/**
 * E2E setup detection for `/e2e-adopt` — pure, read-only, minimal.
 *
 * Philosophy (owner ruling 2026-09-22): tech stacks are not fixed, so NO
 * stack table and NO command guessing. A hardcoded probe list is always
 * partial and drifts from reality; the agent reading the adopt report
 * identifies any stack better than a heuristic table ever will. Detection
 * therefore only pre-fills what is genuinely stack-agnostic and stable —
 * conventional e2e directory names — and reports runner configs as hints.
 * The E2E command is ALWAYS left as an {{E2E_COMMAND}} placeholder for the
 * agent (inspect the repo) or the user to fill: detection is a convenience,
 * never a gate, and a wrong pre-fill is worse than an honest blank.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

export interface E2eDetection {
  /** Conventional e2e directory, or null (agent/user fills the placeholder). */
  e2eDir: string | null
  /** Dedicated e2e runner config file — an informational hint for the
   * agent (identifies the runner without guessing any command). */
  runnerConfig: string | null
}

// Directory naming conventions are stable across ecosystems and change
// far less often than build-system commands — safe to enumerate.
const E2E_DIRS = [
  "tests/e2e",
  "test/e2e",
  "e2e",
  "cypress/e2e",
  "playwright",
  "spec/e2e",
  "src/test/e2e",
  "tests/E2E",
]

// Dedicated e2e runner configs are universal markers regardless of the
// surrounding stack (a Rust project can drive playwright; a PHP project
// can run cypress). Reported as hints, never turned into commands.
const RUNNER_CONFIGS = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "cypress.config.ts",
  "cypress.config.js",
  "nightwatch.conf.js",
  "nightwatch.conf.ts",
]

function firstExisting(root: string, candidates: string[]): string | null {
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) return rel
  }
  return null
}

/** Detect the stack-agnostic e2e conventions. Read-only; never throws. */
export function detectE2eSetup(root: string): E2eDetection {
  return {
    e2eDir: firstExisting(root, E2E_DIRS),
    runnerConfig: firstExisting(root, RUNNER_CONFIGS),
  }
}

/** Build the template values from detection. The command is deliberately
 * NOT derived — it stays an {{E2E_COMMAND}} placeholder for the agent or
 * the user to fill with the project's real e2e invocation. */
export function templateValuesFrom(detection: E2eDetection): { e2eDir?: string } {
  const values: { e2eDir?: string } = {}
  if (detection.e2eDir) values.e2eDir = `${detection.e2eDir}/`
  return values
}
