---
name: md-to-pdf
description: Convert Markdown files to publication-ready styled A4 PDF (uses Pandoc + Playwright). Load ONLY when the user asks to convert, render, or export a .md file to PDF — e.g. "@file.md 转PDF", "将 doc.md 转为 PDF", "export @README.md as PDF", or "/md-to-pdf <path>".
---

# Markdown → PDF Conversion Workflow

You have access to the `md_to_pdf` tool (registered by the `md-to-pdf` plugin). Use it when the user wants a Markdown file rendered as a publication-quality PDF.

## Steps

1. **Extract the file path** from the user's message — `@file.md`, plain `doc.md`, `/md-to-pdf README.md`, etc. Strip leading `@` or backticks; resolve relative paths against the workspace root.
2. **Inform the user in dialogue** that PDF generation is in progress. Use the in-progress format:
   - EN: `⏳ Converting <filePath> to PDF...`
   - ZH: `⏳ 正在将 <filePath> 转换为 PDF...`
3. **Call the tool** with `{ inputPath: "<filePath>" }`. Optional args: `outputPath` (override default), `format` (A4/Letter/Legal/Tabloid), `customCss` (project-specific styling), `keepHtml` (debug only).
4. **On success** — the tool returns the output path + size + a `data:application/pdf;base64,...` attachment. Inform the user in dialogue with:
   - Output file path (absolute)
   - File size
   - The PDF is attached as a download
5. **On failure** — output the error message in dialogue, then **list the manual dependency commands** (Pandoc, Chromium / Playwright browsers), and **point at the detailed log**:
   ```
   .ocp/logs/<session-id>/md-to-pdf.log
   ```
   The log is the single source of truth for diagnosing conversion failures; do not invent error text beyond what the tool / log returned.

## When NOT to use this

- User wants HTML → use a different tool (or just describe HTML).
- User wants DOCX → `md-to-docx` skill / `md_to_docx` tool.
- User wants a preview rendered to chat → emit the rendered markdown directly; no PDF needed.
- Conversion target is something other than Markdown → reject; `md_to_pdf` only accepts `.md`.

## Triggers

Natural-language signals that should activate this skill:
- "@path/to/doc.md 转PDF", "@README.md 转PDF"
- "将 doc.md 转为 PDF"
- "export @README.md as PDF", "render report.md to PDF"
- "/md-to-pdf <path>" slash command
- "convert this markdown to a PDF report"
