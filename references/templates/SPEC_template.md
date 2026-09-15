# Product Specification (SPEC)

> P1 output. Source of truth for downstream stages (P3, P4, P6, P9). The MACHINE block at the end is mandatory and machine-parsed by @ultra for routing. Tech-stack agnostic — only operator outputs.

---

## 1. Requirement (verbatim)

> Paste the user's exact requirement here, word-for-word. No paraphrase. No cleanup. This is the Zero-Loss Raw Passthrough contract.

```
<USER_REQUIREMENT_VERBATIM>
```

## 2. Scope verdict

| Field | Value |
|---|---|
| Scope | `frontend_only` \| `backend_only` \| `fullstack` \| `library_sdk` \| `cli_tool` \| `mobile_app` \| `mini_program` |
| Language | one of the language_stacks card ids, or `<other>` (grow a new card live per stack_schema) |
| Needs perf engineering | `yes` \| `no` |
| Signals hit | <the words in the requirement that drove the scope> |
| Layers activated | <which of L0-1…L0-7 applied> |
| Layers pruned | <which were skipped, with reason> |
| Transforms | <any shape-specific transformations> |
| WOW definition | <the 3+ memorable details this shape demands> |

## 3. Decision tree

> OP-TREE product: walking the load-bearing unknown until leaf nodes are concrete executable decisions. Each layer annotated with source: `user-explicit` | `inferred` | `default`.

```
L1 <load-bearing variable>: <source>
├─ <branch A> : <source>
│   L2 <next variable>: <source>
│   ├─ <leaf>: <executable decision>
│   └─ <leaf>: <executable decision>
└─ <branch B>: <source>
    L2 ...
```

**Leaf-node decisions** (each MUST land in §6 or §8):
- Tech stack with pinned versions
- Persistence choice
- Authentication / authorization model
- Deployment shape
- External dependencies

## 4. Capabilities (Given / When / Then)

> Every capability the user expects. Each row is one acceptance criterion; downstream QC verifies them row by row.

| ID | User story | Given | When | Then | Priority |
|---|---|---|---|---|---|
| C-001 | … | … | … | … | P1 \| P2 \| P3 |

## 5. State machines

> Every entity with lifecycle. List states, legal transitions, terminal states, illegal-transition behavior, concurrent-transition behavior.

### <Entity name>
States: `<s1>` → `<s2>` → … → `<terminal>`
Legal transitions: <trigger> → <target state>
Terminal: <list, with cleanup semantics>
Illegal transition: <system behavior>
Concurrent: <last-write-wins | optimistic-lock | …>

## 6. Interaction / full-state coverage

> Per interaction point, all states defined (tech-agnostic): loading / empty / error / success for visual targets; success / client-error / server-error / timeout / rate-limited / idempotent-retry response spectrum for backend endpoints; help-output / error-output / normal-output / exit-codes for CLI; etc.

| Interaction | Loading/Skeleton | Empty | Error | Success | Special |
|---|---|---|---|---|---|
| … | … | … | … | … | … |

## 7. Boundary & failure behavior

> OP-BOUNDARY × OP-FAILURE product.

| Boundary | Behavior |
|---|---|
| Empty | … |
| Very large (1k+) | … |
| Very long input | … |
| Malicious (XSS / SQL / emoji) | … |
| Concurrent | … |
| Disconnected mid-operation | … |
| Duplicate submit / retry | … |
| External dep down | … |
| External dep slow | … |
| External dep returns dirty data | … |
| Recovery convergence | … |

## 8. Tech selection (tied to decision tree leaves)

| Concern | Choice | Source | Reason |
|---|---|---|---|
| Frontend stack | … | <decision-tree leaf> | … |
| Backend stack | … | <decision-tree leaf> | … |
| Persistence | … | <decision-tree leaf> | … |
| Auth | … | <decision-tree leaf> | … |
| Deployment | … | <decision-tree leaf> | … |
| External libs | … | … | … |

Detail the language_stacks card you matched (toolchain/scaffold/layout/gates/red lines/test surface/deliverable) or grown (if uncovered).

## 9. Engineering floor (non-negotiable)

- Strict typing at the shared module boundaries (per language conventions)
- Build / lint / typecheck / format exit 0
- Secrets in env vars; `.env.example` complete
- Parameterized queries / safe string interpolation at any DB boundary
- Output escaping / safe rendering at any output boundary
- Sensitive fields hashed / encrypted at rest

## 10. Boundaries (out of scope)

> Active cuts. Each row = something the user might expect, deliberately not delivered. Naming these prevents "you forgot X" later.

- <capability>: <why cut>

## 11. Assumptions (auto-adopted if user silent)

> Every inferred decision. Each row is one assumption the user can overturn.

| # | Assumption | Source | If wrong, do … |
|---|---|---|---|
| A-001 | … | inferred / default | … |

## 12. Open questions (max 5; user did not answer)

| # | Question | Recommended default | Why it matters |
|---|---|---|---|
| Q-001 | … | … | … |

## 13. Extension registry (OP-TREE extension_interface)

> Anything that didn't fit the standard scope_adapter. Each row must declare an accompanying verification item (§4 or §6).

| Extension | Layer | Default strategy | Confidence |
|---|---|---|---|
| EXT-001 | <layer> | <strategy> | <0.0–1.0> |

## 14. Delivery checklist (P11 source)

- [ ] Build command exits 0
- [ ] Test command exits 0 (or "N/A — no tests by design" with reason)
- [ ] Lint exits 0
- [ ] README ≤5 steps to run from clean
- [ ] `.env.example` complete
- [ ] Seed/example data rich and demo-worthy
- [ ] No TODO / FIXME / placeholder / "coming soon"
- [ ] No fake mocks masquerading as functionality

---

## MACHINE block (mandatory — @ultra parses this)

```
=== MACHINE ===
SCOPE: <frontend_only | backend_only | fullstack | library_sdk | cli_tool | mobile_app | mini_program>
LANGUAGE: <one of the language_stacks card ids | <other language name lowercase>>
NEEDS_PERF: <yes | no>
DESIGN_REQUIRED: <yes | no>            # yes for frontend_only / fullstack / mobile_app / mini_program; no for backend_only / cli_tool / library_sdk / sql_focused
=== END ===
```
