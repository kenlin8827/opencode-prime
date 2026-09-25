/**
 * OpenChamber major pin — Unit Tests (no host dependency)
 *
 * `ocp web` drives the OpenChamber CLI's `serve` / `status --quiet` /
 * `stop [--port]` surface, so the web CLI carries the same major-version
 * contract as the opencode runtime: OCP v2 targets `@openchamber/web` v2
 * and must never pull a v3 silently.
 *
 * Pinned here:
 *   - the registry (install/tools.jsonc) installs and upgrades the PINNED
 *     RANGE `@openchamber/web@2` — a range, not an exact version, so in-major
 *     fixes still flow through;
 *   - `upgrade_strategy` is "static" — the "smart" path would re-install the
 *     bare `upgrade_package` (unpinned latest) and sail past the pin;
 *   - `required_major: 2` unlocks exactly one cross-major direction
 *     (v1 → v2 is the compat fix); 2 → 3 stays refused.
 *
 * Run: bun run tests/test-openchamber-pin-unit.ts
 */

import { resolve } from "node:path"
import {
  OPENCHAMBER_WEB_REQUIRED_MAJOR,
  PACKAGE_SPEC,
  openChamberPinContractWarning,
} from "../install/src/openchamber"
import { loadToolRegistry, type ToolRegistry } from "../install/src/installer"
import { requiredMajorRowLocked } from "../install/src/updater"

// Repo root from the test file's own location — never the caller's cwd, so
// the registry lookup works no matter where `bun` was invoked from.
const REPO_ROOT = resolve(import.meta.dir, "..")

let passed = 0
let failed = 0

function assert(cond: unknown, label: string) {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.error(`  ❌ ${label}`)
  }
}

const registry: ToolRegistry | null = loadToolRegistry(REPO_ROOT)
const entry = registry?.tools?.openchamber_web as
  | (Record<string, any> & {
      install?: Record<string, string>
      update_check?: Record<string, any> & { upgrade?: Record<string, string> }
    })
  | undefined

console.log("openchamber_web registry entry — pinned to major 2")

assert(!!entry, "tools.openchamber_web is declared in install/tools.jsonc")
assert(PACKAGE_SPEC === "@openchamber/web@2", "code installs the pinned range @openchamber/web@2")
assert(OPENCHAMBER_WEB_REQUIRED_MAJOR === 2, "the required major is 2")
assert(
  entry?.install?.default === `@pm:@openchamber/web@${OPENCHAMBER_WEB_REQUIRED_MAJOR}`,
  "registry install spec is the pinned range (@pm:@openchamber/web@2)",
)
assert(
  entry?.update_check?.upgrade?.default === `@pm:@openchamber/web@${OPENCHAMBER_WEB_REQUIRED_MAJOR}`,
  "registry upgrade spec is the pinned range (never @latest)",
)
// The pin must be a MAJOR RANGE (`@<digit>`, e.g. `@2`), never an exact
// patch (`@2.0.0`) and never `@latest`. The bare-digits regex catches
// `2.0.0`-style exact pins; the explicit `last` check catches `@latest`
// (which the bare-digits check alone would let through — that was a hole).
const installSpec = entry?.install?.default ?? ""
const upgradeSpec = entry?.update_check?.upgrade?.default ?? ""
assert(
  !/@\d+\.\d+\.\d+/.test(installSpec + upgradeSpec),
  "the pin is a major RANGE, not an exact patch — in-major fixes still install",
)
assert(
  !/@latest\b/.test(installSpec + upgradeSpec),
  "no `@latest` anywhere — that would sail past the major pin into v3",
)
assert(
  entry?.update_check?.upgrade_strategy === "static",
  "upgrade_strategy is static — smart would re-install the unpinned upgrade_package",
)
assert(
  entry?.update_check?.upgrade_package === "@openchamber/web",
  "upgrade_package stays bare (verifyPostUpgradeMajor appends @<version> for the pin-back hint)",
)
assert(
  entry?.update_check?.required_major === OPENCHAMBER_WEB_REQUIRED_MAJOR,
  "registry required_major matches the code constant",
)

console.log("requiredMajorRowLocked — v1 → v2 is the fix, 2 → 3 stays locked")

assert(requiredMajorRowLocked("1.24.2", 2, true) === false, "v1 CLI → offered (crossing up to v2 is the fix)")
assert(requiredMajorRowLocked("2.0.0", 2, true) === true, "in-major row keeps the lock (v3 stays blocked)")
assert(requiredMajorRowLocked("2.5.1", 2, true) === true, "a newer v2 still keeps the lock")
assert(requiredMajorRowLocked("3.0.0", 2, true) === true, "already past the required major → locked")
assert(requiredMajorRowLocked("1.24.2", 2, false) === false, "an explicitly unlocked row stays unlocked")
assert(requiredMajorRowLocked("garbage", 2, true) === true, "unparseable version → fail closed (keep the lock)")

console.log("openChamberPinContractWarning — runtime cross-check of the four contract fields")

// Null registry (e.g. install ran from a non-repo cwd) → no warning.
assert(openChamberPinContractWarning(null) === null, "null registry → no warning (caller decides what to do)")
// Real repo's registry → null (all four fields agree with code constants).
assert(
  openChamberPinContractWarning(registry) === null,
  "repo registry is consistent — warning returns null",
)
// Synthetic drift: required_major bumped to 3 → warning surfaces with that field.
const drifted = {
  tools: {
    openchamber_web: {
      install: { default: `@pm:@openchamber/web@${OPENCHAMBER_WEB_REQUIRED_MAJOR}` },
      update_check: {
        upgrade: { default: `@pm:@openchamber/web@${OPENCHAMBER_WEB_REQUIRED_MAJOR}` },
        required_major: OPENCHAMBER_WEB_REQUIRED_MAJOR + 1,
        upgrade_strategy: "static",
      },
    },
  },
} as unknown as ToolRegistry
const driftMsg = openChamberPinContractWarning(drifted)
assert(driftMsg !== null, "drift on required_major produces a warning")
assert(driftMsg?.includes("required_major") === true, "the warning names the drifted field")
// Synthetic drift: upgrade_strategy flipped back to "smart" (the original footgun).
const smartDrift = {
  tools: {
    openchamber_web: {
      install: { default: `@pm:@openchamber/web@${OPENCHAMBER_WEB_REQUIRED_MAJOR}` },
      update_check: {
        upgrade: { default: `@pm:@openchamber/web@${OPENCHAMBER_WEB_REQUIRED_MAJOR}` },
        required_major: OPENCHAMBER_WEB_REQUIRED_MAJOR,
        upgrade_strategy: "smart",
      },
    },
  },
} as unknown as ToolRegistry
const smartMsg = openChamberPinContractWarning(smartDrift)
assert(smartMsg !== null, "upgrade_strategy=smart produces a warning (would bypass the pin)")
assert(smartMsg?.includes("upgrade_strategy") === true, "the warning names upgrade_strategy as the drifted field")

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
