/**
 * rtk-write configuration — `tools.rtkWrite` in ~/.config/opencode/options.jsonc.
 *
 * Shape (all keys optional; missing file / parse failure → safe defaults):
 * {
 *   "tools": {
 *     "rtkWrite": {
 *       "enabled": true,          // master switch (default true)
 *       "loopThreshold": 3,       // same command Nth execution passes through raw; 0 disables (default 3)
 *       "blocklist": ["git diff"] // normalized-command prefixes never rewritten (default [])
 *     }
 *   }
 * }
 *
 * Unlike tools.tgrep (missing config → disabled), rtk-write's enable gate is
 * "rtk binary exists in PATH"; this config only tunes behavior, so a missing
 * or broken file falls back to fully-enabled defaults.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripJsonc } from "../shared/opencode-prime";

export interface RtkWriteOptions {
  enabled: boolean;
  /** Same normalized command runs this many times in a session → stop rewriting (0 = off). */
  loopThreshold: number;
  /** Normalized-command prefixes that are never rewritten (e.g. "git diff" blocks "git diff HEAD"). */
  blocklist: string[];
}

export const DEFAULT_RTK_WRITE_OPTIONS: RtkWriteOptions = {
  enabled: true,
  loopThreshold: 3,
  blocklist: [],
};

/** Validate a parsed `tools.rtkWrite` value. Throws with a `tools.rtkWrite`
 * prefixed message on invalid input so callers can distinguish config errors
 * from unrelated parse failures. */
export function parseRtkWriteOptions(value: unknown): RtkWriteOptions {
  if (value === undefined) return { ...DEFAULT_RTK_WRITE_OPTIONS };
  if (value === false) return { ...DEFAULT_RTK_WRITE_OPTIONS, enabled: false };
  if (value === true) return { ...DEFAULT_RTK_WRITE_OPTIONS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tools.rtkWrite must be a boolean or object");
  }
  const raw = value as Record<string, unknown>;
  const result: RtkWriteOptions = { ...DEFAULT_RTK_WRITE_OPTIONS };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error("tools.rtkWrite.enabled must be a boolean");
    result.enabled = raw.enabled;
  }
  if (raw.loopThreshold !== undefined) {
    if (typeof raw.loopThreshold !== "number" || !Number.isInteger(raw.loopThreshold) || raw.loopThreshold < 0) {
      throw new Error("tools.rtkWrite.loopThreshold must be a non-negative integer");
    }
    result.loopThreshold = raw.loopThreshold;
  }
  if (raw.blocklist !== undefined) {
    if (!Array.isArray(raw.blocklist) || raw.blocklist.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error("tools.rtkWrite.blocklist must be an array of non-empty command prefixes");
    }
    result.blocklist = (raw.blocklist as string[]).map(normalizeCommand);
  }
  return result;
}

/** Collapse whitespace runs and trim so `git  status` and `git status` count
 * as the same command for loop detection and blocklist matching. */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/** Read tools.rtkWrite from the user's options.jsonc; any failure (missing
 * file, unparseable text, invalid values) safely returns defaults. A file
 * that parses but holds an invalid rtkWrite section warns at plugin load so
 * the typo is visible; a file that does not parse at all is someone else's
 * error to report, so this stays quiet to avoid a misleading rtk warning. */
export function loadRtkWriteOptions(): RtkWriteOptions {
  let text: string;
  try {
    text = readFileSync(join(homedir(), ".config", "opencode", "options.jsonc"), "utf8");
  } catch {
    return { ...DEFAULT_RTK_WRITE_OPTIONS };
  }

  let parsed: { tools?: { rtkWrite?: unknown } };
  try {
    parsed = JSON.parse(stripJsonc(text)) as { tools?: { rtkWrite?: unknown } };
  } catch {
    return { ...DEFAULT_RTK_WRITE_OPTIONS };
  }

  try {
    return parseRtkWriteOptions(parsed.tools?.rtkWrite);
  } catch (error) {
    console.warn(`[rtk-write] ignoring invalid tools.rtkWrite — using defaults: ${String(error)}`);
    return { ...DEFAULT_RTK_WRITE_OPTIONS };
  }
}
