# 客户端与交互界面

OpenCode 拥有开放的前端生态。无论你习惯纯键盘流的终端环境，还是偏好现代图形化的双栏 Diff 审查，均可根据场景灵活切换。

---

## 多端形态一览

| 客户端形态 | 推荐人群 | 核心优势 | 启动 / 使用方式 |
|---|---|---|---|
| **终端 TUI — 直接模式** | 命令行极客、SSH 远程开发 | 极轻量、毫秒级响应、原生键盘流交互 | 运行 `ocp`（或 `ocp tui --direct`） |
| **终端 TUI — 工作区包装模式** | 希望使用受管工作区的终端用户 | 连同直接模式，终端 TUI 目前可选三种模式：直接、Herdr 和 Luvus | 通过所选 Herdr 或 Luvus 包装器运行 `ocp tui` |
| **OpenChamber 桌面端** | 偏好图形界面、精细 Code Review 用户 | **双栏可视化 Diff**、多模型并行对比与熔合（Fusion）、会话时间线管理 | 下载 [OpenChamber](https://openchamber.dev/download) 桌面应用后运行 `ocp desktop` |
| **OpenChamber VS Code 扩展** | 不想离开编辑器的 Review 用户 | 在 VS Code 内提供同一套 OpenChamber 审查界面（兼容 VSCodium / Cursor / Windsurf） | 运行 `ocp code` —— 缺失时自动安装扩展 |
| **OpenChamber Web 端** | 局域网访问、轻量浏览器体验 | 密码保护的浏览器访问、可视化并列审查 | 运行 `ocp web` |

---

## 各端界面预览

### 终端 TUI — 直接模式

在任意项目目录下运行 `ocp`（或 `ocp tui --direct`）即可在当前 shell 直接启动 OpenCode —— 默认日常主力界面，支持 21 位专家智能体、四种工作模式与工作流斜杠命令：

![OpenCode 终端界面](/images/opencode-zh.webp)

---

### 终端 TUI — 工作区包装模式

终端 TUI 目前可选三种模式：**直接模式**、**Herdr** 和 **Luvus**。运行 `ocp tui` 可通过安装时选择的工作区包装器启动同一套 OpenCode 终端界面（Herdr 或 Luvus）；单次覆盖选择可使用 `ocp tui --herdr` 或 `ocp tui --luvus`。

---

### OpenChamber 桌面端

运行 `ocp desktop`（别名 `ocp ui`）启动基于 Tauri 的原生桌面应用，提供并列差异对比与多模型比较：

![OpenChamber 桌面应用](/images/openchamber-desktop-zh.png)

---

### OpenChamber Web 端

运行 `ocp web` 启动浏览器版界面 —— 自动生成密码保护的会话，自动选取空闲端口，无需安装桌面程序：

![OpenChamber 网页界面](/images/openchamber-web-zh.png)

---

### OpenChamber VS Code 扩展

运行 `ocp code` 在 VS Code 中打开当前项目，并保证 OpenChamber 扩展就绪 —— 缺失时 OCP 会通过编辑器 CLI 自动安装 `fedaykindev.openchamber`。`--init` 会先创建/激活 OCP 项目；裸 `.` 表示打开当前目录：

```bash
ocp code          # 打开 VS Code 并确保扩展就绪
ocp code .        # 打开当前目录
ocp code --init   # 先创建/激活 OCP 项目
```

---

## 配置无缝共享机制

无论你选择哪种客户端形态，本项目安装在 `~/.config/opencode` 的全部工程能力均会自动生效并完全共享：

- **21 位专家智能体团队**：`@java-dev`、`@security`、`@dba` 等随时调度；
- **MCP 代码智能服务**：Serena LSP 语言服务、CodeGraph 图谱分析、DBHub 数据库网关开箱即用；
- **模型分层预设（Profiles）**：`/profile` 配置的模型映射在所有客户端完全一致；
- **项目级工程护栏**：ADR 门控、密钥防护与提交规范在各端统一拦截。

你可以随时在终端 TUI、桌面端与 Web 端之间无缝切换，无需重复配置！

---

## 下一步

- 查看快速安装指南：**[快速安装与全景控制台](/zh/getting-started/)**
- 查看项目初始化：**[项目初始化与工程护栏](/zh/getting-started/project-init)**
- 查看环境要求：**[环境要求与源码开发](/zh/getting-started/prerequisites)**
