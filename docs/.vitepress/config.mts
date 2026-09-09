import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
  defineConfig({
    title: "OpenCode Prime",
    description: "The Flagship Production Engineering & Multi-Agent Suite for OpenCode",
    base: "/",
    cleanUrls: true,
    lastUpdated: true,
    srcExclude: ['SUMMARY.md'],

    locales: {
      root: {
        label: 'English',
        lang: 'en',
        title: "OpenCode Prime",
        description: "The Flagship Production Engineering & Multi-Agent Suite for OpenCode",
        themeConfig: {
          siteTitle: 'OpenCode Prime',
          nav: [
            { text: 'Getting Started', link: '/getting-started/' },
            { text: 'Core Capabilities', link: '/core/daily-use' },
            { text: 'Workflows & Guards', link: '/workflows/commands' },
            { text: 'Maintenance', link: '/maintenance/options' },
            { text: 'GitHub', link: 'https://github.com/kenlin8827/opencode-prime' }
          ],
          sidebar: [
            {
              text: 'Part I: Installation & Setup',
              items: [
                { text: 'Quick Install & Dashboard', link: '/getting-started/' },
                { text: 'Project Initialization & Guardrails', link: '/getting-started/project-init' },
                { text: 'Clients & UI Options', link: '/getting-started/clients' },
                { text: 'Prerequisites & Source Install', link: '/getting-started/prerequisites' },
              ]
            },
            {
              text: 'Part II: Core Capabilities',
              items: [
                { text: 'Daily Use & Modes', link: '/core/daily-use' },
                { text: 'MCP Servers & Code Intelligence', link: '/core/mcp-servers' },
                { text: 'Configuration & Profiles', link: '/core/profiles' },
                { text: 'Prompt Disclosure Layers', link: '/core/prompt-layers' },
              ]
            },
            {
              text: 'Part III: Workflows & Governance',
              items: [
                { text: 'Workflow Slash Commands', link: '/workflows/commands' },
                { text: 'Git Workflows', link: '/workflows/git' },
                { text: 'Five Dev Flows', link: '/workflows/dev-loops' },
                { text: '/dev Compositor', link: '/workflows/dev' },
                { text: 'Specification-Driven Development (SDD)', link: '/workflows/sdd' },
                { text: 'Auto-Advisor Mode', link: '/workflows/auto-advisor' },
                { text: 'Plugins & Project Guardrails', link: '/workflows/plugins' },
                { text: 'Hierarchical ADR Upgrade Guide', link: '/workflows/adr-upgrade-guide' },
              ]
            },
            {
              text: 'Part IV: Maintenance & Reference',
              items: [
                { text: 'Installation & Options', link: '/maintenance/options' },
                { text: 'OCP CLI Reference', link: '/maintenance/ocp-cli' },
                { text: 'Troubleshooting & FAQ', link: '/maintenance/faq' },
              ]
            }
          ],
          footer: {
            message: 'Released under the MIT License.',
            copyright: 'Copyright © 2026 OpenCode Prime Contributors'
          }
        }
      },
      zh: {
        label: '简体中文',
        lang: 'zh-CN',
        link: '/zh/',
        title: "OpenCode Prime",
        description: "OpenCode 旗舰级生产工程与多智能体研发套件",
        themeConfig: {
          siteTitle: 'OpenCode Prime',
          nav: [
            { text: '快速起步', link: '/zh/getting-started/' },
            { text: '核心能力', link: '/zh/core/daily-use' },
            { text: '进阶工作流与护栏', link: '/zh/workflows/commands' },
            { text: '安装与运维', link: '/zh/maintenance/options' },
            { text: 'GitHub', link: 'https://github.com/kenlin8827/opencode-prime' }
          ],
          sidebar: {
            '/zh/': [
              {
                text: '第一部分：安装与上手',
                items: [
                  { text: '快速安装与全景控制台', link: '/zh/getting-started/' },
                  { text: '项目初始化与工程护栏', link: '/zh/getting-started/project-init' },
                  { text: '客户端与交互界面', link: '/zh/getting-started/clients' },
                  { text: '环境要求与源码开发', link: '/zh/getting-started/prerequisites' },
                ]
              },
              {
                text: '第二部分：核心能力与使用',
                items: [
                  { text: '日常使用与工作模式', link: '/zh/core/daily-use' },
                  { text: 'MCP 代码智能与数据库', link: '/zh/core/mcp-servers' },
                  { text: '模型配置与预设 Profiles', link: '/zh/core/profiles' },
                  { text: '提示词披露分层', link: '/zh/core/prompt-layers' },
                ]
              },
              {
                text: '第三部分：进阶工作流与护栏',
                items: [
                  { text: '工作流斜杠命令', link: '/zh/workflows/commands' },
                  { text: 'Git 工作流', link: '/zh/workflows/git' },
                  { text: '五档开发流', link: '/zh/workflows/dev-loops' },
                  { text: '/dev 组合引擎', link: '/zh/workflows/dev' },
                  { text: '规范驱动开发 (SDD)', link: '/zh/workflows/sdd' },
                  { text: 'Auto-advisor 模式', link: '/zh/workflows/auto-advisor' },
                  { text: '插件系统与项目护栏', link: '/zh/workflows/plugins' },
                  { text: '分层 ADR 体系升级指南', link: '/zh/workflows/adr-upgrade-guide' },
                ]
              },
              {
                text: '第四部分：安装进阶与运维',
                items: [
                  { text: '安装器进阶与选项', link: '/zh/maintenance/options' },
                  { text: 'OCP 命令行参考', link: '/zh/maintenance/ocp-cli' },
                  { text: '常见问题与排查 FAQ', link: '/zh/maintenance/faq' },
                ]
              }
            ]
          },
          footer: {
            message: '基于 MIT 协议发布。',
            copyright: 'Copyright © 2026 OpenCode Prime Contributors'
          }
        }
      }
    },

    themeConfig: {
      logo: '/logo.svg',
      socialLinks: [
        { icon: 'github', link: 'https://github.com/kenlin8827/opencode-prime' }
      ],
      search: {
        provider: 'local'
      }
    },

    vite: {
      optimizeDeps: {
        include: ['mermaid', 'fastdom', '@braintree/sanitize-url', 'dayjs'],
      },
      ssr: {
        noExternal: ['mermaid', 'vitepress-plugin-mermaid', 'fastdom'],
      }
    }
  })
)
