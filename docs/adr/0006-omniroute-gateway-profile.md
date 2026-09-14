---
status: accepted
date: 2026-09-15
layer: component
deciders: ken
---

# 0006 — OmniRoute gateway profile

## Status: accepted

## Context and Problem Statement

OCP ships tiered profiles that map each tier to a concrete model or channel.
This change adds a bundled profile for a self-hosted OmniRoute gateway, a model
router whose `auto/*` channels select a model at request time from health,
quota, cost, latency, and task-fit signals.

Two new shipped files:

- `profiles/router/omniroute-auto.json` — bundled OCP profile mapping the five
  tiers to `omniroute/*` model refs.
- `providers/omniroute.json` — companion provider preset built on
  `@ai-sdk/openai-compatible`, with `baseURL: {env:OMNIROUTE_BASE_URL}` and
  `apiKey: {env:OMNIROUTE_API_KEY}`, listing the gateway's 38 advertised
  `auto/*` channels plus a bare `auto`.

The decision is which channel each tier resolves to, given the gateway's
documented `auto/<category>` grammar and its legacy flat aliases.

## Decision Drivers

- Each tier should resolve to a channel whose engine semantics match that
  tier's role: latency, balanced, quality, reasoning, or vision.
- Where the documented grammar and a legacy alias are engine-identical, prefer
  the documented grammar over the legacy alias.
- The profile must stay portable: env-var configuration only, no deploy-side
  model pinning or fitness overrides.
- A tier's channel must not silently disappear under an operator switch such
  as `hidePaidModels`.

## Considered Options

1. **`auto/best-*` legacy aliases** — engine-identical to the documented
   `auto/<category>` grammar for flash/standard/pro/vision, but the legacy
   names mislead (e.g. `best-chat` resolves to the balanced default) and
   upstream labels the set "legacy flat template". Kept only as an alternative.
2. **`auto/pro-*` aliases** — same variant as `best-*`, but additionally
   flagged paid-tier by `isPaidTierAutoId()`, so they are removed from the
   catalog when an operator enables `hidePaidModels`. Rejected for the
   non-max tiers.
3. **Bare `auto` for standard** — rejected. The gateway documents bare `auto`
   as LKGP-sticky, and on the reference deployment it consistently resolves to
   a free model (`oc/big-pickle`) while `auto/chat` resolves to a stronger
   one. Standard is the high-traffic orchestrator tier, so the sticky-cheap
   route is a downgrade.
4. **`auto/smart` for max** — rejected. Upstream markets it as "smartest", but
   it is the same quality-first weight pack as `auto/coding` plus 10%
   exploration and applies no reasoning-capability filter, so it does not
   distinguish max from pro.

## Decision

The profile maps tiers to channels as follows:

| Tier | Channel | Engine semantics |
| --- | --- | --- |
| flash | `auto/fast` | variant `fast` = ship-fast weights: latency-first |
| standard | `auto/chat` | variant `undefined` = balanced default |
| pro | `auto/coding` | variant `coding` = quality-first weights, taskFit-heavy |
| max | `auto/reasoning:pro` | category `reasoning` = reasoning-capable models; tier `pro` = premium pool |
| vision | `auto/vision` | category `vision` = vision-capable models only |

For four of the five tiers the legacy flat aliases (`auto/best-*`) are
engine-identical to the documented `auto/<category>` grammar, so the profile
deliberately uses the documented grammar rather than the legacy aliases:
names like `best-chat` actually resolve to the balanced default, the legacy
names mislead, and upstream labels them "legacy flat template".

## Consequences

### Positive

- The documented grammar matches upstream documentation and avoids the
  misleading legacy names.
- Each tier's channel matches the tier's role: latency for flash, balanced for
  standard, quality for pro, reasoning for max, vision for vision.
- The profile stays portable: it consumes only `OMNIROUTE_BASE_URL` and
  `OMNIROUTE_API_KEY`, with no deploy-side pinning.

### Negative

- The gateway exposes no channel that combines reasoning filtering with
  quality-first weights. `auto/reasoning:pro` carries no weight bias (the `pro`
  tier only filters the pool by cost class, and both `deepseek-v4-pro` and
  `deepseek-v4-flash` sit in that pool). Consequently `max` is scored by the
  default balanced weights (health/quota/cost/latency dominate; taskFit is
  minor) and was observed resolving to the cheapest premium reasoning model
  (`deepseek-v4-flash`). The ladder `pro <= max` is therefore not guaranteed by
  this profile; fixing it needs a deploy-side `user_override` fitness entry for
  the stronger model or a pinned concrete model id, both out of scope for a
  portable bundled profile.
- `auto/reasoning:pro` is a paid-tier id (`:pro` suffix, and `auto/pro-*`
  likewise): an operator enabling `hidePaidModels` removes it from the
  advertised catalog, so the `max` ref can disappear on such a deployment.
  `auto/fast`, `auto/chat`, `auto/coding`, and `auto/vision` are not paid-tier
  and survive that switch.
- The `vision` tier's correctness depends on the deployment's
  vision-bridge/model-capability plumbing rather than on the profile. On the
  reference deployment, image requests initially 502'd because the vision path
  resolved to a browser-driven provider whose Chromium was missing server-side,
  and only recovered via the gateway's circuit-breaker self-healing (root cause
  unfixed). This is a deployment-side operational dependency, not a profile
  defect.

### Neutral

- The provider preset is OpenAI-compatible and is inert until the operator
  provides the two environment variables.

## Verification

- [Fact] Reviewed the staged `profiles/router/omniroute-auto.json` and
  `providers/omniroute.json`.
- [Fact] The profile maps flash/standard/pro/max/vision to `omniroute/fast`,
  `omniroute/chat`, `omniroute/coding`, `omniroute/reasoning-pro`, and
  `omniroute/vision`, matching the channel ids in the provider preset.
- [Fact] The provider lists the bare `auto` plus 38 `auto/*` channels.
- [Fact] No implementation files were changed for this ADR.

## References

- `profiles/router/omniroute-auto.json`
- `providers/omniroute.json`
