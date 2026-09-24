# 升级到 OCP 2.x（OpenCode v2 运行时）

OpenCode Prime 2.0.0 是一条**为 OpenCode v2 运行时（2.0.x 系列）打造的全新版本线**。
OCP 0.x 面向 v1 运行时，无法在 v2 上运行——反之亦然。本页给出完整的迁移说明：
什么会坏、安装器替你做什么、以及自研 v1 插件如何迁到 v2 API。

::: warning 硬性要求
OCP **2.x 需要 OpenCode 大版本 v2**。没有兼容垫片：v1 插件在 v2 上不会加载，
且 v1 的 OCP 包会拒绝 v2 运行时（反向同理）——在任何文件改动之前即被拦下。
该决策及被否决的备选方案记录于 **ADR-2.0.0**（仓库内
`docs/adr/2.0.0-adapt-opencode-prime-to-v2-runtime.md`）。
:::

## 升级步骤（TL;DR）

`ocp update` / `ocp upgrade` **不会**把你从 0.x 带到 2.0.0——大版本锁
（ADR-0.41.0）按设计拒绝跨大版本跳跃。刻意路径是一次全新安装：

1. **`ocp init`** —— 备份并清空目标配置（`~/.config/opencode`）。
2. 执行发布版一键安装命令（见[快速安装](./)）：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash   # POSIX
   ```

   ```powershell
   irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1 | iex          # Windows
   ```

随后 2.x 安装器会替你解析并钉住最新的 **v2** opencode 发布——运行时二进制
会发生什么，详见下节。

## 安装器做了什么

- **运行时解析**：opencode 安装通道（`@script:opencode`）查询 releases API，
  取最新的 **v2** tag——绝不取"latest overall"——API 不可达时回退到钉住的 v2 版本。
- **v1 → v2 运行时升级**：**用户 profile 内**的 v1 opencode 二进制会被就地升级
  （v2 沿用相同的配置位置）。由其他包管理器（brew/choco，位于 profile 之外）持有的
  v1 二进制会被判定为外部管理而拒绝触碰——请用对应管理器升级后再重跑。
- **未经同意绝不降级**：v3+ 二进制新于本 OCP 线可运行的范围，安装器直接拒绝且不触碰它。
- **双向兼容门禁**：v2 包遇到 v1 运行时（或 v1 包遇到 v2 运行时）会在**任何改动之前**
  被拒绝；安装完成后还会复检二进制大版本（TOCTOU 防护）。
- **配置保全**：API 密钥、自定义 provider/model 定义、模型层级选择与项目级插件开关
  在合并中存活。你手工编辑过的 v1 形状 `opencode.jsonc` 由运行时自带的配置归一化吸收
  （遗留键被迁移，而非报错拒绝）。
- **终端客户端迁移**：v1 的分层 `tui.json` / `tui.jsonc` 已退役。首次 v2 运行时，
  v1 遗留的 `tui.jsonc` **插件列表会被迁移**进唯一的全局文件
  `~/.config/opencode/cli.json`（由 `cli.template.jsonc` 合并生成，用户自加的插件保留）。
- **清理**：升级时会从配置目录移除仅存在于 v1 的过期文件（如旧的
  `plugins/rtk-write.ts` 根 barrel），并把 `@opencode/plugin` 安装进配置目录，
  让源码运行（source-run）插件能解析其 import。

## 什么会坏

| v1 表面（0.x 世界） | v2 现实 | 应对 |
|---|---|---|
| `tui.template.jsonc` / 分层 `tui.json(c)` | `cli.template.jsonc` → 唯一全局 `cli.json`（`theme{name,mode}`、`keybinds`、`plugins[]`） | 自定义 TUI 调优请重新落在 `cli.json` |
| 根配置 `agent` 块、`permission` 字符串/映射、根 `model`/`small_model` | V2 原生键：`agents`（复数）、有序 `permissions[]`（`{action, resource, effect}`，最后匹配生效）、`mcp.servers`；flash 层模型引用位于 `agents.title.model` | 手改的旧键由运行时归一化兜底；建议择机改写 |
| v1 插件（`server()` 导出、字符串键 hook 表） | **在 v2 上完全不运行**——无垫片 | 迁移（见下节）或放弃 |
| `providers/*.json` 预设形状 | 预设仍按 v1 定义形状（`npm`/`options`）发货，依赖运行时旧版归一化读取 | 无需动作；v2 原生预设表面留待后续迭代 |
| 配置级 `env` 块 | 在 v2 运行时上不生效（OCP 合并器保留你的块，但运行时不再消费） | 真实环境需求改用 shell 环境变量 / MCP `environment` |
| agent prompt 中的 `{file:}` / `{env:}` 标记 | 在 v2 上存活且语义不变——已端到端验证 | 无需动作 |

## 迁移自定义 v1 插件

v2 契约：每个入口从 **`@opencode/plugin`**（注意：包名不同于 v1 的
`@opencode-ai/plugin`）**默认导出** `Plugin.define({ id, setup })`。行为在
`setup(ctx)` 内通过**领域 hook** 与**同步注册表 transform** 注册，不再是单一
字符串键 hook 表：

| v1（字符串键 hook） | v2 替代 |
|---|---|
| `default export async function server(...)` 返回 `{ name, ...hooks }` | `Plugin.define({ id, setup(ctx) { ... } })`；注册返回 disposable，`setup` 返回清理函数 |
| `experimental.chat.system.transform` | `ctx.session.hook("context")`——修改 `SystemPart[]`；事件携带 `agent` 与 `model` 供作用域判定 |
| `chat.params` 等聊天期参数改写 | `ctx.session.hook(...)` 领域集：`context` / `prompt` / `compaction` / `model.request` |
| `tool.execute.before` / `tool.execute.after` | `ctx.tool.hook("execute.before")` / `ctx.tool.hook("execute.after")`——单一可变事件 |
| permission / question 拦截 | `ctx.permission.hook("evaluate")`（外加 `execute.after` 再授权——OCP 的 question 信任通道已重构至此） |
| shell 命令拦截 | `ctx.shell.hook("create.before")` |
| `event` 表（`file.edited`、`session.created`、`session.deleted` 等） | `ctx.event.subscribe(...)`——**`file.edited` 已不存在，改用 `filesystem.changed`**（跳过 `unlink`） |
| 经 config hook 注册 tool / command | `ctx.tool.transform(editor.add)`、`ctx.command.transform(editor.add)`，以及 `ctx.model.transform`、`ctx.agent.transform` 等 |
| TUI 插件 API（分层 `tui.json`、slot 内部件） | `@opencode/plugin/tui` 的 slot/keymap API；在全局 `cli.json` 的 `plugins[]` 列表注册 |

最小 v2 服务端插件示例：

```ts
// ~/.config/opencode/plugins/my-plugin.ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "my-plugin",
  setup(ctx) {
    ctx.session.hook("context", async (event) => {
      if (event.agent !== "build") return
      event.system.push({ type: "text", text: "<my directive>" })
    })
  },
})
```

参考实现：本套件的全部插件（`plugins/*.ts` barrel + `plugins/<name>/` 子目录）
都是可运行的 v2 示例；贡献者视角的细节在 `DEVELOPING.md` §"Plugin system"。

## 已接受的降级（OCP-V2-GAP 登记表）

v2 表面缺失某些 v1 能力时，OCP 选择接受**有记录的降级**而不是硬凑 hack。
每处降级在源码中都有 `OCP-V2-GAP` 注释（2.0.0 打 tag 时共 15 处）：

- **Toast 通知** → v2 插件 `Context` 没有 TUI 通知领域；公告降级为经
  `plugins/shared/notify.ts` 输出的服务端日志行（TUI 桥接是后续项）。
- **`/usage` 步数** → v2 把 steps 折叠为每回合一条 assistant 消息；该列以
  assistant 消息数作为最接近的代理指标。
- **工具结果标题** → v2 `Tool.Result` 没有 `title` 字段（tgrep、memory-note：
  标题移除，文本保留）。
- **命令级 variant 改写** → v2 `Command` 不携带模型引用；按 agent 的 variant
  被折叠到已验证的兄弟模型引用上并清除 variant 标记（`plugins/model-variants.ts`）。
- **Question 授权重构** → auto-advisor / ADR 压缩的用户通道信任现经
  `ctx.tool.hook("execute.after")` + `ctx.permission.hook("evaluate")` 实现。
- **忙碌模态** → v2 内建对话框没有 busy 属性；向导绘制一个最小静态面板，
  由结果对话框按单活动对话框模型替换之。
- **向导过滤框** → v2 的 select 对话框始终显示过滤框（provider 向导表单页的
  外观变化，仅美观层面）。

## 验证状态（诚实说明）

全部适配节点在**源码运行（source-run）**的 v2 运行时上通过了各自的单元测试门禁；
完整运行时集成测试与针对编译版（非源码运行）v2 二进制的最终端到端验证，
在 2.0.0 发布核对清单中跟踪。上文文档断言与打 tag 时的发货代码一致。

## 另见

- [快速安装与全景控制台](./) —— 全新安装流程
- [环境要求与源码开发](./prerequisites) —— 运行时要求
- [OCP 命令行参考](/zh/maintenance/ocp-cli) —— 大版本锁细节
- [插件系统与项目护栏](/zh/workflows/plugins) —— OCP 2.x 发货内容
- `install/versions/2.0.0.notes.md` —— 发布说明（GitHub）
- ADR-2.0.0 / ADR-0.41.0 —— 决策记录（GitHub：`docs/adr/`）
