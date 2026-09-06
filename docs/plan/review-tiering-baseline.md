# Review tiering baseline

Captured before the implementation changes on 2026-09-06.

## Prompt budget baseline

Command: `bun run scripts/measure-prompts.ts`

| Measure | Baseline |
|---|---:|
| L0 | 2691 / 2700 tokens |
| `code-review` L1 | 3976 tokens |
| `code-review` MCP overhead | 3123 tokens/step |
| Fleet | 61645 tokens/step across 23 agents |

## Post-implementation comparison

Command: `bun run scripts/measure-prompts.ts`

| Measure | Current |
|---|---:|
| L0 | 2691 / 2700 tokens |
| `code-review` L1 | 4184 tokens |
| `code-review-fast` L1 | 2802 tokens |
| `code-review-fast` MCP overhead | 0 tokens/step |
| `code-review` MCP overhead | 0 tokens/step |
| `codegraph-scout` L1 | 317 tokens |
| `codegraph-scout` MCP overhead | 2104 tokens/step (1 of 4 snapshot tools) |
| `gitnexus-scout` L1 | 351 tokens |
| `gitnexus-scout` MCP overhead | 0 tokens/step while GitNexus is disabled by default |
| Fleet | 60616 tokens/step across 26 agents |

The repository does not provide a local harness that dispatches reviewer agents or exposes
model token accounting for fixture runs. The fixture catalog now contains representative
files and a real seed bug, and the prompt-level before/after costs are captured above. A
real OpenCode smoke run must still record provider usage events for end-to-end dollar cost.
