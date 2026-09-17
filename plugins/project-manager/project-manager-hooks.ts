/**
 * Git hook registration for `/project init`.
 *
 * Managed blocks are driven by `project-hooks.jsonc`. Each backend that
 * declares `git_hooks` gets an `OCP-project-hook:<backend>` block inside every
 * configured hook file. Inactive backends have their block removed. Legacy
 * `OCP-gitnexus-update-hook` blocks are also cleaned up.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BackendProbe } from "./project-manager-index"
import { loadProjectHooks } from "./project-hooks-loader"

export interface HookResult {
  hook: string
  status: "registered" | "updated" | "skipped" | "failed"
  detail: string
}

const LEGACY_START_MARKER = "# >>> OCP-gitnexus-update-hook (managed by /project init; do not edit this block) >>>"
const LEGACY_END_MARKER = "# <<< OCP-gitnexus-update-hook <<<"

function markerStart(backend: string): string {
  return `# >>> OCP-project-hook:${backend} (managed by /project init; do not edit this block) >>>`
}

function markerEnd(backend: string): string {
  return `# <<< OCP-project-hook:${backend} <<<`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Remove a managed block from content by line, preserving user code. */
function stripManagedBlock(content: string, backend: string): string {
  const start = markerStart(backend)
  const end = markerEnd(backend)
  const lines = content.split("\n")
  const out: string[] = []
  let inBlock = false
  for (const line of lines) {
    if (line === start) {
      inBlock = true
      continue
    }
    if (line === end) {
      inBlock = false
      continue
    }
    if (!inBlock) out.push(line)
  }
  // Collapse trailing blank runs left by the removed block.
  while (out.length > 1 && out[out.length - 1] === "" && out[out.length - 2] === "") {
    out.pop()
  }
  return out.join("\n")
}

/** Remove legacy GitNexus blocks while preserving user code. */
function stripLegacyBlock(content: string): string {
  const lines = content.split("\n")
  const out: string[] = []
  let inBlock = false
  for (const line of lines) {
    if (line === LEGACY_START_MARKER) {
      inBlock = true
      continue
    }
    if (line === LEGACY_END_MARKER) {
      inBlock = false
      continue
    }
    if (!inBlock) out.push(line)
  }
  while (out.length > 1 && out[out.length - 1] === "" && out[out.length - 2] === "") {
    out.pop()
  }
  return out.join("\n")
}

/** Build the shell block that refreshes a backend's index. */
function hookBlock(backend: string, cli: string, command: string): string {
  return `${markerStart(backend)}
# Auto-refresh project indexes after git operations.
# Runs only when the ${cli} CLI is on PATH; skips silently otherwise.
if command -v ${cli} >/dev/null 2>&1; then
  ${command}
fi
${markerEnd(backend)}
`
}

function isBackendActive(backend: string, cli: string, probe: BackendProbe): boolean {
  if (backend === "gitnexus") return probe.gitnexusEnabled && probe.gitnexusCli
  if (backend === "codegraph") return probe.codegraphEnabled && probe.codegraphCli
  if (backend === "dbhub") return probe.dbhubEnabled && probe.dbhubCli
  return false
}

function inactiveReason(backend: string, cli: string, probe: BackendProbe): string {
  // The <name>Enabled flags come from mcp.<name>.enabled in
  // ~/.config/opencode/opencode.jsonc — name the right file.
  if (backend === "gitnexus") return !probe.gitnexusEnabled ? "gitnexus disabled in opencode.jsonc" : "gitnexus CLI not installed"
  if (backend === "codegraph") return !probe.codegraphEnabled ? "codegraph disabled in opencode.jsonc" : "codegraph CLI not installed"
  if (backend === "dbhub") return !probe.dbhubEnabled ? "dbhub disabled in opencode.jsonc" : "dbhub CLI not installed"
  return `${backend} inactive`
}

/** Sync one hook file: add blocks for active backends, remove blocks for
 * inactive backends, and strip legacy markers. */
function syncHookFile(
  hookPath: string,
  hookName: string,
  backends: string[],
  backendHooks: Record<string, { cli: string; hooks: Record<string, string> }>,
  probe: BackendProbe,
): HookResult {
  try {
    const active = backends.filter((b) => isBackendActive(b, backendHooks[b].cli, probe))
    const inactive = backends.filter((b) => !isBackendActive(b, backendHooks[b].cli, probe))

    if (!existsSync(hookPath)) {
      if (active.length === 0) {
        return { hook: hookName, status: "skipped", detail: inactive.map((b) => inactiveReason(b, backendHooks[b].cli, probe)).join("; ") }
      }
      // Only create the file if at least one active backend wants it.
      const blocks = active.map((b) => hookBlock(b, backendHooks[b].cli, backendHooks[b].hooks[hookName]))
      writeFileSync(hookPath, `#!/bin/sh\n\n${blocks.join("\n")}`, "utf-8")
      chmodSync(hookPath, 0o755)
      return { hook: hookName, status: "registered", detail: `created hook (${active.join(", ")})` }
    }

    let content = readFileSync(hookPath, "utf-8")
    let changed = false

    for (const backend of active) {
      const block = hookBlock(backend, backendHooks[backend].cli, backendHooks[backend].hooks[hookName])
      if (content.includes(markerStart(backend))) {
        const pattern = new RegExp(`${escapeRegExp(markerStart(backend))}[\\s\\S]*?${escapeRegExp(markerEnd(backend))}\\n?`)
        const updated = content.replace(pattern, block)
        if (updated !== content) {
          content = updated
          changed = true
        }
      } else {
        const sep = content.endsWith("\n") ? "" : "\n"
        content = `${content}${sep}\n${block}`
        changed = true
      }
    }

    for (const backend of inactive) {
      if (content.includes(markerStart(backend))) {
        content = stripManagedBlock(content, backend)
        changed = true
      }
    }

    if (content.includes(LEGACY_START_MARKER)) {
      content = stripLegacyBlock(content)
      changed = true
    }

    if (!changed) {
      return { hook: hookName, status: "skipped", detail: "already up to date" }
    }

    if (content.trim() === "" || content.trim() === "#!/bin/sh") {
      rmSync(hookPath, { force: true })
      return { hook: hookName, status: "updated", detail: "removed hook (no active backends)" }
    }

    writeFileSync(hookPath, content + "\n", "utf-8")
    chmodSync(hookPath, 0o755)
    return { hook: hookName, status: "updated", detail: `refreshed managed block (${active.join(", ") || "cleanup"})` }
  } catch (e) {
    return { hook: hookName, status: "failed", detail: String(e) }
  }
}

/**
 * Sync project git hooks from `project-hooks.jsonc`.
 *   - Register/update blocks for active backends.
 *   - Remove blocks for inactive backends.
 *   - Clean up legacy `OCP-gitnexus-update-hook` blocks.
 */
export function registerProjectHooks(root: string, probe: BackendProbe): HookResult[] {
  if (!existsSync(join(root, ".git"))) {
    return [{ hook: "project-hooks", status: "skipped", detail: "not a git repository" }]
  }

  const registry = loadProjectHooks()
  const hooksDir = join(root, ".git", "hooks")

  if (!registry) {
    // Registry missing — still clean up any legacy blocks, then report skip.
    if (existsSync(hooksDir)) {
      for (const name of readdirSync(hooksDir)) {
        const p = join(hooksDir, name)
        if (!statSync(p).isFile()) continue
        const content = readFileSync(p, "utf-8")
        if (content.includes(LEGACY_START_MARKER)) {
          const updated = stripLegacyBlock(content)
          if (updated.trim() === "" || updated.trim() === "#!/bin/sh") {
            rmSync(p, { force: true })
          } else {
            writeFileSync(p, updated + "\n", "utf-8")
          }
        }
      }
    }
    return [{ hook: "project-hooks", status: "skipped", detail: "project-hooks.jsonc not found" }]
  }

  const hookNames = new Set<string>()
  const backendHooks: Record<string, { cli: string; hooks: Record<string, string> }> = {}
  for (const [backend, entry] of Object.entries(registry.backends)) {
    if (entry.git_hooks && Object.keys(entry.git_hooks).length > 0) {
      backendHooks[backend] = { cli: entry.cli, hooks: entry.git_hooks }
      for (const name of Object.keys(entry.git_hooks)) hookNames.add(name)
    }
  }

  if (hookNames.size === 0) {
    return [{ hook: "project-hooks", status: "skipped", detail: "no git hooks configured" }]
  }

  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true })

  const backends = Object.keys(backendHooks)
  return Array.from(hookNames).map((name) => syncHookFile(join(hooksDir, name), name, backends, backendHooks, probe))
}
