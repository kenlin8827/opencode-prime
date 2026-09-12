---
name: handoff
description: Handoff - compact the current conversation into a handoff document so a fresh session can pick up the work. Load ONLY when the user invokes /handoff or asks for a session handoff.
---

# Handoff Protocol

`/handoff [focus]` — compact the current conversation into a structured handoff document so a fresh session can pick up the work seamlessly.

## Your only job

Produce ONE markdown handoff document and tell the user where it is. No coding work, no dispatching subagents, no follow-up implementation.

## Language

Follow `output-protocol.md` §Session language. Preserve frontmatter keys, paths, commands, agent names, and the paste-ready opener format.

## Arguments

- Positional arg (optional): what the NEXT session will focus on. When provided, tailor the document — emphasize the relevant state, decisions, files, and next steps; trim everything unrelated.
- No args: summarize the whole conversation neutrally.

## Steps

1. **Gather state** from the conversation: original goal, decisions made (and rejected alternatives), work completed, current progress, open questions, blockers, and key files touched.
2. **Check git state** — `git status` summary: current branch, uncommitted/unstaged changes, unpushed commits. A fresh session cannot see this conversation; the document must carry it.
3. **Collect artifacts** — specs, plans, ADRs, issues, tickets, commits, diffs, handoff-relevant docs. Reference them by path or URL — NEVER duplicate their content into the document.
4. **Resolve the Handoff storage directory**:
   - **Primary (Recommended)**: `.ocp/handoffs/` in the workspace root (ensure `.ocp/` is git-ignored so it never pollutes repository commits, while remaining visible and browsable in IDE file tree).
   - **Fallback**: OS temp directory when workspace is unavailable or read-only (Windows → `$env:TEMP`, fallback `$env:TMP`; macOS/Linux → `$TMPDIR`, fallback `/tmp`).
5. **Write the document**:
   - Save timestamped snapshot to `<handoff_dir>/handoff-<project>-<YYYYMMDD-HHMMSS>.md`.
   - If written into `.ocp/handoffs/`, also copy or overwrite `.ocp/handoffs/latest.md` as an always-current resume pointer.
6. **Reply** with the absolute path plus a paste-ready opener for the next session.

## Document structure

```markdown
---
timestamp: "<YYYY-MM-DDTHH:MM:SSZ>"
project: "<project-name>"
branch: "<git-branch>"
sdd_phase: "<prd|adr|plan|impl|none>"
dirty_files:
  - "<path/to/file1>"
suggested_agent: "<@code|@plan|@architect|@build>"
suggested_command: "<command to run in next session>"
---

# Handoff — <project> (<YYYY-MM-DD HH:MM>)

## Focus for next session
<the user's focus arg, or "continue where this session left off">

## Where we are
<original goal, current state, git branch + uncommitted/unpushed changes>

## What was done
<completed work, one bullet per item, cite files/commits>

## Decisions made
<decision — why — rejected alternative (one line each)>

## Open questions / blockers
<unresolved items; mark each: needs user input | needs investigation | known trap>

## Key files
<files the next session will need first, with one-line relevance notes>

## Artifacts
<specs, plans, ADRs, issues — path or URL only, no content duplication>

## Suggested agents
<which @agents / slash commands the next session should reach for, and why —
 e.g. "@code for the implementation", "/review-fix-loop last commit before merge">
```

## Hard rules

1. **Git-safe directory only.** Store exclusively in git-ignored `.ocp/handoffs/` or OS temp directory. Never write untracked handoff files into tracked source trees.
2. **Reference, don't duplicate.** Anything already captured in an artifact (spec, plan, ADR, issue, commit, diff) is cited by path or URL, never copied.
3. **Redact sensitive information.** API keys, passwords, tokens, credentials, PII → replace with `<REDACTED: what it is>` and tell the user where the real value lives (e.g., env var name).
4. **Stay compact.** A fresh agent must be able to read the whole document — well under 200 lines. Compression is the point; if the conversation was long, be ruthless.
5. **Be concrete.** Every "next step" cites a file, command, or artifact. No vague "continue working on X".
6. **Rolling retention.** `.ocp/handoffs/` maintains chronological snapshots. If historical handoffs exceed ~30 files, older snapshots can be pruned while preserving `latest.md`.
7. **End the reply with a paste-ready opener** for the next session:

```
Read <absolute path to handoff doc or .ocp/handoffs/latest.md> and continue from there.
```
