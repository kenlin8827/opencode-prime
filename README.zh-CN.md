# OpenCode Prime (OCP)

> **OpenCode 旗舰级生产工程与多智能体研发套件**

开箱即用的 [OpenCode](https://opencode.ai) 旗舰级生产工程与多智能体研发套件：分层 MCP 代码智能与数据库网关、全链路工程护栏（ADR 铁律 / 密钥防护 / E2E 门控 / 提交纪律）、21 位专家智能体协作与一键模型分层治理 —— 一条命令安装到 `~/.config/opencode`。

> [English](README.md) | **中文** | 📖 **[在线文档站](https://kenlin8827.github.io/opencode-prime/zh/)**
>
> 本 README 是快速上手指南。完整文档请访问 **[在线文档站](https://kenlin8827.github.io/opencode-prime/zh/)**。如需修改本仓库本身，请看 **[DEVELOPING.md](DEVELOPING.md)**。

---

## ⚡ 10 秒一键安装

无需手动克隆仓库，复制并在终端中运行单行命令即可直接安装到 `~/.config/opencode`：

### macOS / Linux / WSL
```bash
curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash
```

### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1 | iex
```

> 💡 **零风险平滑升级**：已安装的用户重复执行上述命令可直接升级到最新版本，你的 API 密钥、自定义模型和层级选择均会**完整保留**。

<details>
<summary><b>安装指定版本</b></summary>

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash -s -- -v 0.9.0
```

```powershell
# Windows
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1))) -Version "0.9.0"
```

</details>

<details>
<summary><b>手动安装与前置条件</b></summary>

如果你希望在运行前检查脚本，或你的环境禁止远程脚本执行：

**macOS / Linux / WSL:**
```bash
curl -fsSL -o /tmp/ocp-install.sh https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh
bash /tmp/ocp-install.sh
```

**Windows (PowerShell):**
```powershell
curl -fsSL -o "$env:TEMP\ocp-install.ps1" https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1
pwsh "$env:TEMP\ocp-install.ps1"
```

**开发者方式（克隆）：**
```bash
git clone https://github.com/kenlin8827/opencode-prime.git
cd opencode-prime
./install/install.sh        # Windows: pwsh install/install.ps1
```

**前置条件：**

| 要求 | 用途 | 安装方式 |
|---|---|---|
| [opencode](https://opencode.ai) CLI | 运行时，读取配置并调度智能体 | `curl -fsSL https://opencode.ai/install \| bash` |
| PowerShell 7+（Windows） | 安装脚本 | `winget install Microsoft.PowerShell` |
| Bash 4+ + `jq`（macOS / Linux / WSL） | 同上，Bash 版本 | `brew install jq` 或 `sudo apt install jq` |
| Git | 版本控制 & 清单回退 | — |
| Node.js 22.5+ + npm（可选） | CodeGraph / GitNexus / DBHub MCP 运行环境 | [Node.js 官网](https://nodejs.org/) |
| uv / Python 3.13+（可选） | Serena LSP MCP 运行环境 | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

</details>

---

## 🇨🇳 大陆用户提示

中国大陆访问 `raw.githubusercontent.com`（OCP 安装与升级脚本所在域名）经常被 DNS 重置或超时。如果上面的安装 / 升级 / `ocp update` 在下载环节卡住，请设置 `OCP_RAW_MIRROR` 环境变量，OCP 会自动把 raw.githubusercontent.com 请求路由到镜像（仍然以官方源为兜底）：

```bash
# 一键安装（带镜像）
OCP_RAW_MIRROR=https://ghfast.top \
  curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash

# 已装用户升级 / update
OCP_RAW_MIRROR=https://ghfast.top ocp upgrade --force
OCP_RAW_MIRROR=https://ghfast.top ocp update
```

也支持 `https://gh-proxy.com`、`https://mirror.ghproxy.com` 等同类镜像（必须用 `prefix + 完整 https URL` 这种拼接方式）。`OCP_RAW_MIRROR` 只影响 `raw.githubusercontent.com`；`github.com` release 资源仍走 `OCP_RELEASE_MIRROR`（若需要请另设）；`api.github.com`（`ocp update` 探测 rtk/herdr/opencode 最新版本号）走 `OCP_API_MIRROR`。第三方依赖（opencode.ai、herdr.dev、npm、pypi）请自行配对应镜像。

**`OCP_API_MIRROR`（可选）**：`ocp update` 探测 rtk / herdr / opencode 最新 release tag 时打的是 `api.github.com`，这个域名经常被大陆 HTTP 429 限速。设 `OCP_API_MIRROR=https://ghfast.top`（或同类）后自动走镜像，失败仍回退官方。

**Mirror 不通时会自动回退到 `raw.githubusercontent.com`** —— 升级 / 装 rtk 时如果 mirror 超时 / 5xx / DNS reset，OCP 会再试一次官方源（终端会出现 `[OCP_RAW_MIRROR] mirror URL failed, falling back to raw.githubusercontent.com` 这一行）。所以 mirror 偶尔挂掉不会卡住你。`OCP_API_MIRROR` / `OCP_RELEASE_MIRROR` 也是同样的"mirror 先，官方兜底"语义。

---

## 📋 OCP CLI 命令一览

安装完成后，全局命令 `ocp`（别名：`opencode-prime`）可在**任意终端路径**下使用：

| 命令 | 别名 | 功能说明 |
| :--- | :--- | :--- |
| `ocp` *(无参数)* | | 启动 **OpenCode 终端 UI**（等同 `ocp tui`） |
| `ocp tui` | | 启动 OpenCode 终端 TUI（`exec opencode`），额外参数原样透传 |
| `ocp serve` | | 启动无头 OpenCode 服务（`opencode serve`） |
| `ocp web` | | 启动 **OpenChamber 网页界面**，自动生成密码 |
| `ocp code` | | 在 **VS Code** 中打开当前项目，缺失时自动安装 OpenChamber 编辑器扩展 |
| `ocp desktop` | `ocp ui` | 启动 **OpenChamber 原生桌面应用** |
| `ocp install` | | 将当前版本清单应用到 `~/.config/opencode` |
| `ocp update` | | 检查套件 + 工具更新，交互式勾选应用 |
| `ocp upgrade` | | 拉取最新发布包并重新安装（一键升级） |
| `ocp init` | | 备份并清空整个目标目录，全新开始 |
| `ocp uninstall` | | 从目标目录移除已安装版本的清单文件 |
| `ocp status` | | 查看已安装版本与仓库版本对比 |
| `ocp generate` | | 从当前仓库树重新生成清单 |
| `ocp register` | | 将全局 shim（`ocp`、`opencode-prime`）安装到 `~/.local/bin` |
| `ocp unregister` | | 移除全局 shim |
| `ocp wizard` | `ocp menu` | 交互式 TUI 安装向导（首次安装与重新配置） |
| `ocp dashboard` | `ocp cc`、`ocp matrix` | 单屏 TUI 控制台 — 切换 MCP / 插件 / 模型层级 |
| `ocp version` | `ocp -v` | 打印仓库版本号 |
| `ocp help` | `ocp -h` | 打印命令帮助 |

> 📖 **完整 CLI 参考**：[OCP CLI — 在线文档](https://kenlin8827.github.io/opencode-prime/zh/maintenance/ocp-cli)

---

## 🖼️ 截图展示

### 单屏 TUI 全景控制台

执行 `ocp dashboard`（或安装器）会打开单屏控制台，按 `空格键` 即可切换 MCP 服务、插件、RTK 压缩器，或循环调整各 Agent 所属模型梯队（`flash` / `standard` / `pro` / `max` / `vision`）：

<p align="center">
  <img src="./docs/public/images/tui-dashboard-zh.webp" alt="OpenCode TUI 全景控制台" width="880"/>
</p>

> **快捷键**：`↑/↓` 移动光标，`空格` 切换/循环梯队，`Enter` 执行操作，`L` 即时切换语言（中/英），`Q` 退出。

---

### 交互式项目向导

在任意项目中运行 `/project init`（或 `ocp wizard`），一键搭建代码知识图谱（CodeGraph + Serena LSP）和项目护栏（ADR + 密钥防护）：

<p align="center">
  <img src="./docs/public/images/tui-project-wizard-zh.webp" alt="项目向导交互对话框" width="880"/>
</p>

两层导航的向导让你用 `🟢 ON` / `🔴 OFF` / `⚪ 默认` 徽章实时切换质量护栏（ADR / E2E / 提交纪律 / 密钥防护），确认后 `💾 保存并应用变更` — 所有修改在确认前仅驻留内存。

---

### OpenCode 终端界面

配置完成后，运行 `ocp`（或 `ocp tui`）启动 OpenCode 终端界面，开始与你的专家智能体团队协作：

<p align="center">
  <img src="./docs/public/images/opencode-zh.webp" alt="OpenCode 终端界面" width="880"/>
</p>

终端界面提供对话式交互，支持 21 位专家智能体（`@java-dev`、`@security`、`@dba`、`@frontend-dev`、`@fast-coder` 等）、四种工作模式（`@lite`（默认 — 约 2k tok/步）/ `@code` / `@build` / `@plan`）、工作流斜杠命令（`/dev` · `/dev-quick` · `/dev-plan` · `/dev-review` · `/review-fix-loop` · `/sdd` …）以及 `/profile` 预设选择器一键映射模型层级。

---

### OpenChamber 网页界面

运行 `ocp web` 启动浏览器版 OpenChamber 网页界面 — 提供并列差异对比与多模型比较，与终端共享同一套配置：

<p align="center">
  <img src="./docs/public/images/openchamber-web-zh.png" alt="OpenChamber 网页界面" width="880"/>
</p>

网页界面自动生成密码保护的会话，自动选取空闲端口（从 3000 起），并自动回收僵尸进程 — 无需手动配置。

---

### OpenChamber 桌面应用

运行 `ocp desktop`（别名 `ocp ui`）启动基于 Tauri 的原生桌面应用：

<p align="center">
  <img src="./docs/public/images/openchamber-desktop-zh.png" alt="OpenChamber 桌面应用" width="880"/>
</p>

桌面应用提供原生窗口体验，支持并列差异对比、多模型比较与全键盘导航 — 终端、网页、桌面共享同一套配置，零重复配置。

---

> 📖 **完整文档** — 智能体、预设、MCP 服务、工作流、护栏与安装选项 — 请访问 **[在线文档站](https://kenlin8827.github.io/opencode-prime/zh/)**。

---

## 许可证

版权所有 (C) 2026 Ken Lin — 基于 [GNU Affero 通用公共许可证 v3.0 或更高版本](./LICENSE) 发布。第三方集成保留各自许可证；各组件的许可说明见 `install/options.jsonc` 与 `opencode.template.jsonc`。
