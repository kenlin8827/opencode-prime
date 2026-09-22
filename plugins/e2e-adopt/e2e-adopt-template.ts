/**
 * E2E red-line template — the fill-in-the-blank policy document that
 * `/e2e-adopt` scaffolds into a project.
 *
 * Design (owner decision 2026-09-22, baijiu-shop-inspired): E2E discipline
 * lives in PROJECT DOCUMENTATION, not in a runtime plugin. The template
 * carries the four baijiu-shop elements:
 *   1. Risk-graded three-tier table (lightweight / targeted / full)
 *   2. Confirmation loop — ask before ANY E2E run; explicit request this
 *      turn counts as confirmed; refusal pauses the commit
 *   3. Trigger discipline — E2E is considered only at commit/push time;
 *      code-only requests get lightweight verification, never proactive E2E
 *   4. Coverage mandate — feat/API changes carry proportionate E2E coverage,
 *      committed in the same batch
 * plus a pre-commit checklist and counter-examples.
 *
 * Placeholders `{{...}}` are pre-filled by detection (e2e-adopt-detect.ts)
 * when possible; anything undetected stays literal and is reported to the
 * user for manual fill-in. The doc is the single source of truth after
 * adoption — the project edits IT, not a config switch.
 */

/** Placeholders the render step may leave unfilled. */
export const PLACEHOLDERS = ["{{E2E_COMMAND}}", "{{E2E_DIR}}", "{{CRITICAL_JOURNEYS}}"] as const

export interface TemplateValues {
  e2eDir?: string
}

/** Render the detailed policy doc (docs/e2e-redline.md). The E2E command
 * is ALWAYS the {{E2E_COMMAND}} placeholder — never guessed (stack-agnostic
 * by design); the agent or the user fills it in the doc file itself. */
export function renderRedlineDoc(values: TemplateValues): string {
  const command = "{{E2E_COMMAND}}"
  const dir = values.e2eDir ?? "{{E2E_DIR}}"
  return `# E2E Red-Line Policy (pre-commit)

> Authoritative execution rules for end-to-end testing in this project.
> Adopted via \`/e2e-adopt\` — edit freely; this file is the single source of
> truth. Unfilled \`{{...}}\` placeholders: ask the agent to inspect the repo
> and fill them in, or edit by hand.

## 1. Risk-graded verification (smallest tier that gives real signal)

| Tier | When it applies | What to do |
|---|---|---|
| Lightweight verification | Localized UI / copy / style changes touching no API, persistence, auth, {{CRITICAL_JOURNEYS}}, or state-machine semantics | No E2E. Type-check, lint, targeted unit tests, or manual check as appropriate. |
| Targeted E2E | API contract changes, or focused backend business-logic changes | Run the affected specs: \`${command} ${dir}<spec>\`. Existing coverage MUST run; missing or uncoverable branches MUST be added. |
| Full E2E | Schema / migration, cross-module or cross-service changes, {{CRITICAL_JOURNEYS}} critical journeys, release branches, or when the user explicitly asks | \`${command}\` must pass green before commit. |

Never substitute lightweight verification for the E2E a high-risk change requires.

## 2. Confirmation loop (HARD RULE)

Before starting ANY E2E run (targeted or full), ask the user via the
interactive question tool, stating scope and estimated cost.

- The user explicitly asked to run E2E in the current turn → already confirmed, no need to ask again.
- The user declines → the required E2E is unmet: pause the commit and let the
  user decide. Never skip silently and never proceed to commit.

## 3. Trigger discipline

Consider E2E only when the user asks for commit/push or a \`git commit\` /
\`git push\` is imminent. When the user only asked for a code change, do NOT
proactively run E2E — verify with the appropriate lightweight tier instead.

## 4. Coverage mandate

\`feat\` commits and API changes MUST keep proportionate E2E coverage:

1. Check existing coverage under \`${dir}\` for the touched endpoints /
   journeys; hit specs MUST run per the tier table.
2. No coverage → add a spec under \`${dir}\` covering the normal path plus at
   least one boundary (e.g. invalid input, conflict, permission denied),
   committed in the same batch as the code — never deferred to a later PR.
3. Pure refactors, UI-only, copy, and non-business config changes are exempt
   from new coverage.

## 5. Pre-commit checklist

- [ ] Tier chosen per the table above, with results retained
- [ ] Any E2E: user confirmed via the question tool, or explicitly requested this turn
- [ ] Full E2E (when required): \`${command}\` green
- [ ] feat / API change: proportionate coverage exists and ran
- [ ] feat / API change without coverage: new spec added in the same batch

## Counter-examples (violations)

- Changed business logic but only ran UI-level verification.
- Changed an API without adding E2E coverage.
- Started an E2E run without user confirmation.
- Dismissed a required E2E with "it is too simple to test".
`
}

/** Render the short AGENTS.md red-line section (index row + link,
 * baijiu-shop pattern — details live in the linked doc, not inline).
 * The command is deliberately NOT embedded here: it is single-sourced in
 * docs/e2e-redline.md, so filling it in means editing exactly one file. */
export function renderAgentsSection(_values: TemplateValues): string {
  return `${AGENTS_MARKER_START}
## E2E red line (pre-commit)

| Red line | Rule | Details |
|---|---|---|
| Pre-commit E2E | Risk-graded: lightweight verification for cosmetic changes; targeted E2E for API / business changes; full-suite E2E green before commit for schema / cross-module / critical-journey / release changes (command: see docs/e2e-redline.md). Ask the user via the question tool before ANY E2E run — an explicit request in the current turn counts as confirmed; a refusal pauses the commit. \`feat\` / API changes must carry proportionate E2E coverage, committed in the same batch. | [docs/e2e-redline.md](docs/e2e-redline.md) |

${AGENTS_MARKER_END}`
}

/** Markers framing the adopted section inside the project's AGENTS.md.
 * Idempotent adopt/update and clean manual removal key off these. */
export const AGENTS_MARKER_START = "<!-- e2e-redline:start -->"
export const AGENTS_MARKER_END = "<!-- e2e-redline:end -->"

/** Unfilled placeholders remaining in a rendered text. */
export function unfilledPlaceholders(...texts: string[]): string[] {
  return PLACEHOLDERS.filter((p) => texts.some((t) => t.includes(p)))
}
