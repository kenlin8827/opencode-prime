---
style: nygard
status: accepted
created: 2026-09-03
date: 2026-09-03
layer: domain
domain: billing
---

# 0005. Process Stripe webhooks with idempotent handlers

## Context

Stripe delivers each webhook more than once, and duplicate processing double-charges customers.

## Decision

Every handler is idempotent: webhook events are deduplicated by event ID before side effects run.

## Consequences

Duplicate deliveries are safe; the dedupe store becomes a new operational dependency.
