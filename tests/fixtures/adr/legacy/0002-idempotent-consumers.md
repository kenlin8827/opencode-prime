---
status: proposed
date: 2026-09-05
layer: domain
parent: docs/adr/0001-event-driven-sync.md
---

# 0002. Make all event consumers idempotent

## Context and Problem Statement

Events may be delivered more than once during broker retries and consumer restarts.

## Decision Outcome

Chosen option: dedupe by event ID before side effects run, because retries are guaranteed by the delivery contract.

### Consequences

- Duplicate deliveries are safe; the dedupe store becomes an operational dependency.
