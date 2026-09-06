# 提示词披露分层

每个提示词文件在每次注入时都消耗 token。因此 OCP 按**违规代价而非文件体积**
把规则排进披露层——规则只在需要它的 Agent 运行时付费，与无关 Agent 完全隔离。

## 层级定义

| 层级 | 载体 | 付费时机 | 内容 |
|---|---|---|---|
| **L0** | `opencode.jsonc:instructions` | 每个 Agent 的每一步 | 铁律：`rfc-keywords`、`output-protocol`、`verification-honesty`、`routing-index` |
| **L1** | Agent 的 `prompt` 字段，经 `{file:}` 标记拼装 | 该 Agent 运行期间 | 角色规则：编码包、`sql-migration`、评审基准 |
| **L2** | `skills/*/SKILL.md` 元数据 | 每步常驻，可见性由 `permission` 控制；**正文经 `commands/*.md` 发射器按需加载** | 场景规则：工作流协议（`sdd-workflow`、`dev`、`goal`、`handoff` 等） |
| **L3** | 你项目的 `AGENTS.md`（OpenCode 原生） | 读取该目录文件时 | 你的个人 / 项目规则 |

L0 是最贵的层（× 步数 × Agent 数），因此发布门禁用
`scripts/measure-prompts.ts` 对其施加硬性 token 预算。

**单一事实来源。** Agent *定义*（mode、model、permission、tools、prompt
拼装）只存在于 jsonc 的 `agent` 块。`prompts/*.md` 片段是无 frontmatter
的纯正文，绝不能落在安装后配置的 `agents/` 目录下：opencode 会把
`agents/*.md` 自动发现为 agent 定义，其 frontmatter/body 会静默覆盖 jsonc
块（v1.18.25 已实证）。`prompts/` 不会被自动发现。

## L1 路由矩阵

| Agent | 附加规则文件 |
|---|---|
| `code`、`fast-coder`、`java-dev`、`python-dev`、`go-dev`、`rust-dev`、`node-dev`、`frontend-dev`、`devops`、`qa` | 编码包：`coding-principles` + `comment-strategy` + `edit-protocol` + `test-scope` |
| `dba` | 编码包 + `sql-migration` |
| `code-review` | `coding-principles` + `comment-strategy` + `test-scope`（无 `edit-protocol`——编辑权限已禁用） |
| `code-review-fast` | 共享评审正文 + `coding-principles`（仅 P0/P1 分诊；不报 nit / 不执行完整 test-scope） |
| `codegraph-scout`、`gitnexus-scout` | 仅自身的紧凑关系证据正文；无 L1 指令、无原生工具 |
| `architect`、`advisor`、`security` | 仅 `coding-principles`（评审基准） |
| `build`、`plan`、`explore`、`researcher`、`tech-writer`、`vision` | 无——仅吃 L0 |

## 每步可见性控制

两个常驻层改用 Agent 级权限门控而非披露（opencode v1.18.25 语义）：

- **skills 块** —— `{ "skill": { "name": "deny" } }` 从常驻 skills 块中移除单个技能；
  `{ "*": "deny" }` 清空整个块。工作流技能仅对 `build`、`plan`、`code`
  主代理可见；所有子代理一律拒绝 `"*"`。
- **MCP 工具面** —— `"<server>_*": { "*": "deny" }` 同时隐藏工具与 `mcp_instructions`
  块。代码情报服务器（`serena`、`codegraph`）只留给真正查代码的 Agent。
- **L0 剥离** —— `lite` 主 Agent 完全退出 L0：其内联 prompt 携带 `<!-- lite-mode -->`
  哨兵，`plugins/lite-mode.ts` 会把它连同所有 `Instructions from:` 块从系统提示中剥离。

分级审查中每个图谱后端只暴露给选定的 Scout；跨审查边界的只有受限关系证据，而非图谱工具定义。Scout 是可选的：无就绪后端时直接深审。

任何改动先用 `scripts/measure-prompts.ts` 量化，再发布。

## 插件注入门控

运行时的协议注入（护栏通告、作用域协议）由 `plugin-scope.json`（仓库根，
随清单发布）策略门控，唯一消费方为 `plugins/shared/plugin-scope.ts`。每个注入器在
触碰系统提示前都要 `await scoped(input, output.system, "<plugin-id>", client)`。

- **身份识别** —— 文本 `identifiers`（lite 哨兵、标题生成器前缀）加会话真值：
  `parentID` 非空即子代理步骤（按会话缓存；仅在文本未命中时查询）。
- **策略** —— 逐插件 `deny`/`allow` 列表，作用域文法 `x`（身份或态）与 `x:*`
  （态 `x` 的任意身份）；未声明的插件继承 `"*"` 默认条目。出厂默认：拒绝 `lite`、
  `utility`、`subagent:*` —— 注入不进被剥离的主代理，也不进任何子代理步骤。
  出厂有一处覆盖：`project-profiler` 仅拒绝 `lite`/`utility` —— 后端路由是子代理的
  工作纪律（explore.md 把后端选择委托给会话画像）。工作流协议无需此门控：它们在 L2，只在斜杠命令触发时加载。
- **失败开** —— 任何策略错误只跳过注入，不破坏步骤。

## 护栏

- `routing-index.md`（L0）保留所有按需规则的指针，规则降级不会丢失其背后的
  铁律义务（例如 SQL 迁移仍必须路由给 `@dba`；SDD 流程仍必须先加载技能）。
- L1 文件之间的简写交叉引用（`cp#N`）**只允许在同一披露单元内**——所有引用
  `cp#N` 的 Agent 都携带 `coding-principles.md`。
- 升级永远可传播：安装器以模板的 `instructions` 数组与出厂 Agent 为准；
  只有你自己新增的 Agent 会原样保留。

## 个人规则

个人或项目专属规则放在 **L3**：项目根目录的 `AGENTS.md`（OpenCode 在该项目
激活时原生加载）。不要修改出厂 `instructions` 数组——安装器每次升级都会以
模板覆盖它，这是设计行为。
