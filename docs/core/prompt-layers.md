# Prompt Disclosure Layers

Every prompt file costs tokens on every injection. OCP therefore sorts its
rules into disclosure layers by **violation cost, not file size** — a rule is
paid for exactly when the agent that needs it runs, and never by the agents
that don't.

## The layers

| Layer | Carrier | Paid when | Contents |
|---|---|---|---|
| **L0** | `opencode.jsonc:instructions` | every step of every agent | iron rules: `rfc-keywords`, `output-protocol`, `verification-honesty`, `routing-index` |
| **L1** | agent `prompt` field, assembled from `{file:}` markers | while that agent runs | role rules: coding pack, `sql-migration`, review criteria |
| **L2** | `skills/*/SKILL.md` metadata | resident every step, visibility gated by the agent `permissions[]` rules; **body loads on demand** via the slash-command launchers in `commands/*.md` | scenario rules: workflow protocols (`sdd-workflow`, `dev`, `goal`, `handoff`, …) |
| **L3** | your project's `AGENTS.md` (OpenCode native) | when files in that directory are read | your personal / project rules |

L0 is the expensive layer (paid × steps × agents), so it stays under a hard
token budget enforced by `scripts/measure-prompts.ts` in the release gate.

**Single source of truth.** Agent *definitions* (mode, model, permissions,
tools, prompt assembly) live only in the jsonc `agents` block. The
`prompts/*.md` fragments are pure bodies without frontmatter, and must never
live under `agents/` in the installed config: opencode auto-discovers
`agents/*.md` as agent definitions whose frontmatter/body silently override
the jsonc block (v2 discovery: `~/.config/opencode/agents/<name>.md` and
`.opencode/agents/`, per the agents guide). `prompts/` is not auto-discovered.

## The L1 routing matrix

| Agents | Attached rule files |
|---|---|
| `code`, `fast-coder`, `java-dev`, `python-dev`, `go-dev`, `rust-dev`, `node-dev`, `frontend-dev`, `devops`, `qa` | coding pack: `coding-principles` + `comment-strategy` + `edit-protocol` + `test-scope` |
| `dba` | coding pack + `sql-migration` |
| `code-review` | `coding-principles` + `comment-strategy` + `test-scope` (no `edit-protocol` — editing is denied) |
| `code-review-fast` | shared review body + `coding-principles` (P0/P1 triage; no nit/full test-scope review) |
| `codegraph-scout`, `gitnexus-scout` | compact graph-evidence bodies only; no L1 instructions or native tools |
| `architect`, `advisor`, `security` | `coding-principles` only (review criteria) |
| `build`, `plan`, `explore`, `researcher`, `tech-writer`, `vision` | none — L0 only |

## Per-step visibility gating

Two resident layers are gated by per-agent permissions instead of disclosure
(opencode v2 `permissions[]` semantics — an ordered array of
`{action, resource, effect}` rules where the LAST match wins):

- **Skills block** — `{ "action": "skill", "resource": "<name>", "effect":
  "deny" }` drops a skill from the resident skills block; resource `"*"`
  denies every skill. Workflow skills stay visible only for the `build`,
  `plan`, `code` primaries; every subagent denies `"*"`; the `lite` primary
  carries a `"*"` deny plus explicit per-skill allows (handoff,
  memory-summarize, the Git family).
- **MCP tool surface** — `{ "action": "<server>_*", "resource": "*", "effect":
  "deny" }` hides the server's tools. The code-intel servers (`serena`,
  `codegraph`) stay only with agents that actually query code.
- **L0 stripping** — the `lite` primary opts out of L0 entirely: its inline
  prompt carries the `<!-- lite-mode -->` sentinel and `plugins/lite-mode.ts`
  strips it plus every `Instructions from:` block from the system prompt.

In tiered review, each graph backend is exposed only to its selected Scout; bounded relationship
evidence crosses to the deep reviewer instead of graph tool definitions. Scout selection is
optional: no ready backend means direct deep review.

Quantify any change with `scripts/measure-prompts.ts` before releasing.

## Plugin injection gating

Runtime protocol injections (guardrail notices, scoped protocols) are
policy-gated by `plugin-scope.json` (repo root, shipped), consumed by
`plugins/shared/plugin-scope.ts` through the v2 gate
`plugins/shared/agent-scope.ts`. Every injector registers its
`ctx.session.hook("context")` / `ctx.tool.hook(...)` callback behind the
gate before touching the system prompt.

- **Identification** (first hit wins) — the v2 event's `agent` ID
(`detectAgentByName`, the primary channel), then text `identifiers` in the
assembled system parts (the `lite` sentinel, the title-generator prefix —
still needed where the agent ID is insufficient), then session ground truth:
a non-empty `parentID` marks a subagent step (cached per session; consulted
only when the earlier channels miss).
- **Policy** — per-plugin `deny`/`allow` lists using the scope grammar `x`
(identity or state) and `x:*` (any identity in state `x`); unspecified
plugins inherit the `"*"` entry. Shipped default: deny `lite`, `utility`,
`subagent:*` — injections stay out of stripped primaries and every
subagent step. One shipped override: `project-profiler` denies only
`lite`/`utility` — backend routing is a subagent's work discipline
(explore.md defers backend choice to the session profile). Workflow
protocols need no gate at all: they live at L2 and
load only when their slash command runs.
- **Fail-open** — any policy error skips the injection rather than breaking
the step.

## Guard rails

- `routing-index.md` (L0) keeps pointers to every on-demand rule, so demoting
  a rule never loses the iron obligation behind it (e.g. SQL migrations must
  still route to `@dba`; SDD flows must still load the skill first).
- L1 files may cross-reference each other with shorthand (`cp-<slug>`) **only
  within the same disclosure unit** — every agent that cites `cp-<slug>` carries
  `coding-principles.md`.
- Upgrades always propagate: the installer takes the template's
  `instructions` array and factory agents as authoritative; only agents you
  added yourself are preserved verbatim.

## Personal rules

Personal or project-specific rules belong in **L3**: an `AGENTS.md` at your
project root (OpenCode loads it natively when the project is active). Do not
edit the shipped `instructions` array — the installer overwrites it with the
template on every upgrade by design.
