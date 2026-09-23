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
 * Follow-up (opencode v1 pin + fresh-install lock): also pins
 * `selectLatestV1Tag` (newest v1 from a newest-first listing),
 * `majorOfOpencodeOutput` (--version parse) and `isBlockedFreshInstall`
 * (cross-major `ocp install` refusal in both directions — installed v2 +
 * repo v1 rolls back nothing).
 */

import { isCrossMajorVersion, majorOf, selectLatestV1Tag } from "../install/src/manifest"
import {
  isBlockedMajorUpgrade,
  majorLockEnabled,
  partitionUpdates,
  policyDefaultFromRegistry,
  shouldOverlayRelease,
  shouldSkipUpgradeDownload,
  type ComponentCheck,
} from "../install/src/updater"
import { isBlockedFreshInstall, majorOfOpencodeOutput } from "../install/src/installer"
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

console.log("selectLatestV1Tag — newest v1 from a newest-first listing")

assert(selectLatestV1Tag(["v2.0.0", "v1.18.32", "v1.18.31"]) === "v1.18.32", "v2 on top → first v1 wins (never latest-overall)")
assert(selectLatestV1Tag(["v1.18.32", "v1.18.31"]) === "v1.18.32", "all-v1 listing → newest v1")
assert(selectLatestV1Tag(["2.0.0", "1.18.32"]) === "1.18.32", "missing v prefix still parses")
assert(selectLatestV1Tag(["v2.0.0", "v3.1.0"]) === null, "no v1 tag → null (caller falls back to the pinned v1 release)")
assert(selectLatestV1Tag([]) === null, "empty listing → null")

console.log("majorOfOpencodeOutput — parse `opencode --version`")

assert(majorOfOpencodeOutput("opencode 1.18.32") === 1, "typical --version output → 1")
assert(majorOfOpencodeOutput("2.0.0") === 2, "bare v2 version → 2")
assert(Number.isNaN(majorOfOpencodeOutput("opencode: command not found")), "garbage → NaN (fail-open downstream)")
assert(Number.isNaN(majorOfOpencodeOutput("")), "empty output → NaN")

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
