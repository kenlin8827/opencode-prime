import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"
import { scoped } from "../shared/plugin-scope"
import { loadTgrepOptions } from "../tgrep/tgrep-config"
import { resolveTgrepCapability, type TgrepCapabilityState } from "../tgrep/tgrep-service"

export const MARKER = "[PROJECT CAPABILITIES]"

/** Per-backend capability states. The non-tgrep backends only ever return
 * `ready` or `unavailable`; tgrep widens to the full TgrepCapabilityState
 * set so the [PROJECT CAPABILITIES] block the model reads shows exactly
 * the same state names as the TUI sidebar (single source of truth:
 * resolveTgrepCapability in plugins/tgrep/tgrep-service.ts). */
type Capability = "ready" | "unavailable" | TgrepCapabilityState

export interface ProjectProfile {
  readonly codegraph: Capability
  readonly gitnexus: Capability
  readonly serena: Capability
  readonly tgrep: Capability
}

export function mcpEnabledFrom(text: string, name: string): boolean {
  try {
    const json = text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n")
    const config = JSON.parse(json) as { readonly mcp?: Record<string, { readonly enabled?: boolean }> }
    return config.mcp?.[name]?.enabled === true
  } catch {
    return false
  }
}

function mcpEnabled(name: string): boolean {
  try {
    const configPath = join(homedir(), ".config", "opencode", "opencode.jsonc")
    return mcpEnabledFrom(readFileSync(configPath, "utf8"), name)
  } catch {
    return false
  }
}

function indexedCapability(root: string, directory: string, mcp: string): Capability {
  return existsSync(join(root, directory)) && mcpEnabled(mcp) ? "ready" : "unavailable"
}

export function buildProfile(root: string = process.cwd()): ProjectProfile {
  // Tgrep goes through the shared resolver so the model-visible state
  // here matches the sidebar's `tgrep` badge exactly. Switch-off is
  // represented as `unavailable` for the system-prompt block (the
  // sidebar additionally folds it under OFF + hides the row, but the
  // block is meant for the model, not the user, so the omission is
  // not useful — `unavailable` is the unambiguous fallback).
  let tgrep: Capability = "unavailable"
  try {
    const options = loadTgrepOptions(root)
    if (options.enabled) tgrep = resolveTgrepCapability(root, options)
  } catch { /* optional backend stays unavailable */ }
  return {
    codegraph: indexedCapability(root, ".codegraph", "codegraph"),
    gitnexus: indexedCapability(root, ".gitnexus", "gitnexus"),
    serena: mcpEnabled("serena") ? "ready" : "unavailable",
    tgrep,
  }
}

export function renderProfileBlock(profile: ProjectProfile): string {
  return [
    "",
    "---",
    MARKER,
    `Code intelligence: CodeGraph=${profile.codegraph}; GitNexus=${profile.gitnexus}; Serena=${profile.serena}; Text index: tgrep=${profile.tgrep}`,
    "",
  ].join("\n")
}

const cachedBlocks = new Map<string, string>()

function profileBlock(root: string): string {
  const existing = cachedBlocks.get(root)
  if (existing) return existing
  const block = renderProfileBlock(buildProfile(root))
  cachedBlocks.set(root, block)
  return block
}

export const ProjectProfilerPlugin: Plugin = async ({ client }) => ({
  "experimental.chat.system.transform": async (
    input: { sessionID?: string } | undefined,
    output: { system: string[] },
  ) => {
    try {
      if (!await scoped(input, output.system, "project-profiler", client)) return
      if (output.system.some((entry) => typeof entry === "string" && entry.includes(MARKER))) return

      const block = profileBlock(process.cwd())
      for (let index = output.system.length - 1; index >= 0; index--) {
        const entry = output.system[index]
        if (typeof entry !== "string") continue
        output.system[index] = entry + block
        return
      }
    } catch {
      return
    }
  },
})
