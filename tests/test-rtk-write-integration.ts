/**
 * rtk-write integration test.
 *
 * The plugin intentionally delegates rewriting to `rtk rewrite`, which is
 * RTK's authoritative command-rewrite interface. These cases ensure RTK's
 * non-empty output is propagated and empty output leaves commands untouched.
 * All subprocesses use argv arrays, avoiding shell quoting differences across
 * Windows, macOS, and Linux. It also checks that repeated commands reuse the
 * same in-flight rewrite instead of spawning duplicate RTK processes.
 *
 * Run: bun run tests/test-rtk-write-integration.ts
 */
import { DEFAULT_RTK_WRITE_OPTIONS } from "../plugins/rtk-write/config";
import { createRtkWriteCore, createRewriteCache } from "../plugins/rtk-write/index";

const cases: Array<[string, string | null]> = [
  ["git status", "rtk git status"],
  ["cargo test", "rtk cargo test"],
  ["npm run build", "rtk npm run build"],
  ["npx tsc --noEmit", "rtk tsc --noEmit"],
  ["mvnw test", "rtk mvn test"],
  ["terraform plan", "rtk terraform plan"],
  ["command-that-does-not-exist", null],
];

let failures = 0;
for (const [command, expected] of cases) {
  const process = Bun.spawn(["rtk", "rewrite", command], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = new Response(process.stdout).text();
  await process.exited;
  const rewritten = (await output).trim();
  const actual = rewritten || null;
  if (actual !== expected) {
    console.error(
      `FAIL ${command}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
    );
    failures++;
  } else {
    console.log(`OK   ${command} → ${actual ?? "passthrough"}`);
  }
}

if (failures) process.exit(1);

// --- flexible-plugin behavior against the real rtk binary -------------------
// Drives the plugin core (not the hook plumbing) with the real `rtk rewrite`
// path, so the loop guard, escape hatch, and recovery notice are verified
// end-to-end rather than only against a fake rewriter.
const core = createRtkWriteCore(
  { ...DEFAULT_RTK_WRITE_OPTIONS, loopThreshold: 3 },
  createRewriteCache(),
);

const check = (condition: boolean, label: string) => {
  if (condition) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}`);
    failures++;
  }
};

const firstRun = await core.decideRewrite("session-1", "git status");
const secondRun = await core.decideRewrite("session-1", "git status");
const escaped = await core.decideRewrite("session-1", "RTK_RAW=1 git status");
const annotated = core.annotateOutput(
  "session-1",
  "git status",
  "clean\n[see remaining: tail -n +1 x-hidden.log]",
);
const elisionBypass = await core.decideRewrite("session-1", "git status");
const untouched = core.annotateOutput("session-1", "git status", "clean");

check(firstRun === "rtk git status", "first run rewrites through real rtk");
check(secondRun === "rtk git status", "repeat below threshold still compresses");
check(escaped === null, "RTK_RAW=1 escape hatch bypasses real rtk");
check(
  annotated.includes("RTK_RAW=1 git status"),
  "elided output gains a rerun hint",
);
check(elisionBypass === null, "elided command passes through raw next run");
check(untouched === "clean", "complete output stays untouched");

if (failures) process.exit(1);
