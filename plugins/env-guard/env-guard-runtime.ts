/**
 * Shared env-guard runtime — secret-file path classification and bash
 * leak detection. Pure functions only; the tool guard composes them.
 *
 * Design stance: fail-safe on detection (when a sensitive reference is
 * recognized, block), fail-open on ambiguity (unrecognized command shapes
 * pass through). The tokenizer is reused from adr-runtime, so quoted
 * arguments survive parsing exactly like the commit gate sees them.
 *
 * Known mechanical boundary (same posture as the adr plugin's bash -c note):
 * shell wrappers (`bash -c '...'`, `$(...)`) and glob references (`*.env`)
 * are not inspected; the guard is a hard wall on the common paths, not a
 * formal sandbox.
 */

import { extractBashCommand, tokenize } from "../adr/adr-runtime"

// ─── Path classification ─────────────────────────────────────────────

function normalize(p: string): string {
  return String(p || "").trim().replace(/\\/g, "/")
}

function basenameOf(p: string): string {
  const n = normalize(p)
  const i = n.lastIndexOf("/")
  return i >= 0 ? n.slice(i + 1) : n
}

/**
 * True for files that plausibly bear secrets: basename is `.env` or
 * `.env.<something>` (.env.local, .env.production, ...). `.env.example`
 * and its variants are NOT sensitive — they are the sanctioned scaffold.
 */
export function isSensitiveEnvPath(p: unknown): boolean {
  if (typeof p !== "string") return false
  const base = basenameOf(p)
  if (base === ".env.example" || base.startsWith(".env.example.")) return false
  return base === ".env" || base.startsWith(".env.")
}

/**
 * File path out of a tool-call args object. Mirrors the field names file
 * tools actually use (filePath / path / file_path); first string wins.
 */
export function extractFilePath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  const record = args as Record<string, unknown>
  for (const key of ["filePath", "path", "file_path"]) {
    const v = record[key]
    if (typeof v === "string" && v.trim() !== "") return v
  }
  return null
}

// ─── Bash leak detection ─────────────────────────────────────────────
// Verb sets decide what a command does with a sensitive .env reference.
// Read-like verbs echo contents to the tool output (→ into the LLM
// context); copy verbs with a sensitive SOURCE exfiltrate values into a
// file the guard cannot see. Destination-side references are harmless
// (`cp .env.example .env` scaffolding stays allowed).

const READ_VERBS = new Set([
  "cat", "type", "head", "tail", "less", "more", "zcat", "bat", "grep",
  "egrep", "fgrep", "rg", "awk", "sed", "findstr", "strings", "xxd", "od",
  // PowerShell aliases / cmdlets
  "get-content", "gc", "select-string",
])

const COPY_VERBS = new Set([
  "cp", "mv", "rsync", "scp", "robocopy", "xcopy",
  // PowerShell cmdlets
  "copy-item", "move-item",
])

const BOUNDARY_RE = /^(?:&&|\|\||[;|&<(])+/
const TRAILING_BOUNDARY_RE = /(?:&&|\|\||[;|&>])+$/

/**
 * Whitespace chunks of a token. Quoted arguments arrive as single tokens
 * with their quotes stripped — splitting again keeps the path-detection
 * granular, at the price of blocking prose that literally mentions a
 * sensitive name (fail-safe direction for a secret guard).
 */
function chunksOf(token: string): string[] {
  return token.split(/\s+/).filter((s) => s !== "")
}

function isPathLike(s: string): boolean {
  return !s.startsWith("-") && !/^[<>|&();]+$/.test(s)
}

/**
 * True when a shell command reads a sensitive .env file's contents into
 * the tool output, or copies one out to another path:
 *
 *   - read-like verb (cat/grep/Get-Content/…) with a sensitive reference
 *   - `< .env…` input redirection feeding any command
 *   - copy verb whose SOURCE (not final destination) is sensitive
 *
 * `.env.example` references never trigger. Non-read verbs (touch, rm, ls,
 * git, …) pass — they do not surface values to the LLM.
 */
export function bashLeaksEnv(command: string): boolean {
  const tokens = tokenize(command)
  if (tokens.length === 0) return false

  // One simple-command segment at a time; chained commands (`cat .env &&
  // ls`) are judged independently — a leak in ANY segment blocks.
  let verb = ""
  let argPaths: string[] = []
  const flush = (): boolean => {
    const leaked = verb !== "" && segmentLeaks(verb, argPaths)
    verb = ""
    argPaths = []
    return leaked
  }

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]

    // Input redirection: `< .env` — the next chunk feeds stdin of whatever
    // runs, so the contents land in the command's output.
    if (raw === "<" || /^<[^<]/.test(raw)) {
      const rest = raw === "<" ? "" : raw.slice(1)
      const next = rest !== "" ? rest : tokens[i + 1] ?? ""
      if (chunksOf(next).some((c) => isSensitiveEnvPath(c))) return true
      continue
    }

    // Split the token into leading boundary / body / trailing boundary
    // WITHOUT pre-stripping — a glued separator (`hi;`) is the signal that
    // the current segment ends, and must not be silently removed.
    const leading = raw.match(BOUNDARY_RE)?.[0] ?? ""
    const bodyRaw = raw.slice(leading.length)
    const trailing = bodyRaw.match(TRAILING_BOUNDARY_RE)?.[0] ?? ""
    const body = bodyRaw.slice(0, bodyRaw.length - trailing.length)

    if (leading !== "" && body === "") {
      // Pure separator token — settle the current segment.
      if (flush()) return true
      continue
    }

    if (leading !== "") {
      // Leading-glued boundary (`&&cat`) — settle, then start a new segment
      // whose verb is already carried in `body`.
      if (flush()) return true
      verb = body.toLowerCase()
      continue
    }

    if (verb === "") {
      verb = body.toLowerCase()
      continue
    }

    for (const chunk of chunksOf(body)) {
      if (isPathLike(chunk)) argPaths.push(chunk)
    }
    // Trailing-glued boundary (`hi;`) — this segment ends here.
    if (trailing !== "" && flush()) return true
  }

  return flush()
}

/**
 * Per-segment verdict. Exported separately so tests can exercise the
 * verb/position rules without re-tokenizing.
 */
export function segmentLeaks(verb: string, argPaths: string[]): boolean {
  const sensitive = argPaths.filter((p) => isSensitiveEnvPath(p))
  if (sensitive.length === 0) return false

  const v = verb.toLowerCase()
  if (READ_VERBS.has(v)) return true

  if (COPY_VERBS.has(v)) {
    // Sensitive in SOURCE position = exfiltration. The final path-like
    // argument is the destination, so a reference equal to it is allowed
    // (`cp .env.example .env` → .env is the destination).
    const destination = argPaths[argPaths.length - 1]
    return sensitive.some((p) => normalize(p) !== normalize(destination))
  }

  return false
}

// ─── Bash command passthrough ────────────────────────────────────────

/** Convenience: extract + detect in one call (null command → no leak). */
export function bashArgsLeakEnv(args: unknown): boolean {
  const command = extractBashCommand(args)
  return command !== null && bashLeaksEnv(command)
}

// ─── Block message ───────────────────────────────────────────────────

export function blockMessage(reason: string): string {
  return (
    `[ENV-GUARD] Blocked: ${reason}\n` +
    `.env* files (except .env.example) may bear secrets — their contents ` +
    `must never enter the LLM context (chat, tool output, commits).\n` +
    `Safe alternatives:\n` +
    `1. Read/edit .env.example — it is always allowed.\n` +
    `2. Scaffold real env files in bash: cp .env.example .env\n` +
    `3. Inspect without values: npx envsitter keys --file .env\n` +
    `4. Ask the USER to provide or edit secret values directly.\n` +
    `Never bypass by renaming the file or routing through another tool.`
  )
}
