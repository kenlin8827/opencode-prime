---
name: adr-context
description: |
  Retrieve architecture constraints and decision rationale for implementation,
  refactoring, or review without reading the entire ADR corpus. Use adr_context
  before opening original ADRs; historical decisions are available on demand.
---

# Bounded ADR evidence

- Call `adr_context` with an ID, domain, or iteration; omit selectors for navigation.
- Use current intent for implementation. Accepted successor decisions take priority
  over a requested superseded source; proposals are not binding constraints.
- Inspect freshness, coverage, issues, and source citations. Follow `next` when
  required constraints remain incomplete; do not claim complete coverage otherwise.
- For a concrete rationale gap, use rationale/history intent and a specific ID.
  Archive references are lookup opportunities, not recursive-read instructions.
  Stop once evidence suffices; one archive hop per request is a ceiling, not a quota.
- A stale CURRENT is not current authority: retrieve original evidence, or suggest
  explicit summary refresh. Do not silently rewrite summaries or trigger paid jobs.
- Do not dump all ADR bodies via read, grep, shell loops, Git, or MCP to bypass the
  controlled entry. A guard block provides recovery instructions, not permission
  to try another reader. Full maintenance/audit requires explicit user scope.
- Preserve constraints when a budget is reached: narrow or continue the query,
  rather than silently dropping evidence. Record unresolved conflicts for the user.
