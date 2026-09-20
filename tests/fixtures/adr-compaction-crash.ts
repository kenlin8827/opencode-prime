/** Test child process: fault injection is intentionally NOT a production API. */
import * as fs from "node:fs"
import { join } from "node:path"
import { mock } from "bun:test"
const [project, id, seal, point] = process.argv.slice(2)
const rename = fs.renameSync, unlink = fs.unlinkSync
const state = join(project, ".ocp/adr-compaction")
const complete = (stage: string) => {
  try { return JSON.parse(fs.readFileSync(join(state, `${id}.${stage}.json`), "utf8")).complete === true } catch { return false }
}
const crash = (path: string, removing = false) => {
  const rel = path.slice(project.length + 1).replace(/\\/g, "/")
  const plan = rel === `.ocp/adr-compaction/${id}.json` ? JSON.parse(fs.readFileSync(path, "utf8")) : null
  const hit = {
    approval: plan?.state === "applying",
    "lifecycle-start": rel.endsWith(`${id}.lifecycle.json`) && !complete("lifecycle"),
    ledger: rel === ".ocp/adr-decisions.log",
    successor: rel === "docs/adr/0003-consolidated.md",
    predecessor: rel === "docs/adr/0001-original.md" && !removing,
    "lifecycle-complete": rel.endsWith(`${id}.lifecycle.json`) && complete("lifecycle"),
    "current-body": rel === "docs/adr/CURRENT.md" && !complete("archive"),
    "views-complete": rel.endsWith(`${id}.views.json`) && complete("views"),
    "archive-destination": rel === "docs/adr/archive/0001-original.md",
    "archive-source-removed": rel === "docs/adr/0001-original.md" && removing,
    "archive-complete": rel.endsWith(`${id}.archive.json`) && complete("archive"),
    "relocated-current-body": rel === "docs/adr/CURRENT.md" && complete("archive"),
    "relocated-views-complete": rel.endsWith(`${id}.relocated-views.json`) && complete("relocated-views"),
    complete: plan?.state === "complete",
  }[point]
  if (hit) {
    fs.writeFileSync(join(project, "fault-fired"), String(process.pid))
    process.kill(process.pid, "SIGKILL")
  }
}
mock.module("node:fs", () => ({ ...fs,
  renameSync(from: fs.PathLike, to: fs.PathLike) { rename(from, to); crash(String(to)) },
  unlinkSync(path: fs.PathLike) { unlink(path); crash(String(path), true) },
}))
const { applyPlan } = await import("../../plugins/adr/adr-compaction")
applyPlan(project, id, seal, "verified-fixture-user", "accept")
throw new Error(`Fault point was not reached: ${point}`)
