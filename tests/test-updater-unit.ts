/**
 * OCP Upgrade — Unit Tests (no host dependency)
 *
 * Pins the force-override semantics of `ocp upgrade -f` for the OCP
 * archive-download branch. The behavior under test is the decision
 * captured by `shouldSkipUpgradeDownload`:
 *
 *   skip === true  ⇔  !force ∧ probed !== null ∧ !isNewerVersion(probed, repoVersion)
 *
 * In plain English: skip ONLY when the user did NOT pass -f, the remote
 * probe succeeded, AND the probed release is not ahead of the local copy.
 * Every other shape must re-fetch the archive (force, probe failed, or
 * remote is actually newer).
 *
 * The passthrough forwarding from `applyComponentUpgrade` → `executeUpgrade`
 * is intentionally a one-line change; verify it in the diff and via the
 * executeUpgrade entry point's own `force` parse, not here.
 *
 * Run: bun run tests/test-updater-unit.ts
 *
 * Follow-up (runtime pin + fresh-install lock): also pins
 * `selectLatestTagForMajor` (newest tag of a major from a newest-first
 * listing), `majorOfOpencodeOutput` (--version parse),
 * `requiredRuntimeMajor`/`checkRuntimeCompat` (the both-direction runtime
 * gate — v1 runtime + v2 OCP package and vice versa are refused, unprovable
 * dev/"local" versions are fail-open) and `isBlockedFreshInstall`
 * (cross-major `ocp install` refusal in both directions — installed v2 +
 * repo v1 rolls back nothing).
 */

import { isCrossMajorVersion, majorOf, selectLatestTagForMajor } from "../install/src/manifest"
import {
  isBlockedMajorUpgrade,
  majorLockEnabled,
  opencodeRowLocked,
  partitionUpdates,
  policyDefaultFromRegistry,
  shouldOverlayRelease,
  shouldSkipUpgradeDownload,
  type ComponentCheck,
} from "../install/src/updater"
import {
  checkRuntimeCompat,
  isBlockedFreshInstall,
  majorOfOpencodeOutput,
  requiredRuntimeMajor,
} from "../install/src/installer"
import type { ToolRegistry } from "../install/src/installer"

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

console.log("shouldSkipUpgradeDownload — truth table")

// 1. Today's behavior preserved: no force, probe OK, same version → SKIP.
assert(
  shouldSkipUpgradeDownload(false, "1.0.0", "1.0.0") === true,
  "no force + probe OK + same version → skip (today's behavior)",
)

// 2. The fix: force + probe OK + same version → RE-DOWNLOAD.
assert(
  shouldSkipUpgradeDownload(true, "1.0.0", "1.0.0") === false,
  "force + probe OK + same version → re-download (force overrides)",
)

// 3. Probe failed (CN raw.githubusercontent timeout, etc.) → must re-download.
assert(
  shouldSkipUpgradeDownload(false, null, "1.0.0") === false,
  "no force + probe failed → re-download (graceful degrade)",
)

// 4. Real upgrade available → must re-download (unchanged by the fix).
assert(
  shouldSkipUpgradeDownload(false, "2.0.0", "1.0.0") === false,
  "no force + probe newer → re-download (upgrade available)",
)

// 5. Force + probe failed → still re-download (probe failure must not block force).
assert(
  shouldSkipUpgradeDownload(true, null, "1.0.0") === false,
  "force + probe failed → re-download",
)

// 6. Force + probe newer → re-download (force is a no-op when upgrade already needed).
assert(
  shouldSkipUpgradeDownload(true, "2.0.0", "1.0.0") === false,
  "force + probe newer → re-download",
)

// 7. Repo copy ahead of release (dev build / rolling tag) → skip.
assert(
  shouldSkipUpgradeDownload(false, "0.9.0", "1.0.0") === true,
  "no force + probe older than local → skip (repo copy ahead of release)",
)

// 8. Force + probe older than local → still re-download (force always wins).
assert(
  shouldSkipUpgradeDownload(true, "0.9.0", "1.0.0") === false,
  "force + probe older than local → re-download",
)

// 9. force flag parse: the only flag executeUpgrade honors is one of
//    "-f", "--force", "-Force". Verify the consumer-side detection that
//    wires into shouldSkipUpgradeDownload. (Sanity pin on the contract,
//    not the helper itself — helper only sees the boolean.)
//
//    We can't directly test executeUpgrade's flag parsing here without
//    mocking fs/fetch, but the symbol is small and stable: any change
//    to the flag list should require an explicit test update.

console.log("majorOf / isCrossMajorVersion — version math")

assert(majorOf("1.18.32") === 1, "majorOf(1.18.32) === 1")
assert(majorOf("0.45.0") === 0, "majorOf(0.45.0) === 0")
assert(majorOf("v2.0.0") === 2, "majorOf(v2.0.0) === 2 (leading v stripped)")
assert(Number.isNaN(majorOf("beta")), "majorOf(beta) is NaN (unparseable)")
assert(Number.isNaN(majorOf("")), "majorOf('') is NaN")

assert(isCrossMajorVersion("1.18.32", "2.0.0") === true, "1.18.32 → 2.0.0 crosses the major boundary")
assert(isCrossMajorVersion("0.45.0", "1.0.0") === true, "0.45.0 → 1.0.0 crosses the major boundary")
assert(isCrossMajorVersion("1.18.32", "1.19.0") === false, "1.18.32 → 1.19.0 stays in-major")
assert(isCrossMajorVersion("1.18.32", "1.18.32") === false, "same version never crosses")
assert(isCrossMajorVersion("2.0.0", "1.0.0") === true, "direction-agnostic: majors differ")
assert(isCrossMajorVersion("1.0.0", "not.a.version") === false, "unparseable major → not provable, not blocked")

console.log("isBlockedMajorUpgrade — the lock decision")

assert(isBlockedMajorUpgrade("1.18.32", "2.0.0") === true, "opencode 1.18.32 → 2.0.0 is blocked")
assert(isBlockedMajorUpgrade("0.45.0", "1.0.0") === true, "OCP 0.45.0 → 1.0.0 is blocked")
assert(isBlockedMajorUpgrade("1.18.32", "1.19.0") === false, "same-major bump is allowed")
assert(isBlockedMajorUpgrade("1.18.32", "1.18.32") === false, "same version is not an upgrade")
assert(isBlockedMajorUpgrade("2.0.0", "1.0.0") === false, "older latest is a downgrade, not a blocked upgrade")

console.log("majorLockEnabled — per-tool flag vs registry default")

assert(majorLockEnabled(undefined, true) === true, "no flag + locked default → locked")
assert(majorLockEnabled(undefined, false) === false, "no flag + unlocked default → unlocked")
assert(majorLockEnabled(false, true) === false, "explicit opt-out beats locked default")
assert(majorLockEnabled(true, false) === true, "explicit opt-in beats unlocked default")

console.log("policyDefaultFromRegistry — fail-closed registry default")

assert(policyDefaultFromRegistry(null) === true, "registry load failed → locked (fail-closed)")
assert(policyDefaultFromRegistry({} as ToolRegistry) === true, "no update_policy block → locked")
assert(policyDefaultFromRegistry({ update_policy: {} }) === true, "empty policy block → locked")
assert(policyDefaultFromRegistry({ update_policy: { lock_major_default: true } }) === true, "explicit lock_major_default: true → locked")
assert(policyDefaultFromRegistry({ update_policy: { lock_major_default: false } }) === false, "explicit lock_major_default: false → unlocked")

console.log("shouldOverlayRelease — archive overlay respects the lock")

assert(shouldOverlayRelease("1.19.0", "1.18.32") === true, "newer same-major release → overlay")
assert(shouldOverlayRelease("2.0.0", "1.18.32") === false, "newer cross-major release → refuse overlay")
assert(shouldOverlayRelease("1.18.32", "1.18.32") === false, "same version → no overlay")
assert(shouldOverlayRelease("0.9.0", "1.0.0") === false, "older release → no overlay")

console.log("partitionUpdates — the ocp update report wiring")

const comp = (over: Partial<ComponentCheck>): ComponentCheck => ({
  key: "t",
  label: "t",
  local: "1.0.0",
  latest: "1.1.0",
  status: "",
  ...over,
})

// The user-facing examples: opencode 1.18.32 → 2.0.0 and OCP 0.45.0 → 1.0.0.
const opencodeJump = comp({ key: "opencode", label: "opencode", local: "1.18.32", latest: "2.0.0", majorLocked: true })
const ocpJump = comp({ key: "ocp", label: "opencode-prime", local: "0.45.0", latest: "1.0.0", majorLocked: true })
const inMajor = comp({ key: "opencode", label: "opencode", local: "1.18.32", latest: "1.19.0", majorLocked: true })
const optedOut = comp({ key: "rtk", label: "rtk", local: "0.9.0", latest: "1.0.0", majorLocked: false })
const external = comp({ key: "rg", label: "rg", local: "14.0.0", latest: "15.0.0", majorLocked: true, external: true })
const unknownLocal = comp({ key: "x", label: "x", local: null, latest: "2.0.0", majorLocked: true })

{
  const { pending, blocked } = partitionUpdates([opencodeJump, ocpJump, inMajor, optedOut, external, unknownLocal])
  assert(blocked.length === 2 && blocked.includes(opencodeJump) && blocked.includes(ocpJump),
    "locked cross-major rows (opencode 1.18.32→2.0.0, OCP 0.45.0→1.0.0) are blocked")
  assert(pending.length === 2 && pending.includes(inMajor) && pending.includes(optedOut),
    "same-major bumps and lock_major:false opt-outs stay pending")
  assert(!pending.includes(external) && !blocked.includes(external), "externally-managed rows appear in neither list")
  assert(!pending.includes(unknownLocal) && !blocked.includes(unknownLocal), "rows without a local version appear in neither list")
}
{
  // Default lock state: majorLocked undefined behaves as locked.
  const { pending, blocked } = partitionUpdates([comp({ local: "0.45.0", latest: "1.0.0" })])
  assert(blocked.length === 1 && pending.length === 0, "majorLocked undefined → locked (blocked)")
}

console.log("selectLatestTagForMajor — newest tag of one major from a newest-first listing")

assert(selectLatestTagForMajor(["v3.0.0", "v2.0.15", "v2.0.14"], 2) === "v2.0.15", "v3 on top → first v2 wins (never latest-overall)")
assert(selectLatestTagForMajor(["v2.0.15", "v2.0.14"], 2) === "v2.0.15", "all-v2 listing → newest v2")
assert(selectLatestTagForMajor(["3.0.0", "2.0.15"], 2) === "2.0.15", "missing v prefix still parses")
assert(selectLatestTagForMajor(["v2.0.0", "v1.18.32"], 1) === "v1.18.32", "major 1 still selectable (old OCP lines)")
assert(selectLatestTagForMajor(["v2.0.0", "v1.18.32"], 3) === null, "no tag of that major → null (caller falls back to the pinned release)")
assert(selectLatestTagForMajor([], 2) === null, "empty listing → null")

console.log("majorOfOpencodeOutput — parse `opencode --version`")

assert(majorOfOpencodeOutput("opencode 1.18.32") === 1, "typical v1 --version output → 1")
assert(majorOfOpencodeOutput("2.0.0") === 2, "bare v2 version → 2")
assert(Number.isNaN(majorOfOpencodeOutput("local")), "dev build (OPENCODE_VERSION=\"local\") → NaN (fail-open downstream)")
assert(Number.isNaN(majorOfOpencodeOutput("opencode: command not found")), "garbage → NaN (fail-open downstream)")
assert(Number.isNaN(majorOfOpencodeOutput("")), "empty output → NaN")

console.log("requiredRuntimeMajor / checkRuntimeCompat — the both-direction runtime gate")

assert(requiredRuntimeMajor("2.0.0") === 2, "OCP v2 requires the v2 runtime")
assert(requiredRuntimeMajor("2.3.1") === 2, "OCP v2.x requires v2")
assert(requiredRuntimeMajor("1.9.0") === 1, "OCP v1.x requires the v1 runtime")
assert(requiredRuntimeMajor("0.42.0") === 1, "OCP v0.x requires the v1 runtime")
assert(requiredRuntimeMajor("garbage") === 1, "unparseable OCP version → conservative v1")

assert(checkRuntimeCompat(null, "2.0.0").ok === true, "absent/unparseable runtime → fail-open (provisioning pins the major)")
assert(checkRuntimeCompat(2, "2.0.0").ok === true, "v2 runtime + v2 package → ok")
const tooOld = checkRuntimeCompat(1, "2.0.0")
assert(tooOld.ok === false && tooOld.kind === "runtime-too-old" && tooOld.message.includes("Upgrade the runtime"),
  "v1 runtime + v2 package → refused with 'upgrade the runtime' instruction")
const tooNew = checkRuntimeCompat(2, "0.42.0")
assert(tooNew.ok === false && tooNew.kind === "runtime-too-new",
  "v2 runtime + v1-era package → refused (both directions)")
assert(checkRuntimeCompat(2, "1.18.32").ok === false, "1.x OCP line still requires v1: v2 runtime → too-new")

console.log("opencodeRowLocked — v1→v2 runtime crossing is the fix, not a violation")

assert(opencodeRowLocked("1.18.32", 2, true) === false, "OCP v2 line: opencode 1.18.32 → offered for upgrade (unlocked)")
assert(opencodeRowLocked("2.0.9", 2, true) === true, "in-major rows keep the lock (3.0 would still be blocked)")
assert(opencodeRowLocked("2.0.9", 1, true) === true, "OCP v1 line: no unlock — v2 runtime is the too-new direction")
assert(opencodeRowLocked("1.0.0", 2, false) === false, "already-unlocked row stays unlocked")

console.log("isBlockedFreshInstall — fresh-install lock (both directions)")

assert(isBlockedFreshInstall("2.0.0", "0.41.0") === true, "installed v2 + repo v1 → blocked (no rollback)")
assert(isBlockedFreshInstall("0.41.0", "1.0.0") === true, "installed v0 + repo v1 → blocked (no jump forward)")
assert(isBlockedFreshInstall("1.18.32", "2.0.0") === true, "direction-agnostic: majors differ → blocked")
assert(isBlockedFreshInstall("0.41.0", "0.42.0") === false, "same-major reinstall → allowed")
assert(isBlockedFreshInstall("0.41.0", "0.41.0") === false, "same version → allowed")
assert(isBlockedFreshInstall(null, "0.41.0") === false, "first install (no installed.version) → allowed")
assert(isBlockedFreshInstall("garbage", "0.41.0") === false, "unparseable installed version → fail-open")

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
