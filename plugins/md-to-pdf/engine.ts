import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync } from "node:fs"
import { resolve, isAbsolute, join, dirname, basename, relative } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { buildInjectedStyle } from "./style"
import { preprocessMermaidInMarkdown, cleanupMermaidTempImages } from "../shared/mermaid-renderer"
import { tmpdir } from "node:os"

export interface ConversionOptions {
  inputPath: string
  outputPath?: string
  customCss?: string
  format?: "A4" | "Letter" | "Legal" | "Tabloid"
  viewport?: { width: number; height: number }
  keepHtml?: boolean
}

export interface ConversionResult {
  inputPath: string
  outputPath: string
  fileSizeBytes: number
  htmlPath?: string
}

import { getProjectLogDir, ocpArtifactPath } from "../shared/opencode-prime"

export { getProjectLogDir }

export function writeErrorLog(
  action: string,
  error: Error | string,
  extraDetails: string = "",
  projectDir: string = process.cwd(),
): string {
  const logDir = getProjectLogDir(projectDir)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const logFile = join(logDir, `md-to-pdf-${timestamp}.log`)

  const errorMsg = typeof error === "string" ? error : error.message
  const errorStack = error instanceof Error ? error.stack || "" : ""

  const logContent = `======================================================================
MD-TO-PDF ERROR LOG
Timestamp: ${new Date().toISOString()}
Action: ${action}
======================================================================

[Error Message]
${errorMsg}

[Stack Trace]
${errorStack}

[Execution Details]
${extraDetails}
`

  try {
    writeFileSync(logFile, logContent, "utf8")
    return logFile
  } catch {
    return ""
  }
}

export function formatFriendlyErrorMessage(
  inputFile: string,
  rawError: string,
  logPath: string,
  projectDir: string = process.cwd(),
): string {
  const displayLogPath = logPath.startsWith(projectDir)
    ? relative(projectDir, logPath)
    : logPath

  const firstLine = rawError.trim().split("\n")[0] || ""
  const isShortAndClean = firstLine.length > 0 && firstLine.length <= 120 && !firstLine.includes("at ") && !firstLine.includes("node -e")

  let cause = isShortAndClean ? firstLine : "Rendering failed"
  let guide = ""

  if (rawError.includes("Pandoc executable not found") || rawError.includes("pandoc")) {
    cause = "Pandoc parser is not installed"
    guide = `💡 How to install Pandoc:
  • Windows: winget install JohnMacFarlane.Pandoc  (or choco install pandoc)
  • macOS:   brew install pandoc
  • Linux:   sudo apt-get install pandoc`
  } else if (rawError.includes("ENOSPC") || rawError.includes("no space left")) {
    cause = "Disk space is full on system drive"
    guide = `💡 How to resolve:
  • Free up disk space on your system drive (C:)
  • Or run \`npx playwright install chromium\` with PLAYWRIGHT_BROWSERS_PATH on another drive`
  } else if (
    rawError.includes("Executable doesn't exist") ||
    rawError.includes("playwright install") ||
    rawError.includes("Chromium")
  ) {
    cause = "Playwright Chromium browser binary is not installed"
    guide = `💡 How to install Playwright browser:
  • Run: npx playwright install chromium
  • Or run in OpenCode: /md-to-pdf --install-deps`
  } else {
    guide = `💡 Tip: Check input markdown syntax or run \`/md-to-pdf --doctor\` to verify environment health.`
  }

  const logNotice = logPath
    ? `📋 Detailed error log saved to:\n  👉 ${displayLogPath}\n  (Please open or check this log file for full debug stack trace)`
    : ""

  return `❌ Failed to render PDF from ${inputFile}
Cause: ${cause}

${guide}

${logNotice}`
}

export function checkPandoc(): boolean {
  try {
    const res = spawnSync("pandoc", ["--version"], { stdio: "ignore" })
    return res.status === 0
  } catch {
    return false
  }
}

export function checkNode(): boolean {
  try {
    const res = spawnSync("node", ["--version"], { stdio: "ignore" })
    return res.status === 0
  } catch {
    return false
  }
}

export function checkChromium(): boolean {
  try {
    const testCode = "const { chromium } = require('playwright'); chromium.launch({ headless: true }).then(b => b.close());"
    const res = spawnSync("node", ["-e", testCode], { stdio: "ignore" })
    return res.status === 0
  } catch {
    return false
  }
}

function getInstallationEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const dDriveTemp = "D:\\.tmp"
  const dDriveBrowsers = "D:\\.ms-playwright"

  if (process.platform === "win32" && existsSync("D:\\")) {
    if (!existsSync(dDriveTemp)) {
      try { mkdirSync(dDriveTemp, { recursive: true }) } catch {}
    }
    if (!existsSync(dDriveBrowsers)) {
      try { mkdirSync(dDriveBrowsers, { recursive: true }) } catch {}
    }
    env.TEMP = dDriveTemp
    env.TMP = dDriveTemp
    if (!env.PLAYWRIGHT_BROWSERS_PATH) {
      env.PLAYWRIGHT_BROWSERS_PATH = dDriveBrowsers
    }
  }

  return env
}

export function autoInstallChromium(projectDir: string = process.cwd()): { success: boolean; message: string; logFile?: string } {
  try {
    const env = getInstallationEnv()
    const proc = spawnSync("npx", ["playwright", "install", "chromium"], {
      stdio: "pipe",
      encoding: "utf8",
      shell: true,
      env,
    })

    const output = proc.stdout + "\n" + proc.stderr
    if (proc.status !== 0) {
      const logFile = writeErrorLog("autoInstallChromium", proc.stderr || "Playwright install returned non-zero exit code", output, projectDir)
      return { success: false, message: "Chromium download/install failed", logFile }
    }

    return {
      success: true,
      message: proc.stdout || "Playwright chromium installed successfully.",
    }
  } catch (err) {
    const logFile = writeErrorLog("autoInstallChromium", err as Error, "", projectDir)
    return { success: false, message: (err as Error).message, logFile }
  }
}

export function autoInstallPandoc(projectDir: string = process.cwd()): { success: boolean; message: string; logFile?: string } {
  if (process.platform !== "win32") {
    return {
      success: false,
      message: "Automatic install currently supported via winget on Windows. On macOS run `brew install pandoc`.",
    }
  }

  try {
    const proc = spawnSync(
      "winget",
      ["install", "--id", "JohnMacFarlane.Pandoc", "-e", "--accept-source-agreements", "--accept-package-agreements"],
      { stdio: "pipe", encoding: "utf8", shell: true },
    )
    if (proc.status !== 0) {
      const logFile = writeErrorLog("autoInstallPandoc", proc.stderr || "winget install failed", proc.stdout + "\n" + proc.stderr, projectDir)
      return { success: false, message: "winget install pandoc failed", logFile }
    }
    return {
      success: true,
      message: proc.stdout || "Pandoc installed via winget",
    }
  } catch (err) {
    const logFile = writeErrorLog("autoInstallPandoc", err as Error, "", projectDir)
    return { success: false, message: (err as Error).message, logFile }
  }
}

export function ensurePandoc(projectDir: string = process.cwd()): void {
  if (checkPandoc()) return

  if (process.platform === "win32") {
    const installResult = autoInstallPandoc(projectDir)
    if (installResult.success && checkPandoc()) return
  }

  throw new Error("Pandoc executable not found in PATH")
}

/**
 * Clean up Pandoc's hardcoded column widths and protect short table cells (< 12 chars) from wrapping.
 */
export function optimizeHtmlTables(html: string): string {
  // 1. Remove hardcoded col widths in colgroup
  let optimized = html.replace(/<col\s+style="[^"]*width:[^"]*"[^>]*\/?>/gi, "<col />")

  // 2. Tag short cells (<= 12 characters without manual breaks) as nowrap
  optimized = optimized.replace(/<td([^>]*)>([\s\S]*?)<\/td>/gi, (match, attrs, content) => {
    const plainText = content.replace(/<[^>]+>/g, "").trim()
    const hasBlock = /<(br|p|div|ul|ol|table)\b/i.test(content)
    if (!hasBlock && plainText.length > 0 && plainText.length <= 12) {
      if (/class="/i.test(attrs)) {
        attrs = attrs.replace(/class="([^"]*)"/i, 'class="$1 cell-nowrap"')
      } else {
        attrs = `${attrs} class="cell-nowrap"`
      }
    }
    return `<td${attrs}>${content}</td>`
  })

  return optimized
}

export function renderMarkdownToHtml(
  mdAbsPath: string,
  htmlAbsPath: string,
  customCss?: string,
  projectDir: string = process.cwd(),
): void {
  ensurePandoc(projectDir)

  try {
    execFileSync(
      "pandoc",
      [
        mdAbsPath,
        "-f", "gfm",
        "-t", "html5",
        "-s",
        "--embed-resources",
        "--standalone",
        "--variable=colorlinks=false",
        "--syntax-highlighting=pygments",
        "-M", "document-css=false",
        "-o", htmlAbsPath,
      ],
      { stdio: "pipe" },
    )
  } catch (err) {
    const logFile = writeErrorLog(`renderMarkdownToHtml (${mdAbsPath})`, err as Error, "", projectDir)
    throw new Error(`Pandoc conversion failed (log: ${logFile})`)
  }

  const styleTag = buildInjectedStyle(customCss)
  let html = readFileSync(htmlAbsPath, "utf8")
  html = optimizeHtmlTables(html)
  if (html.includes("</head>")) {
    html = html.replace("</head>", `${styleTag}</head>`)
  } else {
    html = `${styleTag}\n${html}`
  }
  writeFileSync(htmlAbsPath, html, "utf8")
}

/**
 * Execute PDF rendering via Node.js + Playwright runner with auto-install retry
 */
export function renderHtmlToPdfViaNode(
  htmlAbsPath: string,
  pdfAbsPath: string,
  options?: { format?: string; viewport?: { width: number; height: number } },
  projectDir: string = process.cwd(),
  isRetry: boolean = false,
): void {
  const format = options?.format || "A4"
  const width = options?.viewport?.width || 1440
  const height = options?.viewport?.height || 2200
  const fileUrl = "file:///" + htmlAbsPath.replace(/\\/g, "/")

  const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: ${width}, height: ${height} } });
    await page.goto(${JSON.stringify(fileUrl)}, { waitUntil: 'load' });
    await page.pdf({
      path: ${JSON.stringify(pdfAbsPath)},
      format: ${JSON.stringify(format)},
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
`

  const env = getInstallationEnv()

  try {
    execFileSync("node", ["-e", script], {
      stdio: "pipe",
      encoding: "utf8",
      env,
    })
  } catch (err: any) {
    const stderr = err?.stderr || err?.stdout || (err as Error).message || ""

    // Auto-install dependency and retry if browser executable is missing
    if (!isRetry && (stderr.includes("Executable doesn't exist") || stderr.includes("playwright install"))) {
      const installRes = autoInstallChromium(projectDir)
      if (installRes.success) {
        return renderHtmlToPdfViaNode(htmlAbsPath, pdfAbsPath, options, projectDir, true)
      }
    }

    const logFile = writeErrorLog(`renderHtmlToPdf (${pdfAbsPath})`, err as Error, stderr, projectDir)
    throw new Error(formatFriendlyErrorMessage(pdfAbsPath, stderr, logFile, projectDir))
  }
}

/**
 * Convert a single markdown file into a styled PDF.
 */
export async function convertSingleFile(
  opts: ConversionOptions,
  projectDir: string = process.cwd(),
): Promise<ConversionResult> {
  const resolvedInput = isAbsolute(opts.inputPath)
    ? opts.inputPath
    : resolve(projectDir, opts.inputPath)

  if (!existsSync(resolvedInput)) {
    throw new Error(`Input markdown file not found: ${resolvedInput}`)
  }

  let resolvedOutput: string
  if (opts.outputPath) {
    resolvedOutput = isAbsolute(opts.outputPath)
      ? opts.outputPath
      : resolve(projectDir, opts.outputPath)
  } else {
    resolvedOutput = resolvedInput.replace(/\.md$/i, "") + ".pdf"
  }

  const baseDir = dirname(resolvedInput)
  const baseName = basename(resolvedInput, ".md")
  const tempDir = join(tmpdir(), `md2pdf-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
  const intermediateMd = join(tempDir, `${baseName}-preprocessed.md`)
  const tempHtmlPath = join(baseDir, `.${baseName}.tmp-${Date.now()}.html`)

  let tempImages: string[] = []

  try {
    // Stylesheet resolution priority: opts.customCss (path or string) > project root pdf-theme.css / pdf-style.css > builtin style.css
    let resolvedCssPath: string | undefined = undefined
    let resolvedCssContent: string | undefined = undefined

    if (opts.customCss) {
      const maybeFile = isAbsolute(opts.customCss) ? opts.customCss : resolve(projectDir, opts.customCss)
      if (existsSync(maybeFile)) {
        resolvedCssPath = maybeFile
        resolvedCssContent = readFileSync(maybeFile, "utf8")
      } else {
        resolvedCssContent = opts.customCss
      }
    }

    if (!resolvedCssContent) {
      const projectCss = ocpArtifactPath("md-to-pdf.css", projectDir)
      if (existsSync(projectCss)) {
        resolvedCssPath = projectCss
        resolvedCssContent = readFileSync(projectCss, "utf8")
      } else {
        resolvedCssPath = resolve(__dirname, "style.css")
        if (existsSync(resolvedCssPath)) {
          resolvedCssContent = readFileSync(resolvedCssPath, "utf8")
        }
      }
    }

    const rawMd = readFileSync(resolvedInput, "utf8")
    const preprocessed = await preprocessMermaidInMarkdown(rawMd, resolvedCssPath || resolvedCssContent)
    tempImages = preprocessed.tempImages
    writeFileSync(intermediateMd, preprocessed.content, "utf8")

    renderMarkdownToHtml(intermediateMd, tempHtmlPath, resolvedCssContent, projectDir)

    renderHtmlToPdfViaNode(tempHtmlPath, resolvedOutput, {
      format: opts.format,
      viewport: opts.viewport,
    }, projectDir)

    const stat = statSync(resolvedOutput)
    return {
      inputPath: resolvedInput,
      outputPath: resolvedOutput,
      fileSizeBytes: stat.size,
      htmlPath: opts.keepHtml ? tempHtmlPath : undefined,
    }
  } finally {
    cleanupMermaidTempImages(tempImages)
    if (existsSync(intermediateMd)) {
      try { unlinkSync(intermediateMd) } catch {}
    }
    if (!opts.keepHtml && existsSync(tempHtmlPath)) {
      try {
        unlinkSync(tempHtmlPath)
      } catch {}
    }
  }
}
