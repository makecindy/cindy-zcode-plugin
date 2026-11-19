# ZCode for Cindy

在 Cindy 打开 ZCode 插件设置，可检测本机 CLI、从 Z.ai 的 GitHub Releases 安装及检查更新。官方公开安装包自带 CLI。macOS 首次安装放在当前用户的 Applications 目录，Windows 由官方安装向导完成。

从旧版升级时，请从新仓库下载 .cindy 文件并在 Cindy 导入一次，之后插件更新将使用 makecindy 下的新地址。

在 Cindy 的模型选择器里选用这台电脑上的 ZCode。插件包内含 ACP 适配器，账号、订阅和自定义模型沿用 ZCode 的配置。

## 安装与更新

1. 在运行任务的电脑上安装 [ZCode 桌面版](https://zcode.z.ai/)。打开 ZCode，登录账号或配置模型，确认能发消息。
2. 从 [GitHub Releases](https://github.com/makecindy/cindy-zcode-plugin/releases/latest) 下载 `zcode-acp-<版本>.cindy`，在支持插件执行引擎的 Cindy 插件页导入。安装确认会列出本机 Node 工作进程和 ZCode 执行引擎两项权限。
3. 在任务的模型选择器里选择 **ZCode → 模型**。更改 ZCode 的安装或账号后，可以在插件设置里点 **重新检测**。

以后可在 Cindy 的插件设置页检查并安装来自本仓库的更新。Cindy 会校验 GitHub 提供的安装包摘要。

安装位置优先从桌面版查找。Windows 支持常规安装目录及卸载注册表中登记的位置，macOS 支持系统与用户的 Applications 目录。插件也识别 PATH 中的本机 CLI。使用自定义 Windows CLI 时，可以把包含官方 `zcode.mjs` 或 `zcode.cjs` 的目录加入 PATH。

桌面版声明自带 Node 运行时的版本会优先使用随附运行时。独立 CLI 或旧安装需要可运行 `node:sqlite` 的 Node.js 22.13 或更高版本。本插件面向提供 ACP 执行引擎接口的 Cindy 开发版，清单中的 `0.0.0` 对应开发构建。

## 任务行为

- 第一次打开模型选择器即可看到本机配置的模型。检测只读取本地目录和配置。模型有明确声明的思考深度时会随模型上报，任务中的实际选项由 ACP 会话提供。
- 常规模式使用 ZCode 的 `build`，接受编辑使用 `edit`，规划使用 `plan`。ZCode 要求批准操作时由 Cindy 询问。选择 Cindy 的「全部允许」后，Cindy 自动答复审批请求。
- 一项任务使用一个独立适配器进程，支持流式输出、取消、恢复会话和 Cindy 传入的 MCP 服务。ZCode 和适配器按各自的本机规则保存会话和读取账号配置。插件设置页显示可用状态、版本、安装位置、模型数量及可用的账号用量。

## 账号用量

设置页显示 ZCode 账号可读取的 Z.ai、BigModel Coding Plan 或 Start Plan 额度。一次性额度只显示余额比例。自定义模型服务没有提供套餐数据时，页面会显示提示。支持插件用量的 Cindy 也会在使用此引擎的任务输入框下方显示用量，点击可看明细。旁边的圆环显示当前任务由引擎上报的上下文占用。

## 开发

运行下列命令可复现随包适配器。依赖版本与各平台原生库的完整性散列固定在 `.build/package-lock.json`。构建需要 Node.js 和系统 tar。

```sh
cd .build
npm ci --ignore-scripts
node build.mjs
```

集成测试使用官方 ZCode 和临时本地模型服务。从插件根目录运行 `node --test .test/desktop.test.mjs`，并通过 `ZCODE_TEST_BIN` 指定测试用 `zcode.cjs` 的绝对路径。测试另建用户目录和工作目录。通过 Cindy Forge 打包本目录即可生成安装包。

## 发布新版本

更新 `ghost.json` 中的 `version`，用 Cindy Forge 生成 `zcode-acp-<版本>.cindy`。将对应源码提交到 `main`，给这次提交打上 `v<版本>` 标签，再用该标签创建 GitHub Release，并附上刚打包的 `.cindy` 文件。Cindy 按标签、插件 ID 和附件名匹配版本。

## 来源

本仓库的插件代码采用 [Apache-2.0](LICENSE) 许可。随包第三方代码和品牌图标各自保留下列许可与归属。

随包桥接代码来自 [zcode-acp-server 0.89.0](https://github.com/william0wang/zcode-acp/tree/5987b3e1dc66589c2fb9acc8d8f90de796376490)。Cindy 的本地 stdio、初始权限模式和模型列表适配记录在 [.build/build.mjs](.build/build.mjs)。依赖许可见 [vendor/licenses](vendor/licenses)。

图标取自 [Z.ai 官方 ZCode 项目](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/public/logo/icons/256x256.png)，标志归原权利人所有。
