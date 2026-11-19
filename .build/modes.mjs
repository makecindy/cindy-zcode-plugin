// The option values are Cindy's permission mode ids. Full access is applied by
// Cindy when answering ACP permission requests, so the native mode can keep asking.
const nativeModes = new Map([
  ["default", "build"],
  ["acceptEdits", "edit"],
  ["plan", "plan"],
  ["bypassPermissions", "build"],
]);

export function nativeMode(value) {
  const mode = nativeModes.get(value);
  if (!mode) throw new Error("Unknown Cindy permission mode");
  return mode;
}

export function cindyMode(value) {
  for (const [id, mode] of nativeModes) if (value === mode) return id;
  // Preserve an unrecognised resumed mode. Cindy will apply its saved selection.
  return value;
}

export function cindyModeOptions(options) {
  return Array.from(nativeModes)
    .filter(([, mode]) => options.some((option) => option.value === mode))
    .map(([value, mode]) => ({ value, name: value === "bypassPermissions" ? "Full access" : mode }));
}
