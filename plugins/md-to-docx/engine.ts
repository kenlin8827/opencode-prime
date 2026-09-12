import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync } from "node:fs"
import { resolve, isAbsolute, join, dirname, basename, relative } from "node:path"
import { spawnSync, execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { postprocessDocxXml } from "./postprocess.bundle"
import { preprocessMermaidInMarkdown, cleanupMermaidTempImages } from "../shared/mermaid-renderer"
import { loadThemeFromCssFile, DocxTheme } from "./style-parser"

export interface DocxConversionOptions {
  inputPath: string
  outputPath?: string
  company?: string
  tocDepth?: number
  stylePath?: string
}

export interface DocxConversionResult {
  inputPath: string
  outputPath: string
  fileSizeBytes: number
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
  const logFile = join(logDir, `md-to-docx-${timestamp}.log`)

  const errorMsg = typeof error === "string" ? error : error.message
  const errorStack = error instanceof Error ? error.stack || "" : ""

  const logContent = `======================================================================
MD-TO-DOCX ERROR LOG
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
  const isShortAndClean =
    firstLine.length > 0 &&
    firstLine.length <= 120 &&
    !firstLine.includes("at ") &&
    !firstLine.includes("node -e")

  let cause = isShortAndClean ? firstLine : "Conversion failed"
  let guide = ""

  if (rawError.includes("Pandoc executable not found") || rawError.includes("pandoc")) {
    cause = "Pandoc parser is not installed"
    guide = `💡 How to install Pandoc:
  • Windows: winget install JohnMacFarlane.Pandoc  (or choco install pandoc)
  • macOS:   brew install pandoc
  • Linux:   sudo apt-get install pandoc`
  } else {
    guide = `💡 Tip: Check input markdown syntax or run \`/md-to-docx --doctor\` to verify environment health.`
  }

  const logNotice = logPath
    ? `📋 Detailed error log saved to:\n  👉 ${displayLogPath}\n  (Please open or check this log file for full debug stack trace)`
    : ""

  return `❌ Failed to convert Markdown to DOCX for ${inputFile}
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

export function getReferenceDocxPath(projectDir: string = process.cwd()): string {
  const pluginRef = ocpArtifactPath("md-to-docx.docx", projectDir)
  if (existsSync(pluginRef)) return pluginRef

  const assetPath = resolve(__dirname, "assets", "reference.docx")
  if (existsSync(assetPath)) return assetPath

  return ""
}

/**
 * Convert a single markdown file into a styled Word (DOCX) document.
 */
export async function convertSingleFile(
  opts: DocxConversionOptions,
  projectDir: string = process.cwd(),
): Promise<DocxConversionResult> {
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
    resolvedOutput = resolvedInput.replace(/\.md$/i, "") + ".docx"
  }

  if (!checkPandoc()) {
    const logFile = writeErrorLog(`convertSingleFile (${resolvedInput})`, "Pandoc executable not found", "", projectDir)
    throw new Error(formatFriendlyErrorMessage(resolvedInput, "Pandoc executable not found in PATH", logFile, projectDir))
  }

  const baseDir = dirname(resolvedInput)
  const baseName = basename(resolvedInput, ".md")
  const tempDir = join(tmpdir(), `md2docx-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
  const intermediateMd = join(tempDir, `${baseName}-preprocessed.md`)

  let tempImages: string[] = []

  try {
    // 1. Resolve the stylesheet path (explicit CLI arg > project .ocp/md-to-docx.css
    //    > plugin built-in default)
    let themeCssPath = opts.stylePath
    if (!themeCssPath) {
      const projectCss = ocpArtifactPath("md-to-docx.css", projectDir)
      if (existsSync(projectCss)) {
        themeCssPath = projectCss
      } else {
        themeCssPath = resolve(__dirname, "style.css")
      }
    }

    // 2. 预处理 Mermaid (使用样式表动态渲染主题)
    const rawMd = readFileSync(resolvedInput, "utf8")
    const preprocessed = await preprocessMermaidInMarkdown(rawMd, themeCssPath)
    tempImages = preprocessed.tempImages
    writeFileSync(intermediateMd, preprocessed.content, "utf8")

    const refDocx = getReferenceDocxPath(projectDir)
    const tocDepth = opts.tocDepth || 2

    const pandocArgs = [
      intermediateMd,
      "-o", resolvedOutput,
      "--from", "markdown+autolink_bare_uris+pipe_tables+strikeout+task_lists",
      "--to", "docx",
      "--toc",
      `--toc-depth=${tocDepth}`,
      `--resource-path=${baseDir};${tempDir}`,
      "-V", "lang=zh-CN",
    ]

    if (refDocx) {
      pandocArgs.push(`--reference-doc=${refDocx}`)
    }

    try {
      execFileSync("pandoc", pandocArgs, { stdio: "pipe" })
    } catch (err: any) {
      const errorMsg = err?.stderr?.toString() || err?.stdout?.toString() || (err as Error).message || "Pandoc conversion failed"
      const logFile = writeErrorLog(`Pandoc execution (${resolvedInput})`, errorMsg, "", projectDir)
      throw new Error(formatFriendlyErrorMessage(resolvedInput, errorMsg, logFile, projectDir))
    }

    // 3. 深度美化 OpenXML
    const theme = loadThemeFromCssFile(themeCssPath)
    postprocessDocxXml(resolvedOutput, theme)

    const stat = statSync(resolvedOutput)
    return {
      inputPath: resolvedInput,
      outputPath: resolvedOutput,
      fileSizeBytes: stat.size,
    }
  } finally {
    cleanupMermaidTempImages(tempImages)
    if (existsSync(intermediateMd)) {
      try { unlinkSync(intermediateMd) } catch {}
    }
  }
}
