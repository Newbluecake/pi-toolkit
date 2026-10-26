# #64 真机 smoke 报告（plan §7.4）

日期：2026-10-26 · 代码：dev `7dc45d17`（P1+P2 已合入）· 执行：主会话

## 方法

- 选一个真实旧会话 `2026-09-24T02-31-52-327Z_01a0d141-…jsonl`：活动路径上含 1 个 `get_subagent_result` toolCall + 1 个对应 toolResult（node 沿 parentId 链核对，非系统提示里的文字提及）。
- 每条线路复制一份到 `/tmp/smoke64/`，在仓库目录 `pi -p --session <copy> --model <m> …`（无 `--tools` 类参数 ⇒ 迁移应激活新名）。
- S1：请求能否被 provider 接受（旧名历史调用 + 工具列表只有新名）。S2：模型实际调用新名工具。

## 结果

| 线路                           | 协议                              | S1 请求（stopReason） | 模型自报工具名                  | S2 实际调用                                               |
| ------------------------------ | --------------------------------- | --------------------- | ------------------------------- | --------------------------------------------------------- |
| cr-anthropic/claude-sonnet-5-5 | Anthropic messages（CloudRouter） | stop，正常            | get_run_result                  | —                                                         |
| cr-response/gpt-6.1-sol        | OpenAI responses（CloudRouter）   | stop，正常            | get_run_result                  | —                                                         |
| kimi-coding/k3-256k            | kimi coding                       | stop，正常            | get_subagent_result（照抄历史） | `get_run_result` ✓（返回 run target not found，符合预期） |
| deepseek/deepseek-flash        | deepseek                          | stop，正常            | get_subagent_result（照抄历史） | `get_run_result` ✓                                        |

另：主会话本身（cr-anthropic/claude-opus-5-5，历史含 140+ 次旧名调用）在 /reload 后持续正常对话。

## 结论

四条线路均无 400；旧名历史调用不导致请求被拒，F2 方案不需要。迁移在 resume 时生效（kimi/deepseek 真实调用到的是新名）。观察：部分模型口头上会照抄历史里的旧名，但实际调用选择当前工具列表中的新名；若模型真调旧名，pi 返回 `Tool get_subagent_result not found`，下一步可自纠（描述含 `Formerly named get_subagent_result.`）。
