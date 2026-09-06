import { mcpEnabledFrom, renderProfileBlock } from "../plugins/project-profiler/project-profiler"

let failures = 0

function assert(condition: boolean, message: string): void {
  if (condition) return
  failures++
  console.error(`FAIL: ${message}`)
}

const profile: Parameters<typeof renderProfileBlock>[0] = {
  codegraph: "ready",
  gitnexus: "unavailable",
  serena: "unavailable",
}

const block = renderProfileBlock(profile)
assert(block.includes("CodeGraph=ready"), "indexed CodeGraph is a compact ready capability")
assert(block.includes("GitNexus=unavailable"), "absent GitNexus is an explicit unavailable capability")
assert(mcpEnabledFrom('{"mcp":{"codegraph":{"enabled":false}}}', "codegraph") === false, "explicit disabled MCP is unavailable")
assert(mcpEnabledFrom('{"mcp":{}}', "codegraph") === false, "unconfigured MCP is unavailable")

if (failures > 0) process.exit(1)
console.log("Project profiler capability contract: PASS")
