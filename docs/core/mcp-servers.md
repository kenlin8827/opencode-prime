# MCP Servers (Code Intelligence & Database)

Model Context Protocol (MCP) provides structured, token-efficient semantic code retrieval and universal database access.

---

## Why integrate MCP? (Core Significance & Design Philosophy)

Traditional AI coding assistants rely on blind text searching (`grep` / `glob`) and bulk file reads to understand codebases. For non-trivial repositories, this pattern suffers from severe bottlenecks:
1. **Context Window Saturation & High Token Cost**: Tracing a multi-step call chain often requires reading dozens of files, quickly bloating context tokens, degrading reasoning quality, and driving up API costs.
2. **Lack of Structural Global Awareness**: Text grep cannot understand AST syntax trees, polymorphism / dynamic dispatch, interface implementations, or multi-hop call paths. As a result, agents easily overlook the **blast radius** (downstream breakages) of a change.
3. **Database Hallucination & Trial-and-Error**: When dealing with databases, LLMs frequently hallucinate table or column names, leading to SQL execution errors and wasted roundtrips.

To eliminate these bottlenecks, this configuration integrates a **tiered Code Intelligence & Database Gateway matrix** via the **Model Context Protocol (MCP)**:

```
                               ┌────────────────────────────────────────────────────────┐
                               │               OpenCode Agent Team                      │
                               └───────┬─────────────────┬────────────────────┬─────────┘
                                       │                 │                    │
              ┌────────────────────────┴────────┐ ┌──────┴───────────────┐ ┌──┴─────────────────────────┐
              │      Symbol-Level (Real-time)   │ │  Macro Graph & Architecture│ │   Universal Database Gateway  │
              │         (Symbol Layer)          │ │       (Graph Layer)   │ │      (Database Layer)         │
              ├─────────────────────────────────┤ ├───────────────────────┤ ├─────────────────────────────┤
              │ Serena MCP (Live LSP)           │ │ CodeGraph / GitNexus  │ │ DBHub MCP (Bytebase)        │
              │ • find_symbol                   │ │ • codegraph_explore   │ │ • search_objects (Metadata) │
              │ • find_referencing_symbols      │ │ • Call paths / Impact │ │ • execute_sql (Read-only)   │
              │ • get_symbols_overview          │ │ • Cross-file overview │ │                             │
              └─────────────────────────────────┘ └───────────────────────┘ └─────────────────────────────┘
```

- **Precise Symbol Inquiries → Serena (LSP)**: Exact definitions, references, and symbol outlines. Zero indexing wait, minimal payload, returns only what's asked without bloating the context.
- **Architectural Understanding & Impact → CodeGraph / GitNexus**: "How does component X work?", "What breaks if I change this function?" — single-call responses covering complete call flows and blast radius. In tiered review, the capability-selected Scout is the only graph consumer: it compresses bounded relationship evidence for the deep reviewer.
- **Reliable Data Exploration → DBHub**: Enforces discovering real schema (`search_objects`) before running queries (`execute_sql`), preventing hallucinated table/column names.

---

## Built-in MCP Servers Overview

| Server | Type | License | Core Tool | Best For | Lifecycle & Indexing |
|---|---|---|---|---|---|
| **Serena** | Live LSP Semantic Engine | MIT | `find_symbol`, `find_referencing_symbols`, `get_symbols_overview` | Precise symbol lookups: definitions, references, file outlines (zero hallucination) | Connects live to LSP upon session start; **no** pre-indexing step |
| **CodeGraph** | Code Knowledge Graph (Default) | MIT | `codegraph_explore` | High-level architecture, "How X works", complete call paths, blast radius / impact analysis | Run `codegraph init` (or `/project init`) once per repo; background watcher **auto-syncs on every save** |
| **GitNexus** | Deep Graph Analysis (Optional) | PolyForm Noncommercial | Cypher queries, clustering | Multi-repo groups, arbitrary Cypher graph queries, cluster/process visualization | Re-index with `gitnexus analyze` (or `/project index`) after big changes |
| **DBHub** | Universal DB Gateway | MIT (Bytebase) | `search_objects`, `execute_sql` | Unified gateway for PostgreSQL / MySQL / SQLite / SQL Server / MariaDB | Per-project `dbhub.toml` config supporting `${ENV_VAR}` interpolation |
| **Headroom** | Context Compression (Optional) | Apache 2.0 | `headroom_compress`, `headroom_retrieve`, `headroom_stats` | Input-side token savings: compress tool outputs / logs / RAG chunks before they reach the LLM; originals retrievable via CCR | Disabled by default; heavy install (uv + Python 3.13) and first-run model download (see below) |
| **IDE** | JetBrains IDE Bridge | — | IDE-native tools | Live access to the running IntelliJ / WebStorm / etc. — file editing, navigation, refactoring, run configs | IDE must be running with MCP server enabled (Settings → Tools → MCP Server); endpoint dies when IDE closes |

---

## Automated Provisioning & Configuration

The MCP stack is seamlessly woven into the installer and agent runtime:

### 1. Centralized Switches & CLI Auto-Provisioning (`install/options.jsonc`)

Manage active MCP servers in `install/options.jsonc`:

```jsonc
// install/options.jsonc
{
  "mcp": {
    "serena": false,    // LSP semantic queries (off by default — 23 tools ≈ 7.7k tok/step; enable when needed)
    "codegraph": true,  // Code knowledge graph (auto-installed via npm if missing)
    "gitnexus": false,  // Deep Cypher graph (check PolyForm license for commercial use)
    "dbhub": true,      // Universal DB gateway (auto-installed via npm if missing)
    "headroom": false,  // Context compression (heavy install — uv + Python 3.13)
    "idea": true        // JetBrains IDE bridge (enable MCP Server in IDE first)
  }
}
```

- **Automatic CLI Provisioning**: When running `pwsh install/install.ps1` or `./install/install.sh`, if an enabled MCP CLI is missing from PATH, the installer automatically runs its `install` command (from `opencode.jsonc`) to provision it.

**Tiered-review graph selection:** graph evidence is optional. The session profile reports compact
CodeGraph/GitNexus readiness facts; L3 selects CodeGraph for ordinary single-repo impact, or
GitNexus only for its process/group/cross-repo capability. No ready backend bypasses Scout and
sends L3 directly to `@code-review`.

#### Headroom Notes

- **Scope**: Headroom is the only INPUT-side saver in the stack — `rtk` covers the output side. In MCP mode the agent calls `headroom_compress` on demand; compression is reversible (`headroom_retrieve` restores originals within the CCR TTL).
- **Why default-off**: provisioning runs `uv tool install --python 3.13 "headroom-ai[all]"`, and the first run additionally downloads the ONNX runtime (cdn.pyke.io) and the Kompress compression model (huggingface.co). Enable only if you accept those downloads.
- **Do NOT combine with `headroom wrap opencode` or `headroom proxy`**: both rewrite agent/provider configuration that OCP owns (`mergeConfig` / `/profile apply` manage the same `opencode.jsonc`), so they overwrite each other. The MCP entry above is the supported integration surface.

### 2. Runtime Profiling & Routing (`project-profiler` plugin)

You don't need to manually tell agents which tool to call. The bundled `project-profiler.ts` plugin:
- Automatically detects project languages, active MCP servers, and local index status (`.codegraph/`, `.gitnexus/`).
- Injects compact capability facts into the system prompt; `@build` owns backend choice, while a
  selected Scout keeps graph tools off reviewers.

### 3. Project Lifecycle Management (`/project` command)

Initialize and maintain project indexes effortlessly with `/project`:

```text
/project init       # One-shot scaffolding: runs setup steps from project-hooks.jsonc
                    # for each enabled MCP whose CLI is on PATH
/project index      # Refreshes indexes: runs index steps from project-hooks.jsonc
```

Lifecycle steps are declared in the shipped `plugins/project-manager/project-hooks.jsonc`
registry instead of being hardcoded. Each backend entry defines `setup`, `index`,
`teardown`, and `git_hooks` conditions, so adding a new backend only requires a
registry entry — no plugin code changes.

Managed git hooks are written as `OCP-project-hook:<backend>` blocks inside
`.git/hooks/post-commit`, `post-merge`, and `post-checkout`. Inactive backends
have their blocks removed automatically; legacy `OCP-gitnexus-update-hook`
blocks are also cleaned up.

### 4. Database Setup Example (`dbhub.toml`)

Create a `dbhub.toml` in your project root (or let `/project init` scaffold it):

```toml
# dbhub.toml
[[sources]]
id = "default"
dsn = "${DBHUB_DSN}"   # Store DSN in environment variable (e.g. postgres://user:pass@localhost:5432/mydb)

[[tools]]
name = "execute_sql"
source = "default"
readonly = true        # Safety: enforce read-only execution
```
