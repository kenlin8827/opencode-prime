/**
 * Terminal layout helpers for the installer's console output.
 *
 * The install log is organized into titled sections so related lines read
 * as one block instead of a flat stream of prefixed messages:
 *
 *   ────────────────────────────────────────────
 *     OpenCode Prime installer — v0.41.0
 *   ────────────────────────────────────────────
 *
 *   ── Environment ─────────────────────────────
 *   opencode     v1.0.5 · official
 *                C:\Users\me\.opencode\bin\opencode.exe
 *
 *   ── Tools ───────────────────────────────────
 *   ✓ [tool] opencode (opencode) is present on PATH
 *
 * Leaf module (imports only color.ts) so any installer module can use it
 * without creating an import cycle. Colors degrade to plain text when
 * stdout is not a TTY (see color.ts).
 */
import { colorize } from '../color';

/** Full width of the top banner rule. */
const BANNER_WIDTH = 46;
/** Target width of section rules (sits visually under the banner). */
const SECTION_WIDTH = 44;
/** Column where kv() values start (longest key: "OPENCODE_BIN"). */
const KEY_WIDTH = 13;

/** Top-of-run banner: thick rules around the installer title. */
export function banner(title: string, subtitle?: string): void {
  const rule = '─'.repeat(BANNER_WIDTH);
  console.log('');
  console.log(colorize.cyan(rule));
  console.log(`  ${title}${subtitle ? colorize.gray(` — ${subtitle}`) : ''}`);
  console.log(colorize.cyan(rule));
}

/**
 * Section header: `── Title ───…` rule introducing a block of related
 * lines. Only call it when the block is known to emit at least one line —
 * an empty section header is noise.
 */
export function section(title: string): void {
  const label = `── ${title} `;
  console.log('');
  console.log(colorize.cyan(label + '─'.repeat(Math.max(SECTION_WIDTH - label.length, 3))));
}

/** Aligned `key…  value` line; pass key '' to continue the previous value. */
export function kv(key: string, value: string): void {
  // Pad the plain key BEFORE colorizing — ANSI escapes would break alignment.
  // Keys longer than the column get a single separating space instead of
  // colliding with the value.
  const label = key.length < KEY_WIDTH ? key.padEnd(KEY_WIDTH) : `${key} `;
  console.log(`${colorize.gray(label)}${value}`);
}
