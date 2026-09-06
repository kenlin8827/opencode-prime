---
description: Dev-Review - mission-critical dual-review consensus loop: domain-routed coding + dual review + Advisor arbitration (default max 10 rounds). Usage: /dev-review <task> [--max-rounds=N]
agent: build
---

Load the dev skill and execute it with the **dev-review preset**: `--code-review=2` (`--max-rounds` default 10). Use `@code-review-fast` for process rounds, retain `@architect` for the second lens, and apply `prompts/build.md`'s graph-scout selection before dispatching one Scout; `@code-review` (max) remains the final Cleared gate either way.

User request: $ARGUMENTS
