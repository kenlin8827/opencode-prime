import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

function getTerminalHtml(lang: 'zh' | 'en', version: string): string {
  const isZh = lang === 'zh';

  const texts = isZh ? {
    windowTitle: 'OpenCode Prime (OCP) — 全景交互控制台 (TUI Dashboard)',
    headerTitle: `OpenCode Prime 全景控制台 [v${version}] [Lang: zh-CN]`,
    coreSection: '核心工作模式与压缩',
    primaryAgent: '主力工作模式',
    primaryAgentHint: '(空格切换: code ➔ build ➔ plan)',
    rtkLabel: 'RTK 令牌压缩器',
    rtkHint: '(减少 60-90% 上下文 Token 消耗)',
    mcpSection: 'MCP 代码智能与数据库服务矩阵',
    serenaHint: 'Serena LSP (Python/TS/Go/Rust/Java/C++ 语言服务)',
    codegraphHint: 'CodeGraph 代码知识图谱与多跳调用关系分析',
    gitnexusHint: 'GitNexus 分支提交历史与跨文件代码溯源',
    dbhubHint: 'DBHub 数据库网关与多引擎安全只读查询',
    pluginSection: '项目工程护栏与扩展插件',
    adrHint: '架构决策记录 (ADR) 强制门禁，防止架构漂移',
    envHint: '敏感凭证与 .env 配置文件防泄漏门控',
    e2eHint: '端到端 (E2E) 集成测试与验证门控',
    pmHint: '项目规范管理与规范驱动开发 (SDD) 闭环',
    tiersSection: '智能体模型梯队分配 (Agent Tier Governance)',
    tierHint: '(空格键循环调整模型梯队)',
    targetSection: '目标安装目录 (Target Directory)',
    actionSection: '操作执行 (Actions)',
    btnInstall: '🚀 保存配置并执行安装 (Save & Install)',
    btnSave: '💾 仅保存选项 (Save Options Only)',
    btnExit: '❌ 退出控制台 (Exit)',
    footer: '↑/↓/j/k: 移动光标  •  Space: 切换开关/循环梯队  •  Enter: 选中/执行  •  L: 切换语言  •  Q: 退出',
    on: '✓ 开启',
    off: '  关闭',
    fastCoderHint: '极速响应与日常快速编码',
    codeReviewHint: '深度逻辑审查与架构把关',
    frontendHint: '现代 Web 框架与组件交付',
  } : {
    windowTitle: 'OpenCode Prime (OCP) — TUI Panoramic Dashboard',
    headerTitle: `OpenCode Prime Panoramic Dashboard [v${version}] [Lang: en]`,
    coreSection: 'Core Mode & Token Optimizer',
    primaryAgent: 'Primary Agent Mode',
    primaryAgentHint: '(Space to cycle: code ➔ build ➔ plan)',
    rtkLabel: 'RTK Token Compressor',
    rtkHint: '(Compress 60-90% CLI output tokens)',
    mcpSection: 'MCP Code Intelligence & Database Matrix',
    serenaHint: 'Serena LSP (Python/TS/Go/Rust/Java/C++ language server)',
    codegraphHint: 'CodeGraph multi-hop architectural dependency graph',
    gitnexusHint: 'GitNexus commit timeline & cross-file code lineage',
    dbhubHint: 'DBHub database gateway & multi-engine safe querying',
    pluginSection: 'Engineering Guardrails & Plugins',
    adrHint: 'Architecture Decision Record (ADR) enforcement gate',
    envHint: 'Secret & .env sensitive credential leak prevention',
    e2eHint: 'End-to-End (E2E) verification test gate',
    pmHint: 'Project discipline & Spec-Driven Development (SDD)',
    tiersSection: 'Agent Model Tier Governance',
    tierHint: '(Space to cycle tier: flash ➔ standard ➔ pro ➔ max ➔ vision)',
    targetSection: 'Target Directory',
    actionSection: 'Execution Actions',
    btnInstall: '🚀 Save & Execute Install',
    btnSave: '💾 Save Options Only',
    btnExit: '❌ Exit Dashboard',
    footer: '↑/↓/j/k: Move  •  Space: Toggle / Cycle  •  Enter: Select / Run  •  L: Switch Lang  •  Q: Exit',
    on: '✓ ON ',
    off: '  OFF',
    fastCoderHint: 'Fast feedback & low-latency iteration',
    codeReviewHint: 'Deep architectural & logic review',
    frontendHint: 'Modern UI/UX & component delivery',
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: transparent;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 30px;
      font-family: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Menlo', 'Consolas', monospace;
      -webkit-font-smoothing: antialiased;
    }
    .window {
      width: 920px;
      background: #181825;
      border-radius: 14px;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.08);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .title-bar {
      height: 42px;
      background: #11111b;
      display: flex;
      align-items: center;
      padding: 0 16px;
      position: relative;
      border-bottom: 1px solid #313244;
    }
    .traffic-lights {
      display: flex;
      gap: 8px;
    }
    .traffic-lights span {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      display: inline-block;
    }
    .btn-red { background: #f38ba8; }
    .btn-yellow { background: #f9e2af; }
    .btn-green { background: #a6e3a1; }
    .window-title {
      position: absolute;
      left: 0;
      right: 0;
      text-align: center;
      color: #6c7086;
      font-size: 12px;
      font-weight: 500;
    }
    .terminal-body {
      padding: 24px 28px;
      font-size: 13px;
      line-height: 1.6;
      color: #cdd6f4;
    }
    .header-box {
      border: 1px dashed #89b4fa;
      background: rgba(137, 180, 250, 0.08);
      border-radius: 6px;
      padding: 8px 16px;
      color: #89dceb;
      font-weight: 700;
      font-size: 13.5px;
      margin-bottom: 18px;
    }
    .section-title {
      color: #89b4fa;
      font-weight: 700;
      margin-top: 14px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-title.cyan { color: #89dceb; }
    .section-title.green { color: #a6e3a1; }
    .section-title.magenta { color: #cba6f7; }
    .row {
      display: flex;
      align-items: center;
      padding: 2px 0;
      gap: 12px;
    }
    .row.active {
      background: rgba(49, 50, 68, 0.6);
      border-radius: 4px;
      padding: 2px 8px;
      margin-left: -8px;
      margin-right: -8px;
    }
    .cursor {
      color: #89dceb;
      font-weight: bold;
      width: 14px;
    }
    .badge {
      padding: 1px 8px;
      border-radius: 4px;
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.5px;
      display: inline-block;
    }
    .badge-on { background: #1e3a2f; color: #a6e3a1; border: 1px solid rgba(166, 227, 161, 0.3); }
    .badge-off { background: #313244; color: #6c7086; }
    .badge-agent { background: #313244; color: #f9e2af; font-weight: bold; }
    .tier-flash { background: #3e381e; color: #f9e2af; }
    .tier-pro { background: #1e3a2f; color: #a6e3a1; }
    .tier-max { background: #38214a; color: #cba6f7; }
    .tier-standard { background: #1e3a45; color: #89dceb; }
    .label {
      font-weight: 600;
      color: #cdd6f4;
      min-width: 130px;
    }
    .label.highlight { color: #f9e2af; font-weight: bold; }
    .dim {
      color: #6c7086;
      font-size: 12px;
    }
    .actions-bar {
      display: flex;
      gap: 14px;
      margin-top: 18px;
      padding-top: 12px;
      border-top: 1px solid #313244;
    }
    .btn {
      padding: 7px 18px;
      border-radius: 6px;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-primary {
      background: #89dceb;
      color: #11111b;
      box-shadow: 0 0 16px rgba(137, 220, 235, 0.35);
    }
    .btn-secondary {
      background: #313244;
      color: #89b4fa;
      border: 1px solid rgba(137, 180, 250, 0.3);
    }
    .btn-danger {
      background: #313244;
      color: #f38ba8;
      border: 1px solid rgba(243, 139, 168, 0.3);
    }
    .footer {
      margin-top: 16px;
      padding-top: 10px;
      border-top: 1px dashed #313244;
      text-align: center;
      color: #89dceb;
      font-size: 11.5px;
    }
  </style>
</head>
<body>
  <div class="window">
    <div class="title-bar">
      <div class="traffic-lights">
        <span class="btn-red"></span>
        <span class="btn-yellow"></span>
        <span class="btn-green"></span>
      </div>
      <div class="window-title">${texts.windowTitle}</div>
    </div>
    <div class="terminal-body">
      <div class="header-box">
        ┌─ ${texts.headerTitle} ─┐
      </div>

      <!-- Core Section -->
      <div class="section-title">■ ${texts.coreSection}</div>
      <div class="row" style="padding-left: 14px;">
        <span class="label">${texts.primaryAgent}:</span>
        <span class="badge badge-agent">code</span>
        <span class="dim">${texts.primaryAgentHint}</span>
      </div>
      <div class="row" style="padding-left: 14px;">
        <span class="label">${texts.rtkLabel}:</span>
        <span class="badge badge-on">[ ${texts.on} ]</span>
        <span class="dim">${texts.rtkHint}</span>
      </div>

      <!-- MCP Section -->
      <div class="section-title cyan">■ ${texts.mcpSection}</div>
      <div class="row" style="padding-left: 14px;">
        <span class="badge badge-on">[ ${texts.on} ]</span>
        <span class="label highlight" style="min-width: 110px;">serena-lsp</span>
        <span class="dim">${texts.serenaHint}</span>
      </div>
      <div class="row" style="padding-left: 14px;">
        <span class="badge badge-on">[ ${texts.on} ]</span>
        <span class="label highlight" style="min-width: 110px;">codegraph</span>
        <span class="dim">${texts.codegraphHint}</span>
      </div>
      <div class="row" style="padding-left: 14px;">
        <span class="badge badge-on">[ ${texts.on} ]</span>
        <span class="label highlight" style="min-width: 110px;">gitnexus</span>
        <span class="dim">${texts.gitnexusHint}</span>
      </div>
      <div class="row" style="padding-left: 14px;">
        <span class="badge badge-on">[ ${texts.on} ]</span>
        <span class="label highlight" style="min-width: 110px;">dbhub</span>
        <span class="dim">${texts.dbhubHint}</span>
      </div>

      <!-- Plugins Section -->
      <div class="section-title green">■ ${texts.pluginSection}</div>
      <div class="row" style="padding-left: 14px;">
        <span class="badge badge-on">[ ${texts.on} ]</span>
        <span class="label" style="min-width: 130px;">adr</span>
        <span class="dim">${texts.adrHint}</span>
      </div>
      <div class="row" style="padding-left: 14px;">
        <span class="badge badge-on">[ ${texts.on} ]</span>
        <span class="label" style="min-width: 130px;">env-guard</span>
        <span class="dim">${texts.envHint}</span>
      </div>
      <div class="row" style="padding-left: 14px;">
        <span class="badge badge-on">[ ${texts.on} ]</span>
        <span class="label" style="min-width: 130px;">e2e-guard</span>
        <span class="dim">${texts.e2eHint}</span>
      </div>
      <div class="row" style="padding-left: 14px;">
        <span class="badge badge-on">[ ${texts.on} ]</span>
        <span class="label" style="min-width: 130px;">project-manager</span>
        <span class="dim">${texts.pmHint}</span>
      </div>

      <!-- Tiers Section -->
      <div class="section-title magenta">■ ${texts.tiersSection} <span class="dim" style="font-weight: normal; margin-left: 12px;">${texts.tierHint}</span></div>
      <div class="row active">
        <span class="cursor">▶</span>
        <span class="label highlight" style="min-width: 110px;">@fast-coder</span>
        <span class="dim">:</span>
        <span class="badge tier-flash">[ flash    ]</span>
        <span class="dim">${texts.fastCoderHint}</span>
      </div>
      <div class="row" style="padding-left: 14px;">
        <span class="label" style="min-width: 110px;">@code-review</span>
        <span class="dim">:</span>
        <span class="badge tier-max">[ max      ]</span>
        <span class="dim">${texts.codeReviewHint}</span>
      </div>
      <div class="row" style="padding-left: 14px;">
        <span class="label" style="min-width: 110px;">@frontend-dev</span>
        <span class="dim">:</span>
        <span class="badge tier-standard">[ standard ]</span>
        <span class="dim">${texts.frontendHint}</span>
      </div>

      <!-- Actions -->
      <div class="actions-bar">
        <div class="btn btn-primary">${texts.btnInstall}</div>
        <div class="btn btn-secondary">${texts.btnSave}</div>
        <div class="btn btn-danger">${texts.btnExit}</div>
      </div>

      <div class="footer">
        💡 ${texts.footer}
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function main() {
  const repoDir = process.cwd();
  const versionJson = path.join(repoDir, 'install', 'version.json');
  let version = '1.5.0';
  if (fs.existsSync(versionJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(versionJson, 'utf8'));
      if (parsed && typeof parsed.version === 'string' && parsed.version.trim()) version = parsed.version.trim();
    } catch {
      // keep fallback
    }
  }

  const outDir = path.join(repoDir, 'docs', 'public', 'images');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
  });
  const context = await browser.newContext({
    deviceScaleFactor: 2, // High-DPI Retina screenshot
    viewport: { width: 1040, height: 960 },
  });

  const page = await context.newPage();

  // 1. Capture Chinese Dashboard
  const zhHtml = getTerminalHtml('zh', version);
  await page.setContent(zhHtml);
  const zhWindow = await page.$('.window');
  if (zhWindow) {
    await zhWindow.screenshot({
      path: path.join(outDir, 'tui-dashboard-zh.webp'),
      type: 'webp',
      quality: 95,
    });
    console.log('  ✓ Generated docs/public/images/tui-dashboard-zh.webp');
  }

  // 2. Capture English Dashboard
  const enHtml = getTerminalHtml('en', version);
  await page.setContent(enHtml);
  const enWindow = await page.$('.window');
  if (enWindow) {
    await enWindow.screenshot({
      path: path.join(outDir, 'tui-dashboard-en.webp'),
      type: 'webp',
      quality: 95,
    });
    console.log('  ✓ Generated docs/public/images/tui-dashboard-en.webp');
  }

  await browser.close();
}

main().catch(console.error);
