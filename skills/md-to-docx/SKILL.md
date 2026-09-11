---
name: md-to-docx
description: Convert Markdown files to publication-quality Word (.docx) documents (pure-TS OpenXML engine, no Microsoft Word required). Load ONLY when the user asks to convert, export, or "send as Word" a .md file — e.g. "convert to word", "export to docx", "generate word report", "转word", "转docx", "send me the .docx", "/md-to-docx <path>".
---

# Markdown → Word (DOCX) Conversion Workflow

You have access to the `md_to_docx` tool and the `/md-to-docx` slash command (registered by the `md-to-docx` plugin). Use it when the user wants a Markdown file rendered as a publication-quality Word document — meeting minutes, ADRs, requirements docs, architecture specs, or any markdown that has to ship as `.docx`.

## When to use this

- The user asks for "Word", "docx", ".docx", or any of: `转word`, `转docx`, "导出 word", "生成报告".
- The deliverable must look like a real Word document (typography, headings, tables) — plain-text `.md` is not enough.
- The source is Markdown (`.md`). For other formats, reject.

## Steps

1. **Extract the file path** from the user's message. Strip leading `@` or backticks; resolve relative paths against the workspace root.
2. **Inform the user in dialogue** that DOCX generation is in progress:
   - EN: `⏳ Converting <filePath> to Word...`
   - ZH: `⏳ 正在将 <filePath> 转换为 Word...`
3. **Call the tool** with `{ inputPath: "<filePath>" }`. Optional args:
   - `outputPath` — override default (same dir, `.docx` extension)
   - `company` — project / org name for the page header
   - `tocDepth` — heading depth for the auto-generated table of contents (default: 2)
4. **On success** — the tool returns the output path + size + a `data:application/vnd.opencode...docx;base64,...` attachment. Inform the user with:
   - Output file path
   - File size
   - The DOCX is attached as a download
5. **On failure** — output the error message in dialogue, then point at the detailed log:
   ```
   .opencode/logs/<session-id>/md-to-docx.log
   ```

## Why DOCX over PDF

DOCX is the right format when the **recipient** wants to **edit** the document later (comments, track changes, copy/paste into another report). PDF is right when the **recipient** just **reads** the final version. If the user has not specified, ask — don't silently pick.

## Triggers

Natural-language signals that should activate this skill:
- "convert to word", "export to docx", "send me the word version"
- "转 word", "转 docx", "导出 word 格式", "生成 word 报告"
- "/md-to-docx <path>" slash command
- "I need this as a Word document for the meeting"
- "Send me the .docx"

## When NOT to use this

- User wants PDF → `md-to-pdf` skill instead.
- User wants HTML → no DOCX needed.
- User wants a quick preview → render the markdown directly; no file conversion needed.
- Source is not `.md` → reject; `md_to_docx` only accepts Markdown.
