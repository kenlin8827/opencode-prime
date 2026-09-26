---
style: madr
status: accepted
created: 2026-09-26
date: 2026-09-26
translation_of: ADR-0001
language: zh-CN
domain: security
---

# 0001 · Shell Guard 作为尽力而为的确认门

## Context and Problem Statement

分析与审查 agent 需要 shell 来检查仓库、运行检查；但宽泛的 shell 权限并非只读，命令仍可修改文件或执行任意程序。命令模式 hook 可以对部分已知风险操作发起确认，但无法解析所有 shell 方言、包装器或命令组合，也不是执行沙箱。

## Decision Outcome

Chosen option: 保留指定分析/审查 agent 的 shell 访问，并由 Shell Guard 将维护列表中的高风险命令模式转为权限确认。这只是改善交互的尽力而为机制，不是安全边界。列表之外的命令仍会按 agent 的 shell 权限放行；“只读”等角色提示只是行为指导，不构成执行限制。

**Positive**: 仓库检查与代码审查可使用原生 shell，而不必对每条命令确认；部分已知破坏性操作会显示带原因的确认提示。

**Negative / Risks**: 未列出或经过混淆的命令仍可能修改数据、执行程序或访问网络。`edit: deny` 不限制 shell 副作用。用户应将这些 agent 视为拥有 shell 能力，而不是沙箱化的只读工具。

### Confirmation

Shell Guard 单测验证已配置模式会触发权限确认，并且原生 deny 保持有效。测试不证明命令覆盖完整，也不证明存在沙箱。
