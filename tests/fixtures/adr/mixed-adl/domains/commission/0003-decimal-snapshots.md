---
style: madr
status: accepted
created: 2026-09-05
date: 2026-09-05
layer: domain
iteration: "0.2.61"
domain: commission
parent: ADR-0001
supersedes: ADR-0002
---

# 0003. Store ledger amounts as decimal snapshots

## Context and Problem Statement

Integer minor units push currency conversion complexity into every read path, and rounding bugs keep resurfacing in reports.

## Decision Outcome

Chosen option: **Decimal snapshots**, because read-path correctness outweighs the extra storage cost.
