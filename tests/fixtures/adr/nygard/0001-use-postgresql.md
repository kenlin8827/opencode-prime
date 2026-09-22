---
style: nygard
status: accepted
created: 2026-09-02
date: 2026-09-02
layer: system
---

# 0001. Use PostgreSQL as the primary database

## Context

The service needs one durable relational store for transactional data, and the team knows PostgreSQL operations well.

## Decision

Adopt PostgreSQL as the single primary store; revisit sharding only past a single-primary write ceiling.

## Consequences

Strong transactional guarantees and operational familiarity; write scaling must be revisited eventually.
