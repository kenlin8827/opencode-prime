/**
 * tool-compress (v2) — compress native tool descriptions for @lite and @build.
 *
 * opencode ships Claude-Code-derived tool descriptions (~6k tok total;
 * the shell tool alone ~1.8k). The bulk is description prose (usage guides,
 * shell notes, examples), NOT the parameter schema (~100 tok). Frontier
 * models are RL-trained on these schemas, so short descriptions lose almost
 * nothing. Lite and build pay this token cost on every step.
 *
 * Strategy: override description only. Leave the parameter schema untouched —
 * the native schema is always correct (field names, validation rules) and
 * costs little. Overriding parameters by hand risks field-name mismatches
 * (e.g. oldText vs oldString) that break tool calls at runtime — the exact
 * bug we fixed after the first attempt.
 *
 * Shared overrides (bash, read, …) are agent-agnostic. `task` and `skill`
 * name agents/skills in their prose, so each compressed agent carries its
 * own roster text — lite's five-assist list must not leak into build.
 *
 * V2 MAPPING NOTE (v1 → v2):
 *   v1: `tool.definition` (global, one-shot at assembly) + agent tracked
 *   via `chat.message`/`chat.params` state because tool.definition has no
 *   agent field. V2: `ctx.session.hook("context")` carries BOTH the agent
 *   (`e.agent`) and the per-request assembled tool map (`e.tools`, mutable
 *   `{ description, input }` entries) — one hook, no cross-hook state, no
 *   dual-signal drift risk. Descriptions are compressed per request.
 *
 *   V2 tool ids differ from v1 names; ALIASES maps compressed keys onto the
 *   observed v2 registry (`shell`/`execute` ← bash, `subagent` ← task) so
 *   compression keeps hitting the real tools on either host generation.
 *
 * Fail-open: any error leaves `e.tools` untouched.
 */

import type { Plugin } from "@opencode/plugin"

/** Agents that pay full stock tool schemas every step and get compression. */
const COMPRESS_AGENTS = new Set(["lite", "build"])

/** Agent-agnostic compressed descriptions (safe for every compressed agent). */
const SHARED_OVERRIDES: Record<string, string> = {
  bash: "Execute a shell command; returns stdout, stderr and exit code. Use `workdir` instead of `cd`. Set `timeout` for any command that may hang or run long — there is no implicit cap.",
  read: "Read a file with optional line range via `offset` (1-indexed) and `limit`. Passing a directory path lists its entries. For large files prefer `offset`/`limit` over reading whole.",
  edit: "Surgical edit: `oldString` must match exactly. Empty `oldString` creates a new file. On match fail: re-read the file and rebuild the search text — never retry the same string. Batch independent edits in parallel.",
  grep: "Search file contents with ripgrep-compatible regex.",
  write: "Write a file, creating or overwriting it. Requires an absolute path. Read the existing file first when overwriting non-trivial content.",
  glob: "Find files matching a gitignore-style glob; recursive by default; returns workspace-relative paths.",
  websearch: "Search the web and return results.",
  todowrite: "Create or update a structured todo list for multi-step tasks. Each item: `content`, `status` (pending/in_progress/completed/cancelled), `priority` (high/medium/low). Mark in_progress before starting, completed when done — keep the list current.",
  webfetch: "Fetch a URL and extract its main content. Default format markdown; pass `text` or `html` if needed. `timeout` defaults to 120s — set lower for slow endpoints you don't trust.",
}

/** Per-agent overrides for tools whose prose names that agent's roster. */
const AGENT_OVERRIDES: Record<string, Record<string, string>> = {
  lite: {
    task: "Delegate to an assistant. Five-assist roster (lite-only): `explore` (code reading, intent, multi-file nav — NOT for text/regex, use `tgrep_search`), `code-review-fast` (ordinary diff triage), `code-review` (deep/final review), `advisor` (second opinion on a blocking decision), `vision` (images/OCR/diagrams). Pick the most specific type that fits; default `explore` for generic reading. Subagents are read-only.",
    skill: "Load a scoped skill by name and follow its instructions. Available: git-merge, git-pick, git-pull, git-push, git-rebase, handoff, memory-summarize. Load only when the user invokes the corresponding slash command — do not preempt.",
  },
  build: {
    task: "Delegate to a specialist subagent (read-only leaf; never re-dispatch a task tool). Roster & routing: see build.md — explore, researcher, architect, dba, security, *-dev, frontend-dev, qa, code-review-fast, code-review, devops, tech-writer, vision, fast-coder, advisor, codegraph-scout, gitnexus-scout. One agent per step; never merge roles.",
    skill: "Load a scoped skill by name and follow its instructions. Build: all project skills (git-merge, git-pick, git-pull, git-push, git-rebase, handoff, sdd-workflow, adr-*, clean-dead-code, dev*, goal, grill-me, …). Load only when the user invokes the corresponding slash command — do not preempt.",
  },
}

/** v1 logical key → the ids that key can surface under on either host
 *  generation (v1 `bash`/`task` vs v2 `shell`/`execute`/`subagent`). */
const TOOL_ID_ALIASES: Record<string, string[]> = {
  bash: ["bash", "shell", "execute"],
  task: ["task", "subagent"],
}

const COMPRESSED_KEYS = new Set([...Object.keys(SHARED_OVERRIDES), "task", "skill"])

/** Compressed-description lookup for one v2 tool id and agent. Null when
 *  the tool is not compressed or the agent opts out. */
export function compressedDescription(toolID: string, agent: string): string | null {
  if (!COMPRESS_AGENTS.has(agent)) return null
  const key = Object.entries(TOOL_ID_ALIASES).find(([, ids]) => ids.includes(toolID))?.[0] ?? toolID
  if (!COMPRESSED_KEYS.has(key)) return null
  return AGENT_OVERRIDES[agent]?.[key] ?? SHARED_OVERRIDES[key] ?? null
}

/** V2 "context" hook callback: rewrite tool descriptions in place. */
export async function toolCompressContextHook(e: {
  agent?: string | null
  tools?: Record<string, { description?: string } | undefined> | undefined
}): Promise<void> {
  try {
    const agent = e.agent
    if (!agent || !e.tools) return
    for (const [id, tool] of Object.entries(e.tools)) {
      if (!tool || typeof tool.description !== "string") continue
      const next = compressedDescription(id, agent)
      if (next && next !== tool.description) tool.description = next
    }
  } catch {
    // Fail-open: leave stock descriptions untouched.
  }
}

export const ToolCompressPlugin: Plugin.Plugin = {
  id: "opencode-prime.tool-compress",
  async setup(ctx) {
    const context = await ctx.session.hook("context", (e) => toolCompressContextHook(e))
    return async () => {
      await context.dispose()
    }
  },
}

export default ToolCompressPlugin
