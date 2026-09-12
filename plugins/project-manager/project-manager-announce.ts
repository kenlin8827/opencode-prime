/**
 * Hook: event — suggest `/project init` when a new top-level session opens
 * in a project that has never been initialized.
 *
 * Trigger: any baseline scaffold target missing (.ocp/ocp.json,
 * docs/git-commits.md, AGENTS.md). Backend indexes do NOT trigger the
 * suggestion — a project can legitimately opt out of them; they only refine
 * the message (e.g. "codegraph CLI installed but not indexed").
 *
 * Toast-only strategy (same as adr-guard-announce):
 *   - session.created → top-level sessions only (subagent sessions carry
 *     parentID); fires ONCE per plugin instance (in-memory flag) so opening
 *     several sessions in one server run never nags repeatedly.
 *   - tui.showToast — non-intrusive, no chat-transcript pollution; degrades
 *     to silence in headless/older-server environments. Never fatal.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { refreshLocale, tr } from "../tui/i18n"
import { getProjectDir, resolveTarget, SCAFFOLD_TARGETS } from "./project-manager-config"
import { probeBackends, type BackendProbe } from "./project-manager-index"
import { existsSync } from "node:fs"

type Client = PluginInput["client"]

/** Minimal shape we rely on; the SDK's Event union is broader. */
type SessionCreatedEvent = {
  type: string
  properties?: { info?: { parentID?: string; id?: string } }
}

/** Pure message builder — exported for unit tests. */
export function suggestInitMessage(missing: string[], probe: BackendProbe): string {
  refreshLocale()
  const hint: string[] = []
  if (probe.codegraphEnabled && probe.codegraphCli && !probe.codegraphIndexed) {
    hint.push(tr("guard.pm.hintCodegraph"))
  }
  if (probe.gitnexusEnabled && probe.gitnexusCli && probe.gitnexusIndex === "missing") {
    hint.push(tr("guard.pm.hintGitnexus"))
  }
  const files = tr("guard.pm.suggestMissing", { files: missing.join(", ") })
  const extras = hint.length > 0 ? tr("guard.pm.hintTail", { hints: hint.join("; ") }) : ""
  return tr("guard.pm.suggestInit", { files, extras })
}

/** Probe result consumed by the hook — exported for tests. */
export function detectUninitialized(): { missing: string[]; probe: BackendProbe } {
  const missing = (SCAFFOLD_TARGETS as readonly string[]).filter(
    (rel) => !existsSync(resolveTarget(rel as (typeof SCAFFOLD_TARGETS)[number])),
  )
  return { missing, probe: probeBackends(getProjectDir()) }
}

async function suggest(client: Client, message: string, _sessionID?: string): Promise<void> {
  try {
    await client.tui.showToast({ body: { message, variant: "info" } })
  } catch { /* headless / older server — degrade to silence, never fatal */ }
}

export function makeAnnounceHook(client: Client) {
  // Once per plugin instance: the suggestion is about the project, and
  // nagging on every new session of one server run would be noise.
  let announced = false

  return async (input: { event: SessionCreatedEvent }) => {
    try {
      if (announced) return
      const event = input.event
      if (event?.type !== "session.created") return
      // Subagent sessions (task-dispatched) carry parentID — only suggest on
      // the top-level session the user actually opened.
      if (event.properties?.info?.parentID) return

      const { missing, probe } = detectUninitialized()
      if (missing.length === 0) return

      announced = true
      await suggest(client, suggestInitMessage(missing, probe), event.properties?.info?.id)
    } catch {
      // Never crash a session start — a missed suggestion is harmless.
    }
  }
}
