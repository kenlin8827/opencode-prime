import { injectReply, type V2Session } from "../shared/agent-scope"
import { relative } from "node:path"
import {
  convertSingleFile,
  checkPandoc,
  checkNode,
  checkChromium,
  autoInstallPandoc,
} from "./engine"

export const COMMAND_NAMES = ["md-to-docx"] as const

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
      const help = `[md-to-docx] Markdown to Word (DOCX) Exporter

Usage:
  /md-to-docx <file.md> [output.docx] [--style=custom.css]  - Convert markdown to styled Word document
  /md-to-docx --doctor                                      - Check Pandoc, Node, and Playwright status
  /md-to-docx --install-deps                                - Auto-install missing dependencies

Features:
  🎨 CSS Stylesheets: Customize brand color, fonts, borders & tables via CSS (:root / table th / pre)
  ✨ Chinese Typography: SongTi body + HeiTi headings + A4 margins
  📑 Auto TOC: Centered, dotted leader lines, Word field updates
  📊 Enhanced Tables: 100% full width, auto column widths, header background
  💻 Code Blocks: Monospace Consolas font, light gray background and border
  🧜‍♂️ Mermaid Support: Native high-res diagram rendering into Word

Examples:
  /md-to-docx README.md
  /md-to-docx docs/materials/system-design.md dist/design.docx
  /md-to-docx report.md --style=custom-theme.css`

      await injectReply(session, input.sessionID, help)
      return
    }

    if (argsStr === "--doctor" || argsStr === "doctor") {
      const pandocOk = checkPandoc()
      const nodeOk = checkNode()
      const chromiumOk = checkChromium()

      const doctorReport = `[md-to-docx Environment Diagnostic]
- Pandoc (Markdown parser): ${pandocOk ? "✅ Available" : "❌ Missing"}
- Node.js runtime: ${nodeOk ? "✅ Available" : "❌ Missing"}
- Playwright Chromium (Mermaid renderer): ${chromiumOk ? "✅ Ready" : "⚠️ Browser binary missing"}

${!pandocOk || !chromiumOk ? "👉 Run `/md-to-docx --install-deps` to auto-install missing tools or view install guide.\n" : "✨ All DOCX typography, CSS theme & Mermaid engines are ready!"}`

      await injectReply(session, input.sessionID, doctorReport)
      return
    }

    if (argsStr === "--install-deps") {
      const reportLines: string[] = ["[md-to-docx Dependency Provisioning]"]

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

      await injectReply(session, input.sessionID, reportLines.join("\n"))
      return
    }

    // Normal conversion invocation
    const parts = argsStr.split(/\s+/)
    let inputPath = ""
    let outputPath: string | undefined
    let stylePath: string | undefined

    for (const p of parts) {
      if (p.startsWith("--style=")) {
        stylePath = p.slice(8).trim()
      } else if (!inputPath) {
        inputPath = p
      } else if (!outputPath) {
        outputPath = p
      }
    }

    await injectReply(session, input.sessionID, `⏳ Converting \`${inputPath}\` to publication-quality Word (DOCX)...`)

    try {
      const res = await convertSingleFile({ inputPath, outputPath, stylePath }, projectDir)
      const successMsg = `🎉 Word document generated successfully!\n• Source: \`${res.inputPath}\`\n• Output: \`${res.outputPath}\`\n• Size: ${(res.fileSizeBytes / 1024).toFixed(1)} KB`

      await injectReply(session, input.sessionID, successMsg)
    } catch (err) {
      const message = (err as Error).message
      await injectReply(session, input.sessionID, message)
    }

    return
  }
}
