# Comment strategy — right medium for the right intent

> Refines cp-why (Comments explain why) + cp-readable (Readability first). Two anti-patterns: **wall of text** (>15 lines pure prose without diagram = **MUST NOT**) and **diagram spam** (diagram on ≤3-line logic = **SHOULD NOT**). Use the simplest medium that communicates intent.

## Escalation ladder

| Rung | Trigger | Format |
|------|---------|--------|
| 0 | Trivial / self-evident | No comment |
| 1 | 1–3 lines context | Single-line `//` / `#` |
| 2 | 4–8 lines, non-trivial decision | Consecutive single-line bullets |
| 3 | >8 lines, complex class/algorithm/method | **ASCII art** in comment block |
| 4 | Multi-component interaction / state machine | **ASCII art** (only if prose can't convey) |

## Medium rules

- **ASCII art** in source code — zero-dependency, renders anywhere. **Mermaid** in `.md` only.
- **MUST NOT** embed ```` ```mermaid ```` inside source code comments.
- **SHOULD** keep ASCII ≤20w × ≤12h. Bigger → move to `.md`.

## Comment style

- **SHOULD** prefer `//` / `#` over `/* */` for inline logic. **MUST NOT** use `/* */` for logic explanation.
- Block comments (`/** */`, `""" """`) **MAY** be used for public API docs (IDE hover) + ASCII art — subject to anti-wall.

## Method/function comment rules

| Scope | Rule |
|------|------|
| Public API method | **SHOULD** have block docstring: 1-line summary + `@param`/`@return` only when non-obvious from name+type |
| Private/internal method | **SHOULD NOT** have block docstring — use `//` if needed |
| `@param`/`@return` | **MUST NOT** restate type/name in prose (`@param name the name` = spam) |
| `@throws` | **SHOULD** document checked exceptions with trigger condition |
| Complex method body (>8 lines to explain) | Escalate per ladder: ASCII flowchart or structured `//` bullets |
| Getter/setter/delegate | **MUST NOT** have any comment — rung 0 |

Good: `/** Processes payment, retrying on transient errors. @param retryMax default 3 */` — Bad: `/** @param req the request */` (restates name).

## Diagram criteria

Diagram **SHOULD** be used only when: 3+ collaborators (non-obvious), 4+ state transitions, multi-step branching algorithm, or 3+ service call chain with async/error paths. **SHOULD NOT** if obvious from names/signatures or ≤3 prose lines. **MUST NOT** repeat what code says.

## Example

```
// Rung 1: single-line
// Retry with backoff — downstream API flaky

// Rung 3: ASCII art in block comment
/**
 *   Controller ──> FraudService ──> RiskScore
 *       ├──> Gateway ──> ChargeResult
 *       └──> Settlement ──> Confirmation
 */
```

## Agent roles

- **Code-writers/reviewers**: escalate rungs when prose >8 lines. **MUST** diagram or restructure at 15. **SHOULD NOT** diagram trivial logic. Flag walls (cp-readable Readability first), spam (cp-less Write less — reuse ladder), Mermaid-in-code, `@param` spam (cp-why Comments explain why). **Doc-writers**: use Mermaid in `.md`; apply same ladder. 1-line comment is best case.
