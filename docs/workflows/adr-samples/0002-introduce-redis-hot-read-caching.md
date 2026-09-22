---
style: nygard
status: accepted
created: 2026-09-18
date: 2026-09-18
layer: system
---

# 0002. Introduce Redis for hot-read caching

## Context

Order-detail and product-page read traffic amplifies roughly 8x during promotions and lands entirely on the PostgreSQL primary; P99 latency degrades from 40ms to 600ms at peak. Read replicas only partially absorb the load because hot product rows concentrate on a single replica. The team knows PostgreSQL operations well but runs no dedicated cache tier. The business tolerates seconds-level staleness for product/order snapshot reads, but prices on the checkout path must always come from the authoritative store.

## Decision

Adopt Redis as a hot-read cache for staleness-tolerant read models (product details, order snapshots) using Cache-Aside: 60-second TTL plus active invalidation on the write path. Strong-consistency paths — checkout, payment, price changes — always query PostgreSQL directly and never go through the cache.

## Consequences

Hot-read pressure shifts from the database to Redis, with P99 expected to return under 100ms; strong-consistency semantics are unchanged, with no dual-write or distributed locking. The cost is one more stateful component: memory eviction policy, single-flight protection against cache stampede, and a stale-read window when a write succeeds but invalidation fails (bounded by the 60-second TTL).
