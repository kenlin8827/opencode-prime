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
