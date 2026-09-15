# Orchestration Discipline

Universal pipeline discipline. Applies to any tech stack. The principles are stated as concepts; the implementer's craft prompt owns the language-/framework-specific naming.

## Core principles

1. **Design first**: the DESIGN document must exist before any implementation begins; it is the single source of truth for the implementer.
2. **Design fidelity**: implementers faithfully implement the design — exact token values, exact copy, exact motion parameters. "Improving" the design is forbidden; replacing copy is forbidden. Finding a design flaw → record it in the design doc's revision notes; never silently change it.
3. **Foundation first**: design tokens + data layer + shared components must exist before any page-level work.
4. **Interface contracts are sacred**: data-layer type definitions, action signatures, and shared-component props are contracts. Later implementation may only ADD; modifying existing signatures is forbidden because other work depends on them.
5. **Build as gate**: at the end of every implementation stage the language stack's build gate must pass with zero errors zero warnings — otherwise the stage is not done.
6. **Test before handoff**: implementers self-verify before handing to QC; QC independently re-verifies and never trusts the implementer's self-report.

## Parallel discipline (when explicitly enabled)

Parallel page agents share one workspace, so every agent must carry a **forbidden-modify list**:

- Forbidden to modify: **routing skeleton** (the project's top-level route definitions), **global styles** (the project's root stylesheet or theming), **data-layer existing export signatures** (the store / repository / service layer's public API), **shared components** (anything depended on by multiple pages), **public assets directory** (the project's public/static assets root)
- Allowed: creating your own page files, creating local components inside your page directory, ADDING actions / endpoints to the data layer (new actions allowed; existing signature changes forbidden)
- Grouping principle: related pages/features go to one agent; minimize cross-dependencies
- The orchestrator runs the build gate after merging all parallel work

## Serial mode (default)

A single implementer walks pages/features in order, re-reading the relevant design-doc section before starting each page. Slower but steadier; the right default unless the product is large and the split is clean.

## Visual assets

- Prefer hand-drawn SVG, gradients, and abstract shapes (zero external dependency, zero license risk).
- Avatars/covers: generated-SVG schemes or CSS-gradient abstractions.
- Watermarked stock placeholder images are forbidden in final delivery.
