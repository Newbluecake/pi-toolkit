# 上下文与缓存

围绕"长会话不爆上下文、prompt cache 尽量不失效"的一组功能：模型主导的上下文交接、用量提示、cache TTL 与保活、system prompt 稳定化、日期注入。

## switch_context / compact_context

- **`switch_context`**（`compact.switchTool` 默认 `true`）：模型自己写交接，pi 直接用它作为压缩结果，跳过通用摘要器。必填 `goal`、`progress`、`next_steps`；可选 `decisions`、`key_files`、`pitfalls`、`open_questions`、`keep_recent`（`false` = 丢弃此前全部对话，只留交接）、`resume`（默认 `true`，切换后自动继续任务）、`skills`。
  - 交接文本后会机械追加会话事实（在跑的 run / bash job、未完成 todo、会话文件路径）和"在役 skill"清单（被丢弃范围内读过的 `SKILL.md` 只提示重读，不重新注入）。
  - 交接草稿有 TTL、只消费一次。
  - 子 agent 会话同样可用（`compact.childSessions` 默认 `true`，每个 run 最多 `compact.childMaxSwitches`=5 次），受运行时能力自检门控；失败原因记入 run 诊断，`get_subagent_result` 可读。
- **`compact_context`**：`compact.switchTool` 关闭时（或 `compact.keepCompactTool` 为 `true`）可用的手动压缩工具，等价 `/compact`。
- **`set_compact_threshold`**：不带参数查询当前用量，带参数调整提示线 / 强制线（`0` = 关闭）。

## 用量提示（compact-hint）

`compact.enabled` 默认 `true`。turn_end 钩子监测上下文用量：

- **阶梯用量行**：默认每 10% 报一次（`compact.usageTickStepPercent`），接近强制线时自动加密到 step/2、step/5，让模型感知用量。
- **提示线**：`compact.hintThresholdPercent`（默认 75）提醒做上下文交接。
- **强制线**：`compact.forceAtPercent`（默认 88 是 1M 窗口的锚点；`compact.forceScaling` 默认 `true`，窗口越小线越高：200k ≈ 91，且不超过 pi 自己的保留线）。`switch_context` 模式下先"礼"后"兵"：先要求模型自己写交接（`compact.forceDemandTurns`，默认 1 轮），无视才退回通用强制压缩——兜底从不移除。
- **价格感知动态提示线**（`compact.dynamicThreshold.mode` 默认 `on`）：可用时取代静态提示线，静态线退为兜底。`minHintPercent` 35、`maxQualityPercent` 60、`rediscoveryUsd` 10、`unknownPriceMode` `static`；`off` 恢复旧行为。
- 交接遥测写 `~/.pi/agent/telemetry/compact-switch.jsonl`（0600，只记聚合数字，不含路径）。

设计：[compact-hint](../dev/compact-hint/compact-hint-plan.md)、[dynamic-threshold](../dev/compact-hint/dynamic-threshold-plan.md)、[context-switch](../dev/context-switch/context-switch-plan.md)、[child-context-switch](../dev/child-context-switch/plan.md)。

## cache TTL 与保活

`/cache-ttl on|off|auto|save|keepalive on|off|reset|status|probe`

- `mode`（`cacheTtl.mode` 默认 `auto`）：`auto` 跟随 pi/env；`on` 显式强制 `ttl: "1h"`；`off` 移除 TTL 覆写。`save` 持久化当前模式。不会自动升级到 1h。
- **保活**（`cacheTtl.keepalive` 默认 `true`）：在 5 分钟 cache 过期前重放最近一次请求的 payload 发 ping，让缓存续命。默认间隔 `cacheTtl.keepaliveIntervalS`=240（也是上限），单窗口最多 `keepaliveMaxPings`=11 次，前缀小于 `keepaliveMinPrefixTokens`=20000 不 ping。
- **ping 重试窗口**：单次 ping 失败会在缓存窗口内持续重试（间隔 2s→5s→10s→20s→30s，之后恒 30s），截止点为 `aliveUntil − 15s`；默认配置下重试窗口约 45s（约在 +240/+242/+247/+257/+277s 发起）。仅"确定未被处理"的瞬时失败（网络、HTTP 408/429/500/502/503/504/529）不会暂停会话，下个窗口重新来过。
- **状态栏标记**：保活因故未继续时显示 `ping miss:<原因>`（原为 `ping paused:`）。可能已被计费的失败按连续/累计次数熔断；4xx 拒绝按线路（provider+baseUrl+model）熔断，同线路一次真实请求成功即清除；`/cache-ttl keepalive reset` 手动清除全部熔断。
- **provider 证据层**：记录各 provider 的 1h 写入是否真正生效（部分中转会折叠 1h），据此决定是否降级为 5m ping；`/cache-ttl probe` 发 3 次真实请求做体检。连续 3 个会话保活但零读缓存会触发自愈型 `no-cache-value` 熔断。
- **子 agent 保活**（`cacheTtl.childKeepalive` 默认 `true`）：只捕获不改写请求；上限每窗口 11 次、每 run 24 次（`childKeepaliveMaxPingsPerRun`）、并发 4、每 run $1.5、进程 24 小时滚动 $10；无价格信息不 ping。费用计入该 run 的成本。
- Web hub 会话详情头部有只读的保活面板（见 [Web Hub](web-hub.md)）。

设计：[cache-ttl-keepalive](../dev/cache-ttl-keepalive/plan.md)、[breaker-recovery](../dev/cache-ttl-keepalive/breaker-recovery-plan.md)。

## system prompt 稳定化

三段动态内容（项目记忆 / agent 类型 / 可用模型）以前每轮追加到 system prompt，任何变化都让整段缓存前缀失效。现在折叠成**冻结快照**，真实变化改走对话尾部的更新消息（每段落自上次刷新起 ≤3 条 / ≤32KB，之后只留指针）。快照状态持久化进会话，`/reload` 与跨进程 resume 后保持。

- `systemPrompt.mode`：`stable`（默认）/ `live`（每轮刷新，不冻结）/ `legacy`（逐字节回到旧的追加行为，不持久化）。
- `systemPrompt.wakeReplay`（默认 `true`）：通知唤醒轮回放上一次用户轮的开头。pi ≥ 1.2 自身的 forced-prompt 投影会覆盖它，保留是为了 1.0/1.1 的兼容下限。
- `systemPrompt.adoptForeignForcedPrompt`（默认 `false`）：是否采纳其他扩展强制注入的提示词。
- 回滚到旧行为：`{ "systemPrompt": { "mode": "legacy", "wakeReplay": false } }`。

设计与手工验收：[plan](../dev/sysprompt-stable/plan.md)、[acceptance](../dev/sysprompt-stable/acceptance.md)。

## `[date]` 日期注入

`date.enabled` 默认 `true`，主会话与子 agent 会话都注入。让模型知道当前日期和时刻，格式 `[date] YYYY-MM-DD Ddd HH:MM (TZ)`：

- 新会话 / 恢复会话后的首轮注入一次；
- 之后只在跨日时再注入（运行中跨过午夜也会在下一次模型请求前注入）；
- 同一天内闲置 ≥ 1 小时后的新一轮再注入一次时刻。

纯事件驱动，无计时器；记录在会话里，恢复后据此判断是否跨日。
