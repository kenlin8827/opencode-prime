# 安装器进阶与选项

了解安装器命令、options.jsonc 配置开关、rtk 压缩原理以及重装保留字段规则。

---

## 安装命令一览

| 模式 | PowerShell | Bash | 说明 |
|---|---|---|---|
| 安装（默认） | `pwsh install/install.ps1` | `./install/install.sh` | 将当前清单应用到目标目录 |
| 强制重装 | `pwsh install/install.ps1 install -Force` | `./install/install.sh install -f` | 重新应用相同版本 |
| 查看状态 | `pwsh install/install.ps1 status` | `./install/install.sh status` | 显示已安装版本与仓库版本 |
| 初始化（全新开始） | `pwsh install/install.ps1 init` | `./install/install.sh init` | 备份并清空整个目标目录 |
| 注册全局命令 | `pwsh install/install.ps1 register` | `./install/install.sh register` | 将 `opencode-prime` 与 `ocp` shim 安装到 `~/.local/bin` |
| 注销全局命令 | `pwsh install/install.ps1 unregister` | `./install/install.sh unregister` | 移除全局 shims |
| 启动 TUI | `pwsh install/install.ps1 tui` | `./install/install.sh tui` | 启动 OpenCode 终端界面（`exec opencode`） |
| 启动桌面端 | `pwsh install/install.ps1 desktop` | `./install/install.sh desktop` | 启动 OpenChamber 原生桌面应用（别名 `ui`） |
| 启动 Web 界面 | `pwsh install/install.ps1 web` | `./install/install.sh web` | 启动 OpenChamber Web 界面（`openchamber --ui-password <自动生成>`） |

---

## 安装选项（`options.jsonc`）

`install/options.jsonc` 是控制安装配置的单一事实来源（开关 MCP、外部插件、主控智能体与 rtk 压缩代理）。

### 安装前自定义流程

1. **进入仓库目录**（若使用 Git 克隆或解压了 release 包）：
   ```bash
   cd opencode-prime
   ```
2. **编辑 `install/options.jsonc`** 设定所需的可选功能开关：
   ```jsonc
     // install/options.jsonc
   {
     // 安装时将全局命令 shim（ocp / opencode-prime）注册到
     // ~/.local/bin，并把该目录追加进用户 PATH
     "global_commands": true,
     // 可选外部二进制，声明于 install/tools.jsonc
     "tools": {
       // 是否启用 rtk 输出压缩（60-90% token 节省）
       "rtk": true,
       // OpenChamber 拆分为三个独立面，各自一个开关：
        // 网页版 CLI（缺失时自动安装 @openchamber/web；提供 `ocp web`，需 Node.js 22+）
        // 默认关闭：启用后会安装全局包。
        "openchamber_web": false,
       // `ocp desktop` / `ocp ui` 的原生桌面应用——始终需另行下载
       // （https://openchamber.dev/download）；安装时仅检测是否已安装
       "openchamber_desktop": true,
       // `ocp code` 的 VS Code 扩展（缺失时通过编辑器 CLI 自动安装
        // fedaykindev.openchamber）。默认关闭：启用后会修改编辑器。
        "openchamber_vscode": false,
       // 终端工作空间管理器（tui_mode 为 "herdr" 时自动视为 true）
       "herdr": false
     },
     // 默认主控智能体（lite: 默认精益日常驱动 / code: 直接开发 / build: 编排派发 / plan: 只读分析）
     "default_agent": "lite",
     // MCP 服务开关（启用且本地缺失 CLI 时自动拉取安装）
     "mcp": {
       // Serena LSP 语义代码检索与符号分析（需 uv / Python 3.13+；默认关闭，
       // 23 个工具约 7.7k tok/步；需要时手动开启）
       "serena": false,
       // CodeGraph AST 代码知识图谱（需 npm）
       "codegraph": true,
       // GitNexus 代码图谱（PolyForm 非商用许可；需自行索引）
       "gitnexus": false,
       // DBHub 通用数据库网关（PostgreSQL / MySQL / SQLite 等；需 npm）
       "dbhub": true,
       // Headroom 上下文压缩（Apache 2.0；安装较重 —— uv + Python 3.13，
       // 首次运行下载 ONNX 运行时 + Kompress 模型；详见 core/mcp-servers）
       "headroom": false,
       // JetBrains IDE 桥接（需先在 IDE 中启用 MCP 服务器：Settings → Tools → MCP Server）
       "idea": true
     },
     // 外部 npm 插件开关（true: 启用; false: 关闭）
     "plugin": {
       // 偷懒编码协议：实现目标并指出更轻量的替代方案
       "@dietrichgebert/ponytail": true,
       // Qoder 订阅桥接（通过官方 SDK 注入 qoder 服务商及模型，需 qoder login）
       "opencode-qoder-bridge": false,
       // 持久化项目记忆库（向量存储，空闲时产生额外 LLM 捕获调用）
       "opencode-mem@2.24.3": false
     }
   }
   ```
3. **执行安装命令**：
   ```bash
   # macOS / Linux / WSL
   ./install/install.sh

   # Windows (PowerShell)
   pwsh install/install.ps1
   ```

### 安装后修改与生效

安装器在每次运行时都会严格按照仓库中 `install/options.jsonc` 的开关状态重新计算并应用到目标 `opencode.jsonc`。若后续需要开启或关闭某项功能：
1. 修改 `install/options.jsonc` 中的对应字段（`true` / `false`）。
2. 在版本号未变的情况下，带 `-Force`（PowerShell）或 `-f`（Bash）重新运行安装即可生效：
   ```powershell
   pwsh install/install.ps1 install -Force
   ```
   ```bash
   ./install/install.sh install -f
   ```

---

## 插件自动预热（Ensure-Plugins）

为了避免首次启动 OpenCode 时因在线下载 npm 插件而出现卡顿，安装器会在安装的最后阶段自动探测本地包管理器（`bun` > `npm` > `pnpm`），并将已启用的外部插件自动预装至 OpenCode 原生缓存目录（`~/.cache/opencode`）。

- **零配置目录污染**：插件缓存严格存放在 OpenCode 官方数据目录中，不影响 `~/.config/opencode` 配置清单的原子化升级与卸载。
- **容错降级**：若本地未安装包管理器或网络不可达，安装器会优雅跳过，保留由 OpenCode 启动时自动拉取的保底能力。

---

## Token 节省（rtk）

安装时自动配置 [rtk](https://github.com/rtk-ai/rtk) —— 一个在命令输出（git status、测试、构建等）到达模型前将其压缩 60-90% 的 CLI 代理。

若 PATH 中没有 `rtk`，安装器会将固定版本的二进制下载到 `~/.local/bin`。opencode 钩子以内置的 `plugins/rtk-write.ts` 形式随配置分发。

若不需要：在 `install/options.jsonc` 中设 `"rtk": false` 后重新安装即可。

---

## Herdr（`ocp herdr`）—— 可选终端工作区管理器

[Herdr](https://herdr.dev) 是为 AI 编码代理量身打造的终端工作区管理器。每个 herdr 工作区都以某个目录为根，并在新 pane 里自动启动 opencode（通过 OCP 的 `auto-opencode` 插件）。开启 `"herdr": true` 后，安装器会在本地缺 `herdr` 命令时自动拉取，并把内置配置链接到 `~/.config/herdr/config.toml`。

由于 `tui_mode` 默认值为 `"herdr"`，Herdr 默认启用。若不需要，可在向导或此配置中关闭。

要让 `ocp tui` 走 herdr 而非直接启动 `opencode`，请设：

```jsonc
// install/options.jsonc
"tui_mode": "herdr"   // "direct" | "herdr"（默认）
```

选 `"herdr"` 会自动启用 `tools.herdr`（覆盖显式设为 `false` 的情况），并打印一行提示，无需再手动开启第二个开关。

---

## OpenChamber（`ocp desktop` / `ocp web` / `ocp code`）

安装时可供应 [OpenChamber](https://openchamber.dev) —— 运行在本地 OpenCode 引擎之上的图形界面层（双栏 Diff 审查、多模型对比、会话时间线）。它拆分为**三个独立面**，各自对应一个 `tools.openchamber_*` 开关；Web 与 VS Code 默认按需启用：

| 开关 | 表面 | 安装时的行为 |
|---|---|---|
| `tools.openchamber_web` | **网页版** —— `@openchamber/web` CLI，提供 `ocp web` | **默认：false。** 启用后，本地缺少 `openchamber` 命令时通过检测到的第一个包管理器（pnpm > bun > yarn > npm）全局安装（需 Node.js 22+） |
| `tools.openchamber_desktop` | **桌面版** —— 提供 `ocp desktop` / `ocp ui` 的原生应用 | 仅检测是否已安装，缺失时打印下载链接——安装器**从不**下载桌面应用（[openchamber.dev/download](https://openchamber.dev/download)） |
| `tools.openchamber_vscode` | **VS Code 扩展** —— 提供 `ocp code` | **默认：false。** 启用后，本地缺少扩展时通过检测到的第一个编辑器 CLI（`code`、`code-insiders`、`codium`、`cursor`、`windsurf`）安装 `fedaykindev.openchamber` |

安装完成后即可启动：

```bash
ocp desktop      # 原生桌面应用（别名：ocp ui）
ocp web          # OpenChamber Web 界面（自动生成 --ui-password）
ocp code         # 打开 VS Code 并保证 OpenChamber 扩展就绪
ocp tui          # OpenCode 终端界面
```

若需要 Web 或 VS Code：在 `install/options.jsonc` 中把对应开关设为 `true` 后重新安装即可。任何面设为 `false` 都会跳过（已安装的组件不受影响）；被关闭的面同样会被 `ocp code` 的自动安装跳过。

---

## 重装时保留的字段

当 `opencode.jsonc` 被新模板覆盖时，以下字段会从你的现有配置中快照并在覆盖后恢复：

| 字段 | 保留原因 |
|---|---|
| `provider.<name>.options.baseURL` | 你的 API 端点 |
| `provider.<name>.options.apiKey` | 你的 API 密钥 |
| `provider.<name>.models` | 你的模型定义（自定义 model id、用户自加的模型） |
| `model`（根级别） | 你为 standard 层级选择的模型 |
| `agent.<name>.model`（每个层级） | 你为各层级分配的模型 |

---

## 全局命令 (`ocp` / `opencode-prime`)

首次安装后，可将仓库注册为全局快捷命令（`ocp`、`opencode-prime`）：

```powershell
pwsh install/install.ps1 register
```

```bash
./install/install.sh register
```

注册完成后，`ocp` 同时也是运行时启动器：`ocp`（或 `ocp tui`）启动 OpenCode 终端界面，`ocp desktop`（别名 `ocp ui`）启动 OpenChamber 原生桌面应用，`ocp web` 则在 localhost 上提供带自动生成 `--ui-password` 的 OpenChamber Web 界面。

若不想在安装时自动注册 shim，可在 `install/options.jsonc` 中设置 `"global_commands": false` —— 上方的 `register` / `unregister` 独立操作仍然随时可用。

👉 完整命令清单与启动器语义（`ocp web` 的端口与密码策略）见独立章节 [OCP 命令行参考](/zh/maintenance/ocp-cli)。
