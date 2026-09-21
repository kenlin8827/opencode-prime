/**
 * rtk-write — OpenCode plugin for RTK (Rust Token Killer).
 *
 * Vendored from https://github.com/martinstannard/openrtk
 * Copyright (c) 2026 Martin Stannard, MIT License.
 * Intercepts shell commands in `tool.execute.before` and rewrites them
 * through RTK for automatic output compression (60-90% token savings on
 * common dev commands).
 *
 * Local deviations from upstream:
 *  - The rtk probe uses `rtk --version` instead of `which rtk` — `which`
 *    doesn't exist on native Windows and would silently disable the plugin.
 *  - Compression is no longer "fully transparent". Lossy output is what
 *    makes models loop, so this build adds three softness mechanisms:
 *      1. loop guard   — an elided or repeatedly-run command stops being
 *                        rewritten so the model finally sees full output
 *                        (loop-guard.ts)
 *      2. escape hatch — `RTK_RAW=1 <cmd>` bypasses rewriting (recovery.ts)
 *      3. recovery hint— elided output gets a one-line "how to get it all"
 *                        notice appended in `tool.execute.after` (recovery.ts)
 *    Tuning lives in `tools.rtkWrite` (config.ts).
 *
 * Replaces rtk's official opencode plugin (`rtk init -g --opencode`):
 * same hook, same effect, but shipped by this repo so no `rtk init`
 * step is needed and the rewrite rules are reviewable in-tree.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadRtkWriteOptions, normalizeCommand, type RtkWriteOptions } from "./config";
import { createLoopGuard } from "./loop-guard";
import { buildRecoveryNotice, containsElisionMarker, isRawBypass } from "./recovery";

const MAX_REWRITE_CACHE_ENTRIES = 256;
const execFileAsync = promisify(execFile);

/** Run RTK without a shell or a globally installed Bun runtime. */
async function runRtkRewrite(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("rtk", ["rewrite", command], {
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch (error) {
    // `rtk rewrite` may return a non-zero status while still writing a result.
    const stdout = (error as { stdout?: string | Buffer }).stdout;
    return typeof stdout === "string" ? stdout.trim() || null : null;
  }
}

/**
 * Per-session LRU cache. Repeated commands are common in agent loops (status,
 * tests, lint), so cache both RTK rewrites and deliberate passthroughs. Values
 * are promises to coalesce concurrent requests for the same command.
 */
export function createRewriteCache(rewriteCommand = runRtkRewrite) {
  const entries = new Map<string, Promise<string | null>>();

  return (command: string): Promise<string | null> => {
    const cached = entries.get(command);
    if (cached) {
      entries.delete(command);
      entries.set(command, cached);
      return cached;
    }

    const pending = rewriteCommand(command);

    entries.set(command, pending);
    if (entries.size > MAX_REWRITE_CACHE_ENTRIES) {
      entries.delete(entries.keys().next().value!);
    }
    return pending;
  };
}

/** Is this command eligible for rewriting? Shared by the before-hook and
 * exposed for tests so the decision logic stays independent of opencode. */
function isBlocked(command: string, options: RtkWriteOptions): boolean {
  const normalized = normalizeCommand(command);
  return options.blocklist.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Remembers the pre-rewrite command per tool call, so the after-hook can name
 * the original command in the recovery notice.
 *
 * Why this exists: the before-hook mutates `output.args.command`, so
 * opencode's after-hook `args` may already be the rewritten command. Building
 * the hint from that would produce `RTK_RAW=1 rtk git status` — a rerun that
 * still compresses and therefore still loops. Storing the original keyed by
 * `callID` makes the notice correct regardless of which args the runtime
 * hands the after-hook. Bounded: entries are consumed on use, and the cap
 * covers calls whose after-hook never fires (aborted tools).
 */
const MAX_TRACKED_CALLS = 512;

export function createOriginalCommandTracker() {
  const commands = new Map<string, string>();
  return {
    remember(callID: string, command: string): void {
      commands.set(callID, command);
      while (commands.size > MAX_TRACKED_CALLS) {
        const oldest = commands.keys().next().value;
        if (oldest === undefined) break;
        commands.delete(oldest);
      }
    },
    take(callID: string): string | undefined {
      const command = commands.get(callID);
      commands.delete(callID);
      return command;
    },
  };
}

/**
 * Plugin core, decoupled from opencode hook plumbing so it can be unit
 * tested: decide whether to rewrite a command (before-hook) and whether to
 * append a recovery notice (after-hook).
 */
export function createRtkWriteCore(
  options: RtkWriteOptions,
  rewriteCommand: (command: string) => Promise<string | null>,
) {
  const loopGuard = createLoopGuard(options);

  return {
    /** Returns the rewritten command, or null to leave the command as-is. */
    async decideRewrite(sessionID: string, command: string): Promise<string | null> {
      if (!options.enabled) return null;
      // Explicit escape hatch — never rewrite, never count against the loop guard.
      if (isRawBypass(command)) return null;
      if (isBlocked(command, options)) return null;
      // Loop breaker — after elision or the repeat threshold, pass through to
      // the real shell so the model finally sees uncompressed output.
      if (loopGuard.shouldBypass(sessionID, command)) return null;
      return rewriteCommand(command);
    },

    /** Append the recovery notice when RTK elided output, and remember the
     * command so its next run bypasses compression entirely. */
    annotateOutput(sessionID: string, command: string, output: string): string {
      if (!options.enabled) return output;
      if (isRawBypass(command)) return output;
      if (!containsElisionMarker(output)) return output;
      loopGuard.markElided(sessionID, command);
      return `${output}\n${buildRecoveryNotice(command)}`;
    },
  };
}

/**
 * Touch rtk's hook-warn marker so the "No hook installed" banner is
 * rate-limited to silence for the opencode session.
 *
 * rtk's hook_check::check_and_warn() emits the banner when its own
 * shell hook isn't installed. On Windows `rtk init -g` can't install
 * the bash hook (no bash/jq/POSIX perms), so the banner appears on
 * every command and pollutes the LLM context. The check has a 24-hour
 * rate-limit via a marker file at dirs::data_local_dir()/rtk/
 * .hook_warn_last — touching it at plugin load keeps it fresh for the
 * session. Platform paths follow the Rust `dirs` crate: win32 =
 * LOCALAPPDATA, darwin = ~/Library/Application Support (XDG ignored),
 * linux = XDG_DATA_HOME or ~/.local/share.
 *
 * Our vendored plugin already rewrites commands via tool.execute.before,
 * so rtk's shell hook is redundant (and impossible on Windows).
 */
function silenceHookWarn() {
  try {
    const dataDir =
      process.platform === "win32"
        ? join(
            process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
            "rtk",
          )
        : process.platform === "darwin"
          ? join(homedir(), "Library", "Application Support", "rtk")
          : join(
              process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
              "rtk",
            );
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, ".hook_warn_last"), "");
  } catch {
    // best-effort — don't break plugin init
  }
}

/** Extract the shell command from opencode's bash/shell tool args. */
function commandArg(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" && command.trim() ? command : null;
}

export const RtkWritePlugin: Plugin = async () => {
  const options = loadRtkWriteOptions();
  if (!options.enabled) return {};

  // Probe through Node's argv-based process API, not a shell command. This
  // works with rtk.exe on Windows and the Unix binary on macOS/Linux.
  try {
    await execFileAsync("rtk", ["--version"], { windowsHide: true });
  } catch {
    console.warn("[rtk-write] rtk binary not found in PATH — plugin disabled");
    return {};
  }

  // Suppress rtk's "No hook installed" banner — our vendored plugin
  // already handles command rewriting via tool.execute.before, so
  // rtk's own shell hook is redundant (and impossible on Windows).
  silenceHookWarn();
  const core = createRtkWriteCore(options, createRewriteCache());
  const tracker = createOriginalCommandTracker();

  return {
    "tool.execute.before": async (input, output) => {
      // OpenCode may use "bash", "shell", or other names
      const tool = String(input?.tool ?? "").toLowerCase();
      if (tool !== "bash" && tool !== "shell") return;

      const command = commandArg(output?.args);
      if (!command) return;

      // Remember the original before rewriting, so the after-hook can build a
      // correct "rerun with RTK_RAW=1 ..." hint.
      tracker.remember(input.callID, command);

      // RTK owns the rewrite contract. Its exit status is not meaningful here:
      // it returns status 3 even when it writes a valid rewrite. Therefore,
      // non-empty stdout is the sole success condition. Empty output leaves
      // the original command unchanged.
      const rewritten = await core.decideRewrite(input.sessionID, command);
      if (rewritten) (output.args as Record<string, unknown>).command = rewritten;
    },

    "tool.execute.after": async (input, output) => {
      const tool = String(input?.tool ?? "").toLowerCase();
      if (tool !== "bash" && tool !== "shell") return;

      // Only annotate when the before-hook tracked this call. Falling back to
      // `input.args` is unsafe: the before-hook mutated those args, so the
      // after-hook may receive the rewritten command, and the hint would read
      // "RTK_RAW=1 rtk <cmd>" — a rerun that still compresses. Untracked calls
      // (evicted, or the before-hook never saw them) get no hint at all.
      const command = tracker.take(input.callID);
      if (!command || typeof output?.output !== "string") return;
      output.output = core.annotateOutput(input.sessionID, command, output.output);
    },
  };
};
