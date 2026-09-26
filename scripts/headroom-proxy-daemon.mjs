#!/usr/bin/env node
/**
 * Headroom Proxy Daemon Bridge
 *
 * Ensures the headroom proxy backend (127.0.0.1:8787) is running before
 * delegating to `headroom mcp serve`. Mirrors the serena-workspace-daemon
 * pattern: zero manual intervention, 100% silent on Windows.
 *
 * Flow:
 * 1. Check if proxy is listening on 8787.
 * 2. If not, spawn `headroom proxy` detached in the background.
 * 3. Wait for port to become ready (up to 30s — first run downloads ONNX + model).
 * 4. exec `headroom mcp serve` (replaces this process — stdio flows directly).
 */

import { spawn, execFileSync } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"

const PROXY_HOST = "127.0.0.1"
const PROXY_PORT = 8787
const READY_TIMEOUT_MS = 30000 // 30s — first run downloads ONNX runtime + Kompress model
const LOG_DIR = path.join(os.homedir(), ".config", "opencode", "logs")
const LOG_FILE = path.join(LOG_DIR, "headroom-proxy.log")

function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let status = false
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => { status = true; socket.destroy(); resolve(true) })
    socket.once("timeout", () => { socket.destroy(); resolve(false) })
    socket.once("error", () => { socket.destroy(); resolve(false) })
    socket.connect(port, PROXY_HOST)
  })
}

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

function launchProxy() {
  const isWin = process.platform === "win32"
  let logFd
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    logFd = fs.openSync(LOG_FILE, "a")
    fs.writeSync(logFd, `\n=== Headroom Proxy Daemon started at ${new Date().toISOString()} ===\n`)
  } catch {
    logFd = "ignore"
  }

  const cmd = isWin ? "headroom.exe" : "headroom"
  const proxy = spawn(cmd, ["proxy"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  })
  proxy.unref()

  if (typeof logFd === "number") {
    try { fs.closeSync(logFd) } catch {}
  }
  log(`Launched headroom proxy (PID ${proxy.pid})`)
  return proxy
}

async function waitForProxy() {
  const start = Date.now()
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (await isPortOpen(PROXY_PORT, 300)) {
      await new Promise((r) => setTimeout(r, 500))
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function main() {
  const running = await isPortOpen(PROXY_PORT, 500)
  if (!running) {
    log("Proxy not running, launching headroom proxy...")
    launchProxy()
    const ready = await waitForProxy()
    if (!ready) {
      process.stderr.write(
        `[headroom-daemon] Proxy failed to start within ${READY_TIMEOUT_MS / 1000}s.\n` +
        `Check ${LOG_FILE} for details. First run downloads ONNX runtime + Kompress model.\n`
      )
      // Still exec headroom mcp serve — it will degrade gracefully (tools registered but calls fail)
    } else {
      log("Proxy is ready, starting MCP serve...")
    }
  } else {
    log("Proxy already running, starting MCP serve...")
  }

  // Replace this process with headroom mcp serve — stdio flows directly to opencode
  const isWin = process.platform === "win32"
  const cmd = isWin ? "headroom.exe" : "headroom"
  const args = ["mcp", "serve", ...process.argv.slice(2)]

  try {
    const mcp = spawn(cmd, args, { stdio: "inherit", windowsHide: true })
    mcp.on("exit", (code) => process.exit(code ?? 0))
    mcp.on("error", () => process.exit(1))
  } catch {
    // Fallback: execFileSync blocks until the child exits
    try {
      execFileSync(cmd, args, { stdio: "inherit", windowsHide: true })
    } catch (e) {
      process.stderr.write(`[headroom-daemon] Failed to start headroom mcp serve: ${e.message}\n`)
      process.exit(1)
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[headroom-daemon] Unhandled error: ${err.stack || err}\n`)
  process.exit(1)
})
