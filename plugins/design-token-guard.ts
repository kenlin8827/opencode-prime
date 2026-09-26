import type { Plugin } from "@opencode/plugin"

/**
 * Design Token Guard — intercepts file writes and blocks hardcoded design values.
 *
 * Enforces: colors, spacing, border-radius, shadows MUST come from design tokens.
 * Only scans CSS/SCSS/TSX/JSX/Vue files. Non-frontend files are ignored.
 *
 * To disable for a specific write: add `// design-token-guard: off` as first line.
 *
 * v2: the tool execute.before hook receives one mutable event; a
 * Tool.Error-shaped throw is the deny path, any other defect must fail
 * open (a hook error beyond execute.before aborts the request flow).
 */

const FRONTEND_EXTENSIONS = [".css", ".scss", ".tsx", ".jsx", ".vue", ".svelte"] as const
const HARDCODED_COLOR = /#[0-9A-Fa-f]{3,8}\b(?!.*design-token-guard)/g
const HARDCODED_RGB = /\b(?:rgb|rgba)\s*\(\s*\d+/g
const HARDCODED_HSL = /\b(?:hsl|hsla)\s*\(\s*\d+/g
const MAGIC_SPACING = /(?:padding|margin|gap|top|left|right|bottom|width|height)\s*[:=]\s*(?:(?!\d+(?:px|rem|em|vh|vw)\b)|0)(\d{2,}px)/gi
const MAGIC_RADIUS = /border-radius\s*[:=]\s*(?!(?:0|var|--|\$\{))(\d{2,}px)/gi
const MAGIC_SHADOW = /box-shadow\s*[:=]/i

/** Tool.Error-shaped rejection — the v2 execute.before deny path. */
class ToolRejection extends Error {
  readonly _tag = "Tool.Error" as const
}

function isFrontend(filePath: string): boolean {
  return FRONTEND_EXTENSIONS.some((ext) => filePath.endsWith(ext))
}

function scanContent(content: string): string[] {
  const violations: string[] = []

  // Hardcoded hex colors (skip tailwind classes like bg-#xxx which don't exist)
  const hexMatches = content.match(HARDCODED_COLOR)
  if (hexMatches) violations.push(`hardcoded colors: ${hexMatches.slice(0, 5).join(", ")}`)

  // rgb()/rgba() with literal values
  const rgbMatches = content.match(HARDCODED_RGB)
  if (rgbMatches) violations.push(`hardcoded rgb(): ${rgbMatches.length} occurrences`)

  // hsl()/hsla() with literal values
  const hslMatches = content.match(HARDCODED_HSL)
  if (hslMatches) violations.push(`hardcoded hsl(): ${hslMatches.length} occurrences`)

  // Magic spacing values (2+ digit px that aren't standard tailwind scale)
  const spacingMatches = content.match(MAGIC_SPACING)
  if (spacingMatches) violations.push(`non-standard spacing: ${spacingMatches.slice(0, 5).join(", ")}`)

  // Magic border-radius
  const radiusMatches = content.match(MAGIC_RADIUS)
  if (radiusMatches) violations.push(`non-standard border-radius: ${radiusMatches.slice(0, 3).join(", ")}`)

  return violations
}

function checkWrite(filePath: string, content: string): void {
  if (!isFrontend(filePath)) return
  if (!content) return

  // Allow opt-out via comment
  if (content.startsWith("// design-token-guard: off")) return

  const violations = scanContent(content)
  if (violations.length > 0) {
    throw new ToolRejection(
      `[Design Token Guard] Blocked write to ${filePath}:\n` +
        violations.map((v) => `  ❌ ${v}`).join("\n") +
        `\n  Use design tokens (CSS variables, Tailwind config, or theme constants).\n` +
        `  To bypass: add "// design-token-guard: off" as first line.`
    )
  }
}

const plugin: Plugin.Plugin = {
  id: "opencode-prime.design-token-guard",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "write") return
      try {
        const args = (event.input ?? {}) as { filePath?: unknown; content?: unknown }
        const filePath = typeof args.filePath === "string" ? args.filePath : ""
        const content = typeof args.content === "string" ? args.content : ""
        checkWrite(filePath, content)
      } catch (err) {
        // The deny rejection must propagate; a guard defect fails open.
        if (err instanceof ToolRejection) throw err
        console.warn(`[design-token-guard] check failed open: ${String(err)}`)
      }
    })
  },
}

export default plugin
