# ADR 三风格示例

三种规范风格各一份完整示例,作为手册的一部分随库发布。同样三个决策渲染了两份:`docs/workflows/adr-samples/`(英文)与 `docs/zh/workflows/adr-samples/`(中文),用于实证 ADR 正文语言政策——语法是固定的英文单一权威,正文一律跟随语言环境确定的工作语言。

| 示例 | 风格 | 演示要点 |
| --- | --- | --- |
| [0002-引入 Redis 热读缓存](./0002-introduce-redis-hot-read-caching.md) | `nygard` | 极简三段式叙事(`Context / Decision / Consequences`),编号 H1 |
| [0003-开放 API 限流策略](./0003-api-rate-limiting-strategy.md) | `madr` | system 层完整方案分析:决策驱动、带缺点的候选方案、`Chosen option …, because …`、后果,及可选的 Confirmation / More Information |
| [0.2.54-支付重试与幂等](./0.2.54-payment-retry-idempotency.md) | `ocp` | 迭代容器:`baseline`/`iteration` frontmatter、Cheatsheet + Mermaid 快览、H3 小节五段骨架与 emoji 状态行 |

这些文件仅作参考——它们位于 `docs/adr/` 之外,永远不会被扫描、索引或当作真实决策治理。文件名保留引擎的 ID 前缀格式,确保每份示例都能通过对应 style adapter 的解析与校验。
