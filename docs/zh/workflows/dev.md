# `/dev` 组合引擎

`/dev` 是[五档开发流](dev-loops.md)背后的**单趟流水线组合引擎**：通过规格深度、计划评审、代码评审与 QA 标志自由组装开发流水线。预设命令（`/dev-quick`、`/dev-plan`、`/dev-review`）都是该引擎上的固定标志组合。

---

## 标志语法

| 标志 | 作用 |
|---|---|
| `--plan` | 临时会话内计划（澄清 + 计划 + 确认门禁） |
| `--sdd[="prd,adr,plan"]` | 文档化 SDD 生命周期前端（隐含 `--plan`） |
| `--plan-review[=1\|2]` | 确认门禁前的计划审计（隐含 `--plan`） |
| `--code-review[=1\|2]` | 实现后审计（裸值 = 1） |
| `--qa` | `@qa` 从验收标准推导回归测试 |
| `--fast` | 强制 `@fast-coder`，无视其他标志 |
| `--max-rounds=N` | 评审/修复轮数上限 |
| `--auto-advisor[=full\|lite\|off]` | task 级 advisor 模式覆盖（裸值 = `full`）；出现时仅本次运行由它决定 Clarify 自动采纳 + Confirm 代理批准；缺省 → 沿用全局模式 |

传统别名：`--review`（预设命令仍接受）→ `--code-review=1`。

## 解析与归一化规则

1. **评审标志**（`--plan-review`、`--code-review`）：裸值 = `1`；仅接受 `=1` / `=2`。其他取值（包括 `dual`）→ 报错 `"valid values: 1|2"` 并终止。绝不猜测。
2. **`--sdd` 取值是集合而非序列**：逗号分隔、大小写不敏感、去空白、静默去重。合法 token：`prd`、`adr`、`plan`。
   - `impl` → 报错："`impl` is not valid here — /dev already IS implementation"。其他 token → 报错并列出合法 token。
   - 执行顺序始终归一化为 `prd → adr → plan`；输入顺序被忽略。
   - 归一化绝不新增阶段：`--sdd="plan,adr"` 只跑 adr → plan，跳过 prd。裸 `--sdd` = `"prd,adr,plan"`。
3. **`--max-rounds`**：按预设默认（见下表）；裸 `/dev` 默认 5。钳位到 [1, 99]；非数字 → 预设默认。
4. **未知标志** → 一行报错并列出合法标志；终止。绝不静默忽略。
5. **`--auto-advisor`**：裸值 = `full`；合法取值 `full|lite|off`；其他取值 → 报错并列出合法值，终止。**仅当**临时 Clarify/Confirm 阶段真正运行时生效（`--plan` 且无 `--sdd`）——裸直通与 `--sdd` 下均不生效（工件 Approve/Revise/Stop 门不咨询 advisor 模式）。生效时仅本次运行覆盖全局模式——这些门禁一律忽略环境注入的 auto-advisor 指令，只遵循 flag 的模式；缺省 → 沿用全局模式。

## 隐含关系

| 出现的标志 | 隐含 |
|---|---|
| `--plan-review` | `--plan` |
| `--sdd` | `--plan`（文档化生命周期**取代**临时 Clarify+Plan 阶段；最后一个计划产物即确认计划） |
| `--code-review=2` | 双审 + 分歧时 `@advisor` 仲裁（Safety-First） |
| `--review` | `--code-review=1` |

## 编码者路由

| 归一化后的标志 | 编码者 |
|---|---|
| 零深度标志（无 `--plan/--plan-review/--sdd/--code-review/--qa`） | `@fast-coder`（Flash 档） |
| 任一深度标志 | 按 `build.md` 路由的领域 `@<lang>-dev`（`@node-dev`、`@python-dev`、`@frontend-dev`、`@dba` 等；多领域 → 按依赖顺序串行派发） |
| `--fast`（覆盖一切） | 即使带深度标志也用 `@fast-coder` |

## 预设等价关系

| 预设 | 等价 `/dev` 标志 | 传统别名翻译 | max-rounds 默认 |
|---|---|---|---|
| `/dev-quick`（别名 `/dev-flash`） | *（无）* | `--review` → `--code-review=1` | 3 |
| `/dev-plan` | `--plan` | `--review` → `--code-review=1` | 5 |
| `/dev-review` | `--code-review=2` | — | 10 |
| 裸 `/dev` | 自定义标志 | `--review` → `--code-review=1` | 5 |

评审阶段按确定性规则分级：文档、锁文件、纯重命名和版本号改动为 L0 免审；L1/L2
使用 `@code-review-fast`（pro/medium/15 步）。符合条件的 L3 可由一个就绪图谱后端提供受限关系
证据：普通单仓影响面使用 CodeGraph，流程、群组或跨仓问题使用 GitNexus；否则直接使用
`@code-review`（max/high/30 步）。

## 用法示例

```bash
# 计划 + 双重代码评审 + QA —— 预设不覆盖的组合
/dev 实现带指数退避的 Webhook 重试 --plan --code-review=2 --qa

# 文档化 SDD 前端，跳过 PRD（adr → 计划），随后实现
/dev 添加多租户行级权限隔离 --sdd="adr,plan"

# 编码前计划审计：双计划评审 + 单代码评审
/dev 重构账单导入器 --plan --plan-review=2 --code-review=1

# 仅 QA —— 从原始需求推导回归测试
/dev 加固 CSV 解析器边界用例 --qa

# 即使带深度标志也强制快速编码者
/dev 设置抽屉的快速原型 --plan --fast

# 显式轮数上限
/dev 配置加载器迁移到 ESM --code-review=1 --max-rounds=8
```

## 无预设匹配时

五档开发流是决策默认值。当你需要它们未编码的组合 —— 带双审的计划、不带评审的 QA、跳过 PRD 的 SDD 前端 —— 直接调用 `/dev` 并给出你要的标志集。引擎按标志组装同一条线性流水线（SDD-Spec → Clarify → Plan → PlanReview → Confirm → Implement → CodeReview → QA → Deliver）：每个阶段要么执行、要么跳过，绝不交错。

## 边界

`/dev-prud`（FMEA 风险登记册）与 `/dev-ultra`（自主多阶段）仍是**独立协议** —— 拓扑不同（登记册驱动 / 多阶段自主），无法用 `/dev` 标志表达。

预设优先的总览见[五档开发流](dev-loops.md)。
