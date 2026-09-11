# ADR 分层活化架构体系升级清单 (Upgrade & Changelog)

## 📋 升级总览

本次升级将原先单一的 `adr-guard` 提交拦截机制，全面升级为**顶级企业级工程水准的分层活化架构决策体系（Hierarchical Living Architecture & ADR Engine）**。实现了从“单纯 Commit 卡点拦截”到“思考脚手架 + 决策生命周期管理 + 智能分层感知 + 活化消费”的完整闭环。

---

## 🛠️ 文件变动与新增清单

| 文件路径 | 变动类型 | 核心职责说明 |
| :--- | :---: | :--- |
| `plugins/adr-guard/adr-engine.ts` | **新增** | 分层 ADR 核心引擎：多路径自动嗅探、自增序号计算、分层模板生成、原子化 Supersede 状态机、Mermaid DAG 拓扑渲染及断链体检 |
| `plugins/adr-guard/adr-guard-config.ts` | **修改** | 增加 `adrLayout`（`auto` \| `flat` \| `hierarchical`）治理布局读取、归一化与持久化配置 |
| `plugins/adr-guard/adr-guard-command.ts` | **修改** | 注册并实现 `/adr` 统一命令调度器（`new`, `supersede`, `tree`, `check`, `layout`, `help`） |
| `plugins/adr-guard/adr-guard.ts` | **修改** | 向 OpenCode 注册 `/adr` 与 `/adr-guard` Slash 命令 |
| `plugins/adr-guard/adr-guard-runtime.ts` | **修改** | 增强 `hasAdrChanges` 支持对子包 `**/docs/adr/**` 与全局 `docs/adr/` 的 Git Working-Tree 变动感知 |
| `plugins/adr-guard/adr-guard-protocol.md` | **修改** | 更新 ADR 铁律协议，增加三层决策模型（L1/L2/L3）与 `/adr` 指南 |
| `tests/test-adr-hierarchical-unit.ts` | **新增** | 31 项分层 ADR 引擎专项单元测试 |
| `docs/workflows/plugins.md` | **修改** | VitePress 官方英文文档更新 |
| `docs/zh/workflows/plugins.md` | **修改** | VitePress 官方中文文档更新 |
| `docs/workflows/commands.md` | **修改** | Slash 命令表增加 `/adr` 与 `/adr-guard` |
| `docs/zh/workflows/commands.md` | **修改** | 中文 Slash 命令表增加 `/adr` 与 `/adr-guard` |

---

## ✨ 新增功能与命令清单

### 1. 全套 `/adr` 命令族
- [x] **`/adr new [layer/scope] <title> [--empty]`**：
  - 自动识别当前目录最大序号并加一（`NNNN-slug.md`）；
  - 根据 `system` / `domain` / `component` 层级特化生成 MADR 模板并更新 `INDEX.md`；
  - **自动唤醒 AI 结合代码库深度起草完整决策内容**（可追加 `--empty` 仅生成空骨架）。
- [x] **`/adr supersede <old-id> <new-title> [--empty]`**：
  - 原子化将旧 ADR 状态变更为 `superseded by NNNN`；
  - 自动创建新 ADR 并建立双向 `parent` / `superseded_by` 溯源链接，刷新两端 `INDEX.md`；
  - **自动唤醒 AI 撰写技术演进对比与替代论证**（支持纯数字 ID 如 `supersede 1 "新标题"`，可加 `--empty` 仅生成骨架）。
- [x] **`/adr tree`（或 `/adr map`）**：
  - 扫描全仓 ADR，生成 Markdown 决策层级树；
  - 输出可交互的 Mermaid DAG 拓扑图（呈现 `constrains` 与 `superseded by` 关系网）。
- [x] **`/adr check`（或 `/adr lint`）**：
  - 检查全仓 ADR 引用完整性（父子引用断链、替代目标不存在）；
  - 检查 frontmatter 必填字段与同目录序号冲突；
  - **复杂度自动感知与升级顾问（Complexity Advisor）**：自动嗅探 ADR 规模与 Monorepo 包数量，并在适合时主动给出布局切换建议。
- [x] **`/adr migrate [flat|hierarchical] [--confirm]`（自动重构与文件迁移引擎）**：
  - **预览模式（Dry-Run）**：一览重构方案、文件移动源/目标路径、层级映射与新序号；
  - **执行模式（Confirm）**：原子化移动文件、重写 frontmatter、更新相互引用链接并重新生成所有目录的 `INDEX.md`；
  - 支持 **双向自由重构**（`flat` → `hierarchical` 分层扩散 或 `hierarchical` → `flat` 单层收拢）。
- [x] **`/adr layout [auto|flat|hierarchical]`**：
  - 查看或一键切换项目级分层治理布局（切换时若有可迁移文件，会自动提示一键重构命令）。


---

## ⚙️ 配置项升级规范 (`opencode.jsonc`)

在项目根目录的 `opencode.jsonc` 中支持以下配置字段：

```jsonc
{
  // ADR 提交门禁开关 (默认 "off")
  "adrGuard": "on",

  // ADR 自定义根目录 (默认 "docs/adr")
  "adrDir": "docs/adr",

  // ADR 分层治理布局 (默认 "auto")
  // "auto": 智能自适应布局 (常规单体项目表现为纯扁平，出现子包时自动拓展)
  // "flat": 极简纯扁平单层布局 (强制只使用根目录 docs/adr/)
  // "hierarchical": 严格分层布局 (强制 L1/L2/L3 多层划分)
  "adrLayout": "auto"
}
```

---

## 🔒 向下兼容性与平滑迁移

1. **100% 向下兼容**：
   - 现有的单层 `docs/adr/` 仓库无需做任何结构改动，在默认 `auto` 模式下完全保持原本极简体验。
2. **零迁移成本**：
   - 旧版 ADR 文件（即使没有新版 `layer` 字段）会被引擎自动识别并赋予默认系统层级，无需手动刷库重构。

---

## 🧪 自动化测试验证

运行完整单元测试集以验证升级正确性：

```powershell
# 1. 运行分层 ADR 专项测试 (31 项测试)
bun run tests/test-adr-hierarchical-unit.ts

# 2. 运行原 ADR Guard 兼容性回归测试 (77 项测试)
bun run tests/test-adr-guard-unit.ts
```

**测试结果**：`108 / 108` 项单元测试 100% 通过。
