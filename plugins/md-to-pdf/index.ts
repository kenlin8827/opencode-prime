/// <reference types="bun" />
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { convertSingleFile, type ConversionOptions } from "./engine"
import { makeCommandHook, COMMAND_NAMES } from "./command"

export const MdToPdfPlugin: Plugin = async ({ client, directory }) => {
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      for (const name of COMMAND_NAMES) {
        cfg.command[name] = {
          template: `/${name} $ARGUMENTS`,
          description: "Convert Markdown file to styled A4 PDF (uses Pandoc + Playwright)",
        }
      }
    },
    "command.execute.before": makeCommandHook(client, directory),
    tool: {
      md_to_pdf: tool({
        description:
          "Convert a Markdown (.md) file to a publication-ready styled A4 PDF document using Pandoc and Playwright. " +
          "Applies beautiful GitHub-flavored typography, code syntax highlighting, and clean table borders. " +
          "Use this tool whenever you need to export documents, reports, ADRs, or API documentation as PDF.",
        args: {
          inputPath: tool.schema.string().describe("Path to the input Markdown file (.md), relative to the workspace or absolute"),
          outputPath: tool.schema.string().optional().describe("Optional path for the output PDF file. Defaults to same directory with .pdf extension"),
          customCss: tool.schema.string().optional().describe("Optional custom CSS rules to inject into the rendered document"),
          format: tool.schema.enum(["A4", "Letter", "Legal", "Tabloid"]).optional().describe("Paper format for the PDF (default: 'A4')"),
          keepHtml: tool.schema.boolean().optional().describe("Keep the intermediate HTML file for debugging (default: false)"),
        },
        execute: async (args, context) => {
          try {
            const opts: ConversionOptions = {
              inputPath: args.inputPath,
              outputPath: args.outputPath,
              customCss: args.customCss,
              format: args.format,
              keepHtml: args.keepHtml,
            }

            const result = await convertSingleFile(opts, directory)

            context.metadata({
              title: `PDF Exported: ${basename(result.outputPath)}`,
              metadata: {
                source: result.inputPath,
                output: result.outputPath,
                size: result.fileSizeBytes,
              },
            })

            let attachments: Array<{ type: "file"; mime: string; url: string; filename: string }> = []
            try {
              const pdfBase64 = readFileSync(result.outputPath).toString("base64")
              attachments = [
                {
                  type: "file",
                  mime: "application/pdf",
                  url: `data:application/pdf;base64,${pdfBase64}`,
                  filename: basename(result.outputPath),
                },
              ]
            } catch {}

            return {
              title: `PDF generated successfully: ${basename(result.outputPath)}`,
              output: `🎉 PDF generation complete!\n• Source: ${result.inputPath}\n• Output: ${result.outputPath}\n• File size: ${(result.fileSizeBytes / 1024).toFixed(1)} KB`,
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
              title: `PDF export failed for ${args.inputPath}`,
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

export default MdToPdfPlugin
