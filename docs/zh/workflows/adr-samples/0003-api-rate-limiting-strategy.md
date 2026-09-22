---
style: madr
status: accepted
created: 2026-09-18
date: 2026-09-18
layer: system
---

# 0003. 开放 API 限流策略

## Context and Problem Statement

平台对外的 Open API 即将开放给第三方租户。当前网关没有任何限流能力,单个失控的调用方可以打垮共享的下游服务(订单、库存)。需要在网关层选择一种限流策略,约束:多实例部署下限额必须全局准确(不能每实例各算各的);规则按租户维度配置;P99 延迟预算内限流判定本身不能超过 5ms。

## Decision Drivers

- 全局准确性:多网关实例共享同一份计数,不允许"3 台机器放大 3 倍限额"
- 租户隔离:按 API key 独立配额,互不挤占
- 低延迟:限流判定在热路径上,必须亚毫秒级完成
- 运维成本:团队目前只有 Redis 和 PostgreSQL,没有引入新中间件的预算

## Considered Options

- **固定窗口计数(Redis INCR)**: 实现最简单,但窗口边界处可能放过 2 倍突发流量
- **滑动窗口日志(Redis ZSET)**: 精确,但每个请求都要读写 ZSET,内存与延迟随 QPS 线性增长
- **集中式令牌桶(Redis + Lua)**: 平滑允许小额突发,一次 Lua 往返完成判定
- **Envoy 本地限流**: 无外部依赖,但只能做到单实例限额,不满足全局准确

## Decision Outcome

Chosen option: **集中式令牌桶(Redis + Lua)**, because 它在"全局准确"与"亚毫秒判定"之间取得最好的平衡:单次 Lua 脚本原子完成取令牌与扣减,天然平滑突发;而滑动窗口日志的精度优势对计费级配额才有意义,当前场景用不上。

### Consequences

- **Positive**: 一次 Redis 往返(~0.3ms)完成判定;令牌桶参数(速率/突发)可直接映射为租户配额产品语义
- **Negative / Risks**: Redis 成为可用性关键路径 — 判定脚本带 1s 超时,Redis 不可用时降级为"放行 + 告警"而非拦截;需要为 Lua 脚本补集群模式下的 key hash-tag 约束

## Confirmation

网关集成测试覆盖:并发 1000 QPS 打满配额后第 1001 个请求收到 429;压测报告判定延迟 P99 < 1ms;故障注入演练验证 Redis 宕机时的放行降级路径。

## More Information

令牌桶参数与租户套餐的映射关系见计费侧文档;Lua 脚本评审记录见 PR #482。
