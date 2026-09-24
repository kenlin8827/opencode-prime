/**
 * Hook: event — suggest `/project init` when a new top-level session opens
 * in a project that has never been initialized.
 *
 * Trigger: any baseline scaffold target missing (.ocp/ocp.json,
 * docs/git-commits.md, AGENTS.md). Backend indexes do NOT trigger the
 * suggestion — a project can legitimately opt out of them; they only refine
 * the message (e.g. "codegraph CLI installed but not indexed").
 *
 * Announce strategy (v2):
 *   - session.created → top-level sessions only (subagent sessions carry
 *     parentID); fires ONCE per plugin instance (in-memory flag) so opening
 *     several sessions in one server run never nags repeatedly.
 *   - v1's tui.showToast has no v2 plugin surface (OCP-V2-GAP — see
 *     shared/notify.ts): the suggestion degrades to a server-log line and
 *     is never fatal.
 *   - V2 event shape: `session.created` is a durable event whose payload
 *     carries `sessionID` + optional `parentID` at `data` (v1 nested them
 *     under `properties.info` — both shapes are read for tolerance).
 */

import { notify } from "../shared/notify"
import { refreshLocale, tr } from "../tui/i18n"
import { getProjectDir, resolveTarget, SCAFFOLD_TARGETS } from "./project-manager-config"
import { probeBackends, type BackendProbe } from "./project-manager-index"
import { existsSync } from "node:fs"

/** Minimal shape we rely on; the EventManifest union is broader. */
type SessionCreatedEvent = {
  type?: string
  data?: { sessionID?: string; parentID?: string | null }
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

/** V2 event handler for the ctx.event.subscribe loop. Returns quietly for
 *  every event type it does not consume. */
export function makeAnnounceHandler() {
  // Once per plugin instance: the suggestion is about the project, and
  // nagging on every new session of one server run would be noise.
  let announced = false

  return async (event: unknown): Promise<void> => {
    try {
      if (announced) return
      const ev = event as {
        type?: string
        data?: { parentID?: string | null; sessionID?: string }
        properties?: { info?: { parentID?: string | null; id?: string } }
      }
      if (ev?.type !== "session.created") return
      // Subagent sessions (task-dispatched) carry parentID — only suggest on
      // the top-level session the user actually opened.
      if (ev.data?.parentID ?? ev.properties?.info?.parentID) return

      const { missing, probe } = detectUninitialized()
      if (missing.length === 0) return

      announced = true
      await notify(suggestInitMessage(missing, probe), "info")
    } catch {
      // Never crash a session start — a missed suggestion is harmless.
    }
  }
}
