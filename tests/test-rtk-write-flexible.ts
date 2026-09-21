/**
 * rtk-write flexible-plugin tests.
 *
 * Covers the softness mechanisms added on top of the upstream rewrite-only
 * plugin: elision-aware loop breaker, repeat-threshold fallback, RTK_RAW
 * escape hatch, the elision recovery notice, and config parsing.
 *
 * Run: bun run tests/test-rtk-write-flexible.ts
 */
import { DEFAULT_RTK_WRITE_OPTIONS, parseRtkWriteOptions, type RtkWriteOptions } from "../plugins/rtk-write/config";
import { createOriginalCommandTracker, createRtkWriteCore } from "../plugins/rtk-write/index";
import { containsElisionMarker, isRawBypass } from "../plugins/rtk-write/recovery";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function options(overrides: Partial<RtkWriteOptions> = {}): RtkWriteOptions {
  return { ...DEFAULT_RTK_WRITE_OPTIONS, ...overrides };
}

/** Core wired to a counting fake rewriter (every command "supported"). */
function coreWithCounter(overrides: Partial<RtkWriteOptions> = {}) {
  let calls = 0;
  const core = createRtkWriteCore(options(overrides), async (command) => {
    calls++;
    return `rtk ${command}`;
  });
  return { core, calls: () => calls };
}

const ELIDED = "clean\n[see remaining: tail -n +1 x-hidden.log]";

// --- elision-aware breaker: an elided command goes raw next time -----------
{
  const { core, calls } = coreWithCounter({ loopThreshold: 5 });
  const first = await core.decideRewrite("s1", "git status");
  const annotated = core.annotateOutput("s1", "git status", ELIDED);
  const second = await core.decideRewrite("s1", "git status");
  assert(first === "rtk git status", `first run should rewrite, got ${first}`);
  assert(annotated.includes("RTK_RAW=1 git status"), `elided output must gain a hint, got ${annotated}`);
  assert(second === null, `an elided command must bypass next run, got ${second}`);
  assert(calls() === 1, `rewriter must run once, got ${calls()}`);
}

// --- elision-aware breaker: sticky for the rest of the session -------------
{
  const { core } = coreWithCounter({ loopThreshold: 5 });
  await core.decideRewrite("s", "git status");
  core.annotateOutput("s", "git status", ELIDED);
  const later = await core.decideRewrite("s", "git status");
  const muchLater = await core.decideRewrite("s", "git status");
  assert(later === null && muchLater === null, "elision bypass must stay sticky");
}

// --- elision-aware breaker: per session, not global -----------------------
{
  const { core } = coreWithCounter({ loopThreshold: 5 });
  await core.decideRewrite("a", "git status");
  core.annotateOutput("a", "git status", ELIDED);
  const other = await core.decideRewrite("b", "git status");
  assert(other === "rtk git status", `elision must not leak across sessions, got ${other}`);
}

// --- repeat threshold: non-elided repeats keep compressing ----------------
{
  const { core, calls } = coreWithCounter({ loopThreshold: 3 });
  const first = await core.decideRewrite("s", "git status");
  const second = await core.decideRewrite("s", "git status");
  const third = await core.decideRewrite("s", "git status");
  const fourth = await core.decideRewrite("s", "git status");
  assert(first === "rtk git status" && second === "rtk git status", "repeats below threshold still compress");
  assert(third === null && fourth === null, "threshold run and beyond pass through raw");
  assert(calls() === 2, `rewriter called twice, got ${calls()}`);
}

// --- repeat threshold: whitespace variants share a counter ----------------
{
  const { core } = coreWithCounter({ loopThreshold: 2 });
  await core.decideRewrite("s", "git   status");
  const second = await core.decideRewrite("s", " git status ");
  assert(second === null, `whitespace variants must share a counter, got ${second}`);
}

// --- repeat threshold: 0 disables the fallback ----------------------------
{
  const { core, calls } = coreWithCounter({ loopThreshold: 0 });
  for (let i = 0; i < 5; i++) {
    const result = await core.decideRewrite("s", "git status");
    assert(result === "rtk git status", `threshold 0 must keep rewriting, got ${result}`);
  }
  assert(calls() === 5, `threshold 0 must never bypass, got ${calls()} calls`);
}

// --- memory bounds must not resurrect a bypassed command ------------------
// Regression: with a single saturating counter, the entry for a command that
// had already reached the threshold stayed at `threshold - 1` and could be
// evicted by the per-session LRU, letting the command be rewritten again and
// a loop resume. Flood the counter past its cap and re-check.
{
  const rewritten: string[] = [];
  const core = createRtkWriteCore(options({ loopThreshold: 2 }), async (command) => {
    rewritten.push(command);
    return `rtk ${command}`;
  });
  const timesRewritten = () => rewritten.filter((c) => c === "git status").length;

  await core.decideRewrite("s", "git status");
  const second = await core.decideRewrite("s", "git status");
  assert(second === null, "threshold run must bypass");
  assert(timesRewritten() === 1, "git status rewritten exactly once before the flood");

  for (let i = 0; i < 1200; i++) await core.decideRewrite("s", `echo unique-${i}`);
  const afterFlood = await core.decideRewrite("s", "git status");
  assert(afterFlood === null, `bypass must survive LRU pressure, got ${afterFlood}`);
  assert(timesRewritten() === 1, "a bypassed command must never reach rtk again");
}

// --- original-command tracker: the notice names the PRE-rewrite command ----
// Simulates the opencode plumbing risk: the before-hook mutated args, so the
// after-hook may receive the rewritten command. The tracker must win, or the
// hint would read "RTK_RAW=1 rtk git status" (which still compresses).
{
  const tracker = createOriginalCommandTracker();
  assert(tracker.take("missing") === undefined, "unknown callID yields undefined");

  tracker.remember("call-1", "git status");
  assert(tracker.take("call-1") === "git status", "tracker returns the original command");
  assert(tracker.take("call-1") === undefined, "take consumes the entry");

  const { core } = coreWithCounter();
  tracker.remember("call-2", "git status");
  await core.decideRewrite("s", "git status");
  // The after-hook is handed the rewritten command by the runtime, but the
  // tracker still knows what the model actually typed.
  const command = tracker.take("call-2") ?? "rtk git status";
  const notice = core.annotateOutput("s", command, ELIDED);
  assert(notice.includes("RTK_RAW=1 git status"), `notice must name the original command, got ${notice}`);
  assert(!notice.includes("RTK_RAW=1 rtk"), `notice must not double-prefix a rewritten command, got ${notice}`);
}

// --- escape hatch: RTK_RAW=1 prefix bypasses rewriting --------------------
{
  const { core, calls } = coreWithCounter();
  const escaped = await core.decideRewrite("s", "RTK_RAW=1 git status");
  const spaced = await core.decideRewrite("s", "  RTK_RAW=1   git status");
  assert(escaped === null, `RTK_RAW=1 prefix must bypass, got ${escaped}`);
  assert(spaced === null, `leading spaces must not defeat the hatch, got ${spaced}`);
  assert(calls() === 0, `hatch must not reach rtk, got ${calls()} calls`);
}

// --- escape hatch: only an exact RTK_RAW=1 prefix matches ----------------
{
  assert(isRawBypass("RTK_RAW=1 ls"), "exact prefix should match");
  assert(!isRawBypass("RTK_RAW=10 ls"), "RTK_RAW=10 is a different variable value");
  assert(!isRawBypass("echo RTK_RAW=1"), "a suffix mention is not the hatch");
  assert(!isRawBypass("RTK_RAW=1"), "prefix without a command is not the hatch");
}

// --- blocklist: prefix match skips rewriting -----------------------------
{
  // Go through the parser so parse-time normalization and lookup-time
  // normalization are proven to agree.
  const parsed = parseRtkWriteOptions({ blocklist: ["git   diff"] });
  const { core, calls } = coreWithCounter({ blocklist: parsed.blocklist });
  const blocked = await core.decideRewrite("s", "git diff HEAD --stat");
  const allowed = await core.decideRewrite("s", "git status");
  assert(blocked === null, `blocklisted prefix must bypass, got ${blocked}`);
  assert(allowed === "rtk git status", `non-blocked command should rewrite, got ${allowed}`);
  assert(calls() === 1, `blocked command must not reach rtk, got ${calls()} calls`);
}

// --- enabled:false disables both hooks -----------------------------------
{
  const { core, calls } = coreWithCounter({ enabled: false });
  const rewrite = await core.decideRewrite("s", "git status");
  const annotated = core.annotateOutput("s", "git status", ELIDED);
  assert(rewrite === null, `disabled plugin must not rewrite, got ${rewrite}`);
  assert(calls() === 0, `disabled plugin must not call rtk, got ${calls()} calls`);
  assert(annotated === ELIDED, "disabled plugin must not annotate");
}

// --- recovery notice: appended only when output was elided ---------------
{
  const { core } = coreWithCounter();
  const elided = core.annotateOutput("s", "git status", ELIDED);
  assert(containsElisionMarker(elided), "elision marker should be detected");
  assert(elided.includes("RTK_RAW=1 git status"), `notice must show the rerun command, got: ${elided}`);
  assert(elided.startsWith("clean"), "original output must be preserved");

  const full = core.annotateOutput("s", "git status", "everything is here");
  assert(full === "everything is here", "complete output must stay untouched");

  const raw = core.annotateOutput("s", "RTK_RAW=1 git status", ELIDED);
  assert(raw === ELIDED, "raw reruns need no recovery notice");
}

// --- config: parsing, defaults, and validation ---------------------------
{
  const defaults = parseRtkWriteOptions(undefined);
  assert(defaults.enabled && defaults.loopThreshold === 3 && defaults.blocklist.length === 0, "missing config → defaults");

  assert(parseRtkWriteOptions(false).enabled === false, "false must disable");
  assert(parseRtkWriteOptions(true).enabled === true, "true must enable");

  const parsed = parseRtkWriteOptions({ enabled: true, loopThreshold: 5, blocklist: ["git  diff"] });
  assert(parsed.loopThreshold === 5, "loopThreshold should parse");
  assert(parsed.blocklist[0] === "git diff", `blocklist should be normalized, got ${parsed.blocklist[0]}`);

  const expectThrow = (value: unknown, label: string) => {
    try {
      parseRtkWriteOptions(value);
      throw new Error(`${label} should have thrown`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("tools.rtkWrite")) {
        throw new Error(`${label} threw the wrong error: ${String(error)}`);
      }
    }
  };
  expectThrow("yes", "string value");
  expectThrow({ loopThreshold: -1 }, "negative loopThreshold");
  expectThrow({ loopThreshold: 1.5 }, "fractional loopThreshold");
  expectThrow({ blocklist: ["  "] }, "blank blocklist entry");
  expectThrow({ blocklist: "git diff" }, "non-array blocklist");
}

console.log("OK   rtk-write flexible plugin (elision breaker, threshold, escape hatch, recovery, config)");
