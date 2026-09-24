import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { commandArgumentText, type V2Session } from "../shared/agent-scope"
import { convertSingleFile, type ConversionOptions } from "./engine"
import { makeCommandHandler, COMMAND_NAMES } from "./command"

/** JSON Schema for the md_to_pdf tool (v2 ValueSchema; v1 used zod via
 *  tool.schema — the field semantics and descriptions are unchanged). */
const TOOL_INPUT = {
  type: "object",
  properties: {
    inputPath: {
      type: "string",
      description: "Path to the input Markdown file (.md), relative to the workspace or absolute",
    },
    outputPath: {
      type: "string",
      description: "Optional path for the output PDF file. Defaults to same directory with .pdf extension",
    },
    customCss: {
      type: "string",
      description: "Optional custom CSS rules to inject into the rendered document",
    },
    format: {
      type: "string",
      enum: ["A4", "Letter", "Legal", "Tabloid"],
      description: "Paper format for the PDF (default: 'A4')",
    },
    keepHtml: {
      type: "boolean",
      description: "Keep the intermediate HTML file for debugging (default: false)",
    },
  },
  required: ["inputPath"],
} as const

export const MdToPdfPlugin = Plugin.define({
  id: "md-to-pdf",
  async setup(ctx) {
    const directory = ctx.location.directory
    const session = ctx.session as unknown as V2Session
    const commands = await ctx.command.transform((editor) => {
      // v1 registered each name via the `config` hook + command.execute.before;
      // these are plugin-owned commands → v2 editor.add per name.
      for (const name of COMMAND_NAMES) {
        const handler = makeCommandHandler(session, directory)
        editor.add({
          name,
          description: "Convert Markdown file to styled A4 PDF (uses Pandoc + Playwright)",
          execute: async (invocation) => {
            await handler({
              arguments: commandArgumentText(invocation.prompt?.text, name),
              sessionID: invocation.sessionID,
            })
          },
        })
      }
    })
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "md_to_pdf",
        options: { codemode: false },
        description:
          "Convert a Markdown (.md) file to a publication-ready styled A4 PDF document using Pandoc and Playwright. " +
          "Applies beautiful GitHub-flavored typography, code syntax highlighting, and clean table borders. " +
          "Use this tool whenever you need to export documents, reports, ADRs, or API documentation as PDF.",
        input: TOOL_INPUT,
        execute: async (args: unknown) => {
          const a = (args ?? {}) as {
            inputPath?: unknown
            outputPath?: unknown
            customCss?: unknown
            format?: unknown
            keepHtml?: unknown
          }
          if (typeof a.inputPath !== "string" || a.inputPath.trim() === "")
            throw new Error("md_to_pdf: `inputPath` must be a non-empty string")
          try {
            const opts: ConversionOptions = {
              inputPath: a.inputPath,
              outputPath: typeof a.outputPath === "string" ? a.outputPath : undefined,
              customCss: typeof a.customCss === "string" ? a.customCss : undefined,
              format:
                a.format === "Letter" || a.format === "Legal" || a.format === "Tabloid" || a.format === "A4"
                  ? a.format
                  : undefined,
              keepHtml: typeof a.keepHtml === "boolean" ? a.keepHtml : undefined,
            }

            const result = await convertSingleFile(opts, directory)

            // v1 `{ output, attachments }` result → v2 `content` array of
            // Text|File parts (Tool.Result has no `attachments` field;
            // files ride the content union as data: URIs — same channel
            // the native read tool uses).
            const content: Array<{ type: "text"; text: string } | { type: "file"; mime: string; uri: string; name: string }> = [
              {
                type: "text",
                text: `🎉 PDF generation complete!\n• Source: ${result.inputPath}\n• Output: ${result.outputPath}\n• File size: ${(result.fileSizeBytes / 1024).toFixed(1)} KB`,
              },
            ]
            try {
              const pdfBase64 = readFileSync(result.outputPath).toString("base64")
              content.push({
                type: "file",
                mime: "application/pdf",
                uri: `data:application/pdf;base64,${pdfBase64}`,
                name: basename(result.outputPath),
              })
            } catch {}

            return {
              content,
              metadata: {
                title: `PDF generated successfully: ${basename(result.outputPath)}`,
                inputPath: result.inputPath,
                outputPath: result.outputPath,
                fileSizeBytes: result.fileSizeBytes,
              },
            }
          } catch (err) {
            const message = (err as Error).message
            return {
              content: message,
              metadata: {
                title: `PDF export failed for ${a.inputPath}`,
                error: message,
                inputPath: a.inputPath,
              },
            }
          }
        },
      })
    })

    return async () => {
      await Promise.allSettled([commands.dispose(), tools.dispose()])
    }
  },
})

export default MdToPdfPlugin
