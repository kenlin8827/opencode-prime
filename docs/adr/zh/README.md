# 架构决策记录

本目录按与 `docs/adr/` 完全相同的 OCP ADR 结构维护中文阅读树。当前记录与根目录保持同构：相同的文件名、OCP 容器、section、状态、元数据和历史材料。

`docs/adr/zh/` 是本地化阅读树，不参与 ADR 发现、编号分配、完整性校验、生成索引、关系图或提交门禁；根目录仍是 ADR 治理的唯一权威树。

| 迭代 | ADR |
| --- | --- |
| 0.10.0 | [CLI and OpenChamber activation](./0.10.0-cli-and-openchamber-activation.md) |
| 0.34.0 | [Profiler cache and ponytail removal](./0.34.0-profiler-cache-and-ponytail-removal.md) |
| 0.35.0 | [OCP path contract](./0.35.0-ocp-path-contract.md) |
| 0.36.0 | [tgrep probe-first contract](./0.36.0-tgrep-probe-first-contract.md) |
| 0.38.0 | [OmniRoute gateway profile](./0.38.0-omniroute-gateway-profile.md) |
| 0.40.0 | [Multi-style ADL and prose language policy](./0.40.0-multi-style-adl-and-prose-language-policy.md) |
| 0.40.1 | [Project-level ADR overrides](./0.40.1-project-level-adr-overrides.md) |
| 0.40.2 | [Rename adr-guard plugin to adr](./0.40.2-rename-adr-guard-plugin-to-adr.md) |
| 0.40.3 | [已接受决策的可上诉性](./0.40.3-appealability-of-accepted-decisions.md) |

## 标签对照表（一次性解码）

记录正文（prose）按团队工作语言起草，但语法标签固定为英文（ADR-0.40.0#02）——这是解析稳定性与跨仓库互操作的基石，不做本地化。下表一次性解码这些英文标签，之后阅读无需再查。插件内置同一对照表的 8 种语言版本（`/adr glossary [语言]`——en、zh-CN、es、fr、ru、ar、pt、ja）；生成的 INDEX 文件仅渲染英文列。解析器容忍标题后的仅展示用括注（如 `## Context (背景)`），但不推荐逐标签括注——会在文件间漂移（协议 Prose language rule 一节）。

| 英文标签 | 样式 | 中文释义 |
| --- | --- | --- |
| `## Context` | nygard | 背景：技术、业务、项目环境中的各方力量 |
| `## Decision` | nygard | 决策：针对上述背景做出的决定 |
| `## Consequences` | nygard、madr | 后果：决策带来的结果，什么变得更容易或更难 |
| `## Context and Problem Statement` | madr | 背景与问题陈述：架构上下文、问题与约束 |
| `## Decision Drivers` | madr（可选） | 决策驱动因素：驱动决策的关键力量（可扩展性、安全性等） |
| `## Considered Options` | madr（可选） | 备选方案：被评估的各选项及其优缺点 |
| `## Decision Outcome` | madr | 决策结果：选定方案及理由（`Chosen option: …, because …`） |
| `## Pros and Cons of the Options` | madr（可选） | 各选项的优缺点明细 |
| `### Confirmation` | madr（可选） | 确认：如何验证决策产生的效果 |
| `## More Information` | madr（可选） | 更多信息：补充材料与引用 |
| `**Positive**` / `**Negative / Risks**` | madr | 正面影响 / 负面影响与风险及缓解 |
| `## Cheatsheet` / `## Quick view` | ocp | 速查表（读者主入口）/ 快览（图 + 表的复述层） |
| `**Status**` | ocp | 小节状态行：emoji + 固定状态词（`✅ accepted` 等） |
| `**Background**` | ocp | 背景：情境与痛点，≤ 3 句 |
| `**Decision**` | ocp | 决策：以 `# / Point / Content` 表格呈现的决策点 |
| `**Rationale**` | ocp | 理由：加粗关键词引导的论据列表 |
| `**Rejected**` | ocp | 已否决：未采纳的备选方案及否决原因（`Option / Reason rejected` 表格） |
| `**Impact**` | ocp | 影响：分层变更清单（插件 / 运行时 / 测试 / 文档等） |
| `**Future extensions**` | ocp | 未来扩展：有意推迟的后续工作 |
| status 枚举 | frontmatter | `proposed`（提议中）→ `accepted`（已接受）或 `rejected`（已否决）；`superseded`（已被取代）、`deprecated`（已废弃） |
| 元数据键 | frontmatter | `style` `status` `created` `date` `layer` `scope` `baseline` `iteration` `domain` `parent` `supersedes` `superseded_by` —— 机器读取，永不本地化 |
