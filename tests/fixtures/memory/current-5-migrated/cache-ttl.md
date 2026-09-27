---
source: agent
updated: 2026-09-25T13:33:48.000Z
---

# cache-ttl：保活 × 自适应的实测事实（设计以 docs/dev/cache-ttl-adaptive/plan.md §17–§20 为准）

## 上游缓存事实（cr-anthropic 实测）
- **1h 与 5m 是分离的命名空间**（13/13）：`ttl:"1h"` 请求只读上一个 1h 写入点，期间 5m 增量按 1h 全额重写；反向可以（5m 能读 1h）。首次升级 = 整前缀入场费；续 1h 也要重写升级后累积的 5m 尾巴。
- 5m 请求**不刷新** 1h 条目：保活撑住空档时 1h 条目照样按寿命死。
- 1h 实际寿命：确认活到 23.2min、确认死亡只在 ≥27.5min。早期「只活 7–13.6min」是误判——实为前缀谱系分裂（唤醒轮与用户轮两条前缀，91a2878 wake replay 已修）。
- 判「命中」别用 `cacheRead > 0`：跨会话共享的 system/tools 块（约 11k tok）总命中；锚上一次前缀 × 0.5。

## 设计结论（已落地，别回退）
- 保活与自适应不是正交，按空档择一：keepalive 能桥接的空档（默认 49min）内 adaptive 不开新前缀；确认的 1h 覆盖期间保活不 ping，且让位要证据（同路由、≥时域空档后读中 1h）。
- keepalive gate #8：capture 带的是被捕获请求**之前**的账本 ⇒ 首请求后空档永远不 ping；仿真器必须建模这点（旧仿真因此造出过假缺陷）。
- 经济学：1h 寿命 ~25m 时「5m+保活」最省，adaptive+ka 仍贵约 4–10%；「始终 1h」只在 1h 活满 60m 时最优。改策略前先在 `tests/cache-ttl/adaptive-economics.test.ts` 用 `RunOpts` 原型化（`ADAPTIVE_ECON_REPORT=1` 打印成本表），再改 src。
- 预算/熔断/学到的 1h 寿命经 `readBackAdaptiveSessionState` 跨 `/reload` 恢复（a0c3400）。

## 取证 / 待办
- 取证：session jsonl 的 `subagent:cache-adaptive` + `subagent:cache-keepalive` 条目 + assistant `usage.cacheWrite1h` 三者对齐；traffic.db 只在 pi-traffic-record 打开时有 wire 载荷。现场取数：`node scripts/exp/cache-adaptive-field.mjs [files…]`。
- 待办：wake replay + §19/§20 修复生效后重跑现场取数；现场出现过 `w1h=0` 的「升级」（实际按 5m 发出），原因未查。
