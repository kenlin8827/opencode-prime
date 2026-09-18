# ADR Style Samples

Three complete sample records — one per canonical style — shipped as part of
the manual. The same three decisions are rendered twice, `docs/workflows/adr-samples/`
(English) and `docs/zh/workflows/adr-samples/` (Chinese), to demonstrate the
ADR prose-language policy: grammar is a fixed English authority; ALL prose
follows the working language of the environment.

| Sample | Style | What it demonstrates |
| --- | --- | --- |
| [0002-introduce-redis-hot-read-caching](./0002-introduce-redis-hot-read-caching.md) | `nygard` | Minimal three-section narrative (`Context / Decision / Consequences`), numbered H1 |
| [0003-api-rate-limiting-strategy](./0003-api-rate-limiting-strategy.md) | `madr` | Full system-layer option analysis: drivers, considered options with cons, `Chosen option …, because …`, consequences, optional Confirmation / More Information |
| [0.2.54-payment-retry-idempotency](./0.2.54-payment-retry-idempotency.md) | `ocp` | Iteration container: `baseline`/`iteration` frontmatter, Cheatsheet + Mermaid quick view, H3 sections with the five-part skeleton and emoji status lines |

These files are reference material only — they live outside `docs/adr/` and
are never scanned, indexed, or governed as real records. File names keep the
engine's ID-prefix format so each sample parses and validates cleanly through
its style adapter.
