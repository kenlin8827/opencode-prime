/**
 * Register a GLOBAL keymap layer the way the V2 TUI actually accepts it.
 *
 * `ctx.keymap.layer` is a Solid hook: it resolves Keymap.Provider through the
 * current reactive owner (`packages/tui/src/context/keykeymap.tsx` createLayer
 * → useValue → useContext). Plugin `setup()` runs outside the reactive tree
 * (a promise continuation of the serialized reconcile), so a direct call there
 * throws `Keymap.Provider is missing`. opencode's own plugins therefore
 * register global slash/palette commands from a render of the ALWAYS-MOUNTED
 * `app` slot — see `feature-plugins/system/stats.tsx` and the docs example in
 * `services/www/src/docs/content/build/plugins/cli.mdx` (slot `append: "app"`
 * wrapping `context.keymap.layer(...)`, `return null`). The contribution's
 * component body runs under Keymap.Provider, and its owner cleanup disposes
 * the layer's bindings when the plugin deactivates.
 *
 * The standalone `ocp provider|profile` host has no slot tree; its
 * `install/src/ui/wizard-context.ts` invokes slot renders once at claim time,
 * so this same shape registers there too.
 *
 * One claim per call — a plugin wanting several layers calls this several
 * times (each claim gets its own `slot#N` key; order is registration order).
 *
 * `slash.arguments` decision record (menu Enter semantics):
 * - WITHOUT it: menu Enter runs the command immediately (provider-style).
 * - WITH it: menu Enter inserts `/name ` for argument typing — one extra
 *   Enter before anything happens.
 * OCP standard: EVERY wizard command runs WITHOUT `arguments` — menu Enter
 * executing immediately is the UX contract (decision: 2026-09-24).
 * Consequences (accepted): typed-with-Enter does NOT reach these commands —
 * it falls to the server command table (if a same-name server command
 * exists, e.g. /project → project-manager) or a plain model message. Use
 * the menu or Ctrl+P palette as the entry point. Subcommands like
 * `/profile reset` / `/usage agent` live as menu entries and in-dialog
 * keys, not typed text. `/project` stays split from its server twin by
 * nature: the TUI menu entry runs the wizard; project-manager's server
 * command keeps serving headless `ocp project <sub>`.
 */
import type { Context, KeymapLayer } from "@opencode/plugin/tui/context"

export function appKeymapLayer(ctx: Context, layer: () => KeymapLayer): void {
  ctx.ui.slot({
    append: "app",
    render() {
      ctx.keymap.layer(layer)
      return null
    },
  })
}
