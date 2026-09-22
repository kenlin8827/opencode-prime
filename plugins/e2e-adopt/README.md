# E2E Adopt

Scaffolds an E2E red-line policy into the project's **own documentation** —
the runtime-plugin-free successor of the retired `e2e-guard` plugin
(owner decision 2026-09-22, baijiu-shop-inspired).

## Why docs, not a plugin

The retired plugin injected a generic protocol into the system prompt and
carried a hard command gate that was never registered (dead code). The
baijiu-shop project proved the better mechanism: **rules live in the
project's AGENTS.md**, written with project-specific precision (exact test
command, exact spec directory, exact critical journeys). A plugin can never
know those — a fill-in-the-blank template adopted into project docs can.

## How it works

```
/e2e-adopt
    │
    ▼
Detect (read-only, stack-agnostic): conventional e2e dirs +
runner-config hints — the command is NEVER guessed
    │
    ▼
Render template ({{E2E_COMMAND}} stays a placeholder; the agent or
the user fills it in the doc after adoption)
    │
    ▼
Write: docs/e2e-redline.md (create-only) +
       AGENTS.md red-line section (marker-framed, idempotent)
    │
    ▼
Report: everything written + unfilled placeholders + uninstall hint
```

### What detection does NOT do (by design)

No stack table, no command guessing. Tech stacks are not fixed — a
hardcoded probe list is always partial, drifts from reality, and a wrong
pre-fill is worse than an honest blank. The adopt report therefore always
points at the agent-fill path: the agent (same session) inspects the repo's
build/test setup and fills `{{E2E_COMMAND}}` (plus `{{E2E_DIR}}` /
`{{CRITICAL_JOURNEYS}}` when undetected) in `docs/e2e-redline.md` — or the
user edits by hand. The command is single-sourced in the doc; the AGENTS.md
row references it and carries no placeholders. Detection is a convenience,
never a gate.

- `/e2e-adopt dry` previews without writing.
- `/e2e-adopt status` reports adoption state.
- **Uninstall** = delete `docs/e2e-redline.md` + the `<!-- e2e-redline -->`
  section in AGENTS.md. No reverse subcommand — deleting a doc section is a
  trivial manual edit.

## Guarantees

1. **User-invoked only** — the command IS the consent (same philosophy as
   `/adr init` / `/project init`); detection pre-selects, never applies
   silently.
2. **Never overwrites** — an existing `docs/e2e-redline.md` is left alone;
   AGENTS.md content outside the markers is untouched; a missing AGENTS.md
   is reported (not minimally created, so `/project init` keeps its full
   baseline).
3. **No runtime footprint** — no system-prompt injection, no tool gate, no
   switch field. After adoption the policy is ordinary project documentation.

## File layout

- `e2e-adopt.ts` — plugin entry (command registration + hook)
- `e2e-adopt-template.ts` — the red-line template (baijiu-shop four elements:
  risk-graded tiers, confirmation loop, trigger discipline, coverage mandate)
  + renderers + markers
- `e2e-adopt-detect.ts` — pure read-only detection
- `e2e-adopt-apply.ts` — idempotent apply + status
