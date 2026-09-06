# Five Dev Flows

Five Dev Flows represent the flagship multi-agent workflow system in OpenCode's production engineering configuration.

Each flow embodies a **development philosophy** — a distinct trade-off between speed, depth, autonomy, and risk posture. Choose based on the nature of your task, not a linear "better/worse" hierarchy.

The three linear flows (`/dev-quick`, `/dev-plan`, `/dev-review`) are implemented as **presets over one [`/dev`](dev.md) compositor engine** — each expands to a flag set on `/dev`. `/dev-prud` and `/dev-ultra` remain standalone protocols (different topologies). Invoke `/dev` directly when no preset matches.

---

## The Five Flows at a Glance

| Flow | Emoji | Philosophy | When to Use |
|---|---|---|---|
| `/dev-quick` | ⚡ | **Zero-friction** — flash-tier coder, code now, review optional | Throwaway scripts, UI tweaks, quick prototypes |
| `/dev-plan` | 📋 | **Plan-first** — clarify, plan, then implement (review optional) | Daily default: features where you want to approve the plan before coding |
| `/dev-review` | 🧠 | **Deep consensus** — dual flagship review + arbitration | 20% mission-critical: distributed transactions, full-stack, security-sensitive |
| `/dev-prud` | 🛡️ | **Risk-first** — FMEA before code, risk register drives everything | Safety-critical: payments, auth, medical, aviation, anything a bug could harm |
| `/dev-ultra` | 🛸 | **Autonomous** — objective in, phases out, zero interaction | Large-scale systems spanning multiple domains and phases |
| [`/dev`](dev.md) | 🧩 | **Composable — bring your own pipeline** | Compositions no preset covers: `--plan --code-review=2 --qa`, `--sdd="adr,plan"` |

---

## Flow Details

### `/dev-quick` — Zero-Review Fast Track

```
User → @build → @fast-coder (Flash) → Done
```

- **Review**: None by default; `--review` triggers single audit
- **Rounds**: 1 (instant)
- **Model**: Flash/Lite tier for maximum throughput
- **Not for**: Zero-ceremony at full quality — just ask directly (`lite` → `@code`); no workflow needed
- **Alias**: `/dev-flash`

### `/dev-plan` — Plan-First Development

```
User → @build → @advisor (clarify) → @architect (plan) → confirm → @<lang>-dev (implement) → optional tiered review → Done
```

- **Phases**: Clarification → Plan → Confirm → Implement → [Optional Review]
- **Review**: None by default; `--review` uses `@code-review-fast`, escalating to max `@code-review` for L3/final gates (max 5 rounds)
- **Exit**: Plan confirmed + implementation delivered (review passed if `--review`)

### `/dev-prud` — FMEA Risk-First Development

```
User → Socratic Clarification → FMEA Risk Register → Risk-Driven Plan → Implementation → Register-Audited Verification
```

- **Core**: Pre-implementation risk enumeration (SEV × PROB ranked, top-N)
- **Review**: Configurable (0, 1, or 2 reviewers — risk register drives the bar)
- **Exit**: All top-N risk mitigations verified in register
- **See**: [Prudent Development](dev-prud.md) for full protocol

### `/dev-review` — Dual-Review Deep Consensus

```
User → @build → @<lang>-dev → @architect (Review A) + @code-review-fast (Review B) → @advisor arbitration → max @code-review final gate → Consensus
```

- **Review**: `@architect` + `@code-review-fast`, followed by max `@code-review` final gate
- **Coder**: Domain-routed (`@<lang>-dev`)
- **Arbitration**: `@advisor` resolves disagreements under Safety-First principles
- **Rounds**: Max 10 (typically 3–5)
- **Exit**: Dual-reviewer consensus

### `/dev-ultra` — Autonomous Multi-Phase Execution

```
User → Objective → @build decomposes → Phase 0: @explore → Loop[Phase 1..N: code + tiered review] → max final gate → Final verify
```

- **Review**: L1/L2 use architect + fast review; qualifying L3 phases use the deep route; one max final gate
- **Autonomy**: High — user gives objective, orchestrator drives all phases
- **Phases**: Default 6 (3–6 recommended; compaction extends to 8–10)
- **Stop**: Consecutive phase fuses ≥ 3, files > 100, external dependency unavailable
- **Resume**: `--resume` from `.opencode/dev-ultra-state.md`

---

## Selection Guide

```
                    Is it a large-scale objective
                    spanning multiple domains?
                   /                          \
                 Yes                           No
                 /                              \
           🛸 /dev-ultra               Could a bug cause harm
           (autonomous)                to people or business?
                                     /                        \
                                   Yes                           No
                                   /                              \
                            🛡️ /dev-prud                  Is it mission-critical
                            (risk-first)                   (distributed TX, full-stack)?
                                                           /                      \
                                                         Yes                                                         No
                                                         /                                                          \
                                                   🧠 /dev-review                                           Is plan approval
                                                   (dual-review)                                           desired before coding?
                                                                                                           /              \
                                                                                                           Yes                No
                                                                                                           /                    \
                                                                                                     📋 /dev-plan          ⚡ /dev-quick
                                                                                                     (plan-first)         (zero-friction)
```

---

## Comparison Matrix

| Dimension | ⚡ `/dev-quick` | 📋 `/dev-plan` | 🧠 `/dev-review` | 🛡️ `/dev-prud` | 🛸 `/dev-ultra` | 🧩 `/dev` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Philosophy** | Zero friction | Plan-first | Deep consensus | Risk-first FMEA | Full autonomy | Composable — bring your own pipeline |
| **Use Cases** | Throwaway scripts, UI tweaks, quick prototyping | Daily default: features where plan approval matters | 20% mission-critical: distributed TX, full-stack, security | Safety-critical: payments, auth, medical, aviation | Large-scale systems spanning multiple domains | Compositions no preset covers |
| **Host Agent** | `@build` | `@build` | `@build` | `@build` | `@build` | `@build` |
| **Coder Agent** | `@fast-coder` | `@<lang>-dev` (domain-routed) | `@<lang>-dev` (domain-routed) | `@<lang>-dev` (domain-routed) | `@<lang>-dev` per phase | `@fast-coder` or `@<lang>-dev` (flag-deterministic) |
| **Review Team** | None (optional `--review`) | None (optional `--review`) | `@architect` + `@code-review-fast` + max `@code-review` final gate | Configurable (risk-driven) | 2 per phase | 0 / 1 / 2 by flag |
| **Pre-Implementation** | None | Socratic clarification + plan | None | FMEA Risk Register | `@explore` survey | Optional plan / SDD by flag |
| **Arbitration** | None | Plan-confirmation gate | `@advisor` (Safety-First) | Risk-register-driven | `@advisor` per phase | `@advisor` (with `--code-review=2`) |
| **Convergence** | 1 round | 1 round (+ max 5 if `--review`) | Max 10 rounds | Register audit | Max 10 rounds/phase | `--max-rounds` by flag (default 5) |
| **Autonomy** | None | Low (plan gate) | Low | Low | High | Low |

---

## Dynamic Domain Persona Injection

All flows that involve coding (`/dev-quick`, `/dev-plan`, `/dev-review`, `/dev-prud`, `/dev-ultra`, and `/dev` compositions) leverage **Dynamic Domain Persona Injection**:

1. **Stateless Container**: `@fast-coder` is bound to the fast Flash/Lite model tier, maintaining maximum throughput (used by the `/dev-quick` preset and bare `/dev` with zero depth flags);
2. **On-the-Fly Persona Enchantment**: Orchestrator `@build` detects the technical stack and injects specialized domain guidelines into the prompt header:
   - **Frontend**: Strict TS (no `any`), atomic Tailwind, no wasteful re-renders, A11y standards;
   - **Go**: Explicit error handling, context propagation, goroutine leak prevention, zero panics in hot paths;
   - **Python**: Pydantic/Type Hints, `asyncio` concurrency, `with` resource cleanup, PEP8;
   - **DBA**: Leftmost prefix index matching, non-blocking migrations, parameterized queries;
3. **Parallel Multirole Execution**: Subagents operate in isolated sessions, allowing `@build` to dispatch multiple domain specialists in parallel (e.g. Frontend + Backend concurrently).

---

## Usage & Arguments

### `/dev-quick` (Zero-Review, Optional Review)

```bash
/dev-quick Add copy button to code blocks with toast feedback
/dev-flash Fix off-by-one error in pagination query  # alias
/dev-quick Add dark mode toggle --review  # with single audit
```

### `/dev-plan` (Plan-First, Optional Review)

```bash
/dev-plan Implement user avatar upload and crop component
/dev-plan Optimize order pagination query --review  # plan + single-review audit
/dev-plan Add payment webhook handler --review --max-rounds=5
```

### `/dev-prud` (Risk-First)

```bash
/dev-prud Implement payment settlement with idempotency guarantees --top=5
/dev-prud Add OAuth2 PKCE flow for mobile app --top=3 --max-rounds=8
```

### `/dev-review` (Dual-Review)

```bash
/dev-review Refactor settlement engine with distributed transaction compensation
/dev-review Implement QR-code login: session table, polling API, dialog --max-rounds=10
```

### `/dev-ultra` (Autonomous Multi-Phase)

```bash
/dev-ultra Implement a complete user authentication system with OAuth2, session management, and RBAC
/dev-ultra Build real-time notification service: WebSocket, queue, SDK, dashboard --max-rounds=8 --max-phases=10
/dev-ultra --resume
```

### `/dev` (Compositor — no preset matches)

```bash
/dev Implement webhook retry with exponential backoff --plan --code-review=2 --qa
/dev Add multi-tenant row-level security --sdd="adr,plan"
/dev Tighten the CSV parser edge cases --qa
```

---

## Guardrails & Anti-Lock Mechanisms

| Guardrail | Applies To |
|---|---|
| **Safety-First Arbitration** | `/dev-review`, `/dev-ultra`, `/dev-prud` (when dual-review enabled) |
| **Plan Confirmation Gate** | `/dev-plan` |
| **10-Round Fuse** | All flows with review (per phase for `/dev-ultra`) |
| **Consecutive Fuse Stop** (≥ 3) | `/dev-ultra` |
| **Max-Phases Cap** (default 6, max 20) | `/dev-ultra` |
| **Context Compaction** | `/dev-ultra` (every 2 phases) |
| **Per-Phase Diff Isolation** | `/dev-ultra` (one git commit per phase) |
| **Risk Register Audit** | `/dev-prud` (all top-N mitigations verified) |
