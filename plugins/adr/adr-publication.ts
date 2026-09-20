/** Pure, reviewable publication plans. No source writes and no model calls. */
import { posix } from "node:path"
import { getAdrConfig } from "./adr-config"
import { buildAdrTree, renderAdlIndex, type AdrTreeNode } from "./adr-views"
import { groupByIteration, renderIterationIndex } from "./adr-evolution"
import { decisionUnits, isArchived, recordRoot, renderCurrent, type Snapshot, type SummaryItem } from "./adr-context"
import { digest, readOptional, type FileChange } from "./adr-storage"

export function planPublication(project: string, snapshot: Snapshot, items?: SummaryItem[], previous: FileChange[] = []): FileChange[] {
  const outputs = new Map<string, string>()
  const roots = [...new Set([snapshot.root, ...snapshot.records.map(r => recordRoot(r.sourcePath, snapshot.root))])].sort()
  if (items) {
    const bodies = new Map<string, { body: string; items: SummaryItem[] }>()
    for (const root of roots) {
      const local = new Set(snapshot.records.filter(r => !isArchived(r.sourcePath, snapshot.root) && (posix.dirname(r.sourcePath) === root || r.layer === "system")).flatMap(r => [r.id, ...decisionUnits(r)]))
      const scoped = items.filter(item => item.sources.some(id => local.has(id)))
      const manifestItems = root === snapshot.root ? items : scoped
      const navigation = roots.filter(r => r !== root && (root === snapshot.root || r === snapshot.root)).map(r => `- [${r}](${posix.relative(root, `${r}/CURRENT.md`)})`).join("\n")
      const body = renderCurrent(scoped) + `\n## View scope\n\n${root === snapshot.root ? "Project-wide navigation; root and system constraints inline; module detail in linked views" : root + " and shared system constraints"}. Source fingerprint: \`${snapshot.fingerprint}\`.\n\n## Other views\n\n${navigation || "No additional roots."}\n\n<!-- ocp-adr-summary: ${digest(JSON.stringify(manifestItems))} -->\n`
      bodies.set(root, { body, items: scoped })
      outputs.set(`${root}/CURRENT.md`, body)
    }
    const views = Object.fromEntries([...bodies].map(([root, value]) => [`${root}/CURRENT.md`, digest(value.body)]))
    for (const [root, value] of bodies) {
      outputs.set(`${root}/CURRENT.sources.json`, JSON.stringify({
        version: 1, owner: "ocp-adr-compaction", fingerprint: snapshot.fingerprint,
        root, roots, summaryHash: digest(value.body), views,
        sources: snapshot.records.map(r => ({ id: r.id, path: r.sourcePath, hash: digest(r.rawContent), status: String(r.status), units: decisionUnits(r), sections: r.sections?.map(sec => ({ id: sec.id, status: String(sec.status) })) })),
        displayItems: value.items,
        coverage: (root === snapshot.root ? items : value.items).map((item, index) => ({ item: index + 1, sources: item.sources })), items: root === snapshot.root ? items : value.items,
      }, null, 2))
    }
  }
  const visit = (node: AdrTreeNode) => {
    outputs.set(`${node.relDir}/INDEX.md`, renderAdlIndex(node, getAdrConfig(project).indexColumns))
    node.children.forEach(visit)
  }
  buildAdrTree(snapshot.records, snapshot.root).forEach(visit)
  if (groupByIteration(snapshot.records).length) outputs.set(`${snapshot.root}/INDEX.by-iteration.md`, renderIterationIndex(snapshot.records, snapshot.root))
  return [...outputs].map(([path, after]) => {
    const prior = previous.find(c => c.path === path)
    const before = prior ? prior.after : readOptional(project, path)
    if (items && /\/CURRENT\.(?:md|sources\.json)$/.test(path) && before !== null && !prior) {
      const owned = path.endsWith(".md") ? before.includes("<!-- ocp-adr-compaction: generated, reviewed derived view -->") : (() => { try { return JSON.parse(before).owner === "ocp-adr-compaction" } catch { return false } })()
      if (!owned) throw new Error(`Refusing to overwrite user-owned view: ${path}`)
    }
    return { path, before, after }
  })
}
