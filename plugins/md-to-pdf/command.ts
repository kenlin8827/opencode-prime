import { injectReply, type V2Session } from "../shared/agent-scope"
import { relative } from "node:path"
import {
  convertSingleFile,
  checkPandoc,
  checkNode,
  checkChromium,
  autoInstallPandoc,
  autoInstallChromium,
} from "./engine"

export const COMMAND_NAMES = ["md-to-pdf"] as const

/** V2 command handler (registered per COMMAND_NAMES via
 *  ctx.command.transform in index.ts). All user feedback rides the
 *  synthetic-message channel (v1 equivalent: session.prompt({noReply,
 *  ignored})); returning from execute() consumes the command (v1
 *  equivalent: throw the empty-204 response — the LLM never sees a turn). */
export function makeCommandHandler(session: V2Session | undefined, projectDir: string) {
  return async (input: { arguments?: string; sessionID?: string }) => {
    const argsStr = (input.arguments || "").trim()

    // Show help if no arguments provided
    if (!argsStr || argsStr === "help" || argsStr === "--help" || argsStr === "-h") {
      const help = `[md-to-pdf] Markdown to PDF Exporter

Usage:
  /md-to-pdf <file.md> [output.pdf] [--style=<custom.css>]  - Convert markdown to styled A4 PDF
  /md-to-pdf --doctor                                        - Check Pandoc, Node, and Playwright status
  /md-to-pdf --install-deps                                  - Auto-install missing dependencies

Examples:
  /md-to-pdf README.md
  /md-to-pdf doc/api-v1.md dist/api-v1.pdf
  /md-to-pdf doc/whitepaper.md --style=custom-theme.css`

      await injectReply(session, input.sessionID, help)
      return
    }

    if (argsStr === "--doctor" || argsStr === "doctor") {
      const pandocOk = checkPandoc()
      const nodeOk = checkNode()
      const chromiumOk = checkChromium()

      const doctorReport = `[md-to-pdf Environment Diagnostic]
- Pandoc (Markdown parser): ${pandocOk ? "✅ Available" : "❌ Missing"}
- Node.js runtime: ${nodeOk ? "✅ Available" : "❌ Missing"}
- Playwright Chromium: ${chromiumOk ? "✅ Ready" : "⚠️ Browser binary missing"}

${!pandocOk || !chromiumOk ? "👉 Run `/md-to-pdf --install-deps` to auto-install missing tools or view install guide.\n" : ""}`

      await injectReply(session, input.sessionID, doctorReport)
      return
    }

    if (argsStr === "--install-deps") {
      const reportLines: string[] = ["[md-to-pdf Dependency Provisioning]"]

      if (!checkPandoc()) {
        reportLines.push("• Pandoc Markdown Parser:")
        const res = autoInstallPandoc(projectDir)
        if (res.success) {
          reportLines.push("  ✅ Auto-installed successfully via winget.")
        } else {
          reportLines.push(`  ❌ Auto-install failed: ${res.message}`)
          reportLines.push("  👉 Manual installation guide:")
          reportLines.push("     - Windows: Run `winget install JohnMacFarlane.Pandoc` (or `choco install pandoc`)")
          reportLines.push("     - macOS:   Run `brew install pandoc`")
          reportLines.push("     - Linux:   Run `sudo apt-get install pandoc`")
          if (res.logFile) {
            const relLog = res.logFile.startsWith(projectDir) ? relative(projectDir, res.logFile) : res.logFile
            reportLines.push(`  📝 Log: ${relLog}`)
          }
        }
      } else {
        reportLines.push("• Pandoc Markdown Parser: ✅ Already installed.")
      }

      if (!checkChromium()) {
        reportLines.push("\n• Playwright Chromium Browser:")
        const res = autoInstallChromium(projectDir)
        if (res.success) {
          reportLines.push("  ✅ Auto-installed successfully.")
        } else {
          reportLines.push(`  ❌ Auto-install failed: ${res.message}`)
          reportLines.push("  👉 Manual installation guide:")
          reportLines.push("     - In your terminal run: `npx playwright install chromium`")
          reportLines.push("     - If system drive (C:) is full, run: `$env:PLAYWRIGHT_BROWSERS_PATH=\"D:\\.ms-playwright\"; npx playwright install chromium`")
          if (res.logFile) {
            const relLog = res.logFile.startsWith(projectDir) ? relative(projectDir, res.logFile) : res.logFile
            reportLines.push(`  📝 Log: ${relLog}`)
          }
        }
      } else {
        reportLines.push("\n• Playwright Chromium Browser: ✅ Already installed.")
      }

      await injectReply(session, input.sessionID, reportLines.join("\n"))
      return
    }

    const parts = argsStr.split(/\s+/).filter(Boolean)
    let inputFile = ""
    let outputFile: string | undefined = undefined
    let stylePath: string | undefined = undefined

    for (const part of parts) {
      if (part.startsWith("--style=")) {
        stylePath = part.slice("--style=".length).trim().replace(/^['"]|['"]$/g, "")
      } else if (!inputFile) {
        inputFile = part
      } else if (!outputFile) {
        outputFile = part
      }
    }

    // 1. Notify user in dialogue: conversion is starting
    try {
      await injectReply(session, input.sessionID, `⏳ Converting \`${inputFile}\` to PDF (Pandoc parsing & A4 rendering in progress)...`)
    } catch {
      // v1 parity: a failed announce never aborts the conversion.
    }

    try {
      const result = await convertSingleFile(
        {
          inputPath: inputFile,
          outputPath: outputFile,
          customCss: stylePath,
        },
        projectDir,
      )

      // 2. Notify user in dialogue: conversion complete
      const successMsg = `🎉 PDF generation complete!
• Source: ${result.inputPath}
• Output: ${result.outputPath}
• File size: ${(result.fileSizeBytes / 1024).toFixed(1)} KB`

      await injectReply(session, input.sessionID, successMsg)
    } catch (err) {
      const errorMsg = (err as Error).message
      await injectReply(session, input.sessionID, errorMsg)
    }

    return
  }
}
