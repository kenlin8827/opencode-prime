import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { commandArgumentText, type V2Session } from "../shared/agent-scope"
import { convertSingleFile, type DocxConversionOptions } from "./engine"
import { makeCommandHandler, COMMAND_NAMES } from "./command"

/** JSON Schema for the md_to_docx tool (v2 ValueSchema; v1 used zod via
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
      description: "Optional path for the output DOCX file. Defaults to same directory with .docx extension",
    },
    company: {
      type: "string",
      description: "Optional organization or project name to display on the page header",
    },
    tocDepth: {
      type: "number",
      description: "Table of Contents heading depth (default: 2)",
    },
  },
  required: ["inputPath"],
} as const

export const MdToDocxPlugin = Plugin.define({
  id: "md-to-docx",
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
          description: "Convert Markdown file to publication-quality Word (DOCX) document (pure TS OpenXML engine)",
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
        name: "md_to_docx",
        options: { codemode: false },
        description:
          "Convert a Markdown (.md) file to a publication-ready styled Word (.docx) document. " +
          "Applies Chinese SongTi/HeiTi typography, auto table of contents (TOC), full-width styled tables, and code formatting. " +
          "Use this tool whenever you need to export documents, reports, proposals, ADRs, or specifications as Word files.",
        input: TOOL_INPUT,
        execute: async (args: unknown) => {
          const a = (args ?? {}) as { inputPath?: unknown; outputPath?: unknown; company?: unknown; tocDepth?: unknown }
          if (typeof a.inputPath !== "string" || a.inputPath.trim() === "")
            throw new Error("md_to_docx: `inputPath` must be a non-empty string")
          try {
            const opts: DocxConversionOptions = {
              inputPath: a.inputPath,
              outputPath: typeof a.outputPath === "string" ? a.outputPath : undefined,
              company: typeof a.company === "string" ? a.company : undefined,
              tocDepth: typeof a.tocDepth === "number" ? a.tocDepth : undefined,
            }

            const result = await convertSingleFile(opts, directory)

            // v1 `{ output, attachments }` result → v2 `content` array of
            // Text|File parts (Tool.Result has no `attachments` field;
            // files ride the content union as data: URIs — same channel
            // the native read tool uses).
            const content: Array<{ type: "text"; text: string } | { type: "file"; mime: string; uri: string; name: string }> = [
              {
                type: "text",
                text: `🎉 Word document generation complete!\n• Source: ${result.inputPath}\n• Output: ${result.outputPath}\n• File size: ${(result.fileSizeBytes / 1024).toFixed(1)} KB`,
              },
            ]
            try {
              const docxBase64 = readFileSync(result.outputPath).toString("base64")
              content.push({
                type: "file",
                mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                uri: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${docxBase64}`,
                name: basename(result.outputPath),
              })
            } catch {}

            return {
              content,
              metadata: {
                title: `DOCX generated successfully: ${basename(result.outputPath)}`,
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
                title: `DOCX export failed for ${a.inputPath}`,
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

export default MdToDocxPlugin
