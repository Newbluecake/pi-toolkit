---
description: Core rules every turn
topic: core
status: active
source: agent
---

# 跨主题坑与用户偏好（常驻；2026-09-26 治理）

## 用户偏好
- 严格遵循 dev-flow（skills/dev-flow）：L2 方案评审 ∥ 用户确认；开发包 `subagent_type=general`（UI 用 frontend-dev，不是 general-purpose）；每包返回**立即**派 verifier，验收模型 ≠ 开发模型；L0 小修主会话直改后让原 verifier 复验；方案改口径后的开发包挂 `experts: [Plan label]`。
- 验收通过自动 commit（每任务单独 Conventional Commit，只 `git commit <精确路径>`，绝不 `git add -A`）；push/发版需用户确认（用户常自己 push，先 `git fetch` 看 origin）。
- 传输层故障（stream 中断/502/503/upstream/0 轮无进展超时）⇒ 直接 `resume` 换线续跑，不问；429 按路由换线；升 opus/用 fable 先问。
- 模型路由（2026-09-26）：开发 `cr-anthropic/claude-sonnet-5`；评审/验收 `cr-response/gpt-5.6-sol` ⇄ `zhipu-pool/gpt-5.6-sol`（zhipu 线偶发 0 轮卡死）；方案 `cr-anthropic/claude-opus-5-5`；kimi-coding / zai 额度常耗尽。provider 旧名 `cloudrouter-*` 是历史。


## Pointers
- 并发 / subagent → concurrency.md
- git / 并行写 → git-parallel.md
- 运行时 / 环境 → runtime-pitfalls.md
- 已落地、别再按旧认知处理 → landed-notes.md
