# 环境要求与源码开发

本页面列出运行与定制 OpenCode 配置所需的基础系统依赖，以及面向参与本仓库贡献的开发者指南。

---

## 基础前置条件

| 要求 | 用途 | 安装方式 |
|---|---|---|
| [opencode](https://opencode.ai) CLI（大版本 **v2**——即 2.0.x 线） | 核心运行时，读取配置并调度智能体 | 通常由安装器自动装好：OCP 安装器（`install/scripts/tools/opencode.sh\|.ps1`，以 `@script:opencode` 接入）只解析 [releases](https://github.com/anomalyco/opencode/releases) 上最新的 **v2** 发布包——绝不取 "latest overall"；若用户 profile 里检测到 v1 二进制，则就地升级至最新 v2。手动安装：从 releases 取最新 v2 标签（`curl -fsSL https://opencode.ai/install \| bash -s -- --version <latest-2.x>`） |
| PowerShell 7+（Windows） | Windows 端安装与维护脚本 | `winget install Microsoft.PowerShell` |
| Bash 4+ + `jq`（macOS / Linux / WSL） | Unix 端安装与清单解析 | `brew install jq` 或 `sudo apt install jq` |
| Git | 版本控制与升级清单回退 | 系统包管理器自带 |

---

## 可选 MCP 运行时（按需装配）

本项目集成了分层 MCP 代码智能与数据库网关。安装器支持**按需自动装配**：在 `install/options.jsonc` 开启对应服务且本地缺失 CLI 时，安装器会自动调用 `npm` / `uv` 执行拉取：

| 运行时 | 对应 MCP 服务 | 补充说明 |
|---|---|---|
| **Node.js 22.5+ + npm** | CodeGraph / GitNexus / DBHub | 从 [Node.js 官网](https://nodejs.org/) 安装或通过 `fnm` / `nvm` 管理 |
| **uv / Python 3.13+** | Serena LSP（多语言符号分析） | 通过 `curl -LsSf https://astral.sh/uv/install.sh \| sh` 安装 |

> 💡 **说明**：如果你的工作流暂不涉及某些 MCP 服务，可在全景控制台中直接关闭对应开关，无需预先安装其运行环境。

---

## 开发者模式：克隆源码与本地开发

如果你希望修改本仓库本身（例如新增专家智能体、扩展自定义插件、调试安装脚本），请使用 Git 源码克隆方式：

```bash
# 1. 克隆本仓库到本地
git clone https://github.com/kenlin8827/opencode-prime.git
cd opencode-prime

# 2. 执行安装（Windows 下使用 pwsh install/install.ps1）
./install/install.sh
```

- **Bun 运行时**：二次开发与运行测试时推荐安装 [Bun](https://bun.sh)（`powershell -c "irm bun.sh/install.ps1 | iex"` 或 `curl -fsSL https://bun.sh/install | bash`）。
- 更多贡献规范与架构细节，请参阅根目录 **[DEVELOPING.md](https://github.com/kenlin8827/opencode-prime/blob/main/DEVELOPING.md)**。

---

## 下一步

- 回到快速安装指南：**[快速安装与全景控制台](/zh/getting-started/)**
- 查看更多安装定制参数：**[安装器进阶与选项](/zh/maintenance/options)**
