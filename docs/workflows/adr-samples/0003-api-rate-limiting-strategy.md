---
style: madr
status: accepted
created: 2026-09-18
date: 2026-09-18
layer: system
---

# 0003. API rate limiting strategy for public endpoints

## Context and Problem Statement

The platform is about to open its public Open API to third-party tenants. The gateway currently has no rate limiting, so a single runaway caller can take down shared downstream services (orders, inventory). A gateway-level strategy is needed, under these constraints: quotas must be globally accurate across gateway instances (not per-instance counters); rules are configured per tenant (API key); and the decision itself must stay within the P99 latency budget of 5ms.

## Decision Drivers

- Global accuracy: all gateway instances share one counter; a 3-instance deployment must not triple the quota
- Tenant isolation: independent quotas per API key, no noisy-neighbor effects
- Low latency: the check sits on the hot path and must complete in sub-millisecond time
- Operations cost: the team runs only Redis and PostgreSQL today; no budget for new middleware

## Considered Options

- **Fixed window counter (Redis INCR)**: simplest to build, but can admit 2x burst at window boundaries
- **Sliding window log (Redis ZSET)**: precise, but every request reads and writes a ZSET; memory and latency grow linearly with QPS
- **Token bucket, centrally in Redis (Lua)**: smooths small bursts naturally; one Lua round-trip decides
- **Envoy local rate limit**: no external dependency, but per-instance only — fails the global-accuracy requirement

## Decision Outcome

Chosen option: **Token bucket, centrally in Redis (Lua)**, because it balances global accuracy against sub-millisecond decisions: a single Lua script atomically checks and debits the bucket and smooths bursts by construction. The sliding window log's extra precision only matters for billing-grade quotas, which is not this scenario.

### Consequences

- **Positive**: one Redis round-trip (~0.3ms) per decision; bucket parameters (rate/burst) map directly onto tenant plan semantics
- **Negative / Risks**: Redis becomes availability-critical — the decision script uses a 1s timeout and degrades to "allow + alert" (not reject) when Redis is down; the Lua script needs hash-tag keys to stay cluster-compatible

## Confirmation

Gateway integration tests cover: at 1000 QPS sustained, request 1001 receives 429; load-test reports P99 decision latency under 1ms; fault-injection drills verify the allow-degrade path when Redis is down.

## More Information

The mapping between bucket parameters and tenant plans lives in the billing-side documentation; the Lua script review is archived in PR #482.
