/// <reference types="bun" />
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { convertSingleFile, type DocxConversionOptions } from "./engine"
import { makeCommandHook, COMMAND_NAMES } from "./command"

export const MdToDocxPlugin: Plugin = async ({ client, directory }) => {
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      for (const name of COMMAND_NAMES) {
        cfg.command[name] = {
          template: `/${name} $ARGUMENTS`,
          description: "Convert Markdown file to publication-quality Word (DOCX) document (pure TS OpenXML engine)",
        }
      }
    },
    "command.execute.before": makeCommandHook(client, directory),
    tool: {
      md_to_docx: tool({
        description:
          "Convert a Markdown (.md) file to a publication-ready styled Word (.docx) document. " +
          "Applies Chinese SongTi/HeiTi typography, auto table of contents (TOC), full-width styled tables, and code formatting. " +
          "Use this tool whenever you need to export documents, reports, proposals, ADRs, or specifications as Word files.",
        args: {
          inputPath: tool.schema.string().describe("Path to the input Markdown file (.md), relative to the workspace or absolute"),
          outputPath: tool.schema.string().optional().describe("Optional path for the output DOCX file. Defaults to same directory with .docx extension"),
          company: tool.schema.string().optional().describe("Optional organization or project name to display on the page header"),
          tocDepth: tool.schema.number().optional().describe("Table of Contents heading depth (default: 2)"),
        },
        execute: async (args, context) => {
          try {
            const opts: DocxConversionOptions = {
              inputPath: args.inputPath,
              outputPath: args.outputPath,
              company: args.company,
              tocDepth: args.tocDepth,
            }

            const result = await convertSingleFile(opts, directory)

            context.metadata({
              title: `DOCX Exported: ${basename(result.outputPath)}`,
              metadata: {
                source: result.inputPath,
                output: result.outputPath,
                size: result.fileSizeBytes,
              },
            })

            let attachments: Array<{ type: "file"; mime: string; url: string; filename: string }> = []
            try {
              const docxBase64 = readFileSync(result.outputPath).toString("base64")
              attachments = [
                {
                  type: "file",
                  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  url: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${docxBase64}`,
                  filename: basename(result.outputPath),
                },
              ]
            } catch {}

            return {
              title: `DOCX generated successfully: ${basename(result.outputPath)}`,
              output: `🎉 Word document generation complete!\n• Source: ${result.inputPath}\n• Output: ${result.outputPath}\n• File size: ${(result.fileSizeBytes / 1024).toFixed(1)} KB`,
              metadata: {
                inputPath: result.inputPath,
                outputPath: result.outputPath,
                fileSizeBytes: result.fileSizeBytes,
              },
              attachments,
            }
          } catch (err) {
            const message = (err as Error).message
            return {
              title: `DOCX export failed for ${args.inputPath}`,
              output: message,
              metadata: {
                error: message,
                inputPath: args.inputPath,
              },
            }
          }
        },
      }),
    },
  }
}

export default MdToDocxPlugin
