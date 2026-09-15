# QC Acceptance Report — Round N

> P9 output. Each round is a fresh, isolated `@qa` dispatch — no implementation narrative visible; the verification surface (per stack card's `test_surface`) is QC-exclusive. Derive the project sub-list from `../constitution/quality_acceptance_checklist.yaml` before testing. The VERDICT block at the end is mandatory and machine-parsed by @ultra.

---

## Stance declaration (mandatory first section)

I am the **adversarial QC**. I assume this product has bugs. Finding bugs = my victory; finding nothing = I didn't look hard enough. I never substitute implementation memory for actual testing. Every PASS is backed by a concrete executed command, a read file, or an interaction on the verification surface. Every FAIL cites `file:line` and includes a fix directive. Unsure = FAIL.

## 1. Source of truth

- SPEC: <path>
- DESIGN: <path> (frontend shapes)
- ARCHITECTURE: <path> (backend shapes)
- Quality constitution: `references/constitution/quality_acceptance_checklist.yaml`
- Project root: <absolute path>

## 2. Derived sub-list (derivation map — mandatory before testing)

Per the constitution's `derivation_rules`, expand the spec into concrete check items:

| Rule | Spec source | Derived check items |
|---|---|---|
| capabilities → run each GWT | §4 C-001…C-NNN | <count> items |
| entities → CRUD every op + audit 'intentionally omitted' | <entity matrix> | <…> |
| state machines → every legal transition + sample illegal/concurrent | <lifecycles> | <…> |
| interaction points → manufacture each state's condition | <states table> | <…> |
| boundary tables → empty/huge/long/malicious/concurrent/disconnect/duplicate | <boundary table> | <…> |
| failure matrices → kill dep / cut network / timeout / dirty data / recovery | <failure matrix> | <…> |
| permission matrix → cell by cell + horizontal escalation actually tested | <actor matrix> | <…> |
| EXT nodes → registered acceptance items appear and execute | <extension registry> | <…> |
| decision-tree leaves → implementation matches, no mid-course swap | <decision tree> | <…> |

## 3. Stack gates (run for real; record exit codes)

| Gate | Command | Exit code | Notes |
|---|---|---|---|
| build | <from stack card> | … | … |
| lint | … | … | … |
| test | … | … | … |
| fmt | … | … | … |

## 4. Verification log (9 dimensions)

> One row per check: actual command/output, never a description of what was expected.

### A — Spec conformance
| ID | critical | Check | Method | Result | Evidence |
|---|---|---|---|---|---|
| A1 | ✔ | every capability GWT executed | … | PASS/FAIL | … |
| A2 | ✔ | zero placeholders | … | … | … |
| A3 | ✔ | no fake data masquerading as features | … | … | … |
| A4 | ✔ | core journey end-to-end | … | … | … |

### B — Full-state coverage
| B1 | ✔ | every interaction point's states match spec | … | … | … |
| B2 | ✔ | errors recoverable, no stack traces, no silent failure | … | … | … |
| B3 | — | destructive ops confirm + undo | … | … | … |

### C — Surface quality (per scope transform)
| C1 | ✔ | transformed bar met item by item | per shape's bar (web screenshot / API-vs-docs / help traversal / platform compliance) | … | … |
| C2 | — | professional copy | … | … | … |

### D — Engineering quality
| D1 | ✔ | build/lint/typecheck zero errors zero warnings; runtime clean | … | … | … |
| D2 | ✔ | no dead code | … | … | … |
| D3 | — | layering, naming, no monolith files | … | … | … |
| D4 | ✔ | secrets via env only; no plaintext in repo/artifacts | rg secret patterns | … | … |

### E — Robustness & failure
| E1 | ✔ | boundary table all rows (incl. XSS/SQL/emoji payloads) | … | … | … |
| E2 | ✔ | failure matrix all rows (down/slow/dirty/recovery) | … | … | … |
| E3 | — | extreme data volume without jank | … | … | … |

### F — Security (P8 report cross-check)
| F1 | ✔ | injection immune (parameterized/ORM + output escaping) | … | … | … |
| F2 | ✔ | permission matrix enforced; horizontal escalation rejected | replay as other/no identity | … | … |
| F3 | ✔ | server-side validation; structured errors not crashes | … | … | … |

### G — Performance
| G1 | ✔ | meets spec budget (measured numbers) | … | … | … |

### H — Delivery completeness
| H1 | ✔ | clean env runs in ≤5 README steps | simulate from zero | … | … |
| H2 | ✔ | README complete (intro/capabilities/stack/architecture/steps/env) | checklist | … | … |
| H3 | — | seed data excellent | reset + review | … | … |

### I — WOW (gate: ≥3 PASS)
| W1 | — | value in 5s, first value ≤5 min | timed fresh-user test | … | … |
| W2 | — | ≥3 shape-appropriate wow points | enumerate + experience | … | … |
| W3 | — | one memorable quality detail | third-party view | … | … |
| W4 | — | holds its own vs the DESIGN's named benchmark | side-by-side | … | … |

## 5. Findings detail (only when FAIL)

### F-001 (severity: critical | major | minor)

- **Source**: SPEC §X.Y / DESIGN §Z
- **Location**: `path/to/file.ts:LINE`
- **Expected**: <observable behavior>
- **Found**: <actual behavior + reproduction steps>
- **Root cause**: <why>
- **Fix**: <concrete code snippet or step-by-step change>

## 6. Pruning log (mandatory if anything was skipped)

| Check | Why skipped | Risk if the check was wrong |
|---|---|---|
| … | … | … |

> Any silent skip counts as a false PASS. List it or don't skip it.

## 7. Full re-audit confirmation

Fixes were applied since last round → this round re-audited **everything**, not only fixed items: ☐ confirmed

---

## VERDICT block (mandatory — @ultra parses this)

```
=== VERDICT ===
GATE: <PASS | FAIL>
CRITICAL_PASSED: <int>/<total>
WOW_PASSED: <int>
FAIL_ITEMS:
- <id>: <one-line finding> | fix: <exact file:line + concrete change>
=== END ===
```

Gate rule: all critical PASS **and** WOW_PASSED ≥ 3. `GATE: FAIL` at max rounds → @ultra halts and surfaces this report to the user.
