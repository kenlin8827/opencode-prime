# 快速安装与全景控制台

开箱即用的 [OpenCode](https://opencode.ai) 生产级工程化配置：一支专家智能体团队、三种编排模式、分层 MCP 代码智能与数据库网关、一键模型预设、工作流斜杠命令、可选的项目级护栏 —— 一条命令安装到 `~/.config/opencode`。

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

> 💡 **零风险平滑升级**：已安装的用户重复执行上述命令可直接升级到最新版本，你的 **API 密钥、自定义模型和模型梯队选择均会完整保留**，不会丢失。

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

---

## 单屏 TUI 全景控制台

执行安装命令后（或后续随时运行 `ocp wizard` / `ocp dashboard`），终端将唤出 **单屏 TUI 全景控制台**：

![OpenCode TUI 全景控制台](/images/tui-dashboard-zh.webp)

### 核心功能与交互说明

- **实时微调**：按空格键秒级切换启用的 MCP 服务、外部插件、RTK 令牌压缩器，或按空格键循环调整各 Agent 所属模型梯队（`flash` / `standard` / `pro` / `max` / `vision`）；
- **快捷键指南**：
  - `↑` / `↓` 或 `j` / `k`：上下移动光标选择配置项
  - `Space`（空格键）：切换 MCP/插件开关，或循环切换 Agent 梯队
  - `Enter`（回车键）：执行当前选中的操作（如“保存配置并执行安装”）
  - `L` 键：即时切换控制台显示语言（中/英）
  - `Q` 键：退出控制台

---

## 全局快捷命令 (`ocp` / `opencode-prime`)

安装完成后，系统已自动注册全局快捷命令。你可以在**任意终端路径下**直接输入：

```bash
ocp              # 直接启动 OpenCode 终端 TUI
ocp dashboard    # 打开 TUI 全景控制台（别名：ocp cc / ocp matrix）
ocp provider     # 配置模型服务商（与 /provider 同一向导）
ocp profile      # 选择或应用模型层级预设（与 /profile 同一向导）
ocp project      # 在当前目录初始化或配置 OCP 项目
ocp usage        # 查看跨项目 Token 与费用用量
ocp tui          # 通过所选工作区包装器启动 OpenCode 终端 TUI
ocp web          # OpenChamber Web 界面（自动生成密码）
ocp desktop      # 启动 OpenChamber 原生桌面应用（别名：ocp ui）
ocp code         # 打开 VS Code 并保证 OpenChamber 扩展就绪（缺失时自动安装）
ocp update       # 检查套件 + opencode + openchamber，交互式升级勾选项
ocp upgrade      # 拉取最新发布包并重装（一键升级）
opencode-prime   # 完整品牌命令（同一分发器）
```

后续无需记住复杂的安装路径，即可随时启动 TUI、微调配置或一键平滑升级！完整命令清单见 [OCP 命令行参考](/zh/maintenance/ocp-cli)。

---

## 客户端界面

OCP 支持五种客户端形态 —— 均共享同一套 `~/.config/opencode` 配置，零重复配置。其中终端 TUI 目前可选三种模式：**直接模式**、**Herdr** 和 **Luvus**。

### 终端 TUI — 直接模式

运行裸 `ocp`（或 `ocp tui --direct`）即可在当前 shell 直接启动 OpenCode —— 日常主力界面，支持 21 位专家智能体、四种工作模式与工作流斜杠命令：

![OpenCode 终端界面](/images/opencode-zh.webp)

### 终端 TUI — 工作区包装模式

运行 `ocp tui` 可通过安装向导中选择的工作区包装器启动同一终端界面：**Herdr** 或 **Luvus**；连同**直接模式**，终端 TUI 目前共支持三种可选模式。单次直接启动可使用 `ocp tui --direct`；单次选择包装器可使用 `--herdr` 或 `--luvus`。

### OpenChamber Web 端

运行 `ocp web` 启动浏览器界面 —— 提供并列差异对比与多模型比较，自动生成密码：

![OpenChamber 网页界面](/images/openchamber-web-zh.png)

### OpenChamber 桌面端

运行 `ocp desktop`（别名 `ocp ui`）启动原生桌面应用，支持全键盘导航：

![OpenChamber 桌面应用](/images/openchamber-desktop-zh.png)

### OpenChamber VS Code 扩展

运行 `ocp code` 可在 VS Code（也支持 VSCodium、Cursor 和 Windsurf）中打开当前项目，并确保 OpenChamber 扩展就绪。`--init` 与编辑器参数传递方式请参阅 **[客户端与交互界面](/zh/getting-started/clients)**。

> 📖 完整对比见 **[客户端与交互界面](/zh/getting-started/clients)**。

---

## 核心特性矩阵

| 特性 | 对你的意义 |
|---|---|
| **专家智能体团队** | 21 位专家（`@java-dev`、`@security`、`@dba`、`@frontend-dev`、`@fast-coder` 等），提示词按领域调优，自动路由 |
| **四种工作模式** | `@lite`（默认 — 精益日常驱动，约 2k tok/步）、`@code`（直接开发）、`@build`（编排执行）、`@plan`（只读分析） |
| **代码智能与数据库（MCP）** | 预配置 MCP 服务（Serena LSP、CodeGraph 图谱、GitNexus、DBHub 数据库网关），开箱按需自动装 CLI |
| **配置预设（Profiles）** | `/profile` 一次性把 5 个模型层级映射到某服务商的模型 —— 无需逐智能体 `set model` |
| **工作流斜杠命令** | `/dev` 组合引擎 · `/dev-quick` · `/dev-plan` · `/dev-review` · `/dev-ultra` 开发流、`/review-fix-loop`、`/grill-improve-loop`、`/goal`、`/handoff`、`/grill-me`、advisor 模式等 |
| **可选护栏** | 按项目启用的 ADR 强制（`/adr-guard`）、密钥文件门控（`env-guard`）、E2E 门控（`/e2e-guard`）、提交纪律（`/project`）—— 全部默认关闭 |
| **一键安装器** | PowerShell + Bash 双平台，基于清单升级；凭证和模型选择在每次重装后完好保留 |
| **Token 节省** | 安装时自动配置 [rtk](https://github.com/rtk-ai/rtk) 输出压缩（60–90%）+ `@lite` 实测约 2k tok/步系统提示，而满配 Agent 每步背负 13k+ tok 开销 |
| **第二意见顾问** | `@advisor` 为阻塞性决策提供独立意见，设计审查时可切换对抗式 red-team 立场 |

---

## ⚖️ 定位对比：omp 与 OpenCode Prime

两种电池，装在两种车上。omp 自建并交付一个原生运行时；OCP 则把工程纪律的电池装进你正在使用的 OpenCode。

| 维度 | omp (`omp.sh`) | **OpenCode Prime (`OCP`)** |
| :--- | :--- | :--- |
| **与运行时的关系** | 独立智能体外壳——替换你的 Agent 运行时 | ⚡ **零迁移的纪律层——保留 OpenCode 运行时、插件与全部配置** |
| **开箱能力侧重** | 🔧 原生工具火力：~8 万行 Rust 核心、hashline 编辑、内置 LSP/DAP、记忆、浏览器、协作 | 🧰 工程纪律火力：21 位专家智能体、MCP 代码智能、`/profile` 预设、护栏、工作流命令 |
| **交付分档** | 魔法关键词（`ultrathink` / `orchestrate`），单轨自主推进 | 🏆 **`/dev-quick` · `/dev-plan` · `/dev-review` · `/dev-ultra` 显式人选档位，可写入团队 SOP** |
| **调度与编排** | 🟢 `task` 子智能体扇出至隔离工作树，类型化结果，实时监督面板 | 🏆 **`@build` 编排器 + 预定义角色流水线（执行计划先公示再执行）+ 分级模型调度（Flash 写码、旗舰审查）+ 动态领域人格注入 + 失败自动重试并原任务续跑** |
| **审查门控** | `/review` 事后判级 P0–P3，单一审查者 | 🏆 **`/dev-review` 旗舰双审 + `@advisor` 安全仲裁，修复在闭环内收敛** |
| **规范驱动生命周期** | 无内置（需外接工具） | 🏆 **`/prd` → `/plan`（自动链接 PRD 与 ADR）→ `/impl` → `/sdd handoff` 完整 SDD 生命周期** |
| **工作流命令套件** | `ultrathink` / `orchestrate` / `workflowz` 关键词 | 🏆 **`/grill-me` 苏格拉底式方案拷问 + `/review-fix-loop` 自动修复至零 P0/P1 + `/grill-improve-loop` 评分驱动改进闭环 + `/goal` 机械可校验的停止条件 + `/handoff` git-safe 会话交接包** |
| **Token 与成本治理** | hashline 编辑省 token + 进程内高效工具 | 🏆 **五级智能体—模型路由（`tiers.json`）+ RTK 代理层输出压缩 60–90%，安装时自动配置** |
| **工程护栏** | 流式规则实时纠偏模型行为 | 🏆 **可审计的策略级门控：ADR/MADR 强制 + 密钥文件拦截 + E2E 门控 + 提交纪律** |
| **代码情报** | 🟢 内置 LSP/DAP/AST（14 LSP + 28 DAP 操作） | Serena LSP + CodeGraph 调用图 + GitNexus + DBHub 数据库网关 |
| **服务商治理** | 60+ 服务商，角色制路由 | 🏆 **`/profile` 一键五级映射——36 个预设全覆盖 OpenCode 内置官方模型族（opencode-go）及 Anthropic / OpenAI / Google / DeepSeek 等一线服务商、路由器方案，国内 Coding Plan 一等公民；TUI 仪表盘** |
| **升级安全性** | 二进制重装 | 🏆 **基于清单的零风险升级——每次重装后 Key 与模型选择完整保留** |
| **文档** | 英文 | 🏆 **完整双语文档树（English + 中文）** |
| **生态与扩展性** | 🟢 TS 扩展模块、插件热重载，兼容继承 8 种已有配置格式 | 🏆 **骑在 OpenCode 生态上——整个 npm 插件库、MCP 生态与社区资产直接复用；OCP 自身亦由 30+ 可插拔插件组合而成** |
| **客户端 / UI 面** | 终端 TUI + Zed（ACP）+ 协作观看页 | 🏆 **TUI + 浏览器 Web UI + OpenChamber 桌面 GUI（并列差异对比、多模型对比）——同一套配置全端共享，零重复配置** |

### 🎯 怎么选？
* **选择 `omp.sh`**：想要一个电池全装的原生外壳，并且愿意整体替换运行时——它的 Rust 工具链、hashline 编辑和 DAP 调试确实出色。
* **选择 OpenCode Prime**：在 OpenCode 上做**真实商业软件**，想要显式交付分档、多模型审查门控、可审计的策略护栏和国内服务商治理——不离开你已投入的生态。
* **两者可以共存**：omp 作为独立火力工具，OCP 作为 OpenCode 技术栈内的团队纪律。

---

## 下一步：项目初始化

安装好全局配置后，**进入任意代码仓库后的黄金第一步就是运行 `/project init`**，自动构建本地代码知识图谱与工程护栏：

👉 **前往查看：[项目初始化与工程护栏](/zh/getting-started/project-init)**
