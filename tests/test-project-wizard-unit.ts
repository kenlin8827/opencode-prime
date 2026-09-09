import { strict as assert } from "node:assert"
import projectWizard from "../plugins/tui/project-wizard"
import { createTuiHost } from "../install/src/ui/tui-host"

const host = createTuiHost()
const commands: string[] = []
await projectWizard.tui({
  ui: {},
  keymap: { registerLayer(layer: { commands?: Array<{ name: string }> }) { commands.push(...(layer.commands ?? []).map((command) => command.name)) } },
  kv: { get: <T>(_key: string, fallback?: T) => fallback, set() {} },
} as any, undefined, {} as any)

assert.equal(projectWizard.id, "opencode-prime.project-wizard")
assert.deepEqual(commands, ["project.wizard"])
assert.equal(host.dispatch("missing"), false)
console.log("project wizard plugin registration tests passed")
