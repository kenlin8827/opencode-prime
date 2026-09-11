/** Reproducible local benchmark; requires user-installed tgrep and rg. */
import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"

const root = process.argv[2] ?? process.cwd()
const pattern = process.argv[3] ?? "TODO"
const runs = Number(process.env.OCP_TGREP_BENCH_RUNS ?? 10)
function timed(command: string, args: string[]) {
  const started = performance.now()
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true })
  return { ms: performance.now() - started, code: result.status ?? 2 }
}
function percentile(values: number[], p: number) { return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] }
for (const [command, args] of [["tgrep", ["index", "."]], ["tgrep", ["-F", "--", pattern, "."]], ["rg", ["-F", "--", pattern, "."]]] as const) {
  const results = Array.from({ length: command === "tgrep" && args[0] === "index" ? 1 : runs }, () => timed(command, args))
  const ms = results.map((r) => r.ms).sort((a, b) => a - b)
  console.log(JSON.stringify({ command: `${command} ${args.join(" ")}`, root, runs: ms.length, p50Ms: percentile(ms, .5), p95Ms: percentile(ms, .95), codes: results.map((r) => r.code), rootBytes: statSync(root).size }))
}
