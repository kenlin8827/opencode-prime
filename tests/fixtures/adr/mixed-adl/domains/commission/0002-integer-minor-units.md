---
style: nygard
status: superseded by ADR-0003
created: 2026-09-02
date: 2026-09-04
layer: domain
iteration: "0.2.54"
domain: commission
---

# 0002. Store ledger amounts as integer minor units

## Context

The commission ledger needs deterministic arithmetic without floating-point drift on money values.

## Decision

We store all ledger amounts as integer minor units and convert only at system boundaries.

## Consequences

Arithmetic is exact and fast, but every consumer must handle minor-unit conversion consistently.
