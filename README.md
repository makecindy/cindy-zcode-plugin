# ZCode for Cindy

在 Cindy 打开 ZCode 插件设置，可检测本机 CLI、从 Z.ai 的 GitHub Releases 安装及检查更新。官方公开安装包自带 CLI。macOS 首次安装放在当前用户的 Applications 目录，Windows 由官方安装向导完成，向导打开期间设置页会提示到安装窗口里继续。安装或更新时，设置页显示当前步骤、已用时间，下载时显示进度、速度和剩余时间；可展开的安装日志列出每一步和安装程序的输出（用户目录显示为 ~，凭据会被隐去）。日志只保存在插件运行期间，重新打开设置页也能看到。

从旧版升级时，请从新仓库下载 .cindy 文件并在 Cindy 导入一次，之后插件更新将使用 makecindy 下的新地址。

在 Cindy 的模型选择器里选用这台电脑上的 ZCode。插件包内含 ACP 适配器，账号、订阅和自定义模型沿用 ZCode 的配置。

## 安装与更新

1. 在运行任务的电脑上安装 [ZCode 桌面版](https://zcode.z.ai/)，用开通了 GLM Coding Plan 的智谱 BigModel 或 Z.ai 账号登录，或在 ZCode 里配置 API Key。
2. 从 [GitHub Releases](https://github.com/makecindy/cindy-zcode-plugin/releases/latest) 下载 `zcode-acp-<版本>.cindy`，在支持插件执行引擎的 Cindy 插件页导入。安装确认会列出本机 Node 工作进程和 ZCode 执行引擎两项权限。
3. 在任务的模型选择器里选择 **ZCode → 模型**。更改 ZCode 的安装或账号后，可以点插件设置里版本旁的刷新图标重新检测。

以后可在 Cindy 的插件设置页检查并安装来自本仓库的更新。Cindy 会校验 GitHub 提供的安装包摘要。

安装位置优先从桌面版查找。Windows 支持常规安装目录及卸载注册表中登记的位置，macOS 支持系统与用户的 Applications 目录。插件也识别 PATH 中的本机 CLI。使用自定义 Windows CLI 时，可以把包含官方 `zcode.mjs` 或 `zcode.cjs` 的目录加入 PATH。

桌面版声明自带 Node 运行时的版本会优先使用随附运行时。独立 CLI 或旧安装需要可运行 `node:sqlite` 的 Node.js 22.13 或更高版本。本插件面向提供 ACP 执行引擎接口的 Cindy 开发版，清单中的 `0.0.0` 对应开发构建。

## 任务行为

- 第一次打开模型选择器即可看到本机配置的模型。检测只读取本地目录和配置。模型有明确声明的思考深度时会随模型上报，任务中的实际选项由 ACP 会话提供。
- 常规模式使用 ZCode 的 `build`，接受编辑使用 `edit`，规划使用 `plan`。ZCode 要求批准操作时由 Cindy 询问。选择 Cindy 的「全部允许」后，Cindy 自动答复审批请求。
- 一项任务使用一个独立适配器进程，支持流式输出、取消、恢复会话和 Cindy 传入的 MCP 服务。ZCode 和适配器按各自的本机规则保存会话和读取账号配置。插件设置页显示可用状态、版本、安装位置、模型数量及可用的账号用量。

## 让自己的其他电脑使用与分享给朋友

在插件设置里为「ZCode」打开「允许被远程调用」后，同一账号的另一台电脑无需安装本插件或 ZCode，新建任务时即可直接选择这台电脑的 ZCode；你也可以点击旁边的「远程与分享」生成一次性链接，把这台电脑上的 ZCode 分享给朋友免安装使用：Agent 在这台电脑上运行，沿用这里的登录、API Key 和套餐额度，项目文件与命令仍在任务所在的那台电脑。开关默认关闭，只能在这台电脑上改。暂不支持加入供应商组。

远程与分享任务通过 `toolDenylist` 和随包 ACP 转接禁用 ZCode 自带的本机文件、命令、搜索、工作流、插件与定时任务工具，文件与命令改走 Cindy 经 HTTP MCP 传入的 `cindy_exec`（转接层还原为原生的 `Bash`、`Read`、`Write`、`Edit` 等名称与审批卡片；若检测到本机工具调用立即终止进程）。分享给朋友的任务还会额外禁用 `Skill` 与本机 `WebFetch`（网页抓取在朋友自己的电脑上执行）、拦截 `session/list`，并运行在仅含服务商与凭据配置的隔离数据目录中，不读取你的历史会话、自定义技能、MCP 服务或 `AGENTS.md`。

## 账号与套餐

设置页的账号卡片显示 ZCode 当前登录的智谱 BigModel 或 Z.ai 账号，以及这个账号的 GLM Coding Plan 是否开通；没有开通时附开通页面链接。ZCode 同一时间只保留一个登录账号，桌面版和命令行共用。

- 使用桌面版时，登录、切换和退出账号都在 ZCode 桌面版里完成。卡片上的按钮会打开 ZCode，回到 Cindy 后自动重新检测。桌面版随附的命令行没有自己的系统钥匙串模块，不能单独登录。
- 使用独立安装的 ZCode CLI 时，可以在卡片里选择平台登录（`zcode login bigmodel` 或 `zcode login zai`，在浏览器中授权）和退出登录（`zcode logout`）。

不登录也可以：在 ZCode 桌面版的模型设置里添加「BigModel Coding Plan」或「Z.ai Coding Plan」API Key 后，这些模型会出现在 Cindy 的模型选择器里，卡片显示「API Key · 平台」和这个 Key 的 Coding Plan 状态。ZCode 3.18 只在这类服务商里保存所用模板和 Key，地址与默认模型来自 ZCode 自带配置中的模板，插件按同一模板读取。

Cindy 不读取也不保存登录令牌，账号检查只取平台、显示名称和套餐状态。API Key 只发给它所属平台的额度查询服务。

ZCode 的 Start Plan 只服务 ZCode 桌面版，其他客户端调用时返回 3012「This client is not supported」，因此模型列表、任务默认模型和任务中的模型切换都不包含 Start Plan 模型。

## 账号用量

设置页显示 ZCode 账号的智谱 BigModel 或 Z.ai GLM Coding Plan 额度。账号检查和用量共用一次额度查询，每个不同的 Key 查询一次，同一平台最多 3 个。额度服务拒绝某个 Key 时，卡片只说明暂时读不到额度，不据此判断 Key 无效：2026-11-20 BigModel 的额度服务拒绝过一个能正常运行 GLM-5.3 的 Coding Plan API Key。自定义模型服务没有提供套餐数据时，页面会显示提示。支持插件用量的 Cindy 也会在使用此引擎的任务输入框下方显示用量，点击可看明细。旁边的圆环显示当前任务由引擎上报的上下文占用。

## 在 Cindy 里使用多个账号

支持引擎账号的 Cindy 可以给 ZCode 添加更多账号，像内置的 Claude、Codex 账号池一样分摊任务、限制并发，额度用完时自动换号，并显示每个账号的用户名或邮箱。ZCode 原有的登录（`~/.zcode`，与桌面版共用）是「默认」账号，用法不变。

- 添加的每个账号是一次智谱 BigModel 或 Z.ai 登录，或一个 GLM Coding Plan API Key，保存在 Cindy 为它新建的文件夹里。任务只让 ZCode 使用这个文件夹（`ZCODE_HOME=<文件夹>/.zcode`、`ZCODE_DATA_BASE_DIR=<文件夹>`）保存登录、服务商配置、设置和会话记录，不读写原有登录，也不改 ZCode 的全局配置。文件夹不可用、或经符号链接（Windows 上的目录联接）指回原有登录时，任务直接报错，不会改用原有登录。分享给朋友的任务从这个账号的文件夹建立隔离目录。
- 一个添加的账号同一时间只用一种方式：给已用浏览器登录的账号改存 API Key 时，插件删除这个账号文件夹里原来的登录；改用浏览器登录成功后，删除原来的 Key。这样 Cindy 显示的身份和实际计费的账号一致。原有登录与桌面版共用，插件从不删除它的登录或 Key，也不在两种方式之间切换它，这类操作请在 ZCode 里完成。保存 Key 前取消，Key 不会写入。
- 原有登录没有可用模型（例如尚未登录或已退出）时，ZCode 仍显示为可用，以便添加第一个账号；模型列表包含原有登录和各添加账号的模型，每个账号只接它自己能用的模型。插件把添加账号的模型清单记在插件自己的存储里（最多 16 个账号），账号移除后自动去掉。
- ZCode 按 `credentials.json` 的完整路径在系统钥匙串里各存一把加密密钥，所以每个文件夹里的登录互不覆盖，也不影响桌面版的登录。
- 只装了 ZCode 桌面版时，只能添加 Coding Plan API Key 账号：在 Cindy 弹出的窗口里粘贴 Key，插件按 ZCode 模型设置的同一模板把它写进该账号的文件夹。桌面版随附的命令行不能单独登录，所以不提供浏览器登录；默认账号的登录和切换仍在桌面版里完成。装了独立的 ZCode CLI 时，还可以在浏览器里登录添加 BigModel 或 Z.ai 账号（`zcode login`）。
- Cindy 显示登录账号的名称和邮箱，API Key 账号显示平台和 Key 的末四位，并显示 GLM Coding Plan 的套餐档位。用量按账号分别读取，5 小时和每周额度带上窗口长度；MCP 工具额度用完不影响模型调用。
- 任务因为账号失败时，适配器在错误里注明原因，供 Cindy 冷却这个账号并换号：额度用完（如 1308、1310）、登录或 Key 失效（401、1000–1004）、服务繁忙（429 并发、503）。适配器会自动重试的网络和繁忙错误不在此列：重试用完时照旧以提示结束这一轮，不触发换号。
- 旧版 Cindy 不传账号文件夹，也不调用这些方法，插件的行为与以前相同。

## 开发

运行下列命令可复现随包适配器。依赖版本与各平台原生库的完整性散列固定在 `.build/package-lock.json`。构建需要 Node.js 和系统 tar。

```sh
cd .build
npm ci --ignore-scripts
node build.mjs
```

Windows 的 Git Bash 自带的 tar 会把 `C:` 当成远程主机，构建时请让系统自带的 `C:\Windows\System32\tar.exe` 排在 PATH 前面。

单元测试从插件根目录运行 `node --test .test/usage.test.mjs .test/account.test.mjs .test/api-key.test.mjs .test/remote-workspace.test.mjs`，使用临时用户目录和替身 ZCode 安装，不读取本机的 ZCode，额度查询发往一个关闭的本机代理，不联网。集成测试使用官方 ZCode 和临时本地模型服务：运行 `node --test .test/desktop.test.mjs`，并通过 `ZCODE_TEST_BIN` 指定测试用 `zcode.cjs` 的绝对路径。测试另建用户目录和工作目录。通过 Cindy Forge 打包本目录即可生成安装包。

## 发布新版本

更新 `ghost.json` 中的 `version`，用 Cindy Forge 生成 `zcode-acp-<版本>.cindy`。将对应源码提交到 `main`，给这次提交打上 `v<版本>` 标签，再用该标签创建 GitHub Release，并附上刚打包的 `.cindy` 文件。Cindy 按标签、插件 ID 和附件名匹配版本。

## 来源

本仓库的插件代码采用 [Apache-2.0](LICENSE) 许可。随包第三方代码和品牌图标各自保留下列许可与归属。

随包桥接代码来自 [zcode-acp-server 0.89.0](https://github.com/william0wang/zcode-acp/tree/5987b3e1dc66589c2fb9acc8d8f90de796376490)。Cindy 的本地 stdio、初始权限模式、模型列表（含隐藏 Start Plan）、命令行登录识别和账号类错误标注的适配记录在 [.build/build.mjs](.build/build.mjs)。依赖许可见 [vendor/licenses](vendor/licenses)。

图标取自 [Z.ai 官方 ZCode 项目](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/public/logo/icons/256x256.png)，标志归原权利人所有。
