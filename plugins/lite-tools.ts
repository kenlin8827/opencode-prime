/**
 * lite-tools — compress native tool descriptions for @lite only.
 *
 * opencode ships Claude-Code-derived tool descriptions (~6.5k tok total;
 * bash alone ~1.8k). The bulk is description prose (usage guides, shell
 * notes, examples), NOT the parameter schema (which is typically ~100 tok).
 * Frontier models are RL-trained on these schemas, so short descriptions
 * lose almost nothing.
 *
 * Strategy: compress description only. Leave parameters and jsonSchema
 * untouched — the native Effect Schema is always correct (field names,
 * validation rules) and costs little. Overriding parameters by hand risks
 * field-name mismatches (e.g. oldText vs oldString) that break tool calls
 * at runtime — the exact bug we fixed after the first attempt.
 *
 * tool.definition input has no agent field, so gate via chat.message +
 * chat.params state (both fire per user message before the request is
 * assembled; dual signals guard against either hook dropping the agent
 * field in a future opencode version).
 * Loader contract: this module MUST export a function only
 * (getLegacyPlugins drops files with any non-function export).
 */

const OVERRIDES: Record<string, string> = {
  bash: "Execute a shell command; returns stdout and stderr. Use workdir instead of cd.",
  read: "Read a file, or a line range with offset/limit. Passing a directory path lists its entries.",
  edit: "Surgical edit: oldString must match exactly. Empty oldString creates a new file.",
  grep: "Search file contents with ripgrep-compatible regex.",
  write: "Write a file, creating or overwriting it.",
  glob: "Find files matching a glob pattern.",
  websearch: "Search the web and return results.",
  todowrite: "Create or update a structured todo list for multi-step tasks.",
  webfetch: "Fetch a URL and extract its main content as markdown.",
  task: "Delegate to a read-only assistant. explore: code reading + intent + multi-file navigation (NOT for plain text/regex - use tgrep_search). code-review-fast: ordinary diff review. code-review: deep/final review. advisor: second opinion. vision: image analysis. Only these five available.",
  skill: "Load a scoped skill by name and follow it. Available: git-merge, git-pick, git-pull, git-push, git-rebase.",
  question: "Ask the user a blocking question mid-execution; answers return as selected labels. Use at most once per task — only for irreversible/destructive decisions.",
}

export async function LiteToolsPlugin() {
  let currentAgent = ""
  const track = (agent?: string) => { if (agent) currentAgent = agent }
  return {
    "chat.message": async (input: { agent?: string }, _output: unknown) => track(input.agent),
    "chat.params": async (input: { agent?: string }, _output: unknown) => track(input.agent),
    "tool.definition": async (input: { toolID: string }, output: { description: string }) => {
      if (currentAgent !== "lite") return
      const next = OVERRIDES[input.toolID]
      if (next) output.description = next
    },
  }
}
