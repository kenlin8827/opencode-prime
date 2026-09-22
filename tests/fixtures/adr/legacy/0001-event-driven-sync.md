---
status: accepted
date: 2026-09-01
layer: system
---

# 0001. Use event-driven sync for cross-service consistency

## Context and Problem Statement

Two services must stay consistent without distributed transactions, and the team has no appetite for a blocking coordinator.

## Decision Drivers

- Availability during network partitions
- Operational simplicity on a two-service fleet

## Considered Options

- **Event-driven sync**: Cons: eventual-consistency windows need reconciliation.
- **Two-phase commit**: Cons: blocking coordinator, poor partition tolerance.

## Decision Outcome

Chosen option: **Event-driven sync**, because partition tolerance outweighs the consistency window at this scale.

### Consequences

- **Positive**: both services stay available independently during outages.
- **Negative / Risks**: reconciliation jobs must be built and monitored.
