# 日常使用与工作模式

OpenCode 多智能体配置提供默认的 `@lite` 轻量模式，三种编排模式（`@code`、`@build`、`@plan`），并允许直接调度领域专家智能体。

---

## Lite 模式（默认）

`@lite` 是默认入口 —— 精益、全能、随叫随到：快速修复、查询、问答、小改动、起草、分析。它是唯一做到**实测近零提示词开销**的模式：0 L1 token、0 常驻 skills/MCP 定义、L0 在运行时剥离。满配 Agent 每步要背负 **13k+ token** 的提示词开销，而 `@lite` 的完整系统提示实测仅 **约 2k token**。

```
> @lite 这个函数是干什么的？
> @lite 重命名这个变量并修好所有调用点
```

`@lite` 覆盖 80% 的日常任务。当任务超出能力范围时，它会主动建议升级到 `@code`（深度单域开发）、`@build`（多域编排）、`@code-review-fast`（普通审查）、`@code-review`（敏感/终审）或 `@advisor`。派发策略：助手仅凭显式要求触发；唯一例外是 `@vision`，遇到 lite 自己看不见的图片时自主补位。

---

## Code 模式（直接开发）

切换到 `@code` 进行直接开发 —— 自己动手编写、修改、测试和验证代码，不主动委托：

```
> @code 修复分页逻辑里的差一错误
> @code 给注册表单加上输入校验
```

仍可按需手动委托辅助类 subagent（`@advisor`、`@explore`、`@code-review-fast`、`@code-review`、`@vision`）。如果任务实际上是跨领域的，`@code` 会建议切换到 `@build`。

---

## Build 模式（编排）

跨领域任务切换到 `@build` — 它会自动将你的任务路由给专家团里合适的成员：

```
> 添加一个 Spring Boot 用户注册接口，使用 JPA 和 BCrypt
  → @build 调度到 @java-dev

> 审查我最近的提交，关注安全问题
  → @build 按分级规则调度：默认 @code-review-fast；符合条件的 L3 仅使用一个按能力选择的图谱 Scout 产出紧凑关系证据，否则直接交给 @code-review（需要时追加 @security）

> 设计一个新支付服务的架构
  → @build 调度到 @architect（先展示多步计划）
```

你不需要手动指定智能体 — 只需描述任务。对于跨领域任务，`@build` 会先展示执行计划再开始。

---

## Plan 模式（只读）

切换到 `@plan` 进行仅分析任务（不修改代码）：

```
> @plan 审计代码库的技术债务和安全漏洞
  → @plan 并行调度 @architect、@security、@code-review-fast、@qa；L3/终审再追加深度审查
  → 汇总报告，按优先级给出建议
```

通过 `Tab` 或 `@lite` / `@code` / `@build` / `@plan` 在四种模式之间切换。

---

## 直接调用专家

你可以跳过编排器，直接调用专家团的成员：

```
> @dba 优化 orders 表的索引
> @frontend-dev 用设计令牌创建一个可复用的 Button 组件
> @code-review 审查 PR #42
```

---

## 多步工作流示例

对于复杂功能，`@build` 会创建并执行计划：

```
## 执行计划

1. [@architect] — 设计事件溯源架构 → ADR + 设计文档
2. [@dba] — 设计事件存储 schema → DDL + 迁移脚本
3. [@java-dev] — 实现生产者和消费者 → 代码 + 测试
4. [@qa] — 编写集成测试 → 测试套件
5. [@security] — 安全审查 → 报告
6. [@code-review] — 代码审查 → 审查报告
7. [@tech-writer] — 编写文档 → README + API 文档

是否继续？
```
