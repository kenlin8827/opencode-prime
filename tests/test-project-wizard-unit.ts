import { strict as assert } from "node:assert"
import projectWizard, { applyAdrSuiteToSwitches, detectAdrSuite } from "../plugins/tui/project-wizard"
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

// applyAdrSuiteToSwitches — the /adr init bundles land on the wizard state.
const standard = applyAdrSuiteToSwitches({} as never, "standard")
assert.equal(standard.adrStyle, "madr", "standard → adrStyle madr")
assert.equal(standard.adrNumbering, "sequential", "standard → sequential numbering")
assert.equal(standard.adrGovernance, "none", "standard → no governance")
assert.equal(standard.adrLayout, "auto", "standard → auto layout (legacy root key)")

const evolution = applyAdrSuiteToSwitches({} as never, "evolution")
assert.equal(evolution.adrStyle, "madr", "evolution → adrStyle madr")
assert.equal(evolution.adrNumbering, "iteration", "evolution → iteration numbering")
assert.equal(evolution.adrGovernance, "review", "evolution → review governance")
assert.equal(evolution.adrLayout, "hierarchical", "evolution → hierarchical layout (legacy root key)")

const keepOthers = applyAdrSuiteToSwitches({ envGuard: "off" } as never, "standard")
assert.equal(keepOthers.envGuard, "off", "suite application never touches unrelated switches")

// ocp suite — container preset lands on the wizard state.
const ocpSuite = applyAdrSuiteToSwitches({} as never, "ocp")
assert.equal(ocpSuite.adrStyle, "ocp", "ocp → adrStyle ocp")
assert.equal(ocpSuite.adrNumbering, "iteration", "ocp → iteration numbering")
assert.equal(ocpSuite.adrGovernance, "review", "ocp → review governance")
assert.equal(ocpSuite.adrLayout, "hierarchical", "ocp → hierarchical layout (legacy root key)")

// detectAdrSuite — reverse mapping for the main-menu badge.
assert.equal(detectAdrSuite({} as never), null, "empty state matches no suite")
assert.equal(detectAdrSuite(standard), "standard", "applied standard round-trips")
assert.equal(detectAdrSuite(evolution), "evolution", "applied evolution round-trips")
assert.equal(detectAdrSuite(ocpSuite), "ocp", "applied ocp suite round-trips")
const customMix = applyAdrSuiteToSwitches({} as never, "evolution")
customMix.adrGovernance = "strict"
assert.equal(detectAdrSuite(customMix), null, "partially overridden state is custom, not a suite")

console.log("project wizard plugin registration tests passed")
