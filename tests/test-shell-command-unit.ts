import { runShellCommand } from "../install/src/shared/shell-command"

const captured = runShellCommand("echo shell-runner", {
  output: "capture",
  timeoutMs: 20000, // Windows PowerShell process startup alone takes ~1-2s cold; 1s was a flake (QA sweep 2026-09-24)
})
if (captured.status !== 0 || !captured.stdout.toLowerCase().includes("shell-runner")) {
  throw new Error("shared shell runner must capture successful command output")
}

const failed = runShellCommand("exit 7", {
  output: "capture",
  timeoutMs: 20000, // Windows PowerShell process startup alone takes ~1-2s cold; 1s was a flake (QA sweep 2026-09-24)
})
if (failed.status !== 7) throw new Error("shared shell runner must preserve command exit status")

console.log("Shared shell command runner: PASS")
