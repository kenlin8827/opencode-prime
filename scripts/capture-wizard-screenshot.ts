import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

function getProjectWizardHtml(lang: 'zh' | 'en'): string {
  const isZh = lang === 'zh';

  const texts = isZh ? {
    windowTitle: 'opencode — /project init (项目初始化向导)',
    targetLabel: '📍 目标工程: /home/user/workspace/order-service',
    backendsTitle: '代码智能后端 (Code Intelligence):',
    serenaReport: '✅ Serena LSP: 语义符号与 AST 语法索引构建完成 (Java / TS / Go / Python)',
    codegraphReport: '✅ CodeGraph: 代码知识图谱与多跳调用关系分析完成 (2,840 节点, 6,120 条边)',
    structureTitle: '工程目录结构 (Project Structure):',
    configReport: '✅ 已创建 .opencode/opencode.jsonc (项目专属护栏开关配置)',
    adrReport: '✅ 已创建 docs/adr/ (架构决策记录 ADR 存储目录)',
    sddReport: '✅ 已创建 docs/specs/ (规范驱动开发 SDD 骨架目录)',
    dialogTitle: 'Project Wizard — 项目级工程护栏与开关配置',
    advisorLabel: 'Auto Advisor 模式',
    advisorHint: '轻量顾问：在关键架构决策与阻塞设计时介入',
    adrLabel: 'ADR Guard',
    adrHint: '架构决策记录 (ADR) 强制门禁，防止架构漂移',
    adrModeLabel: 'ADR Layout',
    adrModeHint: '自适应扁平目录或分层子模块 ADR 存储',
    envLabel: 'Env Guard',
    envHint: '敏感凭证与 .env 配置文件防泄漏安全门控',
    e2eLabel: 'E2E Guard',
    e2eHint: '端到端集成测试与交付验证门控',
    btnSave: '💾 保存并应用项目配置 (Save & Apply)',
    footer: '↑/↓: 移动光标  •  Enter/Space: 循环切换状态  •  Esc: 退出向导',
  } : {
    windowTitle: 'opencode — /project init (Project Wizard)',
    targetLabel: '📍 Target: /home/user/workspace/order-service',
    backendsTitle: 'Backends (Code Intelligence):',
    serenaReport: '✅ Serena LSP: Semantic symbol indexing completed (Java / TS / Go / Python)',
    codegraphReport: '✅ CodeGraph: Multi-hop AST graph constructed (2,840 nodes, 6,120 edges)',
    structureTitle: 'Project Structure:',
    configReport: '✅ created .opencode/opencode.jsonc (Project switches)',
    adrReport: '✅ created docs/adr/ (Architecture Decision Records scaffold)',
    sddReport: '✅ created docs/specs/ (Spec-Driven Development scaffold)',
    dialogTitle: 'Project Wizard — Project Guardrails & Configuration',
    advisorLabel: 'Auto Advisor Mode',
    advisorHint: 'Lite advisor: triggers on blocking design reviews',
    adrLabel: 'ADR Guard',
    adrHint: 'Architecture Decision Record enforcement gate',
    adrModeLabel: 'ADR Layout',
    adrModeHint: 'Adaptive flat or hierarchical ADR directory',
    envLabel: 'Env Guard',
    envHint: 'Secret & .env sensitive credential leak prevention',
    e2eLabel: 'E2E Guard',
    e2eHint: 'End-to-End verification test delivery gate',
    btnSave: '💾 Save & Apply Project Settings',
    footer: '↑/↓: Move  •  Enter/Space: Toggle status  •  Esc: Exit',
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
    .prompt-line {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #89b4fa;
      font-weight: bold;
      margin-bottom: 14px;
    }
    .prompt-cmd {
      color: #a6e3a1;
    }
    .report-box {
      background: #11111b;
      border: 1px solid #313244;
      border-radius: 8px;
      padding: 14px 18px;
      margin-bottom: 20px;
      font-size: 12.5px;
    }
    .report-header {
      color: #89dceb;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .report-item {
      color: #a6e3a1;
      padding-left: 8px;
    }
    .wizard-dialog {
      background: #1e1e2e;
      border: 1px solid #89b4fa;
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      padding: 16px 20px;
    }
    .dialog-title {
      color: #89dceb;
      font-weight: 700;
      font-size: 13.5px;
      padding-bottom: 10px;
      margin-bottom: 12px;
      border-bottom: 1px dashed #313244;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .row {
      display: flex;
      align-items: center;
      padding: 4px 0;
      gap: 12px;
    }
    .row.active {
      background: rgba(137, 180, 250, 0.15);
      border-radius: 4px;
      padding: 4px 8px;
      margin-left: -8px;
      margin-right: -8px;
    }
    .cursor {
      color: #89dceb;
      font-weight: bold;
      width: 14px;
    }
    .badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .badge-on { background: #1e3a2f; color: #a6e3a1; border: 1px solid rgba(166, 227, 161, 0.3); }
    .badge-lite { background: #1e3a2f; color: #a6e3a1; }
    .badge-auto { background: #1e3a45; color: #89dceb; }
    .label {
      font-weight: 600;
      color: #cdd6f4;
      min-width: 160px;
    }
    .label.highlight { color: #f9e2af; font-weight: bold; }
    .dim {
      color: #6c7086;
      font-size: 12px;
    }
    .save-btn {
      margin-top: 14px;
      padding: 6px 16px;
      background: #89dceb;
      color: #11111b;
      font-weight: 700;
      border-radius: 4px;
      display: inline-block;
      font-size: 12px;
    }
    .footer {
      margin-top: 14px;
      text-align: center;
      color: #89dceb;
      font-size: 11.5px;
      border-top: 1px dashed #313244;
      padding-top: 10px;
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
      <div class="prompt-line">
        <span>opencode ❯</span>
        <span class="prompt-cmd">/project init</span>
      </div>

      <!-- Scaffolding & Indexing Report -->
      <div class="report-box">
        <div class="report-header">${texts.targetLabel}</div>
        <div style="color: #89b4fa; margin: 4px 0 2px 0;">${texts.backendsTitle}</div>
        <div class="report-item">${texts.serenaReport}</div>
        <div class="report-item">${texts.codegraphReport}</div>
        <div style="color: #89b4fa; margin: 8px 0 2px 0;">${texts.structureTitle}</div>
        <div class="report-item">${texts.configReport}</div>
        <div class="report-item">${texts.adrReport}</div>
        <div class="report-item">${texts.sddReport}</div>
      </div>

      <!-- Interactive Project Wizard Dialog -->
      <div class="wizard-dialog">
        <div class="dialog-title">
          <span>🎯</span>
          <span>${texts.dialogTitle}</span>
        </div>

        <div class="row active">
          <span class="cursor">▶</span>
          <span class="label highlight">${texts.advisorLabel}</span>
          <span class="badge badge-lite">[ 🟢 lite ]</span>
          <span class="dim">${texts.advisorHint}</span>
        </div>

        <div class="row" style="padding-left: 14px;">
          <span class="label">${texts.adrLabel}</span>
          <span class="badge badge-on">[ 🟢 ON   ]</span>
          <span class="dim">${texts.adrHint}</span>
        </div>

        <div class="row" style="padding-left: 14px;">
          <span class="label">${texts.adrModeLabel}</span>
          <span class="badge badge-auto">[ 🟢 auto ]</span>
          <span class="dim">${texts.adrModeHint}</span>
        </div>

        <div class="row" style="padding-left: 14px;">
          <span class="label">${texts.envLabel}</span>
          <span class="badge badge-on">[ 🟢 ON   ]</span>
          <span class="dim">${texts.envHint}</span>
        </div>

        <div class="row" style="padding-left: 14px;">
          <span class="label">${texts.e2eLabel}</span>
          <span class="badge badge-on">[ 🟢 ON   ]</span>
          <span class="dim">${texts.e2eHint}</span>
        </div>

        <div class="row" style="padding-left: 14px; margin-top: 8px;">
          <div class="save-btn">${texts.btnSave}</div>
        </div>

        <div class="footer">
          💡 ${texts.footer}
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function main() {
  const repoDir = process.cwd();
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

  // 1. Capture Chinese Project Wizard
  const zhWizardHtml = getProjectWizardHtml('zh');
  await page.setContent(zhWizardHtml);
  const zhWizardWindow = await page.$('.window');
  if (zhWizardWindow) {
    await zhWizardWindow.screenshot({
      path: path.join(outDir, 'tui-project-wizard-zh.webp'),
      type: 'webp',
      quality: 95,
    });
    console.log('  ✓ Generated docs/public/images/tui-project-wizard-zh.webp');
  }

  // 2. Capture English Project Wizard
  const enWizardHtml = getProjectWizardHtml('en');
  await page.setContent(enWizardHtml);
  const enWizardWindow = await page.$('.window');
  if (enWizardWindow) {
    await enWizardWindow.screenshot({
      path: path.join(outDir, 'tui-project-wizard-en.webp'),
      type: 'webp',
      quality: 95,
    });
    console.log('  ✓ Generated docs/public/images/tui-project-wizard-en.webp');
  }

  await browser.close();
}

main().catch(console.error);
