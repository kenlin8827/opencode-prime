---
status: accepted
date: 2026-09-11
layer: system
deciders: ken
---

# 0003 — `@dietrichgebert/ponytail` removed from OCP entirely

## Status: accepted (revised 2026-09-11 — strengthened from opt-in to full removal)

The original draft of this ADR proposed flipping `@dietrichgebert/ponytail` to opt-in. After further review (same day), the stronger decision was taken: remove the npm dependency entirely and fold the only non-redundant bit of ponytail's behavior (the "after completing, consider a simpler YAGNI-aligned alternative" forcing function) into our own agent prompts. The shipped change is the **full removal + self-hosted forcing function**. This ADR supersedes the opt-in draft that existed for several hours of the same day.

## Context and Problem Statement

OCP shipped `@dietrichgebert/ponytail` as a default-on npm plugin (entry in `opencode.template.jsonc:plugin`, `install/options.jsonc:plugin['@dietrichgebert/ponytail'] = true`). The plugin's framing — "build what was asked, then name the lazier alternative in one line" — promotes "laziness" as a positive engineering value and surfaces simplifications under that framing.

Two layered concerns motivated this ADR:

1. **Direct conflict with `cp#10`**: The `cp#10` design principle (`Top-tier floor + YAGNI discipline`) rejects rationales that bypass the top-tier engineering floor (correctness / security / testability / type safety / error & edge-case handling; maintainability / defensibility / platform-native design / simplicity) under any "do less" framing. Ponytail's "lazier alternative" framing is exactly the rationalization pattern `cp#10` rules out.
2. **Architectural sovereignty**: OCP's own prompt stack (`cp#10`, `prompts/architect.md:38`, `prompts/code-review.md:27`, the `cp#7` no-premature-abstraction rule) already covers YAGNI, SOLID, KISS, and DRY. A third-party npm package imposing its own "what good code looks like" framing on the agent's design process is an external constraint on architectural decisions the project should own. **Architectural decisions should not be limited by an external plugin.**

## Decision Drivers

- `cp#10` (Top-tier floor + YAGNI discipline) — principle recorded in `AGENTS.md` §0 and `instructions/coding-principles.md`
- **Defendability gate** — design must withstand public scrutiny
- **Architectural sovereignty** — design principles live in the project (AGENTS.md, `cp#N`), not in a third-party npm package
- **SOLID + YAGNI are general programming principles** — they belong in our own prompts, not in a plugin that injects "lazy coding" framing
- **No marginal value** — ponytail's only non-redundant contribution (the "consider simpler alternative" forcing function) can be expressed in two lines of our own agent prompt text, with no token-cost ruleset block and no third-party dependency

## Considered Options

1. **Keep ponytail default-on, reframe it as "YAGNI-scoped"** — rejected. Reframing the docs does not change the npm plugin's actual behavior or its rationalization-framing output.
2. **Flip to opt-in (default off)** — initially accepted, then superseded. Rejected as the final state because: (a) shipping an opt-in plugin is still shipping the rationalization framing into the package surface, just behind a switch; (b) Defendability gate still requires defending "why is this shipped but disabled" — and the honest answer is "no good reason"; (c) any user who actively opts in re-introduces the exact `cp#10` conflict the project just disclaimed.
3. **Remove ponytail entirely; fold the forcing function into our own agent prompts** — chosen. Eliminates the third-party npm dependency, the rationalization framing in the package surface, and the Defendability-gate liability. The forcing function moves into the agent's own operating protocol — a one-line addition to `prompts/code.md` and `prompts/lite.md` that captures ponytail's only non-redundant contribution.

## Decision

`@dietrichgebert/ponytail` is **removed from OCP entirely**:

- `package.json` — `@dietrichgebert/ponytail` removed from `dependencies`; `bun.lock` regenerated accordingly
- `install/options.jsonc` — ponytail entry removed from the `plugin` map (the map no longer carries it as an option)
- `install/src/i18n.ts` and `install/locales/{en,zh-CN}.json` — ponytail entry removed from `pluginLabels`
- `install/README.md` — example config no longer references ponytail
- `opencode.template.jsonc:plugin` — already empty (was set during the opt-in draft); headroom MCP comment updated to drop the "ponytail supplements rtk on output" claim
- `plugins/lite-mode/lite-mode.ts` — `PONYTAIL MODE ACTIVE` / `# Ponytail` strip logic removed (dead code, no third party injects the block anymore)
- `DEVELOPING.md` — "5. Ponytail protocol" section removed; architecture tree no longer names ponytail; npm-plugin bullet no longer mentions it as an opt-in default
- `docs/workflows/plugins.md` (and ZH) — ponytail row removed from the external NPM plugins table
- `docs/maintenance/options.md` (and ZH) — example `plugin` map no longer includes ponytail
- `docs/core/mcp-servers.md` (and ZH) — "rtk covers the output side, ponytail supplements it" reverted to "rtk covers the output side"
- `tests/test-all.ps1` — `plugin does NOT include ponytail` check removed (no longer relevant: the plugin isn't shipped at all); `ponytail/config.json` env-dependent check removed (no third-party config to assert against)
- `tests/test-lite-mode-unit.ts` — `stripLiteOverhead — ponytail block` section removed (the strip logic it covered is gone)
- `tests/README.md` — ponytail behavioral test descriptions removed

The forcing function is folded into `prompts/code.md` step 4 (Implement) and `prompts/lite.md` Editing-code line:

```
Before finalizing, briefly consider a YAGNI-aligned simpler path — an alternative
that drops only work genuinely unneeded for the stated goal — and name it in
the report if obvious; skip for trivial changes. (`cp#10` floor still applies.)
```

This preserves the one non-redundant bit of ponytail's behavior (the "after completing, briefly consider an alternative" forcing function) in our own prompt text — no token-cost ruleset block, no third-party framing, no Defendability-gate liability.

## Consequences

### Positive

- The third-party npm dependency is gone — `package.json`, `bun.lock`, and the install graph are leaner.
- The rationalization framing ("lazy coding") no longer exists anywhere in the OCP package surface.
- Defendability gate is fully restored — no embarrassing "why is this shipped" surface area.
- Architectural sovereignty: design principles live in `AGENTS.md` and `cp#N`, where they belong.
- Forcing function is preserved via two lines of our own prompt text — no behavior loss for the one non-redundant bit ponytail contributed.
- Token cost: the ponytail ruleset block is no longer injected into any session, lite or otherwise; lite-mode's strip logic is dead code and is removed.

### Negative

- Existing users who manually configured ponytail (via npm install + opencode.jsonc edit outside OCP) will see it disappear from the prompt surface after upgrading. Mitigation: the release notes and CHANGELOG must call this out as a behavioral change. The npm package itself is still on the public registry; users who really want it can install it themselves and wire it into their own opencode.jsonc — they just no longer get OCP's framing or the lite-mode strip.
- The `ponytail/config.json` env-dependent test (which only ran on machines where the user had opted in) is removed — net positive (no test to maintain) but reduces the test surface that previously caught ponytail-block regressions. The strip logic that test covered is also gone, so there is nothing left to regression-test.

### Neutral

- `cp#10` is unchanged; the YAGNI framing remains the gate for adopting any "simpler" alternative the agent surfaces.
- `prompts/architect.md:38`, `prompts/code-review.md:27`, and `instructions/coding-principles.md` row 7 (no premature abstraction) already encode SOLID + YAGNI + KISS at the architectural and review tiers — the gap ponytail previously filled at the implementation tier is now filled by the in-prompt forcing function in `code.md` / `lite.md`.

## References

- `AGENTS.md` §0 — Architectural Legitimacy (Top-tier engineering floor bullet)
- `instructions/coding-principles.md` row 10 — Top-tier floor + YAGNI discipline (`cp#10`)
- `prompts/code.md` step 4 — YAGNI-aligned simpler-path self-review
- `prompts/lite.md` Editing-code line — YAGNI-aligned simpler-path self-review
- `prompts/architect.md:38,46` — YAGNI at the architecture tier
- `prompts/code-review.md:27` — SOLID + DRY/KISS/YAGNI at the review tier

## Confirmation

This ADR accompanies a `refactor` commit (or its equivalent in the merged commit series). The `adr-guard` plugin's iron law (`plugins/adr-guard/adr-guard-protocol.md`) is satisfied by this ADR landing in the same commit as the removal + forcing-function merge.
