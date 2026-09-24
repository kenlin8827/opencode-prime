# ADR 压缩：交付状态、安装与发布步骤

实现状态：**工作分支上已完成并验证**，尚未发布。`install/version.json` 为 `0.40.0`，这是进行中的发布（最新已发布标签为 `v0.39.1`）；本次工作没有创建标签、Release 或版本号变更。功能复核、崩溃恢复、打包与真实服务交付证据见 [ADR 压缩：验证与成本测量](./adr-compaction-verification.md)；架构提案 [`docs/proposals/adr-compaction-governance.md`](../proposals/adr-compaction-governance.md) 仍然未接受。

## 交付内容

| 交付面 | 实际路径 | 作用 |
| --- | --- | --- |
| 命令 | `/adr compaction`（别名 `/adr-guard compaction`） | 只读分析、起草、复核、执行、归档、恢复 |
| 工具 | `adr_context`、`adr_compaction` | 供 agent 使用的有界检索与计划提交 |
| 技能 | `skills/adr-compaction/`、`skills/adr-context/` | 按需加载的工作流与检索指引 |
| 服务 | `plugins/adr/adr-compaction.ts`、`adr-compaction-runtime.ts`、`adr-context.ts`、`adr-publication.ts`、`adr-archive.ts`、`adr-storage.ts`、`adr-read-guard.ts` | 计划与执行、原生成本确认与最终 Ask、有界检索、CURRENT／溯源／索引发布、可逆归档、原子存储与日志、有限路径读守卫 |
| 策略 | `plugin-scope.json` → `adr-context-tool` | 检索作用域独立的 off／warn／guard 读策略 |

以上文件均进入发布清单，见 `install/versions/0.40.0.manifest.txt`。

## 安装与首次使用

1. 安装或升级 OCP（`ocp install` / `ocp upgrade`）。插件树、技能与作用域策略会落到 OpenCode 配置目录；除 OpenCode 自带的 `@opencode/plugin` 外不需要额外 npm 依赖。下方交付测试正是通过运行生产安装器、再启动真实服务来证明这一点。
2. 在已有 ADR 的项目中执行 `/adr compaction`。该默认路径只读：列出待整合记录、覆盖范围与视图新鲜度，不调用模型、不写文件。
3. 需要时可要求语义摘要或正式整合草案。独立的成本确认授权模型开销；起草以命名批次（`stage`）落盘，可幂等重试。
4. 以 `submit` 收尾，并在原生复核 Ask 中选择：**接受**、**仅保存草案**、**请求修改**或**取消**。一次明确接受即同时记录决定并执行所列计划，无需逐条手工命令。
5. 退役与接受相互独立：被取代的源记录只能通过单独授权的归档计划移动，`restore` 只还原归档位置，不回退决定。

中断的工作不会被静默丢弃：未完成计划（含已部分执行者）会在下次 `/adr compaction` 时报告，`--confirm <plan-id>` 是 Ask 应答丢失时的显式恢复入口；恢复保留原始执行者与账本记录。

## 验证对照

| 结论 | 证据 | 命令 |
| --- | --- | --- |
| 服务行为、批量提交、生命周期往返 | 21 组 | `bun tests/test-adr-compaction-unit.ts` |
| 各写入边界中断恢复 | 14 个 SIGKILL 边界 | `bun tests/test-adr-compaction-faults.ts` |
| 原生成本门、技能加载、四种复核结果 | 真实 OpenCode 服务 + 确定性本地模型，无付费调用 | `OCP_TEST_NATIVE_ADR=1 bun tests/test-adr-compaction-runtime.ts` |
| 真实进程死亡后重启与反向归档 | 接受写入后击杀真实服务 | `OCP_TEST_NATIVE_ADR=1 bun tests/test-adr-compaction-recovery-runtime.ts` |
| 发布归档确实包含该功能 | 一次性版本、ZIP／tar 逐文件核对、陈旧清单拒绝 | `bun tests/test-adr-compaction-package.ts` |
| 生产安装器与安装后目录可用 | 沙箱 HOME 安装、安装副本分析、真实服务自动发现工具与命令 | `OCP_TEST_INSTALL_ADR=1 bun tests/test-adr-compaction-install.ts` |
| 既有 ADR 行为无回归 | 全部既有 ADR 脚本与作用域套件 | `for f in tests/test-adr-*.ts tests/test-plugin-scope-unit.ts; do bun "$f"; done` |

仓库级门禁：`bunx tsc --noEmit`、`bun scripts/measure-prompts.ts`、`bun run docs:build`、`git diff --check`。

## 发布步骤

```bash
# 1. 提升进行中的版本号（version.json + 发布说明）
# 2. 重新生成当前版本清单（不要手工编辑）
bun run manifest:generate
# 3. 构建并校验归档
bash scripts/pack.sh --out dist
bash scripts/verify.sh dist
# 4. 打标签；发布工作流会执行同样的构建与校验
git tag vX.Y.Z && git push origin vX.Y.Z
```

`pack.sh`／`pack.ps1` 现在通过 `scripts/check-package-manifest.ts` 解析唯一发货清单，当前清单与实际发货不一致时直接构建失败。这不是形式主义：此前 `pack.sh` 会依据陈旧清单“成功”打包，静默漏掉文件——而本次恰恰如此，仓库中已提交的 `0.40.0` 清单仍列着重构前的 `plugins/adr-guard/…` 布局，漏掉 31 个发货文件（含整套压缩工具链）。因此该进行中的 `0.40.0` 清单已重新生成（297 个文件，也是该步骤唯一被改动的跟踪文件）；没有修改任何历史清单、没有执行历史压缩，且 `bash scripts/pack.sh --out dist && bash scripts/verify.sh dist` 现已通过，内容哈希与工作区一致。

## 已知限制

- 本 Linux 验证环境**未运行** PowerShell 汇总入口 `tests/test-all.ps1`（`pwsh` 不可用）；其组成脚本均已直接运行。仅 Windows 的 `pack.ps1` 与 `pack.sh` 保持逻辑一致，但未实际执行。
- 未做付费模型评估：语义摘要质量、真实计费与单次 1,000 条记录的可行性**均未证明**。基准使用 `tiktoken` 与确定性 oracle 摘要，价格仅为示例。
- 读守卫只覆盖有限的支持路径，不是 Shell／Git／MCP 沙箱，也没有原生读取累计上限。
- 结构校验、源哈希与原生确认无法证明语义忠实；人工复核仍然必需，尤其是刻意修改约束时。
- 崩溃覆盖为进程死亡（`SIGKILL`、运行中断），不等于断电／fsync 持久性或任意存储故障。
- 生成的 CURRENT／溯源视图仅在读取时校验；普通 ADR 改动会使其陈旧，手工编辑只会被检出而不会自动修复。
- `OCP_TEST_INSTALL_ADR=1` 需要访问 npm registry（OpenCode 自身依赖安装），因此设为显式开关。

## 回滚

选择**取消**，或对中断计划不执行恢复，都不会改动磁盘。计划一旦执行，回滚是显式且有审计的：执行反向归档计划（`/adr compaction archive restore`）移回记录；若退役决定本身需要撤销，则新增一条决定。ADR 正文与编号永不被改写或复用，账本保留原始接受记录。
