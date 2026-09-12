# Review: ADR-0004 `.opencode/` → `.ocp/` path contract (final gate)

- Baseline: `0e00812..8d43eda` (11 commits, ~90 files)
- Tier: L3; reviewers: @architect + @code-review-fast (per-phase L2), @codegraph-scout, @code-review ×3 (final gate rounds)
- Verdict: Cleared

## Findings

- P0 — `plugins/tui/project-wizard.ts` — wizard detected switches BEFORE migration, then save clobbered migrated values with defaults (root-`opencode.json` carriers unrecoverable). Fixed: migrate-at-open, before detect (c0dfdfb) + order Check in `tests/test-all.ps1` proven fail-on-pre-fix (e76b31c).
- P1 — `install/versions/0.34.0.notes.md` — ADR-MUST migration note missing + stale `.opencode/memory/` paths. Fixed (95344de).
- P1 — `plugins/project-manager/project-manager-scaffold.ts` / `plugins/shared/opencode-prime.ts` (phase-2 round) — wizard-append missing separator comma corrupted `.ocp/ocp.json`; migration deactivated legacy keys despite failed copy; unescaped value interpolation; six stale i18n path strings. All fixed in 275e5d1 (rounds 3–4), string-aware `lineCommentStart` + span-excision re-verified.
- P1 — `install/src/installer.ts` (phase-3 round) — rename targeted `OPENCODE_CONFIG_DIR` base while runtime resolves XDG-aware dir → silent skip for XDG users. Fixed: runtime-dir-first precedence + wrong-base rescue (92915fe).
- P2 — `tests/test-all.ps1:617,:707` — operand-lost `Check` expressions from the phase-4 sweep made the structural harness unparseable (dead gate). Repaired (e76b31c).

## Verification

- `bun x tsc --noEmit` → pass (0 errors)
- `bun tests/test-*.ts|tsx` ×60 → pass (all exit 0; incl. inverted write-new pins + B1 chain pin §16)
- `bun test installer herdr` → pass (0 fail)
- `pwsh tests/test-all.ps1` → pass (full run: "ALL TESTS COMPLETE", sections Failed: 0, exit 0; orchestrator-executed)
- `node --check scripts/serena-workspace-daemon.mjs` → pass
- Not run: `-IncludePrompts` section (needs LLM API) — pre-existing exclusion.

## Decision and residual risk

Contract: `.ocp/` is 100% OCP (single-path runtime reads, strict-JSON `ocp.json`, `OCP_PROJECT_DIR` project-relative override), `.opencode/` stays 100% platform, no runtime legacy reads — one-shot idempotent migration runs at wizard open / `/project init` / `/project sync`, installer auto-renames global `ocp.jsonc`. Residual: users who upgrade and never trigger migration read defaults (accepted by design, release-noted); downgrade is lossy; `.ocp/ocp.json` order-pin in test-all.ps1 is literal-coupled (fail-closed by design); global dotfiles (`.deepseek-anchor-enabled`, `.active-profile`) intentionally not folded into `ocp.json` (ADR open question 1).
