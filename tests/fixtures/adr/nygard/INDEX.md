# Architecture Decision Log

> ⚠️ **GENERATED INDEX — DO NOT EDIT BY HAND.** This file is regenerated from the
> ADR records in this directory and its subtree (§9.3). Any hand edit is overwritten
> on the next regeneration — change the records instead. It is a navigation aid,
> never a hand-maintained source of truth.

*Directory: `tests/fixtures/adr/nygard`*

## Records (1)

| ID | Decision Title | Style | Layer | Status | Domain | Iteration | Created |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| [ADR-0001](./0001-use-postgresql.md) | Use PostgreSQL as the primary database | `nygard` | `system` | 🟢 Accepted |  |  | 2026-09-02 |

## Label glossary

Grammar labels are fixed English in every record — prose follows the team's
working language (ADR-0.40.0#02). One-time decoding below; the labels
themselves are never localized. Translations ship in the plugin
(`/adr glossary` — 8 locales); generated files stay English-only.

| Label | Style | Meaning |
| :--- | :--- | :--- |
| `## Context` | nygard | Forces at play: technical, business, project context |
| `## Decision` | nygard | The decision made in response to the context |
| `## Consequences` | nygard · madr | Resulting context: what becomes easier or harder |
| `## Context and Problem Statement` | madr | Architectural context, the problem, and constraints |
| `## Decision Drivers` | madr (optional) | Forces driving the decision (scalability, security, …) |
| `## Considered Options` | madr (optional) | Alternatives evaluated, each with pros/cons |
| `## Decision Outcome` | madr | The chosen option and rationale (`Chosen option: …, because …`) |
| `## Pros and Cons of the Options` | madr (optional) | Per-option advantage/disadvantage detail |
| `### Confirmation` | madr (optional) | How the decision's outcomes will be verified |
| `## More Information` | madr (optional) | Supplementary material and references |
| `**Positive**` / `**Negative / Risks**` | madr | Good impacts / trade-offs and mitigations |
| `## Cheatsheet` / `## Quick view` | ocp | Reader's primary entry / restatement layer (graphs + tables) |
| `**Status**` | ocp | Section status line: emoji + fixed token (`✅ accepted`, …) |
| `**Background**` | ocp | Situation and pain, ≤ 3 sentences |
| `**Decision**` | ocp | Decision points as a `# / Point / Content` table |
| `**Rationale**` | ocp | Why — bold-keyword-led bullets |
| `**Rejected**` | ocp | Alternatives not taken, as an `Option / Reason rejected` table |
| `**Impact**` | ocp | Layered change list (plugins / runtime / tests / docs / …) |
| `**Future extensions**` | ocp | Deliberately deferred follow-ups |
| status enum | frontmatter | `proposed` → `accepted` or `rejected`; `superseded`, `deprecated` |
| metadata keys | frontmatter | `style` `status` `created` `date` `layer` `scope` `baseline` `iteration` `domain` `parent` `supersedes` `superseded_by` — machine-read, never localized |
