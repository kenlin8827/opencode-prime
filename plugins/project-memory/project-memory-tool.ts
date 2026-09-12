/**
 * Tool: memory_note — let the agent itself note a durable lesson to
 * the project's memory. Sibling to `/memory note`:
 *
 *   /memory note                     — user command, default scope = public
 *   /memory note --private "<note>"  — user command, private scope
 *   memory_note (tool)               — agent judges and notes itself
 *
 * Two scopes, both PROJECT-LEVEL inside `<projectDir>/.opencode/memory/`,
 * file names self-describe visibility:
 *   public  → public.md   — committed to git, follows the checkout
 *                            (same tier as AGENTS.md; reviewed via the
 *                             normal PR flow)
 *   private → private.md  — gitignored (auto-gitignored on first capture
 *                            via `.opencode/.gitignore`)
 *
 * SCOPE HEURISTIC (the only thing the agent really has to decide):
 *   "Will another developer at this same machine, on this project,
 *    tomorrow find this rule useful?"
 *     YES → public
 *     NO  → private (your environment, your preferences, your hacks —
 *                     only you see it)
 *   When in doubt → public. PR review will route misclassified entries back.
 *
 * Noise control lives in `description` (USE WHEN / DO NOT USE FOR / scope
 * rules / confidence semantics). The tool does NOT enforce a confidence
 * floor — soft guidance beats hard refusal.
 *
 * Tool gate: the `execute` handler runs `scopedForTool()` against the
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

import { tool } from "@opencode-ai/plugin"
import { scopedForTool, type SessionClient } from "../shared/plugin-scope"
import { appendLesson, type LessonScope } from "./project-memory-config"

export const TOOL_NAME = "memory_note"

type Confidence = "low" | "medium" | "high"

export function makeCaptureTool(client: SessionClient) {
  return tool({
    description:
      "Note a durable 'lesson learned' to this project's memory. Two scopes — pick the one that fits:\n\n" +
      "SCOPE HEURISTIC: 'Will another developer at this same machine, on this project, tomorrow find this useful?'\n" +
      "  YES → scope='public' (default). <projectDir>/.opencode/memory/public.md, committed to git, reviewed by your team via the normal PR flow. " +
      "Examples: 'this repo uses pnpm not npm', 'do not import from packages/legacy/', 'test runner needs --preload for opentui', 'CI fails on Windows without <flag>'.\n" +
      "  NO  → scope='private'. <projectDir>/.opencode/memory/private.md, gitignored (auto-gitignored on first capture via .opencode/.gitignore) — only you see it. " +
      "Examples: 'user prefers no semicolons', 'VPN slow, set API timeout to 60s', 'my private TODO list for this codebase'.\n" +
      "  When in doubt → leave scope unset (defaults to public); PR review will route misclassified entries back.\n\n" +
      "USE WHEN you discover a clear, reusable rule worth the next session's attention.\n\n" +
      "DO NOT USE FOR: session-specific facts, current task state, anything already in AGENTS.md, " +
      "one-off bug fixes, or speculative guesses that haven't been validated against real code.\n\n" +
      "Confidence is metadata only — the tool does not gate on it. " +
      "Rating (default medium): high = rule you will act on next session; low = a hunch, prefer to surface to the user instead of silently filing.",
    args: {
      lesson: tool.schema
        .string()
        .describe(
          "The lesson text. One sentence. State the rule, not the story. " +
            "Dated-bullet prefix is added automatically.",
        ),
      scope: tool.schema
        .enum(["public", "private"])
        .optional()
        .describe("'public' (default, committed to git) or 'private' (gitignored, only the current user sees it)."),
      confidence: tool.schema
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Self-rated durability/reusability of this lesson (default: medium). Metadata only — not gated."),
    },
    execute: async (args, ctx) => {
      // Tool-context gate: deny utility sessions (title generator can't
      // discover reusable rules; a stray note pollutes public.md /
      // private.md with noise). Subagents and primary sessions pass.
      // `client` is the plugin-level client captured at registration
      // (OpenCode's ToolContext doesn't carry it) — used for subagent
      // detection via parentID when no agent name hits.
      const gate = await scopedForTool(
        { sessionID: ctx?.sessionID, agent: ctx?.agent },
        "project-memory-note-tool",
        client,
      )
      if (!gate) {
        return {
          title: "Memory note denied",
          output:
            `memory_note is not available in this agent context (${ctx?.agent ?? "unknown"}). ` +
            `Utility sessions (title generator) are denied because title tasks are too narrow to discover reusable rules. ` +
            `Run /memory note "<lesson>" from a normal agent session instead.`,
          metadata: {
            denied: true,
            scope: args.scope ?? "public",
            agent: ctx?.agent ?? null,
            sessionID: ctx?.sessionID ?? null,
            lesson: args.lesson,
          },
        }
      }

      const scope: LessonScope = (args.scope ?? "public") as LessonScope
      const conf: Confidence = (args.confidence ?? "medium") as Confidence
      try {
        const path = appendLesson(scope, args.lesson)
        return {
          title: `Memory noted (${scope}, ${conf})`,
          output:
            `Saved to ${path}\n` +
            `Scope: ${scope} | Confidence: ${conf}\n` +
            `Injected into the system prompt on the next chat request (while projectMemory is on).`,
          metadata: {
            path,
            scope,
            confidence: conf,
            confidenceRank: conf === "high" ? 3 : conf === "medium" ? 2 : 1,
            lesson: args.lesson,
          },
        }
      } catch (err) {
        return {
          title: `Memory note failed`,
          output: `Failed to write ${scope} memory: ${String(err)}`,
          metadata: {
            error: String(err),
            scope,
            confidence: conf,
            lesson: args.lesson,
          },
        }
      }
    },
  })
}