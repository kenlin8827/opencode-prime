/**
 * ADR style registry — dispatch between source-document grammars.
 *
 * The parser reads explicit `style` frontmatter FIRST. Documents without
 * it are `legacy` (pre-refactor files are MADR-shaped): they dispatch to
 * the madr adapter, are reported as undeclared, and are never modified
 * silently. Adding a style = one adapter module + one registration
 * (Phase 2 registers `styles/nygard.ts` here).
 */

import type { AdrDocument, AdrStyle, AdrStyleAdapter } from "./adr-types"
import { extractFrontmatter } from "./adr-types"
import { madrAdapter } from "./styles/madr"
import { nygardAdapter } from "./styles/nygard"
import { ocpAdapter } from "./styles/ocp"

const registry = new Map<AdrStyle, AdrStyleAdapter>()

export function registerAdrStyle(adapter: AdrStyleAdapter): void {
  registry.set(adapter.style, adapter)
}

export function getAdrStyleAdapter(style: AdrStyle): AdrStyleAdapter {
  const adapter = registry.get(style)
  if (!adapter) {
    throw new Error(`ADR style '${style}' is not registered (available: ${listAdrStyles().join(", ") || "none"})`)
  }
  return adapter
}

/** Available styles without throwing (registry introspection). */
export function findAdrStyleAdapter(style: string): AdrStyleAdapter | null {
  return registry.get(style as AdrStyle) ?? null
}

export function listAdrStyles(): AdrStyle[] {
  return Array.from(registry.keys())
}

export interface ResolvedDocumentStyle {
  adapter: AdrStyleAdapter
  /** Explicitly declared style, or null when the document is legacy
   * (no `style` frontmatter — parsed by the madr adapter, reported,
   * never silently rewritten). */
  declaredStyle: AdrStyle | null
}

/**
 * Dispatch one document to its adapter. Explicit `style` wins; a
 * declared-but-unregistered style (a style key with no adapter in the
 * registry) still parses through madr (the MADR-shaped fallback) with
 * declaredStyle preserved for reporting. No style frontmatter → legacy → madr.
 */
export function resolveDocumentAdapter(document: AdrDocument): ResolvedDocumentStyle {
  const declared =
    document.frontmatter["style"]?.toLowerCase() ?? extractFrontmatter(document.rawContent)["style"]?.toLowerCase()
  if (declared) {
    const adapter = findAdrStyleAdapter(declared) ?? madrAdapter
    return { adapter, declaredStyle: declared as AdrStyle }
  }
  return { adapter: madrAdapter, declaredStyle: null }
}

// Built-in styles (§7): Nygard and MADR 4 (industry canonical), plus the
// OCP-native container style (baijiu-shop grammar — one record per
// iteration file, sections as structured payload). Adding a style = one
// adapter module + one registration call.
registerAdrStyle(nygardAdapter)
registerAdrStyle(madrAdapter)
registerAdrStyle(ocpAdapter)
