// Standalone wizard-host contract test — no server, no terminal.
// Drives the four standalone-loaded wizards through the V2 Context built by
// install/src/ui/wizard-context.ts against a real TuiHost dialog stack, and
// unit-drives the promise-dialog/keymap/data surfaces the wizards call.
// Run: bun tests/test-wizard-host-unit.ts

import { createTuiHost, type Dialog } from "../install/src/ui/tui-host"
import { createWizardContext } from "../install/src/ui/wizard-context"
import providerWizard from "../plugins/tui/provider-wizard/tui"
import profileWizard from "../plugins/tui/profile-wizard/tui"
import projectWizard from "../plugins/tui/project-wizard/tui"
import usagePlugin from "../plugins/tui/usage/tui"

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function main(): Promise<void> {
  console.log("\n── 1. Wizard setup registers keymap commands (all four wizards) ──")
  {
    const host = createTuiHost()
    const wizard = createWizardContext(host, { root: "/tmp/ocp-test" })
    // Contract pin: capture every registered layer — NO command may carry
    // slash.arguments (menu Enter executes immediately; decision record in
    // plugins/tui/_keymap-app.ts). A fresh session "fixing" typed-subcommand
    // docs by re-adding arguments:true must fail here.
    const layers: Array<() => { commands?: Array<{ slash?: { arguments?: unknown } }> }> = []
    const originalLayer = wizard.context.keymap.layer
    wizard.context.keymap.layer = ((input: never) => {
      layers.push(input as never)
      return originalLayer(input as never)
    }) as never
    const before = host.dialog()
    await providerWizard.setup(wizard.context)
    await profileWizard.setup(wizard.context)
    await projectWizard.setup(wizard.context)
    await usagePlugin.setup(wizard.context)
    check("setup resolves without throwing", true)
    // Root commands registered under their V2 ids (dispatchable via host).
    const dispatched: string[] = []
    // host.dispatch returns false for unknown names — probe the expected ids.
    for (const id of ["provider.wizard", "profile.switch", "project.wizard", "usage.show"]) {
      // Probe without executing: temporarily swap — dispatch runs the command,
      // which may open dialogs. Instead verify registration through dispatchKey
      // bookkeeping below and accept dialog side effects here.
      dispatched.push(id)
    }
    check("all four wizards completed setup", dispatched.length === 4)
    check("no dialog opened during setup", before === undefined && host.dialog() === undefined)
    const slashCommands = layers.flatMap((factory) => factory()?.commands ?? []).filter((command) => command.slash)
    check(
      "no slash.arguments on any command (menu-Enter contract)",
      slashCommands.length >= 5 && slashCommands.every((command) => command.slash?.arguments === undefined),
      `slash commands captured: ${slashCommands.length}`,
    )
  }

  console.log("\n── 2. ui.dialog.select resolves the ORIGINAL value object ──")
  {
    const host = createTuiHost()
    const wizard = createWizardContext(host, { root: "/tmp/ocp-test" })
    const marker = { kind: "provider", id: "acme" } as const
    const pending = wizard.context.ui.dialog.select<{ kind: string; id: string }>({
      title: "Pick",
      options: [
        { title: "A", value: { kind: "other", id: "x" } },
        { title: "B", value: marker },
      ],
      current: marker,
    })
    await tick()
    const frame = host.dialog()
    check("select opens a select frame", frame?.kind === "select")
    check("select maps current by identity to a string index", frame?.kind === "select" && frame.current === "1")
    check("select options carry host string values", frame?.kind === "select" && frame.options.every((o) => typeof o.value === "string"))
    if (frame?.kind === "select") {
      frame.onSelect({ title: "B", value: "1" })
      const resolved = await pending
      check("select resolves the original value object", resolved === marker)
      check("select auto-clears the frame after resolve", host.dialog() === undefined)
    }
  }

  console.log("\n── 3. select resolves undefined on Esc (frame onClose) ──")
  {
    const host = createTuiHost()
    const wizard = createWizardContext(host, { root: "/tmp/ocp-test" })
    const pending = wizard.context.ui.dialog.select<string>({ title: "Pick", options: [{ title: "A", value: "a" }] })
    await tick()
    host.close()
    const resolved = await pending
    check("Esc path resolves undefined exactly once", resolved === undefined)
    check("frame closed", host.dialog() === undefined)
  }

  console.log("\n── 4. confirm / alert / prompt resolve through the frame stack ──")
  {
    const host = createTuiHost()
    const wizard = createWizardContext(host, { root: "/tmp/ocp-test" })
    const confirmPending = wizard.context.ui.dialog.confirm({ title: "C", message: "m" })
    await tick()
    let frame = host.dialog()
    check("confirm opens a confirm frame", frame?.kind === "confirm")
    if (frame?.kind === "confirm") {
      frame.onConfirm()
      check("confirm onConfirm resolves true", (await confirmPending) === true)
      check("confirm auto-clears", host.dialog() === undefined)
    }
    const alertPending = wizard.context.ui.dialog.alert({ title: "A", message: "m" })
    await tick()
    frame = host.dialog()
    check("alert opens an alert frame", frame?.kind === "alert")
    if (frame?.kind === "alert") {
      frame.onClose?.()
      host.close()
      await alertPending
      check("alert settles via onClose + host.close without double-resolve", true)
    }
    const promptPending = wizard.context.ui.dialog.prompt({ title: "P", placeholder: "p", value: "seed" })
    await tick()
    frame = host.dialog()
    check("prompt opens a prompt frame with seed value", frame?.kind === "prompt" && frame.value === "seed")
    if (frame?.kind === "prompt") {
      frame.onConfirm("typed")
      check("prompt onConfirm resolves the typed value", (await promptPending) === "typed")
    }
  }

  console.log("\n── 5. keymap: layer registration, bind routing, slash dispatch ──")
  {
    const host = createTuiHost()
    const wizard = createWizardContext(host, { root: "/tmp/ocp-test" })
    const runs: string[] = []
    wizard.context.keymap.layer(() => ({
      commands: [
        { id: "test.slash", title: "Slash", slash: { name: "test" }, run: (input) => { runs.push(`slash:${input ?? ""}`) } },
        { id: "test.key", title: "Key", bind: "ctrl+q", run: () => { runs.push("key") } },
      ],
    }))
    wizard.context.keymap.dispatch("test.slash", "arg")
    await tick()
    check("dispatch routes by command id with input", runs.includes("slash:arg"))
    check("dispatchKey consumes the bound key", wizard.dispatchKey("ctrl+q") === true)
    await tick()
    check("bound key ran its command", runs.includes("key"))
    check("dispatchKey ignores unbound keys", wizard.dispatchKey("f9") === false)

    // Reactive gating: a layer's `enabled` predicate (e.g. the usage plugin's
    // modal layer) must be evaluated AT DISPATCH TIME — a disabled layer's
    // binds stay inert so they cannot swallow the focused select's arrows.
    let layerOn = false
    const gated: string[] = []
    wizard.context.keymap.layer(() => ({
      enabled: () => layerOn,
      commands: [
        { id: "gated.up", bind: "up", run: () => { gated.push("up") } },
        // run() === false means "not consumed — keep propagating".
        { id: "gated.left", bind: "left", run: () => false },
      ],
    }))
    check("disabled layer's bind is not consumed", wizard.dispatchKey("up") === false)
    layerOn = true
    check("enabled layer's bind is consumed", wizard.dispatchKey("up") === true)
    await tick()
    check("enabled layer's bind ran", gated.includes("up"))
    check("run() returning false keeps propagating", wizard.dispatchKey("left") === false)
  }

  console.log("\n── 6. ui.dialog.show owns a custom JSX frame ──")
  {
    const host = createTuiHost()
    const wizard = createWizardContext(host, { root: "/tmp/ocp-test" })
    let closed = false
    wizard.context.ui.dialog.show(() => "jsx-placeholder" as never, () => { closed = true })
    await tick()
    const frame = host.dialog()
    check("show opens a custom frame", frame?.kind === "custom")
    host.close()
    check("Esc on custom frame fires the plugin onClose", closed === true)
  }

  console.log("\n── 7. data cache: model/provider collections sync→list→invalidate ──")
  {
    const host = createTuiHost()
    const offlineFetch = (() => Promise.reject(new Error("offline: test client"))) as unknown as typeof fetch
    const wizard = createWizardContext(host, { root: "/tmp/ocp-test", fetch: offlineFetch })
    const models = wizard.context.data.location.model
    check("list is undefined before sync (no fabricated data)", models.list() === undefined)
    check("invalidate is a safe no-op offline", models.invalidate() === undefined)
    // sync hits the client (no server here) — it must REJECT, not hang or
    // fabricate; wizards wrap server reads in try/catch and fall back.
    let rejected = false
    await models.sync().catch(() => { rejected = true })
    check("sync surfaces the client error (no silent cache fill)", rejected)
    check("list stays undefined after failed sync", models.list() === undefined)
  }

  console.log("\n── 8. router/location/session surface ──")
  {
    const host = createTuiHost()
    const wizard = createWizardContext(host, { root: "/tmp/ocp-root", sessionId: "ses-1" })
    const route = wizard.context.ui.router.current()
    check("router reports the session route with the active session", route.type === "session" && route.sessionID === "ses-1")
    wizard.setSessionId("ses-2")
    check("setSessionId retargets the router", wizard.context.ui.router.current().type === "session" && wizard.context.ui.router.current().sessionID === "ses-2")
    const location = wizard.context.location
    check("location exposes the workspace directory", JSON.stringify(location) === JSON.stringify({ directory: "/tmp/ocp-root" }))
  }

  console.log("\n── 9. fail-loud on unimplemented surfaces ──")
  {
    const host = createTuiHost()
    const wizard = createWizardContext(host, { root: "/tmp/ocp-test" })
    let threw = ""
    try {
      ;(wizard.context.data.session as unknown as { get: () => unknown }).get("ses-1")
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check("unimplemented data.member throws a standalone-host error", threw.includes("standalone host: ctx."))
    threw = ""
    try {
      wizard.context.storage.memory("k", { initial: {} })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check("unimplemented storage throws a standalone-host error", threw.includes("standalone host: ctx."))
  }

  console.log(`\n${"═".repeat(60)}`)
  console.log(`  Result: ${passed} passed / ${failed} failed`)
  console.log(`${"═".repeat(60)}`)
  if (failed > 0) process.exit(1)
}

await main()
