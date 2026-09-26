/// <reference types="bun" />
import type { Plugin } from "@opencode/plugin"

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
 * Formatter runs via Bun.spawn. Failures are logged but never block.
 *
 * v2 event mapping: v1's `file.edited` (emitted by the edit tools) has no
 * v2 emitter (core edit tool marks it TODO); the live equivalent is the
 * location file watcher's `filesystem.changed` with data.{file,event}.
 * The watcher also sees the formatter's own write-back, so each successful
 * run records the formatted content hash and skips the echo event —
 * without this, an always-writing formatter (prettier --write) would loop.
 */

import { createHash } from "node:crypto"
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

/** Bound the echo-dedup map; oldest entries just re-validate next time. */
const MAX_TRACKED_FILES = 512

async function formatFile(filePath: string, projectRoot: string, echoHashes: Map<string, string>): Promise<void> {
  const formatter = getFormatter(filePath, projectRoot)
  if (!formatter) return

  const before = createHash("sha256").update(await Bun.file(filePath).text(), "utf8").digest("hex")
  if (echoHashes.get(filePath) === before) return

  const cmd = formatter.command(filePath)
  const process = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" })
  if (await process.exited !== 0) {
    throw new Error((await new Response(process.stderr).text()).trim() || "formatter exited with an error")
  }

  // Record the POST-format hash: the watcher echo carries the formatted
  // bytes, so this exact value is what dedups the echo event.
  const after = createHash("sha256").update(await Bun.file(filePath).text(), "utf8").digest("hex")
  if (echoHashes.size > MAX_TRACKED_FILES) echoHashes.delete(echoHashes.keys().next().value!)
  echoHashes.set(filePath, after)
  console.debug(`[auto-format] Formatted ${filePath} with ${formatter.name}`)
}

const plugin: Plugin.Plugin = {
  id: "opencode-prime.auto-format",
  setup(ctx) {
    const projectRoot = ctx.location.directory
    const controller = new AbortController()
    const echoHashes = new Map<string, string>()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "filesystem.changed") continue
          if (event.data.event === "unlink") continue
          const file = event.data.file
          try {
            await formatFile(file, projectRoot, echoHashes)
          } catch (err) {
            // Formatter failed — warn but never block (v1 parity).
            console.warn(`[auto-format] formatter failed on ${file}: ${(err as Error).message}`)
          }
        }
      } catch {
        // Subscription stream died (abort or transport error). The plugin
        // holds no resource beyond the signal; cleanup below aborts it.
      }
    })()

    return () => controller.abort()
  },
}

export default plugin
