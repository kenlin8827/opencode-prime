# 工作流斜杠命令

OpenCode 多智能体配置自带一系列生产级工作流斜杠命令。

---

## 命令一览表

| 命令 | 分类 | 说明 |
|---|---|---|
| **`/prd <topic>`** | SDD 规范驱动 | 在 `docs/prd/` 中脚手架生成并起草需求规格说明书 (PRD) |
| **`/adr [new\|supersede\|tree\|check\|migrate\|mode]`** | 架构治理 | 架构决策记录（ADR）治理：自动起草、生命周期替代、DAG 拓扑树、完整性体检、双向分层重构与模式切换 |
| **`/plan <topic>`** | SDD 规范驱动 | 在 `docs/plan/` 中脚手架生成并起草分阶段实施计划 (PLAN)，自动关联 PRD 与 ADR |
| **`/impl [task]`** | SDD 规范驱动 | 依照 PRD/ADR/Plan 规范执行测试驱动编码实现与质量验证 |
| **`/sdd [status\|handoff\|help]`** | SDD 规范驱动 | 规范驱动开发导航、制品状态检查与专属跨会话暂存交接（`/sdd handoff`） |
| **`/grill-me <topic>`** | 架构与构思 | 逐题逼问式苏格拉底访谈，全方位磨砺需求与技术设计 |
| **`/dev <requirement> [--plan] [--sdd[="prd,adr,plan"]] [--plan-review[=1\|2]] [--code-review[=1\|2]] [--qa] [--fast] [--max-rounds=N] [--auto-advisor[=full\|lite\|off]]`** | 开发流 | **Dev 组合引擎**：单趟流水线引擎 —— 规格深度（`--plan` / `--sdd`）、计划评审、代码评审（1\|2）与 QA 标志自由组装流水线；`--auto-advisor` 仅本次运行覆盖 advisor 模式（裸值 = full）；预设 dev-quick/dev-plan/dev-review 是该引擎上的固定标志组合（详见 [/dev 组合引擎](dev.md)） |
| **`/dev-quick <task> [--review] [--max-rounds=N]`** | 开发流 | **Quick-Dev 极速免审直通**：Flash 档最低成本出码 + 动态领域灵魂注入（零审查开销，出码即交付，`--review` 触发单审，别名 `/dev-flash`；`/dev` 的零深度标志预设，详见 [五档开发流](dev-loops.md)） |
| **`/dev-plan <requirement> [--review] [--max-rounds=N]`** | 开发流 | **Plan-Dev 计划先行开发**：苏格拉底式澄清 + 架构师出计划 + 按领域路由实现，按需审查（`/dev` 的 `--plan` 预设，详见 [五档开发流](dev-loops.md)） |
| **`/dev-review <task> [--max-rounds=N]`** | 开发流 | **Review-Dev 深度双审共识闭环**：领域路由编码 + 双旗舰顶级会审 + Advisor 争议仲裁共识，支持全栈拆解汇总（`/dev` 的 `--code-review=2` 预设，详见 [五档开发流](dev-loops.md)） |
| **`/dev-ultra <objective> [--max-rounds=N] [--max-phases=N]`** | 开发流 | **Ultra-Dev 自主多阶段闭环**：端到端自主执行 —— 将大型目标分解为多阶段，每阶段按分级规则审查 + 上下文压缩 + 逐阶段 Git 提交隔离 + 一次 max 终审 + 支持 `--resume` 断点续跑（详见 [五档开发流](dev-loops.md)） |
| **`/dev-prud <requirement> [--top=N] [--max-rounds=N]`** | 开发流 | **FMEA 审慎开发**：苏格拉底式澄清 + 编码前风险登记册（SEV×PROB 排序，top-N），由登记册驱动计划、实现与逐条审计验证（详见 [审慎开发](dev-prud.md)） |
| **`/review-fix-loop [scope] [--max-rounds=N]`** | 质量自动化 | 自动化 审查→验证→修复→复审 循环，直到没有 P0/P1。范围：`last commit`、`HEAD~N`、`branch`、`PR`，或空（未提交变更） |
| **`/git-merge <source> <target> [--dry-run] [--no-verify] [--squash] [--no-ff] [--continue] [--abort]`** | Git 工程流 | **原生 `git merge`，agent 扮演解决冲突的人**：先把目标分支与 origin 同步（`--ff-only`，本地分叉即停）、建 guard 备份，再合并 —— git 能自动合的全部交给 git，只有冲突文件才做语义合并，且**目标 HEAD 是权威基线**。压成 1 个干净 commit → `--squash`；其他情况不带 flag（merge commit 保留双方拓扑） |
| **`/git-pick <source> <target> <commit>... [--all] [--dry-run] [--no-verify] [--continue] [--skip] [--abort]`** | Git 工程流 | **原生 `git cherry-pick`，agent 扮演解决冲突的人**：复制指定 commit；`--all` 时按拓扑逆序复制 source 有而 target 没有的全部非 merge commit，逐 commit 以 target 为基线解决冲突。每次都生成新的普通 commit（绝不生成 merge commit），source 历史不改写 |
| **`/git-rebase <source> <target> [--dry-run] [--no-verify] [--continue] [--skip] [--abort]`** | Git 工程流 | **原生 `git rebase`，agent 扮演解决冲突的人**：把源分支独有的全部 commit 重放到目标分支 HEAD 之上，得到线性历史 —— 同步目标分支、对**两个**尖端建 guard 备份、逐个停下的 commit 做语义解冲突，最后 fast-forward 目标分支。会改写 source：更新已推送的 source 需 `git push --force-with-lease`，由你决定 |
| **`/git-pull [--rebase] [--dry-run] [--no-verify] [--abort]`** | Git 工程流 | **当前分支的安全上游同步**：先试 `git pull --ff-only`，什么都不重写；已分叉 → 建 guard 备份，再委托 git-merge 协议（拉取到的上游引用作为 source）。`--rebase` 则把本地 commit 重放到远程 tip 之上。不支持 `--squash` —— 压扁已发布的分支历史永不正当 |
| **`/git-push [--rebase\|--merge] [--dry-run] [--no-verify] [--force-with-lease] [--abort]`** | Git 工程流 | **当前分支的安全推送**：先 fetch 配置的上游并尝试普通 `git push`；确认是 `non-fast-forward` → 建 guard，按 merge 或 rebase 调和、验证后重试。认证、策略、hook、网络和语义冲突会停下；裸 `--force` 永远禁止 |
| **`/grill-improve-loop [subject] [--max-rounds=N] [--target=N]`** | 评分驱动闭环 | 评分驱动改进闭环：评分→分析改进路径→修复/重构→验证→重新评分，直到结构性天花板、停滞或最大轮次。每轮触发 verification-honesty 评分机制（规则 5–7） |
| **`/goal [text]`** | 自动化协议 | 结构化目标执行协议，包含审计友好的验收清单和可机械检测的停止条件 |
| **`/handoff [focus]`** | 状态交接 | 将当前会话状态压缩为轻量交接包（存至 Git 忽略的 `.ocp/handoffs/`），生成新会话一键恢复开场白 |
| **`/adr-guard [on\|off\|status]`** | 质量硬门禁 | 项目级 ADR 提交铁律门禁：拦截缺少架构决策记录的 `feat:` 与 `refactor:` 提交 |
| **`/e2e-guard [on\|off\|status]`** | 质量硬门禁 | 项目级 E2E 测试硬门禁：在功能变更和 Bug 修复时强制进行端到端测试覆盖检查 |
| **`/env-guard [on\|off\|status]`** | 安全护栏 | 项目级敏感信息防泄漏护栏：拦截读取或向 Bash 暴露 `.env` 等凭据的行为 |
| **`/deepseek-anchor [on\|off\|status]`** | 模型增强 | DeepSeek V4/Pro 深度思考锚定插件：防止思考过程退化，并在推理阶段实施工具阻断 |
| **`/auto-advisor [off\|lite\|full]`** | 智能决策 | 切换 Advisor 智能决策模式（`off` 关闭 / `lite` 决策建议 / `full` 事实类自动代答） |
| **`/md-to-pdf <file.md> [output.pdf]`** | 出版级导出 | Markdown 一键转高清 A4 PDF，支持 300 DPI Mermaid 图表、CSS 样式定制与 `--doctor` 自检修复 |
| **`/md-to-docx <file.md> [output.docx]`** | 出版级导出 | Markdown 导出为行政级 Word (.docx)，支持纯 TS 引擎、中西双字排版、Mermaid 渲染与样式定制 |
| **`/project`（或 `init`/`index`/`sync` 子命令）** | 项目管理 | `init\|index\|sync` 子命令用于脚手架生成项目基线文件（`.ocp/ocp.json` 等），并自动触发 CodeGraph 与 GitNexus 索引；裸的 `/project` 打开交互式项目配置向导（通过终端可视化菜单一键开启或关闭各项 MCP 服务与功能插件） |
| **`/memory [note\|status\|on\|off]`** (+ `/memory-summarize [focus]`) | 项目记忆 | 项目级记忆双 scope：`/memory note "<经验>"` 写入 `.ocp/memory/public.md`（进 git，PR 审阅）；`--private` 写入 `private.md`（gitignored，仅当前用户）。LLM 发现可复用规则时也可调用 `memory_note` 工具。`/memory-summarize [focus]` 回顾当前会话并沉淀持久经验。两个文件均以 `[PROJECT MEMORY]` 注入（冲突时 AGENTS.md 权威）。每段超 16k 字符上限改为指针块。 |
| **`/profile`** | 交互向导 (TUI) | 打开模型预设弹窗选择器：一键切换或精细配置 Auto / Ultimate / Performance / Economy / Lightweight 各层级模型 |
| **`/provider`** | 交互向导 (TUI) | 打开服务商向导：为已激活或仓库自带的服务商配置凭证（baseURL / apiKey），管理模型清单 |
| **`/disconnect [id\|--all]`** | 交互向导 (TUI) | 断开服务商密钥：裸打开连接向导；`<id>` 直达确认；`--all` 一次确认所有连接 |
| **`/queued`** | 交互向导 (TUI) | 打开排队消息管理对话框：实时查看、编辑或取消在会话忙碌期间提交的排队提示词 |
| **`/usage [session\|agent\|model\|all]`** | 可观测性 | 按会话 / Agent / 模型分 tab 查看 token/费用消耗 —— 1/2/3 或 ←→ 切换，↑/↓ 滚动 |

> 五个 `/git-*` 命令共用一套教义：前置检查只会停下而不替你收拾残局、适用时用 `--ff-only` 同步目标分支、`guard/` 备份、基线优先的冲突解决、逐 hunk 置信度自检（不确定则升级 `@advisor`，仍不确信就交还给你、绝不瞎猜）、只验证一次且诚实报告，以及**每次**调用都写入 `.git/ocp-*-reports/` 的脱敏哈希链审计轨迹。完整教义、flag 矩阵与故障表：**[Git 工作流](git.md)**。



---

## 示例：review-fix-loop

```
> /review-fix-loop last commit
  → @code-review-fast 发现 P0/P1 问题；符合条件的 L3 会先由一个按能力选择的图谱 Scout 提供紧凑关系证据，再交给 @code-review
  → 验证每个发现（读代码、追踪数据流、检查上游守卫）
  → 若为误报 → @advisor 确认后方可跳过
  → 若确认真 BUG → @<领域开发> 修复每个已验证问题
  → @code-review-fast 复审；最终 Cleared 门禁使用 max @code-review
  → 重复直到清零或达到最大轮次（默认 5）
  → 输出总结：结论 + 统计数据

> /review-fix-loop HEAD~3 --max-rounds=8
  → 相同流程，允许最多 8 轮（适用于较大 diff）
```
