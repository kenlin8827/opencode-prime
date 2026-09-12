#!/usr/bin/env node
/**
 * Serena Workspace Daemon Bridge
 *
 * Provides a lightweight stdio-to-SSE bridge with automatic workspace daemon management
 * and idle auto-shutdown (heartbeat watchdog).
 *
 * Key features:
 * - Same workspace: all sessions share a single Serena + LSP process (saving massive RAM/CPU).
 * - Different workspaces: isolated Serena instances bound to each project directory.
 * - Zero manual intervention: automatically launches the project daemon if not running.
 * - 100% Silent execution: no console window popup on Windows.
 * - Logging: all daemon stdout/stderr redirected to <OCP dir>/logs/serena.log
 *   (default `.ocp`, `OCP_PROJECT_DIR`-aware — mirrors plugins/shared/opencode-prime.ts).
 * - Auto-shutdown watchdog: terminates idle Serena instance after 15 minutes of inactivity
 *   when all sessions are closed, freeing memory cleanly.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"

const CWD = process.cwd()
const IDLE_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes

function getProjectPort(dir) {
  const normalized = path.resolve(dir).toLowerCase()
  let hash = 0
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(i)
    hash |= 0
  }
  return 24300 + (Math.abs(hash) % 600)
}

const PORT = getProjectPort(CWD)
const SSE_URL = `http://127.0.0.1:${PORT}/sse`
const STATE_FILE = path.join(os.tmpdir(), `serena-daemon-${PORT}.json`)

function isPidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"))
    }
  } catch {}
  return { serenaPid: null, watchdogPid: null, clients: [], lastActive: Date.now(), projectDir: CWD }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8")
  } catch {}
}

function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let status = false

    socket.setTimeout(timeoutMs)
    socket.once("connect", () => {
      status = true
      socket.destroy()
      resolve(true)
    })
    socket.once("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => {
      socket.destroy()
      resolve(false)
    })

    socket.connect(port, "127.0.0.1")
  })
}

function launchDaemon() {
  const isWin = process.platform === "win32"
  const args = [
    "start-mcp-server",
    "--transport", "sse",
    "--port", String(PORT),
    "--project-from-cwd",
    "--context", "ide",
    "--open-web-dashboard", "False",
  ]

  // Prepare workspace log directory: <runtime OCP dir>/logs/serena.log
  // Plain-js mirror of ensureOcpGitignore() + ocpDir() in
  // plugins/shared/opencode-prime.ts (ADR 0004) — this standalone shipped
  // script cannot import the plugin tree; keep the ignore list AND the
  // OCP_PROJECT_DIR resolution rules in sync with the shared
  // implementation. PROJECT-RELATIVE ONLY: unset/empty/whitespace or an
  // ABSOLUTE / ".."-traversing (invalid) value → <cwd>/.ocp; plain relative
  // value → <cwd>/<value>.
  const ocpEnv = (process.env.OCP_PROJECT_DIR || "").trim()
  const ocpInvalid = !ocpEnv || path.isAbsolute(ocpEnv) || ocpEnv.split(/[\\/]/).includes("..")
  const ocpDir = ocpInvalid ? path.join(CWD, ".ocp") : path.join(CWD, ocpEnv)
  const logDir = path.join(ocpDir, "logs")
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    const gitignoreFile = path.join(ocpDir, ".gitignore")
    if (!fs.existsSync(gitignoreFile)) {
      fs.writeFileSync(gitignoreFile, ".gitignore\nlogs/\n*.log\nhandoffs/\nmemory/private.md\ndev-ultra-state.md\n", "utf-8")
    } else {
      const gitignoreContent = fs.readFileSync(gitignoreFile, "utf-8")
      let needsUpdate = false
      let nextContent = gitignoreContent
      if (!gitignoreContent.includes("logs")) {
        nextContent = nextContent.trimEnd() + "\nlogs/\n*.log\n"
        needsUpdate = true
      }
      if (!gitignoreContent.includes("handoffs")) {
        nextContent = nextContent.trimEnd() + "\nhandoffs/\n"
        needsUpdate = true
      }
      if (!gitignoreContent.includes("memory/private.md")) {
        nextContent = nextContent.trimEnd() + "\nmemory/private.md\n"
        needsUpdate = true
      }
      if (!gitignoreContent.includes("dev-ultra-state.md")) {
        nextContent = nextContent.trimEnd() + "\ndev-ultra-state.md\n"
        needsUpdate = true
      }
      if (needsUpdate) {
        fs.writeFileSync(gitignoreFile, nextContent, "utf-8")
      }
    }
  } catch {}
  const logFile = path.join(logDir, "serena.log")

  let logFd
  try {
    logFd = fs.openSync(logFile, "a")
    fs.writeSync(logFd, `\n=== Serena Daemon Started at ${new Date().toISOString()} (Port: ${PORT}) ===\n`)
  } catch {
    logFd = "ignore"
  }

  let serenaProcess
  if (isWin) {
    try {
      serenaProcess = spawn("serena.exe", args, {
        cwd: CWD,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      })
    } catch {
      serenaProcess = spawn("cmd.exe", ["/c", "serena", ...args], {
        cwd: CWD,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      })
    }
  } else {
    serenaProcess = spawn("serena", args, {
      cwd: CWD,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    })
  }

  if (typeof logFd === "number") {
    try { fs.closeSync(logFd) } catch {}
  }
  serenaProcess.unref()

  // Start background watchdog process with double-kill protection (PID + Port fallback)
  const watchdogScript = `
    const fs = require('fs');
    const cp = require('child_process');
    const stateFile = ${JSON.stringify(STATE_FILE)};
    const port = ${PORT};
    const idleTimeout = ${IDLE_TIMEOUT_MS};

    function isAlive(pid) {
      if (!pid) return false;
      try { process.kill(pid, 0); return true; } catch { return false; }
    }

    function killPortProcess(targetPort) {
      try {
        if (process.platform === 'win32') {
          const out = cp.execSync('netstat -ano | findstr :' + targetPort, { encoding: 'utf-8' });
          const lines = out.trim().split('\\n');
          for (const line of lines) {
            const parts = line.trim().split(/\\s+/);
            if (parts.length >= 5 && parts[1].endsWith(':' + targetPort)) {
              const pid = parseInt(parts[parts.length - 1], 10);
              if (pid && pid > 0 && pid !== process.pid) {
                try { cp.execSync('taskkill /F /T /PID ' + pid); } catch {}
              }
            }
          }
        } else {
          try { cp.execSync('fuser -k -n tcp ' + targetPort + ' 2>/dev/null || true'); } catch {}
          try { cp.execSync('lsof -ti:' + targetPort + ' | xargs kill -9 2>/dev/null || true'); } catch {}
        }
      } catch {}
    }

    const timer = setInterval(() => {
      try {
        if (!fs.existsSync(stateFile)) {
          clearInterval(timer);
          process.exit(0);
        }
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        
        state.clients = (state.clients || []).filter((pid) => isAlive(pid));

        if (state.clients.length > 0) {
          state.lastActive = Date.now();
          fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
        } else {
          if (Date.now() - (state.lastActive || Date.now()) > idleTimeout) {
            if (state.serenaPid && isAlive(state.serenaPid)) {
              try {
                if (process.platform === 'win32') {
                  cp.execSync('taskkill /F /T /PID ' + state.serenaPid);
                } else {
                  process.kill(-state.serenaPid, 'SIGTERM');
                }
              } catch {}
            }
            killPortProcess(port);
            try { fs.unlinkSync(stateFile); } catch {}
            clearInterval(timer);
            process.exit(0);
          }
        }
      } catch {
        clearInterval(timer);
        process.exit(0);
      }
    }, 20000);
  `

  const watchdog = spawn(process.execPath, ["-e", watchdogScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  watchdog.unref()

  const state = {
    serenaPid: serenaProcess.pid,
    watchdogPid: watchdog.pid,
    clients: [process.pid],
    lastActive: Date.now(),
    projectDir: CWD,
  }
  writeState(state)
}

async function waitForServer(timeoutMs = 20000) {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    if (await isPortOpen(PORT, 300)) {
      await new Promise((r) => setTimeout(r, 600))
      return true
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

function registerClient() {
  const state = readState()
  state.clients = (state.clients || []).filter((pid) => isPidAlive(pid))
  if (!state.clients.includes(process.pid)) {
    state.clients.push(process.pid)
  }
  state.lastActive = Date.now()
  writeState(state)
}

function unregisterClient() {
  const state = readState()
  state.clients = (state.clients || []).filter((pid) => pid !== process.pid && isPidAlive(pid))
  state.lastActive = Date.now()
  writeState(state)
}

// 1. Immediately start listening to stdin so no initialization messages are lost
const pendingMessages = []
let postUrl = null

function sendPost(targetUrl, payload) {
  const urlObj = new URL(targetUrl)
  const postData = typeof payload === "string" ? payload : JSON.stringify(payload)

  const postReq = http.request(
    {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    },
    (res) => {
      res.resume()
    }
  )

  postReq.on("error", (err) => {
    process.stderr.write(`[serena-daemon] POST error: ${err.message}\n`)
  })

  postReq.write(postData)
  postReq.end()
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
})

rl.on("line", (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  if (postUrl) {
    sendPost(postUrl, trimmed)
  } else {
    pendingMessages.push(trimmed)
  }
})

let cleanedUp = false
let activeReq = null
let heartbeatTimer = null

function cleanupAndExit(code = 0) {
  if (cleanedUp) return
  cleanedUp = true
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  unregisterClient()
  try { if (activeReq) activeReq.destroy() } catch {}
  process.exit(code)
}

rl.on("close", () => cleanupAndExit(0))
process.on("SIGINT", () => cleanupAndExit(0))
process.on("SIGTERM", () => cleanupAndExit(0))

function connectSSE(retryCount = 0) {
  if (cleanedUp) return

  const sseReq = http.get(SSE_URL, (res) => {
    if (res.statusCode !== 200) {
      if (retryCount < 8 && !cleanedUp) {
        setTimeout(() => connectSSE(retryCount + 1), 600)
        return
      }
      process.stderr.write(`[serena-daemon] SSE connection failed with status ${res.statusCode}\n`)
      cleanupAndExit(1)
      return
    }

    let buffer = ""
    res.on("data", (chunk) => {
      buffer += chunk.toString("utf-8").replace(/\r\n/g, "\n")
      const lines = buffer.split("\n\n")
      buffer = lines.pop() || ""

      for (const block of lines) {
        let event = "message"
        let data = ""
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim()
          } else if (line.startsWith("data:")) {
            data += (data ? "\n" : "") + line.slice(5).trim()
          }
        }

        if (event === "endpoint") {
          postUrl = new URL(data, `http://127.0.0.1:${PORT}`).href
          while (pendingMessages.length > 0) {
            const msg = pendingMessages.shift()
            sendPost(postUrl, msg)
          }
        } else if (event === "message" && data) {
          process.stdout.write(data + "\n")
        }
      }
    })

    res.on("end", () => {
      if (!cleanedUp && retryCount < 5) {
        setTimeout(() => connectSSE(retryCount + 1), 500)
      } else {
        cleanupAndExit(0)
      }
    })
  })

  sseReq.on("error", (err) => {
    if (retryCount < 8 && !cleanedUp) {
      setTimeout(() => connectSSE(retryCount + 1), 600)
    } else {
      process.stderr.write(`[serena-daemon] SSE request error: ${err.message}\n`)
      cleanupAndExit(1)
    }
  })

  activeReq = sseReq
}

async function main() {
  const running = await isPortOpen(PORT, 500)
  if (!running) {
    launchDaemon()
    const ready = await waitForServer()
    if (!ready) {
      process.stderr.write(`[serena-daemon] Failed to start serena daemon on port ${PORT} within 20s\n`)
      cleanupAndExit(1)
      return
    }
  } else {
    registerClient()
  }

  heartbeatTimer = setInterval(() => {
    registerClient()
  }, 30000)

  connectSSE(0)
}

main().catch((err) => {
  process.stderr.write(`[serena-daemon] Unhandled error: ${err.stack || err}\n`)
  cleanupAndExit(1)
})
