---
style: nygard
status: proposed
created: 2026-09-06
date: 2026-09-06
layer: domain
iteration: "0.2.61"
domain: audit
parent: ADR-0003
---

# 0004. Record commission events in an audit log

## Context

Regulators require a replayable audit trail of every commission decision and its inputs.

## Decision

Every commission posting emits an immutable audit event that can be replayed verbatim.

## Consequences

Replay and forensic analysis become possible; retention policies and storage budgets must be defined.
