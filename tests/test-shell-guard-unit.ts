/**
 * Shell Guard permission-hook tests; exercises the registered v2 hook through
 * the plugin entry point without spawning a shell or invoking OpenCode APIs.
 */
import plugin from "../plugins/shell-guard"

let passed = 0
let failed = 0
function check(name: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.error(`  FAIL  ${name}`)
  }
}

let evaluate: ((event: any) => void | Promise<void>) | undefined
let disposed = false
const childSessions = new Set(["sub-1", "sub-pipe", "sub-codegraph", "sub-unknown"])
const cleanup = await (plugin as any).setup({
  session: {
    get: async ({ sessionID }: { sessionID: string }) => ({
      parentID: childSessions.has(sessionID) ? "parent-session" : "",
    }),
  },
  permission: {
    hook: async (name: string, callback: (event: any) => void | Promise<void>) => {
      check("registers the v2 permission evaluation hook", name === "evaluate")
      evaluate = callback
      return { dispose: async () => { disposed = true } }
    },
  },
})

async function run(input: Partial<{ sessionID: string; action: string; effect: string; agent: string; resources: string[] }>) {
  const event: any = {
    sessionID: "sub-1",
    action: "shell",
    effect: "allow",
    agent: "explore",
    resources: [],
    ...input,
  }
  await evaluate?.(event)
  return event
}

check("plugin installs an evaluate callback", typeof evaluate === "function")

const safeStatus = await run({ resources: ["git status --short"] })
check("ordinary read-only Git commands stay allowed", safeStatus.effect === "allow")

const safePipe = await run({ resources: ["git show HEAD:src/file.ts", "Select-Object -First 200"] })
check("ordinary inspection pipelines stay allowed", safePipe.effect === "allow")

const highRiskGit = [
  "git reset --hard HEAD",
  "git reset --hard",
  "git clean -fdx",
  "git push --force origin main",
  "git push -f origin main",
  "git branch -D old-branch",
  "git rebase -i HEAD~3",
  "git rebase --abort",
  "git cherry-pick --abort",
  "git merge --abort",
  "git am --abort",
  "git revert --abort",
  "git stash drop stash@{0}",
  "git stash clear",
  "git filter-branch --tree-filter command",
  "git filter-repo --path old.txt",
  "git worktree remove old-tree",
]
for (const command of highRiskGit) {
  const result = await run({ resources: [command] })
  check(`high-risk Git operation asks: ${command}`, result.effect === "ask")
}

const destructiveGit = await run({ resources: ["git reset --hard HEAD"] })
check("ask explains why the command was flagged", String(destructiveGit.message).includes("discard tracked changes"))

const rtkForcePush = await run({ resources: ["rtk git push --force-with-lease origin HEAD"] })
check("RTK-wrapped force push becomes an ask", rtkForcePush.effect === "ask")

const pipedDelete = await run({ resources: ["git status --short", "Remove-Item -Recurse -Force .\\generated"] })
check("high-risk commands in a parsed pipeline are checked", pipedDelete.effect === "ask")

const safeDelete = await run({ resources: ["Remove-Item .\\one-file.tmp"] })
check("ordinary single-file cleanup is not escalated", safeDelete.effect === "allow")

const safeDryRun = await run({ resources: ["git clean -nfdx", "git reset --soft HEAD"] })
check("dry-run cleanup and non-hard reset remain allowed", safeDryRun.effect === "allow")

const highRiskPowerShell = await run({ resources: ["Remove-Item -Recurse -Force .\\generated"] })
check("recursive forced PowerShell deletion asks", highRiskPowerShell.effect === "ask")

const highRiskCmd = await run({ resources: ["rmdir /s /q C:\\temp\\old"] })
check("recursive cmd deletion asks", highRiskCmd.effect === "ask")

const format = await run({ resources: ["format D:"] })
check("volume formatting asks", format.effect === "ask")

const primary = await run({ sessionID: "root-1", agent: "code", resources: ["git reset --hard HEAD"] })
check("primary sessions are outside the guard scope", primary.effect === "allow")

const primaryListedAsChild = await run({ sessionID: "sub-1", agent: "code", resources: ["git reset --hard HEAD"] })
check("primary agent names are excluded even if session state says child", primaryListedAsChild.effect === "allow")

const codegraphSubagent = await run({ sessionID: "sub-codegraph", agent: "codegraph-scout", resources: ["git reset --hard HEAD"] })
check("subagent scope is based on parent-session state", codegraphSubagent.effect === "ask")

const otherTool = await run({ action: "read", resources: ["git reset --hard HEAD"] })
check("non-shell permissions are unchanged", otherTool.effect === "allow")

const alreadyDenied = await run({ effect: "deny", resources: ["git reset --hard HEAD"] })
check("explicit native deny remains a deny", alreadyDenied.effect === "deny")

await cleanup()
check("plugin cleanup unregisters the permission hook", disposed)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
