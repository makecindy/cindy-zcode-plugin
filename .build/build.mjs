// Author-time build only. Forge excludes this directory and node_modules.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.join(here, "node_modules");
const vendor = path.resolve(here, "../vendor");
const dist = path.join(vendor, "dist");
const native = path.join(vendor, "native");
const licenses = path.join(vendor, "licenses");
await Promise.all([dist, native, licenses].map(dir => mkdir(dir, { recursive: true })));
const lock = JSON.parse(await readFile(path.join(here, "package-lock.json"), "utf8"));

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw new Error("Upstream changed. Review the adaptation for: " + from);
  return source.replace(from, () => to);
}

// These small changes are checked against the pinned distribution. Protocol
// translation, event correlation, resume and auth stay with the upstream bridge.
const adaptations = {
  "index.js": source => replaceOnce(source,
    "const remoteConfigEarly = parseRemoteConfig();", "const remoteConfigEarly = null;"),
  "server.js": source => replaceOnce(source, "            ...(await envWithLoginShell()),\n", ""),
  "remote/config.js": source => replaceOnce(source,
    'const file = loadUserConfig(env).remote ?? {};\n    return file.enabled !== undefined\n        ? file.enabled\n        : ["1", "true", "yes", "on"].includes((env.ZCODE_ACP_REMOTE ?? "").trim().toLowerCase());',
    'return false;'),
  "config/settings.js": source => replaceOnce(source,
    'const file = loadUserConfig(env).session?.mode;\n    if (file !== undefined)\n        return file;\n    return env.ZCODE_ACP_MODE || "yolo";',
    'return "build";'),
  "config/options.js": source => {
    source = 'import { cindyMode, cindyModeOptions } from "cindy-modes";\nimport { withProviderTemplate } from "cindy-templates";\n' + source;
    source = replaceOnce(source, "currentValue: currentMode,", "currentValue: cindyMode(currentMode),");
    source = replaceOnce(source, "options: [...CONFIG_META.mode.options]", "options: cindyModeOptions(CONFIG_META.mode.options)");
    // set_config_option switches the same plan flag as upstream's set_mode.
    // The backend acknowledges it before sending the mode-change event.
    source = replaceOnce(source, "return { kind: configId, currentValue: value };",
      'if (configId === "mode") {\n        if (value === "plan") server.sessionPlanActive.add(zcodeSid);\n        else server.sessionPlanActive.delete(zcodeSid);\n    }\n    return { kind: configId, currentValue: value };');
    // The official CLI accepts a provider that lists personalModelIds with no
    // per-model overrides. Include those IDs in both the picker and the task.
    // A provider made from a ZCode template takes its address and default
    // models from that template, as the CLI does.
    source = replaceOnce(source, "out.providers.push({ pid: configProviderIdFor(rule.providerId), rule });",
      `const pid = configProviderIdFor(rule.providerId);
        const entry = withProviderTemplate(rule);
        const personalIds = entry.config?.personalModelIds;
        if (Array.isArray(personalIds)) {
            const disabled = new Set(modelRules.filter(m => m.providerId === rule.providerId && m.config?.enabled === false).map(m => m.modelId));
            const ids = (out.modelsByProvider.get(pid) ?? []).concat(personalIds);
            out.modelsByProvider.set(pid, [...new Set(ids)].filter(id => typeof id === "string" && !disabled.has(id)));
        }
        out.providers.push({ pid, rule: entry });`);
    // ZCode serves Start Plan only to its own desktop app: model requests from
    // this bridge are refused with 3012 "This client is not supported". Every
    // model menu, session default and model switch reads this one list.
    source = replaceOnce(source, "export function loadAllModels() {",
      `export function loadAllModels() {
    return loadAllModelsWithStartPlan().filter(m => !/^(?:account|builtin):[a-z0-9]+-start-plan$/.test(m.providerId));
}
function loadAllModelsWithStartPlan() {`);
    // A fresh install has no usable model yet. Reuse the upstream entitlement
    // and local-provider checks without fabricating a default subscription.
    return replaceOnce(source,
      "return [\n        {\n            providerId: DEFAULT_PROVIDER_ID,\n            providerName: DEFAULT_PROVIDER_NAME,\n            modelId: DEFAULT_MODEL_ID,\n        },\n    ];",
      "return [];");
  },
  "handlers/session.js": source =>
    'import { nativeMode } from "cindy-modes";\n' + replaceOnce(source,
      "setConfigOption(server, zcodeSid, params.configId, params.value, params.sessionId)",
      'setConfigOption(server, zcodeSid, params.configId, params.configId === "mode" ? nativeMode(params.value) : params.value, params.sessionId)'),
  "backend/credential-store.js": source => replaceOnce(source,
    'req("@napi-rs/keyring")', 'req("../native/keyring.cjs")'),
  // The settings page signs in with `zcode login <family>`. Without the desktop
  // app, the CLI records that OAuth connection on the family's individual
  // coding plan provider in the shared credential store, not in setting.json.
  "config/account-provider.js": source => replaceOnce(source,
    "    catch {\n        // setting.json absent (headless-only) — nothing to infer\n    }\n    return out;\n}\n/**\n * Families entitled for Start Plan.",
    `    catch {
        // setting.json absent (headless-only) — nothing to infer
    }
    const store = readCredentialStoreSync();
    for (const rule of readBuiltinTable()?.table.config?.providerConfigRules?.providerRules ?? []) {
        const access = rule.config?.access;
        if (access?.type !== "zhipu-account" || access.mode !== "individual-coding-plan")
            continue;
        if (!isCodingPlanFamily(access.accountType) || !hasOAuthLogin(access.accountType))
            continue;
        if (store["account-provider:" + rule.providerId + ":auth-source"]?.trim() === "oauth" &&
            store["account-provider:" + rule.providerId + ":identity"]?.trim())
            out.add(access.accountType);
    }
    return out;
}
/**
 * Families entitled for Start Plan.`),
};
const applied = new Set();
const upstream = path.join(modules, "zcode-acp-server");
const output = await build({
  absWorkingDir: here, entryPoints: ["adapter.mjs"], outfile: path.join(dist, "adapter.mjs"),
  bundle: true, format: "esm", platform: "node", target: "node22", metafile: true,
  alias: { "cindy-modes": path.join(here, "modes.mjs"), "cindy-templates": path.join(here, "templates.mjs") },
  // Some CommonJS dependencies require Node built-ins from the ESM bundle.
  banner: { js: 'import { createRequire as cindyCreateRequire } from "node:module"; const require = cindyCreateRequire(import.meta.url);' },
  external: ["bufferutil", "utf-8-validate"],
  plugins: [{
    name: "cindy-local-stdio",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]zcode-acp-server[\\/]dist[\\/].*\.js$/ }, async ({ path: file }) => {
        const rel = path.relative(path.join(upstream, "dist"), file).split(path.sep).join("/");
        if (!Object.hasOwn(adaptations, rel)) return;
        applied.add(rel);
        return { contents: adaptations[rel]((await readFile(file, "utf8")).replaceAll("\r\n", "\n")), loader: "js" };
      });
    },
  }],
});
if (applied.size !== Object.keys(adaptations).length) throw new Error("Missing upstream adaptation");
const { name, version, license } = JSON.parse(await readFile(path.join(upstream, "package.json"), "utf8"));
await writeFile(path.join(vendor, "package.json"), JSON.stringify({ name, version, license }, null, 2) + "\n");
await copyFile(path.join(modules, "@napi-rs/keyring/index.js"), path.join(native, "keyring.cjs"));

// Preserve license notices for each package actually used in the runtime.
const packages = new Set(["@napi-rs/keyring"]);
for (const file of Object.keys(output.metafile.inputs)) {
  const match = file.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]);
}
for (const pkg of packages) {
  const folder = path.join(modules, pkg);
  for (const file of await readdir(folder)) {
    if (/^(license|notice|copying)(\.|$)/i.test(file)) {
      await copyFile(path.join(folder, file), path.join(licenses, pkg.replace("/", "-") + "-" + file));
    }
  }
}

// Keyring's official JS loader supports adjacent .node files. Include the
// desktop architectures, including both common Linux libcs. npm normally
// installs just the builder's own native variant.
const scratch = await mkdtemp(path.join(os.tmpdir(), "cindy-zcode-build-"));
try {
  for (const target of ["win32-x64-msvc", "win32-arm64-msvc", "darwin-x64", "darwin-arm64",
    "linux-x64-gnu", "linux-arm64-gnu", "linux-x64-musl", "linux-arm64-musl"]) {
    const pkg = lock.packages["node_modules/@napi-rs/keyring-" + target];
    const archive = path.join(scratch, target + ".tgz");
    const response = await fetch(pkg.resolved);
    if (!response.ok) throw new Error("Could not fetch " + target + ": " + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if ("sha512-" + createHash("sha512").update(bytes).digest("base64") !== pkg.integrity) throw new Error("Checksum mismatch for " + target);
    await writeFile(archive, bytes);
    const filename = "keyring." + target + ".node";
    execFileSync("tar", ["-xf", archive, "-C", scratch, "package/" + filename, "package/LICENSE.third-party.md"], { windowsHide: true });
    await copyFile(path.join(scratch, "package", filename), path.join(native, filename));
    await copyFile(path.join(scratch, "package/LICENSE.third-party.md"), path.join(licenses, "keyring-" + target + ".md"));
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log("Bundled " + name + " " + version + " and its runtime notices.");
