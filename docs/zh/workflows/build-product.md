# /build-product — 以产品形态模式调用 @ultra

`/build-product` 是调用 **`@ultra`**（全域全能主 agent）**产品形态模式** 的入口命令。一句话需求 → 完整产品管线。

**非产品任务**（SQL 优化、bug 修复、refactor、脚本、库、基础设施、代码审查）**直接调用 `@ultra`**——它跑轻量的 **分诊 → 契约 → 派单 → 验证 → 交付** 循环。

---

## 一览

| | |
|---|---|
| **命令** | `/build-product <一句话需求> [可选 flags]` |
| **Agent** | `@ultra`（primary，全域主 agent） |
| **类别** | 开发流程 |
| **产出** | 项目根目录的可运行产品 + `docs/build-product/<slug>/` 工件 |
| **默认轮数上限** | 3 轮 QC 迭代（可调） |

---

## 阶段（全管线模式）

```
P1  Grill        @advisor + 需求宪法            → SPEC.md（MACHINE 块）
P1.5 Preflight   @ultra 探测语言栈工具链       → 环境报告
P2  Confirm      用户关卡（沉默 → 默认推进）
P3  Design       @designer + 通用设计指南      → DESIGN.md
P4  Architecture @architect                       → ARCHITECTURE.md
P5  Scaffold     按能力路由的实现者              → 地基
P6  Backend+DB   @dba → @<lang>-dev 按契约      → 端点 + schema + seeds
P7  Implement    默认串行；--parallel 时带禁改清单
P8  Security     @security → SEC_VERDICT（FAIL → 后端修复一轮）
P9  QC 循环      @qa + 质量宪法                  → VERDICT（FAIL → P7 ×N）
P10 Gate         @code-review-fast + @ultra 自跑构建门禁
P11 Deliver      @tech-writer README 收尾 + 交付报告
```

只有两条回边：P8→P6（一次）、P9→P7（有上限）。`@ultra` 驱动所有转移。

## 技术栈无关

`@ultra` **不预设任何技术栈**。栈知识在 `references/constitution/language_stacks.yaml`——**开放注册表**，卡片平等（Web：typescript_web / vue_web / svelte_web / static_web；移动：flutter / react_native / swift_kotlin_native；小程序：taro / uniapp；后端：node_ts / go / rust / java / python；SQL 聚焦；库 SDK）。未覆盖栈按 `extension_rule` 现场生长。没有"默认前端/后端"。

## 产出工件

```
docs/build-product/<slug>/
├── SPEC.md             # P1 — 形态判定 + 能力清单（Given/When/Then）+ 决策树
├── DESIGN.md           # P3 — 令牌、页面/屏 + 逐节动画、资产清单
├── ARCHITECTURE.md     # P4 — 分层、钉版本、字段级 API 契约、预算
└── qc/
    ├── security.md     # P8 — SEC_VERDICT 块
    └── acceptance-round-N.md
```

## Flags

| Flag | 默认 | 作用 |
|---|---|---|
| `--max-rounds=N` | `3` | QC ↔ 修复循环上限。范围 [1, 99]。 |
| `--parallel` | 关闭（串行） | P7 并行页面代理——每个都带禁改清单。 |
| `--no-security` | 关闭 | 跳过安全审计（后端形态）。有风险。 |
| `--no-qc` | 关闭 | 跳过敌对 QC，最终门禁仍跑。有风险。 |
| `--no-gate` | 关闭 | 跳过最终 code review。有风险；与 `--no-qc` 叠加被拒绝。 |
| `--auto-advisor[=full\|lite\|off]` | 环境全局模式 | P1/P2 顾问行为。不带值 = full。 |

## 何时使用

用 `/build-product` 当：一句话表达完整产品（应用/服务/网站/工具/App/小程序/库）。其他都**直接调用 `@ultra`**——它分诊进轻循环。

## 示例

### 产品形态（一句话 → 产品）
```
> /build-product 帮我做一个 Trello 风格的看板
  → P1 SPEC → P2 confirm → P3 DESIGN → P4 ARCHITECTURE → P5 scaffold → P7 实现 → P9 QC → P10 gate → P11 交付
```

### 聚焦任务（任何非产品任务，直接 @ultra）
```
@ultra 优化这条查询：<粘贴查询>
  → 分诊：聚焦任务，SQL 优化
  → 契约：优化前/后 EXPLAIN + p95/p99 耗时；在工作负载 Y 上比 X% 快才算完成
  → 派单：@dba + 性能工程师灵魂契约
  → 验证：重跑 EXPLAIN + 测量；报告数字
```

```
@ultra 修这个文件里的 bug
  → 分诊 → 契约（复现 + 修复）→ 派单 @code 或领域实现者 → 验证（重跑失败用例）→ 交付
```

## Token 经济性

`/build-product` 默认跑完整管线。SPEC 一目了然的常规任务，**直接 `@ultra`** 走轻循环——仪式更轻，证据底线一致。

## 完整协议

单一事实源是 `@ultra` 的 prompt（`prompts/ultra.md`）：全管线模式（每阶段剧本 + 灵魂契约注入 + 机器块格式 + 旗标解析）+ 聚焦任务模式（分诊 → 契约 → 派单 → 验证 → 交付）。
