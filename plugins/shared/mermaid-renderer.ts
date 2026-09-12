import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"

// The render worker runs as `node <tmpfile>` — its `require('playwright')`
// would resolve from the TEMP dir (finds nothing), silently killing offline
// Mermaid rendering under bun. Resolve playwright once from THIS module's
// location and pass the absolute path into the worker.
let playwrightTarget: string | undefined
function playwrightRequirePath(): string {
  if (playwrightTarget === undefined) {
    try {
      playwrightTarget = createRequire(import.meta.url).resolve("playwright")
    } catch {
      playwrightTarget = "" // bare-name fallback: still works under cwd/global resolution
    }
  }
  return playwrightTarget || "playwright"
}

export interface MermaidBlock {
  fullMatch: string
  code: string
  index: number
}

export interface MermaidThemeConfig {
  theme: string
  primaryColor: string
  primaryTextColor: string
  primaryBorderColor: string
  lineColor: string
  secondaryColor: string
  secondaryBorderColor: string
  tertiaryColor: string
  accentColor: string
  fontFamily: string
  fontSize: string
  background: string
  nodeStrokeWidth: string
  edgeStrokeWidth: string
  cardBorderColor: string
  lifelineColor: string
}

export const DEFAULT_MERMAID_THEME: MermaidThemeConfig = {
  theme: "base",
  primaryColor: "#F0F7FF",
  primaryTextColor: "#0F172A",
  primaryBorderColor: "#3B82F6",
  lineColor: "#2563EB",
  secondaryColor: "#DBEAFE",
  secondaryBorderColor: "#93C5FD",
  tertiaryColor: "#FFFFFF",
  accentColor: "#1E3A8A",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "WenQuanYi Micro Hei", "Noto Sans CJK SC", sans-serif',
  fontSize: "13px",
  background: "#FFFFFF",
  nodeStrokeWidth: "1.5px",
  edgeStrokeWidth: "1.8px",
  cardBorderColor: "#CBD5E1",
  lifelineColor: "#CBD5E1",
}

/**
 * Extract Mermaid theme configuration from CSS content or file path.
 * Supports full stylesheet tokenization and dedicated --mermaid-* variable overrides.
 */
export function parseMermaidThemeFromCss(cssInput?: string): MermaidThemeConfig {
  const config: MermaidThemeConfig = { ...DEFAULT_MERMAID_THEME }
  if (!cssInput) return config

  let cssContent = cssInput
  if (existsSync(cssInput)) {
    try {
      cssContent = readFileSync(cssInput, "utf8")
    } catch {
      return config
    }
  }

  const varRegex = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g
  let vMatch: RegExpExecArray | null
  const vars: Record<string, string> = {}

  while ((vMatch = varRegex.exec(cssContent)) !== null) {
    vars[vMatch[1].trim().toLowerCase()] = vMatch[2].trim().replace(/^['"]|['"]$/g, "")
  }

  // 1. Direct --mermaid-* overrides
  if (vars["mermaid-theme"]) config.theme = vars["mermaid-theme"]
  if (vars["mermaid-primary-color"]) config.primaryColor = vars["mermaid-primary-color"]
  if (vars["mermaid-text-color"]) config.primaryTextColor = vars["mermaid-text-color"]
  if (vars["mermaid-border-color"]) config.primaryBorderColor = vars["mermaid-border-color"]
  if (vars["mermaid-primary-border-color"]) config.primaryBorderColor = vars["mermaid-primary-border-color"]
  if (vars["mermaid-line-color"]) config.lineColor = vars["mermaid-line-color"]
  if (vars["mermaid-secondary-color"]) config.secondaryColor = vars["mermaid-secondary-color"]
  if (vars["mermaid-secondary-border-color"]) config.secondaryBorderColor = vars["mermaid-secondary-border-color"]
  if (vars["mermaid-accent-color"]) config.accentColor = vars["mermaid-accent-color"]
  if (vars["mermaid-tertiary-color"]) config.tertiaryColor = vars["mermaid-tertiary-color"]
  if (vars["mermaid-font-family"]) config.fontFamily = vars["mermaid-font-family"]
  if (vars["mermaid-font-size"]) config.fontSize = vars["mermaid-font-size"]
  if (vars["mermaid-bg"]) config.background = vars["mermaid-bg"]
  if (vars["mermaid-node-stroke-width"]) config.nodeStrokeWidth = vars["mermaid-node-stroke-width"]
  if (vars["mermaid-edge-stroke-width"]) config.edgeStrokeWidth = vars["mermaid-edge-stroke-width"]
  if (vars["mermaid-card-border-color"]) config.cardBorderColor = vars["mermaid-card-border-color"]
  if (vars["mermaid-lifeline-color"]) config.lifelineColor = vars["mermaid-lifeline-color"]

  // 2. Safe fallback from standard design tokens if --mermaid-* is omitted
  if (!vars["mermaid-text-color"] && vars["text-main-color"]) config.primaryTextColor = vars["text-main-color"]
  if (!vars["mermaid-card-border-color"] && vars["border-color"]) config.cardBorderColor = vars["border-color"]
  if (!vars["mermaid-font-family"] && (vars["font-body"] || vars["font-heading"])) {
    config.fontFamily = vars["font-body"] || vars["font-heading"]
  }

  return config
}

/**
 * Scan markdown content for ```mermaid code blocks.
 */
export function scanMermaidBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = []
  const regex = /```(?:mermaid)\r?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(markdown)) !== null) {
    blocks.push({
      fullMatch: match[0],
      code: match[1].trim(),
      index: match.index,
    })
  }

  return blocks
}

export function hasMermaidBlocks(markdown: string): boolean {
  return /```(?:mermaid)\r?\n[\s\S]*?```/.test(markdown)
}

/**
 * Preprocess markdown by rendering all mermaid code blocks to high-resolution PNG images via Playwright.
 * Accepts an optional CSS stylesheet path or MermaidThemeConfig to drive all diagram styling dynamically.
 */
export async function preprocessMermaidInMarkdown(
  markdown: string,
  cssOrTheme?: string | MermaidThemeConfig,
): Promise<{ content: string; tempImages: string[] }> {
  const matches = scanMermaidBlocks(markdown)
  if (matches.length === 0) {
    return { content: markdown, tempImages: [] }
  }

  const themeConfig =
    typeof cssOrTheme === "object" && "theme" in cssOrTheme
      ? cssOrTheme
      : parseMermaidThemeFromCss(cssOrTheme)

  const tempDir = join(tmpdir(), "opencode-mermaid")
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true })
  }

  const tempImages: string[] = []
  const renderedMap = new Map<string, string>()

  const renderPayload = matches.map((m, i) => ({
    id: `mermaid_diag_${i + 1}`,
    code: m.code,
    outputPath: join(tempDir, `mermaid-${Date.now()}-${i + 1}.png`),
  }))

  const localMermaidJs = join(__dirname, "assets", "mermaid.min.js")
  const hasLocalJs = existsSync(localMermaidJs)

  const diagramCss = `
    body { margin: 0; padding: 32px; display: inline-block; background: ${themeConfig.background} !important; }
    svg { max-width: none !important; width: auto !important; height: auto !important; background: ${themeConfig.background} !important; }
    
    /* 1. Clear black rects behind text labels */
    .label rect, .edgeLabel rect, .node .label rect, g.label > rect {
      fill: transparent !important;
      stroke: none !important;
    }

    /* 2. Standardize entity nodes as modern light cards */
    .node rect, .node circle, .node polygon,
    .statediagram-state rect.basic,
    .statediagram-state rect,
    .stateGroup rect, .classGroup rect,
    g.stateGroup > rect, .actor,
    .node.default > rect, .node.default > circle {
      fill: ${themeConfig.primaryColor} !important;
      stroke: ${themeConfig.primaryBorderColor} !important;
      stroke-width: ${themeConfig.nodeStrokeWidth} !important;
      rx: 4px !important;
      ry: 4px !important;
    }

    /* 3. Edge label text pill background */
    .edgeLabel .label div, .edgeLabel span {
      background: ${themeConfig.tertiaryColor} !important;
      padding: 2px 6px !important;
      border-radius: 4px !important;
      border: 1px solid #E2E8F0 !important;
    }

    /* 4. Text typography and high-contrast color */
    .label, .nodeLabel, .stateLabel, .edgeLabel, text, tspan, span {
      fill: ${themeConfig.primaryTextColor} !important;
      color: ${themeConfig.primaryTextColor} !important;
      font-family: ${themeConfig.fontFamily} !important;
      font-size: ${themeConfig.fontSize} !important;
    }

    /* 5. Edge lines and arrow markers */
    .edgePath .path, .transition, .flowchart-link, path.link {
      stroke: ${themeConfig.lineColor} !important;
      stroke-width: ${themeConfig.edgeStrokeWidth} !important;
    }
    #arrowhead path, #crosshead path, #filled-head path, #statediagram-barbEnd, [id*="statediagram-barbEnd"] path, [id*="barbEnd"] path {
      fill: ${themeConfig.lineColor} !important;
      stroke: ${themeConfig.lineColor} !important;
    }

    /* 6. State diagram start/end nodes */
    circle.state-start, .statediagram-state .start-state {
      fill: ${themeConfig.accentColor} !important;
      stroke: ${themeConfig.accentColor} !important;
    }
    circle.state-end, .statediagram-state .end-state-inner {
      fill: ${themeConfig.accentColor} !important;
      stroke: ${themeConfig.tertiaryColor} !important;
    }

    /* 7. ER diagram entity, relationship lines, and non-filled crow's foot markers */
    .er.entityBox, [id*="entity-"] rect, [class*="entityBox"] {
      fill: ${themeConfig.primaryColor} !important;
      stroke: ${themeConfig.primaryBorderColor} !important;
      stroke-width: ${themeConfig.nodeStrokeWidth} !important;
      rx: 6px !important;
      ry: 6px !important;
    }
    .er.entityLabel, text.er.entityLabel, text[class*="entityLabel"], text.entityTitleText {
      fill: ${themeConfig.primaryTextColor} !important;
      font-weight: 600 !important;
      font-size: 13px !important;
    }
    .er.relationshipLine, path.er.relationshipLine, [class*="relationshipLine"] {
      stroke: ${themeConfig.lineColor} !important;
      stroke-width: ${themeConfig.edgeStrokeWidth} !important;
      fill: none !important;
    }
    .er.relationshipLabelBox, rect.er.relationshipLabelBox, rect[class*="relationshipLabelBox"] {
      fill: ${themeConfig.tertiaryColor} !important;
      stroke: ${themeConfig.cardBorderColor} !important;
      stroke-width: 1px !important;
      rx: 4px !important;
      ry: 4px !important;
      opacity: 1 !important;
    }
    .er.relationshipLabel, text.er.relationshipLabel, text[class*="relationshipLabel"] {
      fill: ${themeConfig.accentColor} !important;
      font-weight: 600 !important;
      font-size: 11px !important;
    }
    /* Clean ER Crow's Foot markers: ensure lines are crisp and avoid giant solid fills */
    marker[id*="_ONE_"] path, marker[id*="_MORE_"] path, marker[id*="ONLY_ONE"] path, marker[id*="ZERO_OR_"] path {
      fill: none !important;
      stroke: ${themeConfig.lineColor} !important;
      stroke-width: 1.5px !important;
    }
    marker[id*="ZERO_"] circle, marker[id*="ZERO_OR_"] circle {
      fill: ${themeConfig.tertiaryColor} !important;
      stroke: ${themeConfig.lineColor} !important;
      stroke-width: 1.5px !important;
    }

    /* 8. Sequence diagram participants, lifelines, message lines and fragments */
    rect.actor, rect.actor-top, rect.actor-bottom, g[id*="root-"] rect {
      fill: ${themeConfig.primaryColor} !important;
      stroke: ${themeConfig.primaryBorderColor} !important;
      stroke-width: ${themeConfig.nodeStrokeWidth} !important;
      rx: 4px !important;
      ry: 4px !important;
    }
    text.actor, text.actor > tspan, g[id*="root-"] text {
      fill: ${themeConfig.primaryTextColor} !important;
      color: ${themeConfig.primaryTextColor} !important;
      font-weight: 600 !important;
      font-size: 14px !important;
    }
    .actor-line, line[id*="actor"] {
      stroke: ${themeConfig.lifelineColor} !important;
      stroke-width: 1.5px !important;
    }
    .messageLine0, .messageLine1, line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1 {
      stroke: ${themeConfig.lineColor} !important;
      stroke-width: ${themeConfig.edgeStrokeWidth} !important;
    }
    .messageText, text.messageText, text.messageText > tspan {
      fill: ${themeConfig.primaryTextColor} !important;
      color: ${themeConfig.primaryTextColor} !important;
      font-size: ${themeConfig.fontSize} !important;
    }
    #arrowhead path, #crosshead path, #filled-head path {
      fill: ${themeConfig.lineColor} !important;
      stroke: ${themeConfig.lineColor} !important;
    }
    .labelBox, polygon.labelBox, g polygon.labelBox {
      fill: ${themeConfig.secondaryColor} !important;
      stroke: ${themeConfig.primaryBorderColor} !important;
      stroke-width: ${themeConfig.nodeStrokeWidth} !important;
    }
    .labelText, text.labelText, text.labelText > tspan {
      fill: ${themeConfig.accentColor} !important;
      font-weight: bold !important;
      font-size: ${themeConfig.fontSize} !important;
    }
    .loopText, text.loopText, text.loopText > tspan {
      fill: ${themeConfig.primaryTextColor} !important;
      font-weight: 500 !important;
      font-size: ${themeConfig.fontSize} !important;
    }
    .loopLine {
      stroke: ${themeConfig.secondaryBorderColor} !important;
      stroke-dasharray: 3, 3 !important;
    }
  `

  const script = `
const { chromium } = require(${JSON.stringify(playwrightRequirePath())});
const fs = require('fs');

(async () => {
  const payload = ${JSON.stringify(renderPayload)};
  const themeCfg = ${JSON.stringify(themeConfig)};
  const localJsPath = ${JSON.stringify(hasLocalJs ? localMermaidJs : "")};
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 3840, height: 2160 },
      deviceScaleFactor: 3,
    });
    
    if (localJsPath && fs.existsSync(localJsPath)) {
      await page.setContent(\`
        <!DOCTYPE html>
        <html>
          <head>
            <style>\${${JSON.stringify(diagramCss)}}</style>
          </head>
          <body><div id="container"></div></body>
        </html>
      \`);
      await page.addScriptTag({ path: localJsPath });
    } else {
      await page.setContent(\`
        <!DOCTYPE html>
        <html>
          <head>
            <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
            <style>\${${JSON.stringify(diagramCss)}}</style>
          </head>
          <body><div id="container"></div></body>
        </html>
      \`, { waitUntil: 'load' });
    }

    await page.evaluate((themeCfg) => {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: themeCfg.theme,
        flowchart: { useMaxWidth: false, htmlLabels: true },
        sequence: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
        journey: { useMaxWidth: false },
        class: { useMaxWidth: false },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
        themeVariables: {
          primaryColor: themeCfg.primaryColor,
          primaryTextColor: themeCfg.primaryTextColor,
          primaryBorderColor: themeCfg.primaryBorderColor,
          lineColor: themeCfg.lineColor,
          secondaryColor: themeCfg.secondaryColor,
          tertiaryColor: themeCfg.tertiaryColor,
          fontFamily: themeCfg.fontFamily,
          fontSize: themeCfg.fontSize,
          actorBkg: themeCfg.primaryColor,
          actorBorder: themeCfg.primaryBorderColor,
          actorTextColor: themeCfg.primaryTextColor,
          actorLineColor: themeCfg.lifelineColor,
          signalColor: themeCfg.lineColor,
          signalTextColor: themeCfg.primaryTextColor,
          labelBoxBkgColor: themeCfg.secondaryColor,
          labelBoxBorderColor: themeCfg.primaryBorderColor,
          labelTextColor: themeCfg.accentColor,
          loopTextColor: themeCfg.primaryTextColor,
          activationBorderColor: themeCfg.primaryBorderColor,
          activationBkgColor: themeCfg.secondaryColor
        }
      });
    }, themeCfg);

    for (const item of payload) {
      try {
        const svg = await page.evaluate(async ({ id, code }) => {
          const { svg } = await window.mermaid.render(id, code);
          return svg;
        }, { id: item.id, code: item.code });

        await page.evaluate(({ svgContent, themeCfg }) => {
          const container = document.getElementById('container');
          container.innerHTML = svgContent;
          const svgEl = container.querySelector('svg');
          if (svgEl) {
            // 1. Clear black rects behind text labels
            svgEl.querySelectorAll('.edgeLabel rect, .label rect, g.label rect').forEach((r) => {
              r.setAttribute('fill', themeCfg.tertiaryColor);
              r.setAttribute('stroke', themeCfg.cardBorderColor);
              r.setAttribute('stroke-width', '1');
              r.setAttribute('rx', '4');
              r.setAttribute('ry', '4');
              r.style.fill = themeCfg.tertiaryColor;
              r.style.stroke = themeCfg.cardBorderColor;
            });
            // 2. Standardize text typography and contrast
            svgEl.querySelectorAll('.edgeLabel span, .edgeLabel div, .edgeLabel text, .label text, .nodeLabel, text.er, .loopText, text.messageText').forEach((t) => {
              t.style.color = themeCfg.primaryTextColor;
              t.style.fill = themeCfg.primaryTextColor;
              t.setAttribute('fill', themeCfg.primaryTextColor);
            });
            // 3. Harmonize sequence diagram actor boxes and text
            svgEl.querySelectorAll('rect.actor, rect.actor-top, rect.actor-bottom, g[id*="root-"] rect').forEach((r) => {
              r.setAttribute('fill', themeCfg.primaryColor);
              r.setAttribute('stroke', themeCfg.primaryBorderColor);
              r.setAttribute('stroke-width', themeCfg.nodeStrokeWidth);
              r.setAttribute('rx', '4');
              r.setAttribute('ry', '4');
              r.style.fill = themeCfg.primaryColor;
              r.style.stroke = themeCfg.primaryBorderColor;
            });
            svgEl.querySelectorAll('text.actor, text.actor tspan, g[id*="root-"] text').forEach((t) => {
              t.setAttribute('fill', themeCfg.primaryTextColor);
              t.style.fill = themeCfg.primaryTextColor;
              t.style.color = themeCfg.primaryTextColor;
              t.style.fontWeight = '600';
            });
            // 4. Harmonize message lines, lifelines, and markers
            svgEl.querySelectorAll('line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1').forEach((l) => {
              l.setAttribute('stroke', themeCfg.lineColor);
              l.setAttribute('stroke-width', themeCfg.edgeStrokeWidth);
              l.style.stroke = themeCfg.lineColor;
            });
            svgEl.querySelectorAll('line.actor-line, line[id*="actor"]').forEach((al) => {
              al.setAttribute('stroke', themeCfg.lifelineColor);
              al.style.stroke = themeCfg.lifelineColor;
            });
            svgEl.querySelectorAll('marker path, #statediagram-barbEnd, [id*="barbEnd"], #arrowhead path, #crosshead path, #filled-head path').forEach((m) => {
              m.setAttribute('fill', themeCfg.lineColor);
              m.setAttribute('stroke', themeCfg.lineColor);
              m.style.fill = themeCfg.lineColor;
            });
            // 5. Clean sequence diagram loop / alt polygon headers
            svgEl.querySelectorAll('.labelBox, polygon.labelBox, polygon').forEach((p) => {
              p.setAttribute('fill', themeCfg.secondaryColor);
              p.setAttribute('stroke', themeCfg.primaryBorderColor);
              p.setAttribute('stroke-width', themeCfg.nodeStrokeWidth);
              p.style.fill = themeCfg.secondaryColor;
              p.style.stroke = themeCfg.primaryBorderColor;
            });
            svgEl.querySelectorAll('.labelText, .labelText tspan').forEach((t) => {
              t.setAttribute('fill', themeCfg.accentColor);
              t.style.fill = themeCfg.accentColor;
              t.style.color = themeCfg.accentColor;
            });
            // 6. Enhance ER diagram entity boxes, markers, and relationship labels
            svgEl.querySelectorAll('.er.entityBox, [id*="entity-"] rect, [class*="entityBox"]').forEach((e) => {
              e.setAttribute('fill', themeCfg.primaryColor);
              e.setAttribute('stroke', themeCfg.primaryBorderColor);
              e.setAttribute('stroke-width', themeCfg.nodeStrokeWidth);
              e.setAttribute('rx', '6');
              e.setAttribute('ry', '6');
              e.style.fill = themeCfg.primaryColor;
              e.style.stroke = themeCfg.primaryBorderColor;
            });
            svgEl.querySelectorAll('.er.relationshipLine, path[class*="relationshipLine"]').forEach((l) => {
              l.setAttribute('stroke', themeCfg.lineColor);
              l.setAttribute('stroke-width', themeCfg.edgeStrokeWidth);
              l.setAttribute('fill', 'none');
              l.style.stroke = themeCfg.lineColor;
              l.style.fill = 'none';
            });
            svgEl.querySelectorAll('marker[id*="_ONE_"] path, marker[id*="_MORE_"] path, marker[id*="ONLY_ONE"] path, marker[id*="ZERO_OR_"] path').forEach((p) => {
              p.setAttribute('fill', 'none');
              p.setAttribute('stroke', themeCfg.lineColor);
              p.setAttribute('stroke-width', '1.5');
              p.style.fill = 'none';
              p.style.stroke = themeCfg.lineColor;
            });
            svgEl.querySelectorAll('marker[id*="ZERO_"] circle, marker[id*="ZERO_OR_"] circle').forEach((c) => {
              c.setAttribute('fill', themeCfg.tertiaryColor);
              c.setAttribute('stroke', themeCfg.lineColor);
              c.setAttribute('stroke-width', '1.5');
              c.style.fill = themeCfg.tertiaryColor;
              c.style.stroke = themeCfg.lineColor;
            });
            svgEl.querySelectorAll('.er.relationshipLabelBox, rect[class*="relationshipLabelBox"]').forEach((b) => {
              b.setAttribute('fill', themeCfg.tertiaryColor);
              b.setAttribute('stroke', themeCfg.cardBorderColor);
              b.setAttribute('stroke-width', '1');
              b.setAttribute('rx', '4');
              b.setAttribute('ry', '4');
              b.setAttribute('opacity', '1');
              b.style.fill = themeCfg.tertiaryColor;
              b.style.stroke = themeCfg.cardBorderColor;
              b.style.opacity = '1';
            });
            svgEl.querySelectorAll('.er.relationshipLabel, text[class*="relationshipLabel"]').forEach((t) => {
              t.setAttribute('fill', themeCfg.accentColor);
              t.style.fill = themeCfg.accentColor;
              t.style.color = themeCfg.accentColor;
              t.style.fontWeight = '600';
              t.style.fontSize = '11px';
            });
            // 7. Inject top-level !important styles
            const svgStyle = document.createElement('style');
            svgStyle.textContent = \`
              .edgeLabel rect, .label rect, g.label > rect { fill: \${themeCfg.tertiaryColor} !important; stroke: \${themeCfg.cardBorderColor} !important; stroke-width: 1px !important; }
              .edgeLabel span, .edgeLabel div, .edgeLabel text { color: \${themeCfg.primaryTextColor} !important; fill: \${themeCfg.primaryTextColor} !important; }
              rect.basic { fill: \${themeCfg.primaryColor} !important; stroke: \${themeCfg.primaryBorderColor} !important; }
              rect.actor, rect.actor-top, rect.actor-bottom { fill: \${themeCfg.primaryColor} !important; stroke: \${themeCfg.primaryBorderColor} !important; }
              text.actor { fill: \${themeCfg.primaryTextColor} !important; font-weight: 600 !important; }
              .messageLine0, .messageLine1 { stroke: \${themeCfg.lineColor} !important; stroke-width: \${themeCfg.edgeStrokeWidth} !important; }
              .messageText { fill: \${themeCfg.primaryTextColor} !important; }
              .statediagram-state .start-state, circle.state-start { fill: \${themeCfg.accentColor} !important; stroke: \${themeCfg.accentColor} !important; }
              .statediagram-state .end-state-inner, circle.state-end { fill: \${themeCfg.accentColor} !important; }
              .er.entityBox { fill: \${themeCfg.primaryColor} !important; stroke: \${themeCfg.primaryBorderColor} !important; stroke-width: \${themeCfg.nodeStrokeWidth} !important; rx: 6px !important; ry: 6px !important; }
              .er.entityLabel, text.er.entityLabel, text[class*="entityLabel"], text.entityTitleText { fill: \${themeCfg.primaryTextColor} !important; font-weight: 600 !important; }
              .er.relationshipLine, path[class*="relationshipLine"] { stroke: \${themeCfg.lineColor} !important; stroke-width: \${themeCfg.edgeStrokeWidth} !important; fill: none !important; }
              marker[id*="_ONE_"] path, marker[id*="_MORE_"] path, marker[id*="ONLY_ONE"] path, marker[id*="ZERO_OR_"] path { fill: none !important; stroke: \${themeCfg.lineColor} !important; stroke-width: 1.5px !important; }
              marker[id*="ZERO_"] circle, marker[id*="ZERO_OR_"] circle { fill: \${themeCfg.tertiaryColor} !important; stroke: \${themeCfg.lineColor} !important; stroke-width: 1.5px !important; }
              .er.relationshipLabelBox, rect[class*="relationshipLabelBox"] { fill: \${themeCfg.tertiaryColor} !important; stroke: \${themeCfg.cardBorderColor} !important; rx: 4px !important; ry: 4px !important; opacity: 1 !important; }
              .er.relationshipLabel, text[class*="relationshipLabel"] { fill: \${themeCfg.accentColor} !important; font-weight: 600 !important; }
              .labelBox, polygon.labelBox, g polygon.labelBox { fill: \${themeCfg.secondaryColor} !important; stroke: \${themeCfg.primaryBorderColor} !important; }
              .labelText, text.labelText { fill: \${themeCfg.accentColor} !important; }
            \`;
            svgEl.appendChild(svgStyle);
          }
        }, { svgContent: svg, themeCfg });

        const svgElement = await page.$('#container svg');
        if (svgElement) {
          await svgElement.screenshot({
            path: item.outputPath,
            type: 'png',
            omitBackground: false,
          });
        }
      } catch (err) {
        console.error('Failed to render diagram ' + item.id + ':', err.message);
      }
    }
  } finally {
    await browser.close();
  }
})();
`

  const scriptPath = join(tempDir, `render-worker-${Date.now()}.js`)
  try {
    writeFileSync(scriptPath, script, "utf8")
    const isBun = typeof process !== "undefined" && (process.execPath?.includes("bun") || Boolean((process.versions as Record<string, string>)?.bun))
    const nodeExecutable = isBun ? "node" : (process.execPath || "node")
    execFileSync(nodeExecutable, [scriptPath], {
      stdio: "pipe",
      timeout: 60000,
    })

    for (const item of renderPayload) {
      if (existsSync(item.outputPath)) {
        tempImages.push(item.outputPath)
        renderedMap.set(item.code, item.outputPath)
      }
    }
  } catch (err) {
    console.warn("[MermaidRenderer] Warning: Playwright render execution failed, keeping original code blocks:", (err as Error).message)
  } finally {
    if (existsSync(scriptPath)) {
      try {
        unlinkSync(scriptPath)
      } catch {}
    }
  }

  // Replace mermaid code blocks with image markdown syntax
  let processedContent = markdown
  for (const match of matches) {
    const imgPath = renderedMap.get(match.code)
    if (imgPath && existsSync(imgPath)) {
      const normalizedPath = imgPath.replace(/\\/g, "/")
      const imageTag = `\n\n![Mermaid Diagram](${normalizedPath})\n\n`
      processedContent = processedContent.replace(match.fullMatch, imageTag)
    }
  }

  return {
    content: processedContent,
    tempImages,
  }
}

/**
 * Safely clean up all temporary mermaid images.
 */
export function cleanupMermaidTempImages(tempImages: string[]): void {
  for (const img of tempImages) {
    if (existsSync(img)) {
      try {
        unlinkSync(img)
      } catch {}
    }
  }
}
