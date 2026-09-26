/** Native command/tool/Question integration. Question replies are server
 * facts (the native question tool's completed result), never model-provided
 * authorization flags.
 *
 * V2 MAPPING NOTES (v1 → v2):
 *   • v1 `tool: { adr_context, adr_compaction }` (SDK `tool({...})` with
 *     zod args) → v2 payloads registered through ctx.tool.transform with
 *     `options: { codemode: false }` (first-class model tools). Zod 4
 *     schemas are StandardSchemaV1 — accepted directly as v2 `input`.
 *     Result shape: v1 returned bare strings; v2 returns
 *     `Tool.Result { content }` — the JSON payload rides `content`.
 *   • v1 question authorization rode server events
 *     `question.asked` / `question.replied` / `question.rejected`. The v2
 *     plugin Context carries no question event surface; the equivalent
 *     server-fact proof is the question tool's own execute.after event:
 *     a completed result's `answers` (output/metadata) are produced by
 *     the server-side form flow exactly like the v1 reply event, and an
 *     `error` status is the dismissal the v1 rejected event carried.
 *     Same security property: only the native tool round-trip — never a
 *     model argument — can authorize execution.
 *   • v1 `client.session.prompt({noReply})` reply injection → v2
 *     session.synthetic (shared/agent-scope.injectReply).
 *   • v1 toast on apply → shared/notify log line (OCP-V2-GAP: no TUI
 *     surface in the v2 plugin Context).
 */
import { readdirSync } from "node:fs"
import { injectReply, scopedForCall, type V2Session } from "../shared/agent-scope"
import { notify } from "../shared/notify"
import { refreshLocale, tr } from "../tui/i18n"
import { analyzeCompaction, checkCompaction, approveDrafting, applyPlan, candidateBatchPage, stageCandidate, compactionEvidence, loadPlan, planArchive, reviewPage, sealPlan, startCompaction, submitCandidate, type CompactionOptions, type Plan } from "./adr-compaction"
import { currentState, queryAdrContext, takeSnapshot } from "./adr-context"
import { maintenancePath, projectPath, readOptional } from "./adr-storage"

// V2 Tool.Info.input is plain JSON Schema. Mirrors the runtime validators in
// adr-compaction.ts (parseCandidateBatch) — keep both in sync.
const candidateBatchInputSchema = {
  type: "object",
  properties: {
    summary: { type: "array", items: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 12000 }, sources: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["text", "sources"], additionalProperties: false } },
    replacements: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string", minLength: 1, maxLength: 200 }, content: { type: "string", minLength: 1, maxLength: 200000 } }, required: ["id", "title", "content"], additionalProperties: false } },
    coverage: { type: "array", items: { type: "object", properties: { source: { type: "string" }, disposition: { type: "string", enum: ["retain", "replace", "historical", "unresolved"] }, targets: { type: "array", items: { type: "string" } }, note: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["source", "disposition", "note"], additionalProperties: false } },
  },
  additionalProperties: false,
} as const

export const COMPACTION_HELP = `/adr compaction [--dry-run] [--domain <slug> | --sources <id,id>]
/adr compaction --mode summary|consolidate [--archive] [--style ocp|madr|nygard] [--baseline N.N --iteration N]
/adr compaction status [<plan-id>]
/adr check --compaction
/adr compaction --confirm <plan-id>  (manual approval/recovery fallback)
/adr compaction archive [--sources <id,id>]
/adr compaction archive restore <completed-plan-id>
Default: local read-only analysis. Explicit modes draft; native Ask approves exact reviewed decisions/actions. Archive is opt-in. Sources changing invalidate approval.`

/** Strict, quote-aware flag parser; no silent unknown/duplicate options. */
export function parseCompactionArgs(raw: string): { options: CompactionOptions; action: "analyze" | "draft" | "confirm" | "status" | "archive" | "restore" | "help"; id?: string } {
  const tokens = raw.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(s => s.replace(/^(['"])(.*)\1$/, "$2")) ?? []
  let action: "analyze" | "draft" | "confirm" | "status" | "archive" | "restore" | "help" = "analyze"
  let id: string | undefined
  if (tokens[0] === "status") { action = "status"; tokens.shift(); if (tokens[0] && !tokens[0].startsWith("--")) id = tokens.shift() }
  if (tokens[0] === "archive") { action = "archive"; tokens.shift(); if (tokens.at(0) === "restore") { action = "restore"; tokens.shift(); id = tokens.shift(); if (!id) throw new Error("restore requires a completed plan ID") } }
  const opts: Record<string, string | boolean> = {}
  const values = new Set(["mode", "domain", "sources", "style", "baseline", "iteration", "confirm"])
  for (let i = 0; i < tokens.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(tokens[i])
    if (!match) throw new Error(`Unexpected compaction argument: ${tokens[i]}`)
    const key = match[1]
    if (key in opts) throw new Error(`Duplicate flag: --${key}`)
    if (values.has(key)) {
      const value = match[2] ?? tokens[++i]
      if (!value || value.startsWith("--")) throw new Error(`Missing value: --${key}`)
      opts[key] = value
    } else if (["archive", "dry-run", "help"].includes(key) && match[2] === undefined) opts[key] = true
    else throw new Error(`Unknown compaction flag: --${key}`)
  }
  if (opts.help) { if (Object.keys(opts).length > 1 || action !== "analyze") throw new Error("--help must stand alone"); return { options: {}, action: "help" } }
  if (opts.confirm) {
    if (Object.keys(opts).length !== 1 || action !== "analyze") throw new Error("--confirm cannot change the reviewed plan")
    return { options: {}, action: "confirm", id: String(opts.confirm) }
  }
  if (opts.domain && opts.sources) throw new Error("--domain and --sources are mutually exclusive")
  if (opts.mode && !["summary", "consolidate"].includes(String(opts.mode))) throw new Error("Invalid compaction mode")
  if (opts.style && !["ocp", "madr", "nygard"].includes(String(opts.style))) throw new Error("Invalid ADR style")
  if (opts.mode !== "consolidate" && ["archive", "style", "baseline", "iteration"].some(k => opts[k])) throw new Error("Archive/style/numbering flags require --mode consolidate")
  if (action !== "analyze" && Object.keys(opts).some(k => action !== "archive" || k !== "sources")) throw new Error(`Flags not supported for ${action}`)
  const sources = opts.sources ? String(opts.sources).split(",").map(s => s.trim()) : undefined
  if (sources?.some(s => !s)) throw new Error("Empty source ID")
  const options: CompactionOptions = { mode: opts.mode as CompactionOptions["mode"], domain: opts.domain as string | undefined, sources, archive: opts.archive === true, style: opts.style as CompactionOptions["style"], baseline: opts.baseline as string | undefined, iteration: opts.iteration as string | undefined, dryRun: opts["dry-run"] === true }
  if (action === "analyze" && options.mode && !options.dryRun) action = "draft"
  return { options, action, id }
}

type Question = { header: string; question: string; multiple: boolean; options: Array<{ label: string; description: string }> }
/** Native Question strips unsupported fields and reorders keys. Compare only
 * the validated user-visible contract, never JSON property insertion order. */
function questionSignature(value: unknown): string {
  if (!Array.isArray(value)) return "invalid"
  try {
    return JSON.stringify(value.map(q => {
      if (!q || typeof q.question !== "string" || typeof q.header !== "string" || !Array.isArray(q.options)) throw new Error("Invalid question")
      return { question: q.question, header: q.header, multiple: q.multiple === true, options: q.options.map((o: { label?: unknown; description?: unknown }) => {
        if (typeof o.label !== "string" || typeof o.description !== "string") throw new Error("Invalid option")
        return { label: o.label, description: o.description }
      }) }
    }))
  } catch { return "invalid" }
}
interface Pending { budget?: boolean; id: string; seal: string; question: Question; labels: Map<string, "accept" | "drafts" | "cancel" | "modify">; expires: number; callID?: string; authorized?: boolean }

/** V2 ToolContext subset the execute handlers read. */
interface ExecuteCtx { sessionID?: string; agent?: string }
/** V2 Tool.Result — the shape execute handlers return. */
type ToolResult = { content?: string | ReadonlyArray<unknown>; output?: unknown; metadata?: Record<string, unknown> }

/** V2 minimal structural session view (synthetic + get for the scope gate). */
export function createCompactionRuntime(project: string, session: V2Session) {
  const pending = new Map<string, Pending>()
  const results = new Map<string, string>()
  const seenEvidence = new Map<string, Set<string>>()
  const allowed = async (ctx: ExecuteCtx, scope = "adr") => {
    if (!(await scopedForCall({ sessionID: ctx.sessionID, agent: ctx.agent }, scope, session)))
      throw new Error("ADR tools unavailable in this agent scope")
  }
  const registerBudget = (p: Plan): { questions: Question[]; instructions: string } => {
    refreshLocale()
    const s = takeSnapshot(project)
    const chars = s.records.filter(r => p.evidencePaths.includes(r.sourcePath)).reduce((n, r) => n + Array.from(r.rawContent).length, 0)
    const labels = new Map<string, "accept" | "cancel">([[tr("adr.compaction.costContinue"), "accept"], [tr("adr.compaction.cancel"), "cancel"]])
    const question: Question = { header: "ADR drafting cost", multiple: false,
      question: tr("adr.compaction.cost", { records: String(p.evidencePaths.length), chars: String(chars), tokens: String(Math.ceil(chars / 4)) }) + `\nPlan: ${p.id}; fingerprint: ${p.fingerprint}`,
      options: [...labels].map(([label, action]) => ({ label, description: tr(action === "accept" ? "adr.compaction.costContinueDesc" : "adr.compaction.cancelDesc") })),
    }
    pending.set(p.sessionID, { budget: true, id: p.id, seal: p.fingerprint, question, labels, expires: Date.now() + 30 * 60_000 })
    return { questions: [question], instructions: "Call native question with these exact arguments BEFORE retrieving evidence. Cost approval permits drafting only; a separate reviewed Ask is required for acceptance/publication." }
  }
  const registerReview = (p: Plan): { questions: Question[]; instructions: string } => {
    if (p.state !== "review" || !p.seal || sealPlan(p) !== p.seal) throw new Error("No validated candidate to review")
    refreshLocale()
    const labels = new Map<string, "accept" | "drafts" | "cancel" | "modify">()
    if (!p.blockers?.length) labels.set(tr(p.kind === "summary" ? "adr.compaction.publish" : "adr.compaction.accept"), "accept")
    if (p.kind === "consolidate") labels.set(tr("adr.compaction.drafts"), "drafts")
    labels.set(tr("adr.compaction.modify"), "modify")
    labels.set(tr("adr.compaction.cancel"), "cancel")
    const creates = (p.changes ?? []).filter(c => c.before === null).map(c => c.path)
    const retires = (p.changes ?? []).filter(c => c.before !== null).map(c => c.path)
    const compact = (values: string[]) => values.slice(0, 6).join(", ") + (values.length > 6 ? ` … (+${values.length - 6})` : "")
    const preview = tr("adr.compaction.scopeCard", { sources: compact(p.selected), successors: compact(p.candidate?.replacements.map(r => r.id) ?? []), moves: compact(p.archiveChanges?.filter(c => c.after === null).map(c => c.path) ?? []), unresolved: String(p.candidate?.coverage.filter(c => c.disposition === "unresolved").length ?? 0) })
    const question: Question = {
      header: "ADR review", multiple: false,
      question: tr("adr.compaction.review", { id: p.id, revision: String(p.revision), mode: p.kind, creates: String(creates.length), retires: String(retires.length), moves: String(p.archiveChanges?.filter(c => c.after === null).length ?? 0), path: `${maintenancePath(project)}/${p.id}.review.md` }) + `\nSeal: ${p.seal}\n${preview}\n${p.blockers?.length ? "Execution blocked: " + p.blockers.join("; ") : ""}\n` + tr("adr.compaction.effects"),
      options: [...labels].map(([label, action]) => ({ label, description: tr(action === "accept" ? "adr.compaction.acceptDesc" : action === "drafts" ? "adr.compaction.draftDesc" : action === "modify" ? "adr.compaction.modifyDesc" : "adr.compaction.cancelDesc") })),
    }
    pending.set(p.sessionID, { id: p.id, seal: p.seal, question, labels, expires: Date.now() + 30 * 60_000 })
    return { questions: [question], instructions: "Show the review artifacts to the user. Call the native question tool with these exact questions. Only its completed result (server-produced answers) can authorize execution. Do not edit the question or claim approval yourself." }
  }
  const progress = (p: Plan) => Object.fromEntries(["drafts", "lifecycle", "views", "archive", "relocated-views"].map(stage => {
    const raw = readOptional(project, `${maintenancePath(project)}/${p.id}.${stage}.json`)
    try { return [stage, raw === null ? "not-started" : JSON.parse(raw).complete === true ? "complete" : "pending"] } catch { return [stage, "invalid"] }
  }))
  const reply = async (sessionID: string | undefined, text: string) => {
    await injectReply(session, sessionID, text)
  }
  // V2 tool payloads registered through ctx.tool.transform (codemode:false →
  // first-class model tools). execute returns Tool.Result ({ content }); v1
  // returned bare strings — the JSON payload now rides `content`.
  const toolPayloads = [
    {
      name: "adr_context",
      options: { codemode: false as const },
      description: "Bounded architecture decision evidence. Select an ID/domain/iteration; current follows accepted successors, history expands archive bodies at most one hop. Read next pages only when evidence is incomplete. Checks CURRENT freshness.",
      input: { type: "object", properties: { id: { type: "string" }, domain: { type: "string" }, iteration: { type: "string" }, intent: { type: "string", enum: ["current", "rationale", "history"] }, cursor: { type: "string" } }, additionalProperties: false } as const,
      execute: async (args: { id?: string; domain?: string; iteration?: string; intent?: "current" | "rationale" | "history"; cursor?: string }, ctx: ExecuteCtx): Promise<ToolResult> => {
        await allowed(ctx, "adr-context-tool")
        const page = queryAdrContext(project, args)
        const seen = seenEvidence.get(ctx.sessionID ?? "") ?? new Set<string>()
        const keys = page.entries.map(e => `${e.hash}:${e.offset}:${e.end}`)
        if (keys.length && keys.every(k => seen.has(k))) page.issues.push("Repeated evidence: stop unless a concrete unresolved question requires rereading.")
        keys.forEach(k => seen.add(k)); seenEvidence.set(ctx.sessionID ?? "", seen)
        return { content: JSON.stringify(page) }
      },
    },
    {
      name: "adr_compaction",
      options: { codemode: false as const },
      description: "Draft/review a USER-started ADR compaction plan. evidence returns bounded full-source batches; slots returns reserved scaffolds; stage saves a bounded named candidate batch, batches pages saved drafts; submit without candidate assembles batches and validates a candidate and offers native Ask; review pages the complete changes. No model argument can accept a decision or bypass user review. Load adr-compaction skill.",
      input: { type: "object", properties: { plan: { type: "string" }, action: { type: "string", enum: ["evidence", "slots", "stage", "batches", "submit", "review", "ask", "status"] }, cursor: { type: "string" }, candidate: candidateBatchInputSchema, batch: { type: "string" } }, required: ["plan", "action"], additionalProperties: false } as const,
      execute: async (args: { plan: string; action: "evidence" | "slots" | "stage" | "batches" | "submit" | "review" | "ask" | "status"; cursor?: string; candidate?: unknown; batch?: string }, ctx: ExecuteCtx): Promise<ToolResult> => {
        await allowed(ctx)
        const sessionID = ctx.sessionID ?? ""
        const p = loadPlan(project, args.plan, sessionID)
        if (["evidence", "stage"].includes(args.action) && !p.costApproval) throw new Error("Drafting cost is not authorized. Use action ask and obtain the native user reply first.")
        if (args.action === "evidence") return { content: JSON.stringify(compactionEvidence(project, p.id, sessionID, args.cursor)) }
        if (args.action === "stage") {
          if (!args.batch || !args.candidate) throw new Error("stage requires a batch key and candidate data")
          const staged = stageCandidate(project, p.id, sessionID, args.batch, args.candidate as never)
          if (staged.revision !== p.revision) pending.delete(sessionID)
          return { content: JSON.stringify({ id: staged.id, state: staged.state, revision: staged.revision, batches: Object.keys(staged.batches ?? {}).length, instructions: "Batch saved locally, not accepted. Use batches for paged inspection; submit without candidate assembles all batches and validates complete coverage." }) }
        }
        if (args.action === "batches") return { content: JSON.stringify(candidateBatchPage(project, p.id, sessionID, args.cursor)) }
        if (args.action === "slots") {
          const { evidencePage } = await import("./adr-context")
          return { content: JSON.stringify(evidencePage(p.slots.map(slot => ({ id: slot.id, path: p.root, status: "reserved", via: "candidate scaffold", hash: p.fingerprint, body: slot.scaffold })), p.fingerprint, `${p.id}:slots`, args.cursor)) }
        }
        if (args.action === "review") return { content: JSON.stringify(reviewPage(project, p.id, sessionID, args.cursor)) }
        if (args.action === "submit") {
          const submitted = submitCandidate(project, p.id, sessionID, args.candidate as never)
          return { content: JSON.stringify(registerReview(submitted)) }
        }
        if (args.action === "ask") return { content: JSON.stringify(p.state === "drafting" && !p.costApproval ? registerBudget(p) : registerReview(p)) }
        return { content: JSON.stringify({ id: p.id, state: p.state, revision: p.revision, result: p.result, stages: progress(p), selected: p.selected.length, evidenceRecords: p.evidencePaths.length, review: p.seal ? `${maintenancePath(project)}/${p.id}.review.md` : null }) }
      },
    },
  ]

  // Keyed view of the registered payloads (adr_context / adr_compaction) —
  // production uses toolPayloads via ctx.tool.transform; unit tests reach a
  // tool's execute() by name through this map.
  const tools = Object.fromEntries(toolPayloads.map((t) => [t.name, t]))

  return {
    toolPayloads,
    tools,
    async command(input: { command?: string; arguments?: string; sessionID?: string }, output: { parts: Array<unknown> }): Promise<"handled" | "continue" | null> {
      if (input.command !== "adr") return null
      const raw = input.arguments?.trim() ?? ""
      if (raw === "check --compaction") {
        try { await reply(input.sessionID, checkCompaction(project)) } catch (err) { await reply(input.sessionID, `ADR compaction check failed: ${String(err)}`) }
        return "handled"
      }
      if (/^context(?:\s|$)/.test(raw)) {
        try {
          const tokens = raw.split(/\s+/).slice(1), q: Parameters<typeof queryAdrContext>[1] = {}
          for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i]
            if (t === "--history") q.intent = "history"
            else if (["--domain", "--iteration", "--cursor"].includes(t)) { const v = tokens[++i]; if (!v || v.startsWith("--")) throw new Error(`Missing ${t}`); q[t.slice(2) as "domain" | "iteration" | "cursor"] = v }
            else if (!t.startsWith("--") && !q.id) q.id = t
            else throw new Error(`Unknown context argument: ${t}`)
          }
          await reply(input.sessionID, JSON.stringify(queryAdrContext(project, q), null, 2))
        } catch (err) { await reply(input.sessionID, String(err)) }
        return "handled"
      }
      if (!/^compaction(?:\s|$)/.test(raw)) return null
      try {
        const parsed = parseCompactionArgs(raw.replace(/^compaction\s*/, ""))
        if (parsed.action === "help") { await reply(input.sessionID, COMPACTION_HELP); return "handled" }
        if (parsed.action === "analyze") { await reply(input.sessionID, analyzeCompaction(project, parsed.options)); return "handled" }
        if (!input.sessionID) throw new Error("A session is required for ADR maintenance")
        if (parsed.action === "status") {
          let text: string
          if (parsed.id) { const p = loadPlan(project, parsed.id); text = JSON.stringify({ id: p.id, state: p.state, revision: p.revision, result: p.result, approval: p.approval, stages: progress(p), review: `${maintenancePath(project)}/${p.id}.review.md` }) }
          else {
            let names: string[] = []
            try { names = readdirSync(projectPath(project, maintenancePath(project))).filter(n => /^cp-[a-f0-9]{16}\.json$/.test(n)).slice(-30) } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err }
            text = JSON.stringify({ current: currentState(project).status, plans: names.map(n => { const p = loadPlan(project, n.slice(0, -5)); return { id: p.id, state: p.state, kind: p.kind } }) })
          }
          await reply(input.sessionID, text); return "handled"
        }
        if (parsed.action === "confirm") {
          const p = loadPlan(project, parsed.id!)
          if (!p.seal) throw new Error("A complete reviewed candidate is required")
          const result = applyPlan(project, p.id, p.seal, `user-command:${input.sessionID}`, p.approval?.choice === "drafts" ? "drafts" : "accept")
          await reply(input.sessionID, `${result.state}: ${result.result ?? ""}`); return "handled"
        }
        if (parsed.action === "archive" || parsed.action === "restore") {
          const p = planArchive(project, input.sessionID, parsed.options.sources, parsed.action === "restore" ? parsed.id : undefined)
          output.parts = [{ type: "text", text: `Review ADR maintenance ${p.id}. Load the adr-compaction skill. Read adr_compaction review pages and show the changes before presenting this native Ask: ${JSON.stringify(registerReview(p))}` }]
          return "continue"
        }
        const p = startCompaction(project, input.sessionID, parsed.options)
        output.parts = [{ type: "text", text: `ADR ${p.kind} plan ${p.id} created. Load the adr-compaction skill. Source targets: ${p.selected.length}; full CURRENT evidence records: ${p.evidencePaths.length}. FIRST use adr_compaction action ask and call its native cost question. Do not ingest source bodies until the user authorizes cost. After authorization retrieve all evidence pages with adr_compaction; only selected IDs may be replaced. Preserve meaning, retain independent decisions, and submit a complete coverage matrix. Show review artifacts, then use the registered native Ask. Do not modify original ADRs directly.` }]
        return "continue"
      } catch (err) { await reply(input.sessionID, `ADR compaction stopped: ${String(err)}`); return "handled" }
    },
    // V2 tool execute.before: record the question call id and reject a stale
    // review. The signature gate means only the exact registered Ask passes.
    async before(e: { tool?: string; sessionID?: string; id?: string; input?: unknown }) {
      if (e.tool !== "question" || !e.sessionID) return
      const p = pending.get(e.sessionID)
      if (!p) return
      const args = e.input as { questions?: unknown } | undefined
      if (questionSignature(args?.questions) !== questionSignature([p.question])) return
      if (Date.now() > p.expires) { pending.delete(e.sessionID); throw new Error("ADR review expired; request a new Ask") }
      p.callID = e.id
    },
    // V2 event subscription handler: only session teardown cleanup remains
    // (question authorization moved to the execute.after result path below).
    async event(event: unknown) {
      if (!event || typeof event !== "object") return
      const e = event as { type?: string; properties?: Record<string, unknown>; data?: Record<string, unknown> }
      const data = e.data ?? e.properties
      if (!data || typeof data.sessionID !== "string") return
      const session = data.sessionID
      if (e.type === "session.deleted") { pending.delete(session); seenEvidence.delete(session); results.delete(session) }
    },
    // V2 tool execute.after — question authorization. A completed question
    // result carries the server-produced answers (the model cannot forge a
    // tool result), so this is the trusted authorization signal that v1 read
    // off the question.replied event. `result`/`error` are mutated in place;
    // the receipt rides back to the model inside the existing tool output.
    async after(e: {
      tool?: string
      sessionID?: string
      id?: string
      input?: unknown
      status: "completed" | "error"
      result?: { content?: string; output?: { answers?: unknown } }
    }) {
      if (e.tool !== "question" || !e.sessionID) return
      const session = e.sessionID
      const p = pending.get(session)
      // Dismissal (error) cancels the armed review.
      if (e.status !== "completed") { if (p) pending.delete(session); return }
      if (p && p.callID === e.id && questionSignature((e.input as { questions?: unknown })?.questions) === questionSignature([p.question])) {
        pending.delete(session) // consume before any write; a duplicate result cannot authorize twice
        const answers = e.result?.output?.answers
        if (Array.isArray(answers) && answers.length === 1 && Array.isArray(answers[0]) && answers[0].length === 1) {
          const choice = p.labels.get(answers[0][0] as string)
          if (choice) {
            if (choice === "modify") {
              results.set(session, "User requested changes. Revise, resubmit, and obtain a NEW Ask; no source changes applied.")
            } else {
              try {
                if (p.budget && choice === "drafts") throw new Error("Invalid cost choice")
                const actor = `question:${e.id};session:${session}`
                const r = p.budget ? approveDrafting(project, p.id, session, actor, choice === "cancel") : applyPlan(project, p.id, p.seal, actor, choice)
                results.set(session, `${r.state}: ${r.result ?? (r.costApproval ? "Drafting cost authorized. Retrieve evidence, then present a separate reviewed acceptance Ask." : "Plan cancelled; local candidate retained.")}`)
              } catch (err) { results.set(session, `ADR application stopped; inspect /adr compaction status ${p.id}. ${String(err)}`) }
              // Best-effort announce (v2: server-log line; status also stays
              // available through the maintenance tool).
              await notify(results.get(session)!, "info")
            }
          }
        }
      }
      // Carry any pending receipt into the question tool's own model-facing
      // result so the LLM sees the outcome without an extra turn.
      if (results.has(session) && e.result && typeof e.result.content === "string") {
        e.result.content += `\n[ADR-COMPACTION] ${results.get(session)}`
        results.delete(session)
      }
    },
  }
}
