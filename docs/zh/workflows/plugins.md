# 插件系统与项目护栏

插件提供仅靠提示词无法实现的运行时强制与工作流。以下全部随安装默认启用 —— 无需额外安装。

---

## 插件总览表

| 插件 | 对你的作用 |
|---|---|
| `project-profiler.ts` | 启动时探测语言与激活的 MCP 后端，向系统提示词注入代码智能指引与检索铁律 |
| `design-token-guard.ts` | 阻止写入硬编码的颜色/间距/圆角 —— 让前端代码坚守设计令牌 |
| `ai-slop-scanner.ts` | 警告前端文件中的 AI 反模式（渐变汤、div 汤等） |
| `usage.ts` | `/usage` TUI 命令打开宽度自适应的弹框，顶部常驻 tab 条：**按会话**（每会话一行 + 总计）、**按 Agent**、**按模型** —— 展示非缓存输入/输出/缓存输入 token、费用、缓存命中率、占比条；`1/2/3` 或 `←→` 实时切换 tab，`Enter` 关闭；`↑/↓` 滚动长表格（tab 条、警告、表头、总计与脚注固定不动）；`/usage all\|agent\|model` 直接打开对应维度；宿主无弹框 API 时降级为 toast（仅 TUI 会话） |
| `auto-format.ts` | 文件编辑后自动运行项目选择的 dprint/Biome/Prettier/ESLint/Ruff/gofmt/rustfmt；dprint 与 Biome 均要求配置文件和项目本地二进制 |
| `auto-advisor-mode.ts` | `/auto-advisor` 命令、协议注入、模式门控、red-team 抑制 |
| `deepseek-anchor.ts` | `/deepseek-anchor` 命令 —— 基于锚点的推理协议与 DeepSeek 模型集成 |
| `adr-guard.ts` | `/adr-guard` 命令 —— 按项目的 ADR 强制 |
| `env-guard.ts` | 按项目的密钥文件门控 |
| `e2e-guard.ts` | `/e2e-guard` 命令 —— 按项目门控：E2E 运行需用户确认 |
| `project-manager.ts` | `/project` 命令 + 提交纪律 |
| `queue-manager.ts` | `/queued` 命令 —— 管理会话忙碌时排队的提示 |
| `profile-wizard.ts`、`provider-wizard.ts`、`project-wizard.ts` | `/profile`、`/provider` 与 `/project-wizard` TUI 弹窗向导；未配置现有 formatter 的新 Node 项目可明确选择配置项目本地 dprint |
| `md-to-pdf.ts` | `/md-to-pdf` 命令与 `md_to_pdf` 工具 —— 将 Markdown 一键导出为高质量 A4 PDF（基于 Pandoc + Playwright） |
| `md-to-docx.ts` | `/md-to-docx` 命令与 `md_to_docx` 工具 —— 将 Markdown 导出为出版级 Word (.docx) 文档（宋体/黑体排版、自动TOC、智能表格与代码美化） |

> **工作流命令不是插件。** `/dev-quick`、`/dev-plan`、`/dev-review`、`/dev-ultra`、`/dev-prud`、`/review-fix-loop`、`/grill-improve-loop`、`/grill-me`、`/grill-with-docs`、`/goal`、`/handoff` 是 opencode 原生命令文件（`commands/*.md`）：薄发射器，按需从 L2 技能（`skills/<name>/SKILL.md`）加载协议正文——每次调用只付费一次，永不常驻。详见[工作流斜杠命令](commands.md)与[五档开发流](dev-loops.md)。

---

## ADR 铁律与活化架构治理（`adr-guard` 与 `/adr`）

企业级架构决策记录（ADR）治理体系，由两大互补能力构成：

1. **提交铁律门禁（`/adr-guard`）** — 软/硬双层护栏，杜绝在 `feat`/`refactor` 提交中出现未记录的架构漂移。
2. **分层活化架构引擎（`/adr`）** — 极简脚手架、决策生命周期流转、多层级拓扑与 Mermaid DAG 可视化。

### 开关与治理模式

提交门禁开关为**项目级**（存储于 `opencode.jsonc`）：

```text
/adr-guard on       # 对本项目启用提交门禁拦截
/adr-guard off      # 关闭提交门禁
/adr-guard          # 状态报告（开关 + ADR 目录）
```

分层治理模式通过 `/adr mode` 进行配置：

```text
/adr mode                   # 查看当前治理模式 (auto | flat | hierarchical)
/adr mode flat              # 极简纯扁平单层模式 (仅 docs/adr/)
/adr mode hierarchical      # 严格分层模式 (强制 L1/L2/L3 多层划分)
/adr mode auto              # 智能自适应模式 (默认: 单体项目保持扁平，出现子包时自动拓展)
```

### Slash 命令族（`/adr`）

| 命令 | 说明 | 示例 |
|---|---|---|
| `/adr [new] [layer/scope] <title> [--empty]` | 自动计算序号生成 MADR 骨架并**自动唤醒 AI 结合代码库起草正文**（可省略 `new`，加 `--empty` 仅生成空骨架） | `/adr "采用 PostgreSQL 作为主库"` 或 `/adr new "采用 PostgreSQL 作为主库"` |
| `/adr supersede <old-id> <new-title> [--empty]` | 原子化将旧 ADR 标记为 superseded，生成新决策并**自动唤醒 AI 编写演进论证** | `/adr supersede 0001 "从 RabbitMQ 迁移至 NATS"` |
| `/adr migrate [h\|f\|a] [--confirm]` | 预览或执行 ADR 架构目录结构双向自动化重构 | `/adr migrate h` |
| `/adr tree` / `/adr map` | 生成 Markdown 决策层级树与 Mermaid DAG 依赖图 | `/adr tree` |
| `/adr check` / `/adr lint` | 审计引用完整性、父子决策断链及复杂度升级建议 | `/adr check` |

#### 1. 创建新决策（`/adr` 或 `/adr new`）
* **基础用法（自动 AI 起草，支持直接传需求标题）**：
  ```text
  /adr "Use PostgreSQL as Primary Database"
  # 或：
  /adr new "Use PostgreSQL as Primary Database"
  ```
  自动在 `docs/adr/` 创建下一个自增编号文件（如 `0003-use-postgresql-as-primary-database.md`），填充标准 MADR 骨架，并自动更新 `INDEX.md` 索引表，**随后自动触发 AI 调研代码库并编写完整决策正文**。
* **纯骨架模式（仅生成占位模板，不调用 AI）**：
  ```text
  /adr "Use PostgreSQL as Primary Database" --empty
  ```
* **分层用法（多包 / Monorepo）**：
  ```text
  /adr new system "Global Event Bus Standard"          # L1 宏观决策（根目录 docs/adr/）
  /adr new domain/payment "Stripe Webhook Processing"  # L2 领域决策（packages/payment/docs/adr/）
  /adr new component/auth "JWT Refresh Rotation"       # L3 模块决策
  ```

#### 2. 替代废弃旧决策（`/adr supersede`）
架构决策不可随意篡改历史，方案演进必须通过 `supersede` 记录演进原因：
```text
/adr supersede 0001 "Migrate from RabbitMQ to NATS JetStream"
```
**系统原子化自动完成**：
1. 旧决策（`0001`）状态更新为 `status: superseded by 0004` 并注明废弃原因；
2. 新决策（`0004`）自动创建，Frontmatter 自动关联 `parent: docs/adr/0001-use-rabbitmq.md`；
3. 自动同步刷新目录下的 `INDEX.md`；
4. 自动唤醒 AI 结合历史决策与代码上下文，编写新 ADR 的方案对比与替代理由（若加 `--empty` 则仅生成骨架）。

#### 3. 自动化重构与迁移（`/adr migrate`）
随着项目规模扩大，随时可以无痛双向重构 ADR 结构：
* **预览迁移方案（Dry-Run）**：`/adr migrate h`（或 `/adr migrate hierarchical`），输出文件移动映射表，不修改任何文件；
* **确认执行重构**：`/adr migrate h --confirm`，自动迁移文件、重写 frontmatter 与相互引用，并刷新全仓索引。

### 双模交互：自然语言与 Slash 命令

ADR 治理系统支持 **Slash 命令（确定性脚手架 + AI 接力）** 与 **纯自然语言交互** 双模并行：

| 场景 | 自然语言交互 | Slash 命令（确定性路径 + 索引保障） |
| :--- | :--- | :--- |
| **新建决策** | “帮我记录一个关于引入 Redis 做分布式锁的 ADR”<br>→ **AI 调研背景、列出候选方案对比、填充论证并落盘** | `/adr 引入 Redis 做分布式锁`<br>→ **秒级分配自增序号与索引，随后 AI 自动填充内容** |
| **仅生成模板** | “帮我生成一个 ADR 模板，我自己手写” | `/adr 引入 Redis 做分布式锁 --empty` |
| **废弃/替代** | “0001 号决策废弃掉，我们现在改用 Kafka 代替 RabbitMQ” | `/adr supersede 1 "迁移至 Kafka"` |
| **健康体检** | “帮我看看目前 ADR 依赖关系有没有断链，有没有缺失的字段” | `/adr check` |
| **架构重构** | “项目拆成 Monorepo 了，帮我把支付和用户相关的 ADR 移到各自子包” | `/adr migrate h --confirm` |

### 三层架构决策模型（从粗到细）


- **L1: 宏观系统级 (`layer: system`)** — 根目录 `docs/adr/`（全局技术栈、通信协议、系统安全体系）。
- **L2: 领域子系统级 (`layer: domain`)** — `packages/<name>/docs/adr/` 或 `apps/<name>/docs/adr/`（业务服务边界、领域状态机、分库分表）。
- **L3: 组件模块级 (`layer: component`)** — 模块内部 `docs/adr/`（局部复杂算法、前端状态管理）。



---

## 密钥文件门控（`env-guard`）

按项目可选的门控机制，防止含敏感信息的 env 文件进入 LLM 上下文。开关为**项目级**，默认关闭：

```text
# 对本项目启用（任选一种）
echo on > <project>/.opencode/.env-guard
# 或在项目的 opencode.jsonc 中添加 "envGuard": "on"
```

启用后，在执行前阻断针对 `.env`、`.env.local`、`.env.production` 等敏感文件的文件读取工具及读取到输出的 shell 命令。

---

## E2E 门控（`e2e-guard`）

按项目可选的门控机制，在运行任何 E2E 测试套件前要求用户明确确认：

```text
/e2e-guard on       # 对本项目启用（项目 opencode.jsonc 中 "e2eGuard": "on"）
/e2e-guard off      # 关闭
/e2e-guard          # 状态报告
```

门控按风险分级：
- **full**：无明确目标的整套运行（`npm run e2e`、裸 `playwright test`）—— 每次运行都需要新的一次性 `/e2e-guard allow` 放行。
- **targeted**：显式指定 spec/测试文件（`playwright test tests/login.spec.ts`）—— 会话内一旦获得过确认，后续自动放行。

---

## 提交纪律（`project-manager`）

按项目的提交规范强制机制，采用**文件即开关**：无状态文件、无 on/off 命令 —— `docs/git-commits.md` 存在即生效。

```text
/project init       # 脚手架生成基线文件（.opencode/opencode.jsonc、docs/git-commits.md、AGENTS.md）
/project index      # 手动刷新已有索引：codegraph sync、gitnexus analyze
/project sync       # 只做配置补齐（只追加）
```

`docs/git-commits.md` 存在期间：
- commit 首行须匹配 `type(scope): summary`（type 限 feat、fix、refactor、docs、test、chore、perf、ci、build、style、revert）且 ≤ 72 字符。

---

## 管理排队提示（`/queued`）

会话忙碌时提交的提示，OpenCode 会立即持久化为用户消息。内置的 `queue-manager.ts` TUI 插件提供交互式管理界面：

- `/queued` 打开选择对话框，列出全部排队消息。
- 选中后可执行：**编辑文本**、**取消消息**、**查看全文**，或 **Cancel ALL** 批量取消。

---

## 文档导出与排版渲染（`md-to-pdf` 与 `/md-to-pdf`）

将项目中的 Markdown 文档（API 规范、ADR 方案、调研报告）一键导出为出版级高保真 A4 PDF。

### 核心能力

- **自然语言直接驱动**：在聊天框发送 `@doc/api-v1.md 转PDF` 或 `帮我把 @README.md 导出为 PDF`，智能体自动提取路径并调用 `md_to_pdf` 工具完成生成。
- **Slash 命令确定性执行**：
  ```text
  /md-to-pdf README.md                         # 渲染为 README.pdf
  /md-to-pdf doc/api-v1.md dist/api-v1.pdf     # 指定输出路径
  /md-to-pdf --doctor                          # 环境与依赖健康检查
  /md-to-pdf --install-deps                    # 自动修复/安装缺失依赖
  ```
- **工业级排版与隔离打印**：
  - **Pandoc 引擎**：生成符合 GFM 规范的 standalone HTML，内置代码高亮与资源内联。
  - **优雅 A4 样式**：A4 页面、页边距、现代化字体族、代码块及表格自适应边框。
  - **Playwright 无头打印**：通过隔离 Node runner 驱动 Chromium 打印矢量 PDF，保证毫秒级生成。

---

## Word 文档排版与导出（`md-to-docx` 与 `/md-to-docx`）

将项目中的 Markdown 文档（技术方案、PRD 需求、ADR 决策、会议纪要）一键导出为符合专业出版标准的行政级 Word (`.docx`) 文档。

### 核心能力

- **自然语言直接驱动**：在聊天框发送 `@docs/design.md 转word` 或 `将 @README.md 导出为 docx`，智能体自动调用 `md_to_docx` 工具。
- **Slash 命令交互**：
  ```text
  /md-to-docx README.md                                    # 导出为 README.docx
  /md-to-docx docs/design.md dist/design.docx              # 指定输出路径
  /md-to-docx doc/whitepaper.md --style=custom-theme.css   # 显式指定自定义样式表
  /md-to-docx --doctor                                     # 检查 Pandoc 与 Playwright 状态
  /md-to-docx --install-deps                               # 自动补齐缺失依赖
  ```
- **纯 TypeScript 架构**：彻底告别 Python 环境与脚本依赖，采用纯 TS / Node.js 实现 100% OpenXML 深度排版与美化。
- **100% 样式表驱动（CSS）**：
  - 支持通过 CSS 样式表（`:root` 变量与标准选择器）控制全部排版参数（版心几何、色彩体系、字号、行高、边框、斑马纹等）。
  - **项目级专属配置**：优先自动加载 `.opencode/md-to-docx.css` 与 `.opencode/md-to-docx.docx` 模板。
- **Mermaid 出版级图表系统**：
  - **离线秒级渲染**：内嵌本地离线 Mermaid 引擎，零网络延迟与零外网依赖。
  - **300+ DPI 视网膜高清**：大视口 + 3x 设备像素比超高清生成，图片自动等比扩展为 100% 满版心宽度居中展示。
  - **统一现代浅蓝商务风格**：消除所有图表类型的黑块与黑条，统一实体浅蓝卡片（`#F0F7FF`）、科技蓝连线与箭头（`#2563EB`）、曜石深黑文字（`#0F172A`）与白底圆角药丸标签。
  - **全图表类型深度覆盖**：全面统一架构图（Flowchart）、状态机（State Diagram）、时序图（Sequence Diagram）、实体关系图（ER Diagram）等。
  - **100% 样式表完全化**：所有图表颜色、字体与线条均由 CSS 变量（`--mermaid-*`）动态驱动。
- **行政级出版排版体系**：
  - **中英文标准双字体**：正文标准五号 10.5pt（西文 Times New Roman + 中文 宋体 SimSun）、标题（Segoe UI Semibold + 黑体 SimHei）、代码（Cascadia Code + 微软雅黑）。
  - **TOC 目录中文化**：自动提取 1~2 级标题生成中文化居中目录，支持 Word 动态更新域与点线对齐。
  - **顶级表格美化**：100% 满宽自适应排版、字数自适应列宽、紧凑匀称表头高度（0.74cm）、清除单元格多余段前段后间距、皇家深海蓝表头（#1E3A8A）+ 偶数行浅冰蓝斑马纹（#F8FAFC）+ 细线边框。
  - **代码块美化**：等宽 Cascadia Code 字体 (9.5pt)、极淡冷灰底色 (#F8FAFC)、细边框与紧凑行距。

---

## 外部 NPM 插件与桥接生态

除了内置的 TypeScript 源码插件外，本项目还集成了经过严格兼容性验证的外部 NPM 插件体系。这些插件通过 `install/options.jsonc` 进行声明，并在安装时由 `Ensure-Plugins` 自动预热至 `~/.cache/opencode`。

| 插件名称 | 默认状态 | 说明与前置要求 |
|---|---|---|
| `opencode-qoder-bridge` | 可选 (`false`) | **Qoder 官方桥接**：通过官方 `@qoder-ai/qoder-agent-sdk` 自动注入 `qoder` 服务商与全部模型（需 `qoder login`）。 |
| `opencode-mem@2.24.3` | 可选 (`false`) | **持久化向量记忆库**：基于本地向量库记录项目历史背景（空闲时会发起额外的轻量 LLM 提炼调用）。 |

若需开启可选插件，只需在 `install/options.jsonc` 中将其设为 `true` 并重新运行安装脚本即可。
