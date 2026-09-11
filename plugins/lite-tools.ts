/**
 * lite-tools — compress native tool descriptions for @lite.
 *
 * opencode ships Claude-Code-derived tool descriptions (~6.5k tok total;
 * bash alone ~1.8k). The bulk is description prose (usage guides, shell
 * notes, examples), NOT the parameter schema (~100 tok). Frontier models
 * are RL-trained on these schemas, so short descriptions lose almost
 * nothing. Lite pays this token cost on every step.
 *
 * Strategy: override description only. Leave parameters and jsonSchema
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

const LITE_ONLY = new Set([
  "bash",
  "read",
  "edit",
  "grep",
  "write",
  "glob",
  "websearch",
  "todowrite",
  "webfetch",
  "task",
  "skill",
  "question",
])

const LITE_OVERRIDES: Record<string, string> = {
  bash: "Execute a shell command; returns stdout, stderr and exit code. Use `workdir` instead of `cd`. Set `timeout` for any command that may hang or run long — there is no implicit cap.",
  read: "Read a file with optional line range via `offset` (1-indexed) and `limit`. Passing a directory path lists its entries. For large files prefer `offset`/`limit` over reading whole.",
  edit: "Surgical edit: `oldString` must match exactly. Empty `oldString` creates a new file. On match fail: re-read the file and rebuild the search text — never retry the same string. Batch independent edits in parallel.",
  grep: "Search file contents with ripgrep-compatible regex.",
  write: "Write a file, creating or overwriting it. Requires an absolute path. Read the existing file first when overwriting non-trivial content.",
  glob: "Find files matching a gitignore-style glob; recursive by default; returns workspace-relative paths.",
  websearch: "Search the web and return results.",
  todowrite: "Create or update a structured todo list for multi-step tasks. Each item: `content`, `status` (pending/in_progress/completed/cancelled), `priority` (high/medium/low). Mark in_progress before starting, completed when done — keep the list current.",
  webfetch: "Fetch a URL and extract its main content. Default format markdown; pass `text` or `html` if needed. `timeout` defaults to 120s — set lower for slow endpoints you don't trust.",
  task: "Delegate to an assistant. Five-assist roster (lite-only): `explore` (code reading, intent, multi-file nav — NOT for text/regex, use `tgrep_search`), `code-review-fast` (ordinary diff triage), `code-review` (deep/final review), `advisor` (second opinion on a blocking decision), `vision` (images/OCR/diagrams). Pick the most specific type that fits; default `explore` for generic reading. Subagents are read-only.",
  skill: "Load a scoped skill by name and follow its instructions. Available: git-merge, git-pick, git-pull, git-push, git-rebase, handoff. Load only when the user invokes the corresponding slash command — do not preempt.",
  question: "Ask the user a blocking question with 1–4 labeled options; the answer returns as the selected label. At most once per task — only for irreversible/destructive decisions or genuinely unresolvable ambiguity.",
}

export async function LiteToolsPlugin() {
  let currentAgent = ""
  const track = (agent?: string) => { if (agent) currentAgent = agent }
  return {
    "chat.message": async (input: { agent?: string }, _output: unknown) => track(input.agent),
    "chat.params": async (input: { agent?: string }, _output: unknown) => track(input.agent),
    "tool.definition": async (input: { toolID: string }, output: { description: string }) => {
      if (!LITE_ONLY.has(input.toolID) || currentAgent !== "lite") return
      const next = LITE_OVERRIDES[input.toolID]
      if (next) output.description = next
    },
  }
}