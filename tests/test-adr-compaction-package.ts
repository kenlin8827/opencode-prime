/** Isolated release-package smoke test. Never bumps the repository's version,
 * rewrites its historical manifests, tags, or publishes a release.
 * Requires Bun, bash, tar, zip, unzip and sha256sum (or shasum).
 */
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { collectShippedFiles, generateManifest } from "../install/src/manifest"

const repo = resolve(import.meta.dir, "..")
const dir = mkdtempSync(join(tmpdir(), "adr-package-smoke-"))
const versionPath = join(repo, "install/version.json")
const originalVersion = readFileSync(versionPath, "utf8")
const manifestHashes = () => Object.fromEntries(readdirSync(join(repo, "install/versions")).map(name => [name, createHash("sha256").update(readFileSync(join(repo, "install/versions", name))).digest("hex")]))
const originalManifests = manifestHashes()
try {
  for (const file of collectShippedFiles(repo)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    cpSync(join(repo, file), join(dir, file))
  }
  for (const folder of ["install", "bin", "scripts"]) cpSync(join(repo, folder), join(dir, folder), {
    recursive: true, filter: path => !/(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)/.test(path),
  })
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"))
  // This is a fixture label, not an approved release or ADR namespace.
  const unBumpedVersion = pkg.version
  const version = `${pkg.version}-adr-validation`
  pkg.version = version
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2))
  writeFileSync(join(dir, "install/version.json"), JSON.stringify({ ...JSON.parse(originalVersion), version }, null, 2))
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir")
  const manifest = generateManifest(dir, version)
  const entries = readFileSync(manifest.path, "utf8").split("\n")
  const required = ["plugins/adr/adr-compaction.ts", "plugins/adr/adr-compaction-runtime.ts", "plugins/adr/adr-context.ts", "plugins/adr/adr-read-guard.ts", "plugins/adr/adr-storage.ts", "plugins/adr/adr-publication.ts", "plugins/adr/adr-archive.ts", "skills/adr-compaction/SKILL.md", "skills/adr-context/SKILL.md", "plugin-scope.json"]
  for (const path of required) assert.ok(entries.includes(path), `Missing shipped feature file: ${path}`)
  assert.ok(!entries.some(path => path.startsWith("tests/") || path.includes("benchmark-adr-compaction")), "Test/benchmark code must not ship")
  const hashOf = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
  const checkManifest = (file: string) => Bun.spawnSync(["bun", join(dir, "scripts/check-package-manifest.ts"), file], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const releaseManifest = join(dir, "install/versions", `${unBumpedVersion}.manifest.txt`)
  // A matching manifest passes and is never rewritten.
  const releaseHash = hashOf(releaseManifest)
  const matched = checkManifest(unBumpedVersion)
  assert.equal(matched.exitCode, 0, `check-package-manifest rejected a matching manifest:\n${matched.stdout.toString()}\n${matched.stderr.toString()}`)
  assert.equal(hashOf(releaseManifest), releaseHash, "check-package-manifest rewrote a matching manifest")
  // Drift must fail loudly and must never be auto-healed: regenerating history or
  // silently shipping an incomplete archive are both unacceptable.
  writeFileSync(releaseManifest, readFileSync(releaseManifest, "utf8").replace("plugins/adr.ts", "plugins/adr-does-not-exist.ts"))
  const drifted = checkManifest(unBumpedVersion)
  assert.notEqual(drifted.exitCode, 0, "check-package-manifest accepted a drifted manifest")
  writeFileSync(releaseManifest, `${readFileSync(releaseManifest, "utf8")}plugins/adr/adr-not-real.ts\n`)
  const extraEntry = checkManifest(unBumpedVersion)
  assert.notEqual(extraEntry.exitCode, 0, "check-package-manifest accepted an unexpected manifest entry")
  writeFileSync(releaseManifest, readFileSync(join(repo, "install/versions", `${unBumpedVersion}.manifest.txt`), "utf8"))
  // pack.sh itself must refuse a drifted manifest for the version it packs
  // instead of building an incomplete archive.
  const validationManifest = manifest.path, validationContent = readFileSync(validationManifest, "utf8"), validationHash = hashOf(validationManifest)
  writeFileSync(validationManifest, `${validationContent}plugins/adr/adr-not-real.ts\n`)
  const refused = Bun.spawnSync(["bash", join(dir, "scripts/pack.sh"), "--out", join(dir, "dist-refused")], { cwd: dir, stdout: "pipe", stderr: "pipe", maxBuffer: 16 * 1024 * 1024 })
  assert.notEqual(refused.exitCode, 0, "pack.sh built an archive from a drifted manifest")
  assert.ok(!existsSync(join(dir, `dist-refused/opencode-prime-${version}.zip`)), "pack.sh produced archives despite refusing the manifest")
  writeFileSync(validationManifest, validationContent)
  assert.equal(hashOf(validationManifest), validationHash)
  console.log("PASS drifted release manifest is refused by the guard and by pack.sh, without rewriting history")
  for (const script of ["pack.sh", "verify.sh"]) {
    const result = Bun.spawnSync(["bash", join(dir, "scripts", script)], { cwd: dir, stdout: "pipe", stderr: "pipe", maxBuffer: 16 * 1024 * 1024 })
    assert.equal(result.exitCode, 0, `${script}:\n${result.stdout.toString()}\n${result.stderr.toString()}`)
    console.log(`PASS isolated ${script}: ${manifest.count} manifest files`)
  }
  const zip = join(dir, `dist/opencode-prime-${version}.zip`), tar = join(dir, `dist/opencode-prime-${version}.tar.gz`)
  assert.ok(existsSync(zip) && existsSync(tar))
  const packaged = ["plugins/adr.ts", "plugins/adr/adr-compaction.ts", "plugins/adr/adr-compaction-runtime.ts", "plugins/adr/adr-context.ts", "plugins/adr/adr-read-guard.ts", "skills/adr-compaction/SKILL.md", "skills/adr-context/SKILL.md"]
  const listing = (output: string) => output.split("\n").map(line => line.replace(`opencode-prime-${version}/`, "")).filter(line => line && !line.endsWith("/"))
  const zipList = listing(Bun.spawnSync(["unzip", "-Z1", zip], { stdout: "pipe" }).stdout.toString())
  const tarList = listing(Bun.spawnSync(["tar", "tzf", tar], { stdout: "pipe" }).stdout.toString())
  for (const file of packaged) {
    assert.ok(zipList.includes(file), `ZIP archive is missing ${file}`)
    assert.ok(tarList.includes(file), `tar.gz archive is missing ${file}`)
  }
  // pack.sh intentionally adds install/, bin/, scripts/, package.json and the
  // generated manifest; everything else must be manifest-listed.
  const extras = new Set(["package.json"])
  for (const list of [zipList, tarList]) for (const file of list) assert.ok(!file || file.startsWith("install/") || file.startsWith("bin/") || file.startsWith("scripts/") || extras.has(file) || entries.includes(file), `Archive contains an unlisted file: ${file}`)
  console.log(`PASS archives carry ${packaged.length} required feature files and no unlisted payloads`)
} finally {
  rmSync(dir, { recursive: true, force: true })
  assert.equal(readFileSync(versionPath, "utf8"), originalVersion)
  assert.deepEqual(manifestHashes(), originalManifests)
}
console.log("PASS ADR files packaged and hash-verified; real version/history unchanged")
