# Universal Design Reference

Read this before producing any DESIGN document. Applies to **any visual target**: web, mobile app, mini-program, or hybrid. No implementation-library assumptions — your craft prompt owns the choice of specific tools (animation libraries, component systems, motion engines); this reference carries the **universal design discipline**.

---

## Visual capabilities (per target)

Your implementation team can build ambitious visual experiences on the chosen target. **You do not prescribe the libraries** — you prescribe the *capabilities* the target needs:

- **Web**: scroll-driven storytelling, kinetic typography, shader-style effects (noise gradients, fluid/smoke backgrounds, image displacement, dithering, chromatic aberration), parallax depth, 3D particle fields. The implementer picks the libraries (animation runtime, shader/3D layer, scroll engine) per their craft.
- **Mobile app (iOS / Android)**: platform-native motion (per platform HIG / Material 3), gesture-driven transitions, haptics, native share/sheet intent, smooth infinite scroll, parallax for cover art. Per-platform feel — not a web aesthetic ported over.
- **Mini-program**: platform-native animations (sub-2s cold start, frame-budgeted transitions), platform-specific share card, subscribe-message integration, runtime-allowed media formats. Strict size budget per platform.
- **Hybrid / cross-platform**: stick to whichever target's platform-native idioms (do not impose a different target's aesthetic).

Mix, adapt, and invent — pick what fits the content's mood. Effects serve the content's meaning, never decoration for its own sake.

## Interactivity

Design for engagement — users should have plenty to click, hover, explore, or tap:

- Controls with feedback (animation chosen per craft, duration per motion table below)
- Tab groups, accordions, toggles that reveal content with motion
- Cards and galleries with hover/tap/zoom/overlay reveals
- Navigation that feels responsive (animated menus, smooth scroll-to-section)
- Modals, drawers, sheets, lightboxes for detail views
- Gesture-driven interaction on touch targets (swipe / pinch / long-press where platform idiomatic)

## Visual design tokens (universal)

### Color palette (exact hex values)

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

- Font stack: … (declared per target — web: web font; iOS: SF Pro; Android: Roboto; mini-program: platform default)
- Type scale (token-relative, exact values): 12 / 14 / 16 / 18 / 20 / 24 / 30 / 36 / 48
- Line height: 1.5 body, 1.2 headings
- Letter spacing: as appropriate per target

### Spacing (use a token-driven grid)

Tokens defined by exact value — the grid value itself is a per-project decision (commonly 4px or 8px). All spacing references tokens, never magic numbers.

### Radii

`sm`, `md`, `lg`, `xl`, `full` — exact values per project.

### Shadows / elevation

Per target's idioms — web: CSS box-shadow tokens; iOS: shadow tokens per HIG; Android: elevation tokens per Material 3.

### Motion (universal table)

| Token | Duration | Easing |
|---|---|---|
| Fast (hover, toggle, tap feedback) | 120ms | ease-out |
| Base (page, modal, sheet) | 200ms | ease-in-out |
| Slow (drawer, route transition) | 300ms | ease-in-out |

Spring parameters for drag/reorder: declared per project, tuned to feel.

## Layout & responsive behavior (per target)

| Target | Breakpoints / size strategy |
|---|---|
| Web | mobile <768px / tablet 768–1024px / desktop ≥1024px |
| Mobile app | per platform idiom (compact / regular size classes); safe areas + notch/home indicator insets |
| Mini-program | per platform design guide (rpx unit for WeChat); device-width-based |

## Page inventory

For each page, document: layout sketch, components with token references, **exact copy** for every visible string (for every locale if applicable), per-section **Animation field with concrete parameters**, and the four states (skeleton / empty / error / success). The implementer must reach zero aesthetic decisions reading this.

## Four states per interaction point

- **Skeleton**: declared explicitly per surface (loading indicator style + which elements)
- **Empty**: illustration description + copy + recovery action
- **Error**: message (human, includes fix) + recovery path
- **Success**: feedback (toast / inline / disabled confirmation)

## Shared components

For each reusable component, document: variants, sizes, three interaction states (default / hover-or-active / focus), anatomy (which tokens it uses), and accessibility (role, keyboard/touch activation, focus ring, ARIA label).

## Iconography (universal principle)

- Style: chosen per target; consistent set across the product
- Sizes: declared per target (web common: 16/20/24; mobile: 24/32; mini-program: declared)
- **NEVER use emoji as functional icons** — decorative emoji in content text is allowed; functional icons (buttons, navigation, status) use icon systems

## Asset manifest (design only — you do NOT generate assets)

In DESIGN, include an **Assets** section listing every image/video/icon asset the product needs. For each asset specify:

- **Filename** (e.g. `hero-bg.png`, `logo.svg`)
- **Description** — a detailed prompt describing what it should look like (style, mood, content, colors). The implementer uses this to generate or draw the asset.
- **Intended location** — which page/section uses it
- **Dimensions** — target resolution and aspect ratio
- **Type** — Image / SVG / Video

Not every product needs generated images — skip the Assets section if the design relies purely on typography, icons, and gradients.

Local-first policy: prefer hand-drawn SVG, gradients, and abstract shapes (zero external dependency, zero license risk). Watermarked stock placeholders are forbidden in final delivery.

## Accessibility floor (universal target)

- WCAG AA contrast on all text (≥4.5:1 body, ≥3:1 large)
- Full keyboard paths on web; touch target ≥ 44×44 pt on mobile
- Focus ring visible on every interactive element
- Reduced-motion media query respected (where the target supports it)
- ARIA labels on icon-only controls
- Dark-mode parity

## Performance guardrails (universal)

- Web: limit simultaneous animating elements to ~8–10 per viewport; one heavy effect per section; CSS fallbacks for any GPU-bound effect; text animation density per element size.
- Mobile app: cold-start ≤ 2 s on mid-range device; main package per platform budget; smooth scrolling under touch (no jank).
- Mini-program: cold-start ≤ 2 s; main package ≤ 2 MB (subcontract otherwise); runtime-allowed media formats only.

## Anti-pattern guardrails

These are forbidden across every target:

- ❌ High-saturation background blocks
- ❌ Blue-purple gradient backgrounds (lazy aesthetic)
- ❌ Emoji as functional icons
- ❌ Magic-number spacing / color / type values (always tokens)
- ❌ Placeholder copy ("Lorem ipsum", "Coming soon", "TODO")
- ❌ Fake data masquerading as real data
- ❌ Component-library stock look (raw unstyled defaults)
- ❌ Web-idiom motion imposed on non-web targets (or vice versa)

## Reference benchmark

Name the product class and its industry benchmark (efficiency tool → Linear; content product → Notion / Apple; data tool → Stripe-style docs; mobile app → relevant platform leader). Then design against that benchmark — your implementer needs to know what "great" looks like to know what "good enough" is not.

## What you do NOT do

- Read implementation-specific guidance for any framework (that's the implementer's craft)
- Decide how to split pages between agents (that's the orchestrator's job)
- Handle deployment or build configuration
- Generate image assets (that's the implementer's job — you only define the asset manifest)
