# 五档开发流

五档开发流是 OpenCode 生产级工程化配置的**核心工作流体系**。

每一种开发流代表一种**开发哲学**——在速度、深度、自主性和风险态度之间的不同取舍。根据任务性质选择，而非线性的"更好/更差"层级。

三条线性开发流（`/dev-quick`、`/dev-plan`、`/dev-review`）已实现为同一个 [`/dev`](dev.md) 组合引擎的**预设**——每条都展开为 `/dev` 上的一组标志。`/dev-prud` 与 `/dev-ultra` 仍是独立协议（拓扑不同）。无预设匹配时可直接调用 `/dev`。

---

## 五种开发流速览

| 开发流 | 理念 | 适用场景 |
|---|---|---|
| `/dev-quick` ⚡ | **零摩擦** —— flash 档出码，审查可选 | 临时脚本、极简改动、样式微调、快速原型 |
| `/dev-plan` 📋 | **计划先行** —— 澄清需求、出计划、再实现（审查可选） | 日常默认：希望在编码前审批计划的功能 |
| `/dev-review` 🧠 | **深度共识** —— 双旗舰顶级会审 + 争议仲裁 | 20% 核心高危：分布式事务、全栈跨端、安全敏感 |
| `/dev-prud` 🛡️ | **风险优先** —— 编码前先做 FMEA，风险登记册驱动全流程 | 安全攸关场景：金融支付、核心鉴权、医疗航空，任何出错可能造成伤害的场景 |
| `/dev-ultra` 🛸 | **完全自主** —— 输入目标，多阶段自主执行，零交互 | 横跨多领域的大型系统交付 |
| [`/dev`](dev.md) 🧩 | **可组合 —— 自带流水线** | 预设不覆盖的组合：`--plan --code-review=2 --qa`、`--sdd="adr,plan"` |

---

## 各开发流详解

### `/dev-quick` — 极速免审直通

```
用户 → @build → @fast-coder (Flash) → 交付
```

- **审查**: 默认无；`--review` 触发单审
- **轮次**: 1 轮（即刻）
- **模型**: Flash/Lite 档，最大化吞吐
- **不适用于**: 零仪式 + 全质量 —— 直接提需求即可（`lite` → `@code`），无需工作流
- **别名**: `/dev-flash`

### `/dev-plan` — 计划先行开发

```
用户 → @build → @advisor (澄清) → @architect (出计划) → 确认 → @<lang>-dev (实现) → 可选分级审查 → 交付
```

- **阶段**: 澄清 → 计划 → 确认 → 实现 → [可选审查]
- **审查**: 默认无；`--review` 默认使用 `@code-review-fast`，L3/终审升级到 max `@code-review`（上限 5 轮）
- **退出**: 计划确认 + 实现交付（若启用审查则需通过）

### `/dev-prud` — FMEA 审慎开发

```
用户 → 苏格拉底澄清 → FMEA 风险登记册 → 风险驱动计划 → 实现 → 登记册审计验证
```

- **核心**: 编码前风险枚举（SEV×PROB 排序，Top-N）
- **审查**: 可配置（0/1/2 审——风险登记册决定审查深度）
- **退出**: Top-N 风险全部在登记册中验证闭环
- **详见**: [审慎开发](dev-prud.md) 完整协议

### `/dev-review` — 深度双审共识闭环

```
用户 → @build → @<lang>-dev → @architect (审查A) + @code-review-fast (审查B) → @advisor 仲裁 → max `@code-review` 终审 → 共识
```

- **审查**: `@architect` + `@code-review-fast`，随后由 max `@code-review` 执行终审门禁
- **编码**: 按领域路由（`@<lang>-dev`）
- **仲裁**: `@advisor` 按 Safety-First 原则处理分歧
- **轮次**: 上限 10 轮（通常 3~5 轮收敛）
- **退出**: 双审共识

### `/dev-ultra` — 自主多阶段执行

```
用户 → 目标 → @build 拆解 → 阶段0: @explore → 循环[阶段1..N: 编码 + 分级审查] → max 终审 → 最终验证
```

- **审查**: L1/L2 使用架构师 + 快速审查；符合条件的 L3 走深度路径；仅一次 max 终审
- **自主性**: 高——用户给目标，调度器驱动全部阶段
- **阶段数**: 默认 6（推荐 3~6；上下文压缩后可达 8~10）
- **停机**: 连续 3 阶段熔断、文件 > 100、外部依赖不可用
- **断点续跑**: `--resume` 读取 `.ocp/dev-ultra-state.md`

---

## 开发流选择决策树

```
                    是否是横跨多领域的大型目标？
                   /                          \
                 是                            否
                 /                              \
           🛸 /dev-ultra                Bug 是否会伤害人身或业务？
           (完全自主)                    /                        \
                                       是                          否
                                       /                            \
                                🛡️ /dev-prud                  是否是核心高危场景
                                (风险优先)                   (分布式事务、全栈跨端)？
                                                           /                      \
                                                         是                                                        否
                                                         /                                                            \
                                                   🧠 /dev-review                                           编码前是否需要审批计划？
                                                   (深度共识)                                                  /              \
                                                                                                              是                否
                                                                                                              /                    \
                                                                                                        📋 /dev-plan          ⚡ /dev-quick
                                                                                                        (计划先行)            (零摩擦)
```

---

## 对比矩阵

| 维度 | ⚡ `/dev-quick` | 📋 `/dev-plan` | 🧠 `/dev-review` | 🛡️ `/dev-prud` | 🛸 `/dev-ultra` | 🧩 `/dev` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **开发哲学** | 零摩擦 | 计划先行 | 深度共识 | 风险优先 FMEA | 完全自主 | 可组合 —— 自带流水线 |
| **适用场景** | 临时脚本、极简改动、快速原型 | 日常默认：计划审批优先的功能 | 20% 核心高危：分布式事务、全栈、安全敏感 | 安全攸关：支付、鉴权、医疗、航空 | 横跨多领域的大型系统 | 预设不覆盖的组合 |
| **宿主 Agent** | `@build` | `@build` | `@build` | `@build` | `@build` | `@build` |
| **编码 Agent** | `@fast-coder` | `@<lang>-dev`（按领域路由） | `@<lang>-dev`（按领域路由） | `@<lang>-dev`（按领域路由） | `@<lang>-dev` 按阶段 | `@fast-coder` 或 `@<lang>-dev`（标志决定） |
| **审查阵容** | 默认无（`--review` 触发单审） | 默认无（`--review` 触发单审） | `@architect` + `@code-review-fast` + max `@code-review` 终审门禁 | 可配置（风险驱动） | 每阶段 2 位 | 按标志 0 / 1 / 2 位 |
| **编码前准备** | 无 | 苏格拉底澄清 + 计划 | 无 | FMEA 风险登记册 | `@explore` 摸底 | 按标志可选计划 / SDD |
| **分歧对齐** | 无 | 计划确认门禁 | `@advisor`（Safety-First） | 风险登记册驱动 | 每阶段 `@advisor` | `@advisor`（`--code-review=2` 时） |
| **收敛轮次** | 1 轮 | 1 轮（若 `--review` 上限 5 轮） | 上限 10 轮 | 登记册审计 | 每阶段上限 10 轮 | 按标志 `--max-rounds`（默认 5） |
| **自主级别** | 无 | 低（计划门禁） | 低 | 低 | 高 | 低 |

---

## 动态领域灵魂注入

所有涉及编码的开发流（`/dev-quick`、`/dev-plan`、`/dev-review`、`/dev-prud`、`/dev-ultra` 及 `/dev` 组合）均使用**动态领域灵魂注入**：

1. **无状态容器**：`@fast-coder` 静态绑定 Flash/Lite 档模型，保持高吞吐与极速响应（`/dev-quick` 预设与零深度标志的裸 `/dev` 使用）；
2. **调度器动态附魔**：`@build` 识别任务领域后，自动在 Task Prompt 顶部注入该领域专属工程铁律：
   - **Frontend**：严格 TS 类型（禁 `any`）、Tailwind 原子化、防冗余 Re-render、A11y 无障碍；
   - **Go**：显式 `if err != nil`、`context` 级联传递、Goroutine 防泄漏、禁主流程 panic；
   - **Python**：Pydantic/Type Hints 强类型、`asyncio` 并发、`with` 资源管理、PEP8；
   - **DBA**：索引最左匹配、避免全表锁 Migration、参数化防注入；
3. **支持并行多角色扮演**：Subagent 底层独立会话隔离，调度器可**同时并发派发多个领域专家**。

---

## 实战使用与参数指南

### `/dev-quick`（极速免审直通，可选审查）

```bash
/dev-quick 给代码块右上角添加一键复制按钮与 Toast 提示
/dev-flash 修复分页查询页码从 0 开始计算的越界问题  # 别名
/dev-quick 添加暗色模式切换 --review  # 带单审
```

### `/dev-plan`（计划先行，可选审查）

```bash
/dev-plan 实现用户个人中心头像上传与裁剪组件
/dev-plan 优化订单查询分页 SQL --review  # 计划 + 单审
/dev-plan 添加支付回调处理 --review --max-rounds=5
```

### `/dev-prud`（FMEA 审慎开发）

```bash
/dev-prud 实现带幂等保证的资金清结算 --top=5
/dev-prud 为移动端添加 OAuth2 PKCE 流程 --top=3 --max-rounds=8
```

### `/dev-review`（核心高危与全栈开发）

```bash
/dev-review 重构资金清结算分布式事务与幂等状态机
/dev-review 实现扫码登录全流程：会话表、轮询接口、弹窗组件 --max-rounds=10
```

### `/dev-ultra`（自主多阶段执行）

```bash
/dev-ultra 实现完整的用户认证系统：OAuth2、会话管理、RBAC
/dev-ultra 构建实时通知服务：WebSocket 网关、消息队列、客户端 SDK、管理后台 --max-rounds=8 --max-phases=10
/dev-ultra --resume  # 断点续跑
```

### `/dev`（组合引擎 —— 无预设匹配时）

```bash
/dev 实现带指数退避的 Webhook 重试 --plan --code-review=2 --qa
/dev 添加多租户行级权限隔离 --sdd="adr,plan"
/dev 加固 CSV 解析器边界用例 --qa
```

---

## 架构防线与收敛保障

| 防线 | 适用开发流 |
|---|---|
| **Safety-First 仲裁** | `/dev-review`、`/dev-ultra`、`/dev-prud`（启用双审时） |
| **计划确认门禁** | `/dev-plan` |
| **10 轮防死锁熔断** | 所有含审查的开发流（`/dev-ultra` 为每阶段 10 轮） |
| **连续熔断停机**（≥ 3） | `/dev-ultra` |
| **阶段数上限护栏**（默认 6，上限 20） | `/dev-ultra` |
| **上下文压缩** | `/dev-ultra`（每 2 阶段） |
| **每阶段 Diff 隔离** | `/dev-ultra`（每阶段独立 git commit） |
| **风险登记册审计** | `/dev-prud`（Top-N 缓解措施全部验证） |
