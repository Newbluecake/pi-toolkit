---
source: agent
updated: 2026-09-25T13:33:48.000Z
---

# 多 agent 交接 / 请教实验结论（2026-09-24，详见 docs/dev/fabric-v2/baseline-results.md §10–19）

- **结构化交接**（fileIndex + ruledOut + 核验纪律）：下游成本 −34~53%、游荡文件 −91~100%，省的是「找」不是「读」；去掉核验纪律 ⇒ 下游几乎不核验（盲信风险）。已固化为仓库 skill `skills/agent-handoff/`。
- **请教的瓶颈在接口设计而非模型能力**：轮内同步工具 + 信息读不到 ⇒ 自发请教 5/5 且有效；阻塞式中继 + 信息可自取 ⇒ 0 次。质量（7 条决策遵守）：不给信息 2.0 / 可请教 6.5 / 推送 7.0。长上下文真实专家被 resume 请教 3/3 按最终修订作答，单次约 $0.1。
- 由此落地 `consult` 工具（src/consult/，docs/dev/consult/plan.md）；fabric v2 完整方案继续搁置。consult 必须是专用工具——有「新起一个 agent」退路时 1/4 下游会问错对象并越界翻仓库。
- 被告知「有信息」却拿不到时，agent 会全盘搜索（~/.pi/agent/sessions 旧会话、/tmp、agent 类型文件）——藏文件无法真正隔离，只能 prompt 禁令 + 事后检测。
- 实验隔离：污染源移出仓库、输入/产出各用独立 /tmp 目录；resume 会续写原 session 文件 ⇒ 取数基线先冻结副本；取数脚本 scripts/exp/*.mjs。
- 历史：`prompt_mode: replace` 的 agent 类型 system prompt 曾从未生效（所有子 agent 无角色设定），14e28c0 修复（SessionSpec.systemPrompt → `DefaultResourceLoader({ systemPromptOverride })`）。

## 实验 6（2026-09-25，docs/dev/consult/exp-trim/）：consult fork 裁剪工具输出——**不做**
- T1（省略较早 >1k token 的工具结果，K=2）首请求省 38%（中位，59 会话），但裁剪臂 9/9 都去重读：含重读总成本为完整 fork 的 78–113%，编造增加（只在 bash 输出里的知识重读不回来），5/9 超过 maxTurns=3。完整 fork 9/9 一轮零工具作答。
- 若还想压首请求成本，只剩两个待测方向：只丢历史 thinking；只省略可重读的超大 read（>8k）且保留 bash/grep、不提示重读。都需新预注册实验，重点测非 Anthropic 路由。
