import { runShellCommand } from "../install/src/shared/shell-command"

const captured = runShellCommand("echo shell-runner", {
  output: "capture",
  timeoutMs: 1000,
  windowsShell: "native",
})
if (captured.status !== 0 || !captured.stdout.toLowerCase().includes("shell-runner")) {
  throw new Error("shared shell runner must capture successful command output")
}

const failed = runShellCommand("exit 7", {
  output: "capture",
  timeoutMs: 1000,
  windowsShell: "native",
})
if (failed.status !== 7) throw new Error("shared shell runner must preserve command exit status")

console.log("Shared shell command runner: PASS")
