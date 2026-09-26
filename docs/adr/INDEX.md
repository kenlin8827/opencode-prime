# Architecture Decision Log

> ⚠️ **GENERATED INDEX — DO NOT EDIT BY HAND.** This file is regenerated from the
> ADR records in this directory and its subtree (§9.3). Any hand edit is overwritten
> on the next regeneration — change the records instead. It is a navigation aid,
> never a hand-maintained source of truth.

*Directory: `docs/adr`*

## Records (15)

| ID | Decision Title | Style | Layer | Status | Domain | Iteration | Created |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| [ADR-0.10.0](./0.10.0-cli-and-openchamber-activation.md) | Iteration 0.10.0 · CLI and OpenChamber activation (1 sections) | `ocp` | `system` | 🔵 Proposed | adr-governance | 0 | 2026-08-29 |
| [ADR-0.34.0](./0.34.0-profiler-cache-and-ponytail-removal.md) | Iteration 0.34.0 · Profiler cache and ponytail removal (2 sections) | `ocp` | `system` | 🟢 Accepted | adr-governance | 0 | 2026-09-11 |
| [ADR-0.35.0](./0.35.0-ocp-path-contract.md) | Iteration 0.35.0 · OCP path contract (1 sections) | `ocp` | `system` | 🟢 Accepted | adr-governance | 0 | 2026-09-12 |
| [ADR-0.36.0](./0.36.0-tgrep-probe-first-contract.md) | Iteration 0.36.0 · tgrep probe-first contract (1 sections) | `ocp` | `system` | 🟢 Accepted | adr-governance | 0 | 2026-09-14 |
| [ADR-0.38.0](./0.38.0-omniroute-gateway-profile.md) | Iteration 0.38.0 · OmniRoute gateway profile (1 sections) | `ocp` | `system` | 🟢 Accepted | adr-governance | 0 | 2026-09-15 |
| [ADR-0.40.0](./0.40.0-multi-style-adl-and-prose-language-policy.md) | Iteration 0.40.0 · Multi-style ADL and prose language policy (2 sections) | `ocp` | `system` | 🔵 Proposed | adr-governance | 0 | 2026-09-18 |
| [ADR-0.40.1](./0.40.1-project-level-adr-overrides.md) | Iteration 0.40.1 · Project-level ADR overrides (4 sections) | `ocp` | `system` | 🟢 Accepted | adr-governance | 1 | 2026-09-18 |
| [ADR-0.40.2](./0.40.2-rename-adr-guard-plugin-to-adr.md) | Iteration 0.40.2 · Rename adr-guard plugin to adr (1 sections) | `ocp` | `system` | 🟢 Accepted | adr-governance | 2 | 2026-09-19 |
| [ADR-0.40.3](./0.40.3-appealability-of-accepted-decisions.md) | Iteration 0.40.3 · Appealability of accepted decisions (1 sections) | `ocp` | `system` | 🟢 Accepted | adr-governance | 3 | 2026-09-21 |
| [ADR-0.41.0](./0.41.0-major-version-upgrade-lock.md) | Iteration 0.41.0 · Major-version upgrade lock (6 sections) | `ocp` | `system` | 🟢 Accepted | updater | 0 | 2026-09-22 |
| [ADR-0.44.0](./0.44.0-per-task-checkpoint-dirs.md) | Iteration 0.44.0 · Per-task checkpoint directories (1 sections) | `ocp` | `system` | 🟢 Accepted | runtime | 0 | 2026-09-24 |
| [ADR-2.0.0](./2.0.0-adapt-opencode-prime-to-v2-runtime.md) | Iteration 2.0.0 · Adapt OpenCode Prime to the OpenCode v2 runtime (1 sections) | `ocp` | `system` | 🟢 Accepted | runtime | 0 | 2026-09-24 |
| [ADR-2.0.0](./2.0.0-session-language-marker-injection.md) | · Session language via runtime marker injection | `madr` | `system` | 🟢 Accepted | i18n |  | 2026-09-25 |
| [ADR-2.0.0](./2.0.0-flat-layout-pm-probe-and-method-alignment.md) | · Flat-layout PM probe with opencode-method alignment | `madr` | `system` | 🟢 Accepted | installer |  | 2026-09-26 |
| [ADR-2.0.0](./2.0.0-typed-plugin-literals-namespaced-ids.md) | · Typed plugin literals, namespaced plugin ids, zero runtime imports | `madr` | `system` | 🟢 Accepted | runtime |  | 2026-09-26 |

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
