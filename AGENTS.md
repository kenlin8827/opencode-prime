# OpenCode Agent & Development Guidelines (AGENTS.md)

This repo is **OpenCode Prime (OCP)** — a multi-agent configuration suite for [OpenCode](https://opencode.ai). It ships agent prompts, plugins, profiles, and an installer into `~/.config/opencode`. See `DEVELOPING.md` for architecture and contribution details.

---

## 0. Design Principle — Architectural Legitimacy

This is an open-source project: **every design decision must withstand public scrutiny.** Architectural legitimacy outranks implementation convenience.

- **Capability-preserving efficiency** — reduce token cost by removing redundancy, not by weakening outcomes. A feature that impairs correct delivery, verification, or informed judgment is a regression; prefer scoped, on-demand capability over permanent context exposure.
- **Native mechanisms first** — prefer the platform's designed extension points (skills for on-demand disclosure, command files for slash commands, hooks for runtime behavior) over ad-hoc workarounds. A hack that "works" but defies the platform's design is a liability that invites criticism.
- **Refactor over patch** — when a mechanism is structurally wrong (e.g., static prompt injection where on-demand loading belongs), fix the architecture. Do NOT accumulate compensating hacks on top of a flawed foundation.
- **Defendability gate** — refactoring cost never justifies shipping a design the maintainers themselves cannot defend in public. If it would be embarrassing to explain, redesign it before merging.

---

## Cost Red Line — Model Pricing

**Hard cap on every model referenced in shipped configs (per M tokens): input ≤ $3.00, output ≤ $15.00.** Applies to `profiles/**`, `providers/**`, `opencode.template.jsonc`, and any other file that names a `provider/model` ref. Violating models are excluded regardless of capability — e.g. `gpt-6-astra` ($10/$50) and `claude-opus-5` ($5/$25) breach the cap and must not be referenced. Price source: `models.dev` provider catalogs. When adding or re-tiering a profile, verify both rates before committing; an over-cap pick is a build failure. The cap bounds spend, not capability: within the cap, always pick the strongest model for the tier's job — `max` feeds advisor/architect and deep/final `code-review` (review quality is paramount; family profiles must use the family's strongest reviewer even when a cheaper cross-family rival exists), while routine review triage uses the pro-tier `code-review-fast`; `pro` should track the vendor's latest code-specialized model. Price-capability sanity source: the LLM Price–Capability Kill Line (https://mappedinfo.github.io/llm-price-kill-line/) — prefer kill-line frontier survivors; never reference models flagged deprecated there.

---

## Ships vs. Dev-Only

- **Ships** (injected into OpenCode agent system prompts): `instructions/*.md`, `prompts/*.md`, `skills/*/SKILL.md`, plus all files under `plugins/`, `profiles/`, `providers/`. These are the actual prompts users consume — every line costs tokens on every session, forever.
- **Dev-only** (repo tooling, never shipped): `AGENTS.md`, `DEVELOPING.md`, `scripts/`, `docs/`, `install/`, `bin/`. These guide contributors working on this repository and are never injected into a user's OpenCode session.

All rules in this document (token budget, cross-references, release flow) exist to serve the shipped prompts. When you edit `instructions/` or `prompts/`, you are editing what every OpenCode session will load.

---

## License & Dependency Compatibility

OCP is licensed **AGPL-3.0-or-later** (`LICENSE`, SPDX in `package.json`). Dependency rules:

- **Compatible to bundle** (import/ship): AGPL-3.0, GPL-3.0, Apache-2.0, MIT/BSD/ISC/0BSD, MPL-2.0 — keep upstream license notices.
- **Not compatible to bundle** (source-available or non-commercial terms — gitnexus, PolyForm, Elastic/BSL, proprietary): keep as opt-in external integrations behind default-off switches, isolated from shipped code (existing pattern: `gitnexus` in `options.jsonc`).
- Any new shipped dependency MUST state its license in the inline comment where it is wired (`options.jsonc` / `opencode.template.jsonc`).

---

## 1. Language Standards

All source code, agent prompts, instructions, plugin protocols, and contributor guidelines (`AGENTS.md`, `DEVELOPING.md`) must be **100% English**.

User docs are strictly bilingual: `README.md` + `docs/**` (outside `docs/zh/`) = English; `README.zh-CN.md` + `docs/zh/**` = Chinese. Never mix.

---

## 2. Token Budget — Prompt Compression

Prompts follow a **disclosure-layer** model (details: `docs/core/prompt-layers.md`): **L0** = `opencode.jsonc:instructions` (paid every step × every agent — iron rules only, hard budget enforced by `scripts/measure-prompts.ts`); **L1** = rule files assembled into an agent's `prompt` via `{file:}` markers (paid only while that agent runs); **L2** = `skills/*/SKILL.md` (paid only when the agent loads the skill). **Token cost is real money.** Bloated prompts violate the project's core philosophy of efficiency.

### Rules

0. **Pick the layer first** — any new rule **MUST** be placed at the cheapest layer whose violation cost it tolerates: universal iron rule → L0; role rule → L1 (attach in `opencode.template.jsonc` routing matrix); scenario rule → L2 skill.
1. **Instruction files** (`instructions/*.md`) — **MUST** stay under **60 lines**. If a rule needs more, split it into a separate file or compress. Tables over prose, rules over explanations.
2. **Agent prompts** (`prompts/*.md`) — **SHOULD** stay under **120 lines**. Competency lists, hard rules, output format. Cut prose, keep structure.
3. **No redundant explanations** — if a rule says "prefer X over Y", don't follow with 3 sentences explaining why Y is bad. The rule itself is the explanation. RFC 2119 keywords carry weight; trust them.
4. **Examples** — max 1 concise example per rule. If the rule is clear without an example, omit it.
5. **Cross-reference, don't duplicate** — in shipped prompt files (`instructions/*.md`, `prompts/*.md`), if a rule exists in another shipped file, reference it by shorthand (`cp#3` = `coding-principles.md` row 3) instead of restating it. Shorthand is only valid **within one disclosure unit**: the LLM resolves it at runtime only when both files are attached to the same agent prompt. Never use such shorthand in dev-only files (`AGENTS.md`, `DEVELOPING.md`) — token economy only matters for shipped prompts.
6. **Review before merge** — any new instruction or agent file **SHOULD** be reviewed for token economy. If a section can be cut without losing normative power, cut it.

> **Principle**: Every line in a prompt file costs money on every single session, forever. A 200-line instruction file that could be 50 lines wastes 150 tokens × every session × every user. Compress ruthlessly.

---

## 3. Release, Manifest & Packaging

The manifest (`install/versions/<VERSION>.manifest.txt`) is auto-generated from `install/src/manifest.ts` (`SHIPPED_DIRS` + `SHIPPED_FILES`). **Never hand-edit it.** Manifests are **immutable per-version historical records**: `verify.ps1`/`verify.sh` fail if any historical manifest differs from git HEAD (the current version's manifest is exempt — it is the release in progress). Deleting manifests below `minVersion` and rewriting `history.manifest.txt` are the legitimate compaction flow — the gate exempts them.

### Version Bump Steps

1. Bump `version` in `install/version.json` (e.g. `0.7.0`). Raise `minVersion` only when you also want to compact older manifests into `install/versions/history.manifest.txt`. Sync `package.json` `version` + `install/README.md` title.
2. Run `bun run manifest:generate` to regenerate the manifest and compact manifests below `minVersion`.
3. Pre-release gate: `pwsh scripts/pack.ps1 && pwsh scripts/verify.ps1` (or `.sh` variants).

> **Pitfall**: `generate` names its output file after the CURRENT value of `version.json`. Running it **before** step 1 silently overwrites the old version's manifest with today's file tree. Always bump first; if you spot a polluted historical manifest, restore it from the parent commit (`git show <parent>:<file> > <file>`).

### Full Release & Deploy Flow

After version bump, manifest regeneration, and pre-release gate pass:

1. **Merge to main** — `git checkout main && git merge dev-<VERSION>.x --no-ff`
2. **Tag** — `git tag v<VERSION>` (e.g. `v0.7.0`)
3. **Push** — `git push origin main` then `git push origin v<VERSION>` (tag push triggers the Release workflow automatically; `--follow-tags` may not push annotated tags reliably)
4. **GitHub Actions auto-run**:
   - `Release` workflow (triggered by `v*` tag): runs `pack.sh` + `verify.sh`, creates GitHub Release with `tar.gz`/`zip` + `latest` aliases.
   - `Deploy Docs` workflow (triggered by push to `main` with `docs/**` changes): builds VitePress and deploys to GitHub Pages.
5. **Verify** — `gh run list --workflow=release.yml --limit 1` and `gh run list --workflow=deploy-docs.yml --limit 1`; both must show `success`.

> **Pitfall**: `git push origin main --follow-tags` does NOT reliably push lightweight tags. Always push the tag explicitly: `git push origin v<VERSION>`.

### What Ships

- **Auto-discovered** (`SHIPPED_DIRS`): `prompts/`, `instructions/`, `plugins/`, `profiles/`, `providers/`, `skills/` — all files in these dirs ship automatically. Agent prompt fragments ship as `prompts/`, never `agents/`: opencode auto-discovers `agents/*.md` as agent definitions whose frontmatter silently overrides the jsonc `agent` block (verified v1.18.25).
- **Explicit** (`SHIPPED_FILES` in `manifest.ts`): `opencode.template.jsonc`, `tiers.json`, `tui.template.jsonc`, `scripts/serena-workspace-daemon.mjs`.
- `scripts/` is NOT in `SHIPPED_DIRS` — only the one runtime script above is installed; the rest (`pack.*`, `verify.*`, `capture-*.ts`) stays repo-side. New standalone ship files must be added to `SHIPPED_FILES`.
- `install/` and `bin/` are auto-mirrored during packaging.
- **Plugin export contract**: files in `plugins/` are dynamically discovered and loaded by OpenCode. Do not add or restore production exports solely to make unit tests import private helpers: an extra runtime export can change plugin loading behavior. Test through the plugin's exported entry point and registered hooks; if direct helper coverage is essential, move the helper to a non-plugin module with an intentional, documented export contract.
