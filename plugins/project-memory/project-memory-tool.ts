/**
 * Tool: memory_note — let the agent itself note a durable lesson to
 * the project's memory. Sibling to `/memory note`:
 *
 *   /memory note                     — user command, default scope = public
 *   /memory note --private "<note>"  — user command, private scope
 *   memory_note (tool)               — agent judges and notes itself
 *
 * Two scopes, both PROJECT-LEVEL inside `<projectDir>/.ocp/memory/`,
 * file names self-describe visibility:
 *   public  → public.md   — committed to git, follows the checkout
 *                            (same tier as AGENTS.md; reviewed via the
 *                             normal PR flow)
 *   private → private.md  — gitignored (auto-gitignored on first capture
 *                            via `.ocp/.gitignore`)
 *
 * ASYMMETRIC DEFAULT (ADR-2.0.2#01): the TOOL defaults to `private`, the
 * COMMAND to `public`. The agent files notes speculatively and nobody
 * reviews its output; the user typing `/memory note "..."` is a deliberate,
 * visible act, so their explicit command keeps the team-facing default.
 * Cost of a wrong guess is what sets the tool's default:
 *   misfiled private → one note only you never see (≈ free)
 *   misfiled public  → repo pollution + a permanent per-session injection
 *                       charge for text nobody curated
 * so the cheap-to-be-wrong side wins. The old "when in doubt → public,
 * PR review will route it back" rationale was unsound: the agent's file
 * was not necessarily in the diff at all (root `.gitignore` can exclude
 * the whole `.ocp/` tree), so nothing ever reviewed it.
 *
 * The team/private question itself is unchanged: "Will another developer
 * on this project want this rule next week?" — YES → public, NO →
 * private. Only the tie-break moved. Public entries are committed repo
 * content, so they follow the repo's English-only content rule.
 *
 * Noise control lives in `description` (USE WHEN / DO NOT USE FOR / scope
 * rules / confidence semantics). The tool does NOT enforce a confidence
 * floor — soft guidance beats hard refusal.
 *
 * Tool gate: the `execute` handler runs `scopedForCall()` against the
 * `project-memory-note-tool` policy in plugin-scope.json. Utility sessions
 * (OpenCode's title generator) are denied — title tasks are too narrow to
 * discover reusable rules and a stray note pollutes public.md / private.md
 * with noise. Subagents are allowed (advisor subagent may legitimately
 * learn a project quirk worth remembering). Description text is the
 * steering wheel for non-denied contexts; the policy gate is the wall.
 *
 * `confidence` and `scope` are returned to the user (tool metadata) but
 * NOT written to the file — the dated-bullet format stays pristine so
 * `countEntries` and human review keep their simple `startsWith("- [")`
 * contract.
 */

import { scopedForCall, type V2Session } from "../shared/agent-scope"
import { appendLesson, type LessonScope } from "./project-memory-config"

export const TOOL_NAME = "memory_note"

type Confidence = "low" | "medium" | "high"

/** V2 tool payload for `ctx.tool.transform(editor.add(...))`.
 *  `input` is a JSON Schema (v2 ValueSchema); the platform validates
 *  arguments against it — execute still guards defensively because a
 *  non-conforming host would otherwise hand us `unknown`.
 *  `options.codemode: false` exposes it as a first-class model tool
 *  (v1 `tool({...})` default). v1's `{title, output, metadata}` result
 *  maps to v2 `{content, metadata}` — the title rides in metadata
 *  (OCP-V2-GAP: v2 Tool.Result has no `title` field; TUIs read
 *  metadata.title as the historical convention). */
export function memoryNoteTool(session: V2Session | undefined) {
  return {
    name: TOOL_NAME,
    options: { codemode: false as const },
    input: {
      type: "object",
      properties: {
        lesson: {
          type: "string",
          description:
            "The lesson text. One sentence. State the rule, not the story. " +
            "Dated-bullet prefix is added automatically.",
        },
        scope: {
          type: "string",
          enum: ["public", "private"],
          description:
            "'private' (DEFAULT — gitignored, only the current user sees it) or 'public' (committed to git, team-visible, PR-reviewed).",
        },
        confidence: {
          type: "string",
          enum: ["low", "medium", "high"],
          description:
            "Self-rated durability/reusability of this lesson (default: medium). Metadata only — not gated.",
        },
      },
      required: ["lesson"],
    },
    description:
      "Note a durable 'lesson learned' to this project's memory. Two scopes; scope defaults to 'private' — pass 'public' only for a rule the whole team needs.\n\n" +
      "SCOPE: 'Would another developer on this project want this rule next week?'\n" +
      "  public  → <projectDir>/.ocp/memory/public.md, committed to git, reviewed by the team via the normal PR flow. Team conventions and shared gotchas: 'this repo uses pnpm not npm', 'CI fails on Windows without <flag>'.\n" +
      "  private → <projectDir>/.ocp/memory/private.md, gitignored (auto-gitignored on first capture), only you see it. Environment quirks, personal preferences, local hacks. THIS IS THE DEFAULT.\n" +
      "  When in doubt → leave scope unset (private). A misfiled private note costs one unseen note; a misfiled public one pollutes the repo and is injected into every future session.\n\n" +
      "USE WHEN you discover a clear, reusable rule worth the next session's attention.\n" +
      "Public entries are committed repo content — write them in English, one rule per entry.\n\n" +
      "DO NOT USE FOR: session-specific facts, current task state, anything already in AGENTS.md, " +
      "one-off bug fixes, conclusions from your own research about external tools or services (those belong in a design doc or ADR), " +
      "or speculative guesses that haven't been validated against real code.\n\n" +
      "Confidence is metadata only — the tool does not gate on it. " +
      "Rating (default medium): high = rule you will act on next session; low = a hunch, prefer to surface to the user instead of silently filing.",
    execute: async (args: unknown, context: { agent?: string; sessionID?: string }) => {
      // Defensive boundary check (JSON Schema is enforced host-side; a
      // non-conforming host must not crash the write path silently).
      // Empty/whitespace lessons flow into the failed-result path below,
      // matching v1 behavior (appendLesson sanitizes and throws -> caught).
      const a = (args ?? {}) as { lesson?: unknown; scope?: unknown; confidence?: unknown }
      if (typeof a.lesson !== "string")
        throw new Error("memory_note: `lesson` must be a string")
      // Default = private (ADR-2.0.2#01). The previous `=== "private" ? … : "public"`
      // made public the fallback for every unset / misspelled / non-conforming
      // value, so the team-visible file was the path of least resistance.
      const scope: LessonScope = a.scope === "public" ? "public" : "private"
      const conf: Confidence =
        a.confidence === "low" || a.confidence === "high" ? a.confidence : "medium"

      // Tool-context gate: deny utility sessions (title generator can't
      // discover reusable rules; a stray note pollutes public.md /
      // private.md with noise). Subagents and primary sessions pass.
      // `session` is the plugin-level domain client captured at
      // registration (the v2 ToolContext carries no client) — used for
      // subagent detection via parentID when no agent name hits.
      const gate = await scopedForCall(
        { sessionID: context?.sessionID, agent: context?.agent },
        "project-memory-note-tool",
        session,
      )
      if (!gate) {
        return {
          content:
            `memory_note is not available in this agent context (${context?.agent ?? "unknown"}). ` +
            `Utility sessions (title generator) are denied because title tasks are too narrow to discover reusable rules. ` +
            `Run /memory note "<lesson>" from a normal agent session instead.`,
          metadata: {
            title: "Memory note denied",
            denied: true,
            scope,
            agent: context?.agent ?? null,
            sessionID: context?.sessionID ?? null,
            lesson: a.lesson,
          },
        }
      }

      try {
        const path = appendLesson(scope, String(a.lesson))
        return {
          content:
            `Saved to ${path}\n` +
            `Scope: ${scope} | Confidence: ${conf}\n` +
            `Injected into the system prompt on the next chat request (while projectMemory is on).`,
          metadata: {
            title: `Memory noted (${scope}, ${conf})`,
            path,
            scope,
            confidence: conf,
            confidenceRank: conf === "high" ? 3 : conf === "medium" ? 2 : 1,
            lesson: a.lesson,
          },
        }
      } catch (err) {
        return {
          content: `Failed to write ${scope} memory: ${String(err)}`,
          metadata: {
            title: "Memory note failed",
            error: String(err),
            scope,
            confidence: conf,
            lesson: a.lesson,
          },
        }
      }
    },
  }
}