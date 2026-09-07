/// <reference types="bun" />
import type { Plugin } from "@opencode-ai/plugin"

/**
 * Auto Format — automatically runs formatters on files after edit.
 *
 * Supported formatters (auto-detected by config file presence):
 *  - dprint:     dprint.json[c] / .dprint.json[c] + project-local binary
 *  - Biome:      biome.json / biome.jsonc + project-local binary
 *  - Prettier:   .prettierrc / prettier.config.js
 *  - ESLint:     .eslintrc / eslint.config.js
 *  - Ruff:       ruff.toml / pyproject.toml [tool.ruff]
 *  - gofmt:      .go files (always available)
 *  - rustfmt:    rustfmt.toml / .rustfmt.toml
 *
 * Formatter runs via Bun.$ shell. Failures are logged but never block.
 * Only runs on file.edited events, not on every tool call.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

interface FormatterConfig {
  name: string
  check: (projectRoot: string) => boolean
  command: (filePath: string) => string[]
  extensions: string[]
}

const FORMATTERS: FormatterConfig[] = [
  {
    name: "dprint",
    check: (root) =>
      (existsSync(join(root, "dprint.json")) || existsSync(join(root, "dprint.jsonc")) ||
        existsSync(join(root, ".dprint.json")) || existsSync(join(root, ".dprint.jsonc"))) &&
      (existsSync(join(root, "node_modules", ".bin", "dprint")) ||
        existsSync(join(root, "node_modules", ".bin", "dprint.cmd"))),
    command: (file) => ["bun", "x", "--no-install", "dprint", "fmt", file],
    extensions: [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".mdx", ".toml",
      ".css", ".scss", ".html", ".vue", ".svelte", ".go", ".py", ".rs", ".java", ".cs", ".vb",
    ],
  },
  {
    name: "biome",
    check: (root) =>
      (existsSync(join(root, "biome.json")) || existsSync(join(root, "biome.jsonc"))) &&
      (existsSync(join(root, "node_modules", ".bin", "biome")) ||
        existsSync(join(root, "node_modules", ".bin", "biome.cmd"))),
    command: (file) => ["bun", "x", "--no-install", "@biomejs/biome", "format", "--write", file],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc", ".css", ".graphql"],
  },
  {
    name: "prettier",
    check: (root) =>
      existsSync(join(root, ".prettierrc")) ||
      existsSync(join(root, ".prettierrc.json")) ||
      existsSync(join(root, ".prettierrc.js")) ||
      existsSync(join(root, "prettier.config.js")) ||
      existsSync(join(root, "prettier.config.mjs")),
    command: (file) => ["bun", "x", "prettier", "--write", file],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".scss", ".md", ".vue", ".svelte"],
  },
  {
    name: "eslint",
    check: (root) =>
      existsSync(join(root, ".eslintrc")) ||
      existsSync(join(root, ".eslintrc.js")) ||
      existsSync(join(root, ".eslintrc.json")) ||
      existsSync(join(root, "eslint.config.js")) ||
      existsSync(join(root, "eslint.config.mjs")),
    command: (file) => ["bun", "x", "eslint", "--fix", file],
    extensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  {
    name: "ruff",
    check: (root) =>
      existsSync(join(root, "ruff.toml")) ||
      existsSync(join(root, ".ruff.toml")),
    command: (file) => ["ruff", "format", file],
    extensions: [".py"],
  },
  {
    name: "gofmt",
    check: (root) => existsSync(join(root, "go.mod")),
    command: (file) => ["gofmt", "-w", file],
    extensions: [".go"],
  },
  {
    name: "rustfmt",
    check: (root) =>
      existsSync(join(root, "rustfmt.toml")) ||
      existsSync(join(root, ".rustfmt.toml")) ||
      existsSync(join(root, "Cargo.toml")),
    command: (file) => ["rustfmt", "--edition", "2021", file],
    extensions: [".rs"],
  },
]

function getFormatter(filePath: string, projectRoot: string): FormatterConfig | null {
  for (const fmt of FORMATTERS) {
    if (fmt.extensions.some((ext) => filePath.endsWith(ext)) && fmt.check(projectRoot)) {
      return fmt
    }
  }
  return null
}

/** Extract a path from both legacy string and current file-object event payloads. */
function filePathFromEvent(value: unknown): string | null {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return null

  const file = value as { path?: unknown; filePath?: unknown }
  if (typeof file.path === "string") return file.path
  if (typeof file.filePath === "string") return file.filePath
  return null
}

function formatterNameFor(filePath: string, projectRoot: string): string | null {
  return getFormatter(filePath, projectRoot)?.name ?? null
}

export const AutoFormatPlugin: Plugin = async ({ client, directory }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "file.edited") return
      const file = filePathFromEvent((event as any).properties?.file) ??
        filePathFromEvent((event as any).file)
      if (!file) return

      const formatter = getFormatter(file, directory)
      if (!formatter) return

      try {
        const cmd = formatter.command(file)
        const process = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" })
        if (await process.exited !== 0) {
          throw new Error((await new Response(process.stderr).text()).trim() || "formatter exited with an error")
        }

        await client.app.log({
          body: {
            service: "auto-format",
            level: "debug",
            message: `Formatted ${file} with ${formatter.name}`,
            extra: { file, formatter: formatter.name },
          },
        })
      } catch (err) {
        // Formatter failed — log warning but never block
        await client.app.log({
          body: {
            service: "auto-format",
            level: "warn",
            message: `${formatter.name} failed on ${file}: ${(err as Error).message}`,
            extra: { file, formatter: formatter.name, error: (err as Error).message },
          },
        })
      }
    },
  }
}
