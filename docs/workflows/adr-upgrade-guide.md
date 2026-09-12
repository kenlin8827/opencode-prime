# ADR Hierarchical Living Architecture Upgrade Guide & Changelog

## 📋 Upgrade Overview

This upgrade elevates the single-layer `adr-guard` commit interception mechanism into an **Enterprise-Grade Hierarchical Living Architecture & Decision Lifecycle System**. It bridges the gap between static gating and active architecture enablement, bringing together scaffolding, lifecycle management, smart scope detection, and live DAG visualization.

---

## 🛠️ Files Added & Modified

| File Path | Change Type | Core Responsibility |
| :--- | :---: | :--- |
| `plugins/adr-guard/adr-engine.ts` | **NEW** | Hierarchical ADR engine: multi-path discovery, auto-increment numbering, layer templates, atomic superseding state machine, Mermaid DAG rendering, and integrity checking |
| `plugins/adr-guard/adr-guard-config.ts` | **MOD** | Project-level `adrLayout` (`auto` \| `flat` \| `hierarchical`) configuration read/write and normalization |
| `plugins/adr-guard/adr-guard-command.ts` | **MOD** | `/adr` command dispatcher (`new`, `supersede`, `tree`, `check`, `layout`, `help`) |
| `plugins/adr-guard/adr-guard.ts` | **MOD** | Register `/adr` and `/adr-guard` slash commands in OpenCode plugin config |
| `plugins/adr-guard/adr-guard-runtime.ts` | **MOD** | Enhanced `hasAdrChanges` supporting multi-path and subsystem `**/docs/adr/**` git status changes |
| `plugins/adr-guard/adr-guard-protocol.md` | **MOD** | Upgraded protocol defining the 3-tier hierarchy (L1/L2/L3) and `/adr` usage |
| `tests/test-adr-hierarchical-unit.ts` | **NEW** | 31 unit tests for hierarchical discovery, lifecycle, DAG, and layout isolation |
| `docs/workflows/plugins.md` | **MOD** | Updated VitePress plugins documentation |
| `docs/zh/workflows/plugins.md` | **MOD** | Updated VitePress Chinese plugins documentation |
| `docs/workflows/commands.md` | **MOD** | Added `/adr` and `/adr-guard` to command overview |
| `docs/zh/workflows/commands.md` | **MOD** | Added `/adr` and `/adr-guard` to Chinese command overview |

---

## ✨ Features & Slash Commands Checklist

### 1. Unified `/adr` Command Suite
- [x] **`/adr new [layer/scope] <title> [--empty]`**:
  - Automatically finds the highest sequential number in target directory and increments (`NNNN-slug.md`);
  - Generates specialized MADR template adapted for `system` / `domain` / `component` layers & updates `INDEX.md`;
  - **Auto-initiates AI drafting** to flesh out the complete decision content (use `--empty` for scaffold only).
- [x] **`/adr supersede <old-id> <new-title> [--empty]`**:
  - Atomically marks previous decision as `superseded by NNNN`;
  - Scaffolds new decision with bidirectional `parent` / `superseded_by` cross-references, syncing both `INDEX.md` files;
  - **Auto-initiates AI drafting** for evolution rationale (supports unpadded IDs like `supersede 1 "Title"`, use `--empty` for scaffold only).
- [x] **`/adr tree` (or `/adr map`)**:
  - Scans workspace ADRs and generates a hierarchical Markdown tree;
  - Generates an interactive Mermaid DAG diagram showing `constrains` and `superseded by` edges.
- [x] **`/adr check` (or `/adr lint`)**:
  - Audits link integrity (broken parent references, missing supersede targets);
  - Validates required frontmatter and duplicate IDs within directories;
  - **Complexity Advisor**: Proactively analyzes decision count & monorepo packages, recommending structure migrations when thresholds are reached.
- [x] **`/adr migrate [flat|hierarchical] [--confirm]` (Automated Refactoring & Migration Engine)**:
  - **Dry-Run Preview**: Inspects proposed restructuring plans, file paths, layer mappings, and new sequential numbers before applying;
  - **Execution**: Atomically relocates files, rewrites frontmatter, updates mutual references, and regenerates all `INDEX.md` files;
  - Supports **Bidirectional Refactoring** (`flat` → `hierarchical` or `hierarchical` → `flat`).
- [x] **`/adr layout [auto|flat|hierarchical]`**:
  - Query or switch project governance layout (automatically offers refactoring commands when relocations are available).


---

## ⚙️ Configuration Schema (`opencode.jsonc`)

The following fields are supported in your project's `opencode.jsonc`:

```jsonc
{
  // Hard commit gate for feat/refactor commits (default "off")
  "adrGuard": "on",

  // Custom root ADR directory (default "docs/adr")
  "adrDir": "docs/adr",

  // ADR hierarchy layout (default "auto")
  // "auto": Smart adaptive layout (flat by default for monoliths, expands for sub-packages)
  // "flat": Strict single-directory flat layout (docs/adr/)
  // "hierarchical": Strict multi-tier hierarchy (L1/L2/L3)
  "adrLayout": "auto"
}
```

---

## 🔒 Backward Compatibility & Migration

1. **100% Backward Compatible**: Existing flat `docs/adr/` repositories require zero changes. Under the `auto` layout, they retain the simple flat experience.
2. **Zero Migration Friction**: Legacy ADRs without explicit `layer` frontmatter are inferred gracefully.

---

## 🧪 Test Verification

Run all test suites to confirm installation:

```powershell
# 1. Run hierarchical ADR unit tests (31 tests)
bun run tests/test-adr-hierarchical-unit.ts

# 2. Run adr-guard regression tests (77 tests)
bun run tests/test-adr-guard-unit.ts
```

**Result**: `108 / 108` unit tests passed (100% Pass Rate).
