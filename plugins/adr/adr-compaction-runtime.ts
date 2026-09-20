/** Native command/tool/Question integration. Question replies are server events,
 * never model-provided authorization flags. No client question-creation API exists
 * in SDK 1.18.15: the agent presents exact registered arguments to `question`.
 */
import { tool, type PluginInput, type ToolContext } from "@opencode-ai/plugin"
import { readdirSync } from "node:fs"
import { scopedForTool } from "../shared/plugin-scope"
import { refreshLocale, tr } from "../tui/i18n"
import { analyzeCompaction, checkCompaction, approveDrafting, applyPlan, candidateBatchSchema, candidateBatchPage, stageCandidate, compactionEvidence, loadPlan, planArchive, reviewPage, sealPlan, startCompaction, submitCandidate, type CompactionOptions, type Plan } from "./adr-compaction"
import { currentState, queryAdrContext, takeSnapshot } from "./adr-context"
import { maintenancePath, projectPath, readOptional } from "./adr-storage"

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
interface Pending { budget?: boolean; id: string; seal: string; question: Question; labels: Map<string, "accept" | "drafts" | "cancel" | "modify">; expires: number; callID?: string; requestID?: string }

export function createCompactionRuntime(project: string, client: PluginInput["client"]) {
  const pending = new Map<string, Pending>()
  const results = new Map<string, string>()
  const seenEvidence = new Map<string, Set<string>>()
  const allowed = async (ctx: ToolContext, scope = "adr") => {
    if (!await scopedForTool(ctx, scope, client)) throw new Error("ADR tools unavailable in this agent scope")
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
    return { questions: [question], instructions: "Show the review artifacts to the user. Call the native question tool with these exact questions. Only its server reply event can authorize execution. Do not edit the question or claim approval yourself." }
  }
  const progress = (p: Plan) => Object.fromEntries(["drafts", "lifecycle", "views", "archive", "relocated-views"].map(stage => {
    const raw = readOptional(project, `${maintenancePath(project)}/${p.id}.${stage}.json`)
    try { return [stage, raw === null ? "not-started" : JSON.parse(raw).complete === true ? "complete" : "pending"] } catch { return [stage, "invalid"] }
  }))
  const reply = async (sessionID: string | undefined, text: string) => {
    if (!sessionID) return
    await client.session.prompt({ path: { id: sessionID }, body: { noReply: true, parts: [{ type: "text", text, ignored: true }] } })
  }
  const tools = {
    adr_context: tool({
      description: "Bounded architecture decision evidence. Select an ID/domain/iteration; current follows accepted successors, history expands archive bodies at most one hop. Read next pages only when evidence is incomplete. Checks CURRENT freshness.",
      args: { id: tool.schema.string().optional(), domain: tool.schema.string().optional(), iteration: tool.schema.string().optional(), intent: tool.schema.enum(["current", "rationale", "history"]).optional(), cursor: tool.schema.string().optional() },
      async execute(args, ctx) {
        await allowed(ctx, "adr-context-tool")
        const page = queryAdrContext(project, args)
        const seen = seenEvidence.get(ctx.sessionID) ?? new Set<string>()
        const keys = page.entries.map(e => `${e.hash}:${e.offset}:${e.end}`)
        if (keys.length && keys.every(k => seen.has(k))) page.issues.push("Repeated evidence: stop unless a concrete unresolved question requires rereading.")
        keys.forEach(k => seen.add(k)); seenEvidence.set(ctx.sessionID, seen)
        return JSON.stringify(page)
      },
    }),
    adr_compaction: tool({
      description: "Draft/review a USER-started ADR compaction plan. evidence returns bounded full-source batches; slots returns reserved scaffolds; stage saves a bounded named candidate batch, batches pages saved drafts; submit without candidate assembles batches and validates a candidate and offers native Ask; review pages the complete changes. No model argument can accept a decision or bypass user review. Load adr-compaction skill.",
      args: { plan: tool.schema.string(), action: tool.schema.enum(["evidence", "slots", "stage", "batches", "submit", "review", "ask", "status"]), cursor: tool.schema.string().optional(), candidate: candidateBatchSchema.optional(), batch: tool.schema.string().optional() },
      async execute(args, ctx) {
        await allowed(ctx)
        const p = loadPlan(project, args.plan, ctx.sessionID)
        if (["evidence", "stage"].includes(args.action) && !p.costApproval) throw new Error("Drafting cost is not authorized. Use action ask and obtain the native user reply first.")
        if (args.action === "evidence") return JSON.stringify(compactionEvidence(project, p.id, ctx.sessionID, args.cursor))
        if (args.action === "stage") {
          if (!args.batch || !args.candidate) throw new Error("stage requires a batch key and candidate data")
          const staged = stageCandidate(project, p.id, ctx.sessionID, args.batch, args.candidate)
          if (staged.revision !== p.revision) pending.delete(ctx.sessionID)
          return JSON.stringify({ id: staged.id, state: staged.state, revision: staged.revision, batches: Object.keys(staged.batches ?? {}).length, instructions: "Batch saved locally, not accepted. Use batches for paged inspection; submit without candidate assembles all batches and validates complete coverage." })
        }
        if (args.action === "batches") return JSON.stringify(candidateBatchPage(project, p.id, ctx.sessionID, args.cursor))
        if (args.action === "slots") {
          const { evidencePage } = await import("./adr-context")
          return JSON.stringify(evidencePage(p.slots.map(slot => ({ id: slot.id, path: p.root, status: "reserved", via: "candidate scaffold", hash: p.fingerprint, body: slot.scaffold })), p.fingerprint, `${p.id}:slots`, args.cursor))
        }
        if (args.action === "review") return JSON.stringify(reviewPage(project, p.id, ctx.sessionID, args.cursor))
        if (args.action === "submit") {
          const submitted = submitCandidate(project, p.id, ctx.sessionID, args.candidate)
          return JSON.stringify(registerReview(submitted))
        }
        if (args.action === "ask") return JSON.stringify(p.state === "drafting" && !p.costApproval ? registerBudget(p) : registerReview(p))
        return JSON.stringify({ id: p.id, state: p.state, revision: p.revision, result: p.result, stages: progress(p), selected: p.selected.length, evidenceRecords: p.evidencePaths.length, review: p.seal ? `${maintenancePath(project)}/${p.id}.review.md` : null })
      },
    }),
  }

  return {
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
    async before(input: { tool?: string; sessionID?: string; callID?: string }, output: { args?: unknown }) {
      if (input.tool !== "question" || !input.sessionID) return
      const p = pending.get(input.sessionID)
      if (!p) return
      const args = output.args as { questions?: unknown } | undefined
      if (questionSignature(args?.questions) !== questionSignature([p.question])) return
      if (Date.now() > p.expires) { pending.delete(input.sessionID); throw new Error("ADR review expired; request a fresh Ask") }
      p.callID = input.callID
    },
    async event(event: unknown) {
      if (!event || typeof event !== "object") return
      const e = event as { type?: string; properties?: Record<string, unknown>; data?: Record<string, unknown> }
      const data = e.properties ?? e.data
      if (!data || typeof data.sessionID !== "string") return
      const session = data.sessionID, p = pending.get(session)
      if (e.type === "session.deleted") { pending.delete(session); seenEvidence.delete(session); results.delete(session); return }
      if (!p) return
      if (Date.now() > p.expires) { pending.delete(session); return }
      if (e.type === "question.asked") {
        const t = data.tool as { callID?: string } | undefined
        if (p.callID && t?.callID === p.callID && questionSignature(data.questions) === questionSignature([p.question]) && typeof data.id === "string") p.requestID = data.id
        return
      }
      if (!p.requestID || data.requestID !== p.requestID) return
      if (e.type === "question.rejected") { pending.delete(session); return }
      if (e.type !== "question.replied") return
      pending.delete(session) // consume before any write; duplicate event cannot authorize twice
      const answers = data.answers
      if (!Array.isArray(answers) || answers.length !== 1 || !Array.isArray(answers[0]) || answers[0].length !== 1) return
      const choice = p.labels.get(answers[0][0])
      if (!choice) return
      if (choice === "modify") { results.set(session, "User requested changes. Revise, resubmit, and obtain a NEW Ask; no source changes applied."); return }
      try {
        if (p.budget && choice === "drafts") throw new Error("Invalid cost choice")
        const actor = `question:${p.requestID};session:${session}`
        const result = p.budget ? approveDrafting(project, p.id, session, actor, choice === "cancel") : applyPlan(project, p.id, p.seal, actor, choice)
        results.set(session, `${result.state}: ${result.result ?? (result.costApproval ? "Drafting cost authorized. Retrieve evidence, then present a separate reviewed acceptance Ask." : "Plan cancelled; local candidate retained.")}`)
      } catch (err) { results.set(session, `ADR application stopped; inspect /adr compaction status ${p.id}. ${String(err)}`) }
      // Do not append a synthetic user message while question is running: even
      // noReply can cause the active runtime loop to take an extra model turn.
      // The question after-hook carries the receipt into its existing tool result.
      try { await client.tui.showToast({ body: { message: results.get(session)!, variant: "info" } }) } catch { /* Status remains available through the maintenance tool. */ }
    },
    async after(input: { tool?: string; sessionID?: string }, output: { output: string }) {
      if (input.tool === "question" && input.sessionID && results.has(input.sessionID)) {
        output.output += `\n[ADR-COMPACTION] ${results.get(input.sessionID)}`
        results.delete(input.sessionID)
      }
    },
  }
}
