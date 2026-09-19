/**
 * Governance enforcement (§11/§13 Phase 6) — the strict decide flow and
 * the append-only decision ledger, plus the staged-diff detection the
 * strict commit gate reuses.
 *
 * Governance is a project-level policy axis (`adr.governance:
 * none | review | strict`), independent of style and of the legacy
 * `adrGuard` commit-presence gate (§6.4). This module is style-agnostic:
 * it operates on normalized record IDs (`ADR-NNNN` / `ADR-x.y.z.qq`,
 * never filename-shaped) and flips ONLY the frontmatter status line
 * (§9.5 byte-stability — the record body stays untouched).
 *
 *   strict mechanics:
 *     - `/adr decide <ADR-ID> [note]` is the ONLY proposed→accepted path;
 *       it flips the status line and appends one ledger line.
 *     - `.ocp/adr-decisions.log` is append-only (flag "a" writes only);
 *       history is never rewritten.
 *     - the tool gate blocks (a) any staged accept flip whose ID has no
 *       ledger entry, and (b) feat/fix/refactor commits that ship no
 *       decided flip — agents can never self-accept.
 *   review mode is protocol-only (§11: "Off (may warn)") — no mechanical
 *   gate, no ledger; the review duty lives in PR review.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { getAdrConfig, getAdrDir, getAdrLayout } from "./adr-config"
import { getAllAdrs, resolveAdrRef, updateAdrIndex, type AdrMeta } from "./adr-engine"
import { adrIdFromFilename, normalizeAdrId } from "./adr-types"

/** Append-only audit ledger, relative to the project root.
 *  TRUST-BOUNDARY NOTE: the ledger is a tripwire over AGENT TOOL calls,
 *  not a security boundary — an agent with raw bash access could forge a
 *  ledger line. Upgrade path: hook-side signing/HMAC of each entry. */
export const DECISIONS_LEDGER_REL = ".ocp/adr-decisions.log"

export interface DecideResult {
  adr: AdrMeta
  /** Canonical normalized ID (`ADR-0001` / `ADR-0.2.54.01`). */
  id: string
  relPath: string
  note: string
}

/**
 * The decide flow — user-only proposed → accepted transition (§11/§13).
 * Refuses outside `strict` governance: in `none`/`review` the human flips
 * the status line by hand and the flip IS the human act (§6.2). Refuses
 * records that are not `proposed` (accepted stays immutable; superseded /
 * deprecated / rejected are archive).
 */
export function decideAdr(projectDir: string, ref: string, note = ""): DecideResult {
  const governance = getAdrConfig().governance
  if (governance !== "strict") {
    throw new Error(
      `Governance mode is '${governance}' — /adr decide is only available in strict mode. ` +
        `In none/review mode the human flips the status line by hand (convention mode).`,
    )
  }

  const cleanRef = ref.trim().replace(/^["']|["']$/g, "")
  // Resolve records from the CONFIGURED root/layout — hard-defaulting to
  // docs/adr here deadlocks an adrDir override: flips under the override
  // dir would be flagged undecidable and /adr decide could never find the
  // record ("Cannot find existing ADR") with no fix path.
  const adrs = getAllAdrs(projectDir, getAdrDir(), getAdrLayout())
  const adr = resolveAdrRef(cleanRef, adrs)
  if (!adr) {
    throw new Error(`Cannot find existing ADR matching '${ref}' to decide.`)
  }

  const id = normalizeAdrId(adr.id)
  if (!id) {
    throw new Error(`ADR '${adr.id}' does not match the ID grammar — cannot decide.`)
  }

  const status = adr.status.toLowerCase()
  if (status.includes("accepted")) {
    throw new Error(`ADR ${id} is already accepted.`)
  }
  if (!status.includes("proposed")) {
    throw new Error(
      `ADR ${id} is '${adr.status}' — only proposed ADRs can be decided. ` +
        `Superseded/deprecated/rejected records stay as archive.`,
    )
  }

  // Flip ONLY the status line INSIDE the first frontmatter block (§9.5
  // byte-stability): a body/fenced line starting `status:` must never be
  // touched — the engine parses frontmatter only, so flipping a body line
  // would desync the record from what the gate just validated. A trailing
  // `# comment` on the status line is preserved. Missing frontmatter
  // status → inject right after the opening fence (hand-rolled docs); no
  // frontmatter at all keeps the historical no-op fallback.
  let content = adr.rawContent
  // §9.5 byte-stability extends to line endings: an injected status line
  // must carry the file's dominant EOL, else a CRLF record gains a lone-LF
  // line. (The replace path below needs no EOL handling: `[^\r\n]+` stops
  // before the CR, so the original line ending survives automatically.)
  const eol = (content.match(/\r\n/g)?.length ?? 0) > (content.match(/[^\r]\n/g)?.length ?? 0) ? "\r\n" : "\n"
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (fmMatch) {
    const fmBody = fmMatch[1] ?? ""
    if (/^status:\s*[^\r\n]+/im.test(fmBody)) {
      const flipped = fmBody.replace(/^status:\s*[^\r\n]+/im, (line) => {
        const comment = /(\s+#.*)$/.exec(line)?.[1] ?? ""
        return `status: Accepted${comment}`
      })
      const openLen = /^---\r?\n/.exec(content)?.[0].length ?? 4
      content =
        content.slice(0, fmMatch.index + openLen) + flipped + content.slice(fmMatch.index + openLen + fmBody.length)
    } else {
      content = content.replace(/^---\r?\n/, `---${eol}status: Accepted${eol}`)
    }
  } else {
    content = content.replace(/^---\r?\n/, `---${eol}status: Accepted${eol}`)
  }
  writeFileSync(adr.fullPath, content, "utf-8")

  appendLedgerLine(projectDir, id, adr.relPath, note)
  updateAdrIndex(projectDir, adr.dir)

  return { adr, id, relPath: adr.relPath, note }
}

/** One append-only ledger line: ISO timestamp, canonical ID, source path,
 *  actor note (tab/newline-sanitized). History is never rewritten. */
export function appendLedgerLine(projectDir: string, id: string, relPath: string, note: string): void {
  const ledgerPath = join(projectDir, DECISIONS_LEDGER_REL)
  mkdirSync(dirname(ledgerPath), { recursive: true })
  const entry = `${new Date().toISOString()}\t${id}\t${relPath}\t${note.replace(/[\t\r\n]+/g, " ")}\n`
  writeFileSync(ledgerPath, entry, { encoding: "utf-8", flag: "a" })
}

/** Canonical IDs recorded in the decide ledger — the commit gate's
 *  cross-check surface. Malformed lines are skipped, never fatal. */
export function readDecidedIds(projectDir: string): Set<string> {
  try {
    const raw = readFileSync(join(projectDir, DECISIONS_LEDGER_REL), "utf-8")
    const ids = new Set<string>()
    for (const line of raw.split(/\r?\n/)) {
      const cols = line.split("\t")
      if (cols.length < 2) continue
      const id = normalizeAdrId(cols[1] ?? "")
      if (id) ids.add(id)
    }
    return ids
  } catch {
    return new Set()
  }
}

export interface StagedAcceptFlip {
  /** Canonical normalized ID (`ADR-0001` / `ADR-x.y.z.qq`). */
  id: string
  relPath: string
}

/** Reverse git's C-style path quoting (core.quotePath=true): the path is
 *  wrapped in double quotes with `\"` `\\` `\n` `\t` escapes and non-ASCII
 *  bytes as octal `\ooo` (UTF-8 source bytes). ASCII/unquoted labels pass
 *  through unchanged. */
function unquoteGitPath(label: string): string {
  if (label.length < 2 || !label.startsWith('"') || !label.endsWith('"')) return label
  const inner = label.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "\\") {
      // UTF-8-encode plain chars: bytes >0x7F must stay multi-byte.
      for (const b of Buffer.from(inner[i] as string, "utf-8")) bytes.push(b)
      continue
    }
    const next = inner[i + 1]
    if (next === undefined) break
    if (next >= "0" && next <= "7") {
      const oct = inner.slice(i + 1, i + 4)
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8))
        i += 3
        continue
      }
    }
    const SIMPLE: Record<string, number> = { '"': 0x22, "\\": 0x5c, n: 0x0a, t: 0x09 }
    bytes.push(SIMPLE[next] ?? next.charCodeAt(0))
    i += 1
  }
  return Buffer.from(bytes).toString("utf-8")
}

/** Pure parse of a `git diff --cached --unified=0` text — split from the
 *  spawn so quoted-path / flip-detection behavior is unit-testable without
 *  a repo. */
export function acceptFlipsFromDiff(diff: string): StagedAcceptFlip[] {
  const flips: StagedAcceptFlip[] = []
  let currentFile: string | null = null
  for (const line of diff.split(/\r?\n/)) {
    // Target file header. Prefixes are forced to a/ b/ on the spawn
    // (CLI flags override user diff.noprefix / mnemonicPrefix config), so
    // the label is always `b/<path>`; /dev/null (deleted file) has no
    // target. Under core.quotePath=true git wraps non-ASCII paths in
    // double quotes (`+++ "b/<path>"`) — unquote BEFORE the prefix check
    // or the flip is silently missed for those records.
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      const label = unquoteGitPath(line.slice(4).trim())
      currentFile = /^[a-z]\//.test(label) ? label.slice(2) : null
      continue
    }
    // Added (not context/metadata) status line settling on accepted —
    // tolerant of quoted YAML scalars (status: "accepted").
    if (currentFile && /^\+status:\s*["']?accepted\b/i.test(line)) {
      const id = adrIdFromFilename(basename(currentFile))
      if (id) flips.push({ id, relPath: currentFile })
    }
  }
  return flips
}

/**
 * ADR files in the STAGED diff whose frontmatter status settles on
 * `accepted` — the strict gate's detection surface. Only the staged diff
 * matters for a plain commit: the guard runs before `git commit`, so the
 * staged content is exactly what the commit would ship. A flip is
 * "undecided" when its ID has no ledger entry (only `/adr decide` writes
 * accepted + ledger).
 *
 * `includeWorkingTree` closes the `git commit -a` hole: `-a`/`--all` also
 * commits TRACKED UNSTAGED modifications, invisible to `--cached` — when
 * set, an unstaged `git diff` pass over the same dirs is concatenated into
 * the parse input so both surfaces are audited.
 *
 * ID extraction routes through adrIdFromFilename — the shared stem
 * grammar covering BOTH sequential (`0001-slug.md`) and dotted iteration
 * (`0.2.54.01-slug.md`) records; there is no four-digit assumption.
 *
 * Fail-open: on any git error we return [] so the guard never blocks on
 * infrastructure problems (same policy as hasAdrChanges).
 */
export function stagedAcceptFlips(
  projectDir: string,
  adrDir: string | string[] = "docs/adr",
  includeWorkingTree = false,
): StagedAcceptFlip[] {
  try {
    const dirs = (Array.isArray(adrDir) ? adrDir : [adrDir]).map((d) =>
      d.replace(/\\/g, "/").replace(/\/+$/, ""),
    )
    const staged = spawnSyncGitDiff(projectDir, dirs, true)
    if (staged === null) {
      // Fail-open asymmetry: never block commits on a broken git probe —
      // but never fail SILENTLY either, or a blind tripwire would pass
      // undecided flips while looking healthy.
      console.warn(
        "[adr] staged ADR diff probe failed (git error) — strict gate failed OPEN for this commit; " +
          "undecided accept flips are NOT being checked. Investigate the git setup.",
      )
      return []
    }
    let diff = staged
    if (includeWorkingTree) {
      const work = spawnSyncGitDiff(projectDir, dirs, false)
      if (work !== null) diff += work
    }
    // A flip both staged and modified further appears in both diffs — the
    // union must not double-report it.
    const seen = new Set<string>()
    return acceptFlipsFromDiff(diff).filter((f) => {
      const key = `${f.id}${f.relPath}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  } catch {
    return []
  }
}

function spawnSyncGitDiff(projectDir: string, dirs: string[], staged: boolean): string | null {
  // --src-prefix/--dst-prefix force a/ b/ labels regardless of user config
  // (diff.noprefix, mnemonicPrefix) — the +++ header parse depends on them.
  const r = spawnSync(
    "git",
    ["diff", ...(staged ? ["--cached"] : []), "--unified=0", "--src-prefix=a/", "--dst-prefix=b/", "--", ...dirs],
    {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 5000,
    },
  )
  if (r.error || r.status !== 0) return null
  return r.stdout || ""
}
