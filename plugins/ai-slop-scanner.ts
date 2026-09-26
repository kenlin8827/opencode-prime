/// <reference types="bun" />
import type { Plugin } from "@opencode/plugin"

/**
 * AI Slop Scanner — scans frontend files after edit for common AI-generated
 * anti-patterns. Reports warnings (does NOT block — use design-token-guard for blocking).
 *
 * Detects:
 *  - Gradient soup (multi-stop gradients on non-special elements)
 *  - Excessive rounded corners (rounded-3xl on everything)
 *  - Drop shadow overuse (shadow-2xl on multiple elements)
 *  - Purple/blue gradient text headings
 *  - Floating glassmorphism without context
 *  - Div soup (<div onClick> instead of <button>)
 *  - Inline styles when Tailwind exists
 *  - z-index wars (z-[9999])
 *  - Emoji in professional UI
 *
 * Only scans TSX/JSX/Vue/Svelte files.
 *
 * v2 event mapping: `filesystem.changed` replaces v1's `file.edited`
 * (see auto-format.ts header for the rationale). Warnings go to the
 * server log via console — v2 dropped the client.app.log API.
 */

const FRONTEND_EXTENSIONS = [".tsx", ".jsx", ".vue", ".svelte"] as const

const SLOP_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /bg-gradient-to-\w+\s+from-\w+-\d+\s+via-\w+-\d+\s+to-\w+-\d+/g,
    message: "Gradient soup: multi-stop gradient detected. Use sparingly, with intent.",
  },
  {
    pattern: /rounded-(?:3xl|full)/g,
    message: "Excessive rounded corners: rounded-3xl/full on elements. Match design system radius.",
  },
  {
    pattern: /shadow-2xl/g,
    message: "Drop shadow overuse: shadow-2xl. Use design system elevation.",
  },
  {
    pattern: /bg-clip-text\s+text-transparent\s+bg-gradient/g,
    message: "Gradient text on headings: almost never professional.",
  },
  {
    pattern: /backdrop-blur-xl\s+bg-white\/10\s+border\s+border-white\/20/g,
    message: "Floating glassmorphism without context.",
  },
  {
    pattern: /<div[^>]*onClick/g,
    message: "Div soup: <div onClick> instead of <button>. Use semantic HTML.",
  },
  {
    pattern: /style\s*=\s*\{\{[^}]*(?:color|background|padding|margin|width|height)\s*:/g,
    message: "Inline styles when Tailwind/design tokens exist.",
  },
  {
    pattern: /z-\[9999\]|z-\[10000\]|z-\[999\]/g,
    message: "z-index wars: z-[9999]. Use design system stacking.",
  },
  {
    pattern: /[🔥🚀✨⚡🎯💡🚦]/g,
    message: "Emoji in professional UI. Use icon library instead.",
  },
]

function isFrontend(filePath: string): boolean {
  return FRONTEND_EXTENSIONS.some((ext) => filePath.endsWith(ext))
}

function scanForSlop(content: string): string[] {
  const warnings: string[] = []
  for (const { pattern, message } of SLOP_PATTERNS) {
    const matches = content.match(pattern)
    if (matches) {
      warnings.push(`${message} (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`)
    }
  }
  return warnings
}

const plugin: Plugin.Plugin = {
  id: "opencode-prime.ai-slop-scanner",
  setup(ctx) {
    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "filesystem.changed") continue
          if (event.data.event === "unlink") continue
          const file = event.data.file
          if (!file || !isFrontend(file)) continue

          try {
            // Read the edited file content
            const content = await Bun.file(file).text()
            if (!content) continue

            const warnings = scanForSlop(content)
            if (warnings.length === 0) continue

            console.warn(`[ai-slop-scanner] AI Slop detected in ${file} (${warnings.length}):\n  ${warnings.join("\n  ")}`)
          } catch {
            // File read failed — skip silently
          }
        }
      } catch {
        // Subscription ended (abort/transport); plugin holds no further resource.
      }
    })()

    return () => controller.abort()
  },
}

export default plugin
