/// <reference types="bun" />
import type { Plugin } from "@opencode/plugin"
import { mkdirSync, existsSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

/**
 * Browser Screenshot Plugin — registers a custom `browser_screenshot` tool
 * that agents (especially @vision and @frontend-dev) can call to capture
 * screenshots of web pages via Playwright's headless browser.
 *
 * The screenshot is saved as a PNG file and returned as structured content
 * (text + image file part), so the LLM can directly "see" the image in the
 * same turn — no manual file reading step needed.
 *
 * v2 mapping notes:
 *  - v1 `tool({...})` map → ctx.tool.transform editor.add with
 *    options.codemode:false (first-class model tool).
 *  - v1 `attachments:[{type:"file",mime,url:<path>}]` → v2 content
 *    FileContent part. The v2 image pipeline (core tool.ts normalizeImages)
 *    only processes `data:` URIs, so the PNG bytes are inlined as a base64
 *    data URI — a bare filesystem path would not render for the model.
 *  - v1 result `title` + `context.metadata()` have no v2 equivalent; the
 *    information stays in `metadata` / the text part.
 *
 * Features:
 *  - Navigate to any URL
 *  - Configurable viewport (desktop / mobile presets or custom)
 *  - Full-page or viewport-only screenshot
 *  - Element-scoped screenshot via CSS selector
 *  - Wait for selector / network idle before capturing
 *
 * Dependencies:
 *  - playwright (auto-installed on first use via `bunx playwright install`)
 *
 * Tool: browser_screenshot
 *   Args:
 *     url         (string, required) — URL to navigate to
 *     fullPage    (boolean, optional, default false) — capture full scrollable page
 *     viewport    (object, optional) — { width, height } in px; defaults to 1440x900
 *     device      (string, optional) — preset: "desktop" | "mobile" | "tablet"
 *     selector    (string, optional) — CSS selector to screenshot a specific element
 *     waitUntil   (string, optional) — "load" | "domcontentloaded" | "networkidle" (default "load")
 *     timeout     (number, optional) — navigation timeout in ms (default 30000)
 */

// ─── Constants ────────────────────────────────────────────────────────

const SCREENSHOT_DIR = join(homedir(), ".config", "opencode", ".screenshots")

const DEVICE_PRESETS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
}

const BROWSER_SCREENSHOT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "URL to navigate to (e.g. 'http://localhost:3000', 'https://example.com')" },
    fullPage: { type: "boolean", description: "Capture the full scrollable page, not just the viewport. Default: false" },
    viewport: {
      type: "object",
      properties: {
        width: { type: "number", description: "Viewport width in px" },
        height: { type: "number", description: "Viewport height in px" },
      },
      required: ["width", "height"],
      description: "Custom viewport dimensions. Overrides 'device' preset.",
    },
    device: { type: "string", enum: ["desktop", "mobile", "tablet"], description: "Device preset for viewport. desktop=1440x900, tablet=768x1024, mobile=375x812. Default: desktop" },
    selector: { type: "string", description: "CSS selector to screenshot a specific element instead of the whole page" },
    waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], description: "When to consider navigation complete. Default: 'load'" },
    timeout: { type: "number", description: "Navigation timeout in milliseconds. Default: 30000" },
  },
  required: ["url"],
}

// ─── Playwright lazy loader ──────────────────────────────────────────
// Playwright is a heavy dependency. Load it lazily so plugins that don't
// use screenshots don't pay the import cost.

// playwright ships no types resolvable from this dependency-free plugin;
// every boundary below is runtime-untyped by necessity.
let playwrightModule: any = null

async function loadPlaywright(): Promise<any> {
  if (playwrightModule) return playwrightModule

  // Step 1: ensure the playwright npm package is importable
  try {
    playwrightModule = await import("playwright")
  } catch {
    // npm package not installed — can't proceed via bunx alone
    throw new Error(
      "Playwright npm package is not installed. Run: bun add playwright",
    )
  }

  // Step 2: ensure the Chromium browser binary is installed
  try {
    // Verify the browser is available by launching a quick throwaway instance
    const probe = await playwrightModule.chromium.launch({ headless: true })
    await probe.close()
  } catch {
    // Browser binary missing — download it via `playwright install`
    try {
      const { exitCode } = await Bun.$`bunx playwright install chromium`.quiet()
      if (exitCode !== 0) {
        throw new Error("Failed to install Playwright chromium browser")
      }
    } catch (installErr) {
      throw new Error(
        "Chromium browser binary not found and auto-install failed.\n" +
        "Run: bunx playwright install chromium\n" +
        `Original error: ${(installErr as Error).message}`,
      )
    }
  }

  return playwrightModule
}

// ─── Screenshot capture ──────────────────────────────────────────────

interface ScreenshotOptions {
  url: string
  fullPage?: boolean
  viewport?: { width: number; height: number }
  device?: string
  selector?: string
  waitUntil?: string
  timeout?: number
}

async function captureScreenshot(opts: ScreenshotOptions): Promise<{ path: string; width: number; height: number }> {
  const pw = await loadPlaywright()

  // Resolve viewport
  const preset = opts.device ? DEVICE_PRESETS[opts.device] : undefined
  const viewport = opts.viewport ?? preset ?? { width: 1440, height: 900 }

  // Launch browser — keep the try-finally tight so that if any step
  // fails (launch, newContext, newPage, goto), we still clean up the
  // resources that *were* successfully created.
  let browser: any = null
  let context: any = null
  let page: any = null

  try {
    browser = await pw.chromium.launch({ headless: true })
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2, // retina-quality screenshots
    })
    page = await context.newPage()

    // Navigate
    await page.goto(opts.url, {
      waitUntil: opts.waitUntil || "load",
      timeout: opts.timeout || 30000,
    })

    // Ensure screenshot dir exists
    if (!existsSync(SCREENSHOT_DIR)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true })
    }

    const filename = `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.png`
    const filepath = join(SCREENSHOT_DIR, filename)

    // Capture
    if (opts.selector) {
      const element = await page.$(opts.selector)
      if (!element) {
        throw new Error(`Element not found: selector "${opts.selector}"`)
      }
      await element.screenshot({ path: filepath, type: "png" })
    } else {
      await page.screenshot({
        path: filepath,
        type: "png",
        fullPage: opts.fullPage || false,
      })
    }

    return { path: filepath, width: viewport.width, height: viewport.height }
  } finally {
    // Close in reverse order; each may be null if an earlier step failed
    if (page) await page.close().catch(() => {})
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
  }
}

// ─── Tool execution ──────────────────────────────────────────────────

/**
 * Inline the PNG as a base64 data URI content part — v2's image
 * normalization only understands data: URIs (core/src/tool.ts
 * normalizeImages), and it resizes oversized images before the provider
 * call, which a bare path would silently miss.
 */
async function imageContentPart(filepath: string): Promise<{ type: "file"; uri: string; mime: string; name: string }> {
  const base64 = Buffer.from(await Bun.file(filepath).arrayBuffer()).toString("base64")
  return { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: basename(filepath) }
}

/** Structural slice of v2 Tool.Content (schema/tool.ts TextContent/FileContent). */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string }

async function runScreenshot(args: ScreenshotOptions): Promise<{ content: ContentPart[]; metadata: Record<string, unknown> }> {
  const opts = args
  try {
    const result = await captureScreenshot(opts)
    const text = `Captured screenshot of ${opts.url} (${result.width}x${result.height}${opts.fullPage ? ", full page" : ""}${opts.selector ? `, selector: ${opts.selector}` : ""})\nSaved to: ${result.path}`
    return {
      content: [
        { type: "text", text },
        await imageContentPart(result.path),
      ],
      metadata: {
        url: opts.url,
        viewport: `${result.width}x${result.height}`,
        fullPage: opts.fullPage || false,
        device: opts.device || "desktop",
        selector: opts.selector || null,
        screenshotPath: result.path,
      },
    }
  } catch (err) {
    const message = (err as Error).message
    return {
      content: [
        {
          type: "text",
          text: `Failed to capture screenshot of ${opts.url}:\n${message}\n\n` +
            "Troubleshooting:\n" +
            "  1. Is the URL accessible? Try: curl -I <url>\n" +
            "  2. Is Playwright installed? Run: bun add playwright && bunx playwright install chromium\n" +
            "  3. Is the selector valid? Check the page structure first.",
        },
      ],
      metadata: {
        url: opts.url,
        error: message,
      },
    }
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────

const plugin: Plugin.Plugin = {
  id: "opencode-prime.browser-screenshot",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "browser_screenshot",
        description:
          "Capture a screenshot of a web page using a headless browser (Playwright/Chromium). " +
          "The screenshot is returned as an image attachment that you can analyze directly. " +
          "Use this to: debug UI issues, verify visual changes, check responsive layouts, " +
          "audit accessibility, or compare designs. " +
          "EXPENSIVE: launches a full Chromium instance each call. " +
          "NEVER call more than once per turn. Skip if no dev server or no visual change. " +
          "Example: browser_screenshot({ url: 'http://localhost:3000', device: 'mobile' })",
        input: BROWSER_SCREENSHOT_INPUT_SCHEMA,
        // codemode:false -> first-class model tool, visible to the provider.
        options: { codemode: false },
        // v2 validates input against the JSON schema before we get here.
        execute: async (args) => runScreenshot(args as ScreenshotOptions),
      })
    })
  },
}

export default plugin
