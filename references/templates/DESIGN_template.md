# Design Document (DESIGN)

> P3 output (skip when DESIGN_REQUIRED=no). Gating document — no frontend code may be written before this file exists at the SPEC-named path. The implementer should reach **zero** aesthetic decisions reading this; every choice lives here, tech-agnostic.

---

## 1. Reference benchmark

Name the product class and its industry benchmark (efficiency tool → Linear; content product → Notion / Apple; mobile app → relevant platform leader; mini-program → leading mini-program in this category). Be specific — your implementer needs to know what "great" looks like to know what "good enough" is not.

## 2. Design tokens (exact values)

### Color palette (hex exact)

| Token | Hex | Use |
|---|---|---|
| `--color-primary` | `#…` | primary actions, brand |
| `--color-primary-hover` | `#…` | hover state |
| `--color-bg` | `#…` | app background |
| `--color-surface` | `#…` | cards, panels |
| `--color-text` | `#…` | body text |
| `--color-text-muted` | `#…` | secondary text |
| `--color-border` | `#…` | dividers |
| `--color-success` | `#…` | confirmations |
| `--color-warning` | `#…` | cautions |
| `--color-danger` | `#…` | destructive |

Neutral scale (≥8 levels): from lightest to darkest, exact hex per level.

### Typography

- Font stack: … (declared per target — web font / SF Pro / Roboto / platform default)
- Type scale (exact values): 12 / 14 / 16 / 18 / 20 / 24 / 30 / 36 / 48
- Line height: 1.5 body, 1.2 headings
- Letter spacing: as appropriate per target

### Spacing (token-driven grid)

Tokens defined by exact value — the grid value itself is a per-project decision (commonly 4px or 8px). All spacing references tokens, never magic numbers.

### Radii

`sm`, `md`, `lg`, `xl`, `full` — exact values per project.

### Shadows / elevation

Per target's idioms — web: CSS shadow tokens; iOS: shadow tokens per HIG; Android: elevation tokens per Material 3; mini-program: per platform design guide.

### Motion

| Token | Duration | Easing |
|---|---|---|
| Fast (hover, toggle, tap feedback) | 120ms | ease-out |
| Base (page, modal, sheet) | 200ms | ease-in-out |
| Slow (drawer, route transition) | 300ms | ease-in-out |

Spring parameters for drag/reorder: declared per project, tuned to feel.

## 3. Layout & size strategy (per target)

| Target | Strategy |
|---|---|
| Web | mobile <768px / tablet 768–1024px / desktop ≥1024px |
| Mobile app | per platform idiom; safe areas + notch/home indicator insets |
| Mini-program | per platform design guide; device-width-based |

Grid: declared per target. Gutter: declared per target.

## 4. Page inventory

| ID | Route / screen | Purpose | Components |
|---|---|---|---|
| P-001 | … | … | … |

For each page, fill the page template below.

### Page template (repeat per page/screen)

**Page**: `<name>` (`<route or screen id>`)
**Purpose**: <one sentence>
**Layout sketch**:
```
┌─────────────────────────────────────────┐
│ header                                  │
├──────┬──────────────────────────────────┤
│      │                                  │
│ side │ main                             │
│ bar  │                                  │
│      │                                  │
└──────┴──────────────────────────────────┘
```

**Components used**: <list with tokens referenced>
**Exact copy** (for every visible string):
- H1: "…"
- Primary CTA: "…"
- Empty state title: "…"
- Empty state body: "…"
- Error state title: "…"
- Error state body: "…"
- …

**Animation** (mandatory per section — concrete parameters, never "fade in"):
- On load: <e.g. "stagger children 0.1s delay, slide up 40px, opacity 0→1, trigger at 20% viewport">
- On scroll / hover / interaction: <…>

**States**:
- Skeleton: <description>
- Empty: <illustration description + copy>
- Error: <message + recovery>
- Success: <toast / inline / disabled confirmation>

## 5. Shared components

For each reusable component, fill:

### Component: `<Name>`

- **Variants**: primary / secondary / ghost / destructive (as applicable)
- **Sizes**: sm / md / lg
- **States**: default / hover-or-active / focus / disabled / loading
- **Anatomy** (which tokens it uses):
  - Background: `--color-…`
  - Border: `--color-border`, radius `--radius-md`
  - Padding: `sm md`
  - Type: `--type-body`
  - Motion: `fast` on hover-or-active
- **Accessibility**: role, aria-label, keyboard/touch activation, focus ring

(Repeat for the product's shared components — Button, Input, Select, Modal, Toast, Tooltip, Card, Avatar, IconButton, EmptyState, ErrorBoundary, … as applicable.)

## 6. Iconography

- Set: chosen per target; consistent across the product
- Style: outlined (per target convention); sizes declared per target
- **NEVER use emoji as functional icons** — decorative emoji in content text is allowed; functional icons (buttons, navigation, status) use icon systems

## 7. Seed data spec

Quality of seed data = quality of first impression. Real, varied, demo-worthy.

- Volume: <n records, n users, n tags, …>
- Variety: <different states, different sizes, different categories>
- Realism: <no "test1/test2"; use real-sounding names, plausible dates, varied content>
- Visual demo path: <which screens look best after seed runs>

## 8. Asset manifest (design only — you do NOT generate assets)

Local-first: hand-drawn SVG + gradients preferred; generated-SVG schemes OK for avatars/covers; watermarked stock is forbidden.

| Filename | Description (generation prompt: style/mood/content/colors) | Intended location | Dimensions | Type |
|---|---|---|---|---|
| `logo.svg` | … | header | `160×40 4:1` | SVG |
| `hero-bg.png` | … | home hero | `1920×1080 16:9` | Image |
| `empty-board.svg` | … | board empty state | `400×400 1:1` | SVG |

## 9. Accessibility floor

- WCAG AA contrast on all text (≥4.5:1 body, ≥3:1 large)
- Full keyboard paths on web; touch targets ≥ 44×44 pt on mobile
- Focus ring visible on every interactive element
- Reduced-motion media query respected where the target supports it
- ARIA labels on icon-only controls
- Dark-mode parity where the target supports it

## 10. Anti-pattern guardrails

These are forbidden across every target:

- ❌ High-saturation background blocks
- ❌ Blue-purple gradient backgrounds
- ❌ Emoji as functional icons
- ❌ Magic-number spacing / color / type values (always tokens)
- ❌ Placeholder copy ("Lorem ipsum", "Coming soon", "TODO")
- ❌ Fake data masquerading as real data
- ❌ Component-library stock look
- ❌ Web-idiom motion imposed on non-web targets (or vice versa)
