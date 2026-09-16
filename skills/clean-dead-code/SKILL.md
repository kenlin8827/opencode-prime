---
name: clean-dead-code
description: Dead-code sweep & cleanup - scans uncommitted changes, a commit/range/PR, or the whole project; grades every finding with evidence (R1-R4), reports first, deletes only user-approved items in small verifiable batches, and hands every uncertain finding to the user - never deletes or dismisses on its own judgment. Load ONLY when the user invokes /clean-dead-code.
---

# Clean Dead Code Protocol

You are running an evidence-graded dead-code sweep and cleanup. Governing principle: **deletion is the user's decision; your job is evidence.** Never delete what you merely suspect, never silently dismiss what you cannot prove. A needless question costs one round-trip; a wrong deletion costs code the user wanted.

## What this is NOT

- **Not history surgery.** Cleanup of a landed commit/PR is a *forward* commit on the current branch. Never amend/rebase a target commit — replay belongs to `/git-rebase` / `/git-pick`.
- **Not a review.** Verdicts are reachability-only. Code-quality findings → `/review-fix-loop` / `@code-review`.
- **Not a refactor.** Removing dead code is the only permitted edit; live code stays byte-identical.
- **Not a package manager.** Never install scanners; never edit lockfiles by hand.

## Arguments

- Parse first: a positional token matching no scope and no flag is a focus description (scope `all`). Prose-like input (`last commit`, `清理这个分支`, any verb) or a scope keyword carrying extra words is NOT auto-parsed — present your resolved scope+focus reading and get one confirmation before Phase 0. `<scope> + trailing words` = that scope, focus = the words.
- Natural language may express flag intent too — normalize it into flags within that same confirmation ("只出报告/别动手" → `--report-only`; "R1 的不用问直接删" → `--approve=R1`; "只看依赖" → `--cats=C4`). Execution understands flags only; prose never reaches Phase 0 unconfirmed.
- Positional scope: `changes` (**default**) · `commit <ref>` · `<base>..<head>` · `pr <n|url>` · `all`
- `--focus="<description>"` — limit findings to the code area behind a natural-language description (see Focus mode). With no explicit scope it behaves like free text: scope `all`.
- `--cats=C1,C3` — category filter (default: all)
- `--paths=<glob,...>` — restrict scan area (splits a monorepo `all` run)
- `--exclude=<glob,...>` — extra known dynamic-use zones; per-run only, never written to the exclusions file.
- `--report-only` — stop after the report; no approval, no deletion. Overrides `--approve`.
- `--approve=R1,R2` — pre-approve risk classes for a non-interactive run. **R3 is never pre-approvable.**

## Focus mode

A focus description narrows **what is reported, never what is searched**:

1. **Resolve** — locate the described feature (symbols, modules, docs, `git log --grep`), then present the inferred file/symbol area and get the user's confirmation before scanning. A guessed area is uncertainty — the user decides it, not you.
2. **Candidates** — findings restricted to the confirmed area, combined with scope (`changes` + focus = only the feature's dead code in the uncommitted diff).
3. **Evidence** — unchanged and whole-tree: references from outside the focus area are still live uses. A symbol "dead" inside the area but used elsewhere is not a finding.

`--focus` + `--approve` is a gate collision (an unconfirmed area may never be scanned, and `--approve` promises no prompts): the run emits the area proposal as its report and stops report-only; the user confirms by re-invoking with `--paths=<the proposed area>`.

## Scope semantics

| Scope | Candidate source | Worktree |
|---|---|---|
| `changes` | `git status --porcelain -uall`, `git diff HEAD`, untracked files | dirty allowed; deletions stay uncommitted |
| `commit <ref>` | `git show --format= <ref>` | clean required; ref must be an ancestor of HEAD (Phase 0) |
| `<base>..<head>` | `git diff <base>..<head>` | clean required; `<head>` must be an ancestor of HEAD |
| `pr <n\|url>` | `gh pr view` + `gh pr diff` | clean required; halt only when the PR head's content is absent from the checkout — a merged PR whose head is an ancestor of HEAD proceeds against the current tree |
| `all` | full tree, honoring ignore files | clean required |

Diff scopes MUST search **both directions**:

- **introduced-dead** — symbols/files/deps the change added that nobody uses.
- **orphaned-by-diff** — pre-existing declarations whose last referencer the change deleted: candidates = identifiers in removed hunks that resolve to project-owned declarations (resolve via layer 2, else a declaration grep on the pre-change tree); for each, count references on the post-change tree — zero makes it a finding. Identifiers whose ownership the hunk text cannot resolve go to the report's appendix, never into a guess.

Reporting only one direction is an incomplete run — state it, never pad.

## Taxonomy

| Cat | Covers |
|---|---|
| C1 | Unused declarations — exports, functions, classes, types, private members, params, imports |
| C2 | Unreachable code — statements after a guaranteed exit, constant-false branches, commented-out code blocks |
| C3 | Orphan files/modules — never imported/referenced and not an entry point |
| C4 | Unused dependencies — declared in a manifest, never imported, never named in scripts/config/CI |
| C5 | Dead config & feature flags — option/env/flag keys never read; config values never consumed |
| C6 | Orphan resources — locale keys, assets, templates, helper scripts referenced by nothing |

## Risk classes — the user decides every uncertainty

| Class | Definition | Disposition |
|---|---|---|
| R1 | Certain — no dynamic path can exist by construction (code after `return`, lint-proven unused imports, constant-false branches) | batch approval |
| R2 | Strong — every applicable evidence layer clean AND declaration is module-private / outside any declared public surface | batch approval, evidence attached |
| R3 | Judgment — public exports, possible API surface, test-only references, dependencies, config keys, any unruled-out dynamic suspicion | **per-item (or a group of ≤5 sharing one rationale) user decision** |
| R4 | Protected — entry points, generated/vendored output, published package `exports`/documented API, known dynamic-dispatch targets, exclusion-listed | never deleted; listed in report with keep-reason |

**Tie-break: if R2-vs-R3 is arguable, it is R3. R4 outranks every other class** at file or symbol granularity — an R1-looking statement inside a generated file is R4. *Module-private* = not reachable from outside its compilation/package unit per the language's visibility rules; a language without visibility rules counts its declarations public.

## Phase 0 — Preflight, run-start state & baseline record

| Check | Test | Fail |
|---|---|---|
| Git repo | `git rev-parse --is-inside-work-tree` | halt |
| Run-start state recorded | `BASE=$(git rev-parse HEAD)`; `changes` scope also records the pre-run `git status --porcelain -uall` path set; all recorded into the report | halt if capture fails |
| Scope resolves | ref exists; commit/range: `git merge-base --is-ancestor <head-ref> HEAD` holds; pr: content present per the scope table's halt rule (head SHA, its merge commit, or squash-applied all count); `gh` present and authed | halt, offer alternatives |
| Worktree rule | per scope table | halt — the user commits/stashes; never auto-stash |
| Consumed snapshots pruned | delete each `.ocp/dead-code/snapshots/<ts>/` whose captured paths are all clean vs index/HEAD (lifetime rule — Phase 5) | note pruned count in the report |
| Baseline record | discover the project's verify commands (package.json scripts / Makefile / CI config); run them; capture the pass/fail set at the finest granularity the command emits (per-test lists where parseable, else per-command exit codes + error counts) | cannot discover → ask the user; user declines → mark every later batch `unverified` in the report |

The baseline is a **no-regress contract, not a green gate**: post-deletion must fail no *more* than pre-deletion — at the recorded granularity: any previously-passing item that now fails is a regression. That is what makes a `changes`-scope sweep possible on legitimately-red WIP.

## Phase 1 — Inventory

Build the candidate set before any global text search. `all` scope: per-module inventory first — a whole-tree regex sweep without a candidate list is budget waste, not diligence. Monorepo → propose per-package batches.

Every scope loads `.ocp/dead-code/exclusions.md` first — listed items are R4, not candidates. `.ocp/dead-code/**` is protocol state: never itself a candidate in any scope, and exempt from the worktree-cleanliness gate.

## Phase 2 — Evidence layers

Every candidate MUST pass **every applicable** layer; record what each returned.

1. **Project tools** — dedicated scanners already installed (knip / ts-prune / depcheck for JS-TS, vulture for Python, staticcheck U1000 for Go, rustc `dead_code` for Rust, ...). Never install one. Scanner output is input, not verdict — spot-verify its hits.
2. **Code intelligence** — find-references via an `@explore` dispatch (Serena / CodeGraph / LSP where available; under `@build`, dispatch is the route to structural evidence); structural evidence beats grep.
3. **Text sweep** — symbol name across the whole tree: imports, equal/containing string literals, config keys, route tables, template/DI/annotation usage, reflection patterns (`getattr`, `Class.forName`, computed member access, dynamic `require`/`import`).
4. **Entry/public surface** — package `bin`/`main`/`exports`, script/Makefile/CI targets, codegen & vendor dirs, documented APIs → a hit here means R4.

An inconclusive layer → the finding is R3. A layer that could not run (no LSP, tool absent) is *not applicable*, not *clean* — the remaining layers must carry the verdict.

## Phase 3 — Report (nothing mutates before it exists)

Write `.ocp/dead-code/<UTC>-<scope>[-<focus>].md` — `<UTC>` = `YYYYMMDDTHHMMSSZ`; scope and focus slugified to alphanumerics plus `-`/`_` (`commit-abc1234`, `pr-123` — number only, never the URL); summarize in chat:

```
ID | Cat | file:line | Finding | Risk | Evidence (layers + ref counts) | Recommendation
```

Plus: counts per class, the R4 keep-list with reasons, the baseline record, the unresolved-identifier appendix, and planned deletion batches. **Area** = one package (monorepo) or one directory subtree; every planned batch names its area and its exact paths — the Phase 4 approval covers those boundaries. `--report-only` ends here.

## Phase 4 — Approval

**How asks work:** every user decision in this protocol is blocking — presented via the **question tool**, recommended option FIRST and labeled "(recommended)", never buried in prose while work continues. R3 items: options `delete` / `keep + persist to exclusions` / `keep this run only`; ≤4 questions per tool invocation, items sharing one rationale collapse into one group question. R1/R2 class approvals and every confirmation gate (parse reading, focus area, resume-after-regression, the failure catalog's user-decision rows) follow the same rule. `--approve` pre-answers only R1/R2 class prompts.

1. Present the R1 batch, then the R2 batch (complete list + counts); the user approves or trims each class. Under `--approve=<classes>` those classes skip their prompt — the complete list still ships in the report; R3 items go to the deferred list, never to deletion.
2. R3: one at a time or in a group of ≤5 sharing one rationale ("these 4 devDependencies"). For each — **your recommendation, the why, the risk of deleting if you're wrong, the risk of keeping**. The user's call is final and recorded in the report.
3. A `keep + persist to exclusions` decision writes to `.ocp/dead-code/exclusions.md` (pattern + reason + date) → treated as R4 in later runs until the user edits it. `keep this run only` writes nothing. A trim from an R1/R2 batch is likewise a keep for this run only — it persists only if the user says so.
4. Nothing approved → the run ends report-only; say so plainly.

## Phase 5 — Deletion batches & verification

Order: C2 → C1-intra-file → C1-module-level → C3 → C5 → C6 → C4 (manifest edit) → lockfile regeneration (own commit, via the project's package manager). One category × area per commit; the two C1 commits carry `C1-intra` / `C1-module` in their message; the lockfile commit is `chore: remove dead code (<area>, C4-lockfile)` — the sole rule-8 exception.

**Snapshot** (every batch, every scope, before deleting): copy the current worktree content of each batch-target path — tracked and untracked — to `.ocp/dead-code/snapshots/<ts>/<repo-relative-path>`. A file-copy capture, not `git diff`: a diff-based snapshot silently misses deleted tracked files that carry no WIP edits — the most common batch case.

**Snapshot lifetime = the undo window** — snapshots self-prune, they never accumulate: on a clean scope, once a batch is committed and verified, git owns the undo and its snapshot dir is deleted in Phase 6; on `changes` scope, each later run's Phase 0 deletes every snapshot dir whose captured paths are all clean against the index/HEAD (the user committed or reverted — the undo is consumed). `exclusions.md` and reports are never auto-deleted (audit trail; user's property).

Per batch: snapshot → delete → run the baseline commands → **no-regress** → append the batch's status (done / reverted / pending) to the report → commit `chore: remove dead code (<area>, <cat>)` on clean scopes. `changes` scope: no commits at all — deletions land in the working tree as part of the user's WIP. Stage explicit paths only; never `git add -A`.

A regressed batch → halt the remaining batches; revert it; downgrade affected findings to R3, marked `regressed` in the report (permanent for this run — a later run may re-derive them on fresh evidence); re-present them via the Phase 4.2 mechanics; the user decides whether the remaining planned batches resume. Revert per scope: clean scopes → `git checkout -- <paths>` before commit (or `git revert` after); `changes` scope → first `git diff` the batch paths — if that diff shows changes beyond this batch's own deletions (mid-run user edits), present them via the question tool, proceed-with-copy-back or stop; then copy every snapshot file back to its relative path — recreates deleted files, undoes edits, no git plumbing. A bare `git checkout --` / `git restore` on WIP paths is **forbidden** — it resets to the index, not to the batch-start state. A failed deletion is evidence about your evidence, not something to retry quietly.

## Phase 6 — Summary

On clean scopes, delete **all** of this run's snapshot dirs first — committed, reverted, or skipped: git now owns every outcome (Phase 5 lifetime rule). Then emit the final summary per `## Output format`. Note plainly that code newly orphaned by this run's own deletions (dead imports of a deleted file, dead private callees) belongs to the next run — one pass per wave, never chase transitives mid-batch.

## Hard rules

1. **Report before delete** — no mutation before the Phase 3 report; the user approves every batch.
2. **Uncertain = user's call** — never delete on suspicion, never dismiss silently; R2/R3 doubt resolves to R3.
3. **Evidence per finding** — layers run, ref counts, dynamic-suspicion notes; "the tool said so" is not evidence.
4. **Never rewrite history** — forward commits only.
5. **Never install tools, never touch dependencies** without approval; C4 removals carry their own batch approval.
6. **R4 untouchable** — generated, vendored, entry, public surface, exclusion-listed; R4 outranks every other class.
7. **No-regress baseline** — verified per batch from real command output, at the recorded granularity — unless the user declined the baseline, in which case every batch is marked `unverified`.
8. **Minimal batches** — one category × area per commit, individually revertible (sole exception: the C4 lockfile commit).
9. **Verification honesty** — per `instructions/verification-honesty.md`: paste real output; never claim unverified passes.
10. **Exclusions belong to the user** — user edits to `exclusions.md` override agent judgment; every scope loads them.
11. **Both directions in diff scopes** — introduced-dead AND orphaned-by-diff.
12. **Deletion is the only edit** — no drive-by renames, formatting, or "while I'm here" changes.
13. **Snapshot before batch** — every batch copies its target paths into `.ocp/dead-code/snapshots/<ts>/` first and, in `changes` scope, reverts only from that copy; bare `git checkout --` / `git restore` on WIP paths is forbidden (per `instructions/git-safety.md`).

## Output format

- **Report** — `.ocp/dead-code/<UTC>-<scope>[-<focus>].md`: the Phase 3 findings table, counts per class, the R4 keep-list with reasons, baseline record, unresolved-identifier appendix, planned batches (area + exact paths), per-batch status lines, deferred-R3 (incl. `regressed`) items.
- **Final summary (chat)** — removed per cat/class (LOC, commit list or "left in working tree"), kept with reasons, deferred R3, verification command output quoted verbatim, transitive note (Phase 6), report path.

## Protocol self-check

Run-start `BASE` comes from Phase 0 — no timestamps involved:

```bash
# clean scopes (where commits were made):
git log "$BASE"..HEAD --format="%s" | grep -v "^chore: remove dead code" && echo "UNEXPECTED COMMITS" || echo "OK: only cleanup commits"
git log "$BASE"..HEAD --name-only --format= | sort -u
# the path set above must equal the approved batch paths; any extra path = out-of-scope edit
```

`changes` scope: the current `git status --porcelain -uall` path set must be within (pre-run set ∪ approved paths ∪ `.ocp/dead-code/`); anything beyond = out-of-scope edit. Spot-diff any approved file whose changed-hunk count exceeds its approved findings.

If a check fails: halt the summary, report the discrepancy to the user, offer to revert the offending batch. Never silently ship an unexplained diff.

## Failure catalog

| Symptom | Action |
|---|---|
| Not a git repo / scope ref missing / ref not an ancestor of HEAD / `gh` unauth | halt; name what is missing; offer checkout, `all` + `--paths`, or alternatives |
| PR head content absent from checkout | halt — the user decides to check it out or switch to `commit <ref>` scope |
| Dirty worktree for a non-`changes` scope | halt — the user commits/stashes; never auto-handle |
| Verify commands absent or user declines baseline | continue, mark every batch `unverified`, state it in the report |
| Deletion breaks build/test (any previously-passing item newly fails) | halt remaining batches; revert per scope (snapshot copy-back / `git checkout --`), downgrade findings to `regressed` R3, re-present, user resumes |
| Scanner crashes or times out | record it; fall back to layers 2–4 |
| Flood (>200 findings total) | cap the report at top-50 per category, ordered R3 → R2 → R1 (the R4 keep-list is never capped); propose per-module follow-up runs |
| Zero candidates / empty diff | state it plainly, write the (empty) report, end — never manufacture findings |
| Focus area resolves too broad or too narrow | present the inferred area and its size; the user confirms, narrows, or drops the focus — never scan an unconfirmed guess |
| Argument prose mixes scope words, flag intent, or free text | present the parsed reading (scope + flags + focus), one confirmation before Phase 0 — never guess-parse |
| Session interrupted mid-run | clean scopes: committed batches + per-batch report statuses = safe state; `changes` scope: `.ocp/dead-code/snapshots/` + the report are the recovery state; on re-invocation rerun Phase 0 and continue; the report notes truncation |
| Library-vs-app public surface ambiguous | R3, ask — never default either way |
| Symbol referenced only by its own tests | R3 with three options: delete with tests / keep as test hook / rewire — rewire exits this protocol: record the decision, hand it to the user or `/dev` as a directed edit (rule 12) |
