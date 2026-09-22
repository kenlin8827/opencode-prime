/** Release preflight: one authoritative shipped-file inventory, never a second
 * shell-specific allowlist. Missing manifests may be generated; existing ones
 * are never silently rewritten, especially not historical version records.
 */
import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { collectShippedFiles, generateManifest, getManifestPath, readManifest } from "../install/src/manifest"

const repo = resolve(import.meta.dir, "..")
const version = process.argv[2]
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Packaging requires a valid explicit release version")
const path = getManifestPath(repo, version)
const expected = collectShippedFiles(repo)
if (!expected.length) throw new Error("Shipped-file inventory is empty")
if (!existsSync(path)) {
  const result = generateManifest(repo, version)
  console.log(`Generated missing manifest: ${result.path} (${result.count} files)`)
} else {
  const actual = readManifest(path)
  const missing = expected.filter(file => !actual?.includes(file))
  const extra = (actual ?? []).filter(file => !expected.includes(file))
  if (!actual || missing.length || extra.length || new Set(actual).size !== actual.length) {
    throw new Error(`Release manifest does not match the shipped inventory. Follow the approved version bump + manifest:generate flow; do not overwrite historical manifests.\nMissing: ${missing.join(", ")}\nUnexpected: ${extra.join(", ")}`)
  }
  console.log(`Release manifest matches ${expected.length} shipped files`)
}
