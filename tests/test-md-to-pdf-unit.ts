/**
 * Markdown to PDF Plugin — Unit & Integration Tests
 *
 * Validates:
 *   - buildInjectedStyle template & custom CSS injection
 *   - checkPandoc environment detection
 *   - renderMarkdownToHtml conversion & style injection
 *   - convertSingleFile end-to-end PDF generation
 *   - Input error handling for non-existent files
 *
 * Run: bun tests/test-md-to-pdf-unit.ts
 */

import { existsSync, writeFileSync, unlinkSync, statSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildInjectedStyle, getDefaultCss, getStyleCssPath } from "../plugins/md-to-pdf/style"
import {
  checkPandoc,
  renderMarkdownToHtml,
  convertSingleFile,
  writeErrorLog,
  getProjectLogDir,
  formatFriendlyErrorMessage,
  optimizeHtmlTables,
} from "../plugins/md-to-pdf/engine"

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✅ ${msg}`)
    passed++
  } else {
    console.error(`  ❌ ${msg}`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(60)}`)
}

async function runTests() {
  section("1. Style Generation Tests")

  assert(existsSync(getStyleCssPath()), "style.css file exists on disk")
  const defaultCss = getDefaultCss()
  assert(defaultCss.includes("@page {"), "Default CSS contains @page rules")
  assert(defaultCss.includes("table {"), "Default CSS contains table rules")

  const defaultStyleTag = buildInjectedStyle()
  assert(defaultStyleTag.startsWith("<style>") && defaultStyleTag.endsWith("</style>"), "buildInjectedStyle wraps in style tags")
  assert(defaultStyleTag.includes("size: A4;"), "Contains A4 page size")

  const customCss = ".custom-class { color: red; }"
  const withCustom = buildInjectedStyle(customCss)
  assert(withCustom.includes(".custom-class { color: red; }"), "Includes custom CSS snippet")
  assert(withCustom.includes("@page {"), "Retains base CSS when adding custom CSS")

  // HTML table optimization test
  const rawHtml = '<colgroup><col style="width: 20%" /></colgroup><td>应用ID</td><td>这是一段很长很长的业务说明描述信息，需要换行</td>'
  const optHtml = optimizeHtmlTables(rawHtml)
  assert(!optHtml.includes('width: 20%'), "Cleans hardcoded col widths in colgroup")
  assert(optHtml.includes('class="cell-nowrap"'), "Applies cell-nowrap to short cells (<= 12 chars)")
  assert(!optHtml.includes('<td>这是一段很长很长的业务说明描述信息，需要换行</td> class="cell-nowrap"'), "Does not apply cell-nowrap to long cells")

  section("2. Environment Check Tests")
  const hasPandoc = checkPandoc()
  assert(typeof hasPandoc === "boolean", "checkPandoc returns a boolean")
  console.log(`  ℹ️  Pandoc available on system: ${hasPandoc}`)

  section("3. Markdown to HTML Conversion Tests")
  const tempDir = join(tmpdir(), "md-to-pdf-test-" + Date.now())
  mkdirSync(tempDir, { recursive: true })

  const sampleMdPath = join(tempDir, "sample.md")
  const sampleHtmlPath = join(tempDir, "sample.html")
  const samplePdfPath = join(tempDir, "sample.pdf")

  const sampleMdContent = `# Test Document Title

This is a **bold** and *italic* paragraph with an [OpenCode link](https://opencode.ai).

## Code Section

\`\`\`typescript
interface User {
  id: string
  name: string
}
const u: User = { id: "1", name: "Alice" }
console.log(u)
\`\`\`

## Table Section

| Feature | Supported | Status |
| :--- | :---: | ---: |
| Markdown | Yes | Stable |
| Pandoc | Yes | Fast |
| PDF Export | Yes | High Quality |

> Note: Rendered via md-to-pdf engine.
`

  writeFileSync(sampleMdPath, sampleMdContent, "utf8")
  assert(existsSync(sampleMdPath), "Sample markdown created")

  if (hasPandoc) {
    renderMarkdownToHtml(sampleMdPath, sampleHtmlPath, "h1 { color: #0969da; }")
    assert(existsSync(sampleHtmlPath), "HTML file rendered by Pandoc")

    const htmlContent = await Bun.file(sampleHtmlPath).text()
    assert(htmlContent.includes("Test Document Title"), "HTML contains rendered heading text")
    assert(htmlContent.includes("@page") && htmlContent.includes("size: A4;"), "HTML contains injected styles")
    assert(htmlContent.includes("h1 { color: #0969da; }"), "HTML contains custom CSS")
  } else {
    console.log("  ⚠️ Skipping pandoc rendering test (pandoc not available)")
  }

  section("4. End-to-End PDF Conversion Tests")
  if (hasPandoc) {
    try {
      const result = await convertSingleFile({
        inputPath: sampleMdPath,
        outputPath: samplePdfPath,
      })

      assert(existsSync(result.outputPath), "PDF file created at target path")
      const stat = statSync(result.outputPath)
      assert(stat.size > 1000, `PDF file has valid size (${(stat.size / 1024).toFixed(1)} KB)`)
      assert(result.fileSizeBytes === stat.size, "Result metadata matches disk file size")
    } catch (err) {
      assert(false, `PDF conversion failed: ${(err as Error).message}`)
    }
  } else {
    console.log("  ⚠️ Skipping PDF conversion test (pandoc not available)")
  }

  section("5. Error Handling & Project-level Logging Tests")

  const projectLogs = getProjectLogDir(tempDir)
  assert(projectLogs.includes(join(tempDir, ".ocp", "logs")), "Project logs dir resolves to .ocp/logs")
  assert(existsSync(projectLogs), ".ocp/logs directory created automatically")

  const loggedFile = writeErrorLog("test-action", new Error("Sample failure"), "extra details", tempDir)
  assert(existsSync(loggedFile), "Log file written to disk")
  assert(loggedFile.startsWith(projectLogs), "Log file located inside project's .ocp/logs")

  const friendlyMsg = formatFriendlyErrorMessage("doc.md", "Executable doesn't exist", loggedFile, tempDir)
  assert(friendlyMsg.includes("How to install Playwright browser"), "Friendly message includes installation instructions")
  assert(friendlyMsg.includes(loggedFile.replace(tempDir + "\\", "")), "Friendly message shows log file location")

  let threwForNonExistent = false
  try {
    await convertSingleFile({
      inputPath: join(tempDir, "non-existent-file-xyz.md"),
    }, tempDir)
  } catch (err) {
    threwForNonExistent = true
    assert((err as Error).message.includes("not found"), "Throws clear error message for missing input")
  }
  assert(threwForNonExistent, "Throws when input file does not exist")

  // Cleanup
  try {
    if (existsSync(sampleMdPath)) unlinkSync(sampleMdPath)
    if (existsSync(sampleHtmlPath)) unlinkSync(sampleHtmlPath)
    if (existsSync(samplePdfPath)) unlinkSync(samplePdfPath)
  } catch {}

  section("Summary")
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err)
  process.exit(1)
})
