# Upgrading to OCP 2.x (OpenCode v2 runtime)

OpenCode Prime 2.0.0 is a **new version line built for the OpenCode v2 runtime**
(the 2.0.x series). OCP 0.x targeted the v1 runtime and cannot run on v2 — and
vice versa. This page is the complete migration story: what breaks, what the
installer does for you, and how to move a custom v1 plugin to the v2 API.

::: warning Hard requirement
OCP **2.x requires OpenCode major v2**. There is no compatibility shim: v1
plugins do not load on v2, and a v1 OCP package refuses a v2 runtime (and the
reverse) before touching any file. The decision and its rejected alternatives
are recorded in **ADR-2.0.0** (`docs/adr/2.0.0-adapt-opencode-prime-to-v2-runtime.md`
in the repository).
:::

## TL;DR upgrade steps

`ocp update` / `ocp upgrade` will **not** carry you from 0.x to 2.0.0 — the
major-version lock (ADR-0.41.0) refuses cross-major jumps by design. The
deliberate path is a fresh install:

1. **`ocp init`** — backs up and clears the target config (`~/.config/opencode`).
2. Run the release quick-install one-liner (see [Quick Install](./)):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash   # POSIX
   ```

   ```powershell
   irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1 | iex          # Windows
   ```

The 2.x installer then resolves and pins the newest **v2** opencode release for
you — see the next section for exactly what happens to your runtime binary.

## What the installer does

- **Runtime resolution**: the opencode install channel (`@script:opencode`)
  queries the releases API and takes the newest **v2** tag — never "latest
  overall" — with a pinned v2 fallback if the API is unreachable.
- **v1 → v2 runtime upgrade**: a v1 opencode binary **inside your user
  profile** is upgraded in place (v2 keeps the same config locations). A v1
  binary owned by another manager (brew/choco, outside the profile) is refused
  as externally managed — upgrade it with that manager, then re-run.
- **No downgrade without consent**: a v3+ binary is newer than this OCP line
  can run; the installer refuses and leaves it untouched.
- **Both-direction compat gate**: a v2 package meeting a v1 runtime (or a v1
  package meeting a v2 runtime) is refused **before any mutation**. After
  install the binary major is re-verified (TOCTOU guard).
- **Config preservation**: API keys, custom provider/model definitions, tier
  selections and project-level plugin switches survive the merge. A v1-shaped
  `opencode.jsonc` you hand-edited is absorbed by the runtime's own config
  normalization (legacy keys are migrated, not rejected).
- **Terminal-client migration**: the layered v1 `tui.json` / `tui.jsonc` files
  are retired. On the first v2 run, a legacy v1 `tui.jsonc` **plugin list is
  migrated** into the one global `~/.config/opencode/cli.json`, merged from
  `cli.template.jsonc` (user-added plugins are preserved).
- **Housekeeping**: stale v1-only files (e.g. the old `plugins/rtk-write.ts`
  root barrel) are pruned from the config dir on upgrade, and `@opencode/plugin`
  is installed into the config dir so source-run plugins resolve their import.

## What breaks

| v1 surface (0.x world) | v2 reality | Action |
|---|---|---|
| `tui.template.jsonc` / layered `tui.json(c)` | `cli.template.jsonc` → ONE global `cli.json` (`theme{name,mode}`, `keybinds`, `plugins[]`) | Re-apply any custom TUI tweaks in `cli.json` |
| Root config `agent` block, `permission` string/map, root `model`/`small_model` | V2-native keys: `agents` (plural), ordered `permissions[]` (`{action, resource, effect}`, last match wins), `mcp.servers`; the flash tier's model ref lives in `agents.title.model` | Hand-edits using old keys ride the runtime's normalize; rewrite when convenient |
| v1 plugins (`server()` export, string-keyed hook maps) | **Do not run on v2 at all** — no shim | Migrate (next section) or drop |
| `providers/*.json` preset shape | Presets still ship in the v1 definition shape (`npm`/`options`) and ride the runtime's legacy normalization | No action; a v2-native preset surface is a follow-up iteration |
| Config-level `env` block | Inert on the v2 runtime (the OCP merger preserves your block; the runtime no longer consumes it) | Move real environment needs to shell env / MCP `environment` |
| `{file:}` / `{env:}` prompt markers in agent prompts | Alive and unchanged — verified end to end on v2 | None |

## Migrating a custom v1 plugin

The v2 contract: every entry **default-exports** `Plugin.define({ id, setup })`
from **`@opencode/plugin`** (note the package rename from v1's
`@opencode-ai/plugin`). Behavior registers inside `setup(ctx)` through **domain
hooks** and **synchronous registry transforms** instead of one string-keyed
hook map:

| v1 (string-key hook) | v2 replacement |
|---|---|
| `default export async function server(...)` returning `{ name, ...hooks }` | `Plugin.define({ id, setup(ctx) { ... } })`; registrations return disposables, cleanup returned from `setup` |
| `experimental.chat.system.transform` | `ctx.session.hook("context")` — mutate the `SystemPart[]`; the event carries `agent` and `model` for scoping |
| `chat.params` and other chat-lifecycle mutation | `ctx.session.hook(...)` domain set: `context` / `prompt` / `compaction` / `model.request` |
| `tool.execute.before` / `tool.execute.after` | `ctx.tool.hook("execute.before")` / `ctx.tool.hook("execute.after")` — one mutable event |
| permission/question interception | `ctx.permission.hook("evaluate")` (+ `execute.after` re-authorization — OCP re-architected its question trust channel here) |
| shell command interception | `ctx.shell.hook("create.before")` |
| `event` map (`file.edited`, `session.created`, `session.deleted`, …) | `ctx.event.subscribe(...)` — **`file.edited` no longer exists; use `filesystem.changed`** (skip `unlink`) |
| tool / command registration via config hooks | `ctx.tool.transform(editor.add)`, `ctx.command.transform(editor.add)`, plus `ctx.model.transform`, `ctx.agent.transform`, … |
| TUI plugin API (layered `tui.json`, slot internals) | `@opencode/plugin/tui` slot/keymap API; register in the `plugins[]` list of the global `cli.json` |

A minimal v2 server plugin:

```ts
// ~/.config/opencode/plugins/my-plugin.ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "my-plugin",
  setup(ctx) {
    ctx.session.hook("context", async (event) => {
      if (event.agent !== "build") return
      event.system.push({ type: "text", text: "<my directive>" })
    })
  },
})
```

Reference implementations: every plugin in this suite (`plugins/*.ts` barrels +
`plugins/<name>/` subdirectories) is a working v2 example; contributor details
live in `DEVELOPING.md` §"Plugin system".

## Accepted degradations (OCP-V2-GAP registry)

Where the v2 surface lacks a v1 affordance, OCP accepted a documented
degradation instead of a hack. Each carries an `OCP-V2-GAP` comment in the
source (16 markers at 2.0.0 tag time):

- **Toasts** → the v2 plugin `Context` exposes no TUI notification domain;
  announcements degrade to a server-log line via `plugins/shared/notify.ts`
  (TUI bridge is a follow-up).
- **`/queued` edit** → the v2 inbox API can cancel, re-admit and toggle
  delivery (steer ↔ queue) but cannot rewrite a pending item's payload.
- **`/usage` steps** → v2 folds steps into one assistant message per turn; the
  column counts assistant messages as the closest proxy.
- **Tool-result titles** → v2 `Tool.Result` has no `title` field (tgrep,
  memory-note: titles dropped, text preserved).
- **Command-level variant rewriting** → v2 `Command` carries no model ref;
  per-agent variants are folded onto proven sibling model refs and the variant
  flag is cleared (`plugins/model-variants.ts`).
- **Question authorization re-architected** → auto-advisor / ADR-compaction
  user-channel trust now rides `ctx.tool.hook("execute.after")` +
  `ctx.permission.hook("evaluate")`.
- **Busy modal** → v2 built-in dialogs have no busy prop; wizards draw a
  minimal static panel that the result dialog replaces.
- **Wizard filter box** → v2's select dialog always shows its filter (cosmetic
  change on provider-wizard form sheets).

## Verification status (honest note)

All adaptation nodes passed their per-node unit gates on a **source-run** v2
runtime; the full runtime-integration suite and the final end-to-end pass
against a compiled (non-source-run) v2 binary are tracked in the 2.0.0 release
checklist. Docs claims above match the shipped code at tag time.

## See also

- [Quick Install & Dashboard](./) — fresh install flow
- [Prerequisites & Source Install](./prerequisites) — runtime requirements
- [OCP CLI Reference](/maintenance/ocp-cli) — the major-version lock in detail
- [Plugins & Project Guardrails](/workflows/plugins) — what ships in OCP 2.x
- `install/versions/2.0.0.notes.md` — the release notes (GitHub)
- ADR-2.0.0 / ADR-0.41.0 — the decision records (GitHub: `docs/adr/`)
