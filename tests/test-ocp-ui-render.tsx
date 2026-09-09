import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Deterministic sandbox: HOME/USERPROFILE pin where the wizard plugins
// resolve opencode.jsonc and profiles/ (module-scope homedir() constants),
// OCP_CONFIG_PATH pins the shared locale store. This keeps the render test
// off the real ~/.config/opencode on every machine.
const home = mkdtempSync(path.join(tmpdir(), 'ocp-ui-test-'))
const cfgDir = path.join(home, '.config', 'opencode')
mkdirSync(path.join(cfgDir, 'profiles'), { recursive: true })
writeFileSync(path.join(cfgDir, 'opencode.jsonc'), JSON.stringify({
  model: 'acme/acme-1',
  agent: { build: { model: 'acme/acme-1' }, lite: { model: 'acme/acme-1' } },
  provider: { acme: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://acme.test/v1' }, models: { 'acme-1': { name: 'Acme One' } } } },
}, null, 2), 'utf8')
writeFileSync(path.join(cfgDir, 'profiles', 'acme-tiers.json'), JSON.stringify({
  description: 'sandbox profile', tiers: { flash: 'acme/acme-1', standard: 'acme/acme-1', pro: 'acme/acme-1', max: 'acme/acme-1', vision: 'acme/acme-1' },
}), 'utf8')
writeFileSync(path.join(home, 'ocp.jsonc'), JSON.stringify({ language: 'en' }), 'utf8')
process.env.OCP_CONFIG_PATH = path.join(home, 'ocp.jsonc')
process.env.HOME = home
process.env.USERPROFILE = home

// The standalone host needs the same Solid runtime the real `ocp` TUI gets:
// under Bun, `solid-js` resolves to the SSR server build (no-op createEffect,
// never-updating <Show>) unless @opentui/solid's plugin redirects it to the
// client build and applies the solid JSX transform. The real app loads it via
// `--preload` (see ui/runtime.ts); the harness registers it before any import
// that pulls in solid-js.
const { ensureSolidTransformPlugin } = await import('../install/node_modules/@opentui/solid/scripts/solid-plugin.js')
ensureSolidTransformPlugin()

const { OcpApp } = await import('../install/src/ui/app')
const { testRender } = await import('../install/node_modules/@opentui/solid/index.bun.js')

// The wizards unwind Esc via `setTimeout(back, 0)` — let macrotasks drain.
const settle = async (ui: { flush: () => Promise<unknown> }) => {
  await new Promise((resolve) => setTimeout(resolve, 10))
  await ui.flush()
}

const repoDir = process.cwd()
const dashboard = await testRender(() => <OcpApp initialRoute="dashboard" context={{ repoDir, root: repoDir }} />, { width: 72, height: 28 })
await dashboard.flush()
let frame = dashboard.captureCharFrame()
assert.match(frame, /OpenCode Prime — Dashboard|OpenCode Prime — 全景控制台/, 'dashboard presents the localized OpenTUI header')
assert.match(frame, /Basic|基础/, 'dashboard renders the active Basic tab')
assert.match(frame, /Tabs · ←\/→|标签 · ←\/→/, 'dashboard identifies its horizontal tab rail')
assert.match(frame, /Basic|基础/, 'dashboard starts on Basic')
assert.match(frame, /Switch Language|切换界面语言/, 'configuration exposes a clear language control')
assert.match(frame, /保存|SAVE CONFIGURATION/, 'dashboard keeps actions in its fixed global context')
const tabRows = dashboard.captureSpans().lines.filter((line) => line.spans.map((span) => span.text).join('').includes('Basic') || line.spans.map((span) => span.text).join('').includes('基础'))
assert.ok(tabRows.length >= 1, 'dashboard renders tab titles in a dedicated row')
assert.equal((frame.match(/OpenCode Prime.*(?:Dashboard|全景控制台)/g) ?? []).length, 1, 'dashboard title is rendered only once')
dashboard.renderer.destroy()

const narrowDashboard = await testRender(() => <OcpApp initialRoute="dashboard" context={{ repoDir, root: repoDir }} />, { width: 56, height: 18 })
await narrowDashboard.flush()
frame = narrowDashboard.captureCharFrame()
assert.match(frame, /保存|SAVE CONFIGURATION/, 'Apply actions remain visible when configuration content scrolls on a short terminal')
narrowDashboard.renderer.destroy()

const wizard = await testRender(() => <OcpApp initialRoute="wizard" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await wizard.flush()
frame = wizard.captureCharFrame()
assert.match(frame, /Quick Install|快速安装/, 'wizard main menu renders through OpenTUI')
wizard.renderer.keyInput.emit('keypress', { name: 'down' })
await wizard.flush()
assert.match(wizard.captureCharFrame(), /Check Status|查看配置状态/, 'wizard retains status entry')
wizard.renderer.keyInput.emit('keypress', { name: 'down' })
await wizard.flush()
assert.match(wizard.captureCharFrame(), /Register Global Commands|注册全局快捷命令|Unregister Global Commands|注销全局快捷命令/, 'wizard retains global command management')
wizard.renderer.keyInput.emit('keypress', { name: 'down' })
await wizard.flush()
assert.match(wizard.captureCharFrame(), /Reset OpenCode Config Directory|重置.*配置目录/, 'wizard retains reset entry')
wizard.renderer.keyInput.emit('keypress', { name: 'down' })
await wizard.flush()
assert.match(wizard.captureCharFrame(), /Uninstall Managed Configs|卸载.*管理/, 'wizard retains uninstall entry')
for (let index = 0; index < 4; index++) wizard.renderer.keyInput.emit('keypress', { name: 'up' })
await wizard.flush()
wizard.renderer.keyInput.emit('keypress', { name: 'return' })
await settle(wizard)
assert.match(wizard.captureCharFrame(), /Quick Install|快速安装/, 'quick install opens its target prompt')
wizard.renderer.keyInput.emit('keypress', { name: 'escape' })
await settle(wizard)
wizard.renderer.destroy()

const dashboardFull = await testRender(() => <OcpApp initialRoute="dashboard" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await dashboardFull.flush()
frame = dashboardFull.captureCharFrame()
assert.match(frame, /Basic|基础/, 'dashboard renders Basic in the tab rail')
assert.match(frame, /Tools|工具/, 'dashboard renders Tools in the tab rail')
  dashboardFull.renderer.destroy()

  for (const key of ['return', 'space']) {
  const booleanDashboard = await testRender(() => <OcpApp initialRoute="dashboard" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
  await settle(booleanDashboard)
  booleanDashboard.renderer.keyInput.emit('keypress', { name: 'return' })
  await booleanDashboard.flush()
  booleanDashboard.renderer.keyInput.emit('keypress', { name: 'right' })
  await booleanDashboard.flush()
  for (let index = 0; index < 3; index++) {
      booleanDashboard.renderer.keyInput.emit('keypress', { name: 'down' })
      await booleanDashboard.flush()
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    await booleanDashboard.flush()
    assert.match(booleanDashboard.captureCharFrame(), /Global Commands|全局命令注册/, 'keyboard navigation reaches the global-commands toggle')
    booleanDashboard.renderer.keyInput.emit('keypress', { name: key })
    await booleanDashboard.flush()
    frame = booleanDashboard.captureCharFrame()
    assert.match(frame, /Global Commands|全局命令注册/, `boolean settings toggle in place with ${key}`)
    assert.match(frame, /ENABLED|DISABLED|已启用|已禁用/, `boolean toggles render an immediate state with ${key}`)
    assert.doesNotMatch(frame, /Enabled\s+Turn this integration on/, 'boolean settings do not open a selection modal')
    booleanDashboard.renderer.destroy()
  }

const dashboardNavigation = await testRender(() => <OcpApp initialRoute="dashboard" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await dashboardNavigation.flush()
dashboardNavigation.renderer.keyInput.emit('keypress', { name: 'right' })
await dashboardNavigation.flush()
assert.match(dashboardNavigation.captureCharFrame(), /Tools|工具/, 'keyboard tab navigation switches scoped panel content')
dashboardNavigation.renderer.keyInput.emit('keypress', { name: 'down' })
await dashboardNavigation.flush()
dashboardNavigation.renderer.keyInput.emit('keypress', { name: 'up' })
await dashboardNavigation.flush()
dashboardNavigation.renderer.keyInput.emit('keypress', { name: 'right' })
await dashboardNavigation.flush()
assert.match(dashboardNavigation.captureCharFrame(), /MCP/, 'Up on the first panel item returns focus to the tab row for horizontal navigation')
assert.doesNotMatch(dashboardNavigation.captureCharFrame(), /Primary agent/, 'Tools panel does not repeat Basic content')
assert.match(dashboardNavigation.captureCharFrame(), /SAVE CONFIGURATION|保存/, 'Review & Apply actions remain globally visible')
dashboardNavigation.renderer.destroy()

// Review tab: Enter on the rail focuses the panel, a second Enter on the
// static review panel opens the save-and-install confirmation (the summary
// has no select of its own, so Enter maps to the install action).
const reviewEnter = await testRender(() => <OcpApp initialRoute="dashboard" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await reviewEnter.flush()
for (let index = 0; index < 4; index++) {
  reviewEnter.renderer.keyInput.emit('keypress', { name: 'right' })
  await reviewEnter.flush()
}
assert.match(reviewEnter.captureCharFrame(), /Installation target|安装目标/, 'the Review tab panel is focused by the tab rail')
reviewEnter.renderer.keyInput.emit('keypress', { name: 'return' }) // rail → panel
await settle(reviewEnter)
reviewEnter.renderer.keyInput.emit('keypress', { name: 'return' }) // panel → install confirmation
await settle(reviewEnter)
assert.match(reviewEnter.captureCharFrame(), /SAVE & INSTALL NOW|保存并立即安装/, 'Enter on the review panel opens the install confirmation')
reviewEnter.renderer.keyInput.emit('keypress', { name: 'escape' })
await settle(reviewEnter)
reviewEnter.renderer.destroy()

const dashboardShortcuts = await testRender(() => <OcpApp initialRoute="dashboard" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await dashboardShortcuts.flush()
dashboardShortcuts.renderer.keyInput.emit('keypress', { name: 'a', ctrl: true, meta: false, shift: false, option: false, sequence: '\u0001', raw: '\u0001', eventType: 'press', source: 'raw', number: false })
await settle(dashboardShortcuts)
// captureCharFrame() consumes the frame — capture once and assert all
// confirmation-dialog properties against the same snapshot.
const confirmFrame = dashboardShortcuts.captureCharFrame()
assert.match(confirmFrame, /SAVE & INSTALL NOW|保存并立即安装/, 'Ctrl+A opens installation confirmation')
assert.match(confirmFrame, /Confirm|确认/, 'confirmation action is localized')
assert.match(confirmFrame, /Cancel|取消/, 'cancellation action is localized')
dashboardShortcuts.renderer.keyInput.emit('keypress', { name: 'escape' })
await dashboardShortcuts.flush()
dashboardShortcuts.renderer.keyInput.emit('keypress', { name: 'l' })
await dashboardShortcuts.flush()
assert.match(dashboardShortcuts.captureCharFrame(), /Switch Language|切换界面语言/, 'L keeps the dashboard language control available')
dashboardShortcuts.renderer.destroy()

// ─── confirm → install handoff: Confirm must reach the installer protocol ───
// The dashboard persists options.jsonc, then exits with UI_INSTALL_EXIT (20)
// so the parent `ocp dashboard` process falls through to executeInstall.
// Regression guard for "confirmation opens but installation never starts".
const dashboardInstall = await testRender(() => <OcpApp initialRoute="dashboard" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await dashboardInstall.flush()
dashboardInstall.renderer.keyInput.emit('keypress', { name: 'a', ctrl: true, meta: false, shift: false, option: false, sequence: '\u0001', raw: '\u0001', eventType: 'press', source: 'raw', number: false })
await settle(dashboardInstall)
dashboardInstall.renderer.keyInput.emit('keypress', { name: 'return' })
await settle(dashboardInstall)
assert.equal(process.exitCode, 20, 'confirming Save-and-install hands back to the CLI via UI_INSTALL_EXIT')
process.exitCode = 0 // the harness itself must still exit green
assert.match(readFileSync(path.join(cfgDir, 'options.jsonc'), 'utf8'), /"default_agent"/, 'confirming persists the dashboard selections before handing off')
dashboardInstall.renderer.destroy()

// ─── wizard quick install: same handoff protocol, one extra persist step ───
// The wizard's only delta vs the dashboard path is persisting its
// global-commands choice; installation itself must be handed off to the
// parent CLI through the shared UI_INSTALL_EXIT protocol.
writeFileSync(path.join(cfgDir, 'options.jsonc'), JSON.stringify({ global_commands: false }), 'utf8')
const sidecar = path.join(home, 'wizard-install-request.json')
process.env.OCP_UI_RESULT_FILE = sidecar
const wizardInstall = await testRender(() => <OcpApp initialRoute="wizard" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await wizardInstall.flush()
wizardInstall.renderer.keyInput.emit('keypress', { name: 'return' }) // Quick Install (first row while not installed)
await settle(wizardInstall)
wizardInstall.renderer.keyInput.emit('keypress', { name: 'return' }) // confirm the pre-filled target
await settle(wizardInstall)
wizardInstall.renderer.keyInput.emit('keypress', { name: 'up' }) // highlight "Register global commands" (current is "skip")
await settle(wizardInstall)
wizardInstall.renderer.keyInput.emit('keypress', { name: 'return' }) // confirm → persist delta + handoff
await settle(wizardInstall)
assert.equal(process.exitCode, 20, 'wizard quick install hands off via the shared UI_INSTALL_EXIT protocol')
process.exitCode = 0 // the harness itself must still exit green
assert.match(readFileSync(path.join(cfgDir, 'options.jsonc'), 'utf8'), /"global_commands": true/, 'wizard persists its global-commands delta before handing off')
const request = JSON.parse(readFileSync(sidecar, 'utf8'))
assert.equal(request.action, 'install', 'wizard writes the install request sidecar for the parent CLI')
assert.equal(request.target, path.join(home, '.config', 'opencode'), 'sidecar carries the wizard-chosen target dir')
delete process.env.OCP_UI_RESULT_FILE
wizardInstall.renderer.destroy()

// ─── host-layer select filtering (mirrors opencode's DialogSelect) ───
// The provider wizard root is a host select dialog without renderFilter —
// the type-down filter must narrow it as the user types, keep the kernel
// select's native arrow/return behavior, and collapse category headers.
const providerUi = await testRender(() => <OcpApp initialRoute="provider" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await settle(providerUi)
const providerRootFrame = providerUi.captureCharFrame()
assert.match(providerRootFrame, /Add custom provider|添加自定义服务商/, 'provider wizard root renders through the host select dialog')
assert.match(providerRootFrame, /⌕ /, 'filterable select dialogs render the type-down filter line')
const typeInto = (ui: { renderer: { keyInput: { emit: (event: string, payload: unknown) => void } } }, text: string) => {
  for (const ch of text) {
    ui.renderer.keyInput.emit('keypress', { name: ch, ctrl: false, meta: false, shift: false, option: false, sequence: ch, raw: ch, eventType: 'press', source: 'raw', number: false })
  }
}
typeInto(providerUi, 'acme')
await providerUi.flush()
const filteredFrame = providerUi.captureCharFrame()
assert.match(filteredFrame, /⌕ acme/, 'typed characters land in the filter line')
assert.match(filteredFrame, /Providers/, 'matching category header survives filtering')
assert.doesNotMatch(filteredFrame, /Add custom provider/, 'non-matching rows drop out of the list')
providerUi.renderer.keyInput.emit('keypress', { name: 'backspace', ctrl: false, meta: false, shift: false, option: false, sequence: '\u007f', raw: '\u007f', eventType: 'press', source: 'raw', number: false })
await providerUi.flush()
assert.match(providerUi.captureCharFrame(), /⌕ acm/, 'backspace trims the filter')
typeInto(providerUi, 'zzz')
await providerUi.flush()
assert.match(providerUi.captureCharFrame(), /No matches/, 'empty result state renders a hint')
for (let index = 0; index < 8; index++) {
  providerUi.renderer.keyInput.emit('keypress', { name: 'backspace', ctrl: false, meta: false, shift: false, option: false, sequence: '\u007f', raw: '\u007f', eventType: 'press', source: 'raw', number: false })
}
await settle(providerUi)
assert.match(providerUi.captureCharFrame(), /Add custom provider/, 'clearing the filter restores the full list')
providerUi.renderer.destroy()

// renderFilter: false opts out — the quick-install register prompt is a
// 2-option select where a filter line would be noise (OCP-owned dialogs
// curate this). Same flow as the wizardInstall handoff above: the yes/no
// register dialog opens after confirming the pre-filled target.
writeFileSync(path.join(cfgDir, 'options.jsonc'), JSON.stringify({ global_commands: false }), 'utf8')
const registerSidecar = path.join(home, 'register-filter-request.json')
process.env.OCP_UI_RESULT_FILE = registerSidecar
const registerUi = await testRender(() => <OcpApp initialRoute="wizard" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await registerUi.flush()
registerUi.renderer.keyInput.emit('keypress', { name: 'return' }) // Quick Install
await settle(registerUi)
registerUi.renderer.keyInput.emit('keypress', { name: 'return' }) // confirm the pre-filled target
await settle(registerUi)
const registerFrame = registerUi.captureCharFrame()
assert.match(registerFrame, /Register global commands|注册全局命令/, 'quick install reaches the register yes/no dialog')
assert.doesNotMatch(registerFrame, /⌕ /, 'renderFilter: false dialogs render no filter line')
process.exitCode = 0
delete process.env.OCP_UI_RESULT_FILE
registerUi.renderer.destroy()
writeFileSync(path.join(cfgDir, 'options.jsonc'), JSON.stringify({ global_commands: false }), 'utf8')


for (const route of ['dashboard', 'setup', 'project', 'home'] as const) {
  const ui = await testRender(() => <OcpApp initialRoute={route} context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
  await ui.flush()
  assert.match(ui.captureCharFrame(), route === 'project' ? /Project Setup|项目设置/ : /OpenCode Prime/)
  ui.renderer.destroy()
}

// ─── /project wizard accepts both navigation and type-to-filter input ──
const project = await testRender(() => <OcpApp initialRoute="project" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await settle(project)
frame = project.captureCharFrame()
assert.match(frame, /Select action|选择操作/, 'project action menu renders')
project.renderer.keyInput.emit('keypress', { name: 'down' })
project.renderer.keyInput.emit('keypress', { name: 'return' })
await settle(project)
assert.match(project.captureCharFrame(), /Configure Switches|配置开关/, 'project action is selectable')
project.renderer.keyInput.emit('keypress', { name: 'linefeed' })
await settle(project)
assert.match(project.captureCharFrame(), /lite|full|off|default/, 'Windows linefeed Enter opens the highlighted switch value chooser')
project.renderer.keyInput.emit('keypress', { name: 'down' })
project.renderer.keyInput.emit('keypress', { name: 'return' })
await settle(project)
assert.match(project.captureCharFrame(), /Configure Switches|配置开关/, 'value picker returns to the switch editor')
project.renderer.destroy()

// ─── /provider wizard is loaded verbatim into the standalone host ───
const provider = await testRender(() => <OcpApp initialRoute="provider" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await settle(provider)
  frame = provider.captureCharFrame()
assert.match(frame, /Provider wizard/, 'provider root dialog renders')
// The wizard focuses `current: ids[0]` (acme); arrow keys scroll the flat list
// back up to ➕ — mirroring the host's behavior — then Enter opens the add form.
for (let i = 0; i < 4; i++) provider.renderer.keyInput.emit('keypress', { name: 'up' })
await settle(provider)
assert.match(provider.captureCharFrame(), /Add custom provider/, 'cursor can reach the ➕ row')
provider.renderer.keyInput.emit('keypress', { name: 'return' })
await settle(provider)
frame = provider.captureCharFrame()
assert.match(frame, /Add custom provider . basic settings/, 'form page renders through the compat api')
// Esc unwinds one level back to the wizard root (onClose + navigated pattern).
provider.renderer.keyInput.emit('keypress', { name: 'escape' })
await settle(provider)
assert.match(provider.captureCharFrame(), /Provider wizard/, 'Esc returns to the root menu')
// Root Esc dismisses the stack → the route shows its closed screen.
provider.renderer.keyInput.emit('keypress', { name: 'escape' })
await settle(provider)
assert.match(provider.captureCharFrame(), /Wizard closed/)
provider.renderer.destroy()

// ─── /profile wizard is loaded verbatim into the standalone host ───
const profile = await testRender(() => <OcpApp initialRoute="profile" context={{ repoDir, root: repoDir }} />, { width: 110, height: 46 })
await settle(profile)
frame = profile.captureCharFrame()
assert.match(frame, /Profile wizard/, 'profile root dialog renders')
assert.match(frame, /Select: Profile/, 'full plugin main menu, not a controller stub')
assert.match(frame, /Edit: Agent.Tier/, 'tier editor entry present')
assert.match(frame, /Reset: Model refs/, 'reset entry present')
assert.match(frame, /── Actions ──/, 'category headers render as group rows')
// Select: Profile is the focused first action — Enter opens the picker list.
profile.renderer.keyInput.emit('keypress', { name: 'return' })
await settle(profile)
assert.match(profile.captureCharFrame(), /Pick a profile to review and apply|Profile wizard/, 'profile picker renders through the compat api')
assert.match(profile.captureCharFrame(), /acme-tiers/, 'sandbox profile is listed or applied')
profile.renderer.destroy()

// ─── /usage dialog width tiers (regression: setSize was a no-op) ────────────
// The usage plugin manages its dialog width through api.ui.dialog.setSize
// (opencode DialogAlert tiers 60/88/116). The standalone host must forward
// that to the Modal — a stale no-op rendered every dialog at the default 76%.
// A mock opencode server feeds the plugin's session/message queries so the
// real open path (dispatch → formatByDimension → presentView) runs end to end.
const usageMock = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url)
    const session = { id: 'ses_1', projectID: 'p', directory: '/', title: 'Test session', version: '1', time: { created: 1, updated: 2 } }
    if (url.pathname === '/session') return Response.json([session])
    if (url.pathname === '/session/ses_1') return Response.json(session)
    if (url.pathname === '/session/ses_1/children') return Response.json([])
    if (url.pathname === '/session/ses_1/message') {
      return Response.json([1, 2, 3].map((i) => ({
        info: { role: 'assistant', mode: 'build', agent: 'a-very-long-agent-name', providerID: 'anthropic', modelID: 'claude-pro', cost: 0.001 * i, tokens: { input: 1000 * i, output: 100 * i, reasoning: 0, cache: { read: 500 * i, write: 0 } } },
        parts: [{ type: 'step-finish' }],
      })))
    }
    return Response.json({})
  },
})
process.env.OPENCODE_SERVER_URL = `http://localhost:${usageMock.port}`
const dialogWidth = (frame: string) => {
  const line = frame.split('\n').find((candidate) => candidate.includes('╭'))
  return line ? (line.indexOf('╮') - line.indexOf('╭')) + 1 : -1
}
const usageUi = await testRender(() => <OcpApp initialRoute="usage" context={{ repoDir, root: repoDir, sessionId: 'ses_1', usageScope: 'current' }} />, { width: 140, height: 40 })
// First open races the models.dev catalog fetch (3s cap) — drain generously.
await new Promise((resolve) => setTimeout(resolve, 4000))
await usageUi.flush()
const usageFrame = usageUi.captureCharFrame()
assert.match(usageFrame, /Token usage/, 'usage report dialog renders through the compat host')
assert.equal(dialogWidth(usageFrame), 88, 'usage dialog renders at the large tier width (88), not the default fluid width')
usageUi.renderer.destroy()
usageMock.stop(true)
delete process.env.OPENCODE_SERVER_URL

console.log('ocp standalone host loads the original provider/profile OpenTUI wizards end to end')
