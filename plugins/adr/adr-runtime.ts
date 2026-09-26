/**
 * Shared adr runtime — log helper, bash command parsing,
 * conventional-commit type detection, and git working-tree ADR detection.
 * Single source of truth for utilities every hook reuses.
 */

import { spawnSync } from "node:child_process"

// ─── Try-catch wrapper ───────────────────────────────────────────────
// Plugin hooks must NEVER crash the user's session. The tool guard does
// NOT use safeHook — its intentional throws are the blocking mechanism.

export function safeHook<H extends (...args: never[]) => Promise<unknown>>(
  hook: H,
  log?: (level: "info" | "warn", msg: string) => Promise<unknown>,
): H {
  return (async (...args: never[]) => {
    try {
      return await hook(...args)
    } catch (err) {
      try { await log?.("warn", `hook error (suppressed): ${String(err)}`) } catch {}
    }
  }) as H
}

// ─── Log helper ──────────────────────────────────────────────────────
// V2: console-backed server log (v1 routed through client.app.log; the v2
// plugin Context has no log domain — console reaches the same server log).

export function makeLogger(service: string) {
  return async (level: "info" | "warn", message: string): Promise<void> => {
    try {
      const line = `[ocp:${service}][${level}] ${message}`
      if (level === "warn") console.warn(line)
      else console.log(line)
    } catch {
      // Logging must never fail a hook.
    }
  }
}

// ─── Bash command extraction ─────────────────────────────────────────

export function extractBashCommand(args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  const c = (args as Record<string, unknown>).command
  return typeof c === "string" && c.trim() !== "" ? c : null
}

// ─── Quote-aware tokenizer ───────────────────────────────────────────
// Splits a shell command on whitespace while keeping quoted strings as
// single tokens (quotes stripped). Needed so a commit message containing
// spaces or semicolons survives parsing.

export function tokenize(cmd: string): string[] {
  const tokens: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (quote === '"' && c === "\\") {
        // keep escaped char inside double quotes
        if (i + 1 < cmd.length) { cur += cmd[++i] }
        continue
      }
      if (c === quote) { quote = null; continue }
      cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
      continue
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (has || cur !== "") { tokens.push(cur); cur = ""; has = false }
      continue
    }
    cur += c
  }
  if (has || cur !== "") tokens.push(cur)
  return tokens
}

// ─── git commit detection ────────────────────────────────────────────

/** True when the command contains a `git commit` invocation (not commit-tree). */
export function isGitCommit(command: string): boolean {
  return findAllCommitTokenIndexes(tokenize(command)).length > 0
}

// Boundary separators between shell commands — standalone tokens (`&&`, `;`,
// `|`, …) or glued to the END of a token (`--amend&&`, `push;`). Leading-glued
// forms (`done&&git`) and shell wrappers (`bash -c '...'`, `$(...)`) are NOT
// split by the tokenizer; such commits escape the mechanical gate and are
// covered by protocol discipline instead (see `skills/adr-protocol/SKILL.md`).
const BOUNDARY_RE = /^(?:&&|\|\||[;|&])+/
const TRAILING_BOUNDARY_RE = /(?:&&|\|\||[;|&])+$/

/**
 * Indexes of the `commit` token of EVERY `git [global-opts] commit`
 * invocation in the token stream, so chained commits (`git commit ... &&
 * git commit ...`) are all gated individually. Global options between `git`
 * and the subcommand (`-c key=value`, `-C path`, `--no-pager`, ...) are
 * skipped so forms like `git -c user.name=x commit -m ...` are still gated.
 */
function findAllCommitTokenIndexes(tokens: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "git") continue
    let j = i + 1
    while (j < tokens.length) {
      const t = tokens[j]
      if (BOUNDARY_RE.test(t)) break // boundary before any subcommand
      if (t === "-c" || t === "-C") { j += 2; continue } // option with value
      if (t.startsWith("-")) { j++; continue } // other global flags
      break
    }
    if (j < tokens.length && tokens[j] === "commit") out.push(j)
    i = j // continue scanning after this git invocation
  }
  return out
}

/**
 * Argument tokens of EVERY `git commit` invocation — one array per call, up
 * to the next command boundary. Glued boundaries are stripped: a leading
 * boundary ends the scan, a trailing one is cut off the token (so
 * `--amend&&git push` keeps `--amend`). Empty when no `git commit` exists.
 */
export function gitCommitSegments(command: string): string[][] {
  const tokens = tokenize(command)
  return findAllCommitTokenIndexes(tokens).map((start) => {
    const seg: string[] = []
    for (let i = start + 1; i < tokens.length; i++) {
      const t = tokens[i]
      if (BOUNDARY_RE.test(t)) break // standalone or leading glued boundary
      const tail = t.match(TRAILING_BOUNDARY_RE)
      if (tail) {
        const stripped = t.slice(0, t.length - tail[0].length)
        if (stripped) seg.push(stripped)
        break
      }
      seg.push(t)
    }
    return seg
  })
}

/** True when ANY commit invocation carries --amend (re-commit, not new work). */
export function hasAmendFlag(command: string): boolean {
  return gitCommitSegments(command).some((seg) => seg.includes("--amend"))
}

/** True when a commit segment stages tracked working-tree modifications:
 *  `-a`, `--all`, or a combined short-flag cluster containing `a` (`-am`,
 *  `-qa`). The cluster scan stops at `m` — `-m` consumes the rest of the
 *  token as its message value, so `-mfeat` is a glued message, NOT -m -f
 *  -e -a -t. Long flags (`--amend`) never match: they start with `--`. */
export function segmentCommitsAll(seg: string[]): boolean {
  for (const t of seg) {
    if (t === "--all") return true
    if (t.startsWith("--") || !/^-[a-zA-Z]/.test(t)) continue
    const cluster = t.slice(1)
    const mIdx = cluster.indexOf("m")
    const flagPart = mIdx === -1 ? cluster : cluster.slice(0, mIdx)
    if (flagPart.includes("a")) return true
  }
  return false
}

/** Long options whose separate-token value must not be misread as a
 *  pathspec — the `=` form carries the value inline instead. */
const COMMIT_VALUE_LONG_OPTS = new Set([
  "--message", "--file", "--template", "--reuse-message", "--author", "--date",
])

/** Short flags consuming a value: glued to the cluster tail (`-mmsg`) or,
 *  as the cluster's LAST letter, the whole next token (`-F file`). */
const COMMIT_VALUE_SHORT_OPTS = new Set(["m", "F", "t", "C"])

/** True when a commit segment ships NAMED working-tree paths: a bare
 *  positional pathspec (git's implied --only when paths are given), the
 *  `--` separator, `--only`/`--include`, `-o`/`-i`, or short clusters
 *  containing them. Tokens consumed as values by known value-taking
 *  options are NOT pathspecs — mirrors commitMessageOfSegment's skipping
 *  discipline. Fail-closed: an ambiguous bare token counts as a path. */
export function segmentCommitsNamedPaths(seg: string[]): boolean {
  let valueNext = false
  for (const t of seg) {
    if (valueNext) {
      valueNext = false
      continue
    }
    if (t === "--") return true // everything after -- is a pathspec
    if (t.startsWith("--")) {
      const eq = t.indexOf("=")
      const name = eq === -1 ? t : t.slice(0, eq)
      if (name === "--only" || name === "--include") return true
      if (COMMIT_VALUE_LONG_OPTS.has(name) && eq === -1) valueNext = true
      continue
    }
    if (!t.startsWith("-")) return true // bare positional = named pathspec
    if (!/^-[a-zA-Z]/.test(t)) continue // "-3"-style: neither path nor cluster
    const cluster = t.slice(1)
    for (let k = 0; k < cluster.length; k++) {
      const c = cluster.charAt(k)
      if (c === "o" || c === "i") return true
      if (COMMIT_VALUE_SHORT_OPTS.has(c)) {
        // value glued to the rest of the token, or in the next token
        if (k === cluster.length - 1) valueNext = true
        break
      }
    }
  }
  return false
}

// ─── Commit message extraction ───────────────────────────────────────
// Supports the forms agents actually emit:
//   -m "msg"   -m 'msg'   -m msg   -m=msg   --message "msg"   --message=msg
//   -am "msg"  (combined short flags with `m` last)
// Returns null when no inline message is present (editor/heredoc commit) —
// the guard then fails open; the system-prompt protocol still applies.

/** Inline message of one commit invocation's argument tokens, or null. */
export function commitMessageOfSegment(seg: string[]): string | null {
  for (let i = 0; i < seg.length; i++) {
    const t = seg[i]
    if (t === "-m" || t === "--message") {
      return seg[i + 1] ?? null
    }
    if (t.startsWith("--message=")) {
      return t.slice("--message=".length)
    }
    if (t.startsWith("-m=")) {
      return t.slice("-m=".length)
    }
    // Combined short flags ending in `m` (-am, -sm) — message is next token.
    if (/^-[a-zA-Z]+m$/.test(t) && t !== "-m") {
      return seg[i + 1] ?? null
    }
    // Glued form -m<msg> (rare, unquoted).
    if (t.startsWith("-m") && t.length > 2 && !/^-[a-zA-Z]+m$/.test(t)) {
      return t.slice(2)
    }
  }
  return null
}

/**
 * Inline message of the FIRST `git commit` invocation, or null when there is
 * no commit or the first one carries no inline message (editor/heredoc).
 * Multi-commit commands are judged per invocation by the tool guard — this
 * helper is for callers inspecting a single (first) commit.
 */
export function extractCommitMessage(command: string): string | null {
  const segments = gitCommitSegments(command)
  return segments.length > 0 ? commitMessageOfSegment(segments[0]) : null
}

// ─── Conventional-commit type gate ───────────────────────────────────
// Only feat/refactor trigger the iron law (scoped and breaking variants
// included): "feat: x", "feat(api): x", "refactor!: x".

const REQUIRES_ADR_RE = /^\s*(feat|refactor)(\([^)]*\))?!?\s*:/i

export function requiresAdr(message: string): boolean {
  const firstLine = String(message || "").split(/\r?\n/)[0]
  return REQUIRES_ADR_RE.test(firstLine)
}

// ─── ADR working-tree change detection ───────────────────────────────

/**
 * True when any file under any ADR directory is part of the working-tree
 * change set (staged, unstaged, or untracked) — supporting global docs/adr/
 * as well as hierarchical subsystem docs/adr/ paths.
 *
 * Fail-open: on any git error (not a repo, binary missing, timeout) we
 * return true so the guard never blocks on infrastructure problems.
 */
export function hasAdrChanges(projectDir: string, adrDir: string | string[] = "docs/adr"): boolean {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    })
    if (r.error || r.status !== 0) return true
    const stdout = (r.stdout || "").trim()
    if (!stdout) return false

    const lines = stdout.split(/\r?\n/)
    const dirs = (Array.isArray(adrDir) ? adrDir : [adrDir]).map((d) =>
      d.replace(/\\/g, "/").replace(/\/+$/, ""),
    )

    return lines.some((line) => {
      // Git status format: XY <path> or XY <old-path> -> <new-path>
      const rawPath = line.slice(3).trim()
      const filePath = (rawPath.includes(" -> ") ? rawPath.split(" -> ")[1] : rawPath)
        .replace(/\\/g, "/")

      return (
        dirs.some((d) => filePath.startsWith(`${d}/`)) ||
        filePath.includes("/docs/adr/") ||
        filePath.startsWith("docs/adr/") ||
        filePath.endsWith(".md") && filePath.includes("/adr/")
      )
    })
  } catch {
    return true
  }
}

