import { strict as assert } from "node:assert"
import projectWizard, { applyAdrSuiteToSwitches, detectAdrSuite } from "../plugins/tui/project-wizard/tui"

// v2 plugin entry: default export is Plugin.define({ id, setup }) — a fake
// Context harness captures the keymap commands without a renderer.
const commandIds: string[] = []
const layerThunks: Array<() => { commands?: Array<{ id?: string }> }> = []
const fakeCtx = {
  keymap: {
    layer(input: () => { commands?: Array<{ id?: string }> }) {
      layerThunks.push(input)
      for (const command of input().commands ?? []) if (command.id) commandIds.push(command.id)
    },
  },
  // Harness mimics the host contract: keymap layers register from a slot
  // render (plugins/tui/_keymap-app.ts → append:"app"), never directly in
  // setup — the real TUI requires a reactive owner for layer().
  slotClaims: [] as Array<{ append?: string; render: (input: unknown) => unknown }>,
  ui: {
    slot(claim: { append?: string; render: (input: unknown) => unknown }) {
      fakeCtx.slotClaims.push(claim)
      claim.render({})
      return () => {}
    },
    toast: { show: () => {} },
  },
}
await projectWizard.setup(fakeCtx as never)

assert.equal(projectWizard.id, "opencode-prime.project-wizard")
assert.deepEqual(commandIds, ["project.wizard"])
assert.equal(layerThunks.length, 1)
assert.equal(fakeCtx.slotClaims.length, 1, "setup claims exactly one slot")
assert.equal(fakeCtx.slotClaims[0]!.append, "app", "layer registers via the always-mounted app slot")

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
