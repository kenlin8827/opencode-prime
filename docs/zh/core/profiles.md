# 模型配置与预设（Profiles）

在 OpenCode 内完成服务商连接、5 大模型层级映射与自定义路由配置。

---

## 在 opencode 内配置服务商（推荐）

对于现有服务商（如官方 DeepSeek、Kimi、通义千问等 API，非自建 LLM Router），通过 OpenCode 的斜杠命令配置：

```
/connect <provider-name>    # 连接到现有服务商
/profile                    # 打开预设选择弹窗
```

**配置流程：**

1. **连接服务商** — 使用 `/connect` 命令连接到已存在的 provider
2. **选择预设** — 使用 `/profile` 打开选择弹窗，选中该服务商对应的配置预设

**示例：**

```
> /connect deepseek
  → 连接到 DeepSeek 服务商
> /profile
  → 弹窗打开 — 选中 "deepseek" 条目即可应用官方 API 预设配置
```

**重要提示：** 配置完成后请退出当前 opencode 会话并重新进入，以确保新的 provider 和 profile 配置完全生效。

---

## 配置预设（Profiles）

配置预设是一个命名预设，将服务商与各层级模型选择打包在一起，一次性应用，而非逐层级 `set model`。

### 可用预设全景表

| 预设 | 分类 | 说明 |
|---|---|---|
| `deepseek` | 官方 API 直连 | 官方 DeepSeek API 直连 (V3.2 Reasoner, Chat, V4 Flash) |
| `anthropic` | 官方 API 直连 | 官方 Anthropic API (Claude 3.5/3.7 Sonnet, Opus, Haiku) |
| `openai` | 官方 API 直连 | 官方 OpenAI API (GPT-5, o3-mini, o4-preview) |
| `google` | 官方 API 直连 | 官方 Google Gemini API (Gemini 2.5 Flash, 2.5 Pro) |
| `kimi-for-coding` | 官方 Coding Plan | 月之暗面 Kimi For Coding 官方开发套餐 (K1.5 / K2 系列) |
| `alibaba/coding-plan` / `-cn` | 官方 Coding Plan | 阿里百炼通义千问 Coding 计划 (Qwen3-Coder, Qwen3.7-Plus) |
| `alibaba/token-plan` / `-cn` | 官方 Coding Plan | 阿里百炼 Token 计划 (DeepSeek V4 Flash / Qwen 3.8 Max) |
| `alibaba/token-plan-cn-deepseek` | 官方 Coding Plan | 阿里百炼 Token 计划的全 DeepSeek 变体 (V4 Flash / V4 Pro) |
| `minimax/coding-plan` / `minimax/cn-coding-plan` | 官方 Coding Plan | 稀宇科技 MiniMax 官方开发套餐 (M2.7, M3) |
| `zhipuai-coding-plan` | 官方 Coding Plan | 智谱 AI 官方 Coding 计划 (GLM-5.1, GLM-5.2, GLM-5v) |
| `zai-coding-plan` | 官方 Coding Plan | Z.AI 官方开发套餐 (GLM 系列) |
| `tencent/coding-plan` | 官方 Coding Plan | 腾讯混元 Coding 计划 (Hunyuan Turbo, TC Code, MiniMax M2.5) |
| `tencent/token-plan` | 官方 Coding Plan | 腾讯混元 Token 计划 (HY3) |
| `xiaomi/token-plan-cn` / `-ams` / `-sgp` | 官方 Coding Plan | 小米大模型 Token 计划（国内 / 欧洲 / 新加坡节点，MiMo v2.5 系列） |
| `opencode-go/ultimate` | OpenCode Go 网关 | 旗舰质量优先满血阶梯 (Kimi K2.7-Code / Qwen 3.8 Max / Grok 4.6) |
| `opencode-go/performance` | OpenCode Go 网关 | 日常主力性价比平衡阶梯 |
| `opencode-go/economy` | OpenCode Go 网关 | 经济实惠高性价比阶梯 |
| `opencode-go/lite` | OpenCode Go 网关 | 最低可用成本极速阶梯 |
| `opencode-go/deepseek` | OpenCode Go 网关 | 全 DeepSeek 模型族纯享预设 |
| `opencode-go/kimi` | OpenCode Go 网关 | 全 Kimi 模型族纯享预设 |
| `opencode-go/qwen` | OpenCode Go 网关 | 全 Qwen 模型族纯享预设 |
| `opencode-go/glm` | OpenCode Go 网关 | 全 GLM 模型族纯享预设 |
| `opencode-zen/ultimate` | OpenCode Zen 网关 | 成本红线内的最强选择 (DeepSeek V4 Flash / Gemini 3.8 Flash / GPT-5.6 Sol / Grok 4.6) |
| `opencode-zen/performance` | OpenCode Zen 网关 | 日常主力，`max` 具备评审能力 (DeepSeek V4 Flash / Kimi K2.7-Code / GPT-5.3 Codex / GPT-5.6 Terra) |
| `opencode-zen/economy` | OpenCode Zen 网关 | 面向高频日常编码的成本优化阶梯 (Gemini 3.5 Flash Lite / GPT-5.1 / GPT-5.1 Codex / DeepSeek V4 Pro) |
| `opencode-zen/lite` | OpenCode Zen 网关 | 成本最低，`max` 仍保持评审能力 (Ling 3.0 Flash Fin Free / Gemini 3.5 Flash Lite / MiniMax M2.7) |
| `opencode-zen/claude` | OpenCode Zen 网关 | 全 Claude 模型族纯享预设 (Haiku 4.5 / Sonnet 5 / Sonnet 4.6) |
| `opencode-zen/gpt` | OpenCode Zen 网关 | 全 GPT codex 线 (5.1 Codex Mini / 5.1 / 5.3 Codex / 5.6 Terra) |
| `opencode-zen/gemini` | OpenCode Zen 网关 | 全 Gemini 模型族纯享预设 (3.5 Flash Lite / 3.6 Flash / 3.8 Flash / 3.1 Pro) |
| `opencode-zen/deepseek` | OpenCode Zen 网关 | 全 DeepSeek 模型族纯享预设 (V4 Flash / V4 Pro / V4 Flash Vision EXP) |
| `opencode-zen/kimi` | OpenCode Zen 网关 | 全 Kimi 模型族纯享预设 (K2.5 / K2.6 / K2.7-Code / K3) |
| `opencode-zen/qwen` | OpenCode Zen 网关 | 全 Qwen 模型族纯享预设 (3.5 Plus / 3.6 Plus) |
| `opencode-zen/glm` | OpenCode Zen 网关 | 全 GLM 模型族纯享预设 (5.3 Flash / 5.1 / 5.2 / 5.3) |
| `qoder/default` | 订阅与网关 | Qoder 订阅，经 opencode-qoder-bridge（需 `qoder login`） |
| `qoder/deepseek` / `qoder/qwen` | 订阅与网关 | Qoder 平台上的 DeepSeek / Qwen 纯享预设 |
| `router/antigravity` | 自建网关 | 自建 Antigravity 网关（Gemini Flash/Pro + Claude Sonnet/Opus Thinking） |
| `router/claude-code` | 自建网关 | 自建 Claude Code 网关（Anthropic 协议） |
| `router/codex` | 自建网关 | 自建 codex 网关（Sol/Luna 系列） |
| `router/qoder` | 自建网关 | 自建 qoder 网关（Ultimate/Performance/Lite） |
| `router/llm` | 自建网关 | 服务端路由基线 |

### 使用预设

`/profile` 斜杠命令打开一个向导，包含三个入口：

1. **Edit: Agent→Tier** — 重新分配 agent 所属层级（flash/standard/pro/max/vision），写 `tiers.json`
2. **Manage: Profile→Models** — 编辑预设的 tier→model 映射，或添加/删除预设文件
3. **Select: Profile** — 选一个预设并立即应用（写 `opencode.jsonc`）

无需参数，直接打开原生弹窗选择器：

```
/profile
  ┌─ 第一层：主菜单
  │
  ├─ "Edit: Agent→Tier"  ────────── 见下方 § Edit: Agent→Tier
  ├─ "Manage: Profile→Models"  ──── 见下方 § Manage: Profile→Models
  ├─ "Select: Profile"  ─────────── 见下方 § Select: Profile
  └─ "🧹 Reset: Model refs"  ────── 确认对话框 → 清空所有模型引用
  │
  → 在主菜单按 Esc 关闭向导
```

`reset` 子命令移除向导写入的全部模型引用：

```
/profile reset
→ 确认对话框列出全部引用 → 从 `opencode.jsonc` 移除根 `model`、`small_model`
  及所有 `agent.*.model`（保留 .bak 备份），并停用当前预设。opencode 回落到
  原生模型选择器。预设文件与 `tiers.json` 保留 — 重置清的是“已应用状态”，
  不是“库存”。重启后生效。
```

#### Edit: Agent→Tier

重新分配 agent 所属层级 — 不触及 tier→model 侧：

```
/profile → "Edit: Agent→Tier"
  ┌─ 第二层：Agent 列表
  │
  │  列出全部 agent 及其当前层级和模型：
  │    advisor    (max)   — model: anthropic/claude-opus
  │    code       (pro)   — model: anthropic/claude-sonnet
  │    explore    (flash) — model: anthropic/claude-haiku
  │    ...
  │
  │  有变更的 agent 显示 pending 状态：
  │    dba        (pro → max)  ← pending
  │
  │  ├─ "( Apply changes )"  → 写入 tiers.json + 热生效模型
  │  ├─ 选中任意 agent  ────→ 第三层：层级选择器
  │  └─ "( Back )"  ─────────→ 返回主菜单
  │
  └─ 第三层：层级选择器（按 agent）
     │
     ├─ flash     "快速 / 轻量 — 代码粗筛，高吞吐"
     ├─ standard  "通用主力 — 编排中枢（根模型）"
     ├─ pro        "专业级 — 最强编码模型"
     ├─ max        "旗舰推理 — 深度分析，审查，设计"
     ├─ vision     "多模态 — 图像/截图分析"
     └─ "( Back )"  ──→ 返回 agent 列表（保留 pending 变更）
```

**Apply 时发生什么：**

1. `tiers.json` 原子重写（备份 `.bak` → 写 tmp → rename）；`$comment` 字段保留。
2. 对每个变更的 agent，将其在 `opencode.jsonc` 中的 `model` 更新为新层级的当前引用 — 来源为当前活跃预设的 `tiers[newTier]`，或已使用该层级的第一个 agent 的 model。
3. 优先通过服务端全局配置 API 热生效（无需重启）。旧版降级为直写 `opencode.jsonc`（备份 `.bak`，需重启）。

**操作示例：**

```
> /profile
  → 选 "Edit: Agent→Tier"
  → 选 "code"（当前 pro）
  → 选 "pro"
  → toast: "code: pro → pro (no change)"
  → 选 "dba"（当前 pro）
  → 选 "max"
  → toast: "dba: pro → max (pending)"
  → "( Apply changes )"
  → toast: "1 tier change applied — dba → max (anthropic/claude-opus). Live, no restart needed."
```

#### Manage: Profile→Models

编辑预设的 tier→model 映射，或添加/删除预设：

```
/profile → "Manage: Profile→Models"
  ┌─ 第二层：预设列表
  │
  │  ├─ opencode-go-glm  ← active  — 描述...
  │  ├─ opencode-go-kimi          — 描述...
  │  ├─ ...
  │  ├─ "( Add profile )"  ────→ 输入名称，创建空白 JSON
  │  ├─ "( Delete profile )"  ──→ 选中预设删除（保留 .bak 备份）
  │  └─ "( Back )"  ─────────→ 返回主菜单
  │
  └─ 第三层：层级审阅（按预设）
     │
     │  列出选中预设的各层级及其 provider/model 引用：
     │    flash     glm-4-flash
     │    standard  glm-4-plus
     │    pro       glm-4-plus
     │    max       glm-4-long
     │    vision    glm-4v
     │
     │  ├─ "( Apply changes )"  → 写入预设 JSON + 应用到 opencode.jsonc
     │  ├─ 选中任意层级  ─────→ 第四层：provider 选择器
     │  ├─ "( Back )"  ──────→ 返回预设列表（保留覆写）
     │  └─ "( Cancel )"  ────→ 丢弃覆写，返回预设列表
     │
     └─ 第四层：Provider 选择器
        │
        ├─ anthropic  — 5 model(s) · built-in · connected
        ├─ openai     — 3 model(s) · built-in
        ├─ ...
        ├─ "( Type a custom ref )"  ──→ 手动输入 '<provider>/<model_id>'
        └─ "( Back )"  ───────────→ 返回层级审阅
        │
        └─ 第五层：Model 选择器（按 provider）
           │
           ├─ claude-sonnet  — Claude 3.7 Sonnet
           ├─ claude-opus    — Claude 3.7 Opus
           ├─ ...
           └─ "( Back )"  ──→ 返回 provider 列表
```

**Apply 时发生什么：**

1. 预设 JSON 文件（`~/.config/opencode/profiles/<name>.json`）原子重写（备份 `.bak` → 写 tmp → rename），写入覆写后的 tier→model 引用。
2. 更新后的预设应用到 `opencode.jsonc` — 每个 agent 的 `model` 按其层级重写为新的引用。
3. 更新 `.active-profile`。优先通过服务端全局配置 API 热生效（无需重启）。

#### Select: Profile

选一个预设并立即应用 — 无中间审阅：

```
/profile → "Select: Profile"
  ┌─ 第二层：预设列表
  │
  │  ├─ opencode-go-glm  ← active  — 描述...
  │  ├─ opencode-go-kimi          — 描述...
  │  ├─ ...
  │  └─ "( Back )"  ─────────→ 返回主菜单
  │
  └─ 选中预设 → 立即应用（与旧行为一致）
```

> **提示：** 三个分支互补使用。用 **Edit: Agent→Tier** 决定 *哪个 agent 属于哪个 tier*（写 `tiers.json`），用 **Manage: Profile→Models** 决定 *某个预设里每个 tier 用哪个 model*（写预设 JSON + `opencode.jsonc`），用 **Select: Profile** 快速切换预设。agent→tier 映射在重装时保留（`PreserveBag` 机制）。

> **Esc 行为：** 在任意弹窗层级，按 Esc 都会返回上一级（而非关闭整个向导）。只有在主菜单（第一层）按 Esc 才会关闭向导。

> **国际化 (i18n)：** 所有 TUI 向导插件（`/profile`、`/provider`、`/project`、`/queued`）均支持国际化。首次使用时自动从系统区域设置/环境变量检测语言，之后存储在 `api.kv` 中。每个向导的主菜单底部都有 `🌐 中文 → English`（或反向）选项，可即时切换语言 — 菜单会立即以新语言重新渲染。翻译集中维护在 `plugins/i18n.ts`。

---

## 模型路由与 5 大层级架构

系统使用 5 个模型层级，每个层级映射到一组智能体：

| 层级 | 用途 | 智能体 |
|---|---|---|
| `flash` | 快速，轻量，代码粗筛，高吞吐 | explore, fast-coder |
| `standard` | 通用编排中枢，高吞吐主力（根模型） | build, plan, researcher, tech-writer |
| `pro` | 专业全栈工程、代码生成与实现、常规审查分诊 | code, code-review-fast, codegraph-scout, gitnexus-scout, java/python/go/rust/node-dev, frontend-dev, qa, dba, devops |
| `max` | 深度推理，系统架构，安全合规，严苛审查 | advisor, architect, security, code-review |
| `vision` | 图像理解与多模态分析 | vision |

每个层级解析到当前活跃预设为它映射的 provider/模型。**Variant**（low/medium/high）控制每个智能体的思考/推理深度；如果后端模型不支持 variant，会被静默忽略。

---

## 自定义服务商（`/provider` 向导）

`/provider` 斜杠命令（通过 `tui.template.jsonc` 注册的 TUI 插件）以原生弹窗端到端配置自定义服务商 — 无需参数：

```
/provider
  → 一级弹窗："➕ 添加自定义服务商"（空白）和 "📦 添加预设服务商…"
    （将 providers/*.json 定义文件导入配置）置顶，
    其下是 opencode.jsonc 中已存储的服务商
  → 二级（服务商详情）：
    ⚙ 基础设置… — 表单（新增时可编辑 id / name / npm / baseURL / apiKey）；
      字段先在内存中修改，💾 时通过 opencode.jsonc 原子写入一次性保存；
      apiKey 留空保留已存密钥，密钥永不明文预填；'{env:VAR}' 令牌留在
      options.apiKey，明文密钥写入 ~/.local/share/opencode/auth.json —
      与官方 /connect 命令同一存储
    📥 拉取模型… — 输入 glob 模式（默认 *），从线上 {baseURL}/models
      (openai) 或 /v1/models (anthropic) 端点导入匹配的模型；
      仅追加 — 已有 key 跳过，不覆盖不删除
    ── 模型 ── — 与配置节点镜像；点开模型表单（身份 / 能力 / 限制），
      🗑 删除该条目
    ➕ 添加模型… — 同一模型表单新建条目
    🗑 删除服务商… — 确认后删除整个配置条目
  → 每一级都只用 Esc 返回；变更需重启 opencode 生效
```

---

## LLM Router 凭证

对于 `llm-router` 自定义服务商，通过下面的环境变量设置 `baseURL` / `apiKey`（推荐）、通过 `/provider` 向导（交互式），或直接编辑 `~/.config/opencode/providers/llm-router.json`（这是 opencode 加载的预设定义文件，`opencode.jsonc` 不再内联 `llm-router` 块）。

> `/provider` 向导把明文 API 密钥存入 `~/.local/share/opencode/auth.json` — 与官方 `/connect` 命令同一存储，两者保持一致。

### 环境变量（推荐用于 API 密钥）

```powershell
# PowerShell ($PROFILE)
$env:LLM_ROUTER_BASE_URL = "https://router.example.com/v1"
$env:LLM_ROUTER_API_KEY  = "sk-xxxx"
```

```bash
# Bash (~/.bashrc 或 ~/.zshrc)
export LLM_ROUTER_BASE_URL="https://router.example.com/v1"
export LLM_ROUTER_API_KEY="sk-xxxx"
```

---

## Qoder 服务商（`opencode-qoder-bridge`）

[opencode-qoder-bridge](https://github.com/naoufalelbani/opencode-qoder-bridge) 插件已列入仓库自带模板 `opencode.template.jsonc` 的 `plugin` 数组，启动时自动注入 `qoder` 服务商及其完整模型目录 —— 无需 provider 块或 API 密钥。它通过官方 `@qoder-ai/qoder-agent-sdk` 与 Qoder 通信，使用你的 Qoder CLI 凭证。

前置条件：
- Node.js `^22.18 || >=24.11`
- 已安装 Qoder CLI 并登录：`qoder login`（凭证存于 `~/.qoder/.auth/user`）

然后重启 opencode，通过 `/profile` 应用自带的 `qoder` 预设。
