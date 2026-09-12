# Auto-Advisor Mode

`@advisor` provides an independent second opinion on **blocking** decisions only — and only when genuinely warranted (frugality rule in advisor protocol). Non-blocking decisions proceed by stating assumptions.

---

## Modes

| Mode | Behavior |
|---|---|
| **off** (default) | `@advisor` is never dispatched; orchestrator decides alone. Manual `@advisor` calls still work. |
| **lite** | `@advisor` is dispatched; presents both perspectives to the user to decide. |
| **full** | `@advisor` is dispatched; FACTUAL questions with confidence >= 8 → auto-executes (max 10/session, then degrades to lite); otherwise presents to user (lite flow). |

---

## Switching

```
/auto-advisor off
/auto-advisor lite
/auto-advisor full
```

The `auto-advisor-mode` plugin writes the config before the LLM sees the command, so transitions are code-level reliable.

---

## State persistence

- **Storage**: `autoAdvisorMode` field in `.ocp/ocp.json` — no hidden state files, no environment variables. Values: `off` / `lite` / `full`.
- **Resolution**: Project config (`.ocp/ocp.json`) → `off` (default). Purely project-scoped — no global fallback.
- **Project-only writes**: `/auto-advisor <mode>` updates the field in the project's `.ocp/ocp.json` (preserving comments and other fields); never modifies global config.
- Persists across sessions and processes, scoped to the individual project.

---

## Red-team stance (adversarial design review)

An optional dispatch where `@advisor` argues AGAINST a proposal instead of balancing options:

- **Triggers**: user asks explicitly ("压测这个方案" / "red team this" / "唱反调"), or orchestrator auto-triggers before irreversible design decisions (schema migration, public API contract, auth redesign, destructive data ops).
- **Output**: verdict (`HOLDS` / `HOLDS WITH CAVEATS` / `FAILS`) + severity-ranked attack list + steelmanned defense.
- **On FAILS**: orchestrator re-dispatches the design owner with attacks for rebuttal, then presents both to the user.
- **Auto-execute isolation**: red-team output never carries a confidence score; code-level guard suppresses all auto-execute directives — adversarial verdicts can never trigger full-mode auto-execute.
