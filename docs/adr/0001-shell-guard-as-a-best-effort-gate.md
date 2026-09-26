---
style: madr
status: accepted
created: 2026-09-26
date: 2026-09-26
domain: security
---

# 0001 · Shell Guard as a best-effort confirmation gate

## Context and Problem Statement

Analysis and review agents need shell access for repository inspection and checks, but broad shell permission is not read-only: commands can modify files or execute arbitrary programs. A command-pattern hook can prompt for selected known risks, but it cannot parse every shell dialect, wrapper, or command composition and is not an execution sandbox.

## Decision Outcome

Chosen option: retain shell access for the configured analysis/review agents and use Shell Guard to turn a maintained list of high-risk command patterns into permission asks. This is an ergonomic, best-effort confirmation gate—not a security boundary. Commands outside the list remain permitted under the agent's shell permission; role prompts such as “read-only” are behavioral guidance, not enforcement.

**Positive**: repository inspection and review can use native shell without prompting on every command; selected destructive operations receive a reasoned confirmation prompt.

**Negative / Risks**: an unlisted or obfuscated command can still modify data, execute programs, or access the network. `edit: deny` does not constrain shell side effects. Users must treat these agents as having shell capabilities, not as sandboxed readers.

### Confirmation

The Shell Guard unit tests verify configured patterns become permission asks and native denies remain intact. They do not establish complete shell-command coverage or sandboxing.
