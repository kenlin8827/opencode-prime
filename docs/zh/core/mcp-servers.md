# MCP 服务器（代码智能与数据库）

通过 Model Context Protocol (MCP) 构建分层代码智能与通用数据库网关。

---

## 为什么集成 MCP？（核心意义与设计哲学）

在传统的 AI 辅助编程中，智能体主要依赖纯文本搜索（grep / glob）和逐个读取文件来理解代码库。对于中大型项目，这种方式存在严重缺陷：
1. **Token 爆炸与上下文污染**：为了搞清楚一个函数的调用链，模型往往需要翻阅十几个文件，消耗海量 Token 并迅速填满上下文窗口，导致推理质量大幅下降。
2. **缺乏结构化全局视野**：纯文本搜索无法理解 AST 语法树、动态分发、接口实现或多跳调用路径（Multi-hop call paths），极易遗漏代码变更引发的**连锁影响（Blast Radius）**。
3. **数据库操作盲目试错**：面对复杂数据库，模型常靠猜测表名或列名构造 SQL，导致频繁报错和低效重试。

为了彻底解决这些痛点，本配置通过 **Model Context Protocol (MCP)** 构建了**分层代码智能与数据网关矩阵**：

```
                               ┌────────────────────────────────────────────────────────┐
                               │                 OpenCode 智能体团队                     │
                               └───────┬─────────────────┬────────────────────┬─────────┘
                                       │                 │                    │
              ┌────────────────────────┴────────┐ ┌──────┴───────────────┐ ┌──┴─────────────────────────┐
              │          符号级实时定位          │ │      宏观架构与图谱      │ │       通用数据库网关          │
              │         (Symbol Layer)          │ │       (Graph Layer)   │ │      (Database Layer)         │
              ├─────────────────────────────────┤ ├───────────────────────┤ ├─────────────────────────────┤
              │ Serena MCP (基于实时 LSP)         │ │ CodeGraph / GitNexus  │ │ DBHub MCP (Bytebase)        │
              │ • find_symbol                   │ │ • codegraph_explore   │ │ • search_objects (表结构)    │
              │ • find_referencing_symbols      │ │ • 调用链 / 影响面分析   │ │ • execute_sql (安全只读查询) │
              │ • get_symbols_overview          │ │ • 跨文件架构全貌       │ │                             │
              └─────────────────────────────────┘ └───────────────────────┘ └─────────────────────────────┘
```

- **精准定点用 Serena (LSP)**：查询函数定义、所有引用位置、文件符号大纲。极小 Payload，直接返回精确结果，不浪费哪怕 1 个额外文件的上下文。
- **全局链路用 CodeGraph / GitNexus**：“这个模块怎么工作的？”、“修改这个接口会影响哪些下游服务？” —— 单次调用直接返回完整调用路径与影响面分析。分级审查中仅按能力选定的 Scout 消费图谱，并把受限关系证据交给深审。
- **数据探索用 DBHub**：先查真实 schema（`search_objects`）再执行查询（`execute_sql`），杜绝幻觉猜测。

---

## 内置 MCP 服务概览

| 服务 | 类型 | 协议 / 许可证 | 核心工具 | 适用场景 | 索引与生命周期 |
|---|---|---|---|---|---|
| **Serena** | 实时 LSP 语义引擎 | MIT | `find_symbol`, `find_referencing_symbols`, `get_symbols_overview` | 精确的符号定义、引用查找、重命名、文件大纲（零幻觉） | 随会话启动实时连接 LSP，**无需**预先构建索引 |
| **CodeGraph** | 代码知识图谱（默认） | MIT | `codegraph_explore` | 架构全貌、“X 是如何工作的”、完整调用链路、修改影响面（Blast radius） | 项目首次运行 `codegraph init`（或 `/project init`），之后由内置文件监控器**自动增量热同步** |
| **GitNexus** | 深度代码图谱（可选） | PolyForm Noncommercial | Cypher 查询、聚类分析工具 | 复杂多仓库关系、执行任意 Cypher 图查询、流程可视化 | 大规模改动后手动执行 `gitnexus analyze`（或 `/project index`） |
| **DBHub** | 通用数据库网关 | MIT (Bytebase) | `search_objects`, `execute_sql` | 连接 PostgreSQL / MySQL / SQLite / SQL Server / MariaDB，高效查询与元数据探测 | 按项目放置 `dbhub.toml`，支持 `${ENV_VAR}` 环境变量 |
| **Headroom** | 上下文压缩（可选） | Apache 2.0 | `headroom_compress`, `headroom_retrieve`, `headroom_stats` | 输入侧省 token：在工具输出 / 日志 / RAG 片段到达 LLM 之前压缩，原文可经 CCR 按需取回 | 默认关闭；安装较重（uv + Python 3.13），首次运行需下载模型（见下文） |
| **IDE** | JetBrains IDE 桥接 | — | IDE 原生工具 | 实时接入运行中的 IntelliJ / WebStorm 等 —— 文件编辑、代码导航、重构、运行配置 | 需在 IDE 中启用 MCP 服务器（Settings → Tools → MCP Server）；IDE 关闭后端点即失效 |

---

## 自动化装配与配置

整个 MCP 体系深度整合到安装器与智能体运行时中，做到**完全免手动折腾**：

### 1. 集中开关与自动安装（`install/options.jsonc`）

在 `install/options.jsonc` 中设置每个 MCP 的启用状态：

```jsonc
// install/options.jsonc
{
  "mcp": {
    "serena": false,    // LSP 语义检索（默认关闭 —— 23 工具约 7.7k tok/步；需要时手动开启）
    "codegraph": true,  // 代码图谱（启用且本地缺失时，安装器自动通过 npm 全局安装）
    "gitnexus": false,  // 深度 Cypher 图谱（商业使用需注意 PolyForm 许可证）
    "dbhub": true,      // 数据库网关（启用且本地缺失时，安装器自动通过 npm 全局安装）
    "headroom": false,  // 上下文压缩（安装较重 —— uv + Python 3.13）
    "idea": true        // JetBrains IDE 桥接（需先在 IDE 中启用 MCP 服务器）
  }
}
```

- **CLI 自动拉取**：运行 `pwsh install/install.ps1` 或 `./install/install.sh` 时，安装器检测到某 MCP 处于启用状态且本地 PATH 缺失该命令，会自动根据 `opencode.jsonc` 中声明的 `install` 指令完成 CLI 自动安装。

**分级审查图谱选择：**图谱证据是可选加速层。会话画像仅报告 CodeGraph/GitNexus 的紧凑就绪状态；
L3 的普通单仓影响面选 CodeGraph，流程、群组或跨仓问题才选 GitNexus。没有就绪后端时跳过 Scout，
直接交给 `@code-review`。

#### Headroom 说明

- **定位**：Headroom 是套件中唯一的输入侧省 token 机制 —— `rtk` 覆盖输出侧。MCP 模式下由 agent 按需调用 `headroom_compress`；压缩可逆（`headroom_retrieve` 可在 CCR 有效期内取回原文）。
- **默认关闭的原因**：provisioning 执行 `uv tool install --python 3.13 "headroom-ai[all]"`，且首次运行还需下载 ONNX 运行时（cdn.pyke.io）与 Kompress 压缩模型（huggingface.co）。仅在接受这些下载的前提下启用。
- **不要与 `headroom wrap opencode` 或 `headroom proxy` 并用**：二者都会改写由 OCP 管理的 agent / provider 配置（`mergeConfig` / `/profile apply` 管理同一份 `opencode.jsonc`），会互相覆盖。上面的 MCP 条目是受支持的集成面。

### 2. 运行时智能调度（`project-profiler` 插件）

无需记住何时调用什么 MCP。内置的 `project-profiler.ts` 插件会在会话启动时自动探测：
- 当前代码库的项目语言构成。
- 已启用的 MCP 服务与本地索引状态（`.codegraph/`、`.gitnexus/`）。
- 向系统提示词注入紧凑能力事实；后端选择由 `@build` 负责，选定的 Scout 让图谱工具不进入审查器上下文。

### 3. 项目生命周期管理（`/project` 命令）

在具体项目中，只需通过 `/project` 命令即可一键完成环境初始化与索引维护：

```text
/project init       # 一键脚手架：若 MCP 已启用且 CLI 已就绪，自动执行 codegraph init，
                    # 并生成 dbhub.toml 模板、项目配置等
/project index      # 刷新索引：执行 codegraph sync 与 gitnexus analyze
```

### 4. 数据库配置示例（`dbhub.toml`）

在项目根目录创建 `dbhub.toml`（或通过 `/project init` 自动生成），使用环境变量引用凭证，避免明文泄露：

```toml
# dbhub.toml
[[sources]]
id = "default"
dsn = "${DBHUB_DSN}"   # 推荐使用环境变量，例如 postgres://user:pass@localhost:5432/mydb

[[tools]]
name = "execute_sql"
source = "default"
readonly = true        # 生产环境安全：限制为只读查询
```
