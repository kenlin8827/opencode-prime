/**
 * Hook: command.execute.before — `/memory <subcommand>` user controls.
 *
 *   /memory note <lesson>             → public (committed to git, PR review)
 *   /memory note --private <lesson>   → private (project-scoped, gitignored,
 *                                      only the current user sees it)
 *   /memory on | off                  → flip the `projectMemory` switch
 *   /memory status                    → gate state + public/private entry counts
 *   /memory show                      → preview what's currently injected
 *   /memory                           → help
 *
 * Both scopes are PROJECT-LEVEL inside `<projectDir>/.opencode/memory/`,
 * file names self-describe visibility:
 *   public  → public.md   (committed)
 *   private → private.md  (gitignored)
 *
 * Why no global personal scope: this plugin is project-scoped, so personal
 * notes ride along with the project (gitignored, not in user home). The
 * top-tier references (Cursor Settings, Aider ~/.aider.conf.yml, Copilot
 * VS Code settings) keep personal settings in the user home because those
 * plugins are NOT project-scoped; the same pattern doesn't apply here.
 *
 * Note is an explicit user trigger — no auto-capture (noise graveyard →
 * LLM trust erosion, see docs/plan/project-memory.md). Replies use
 * session.prompt({ noReply, ignored }) — visible to the user, invisible to
 * the LLM: noting a lesson must not start a conversation.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { refreshLocale, tr } from "../tui/i18n"
import {
  appendLesson,
  countEntries,
  getState,
  privatePath,
  publicPath,
  readPrivate,
  readPublic,
  setState,
  type LessonScope,
  writableProjectConfigFile,
} from "./project-memory-config"

export const COMMAND_NAME = "memory"

export const SUBCOMMAND_NOTE = "note"
export const SUBCOMMAND_STATUS = "status"
export const SUBCOMMAND_SHOW = "show"
export const SUBCOMMAND_ON = "on"
export const SUBCOMMAND_OFF = "off"

/** HELP built at call time — locale from ocp config/env, paths per project. */
function helpText(): string {
  refreshLocale()
  return tr("guard.memory.help", { public: publicPath(), private: privatePath() })
}

/** Resolve `scope` from `/memory ...` raw arguments.
 *
 * Flag grammar (case-insensitive):
 *   --public  | --private  — visibility (default public)
 *
 * Only LEADING flags (before the lesson text) are parsed — a `--private`
 * inside the lesson is content, not a flag. The lesson body is kept
 * byte-untouched (quote stripping happens later, in `unquote`).
 *
 * `private` is the only personal scope (gitignored, in-project).
 *
 * Pure — exported for tests. */
export function parseCaptureArgs(args: unknown): { sub: string; rest: string; scope: LessonScope } {
  const trimmed = (typeof args === "string" ? args : "").trim()
  const subMatch = /^(\S+)([\s\S]*)$/.exec(trimmed)
  const sub = (subMatch?.[1] ?? "").toLowerCase()
  let rest = subMatch?.[2] ?? ""

  let visibility: LessonScope = "public"
  // Peel leading flags only; last one wins (matches the old scan loop).
  for (;;) {
    const flagMatch = /^(--public|--private)(?:\s([\s\S]*))?$/i.exec(rest.trimStart())
    if (!flagMatch) break
    visibility = flagMatch[1].toLowerCase() === "--private" ? "private" : "public"
    rest = flagMatch[2] ?? ""
  }

  return { sub, rest: rest.trim(), scope: visibility }
}

/** Strip one layer of matching surrounding quotes a user may have typed. */
function unquote(text: string): string {
  return text.replace(/^"([^"]*)"$/s, "$1").replace(/^'([^']*)'$/s, "$1")
}

/** Map a LessonScope to a short label key for i18n (en/zh). */
function scopeLabelKey(scope: LessonScope): "guard.memory.scopePublic" | "guard.memory.scopePrivate" {
  return scope === "public" ? "guard.memory.scopePublic" : "guard.memory.scopePrivate"
}

function scopePath(scope: LessonScope): string {
  return scope === "public" ? publicPath() : privatePath()
}

export function statusText(): string {
  refreshLocale()
  const gate = getState()
  const pub = readPublic()
  const priv = readPrivate()
  const injected = gate === "on" && (pub !== null || priv !== null)
  const publicLabel =
    pub === null ? tr("guard.memory.missing") : tr("guard.memory.entries", { count: countEntries(pub) })
  const privateLabel =
    priv === null ? tr("guard.memory.missing") : tr("guard.memory.entries", { count: countEntries(priv) })
  let text = tr("guard.memory.status", {
    gate,
    public: publicLabel,
    private: privateLabel,
    flag: injected ? "ACTIVE" : "INACTIVE",
  })
  // gate on but nothing captured yet — the silent no-op users file as
  // "switched on but nothing happens". Name the next action.
  if (gate === "on" && pub === null && priv === null) {
    refreshLocale()
    text += `\n${tr("guard.memory.noCurated", { public: publicPath(), private: privatePath() })}`
  }
  return text
}

/** Format `mtime` as ISO date in local time (YYYY-MM-DD HH:MM). Returns
 * "?" when the file is gone. Pure — exported for tests. */
export function formatMtime(mtime: Date | null): string {
  if (!mtime) return "?"
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}-${pad(mtime.getDate())} ${pad(mtime.getHours())}:${pad(mtime.getMinutes())}`
}

/** Read the file's mtime (mtime in ms, or null if missing). Pure wrapper
 * around node:fs.statSync for testability — exported for tests. */
export function fileMtimeMs(path: string): number | null {
  try {
    // Lazy import to keep the parser deps file-scoped.
    return require("node:fs").statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** Stale flag: > 30 days since last edit. The exact threshold is a UX
 * choice — long enough that "stale" means "review this", short enough
 * that it actually fires for projects with seasonal activity. */
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000

/** Preview the currently-active memory: file path, last-edited, entries.
 * Both scopes render in the same order the system-inject uses (public
 * first, then private), so the preview matches what the LLM sees. When
 * both are empty / missing, return a single "nothing captured yet" line
 * that points at the next-action command. Pure of side effects — reads
 * files only — exported for tests. */
export function showText(): string {
  refreshLocale()
  const pubContent = readPublic()
  const privContent = readPrivate()
  if (pubContent === null && privContent === null) {
    return tr("guard.memory.showEmpty", {
      public: publicPath(),
      private: privatePath(),
    })
  }

  const lines: string[] = [tr("guard.memory.showHeader")]
  const now = Date.now()

  if (pubContent !== null) {
    const mtime = formatMtime(new Date(fileMtimeMs(publicPath()) ?? 0))
    const stale = (fileMtimeMs(publicPath()) ?? 0) > 0 && now - (fileMtimeMs(publicPath()) ?? 0) > STALE_THRESHOLD_MS
    lines.push(
      tr("guard.memory.showScope", {
        label: "Public",
        mtime,
        count: countEntries(pubContent),
        stale: stale ? tr("guard.memory.showStale") : "",
      }),
    )
    lines.push(pubContent.trimEnd())
  }
  if (privContent !== null) {
    const mtime = formatMtime(new Date(fileMtimeMs(privatePath()) ?? 0))
    const stale = (fileMtimeMs(privatePath()) ?? 0) > 0 && now - (fileMtimeMs(privatePath()) ?? 0) > STALE_THRESHOLD_MS
    lines.push(
      tr("guard.memory.showScope", {
        label: "Private",
        mtime,
        count: countEntries(privContent),
        stale: stale ? tr("guard.memory.showStale") : "",
      }),
    )
    lines.push(privContent.trimEnd())
  }
  lines.push(
    tr("guard.memory.showPaths", {
      public: publicPath(),
      private: privatePath(),
    }),
  )
  return lines.join("\n\n")
}

async function reply(client: PluginInput["client"], sessionID: string | undefined, text: string): Promise<void> {
  if (!sessionID) return
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text, ignored: true }],
      noReply: true,
    },
  })
}

export function makeCommandHook(client: PluginInput["client"], handled: () => never) {
  return async (input: { command?: string; arguments?: string; sessionID?: string }) => {
    if (input.command !== COMMAND_NAME) return

    const { sub, rest, scope } = parseCaptureArgs(input.arguments)

    let text: string
    if (sub === SUBCOMMAND_NOTE) {
      const lesson = unquote(rest)
      if (lesson === "") {
        refreshLocale()
        text = `${tr("guard.memory.nothing")}\n\n${helpText()}`
      } else {
        try {
          const path = appendLesson(scope, lesson)
          refreshLocale()
          text = tr("guard.memory.noted", {
            scope: tr(scopeLabelKey(scope)),
            path,
            memory: scopePath(scope),
          })
        } catch (err) {
          text = `[project-memory] note failed: ${String(err)}`
        }
      }
    } else if (sub === SUBCOMMAND_STATUS) {
      text = statusText()
    } else if (sub === SUBCOMMAND_SHOW) {
      text = showText()
    } else if (sub === SUBCOMMAND_ON || sub === SUBCOMMAND_OFF) {
      refreshLocale()
      text = setState(sub)
        ? tr("guard.memory.set", {
            state: sub,
            STATE: sub.toUpperCase(),
            zhState: sub === "on" ? "启用" : "关闭",
            path: writableProjectConfigFile(),
          })
        : tr("guard.memory.setFail", { field: "projectMemory" })
    } else {
      refreshLocale()
      text = sub ? `${tr("guard.memory.unknown", { sub })}\n\n${helpText()}` : helpText()
    }

    await reply(client, input.sessionID, text)
    return handled()
  }
}