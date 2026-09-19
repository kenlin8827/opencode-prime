---
style: madr
status: accepted
created: 2026-09-01
date: 2026-09-01
layer: system
---

# 0001. Use PostgreSQL as the primary database

## Context and Problem Statement

The service needs one durable relational store for transactional data; the team knows PostgreSQL operations well.

## Considered Options

- **PostgreSQL**: Cons: single-primary writes limit horizontal scale.
- **MySQL**: Cons: the team has less operational experience.

## Decision Outcome

Chosen option: **PostgreSQL**, because operational familiarity outweighs the scale ceiling at the current size.

### Consequences

- **Positive**: one well-understood store; strong transactional guarantees.
- **Negative / Risks**: write scaling must be revisited past a single primary.
