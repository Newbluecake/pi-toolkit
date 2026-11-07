# Jev Reflex 层（R 层）可行性研究

> 状态：**探索结论（feasibility）· 无代码**
> 日期：2026-11-04
> 读者：需要决定要不要做 R 层、MVP 切多大的人
> 相关必读：`AGENTS.md`（I1–I12）、`docs/dev/memory/README.md`（Jev / P 层）、`docs/dev/sysprompt-stable/README.md`、`docs/dev/topic-switch/plan.md`（已有的零-LLM 拦截先例）
> pi 版本基准：`@earendil-works/pi-coding-agent` **1.4.0**（全局 `~/.nvm/.../pi-coding-agent`，与 devDependencies 一致）

---

## 0. 结论（TL;DR）

1. **API 层：只有一个通道能「不发那次 LLM 请求」。** `pi.on("input")` 返回 `{action:"handled"}` 是 pi 里唯一能在模型回合之前把用户输入吞掉、且不启动 run 的机制（`agent-session.js:1649-1655`；`types.d.ts:908-941`）。其余看起来像的钩子（`before_agent_start`、`turn_end`、`agent_before_settle`、`context`、`before_provider_request`、`registerVirtualModel`）**都改不了「这次请求必然发生」**——它们只能在请求前改内容、或请求后追加条目。
2. **「直接产出回复」可行，但要走两条拼接路径**：`pi.sendMessage({customType, display:true})`（进 transcript、**会以 user 角色进入下一轮模型上下文**，`docs/message-types.md:238-245`）或 `pi.appendEntry` + `registerEntryRenderer`（只在 TUI 显示，**不进** LLM 上下文，`types.d.ts:1253/1271`）。建议组合：entry 放完整证据 + 隐藏 message 放一行摘要。
3. **「失败回退强模型」可行且干净**：吞掉输入 → 记录 → 下一 tick 用 `pi.sendUserMessage(原文)` 重新发起，`input` 事件会以 `source:"extension"` 再来一次（`agent-session.js:1936`），用 source 白名单天然防重入。topic-switch 已经把这条链路跑在生产上（`src/topic-switch/wire.ts:743`、`src/topic-switch/release.ts`）。
4. **历史数据：可确定执行的面很窄，但延迟收益显著**。本机 1298 个会话 / 4456 次用户请求：严格「只读 + ≤2 工具 + 无写」的请求 **602 次（13.5%）**，中位耗时 **28s**（p90 82s），只占历史支出 **2.4%**。→ R 层省的是**延迟与确定性**，不是钱。
5. **致命反证：从历史里「抄命令」不成立**。602 次只读请求里有 256 次只调了一条 bash；其中去掉 `cd <path> &&` 前缀后仍无 shell 元字符的仅 **6 条**，首词落在程序白名单内的仅 **3 条**。全库 68935 条 bash 调用里 73.6% 的形状就是 `cd <path> && …`。→ 脚本必须**设计出来**，不能**提炼出来**；提取环节的产出应是「哪些意图在复现 + 匹配器/参数草案」，而不是 argv 回放。
6. **复读率高 ≠ 可确定性**。首行 ≤12 码点的短口令（继续/好/ok）777 次、占支出 **13.6%**、p50 73s——它们是「启动一次长任务」的开关，是误触发后果最严重的一类。R 层必须**显式排除**它们（topic-switch 的 `SHORT_REPLY_TABLE` 已有词表，`src/topic-switch/filters.ts:14`）。
7. **建议**：做，但把 MVP 砍到「**自省类只读问题**」（工具自身状态：后台任务、额度、会话列表、记忆索引、git 状态），全部**进程内**、无子进程、无 shell；默认 `reflex.enabled=false`；`reflex.sources:["interactive"]`；阴影模式先跑 2 周再看指标。写入类脚本进「需确认」二级，高危永久禁。**不做**「用脚本执行用户的任务」（那是一整个 plan-mode + 权限系统，不是 reflex）。

---

## 1. 问题与判据

### 1.1 要解决什么

用户提出一个**结果唯一、可机械执行**的请求（"现在工作区干净吗"、"后台还有几个 job"、"这周花了多少"），当前代价是：

- 一次完整模型回合（p50 28s、p90 82s 在只读类；含工具则更久）；
- 一次工具调用 + 一次模型复述；
- 输出不确定性（模型可能漏看、改写成"大概"）。

R 层目标：这类请求由 **Jev 分诊 + 参数抽取 → 执行一条已审核的确定性脚本 → 直接给出结果**，全程 0 次 LLM、p95 ≤ 1.5s；只要有一丝不确定或执行失败，**无损**交回强模型。

### 1.2 什么算成功（可验收判据）

| 判据         | 阈值                                                                     | 测法                      |
| ------------ | ------------------------------------------------------------------------ | ------------------------- |
| **零误答**   | 抽样人工复核 200 次命中，错误答案 = 0                                    | 审计 `reflex:result` 条目 |
| 延迟         | 命中路径 p95 ≤ 1.5s（含分诊）                                            | `durationMs` 落条目       |
| 命中率       | ≥ 8% 的 interactive 请求被处理（阴影期统计，不要求上线即达标）           | 影子计数器                |
| 回退无损     | 回退时用户感知不到差异（原文完整、无重复、无丢图）                       | 对拍测试 + 人工           |
| 关即字节相同 | `reflex.enabled=false` ⇒ 零 hook 注册、`activate-trace` 与今天逐字节相同 | `tests/governance` + I9   |
| 成本不倒退   | 命中路径成本 = 0；未命中路径额外开销 ≤ 200ms 规则匹配                    | 单测计时                  |

### 1.3 非目标（写死在文档里，防范围漂移）

- 不做「用脚本替模型完成任务」（多步、要判断、要改文件 → 一律强模型）。
- 不做写入类自动化（v1 起就是确认制，且默认关）。
- 不做跨会话的隐式记忆式反射（"上次你让我…" → 交给 P 层注入，不交给 R 层执行）。
- 不替换 `/` 命令（`/mem`、`/agent` 等已经是零-LLM，`agent-session.js:1640-1647` 证明 `/` 永远先于 `input` 钩子，R 层触不到，也不需要触）。
- 不做「便宜模型代替」（那是 virtual-model 路由的事，`docs/virtual-models.md`；两者可叠加，互不替代）。

---

## 2. pi 扩展 API 能力矩阵

### 2.1 一张表（关键结论，逐条给坐标）

| 需求                                    | 可行？                    | 机制                                                                                              | 证据                                                                                               |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 模型回合**前**拦截用户输入              | ✅                        | `on("input")` → `{action:"handled"}`                                                              | `types.d.ts:910-941`；`agent-session.js:1590-1603,1649-1655`                                       |
| **跳过** LLM（这次不发请求）            | ✅ 仅此一路               | `handled` 后 `prompt()` 直接 return，`preflightResult("handled")`                                 | `agent-session.js:1653-1655`；`rpc-client.js:132-137`                                              |
| **取消/短路**已开始的 run               | ⚠️ 部分                   | `ctx.abort()` 只能中止**已在跑**的 run，不能阻止下一次请求                                        | `types.d.ts:245`（`abort(): void`）                                                                |
| 直接产出**用户可见**回复（无 LLM）      | ✅                        | `sendMessage({customType, display:true})` / `appendEntry` + `registerEntryRenderer`               | `types.d.ts:1253-1277`；`agent-session.js:1844-1886`                                               |
| 产出**对模型可见**的回复/记录           | ✅                        | custom message 的内容在下次请求中转为 **user 角色文本**                                           | `docs/message-types.md:238-245`                                                                    |
| 失败后**注入执行记录并回退**            | ✅                        | 记录先落，再 `sendUserMessage(原文)`（source=`extension`）                                        | `agent-session.js:1910-1937`；`src/topic-switch/release.ts:99-118`                                 |
| 在同一次 run 内「先答、不行再让模型答」 | ❌                        | `input` 一旦 handled，本次请求不存在；要重启就只能**新起一次** run（第二次请求）                  | `agent-session.js:1653`；`BoundaryResult` 只有 `entries/continue`（`types.d.ts:792-800`）          |
| 用脚本**替代** provider 响应            | ❌                        | `registerVirtualModel.route()` 只选物理模型；`route` 抛错/无凭证 ⇒ **error 响应**，不是可定制内容 | `docs/virtual-models.md:52-70,100-104`；`types.d.ts:1409-1413`                                     |
| 伪造 assistant 消息                     | ⚠️ 技术可行、**明确否决** | `message_end` 可「保持 role 替换已完成消息」                                                      | `types.d.ts:1121-1124`；见 §2.5                                                                    |
| 工具级拦截/替换结果                     | ✅                        | `tool_call` 可 `block`（fail-closed），`tool_result` 可替换内容                                   | `types.d.ts:1089-1098,1114-1120`；`docs/extensions.md:378`                                         |
| 结构化分诊（intent 分类）               | ✅                        | `ctx.modelRegistry.classify(model,{state,questions})`，答案只有 choice/score/bool                 | `core/model-registry.d.ts:47`；`pi-ai/dist/types.d.ts:449-503`；`src/memory/jev/client.ts:300-330` |
| 执行外部命令                            | ✅                        | `pi.exec` / 自建 argv runner                                                                      | `types.d.ts:1279`；`src/git/run.ts:3-36,105`                                                       |
| 跨会话取历史做离线挖掘                  | ✅                        | 直接读 `~/.pi/agent/sessions/**/*.jsonl`（已有发现基建）                                          | `src/tools/list-sessions-tool.ts:104`；`docs/session-format.md`                                    |

### 2.2 唯一零-LLM 通道的精确语义

`AgentSession.prompt()` 的固定顺序（`agent-session.js:1633-1663`）：

```
1. `/` 扩展命令 → 命中则直接执行并 return（不产生 run）      ← 1640-1647
2. 压缩中 → throw
3. emit("input") → handled ⇒ return（不产生 run）            ← 1649-1655
4. skill/模板展开
5. streaming ⇒ steer/followUp 入队，否则 _startRun()
```

要点：

- **`handled` 发生在 skill/模板展开之前**，所以 R 层看到的是用户**原样**文本（未展开 `@file`、未展开 `/skill:`）。这是好事（匹配面稳定），也意味着 `expandPromptTemplates` 的语义永远不会被 R 层破坏。
- `handled` 之后**没有任何 session 条目**被写入——用户那句话在 transcript 里**不存在**。所以 R 层必须自己落一条记录，否则会话历史会丢失用户的提问（见 §4.2）。
- RPC/print 模式同样生效：`rpc-mode.js:306` 传 `source:"rpc"`，客户端靠 `disposition==="handled"` 判断「不要等 agent_settled」（`rpc-client.js:132-137`）。

### 2.3 两条输出路径的取舍（必须明确选一条）

|                     | custom message (`sendMessage`)                           | custom entry (`appendEntry`)         |
| ------------------- | -------------------------------------------------------- | ------------------------------------ |
| 用户可见            | ✅ `display:true`                                        | ✅ 需 `registerEntryRenderer`（TUI） |
| 进入模型上下文      | **会**，且是 **user 角色**（`message-types.md:238-245`） | **不会**（`types.d.ts:1271`）        |
| token 成本          | 有（小）                                                 | 0                                    |
| web-hub / HTML 导出 | 走消息通道，天然可见                                     | 依赖 entry 渲染，覆盖度较低          |

**建议组合**（与仓库已有"隐藏消息"惯例一致，见 compact-hint / date / todo-nudge）：

1. `pi.appendEntry("subagent:reflex", details)`（`details` 含 argv、exit、耗时、stdout 摘要 ≤4KB、脚本 id@version）；
2. `pi.sendMessage({customType:"subagent:reflex", content:"<reflex id=… ver=… ok>[1-3 行结果]</reflex>", display:true, details})` —— **display:true**，因为用户要知道"这不是模型答的"；
3. 若担心上下文膨胀：把第 2 步的 `display` 保留、`content` 压到 ≤ 2 行；完整输出只在 entry 里。

> 注意方向性错误：**不要**用 `sendMessage` 冒充 assistant 语气长文。它下次以 **user 角色**出现，长文会被模型当成用户诉求，破坏后续对话归属。标签化包裹（`<reflex …>`）是必须的。

### 2.4 回退强模型时的「无损 + 防重入」

```ts
// input handler 内，同步返回 handled；真正的回退放到下一 tick
pi.on("input", (event, ctx) => {
  if (event.source !== "interactive") return { action: "continue" }; // extension/rpc 不受理
  if (event.streamingBehavior !== undefined) return { action: "continue" };
  // …规则匹配（同步，纯字符串）…
  if (!hit) return { action: "continue" };
  void runReflex(hit, event, ctx); // async：执行 + 判据 + 输出/回退
  return { action: "handled" };
});
```

`runReflex` 的回退分支：

```ts
pi.appendEntry("subagent:reflex", { ...record, outcome: "fallback" });
pi.sendMessage({
  customType: "subagent:reflex-note",
  display: false,
  content: `<reflex id=${id} status=miss reason=${why}/>`,
});
await new Promise((r) => setImmediate(r)); // 让 prompt() 先返回 handled
pi.sendUserMessage(event.text, { expandPromptTemplates: true }); // 重放原文
```

- `sendUserMessage` 走 `prompt()`，`source:"extension"`（`agent-session.js:1936`）⇒ 我们的 handler 第一行就放过，无环。
- **不要**在 input handler 里同步 `await` 长活（TUI 会静默、无进度、`isStreaming` 状态未定）。topic-switch 的做法就是先 handled、由 release 队列异步重投（`src/topic-switch/wire.ts:743-772` + `release.ts:40-118`），照抄即可。
- 回退必须**带原因**且**只回退一次**：`details.fallbackAttempted=true`，若同一 turnKey 第二次命中同一脚本则强制 `continue`（防止脚本坏 + 无限重放）。

### 2.5 明确否决的四条近亲方案

| 方案                                                                            | 为何否决                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Virtual model 路由到"无凭证模型"制造 error，再 `message_end` 替换成脚本答案** | ① error 响应会触发 pi 的自动重试链（`_isRetryableError` / `_prepareRetry`，`agent-session.js:1540-1548`），可能连环重试；② `message_end` 替换要求 role 一致且 usage/计费按"成功的模型响应"记账 ⇒ **账本说谎**；③ 思考签名/缓存前缀被污染。**收益（省一次请求）远小于确定性损失。** |
| **`context` / `context_with_system` 里把 transcript 换成"已有答案"**            | 请求照样发出，钱照样花，只是模型看到的东西变了。零收益。                                                                                                                                                                                                                           |
| **`before_provider_request` 改 payload 让模型复读**                             | 同上，且违反 I10 的精神（wire 不可控）。                                                                                                                                                                                                                                           |
| **`turn_end`/`agent_before_settle` + `continue:false` 当作"跳过"**              | 它们只决定"要不要再来**一次**请求"（`BoundaryResult.continue`），不能取消**已经发生**的那次。                                                                                                                                                                                      |

### 2.6 通道的静态顺序（谁先赢，写代码前必须先确认）

主会话 `input` handler 现有注册顺序（`src/index.ts:877-887`，post-guard）：

1. `createWakeInputHook`（唤醒归因，**必须**先看到人类输入，注释明确说明了原因）；
2. xs/rootWakeRecovery 记账（恒 `continue`）；
3. mention（`@label` 直达路由，可 `handled`）；
4. topic-switch（可 `handled` + hold）。

**R 层必须注册在 mention 之后、并且当 mention 已 `handled` 时永不执行**——因为 pi 的 `handled` 是短路（`runner.js:1200-1220`：return 值直接终止后续 handler 链）。反过来，R 层 `handled` 也会挡住 topic-switch 的判断；所以 R 层的门必须比 topic-switch **更严**（`sourceAllowed` + 短句排除 + 无图 + 空闲）。若两者可能同时命中，让 topic-switch 先（它的误判成本低：只是多问一句）。

### 2.7 边界与坑

| 坑                                              | 事实                                                                                                                         | 对策                                                                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **子会话的 prompt 也报 `source:"interactive"`** | `src/runtime/session-driver.ts:447` 调 `session.prompt(text)`，未传 source ⇒ 默认 `"interactive"`（`agent-session.js:1649`） | R 层**只能** post-guard 注册（`src/index.ts:302` 的 `if (g[HOST_KEY]) return;` 之后）。**这是硬不变式，写进代码注释 + 一条 conformance 测试。** |
| stdin 卡住                                      | 子进程等 stdin 会挂到超时                                                                                                    | `stdin:"none"`（`/dev/null`）                                                                                                                   |
| `handled` 后 turn 无进度反馈                    | 用户看到屏幕"没反应"                                                                                                         | 立即 `ctx.ui.setStatus("reflex","running")` + 超时兜底（≤3s）                                                                                   |
| 压缩中                                          | `prompt()` 会 throw（`agent-session.js:1648-1650`）                                                                          | `ctx.isIdle()` + `session_before_compact/session_compact` 期间禁用                                                                              |
| web-hub / 托管 spawn 的 prompt                  | 走 RPC → `source:"rpc"`，且 web-hub 有 hold 机制在等派发（`src/web-hub/agent/hold-wire.ts`）                                 | v1 **只受理 `interactive`**；`rpc` 留到 hold 驱动能识别 `handled` 之后再开                                                                      |
| 图片输入                                        | `InputEvent.images` 存在                                                                                                     | 带图一律 `continue`                                                                                                                             |
| 会话被 fork/切换                                | `activate()` 会重跑（新闭包）                                                                                                | 全部状态闭包内（I4），`Symbol.for` 只放只读缓存且带 TTL                                                                                         |
| 计时器                                          | `pi -p` 会被 ref 的定时器卡住                                                                                                | 一律 `unref()`（I5）；deadline 全过 `clampSpanMs`（I1）                                                                                         |

---

## 3. 历史会话证据（只读挖掘）

### 3.1 方法与隐私

- 数据面：`~/.pi/agent/sessions/**/*.jsonl`，1298 文件 / 336,986 行 / 1.5 GB，只读流式扫描（`session-format.md` 的 v3 树格式）。
- 只统计**结构**：角色、工具名、工具名序列、`stopReason`、`usage.cost.total`、条目时间戳差、命令的"形状"（路径/参数/引号内容一律替换为 `<a>`）。
- **本报告不包含任何用户提示正文、文件路径、命令参数**。下面所有表格都是计数与分位数。

### 3.2 总量

| 指标                       | 值                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 会话文件                   | 1298                                                                                                        |
| 用户请求（run）            | 4456                                                                                                        |
| assistant 消息             | 90,068（`stopReason`: toolUse 83,054 / stop 6,690 / error 313 / aborted 11）                                |
| 工具调用                   | bash 68,924 · read 12,314 · edit 5,218 · Agent 3,454 · write 1,737 · grep 1,394 · ask_user 983 · memory 431 |
| 模型分布（top）            | claude-opus 系 28,463 / glm-5.3 10,605 / sonnet 系 9,843 / kimi-k3 系 8,579+8,371                           |
| 汇总支出（模型自报 usage） | ≈ **$6,184**                                                                                                |

### 3.3 可确定执行的可节省面

以「严格只读 run」= 无 `edit`/`write` ∧ 工具数 1–2 ∧ 无 `ask_user` ∧ 无 `Agent`：

| 类别                             | run 数                   | 占比      | 支出       | 占支出    | p50 耗时 | p90     |
| -------------------------------- | ------------------------ | --------- | ---------- | --------- | -------- | ------- |
| 全部请求                         | 4456                     | 100%      | $6183.9    | 100%      | 255s     | 2044s   |
| **严格只读 run**                 | **602**                  | **13.5%** | **$148.2** | **2.40%** | **28s**  | **82s** |
| 其中：单条 bash                  | 256                      | 5.7%      | —          | —         | —        | —       |
| 其中：单次 read                  | 40                       | 0.9%      | —          | —         | —        | —       |
| 工具成功率（只读类）             | 97.8%（13 次含工具错误） |           |            |           |          |         |
| 纯回答（0 工具、1 条 assistant） | 275                      | 6.2%      | $50.8      | 0.82%     | 18s      | 51s     |
| ≤2 工具 / ≤2 assistant           | 502                      | 11.3%     | $129.8     | 2.10%     | 25s      | 73s     |
| 含写入的 run                     | 987                      | 22.1%     | $2595.7    | 42.0%     | 784s     | 3497s   |

**读数**：R 层的经济上限 ≈ 2.4% 的历史支出；它的主价值是 **28s → ~1s** 的延迟与"答案可回指"。写入类占了 42% 支出，R 层不该碰。

### 3.4 为什么「从历史抄命令」不成立

| 度量                                                           | 值                                   |
| -------------------------------------------------------------- | ------------------------------------ |
| bash 调用总数 / 不同形状（3-token，路径已泛化）                | 68,935 / 1,432                       |
| 最高频形状                                                     | `cd <path> && …` **50,705（73.6%）** |
| 只读单 bash run 中：剥掉 `cd <p> &&` 前缀后**无 shell 元字符** | **6 / 256（2.3%）**                  |
| 同上，且首词在程序白名单（git/ls/grep/npm/…）                  | **3 / 256（1.2%）**                  |
| 只读类全部 602 run 里不同命令形状                              | 63 个（top 仍是 `cd <a> <a>`）       |

**结论**：这个 agent 的 bash 语义是"任务定制的一次性复合命令"，不是"可复用子程序"。`cd 前缀`是 harness 约定造成的假形状。⇒ **提取环节不要试图把历史 argv 变成脚本**；应提取 **意图**（谁在反复问什么），脚本由人/模型按白名单**设计**，再用历史**回放验证**。

### 3.5 复读率高 ≠ 可确定性（最大误触发源）

| 分组                             | run 数            | 占比  | 支出  | 占支出 | p50 耗时 |
| -------------------------------- | ----------------- | ----- | ----- | ------ | -------- |
| 首行 ≤12 码点（继续/好/ok/选 X） | 777               | 17.4% | $843  | 13.6%  | 73s      |
| 首行 13–40 码点                  | 1309              | 29.4% | $1395 | 22.6%  | 100s     |
| 首行 >200 码点（贴长上下文）     | 806               | 18.1% | $1228 | 19.9%  | 448s     |
| 归一化后重复 ≥3 次的提示组       | 384 组 / 1532 run | 34.4% | $2362 | 38.2%  | —        |

**读数**：38% 的支出集中在"重复出现的提示"上，但重复的是"继续/开工"这种**启动开关**——它们后面跟着整段 agentic 工作。R 层若在这类短口令上误触发，代价是"任务没启动"级别的严重事故。⇒ 短口令必须**硬排除**（`SHORT_REPLY_TABLE` + 指代表，`src/topic-switch/filters.ts:13-40`）。

### 3.6 与"便宜模型"的对比

一次只读类 run 的 p50 成本是 $0.10、p50 延迟 28s。用最便宜的模型（历史里 `deepseek/deepseek-flash` 6,159 次调用）答同一问题，延迟约 1–3s、成本约 $0.001。⇒ **R 层相对"便宜模型代打"的增量价值**是：确定性（同一输入永远同一答案）、可审计（argv + 原始 stdout）、零网络/零凭证、可离线。**定价叙事不能写"省钱"**，要写"延迟 + 确定性 + 可审计"。

---

## 4. R 层架构

### 4.1 组件与数据流

```
                     ┌──────────────── 只读、进程内、同步 ────────────────┐
input ──► S0 廉价否决 ──► S1 意图匹配（脚本索引） ──► S2 分类器确认（可选，async）
   │        source/图/长度/短句/否定/压缩中             │
   │                                                   ├─ 无命中 ──► {continue}
   │                                                   └─ 命中
   │                                                        ▼
   └── handled ◄────────────────────────────────────── S3 执行（argv-only runner / in-proc port）
                                                                │
                                                    S4 判据（exit + stdout/stderr）
                                                       ├─ ok ──► entry(证据) + message(标签化摘要)
                                                       └─ fail/超时/不确定 ──► entry(失败记录) + 下一tick 重放原文 → 强模型
```

依赖方向（对齐 I8）：

```
src/reflex/
  index.ts        pi 面装配（wireReflex，post-guard，唯一 pi import）
  wire.ts         on("input") 注册 + 与 mention/topic-switch 的顺序契约文档
  trigger.ts      纯函数：S0 否决表 + S1 匹配（pi-free）
  scripts.ts      schema 解析/校验/索引（pi-free）
  slots.ts        槽位类型与绑定（enum/path/int/word），路径越界拒绝（pi-free）
  exec.ts         argv-only runner（仿 src/git/run.ts：无 shell、硬期限、进程组 kill、输出上限、unref）
  criteria.ts     成功判据求值（pi-free）
  render.ts       输出模板 + 摘要裁剪（pi-free）
  ports/          in-proc 脚本端口（jobs/quota/sessions/mem/git）——把"脚本"抽象成 port，便于测试与禁用
  extract/        离线：扫描 session jsonl → 意图簇 → 草案（不在 hot path，默认关）
  commands.ts     `/reflex`（list / explain / stats / shadow / enable / disable）
  settings.ts     reflex.* 键与默认值
```

### 4.2 时序（两分支）

**命中**

```
t0   input(interactive, idle, no image, len≤200)
t0   S0/S1 同步（<1ms）
t0   return handled                         ← 用户文本此刻不在 transcript
t0+  ui.setStatus("reflex","…")
t1   exec（≤ timeoutMs；unref 计时器；AbortController 联动 session_shutdown）
t2   criteria ok
t2   appendEntry("subagent:reflex", {id, ver, argv, exit, ms, outDigest, outTail})
t2   sendMessage({customType:"subagent:reflex", display:true, content:"<reflex …>\n…\n</reflex>"})
t2   ui.setStatus clear
```

注意 `appendEntry` 不写用户原话——**在 entry 里记 `requestDigest`（sha256 前 16 hex）+ 长度**，正文不进日志（与 Jev 的 `digestOfPayload` 同思路）。

**回退**

```
t0..t1 同上到 exec
t1   criteria fail / timeout / 输出为空 / 脚本标注 uncertain
t1   appendEntry("subagent:reflex", {outcome:"fallback", reason, argv, exit, ms})
t1   sendMessage(hidden, "<reflex id status=miss reason/>")   // display:false，进上下文但极短
t1   setImmediate → sendUserMessage(原文, {expandPromptTemplates:true})   // source=extension，不被再拦
t1   （若该 turnKey 已有一次回退记录 ⇒ 强制 continue，不再尝试）
```

### 4.3 设置键（新增 `reflex.*`）

```jsonc
"reflex": {
  "enabled": false,                 // 默认关；off ⇒ 零注册（I9）
  "mode": "shadow",                 // shadow | auto（shadow 只记账、永不代答）
  "sources": ["interactive"],       // rpc/web 需 hold 驱动改造后再开
  "maxInputChars": 200,
  "totalTimeoutMs": 3000,           // clampSpanMs；超出直接回退
  "execTimeoutMs": 5000,
  "allowWrite": false,              // 写入级脚本一律需确认，本键只允许"可进入确认流程"
  "confirmTimeoutMs": 30000,
  "scriptsDir": "~/.pi/agent/reflex/scripts",   // 数据面，不入库
  "maxOutputBytes": 4096,
  "maxOutputLines": 40,
  "cooldownS": 60,                  // 同脚本冷却
  "classifier": { "enabled": false, "models": ["…"], "budgetMs": 800 },
  "extract": { "enabled": false, "minGroupSize": 3, "lookbackDays": 30 }
}
```

配套：`applySecureDomainOverrides` 里强制 `reflex.enabled=false`（I11，坐标 `src/config/settings.ts:425-448` 同一处，与 `memory.jev`/`traffic`/`feishuNotify` 并列）；`trace-profiles.ts` 的 `max` 档加入 `reflex.enabled:true, mode:"shadow"` 并刷新 `activate-trace.json`（按该金身的规则）。

### 4.4 与仓库不变式的对齐

| 不变式               | 本设计的落点                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| I1 零挂死            | `totalTimeoutMs`/`execTimeoutMs` 过 `clampSpanMs`；超时先杀进程组再结算；回退路径有硬上限；无任何"等回调"的无界等待 |
| I2 装配只在 index.ts | `wireReflex(pi, deps)` 一处注册，`src/index.ts` 一行调用（post-guard）                                              |
| I3 守卫分层          | **post-guard**（主会话），且必须；pre-guard 会拦到子会话任务 prompt（§2.7 第一条）                                  |
| I4 无模块级可变状态  | 索引/计数器/冷却全在 `wireReflex` 闭包；跨激活共享只放 `Symbol.for("pi-subagent:reflex-stats")`（只读快照 + TTL）   |
| I5 unref             | 全部 `setTimeout/interval` `unref()`                                                                                |
| I6 子会话惰性        | 见 I3                                                                                                               |
| I7 旧名              | `customType` 用 `subagent:reflex*`（与 `subagent:*` 前缀一致）                                                      |
| I8 pi-free 边界      | `trigger/scripts/slots/criteria/render` 不 import pi；`exec` 只 `node:child_process`                                |
| I9 off ⇒ 字节相同    | off ⇒ 不注册任何 handler、不加任何命令；golden 用 `reflex-off-golden.json`（A 级新金身）                            |
| I10 wire 追加式      | 不新增 wire 字段；若 web-hub 要展示，只加可选字段                                                                   |
| I11 secure 域        | D8 强制关 + 不接线双保险                                                                                            |
| I12 tool vs skill    | 脚本本身是数据；**策略**（什么时候信任 reflex、误报怎么处理）写进 `skills/`，机制写进 tool/settings 描述            |

---

## 5. 脚本 schema（`rscript/1`）

### 5.1 完整示例（只读级）

```jsonc
{
  "schema": "rscript/1",
  "id": "git.dirty-summary",
  "version": 3,
  "createdAt": "2026-11-04T12:00:00Z",
  "provenance": {
    "origin": "authored", // authored | extracted
    "reviewedBy": "user",
    "reviewedAt": "2026-11-04T12:30:00Z",
    "evidence": ["docs/dev/jev-reflex/replay/git.dirty-summary.json"],
  },
  "intent": {
    "anchors": ["(工作区|workspace).{0,6}(干净|dirty|改动)", "git\\s+(status|状态)"],
    "exclude": ["commit", "push", "回滚", "撤销", "reset"],
    "slots": [],
    "requires": { "gitRepo": true },
    "classifier": {
      "hit": "asks for the current git working-tree state",
      "miss": "asks to change git state or history",
    },
    "examples": { "hit": ["现在工作区干净吗", "git 状态"], "miss": ["把这些改动提交了"] },
  },
  "exec": {
    "kind": "argv", // argv | port
    "argv": ["git", "status", "--porcelain=v1", "--branch"],
    "cwd": "session",
    "env": "minimal",
    "stdin": "none",
    "timeoutMs": 5000,
    "maxStdoutBytes": 65536,
    "maxStderrBytes": 8192,
  },
  "risk": "readonly",
  "success": { "exit": 0 },
  "output": {
    "mode": "evidence",
    "maxLines": 20,
    "emptyMessage": "工作区干净（无改动）。",
  },
  "fallback": { "on": ["exit!=0", "timeout", "empty"], "to": "model" },
  "guards": { "cooldownS": 60, "maxPerSession": 10 },
  "stats": { "runs": 0, "ok": 0, "p50ms": 0, "lastOkAt": null, "driftStrikes": 0 },
}
```

### 5.2 字段语义（逐条都是约束，不是描述）

| 字段                | 约束 / 语义                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | `^[a-z][a-z0-9-]*\.[a-z0-9-]+$`，全局唯一；`version` 单调递增，改 argv/判据/输出必须 bump                                                       |
| `provenance.origin` | `extracted` 的脚本**永远不能直接 `auto`**，至少过一次人工 review（§6.3）                                                                        |
| `intent.anchors`    | 正则数组，**全部**在原文（≤maxInputChars）上跑，**任一**命中即候选；必须至少 1 条                                                               |
| `intent.exclude`    | 任一命中即否决（比 anchors 优先）。内置全局排除（短口令/指代/否定，见 §7.1）**不可覆盖**                                                        |
| `intent.slots`      | 只允许 4 种类型（§5.5）；**绑定失败 = 整体不命中**（绝不猜）                                                                                    |
| `intent.requires`   | 前置条件（`gitRepo`/`fileExists:x`/`program:git`），不满足则不命中（且不记 FP）                                                                 |
| `exec.kind`         | `argv`（子进程）或 `port`（进程内，工具自身状态）；**没有 shell**，没有 `sh -c`，没有字符串拼命令                                               |
| `exec.argv`         | 静态数组；槽位以 `"{{slot}}"` 整元素出现，替换后必须过 `^[A-Za-z0-9._:/@+-]{1,200}$`（**不允许空格/引号/重定向**）。首元素必须在程序白名单内    |
| `exec.cwd`          | 只有 `"session"`（= `ctx.cwd`）；未来可 `"repoRoot"`（`git rev-parse --show-toplevel`）                                                         |
| `exec.env`          | `"minimal"`（PATH/HOME/LANG 白名单，仿 `src/git/run.ts:3-26` 的 `envPolicy`），禁止继承全部环境                                                 |
| `risk`              | `readonly` / `write-local` / `high`（§5.3）                                                                                                     |
| `success`           | 声明式判据（§5.4）；**未声明视为失败**（fail-closed 于"能否自动答"这一侧）                                                                      |
| `output.mode`       | `evidence`（原样回显 argv + 有界 stdout）或 `template`（模板只能引用 `{{stdout}}`/`{{exit}}`/已绑定槽位，**不能**引用未绑定的东西，不能"解释"） |
| `fallback.on`       | 触发回退的条件集合；未命中条件则视为 ok                                                                                                         |
| `guards`            | 冷却、每会话上限、`requiresConfirmation`                                                                                                        |

### 5.3 风险分级与执行策略

| 级别          | 判据                                                                                                                                                                                                                            | 策略                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `readonly`    | argv 首词在只读白名单（`git status/diff/log/branch/show`、`ls/cat/head/tail/wc/stat/grep/rg/find -print/du/df/pwd/which/node -v`…），无重定向、无写路径；或 `port` 且 port 只读                                                 | `mode:auto` 时可**自动答**                                                            |
| `write-local` | 写文件/改 git 工作区但可回滚（`git add`、`prettier --write`、`mv` 到 trash）                                                                                                                                                    | **必须 `ctx.ui.confirm`**（无 UI ⇒ 回退模型）；确认超时 ⇒ 回退                        |
| `high`        | 任何 `git commit/push/reset/rebase/checkout/switch/merge/cherry-pick/stash/tag/clone`、`npm publish/version/install`、`rm/trash/find -delete`、`gh pr/release`、读凭证路径（`.env*/*.pem/auth.json`）、`tests/fixtures/**` 写入 | **永久禁止作为反射脚本**（schema 校验直接拒绝加载，含 argv 前缀检查与路径 glob 检查） |

高危清单**直接复用 taxonomy 的匹配表**（`src/memory/jev/taxonomy.ts` 的 `PRESET_TAGS`：`git-commit`/`git-push`/`git-history`/`release`/`deletion`/`dependencies`/`credentials`/`frozen-files` 的 `match.commands`/`match.paths`），一份数据两处用，不新增第二套"危险命令"认知。⚠️ 注意：tag 的 `risk` 是**记忆条目**的风险等级，不是**请求**的风险等级——这里只借 `match` 表，不借语义。

### 5.4 成功判据 DSL

```jsonc
"success": {
  "exit": 0,                         // 必须
  "stdoutNonEmpty": false,
  "all": [
    { "stdoutMatches": "^## \\S+" }, // 至少一行匹配
    { "stderrMatches": null }        // null = 必须为空
  ],
  "any": [],
  "maxLines": 5000                   // 输出爆炸也算失败（防"看起来成功实则截断"）
}
```

判据只能看 `(exit, stdout, stderr, 行数, 字节数)`——**不允许**脚本返回"我认为成功了"。这是与"模型自评"的关键区别：判据是机械的、可回放的。

### 5.5 槽位类型（无 LLM 的参数抽取）

| 类型   | 语法                                                                                             | 抽取                   | 校验                                                                               |
| ------ | ------------------------------------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------- |
| `enum` | `{"type":"enum","name":"scope","values":{"工作区":"worktree","暂存区":"index","分支":"branch"}}` | 命中词表即绑定         | 值必须来自 `values`                                                                |
| `int`  | `{"type":"int","name":"n","min":1,"max":50,"default":10}`                                        | 正则 `\d{1,3}`         | 区间；非整数 ⇒ 整体不命中                                                          |
| `path` | `{"type":"path","name":"file","base":"cwd","mustExist":true,"within":"cwd"}`                     | 反引号/引号/裸路径候选 | `realpath` 后必须仍在 `base` 内；`..` 逃逸/绝对外部路径 ⇒ 拒绝；symlink 解析后再判 |
| `word` | `{"type":"word","name":"label","pattern":"^[a-z0-9-]{1,32}$"}`                                   | 唯一命名实体           | 严格 charset                                                                       |

**不做自由文本槽位。** 任何需要"理解"才能填的参数 ⇒ 该脚本不合格（回退模型）。这条是 R 层与"用便宜模型抽取参数"的分水岭：后者引入不确定性，前者可以证明"要么精确绑定、要么不触发"。

若需要分类器参与（`reflex.classifier.enabled`），它只能回答 **choice（脚本 id 或 `none`）**，不能产出参数——`classify()` 的答案类型只有 choice/score/bool（`pi-ai/dist/types.d.ts:449-503`），本来也产不出参数。

---

## 6. 提取 → 离线回放 → 启用

### 6.1 后台提取（**不提炼 argv**，提炼意图）

依据 §3.4 的反证，提取管线的产出物是"**意图簇 + 匹配器草案 + 回放用例**"，argv 由模板库/人补。

```
E1 采集    读 sessions/*.jsonl（复用 list_sessions 的发现基建，src/tools/list-sessions-tool.ts:104）
           抽 episode = { 用户首行(截断 200cp + 脱敏), 工具名序列, 每个工具的参数 shape, exit, 耗时 }
           只收：无 edit/write、≤3 工具、无 ask_user/Agent、工具全成功、首行长度 12..200cp
E2 聚类    归一化首行（路径→<path>、数字→<n>、代码块→<code>，仿 predict/rules 的规范）
           与命令 shape（复用 src/memory/jev/predict/shape.ts 的 `program [subcommand]`）双键聚类
           阈值：minGroupSize=3（可调），输出簇 + 代表样本（**只存摘要与计数**）
E3 草案    对每簇判断"是否可能确定化"：簇内工具形状是否同构（≥80% 同签名）→ 否则丢弃
           命中"可设计"的簇 → 生成 rscript 草案：anchors 取簇内共性 n-gram、slots 取变化位、
           exec 从**模板库**（内置的 5 个 port + 只读 argv 模板）里挑，不从历史 argv 抄
E4 离线回放  草案 + 历史 episode 的输入 → 真跑（只读、超时、沙箱 cwd）→ 与历史 stdout 比对
           比对器分三档：byte-equal / 行集 Jaccard ≥ 0.9 / "关键行仍在"（正则集合）
           记录 replay 报告（docs/dev/jev-reflex/replay/<id>.json），不达标的草案直接丢
E5 人工审阅  人（或 agent + 用户签字）看着 replay 报告 + diff 决定 accept/rewrite/reject
           → 写入 scriptsDir，`risk` 由 argv 自动判定 + 人工复核
E6 启用   见 §6.3 阶梯
```

提取全程**离线**（`reflex.extract.enabled=false` 默认）、不联网、不外发正文（外发纪律直接照 `src/memory/jev/predict/outbound.ts` 的 allowlist：只发 `program [subcommand]` + path_class，永不发参数/路径/正文）。

### 6.2 离线回放评测（准入门）

| 门       | 要求                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 可回放   | 同一 episode 输入重跑 ≥3 次，判据 100% ok（幂等 + 无随机）                                  |
| 语义等价 | 与历史 stdout 至少达到"行集 Jaccard ≥ 0.9"或"关键行全在"；否则标 `advisory`（仅 shadow）    |
| 覆盖度   | 该簇 ≥3 次历史命中，且 anchors 在语料上的**误命中率** = 0（用全库 4456 条首行做负样本扫描） |
| 排除面   | 对短口令/指代/否定/带图请求的样本集必须 100% 不命中（内置排除表的回归集）                   |
| 稳定性   | 对 30 天窗口内 2 个不同时间点的语料各扫一次，命中集合漂移 ≤ 10%                             |

### 6.3 启用阶梯

```
draft ──replay过──► shadow ──7天数据达标──► autoresolve(readonly) ──►（可选）confirm(write)
  │                   │                         │
  └─reject            └─永不代答，只记账           └─高危：schema loader 直接拒绝
```

- **shadow**：只 `appendEntry` 记账（"本可命中 X"），**永不**改变用户看到的流程。这是默认上线态。
- **autoresolve(readonly)**：自动应答。准入：shadow 期 ≥20 次候选命中 ∧ 用户没有在 90s 内追问/纠正（FP 代理指标）∧ zero replay drift。
- **confirm(write-local)**：`ctx.ui.confirm`（无 UI 直接回退）。**v1 不实现**，只留 schema 位。
- **high**：不可达（loader 拒绝）。

### 6.4 过期与退役

- `guards.cooldownS` + `maxPerSession` 防刷。
- **drift canary**：每个脚本每 24h（或每 5 次命中）与 replay 基线比对一次（shadow 期间顺带做），连续 2 次不符 ⇒ 自动降回 `shadow`，3 次 ⇒ 自动 `disabled` + `/reflex` 提示。
- `expiresAt`（可选）：随项目结构变化（如 `package.json` scripts 改名）显式到期。
- 主动退役：`/reflex disable <id>`；统计里 `runs==0` 超过 30 天 ⇒ `/reflex` 页面标 `stale`。

---

## 7. 误触发与注入防护

### 7.1 触发侧（12 条，全部在 S0/S1，同步、零 I/O）

1. `source !== "interactive"` ⇒ 放行（`rpc`/`extension` 一律不碰）。
2. `streamingBehavior !== undefined` ⇒ 放行（流式中 steer/followUp 不拦，避免抢用户插话）。
3. `images?.length` ⇒ 放行。
4. 文本（trim 后）码点 > `maxInputChars` ⇒ 放行。
5. 命中**短口令/承接/指代**表 ⇒ 放行（复用 `SHORT_REPLY_TABLE`/`ANAPHORA_CJK`，`src/topic-switch/filters.ts:13-40`）。
6. 命中**取消/否定** ⇒ 放行（`cancelIntent`/`negationWithinWindow`，`src/memory/jev/predict/clauses.ts:98,146`）。
7. 含换行 > 2 行、或含代码块围栏、或含 `@label`/`@file` 前缀 ⇒ 放行（消息不是"一句话请求"）。
8. 本会话上一条消息是 `ask_user` 的待答问题 ⇒ 放行（那是答案，不是请求）。
9. 压缩中（`session_before_compact` 之后未 `session_compact`）⇒ 放行。
10. 同 `requestDigest` 在最近 3 轮出现过且已回退 ⇒ 放行（防"脚本坏 + 反复重放"）。
11. 脚本 `guards.cooldownS` 未过 / `maxPerSession` 用尽 ⇒ 放行。
12. 任一 handler 内部异常 ⇒ `{action:"continue"}`（fail-open：宁可交给模型，也不答错）。

> 与 pi 的通用建议相反：pi 文档说 gate 类 handler 应 fail-closed（`docs/extensions.md:378`）。R 层**不是安全 gate，而是优化器**——它的正确失败模式是"什么都不做"，所以此处 fail-open 是对的。这个差异必须写进代码注释，否则 review 会按文档改错。

### 7.2 输出侧（提示注入）

脚本输出是**不可信内容**（README、日志、issue 文本都可能含指令）。所以：

- 输出必须包在 `<reflex id=… ver=… outcome=ok>` 标签内，且 `output.mode=evidence` 时**只**回显 argv + stdout，不生成自然语言（避免模型把脚本作者的话当成用户/系统指令）。
- 永不把输出写进 **system prompt**（`before_agent_start` 的 `systemPrompt` 字段一律不用），只走 message 通道（与 Jev 的 `subagent:memory-inject` 纪律一致）。
- 输出裁剪：`maxBytes`/`maxLines` + 超限标注 `[truncated N bytes]`，并提示"用真实命令取全量"。
- 敏感内容：输出经与 Jev 同源的脱敏（`src/memory/jev/redact.ts` 的 `redactForJev`）后才进 entry/message；凭证样式（`*.pem`、`sk-…`、`Bearer …`）整行打码。

### 7.3 失败/超时

- 执行超时 ⇒ 杀**进程组**（`src/git/run.ts` 的 `createGitRunner` 已是这个模型：硬期限 + 组 kill + 输出上限），`outcome:"timeout"` ⇒ 回退。
- 输出超上限 ⇒ `outcome:"overflow"` ⇒ **回退**（不要"截断后当成功"，那会造成"答了一半"）。
- `ok` 但输出为空且 `stdoutNonEmpty:false` 未声明 ⇒ 按脚本声明的 `fallback.on` 处理（默认回退）。

### 7.4 隐私与 secure 域

- 数据面在 `~/.pi/agent/reflex/`（随 `PI_CODING_AGENT_DIR`，I7），不改仓库。
- secure/locked 域：`reflex.enabled` 强制 false（settings override）+ 不接线（`src/index.ts` 只把 `secureDomain.kind` 传进去，不自己判定），与 `memory.jev` 同构。
- 提取器只写"摘要 + 计数 + digest"，**永不**把提示正文写进 scriptsDir 或日志。

---

## 8. 指标

### 8.1 北极星与护栏

| 层       | 指标                                                                       | 目标                      |
| -------- | -------------------------------------------------------------------------- | ------------------------- |
| 北极星   | **省下的墙钟时间**（Σ 命中数 × 该类请求的历史 p50 28s − 实际 reflex 耗时） | 单调上升；≥ 10 分钟/周    |
| 北极星 2 | **用户"接受率"**（命中后 90s 内无追问/纠正/重问）                          | ≥ 97%                     |
| 护栏     | **错误答案数**（人工抽样 + 用户显式纠正）                                  | 0                         |
| 护栏     | 回退成功率（回退后模型正常接手）                                           | 100%                      |
| 护栏     | off 时字节相同 / 零注册                                                    | 由 golden 钉住            |
| 成本     | 未命中路径的额外开销                                                       | ≤ 200ms p99（纯内存匹配） |

### 8.2 逐脚本指标

`runs / ok / fallback{reason} / timeout / p50ms / p95ms / fpRate / driftStrikes / lastOkAt / savedSeconds / cooldownHits`

FP 的机械判定（不需要人工）：命中后 90s 内出现 (a) 用户新消息含纠正词（"不对/不是/重新"）或 (b) 用户复述同一意图（归一化相似度 ≥0.8）⇒ 记 FP。

### 8.3 观测点（代码坐标）

- 命中/回退：`appendEntry("subagent:reflex", …)` ⇒ `ctx.sessionManager.getBranch()` 可回读，`/reflex stats` 汇总；
- 延迟：entry 的 `ms`（单调时钟，仿 `tool_execution_end.durationMs` 语义，`types.d.ts:872-880`）；
- 与模型成本无关（0 LLM）；
- 误触发面：与 topic-switch 的 `noteSkip` / `records` 同样的落盘习惯。

---

## 9. MVP 范围

### 9.1 第一刀：**自省类只读（`port` 脚本，零子进程、零 shell）**

| #   | 脚本 id           | 意图                            | 实现                                                          | 风险     |
| --- | ----------------- | ------------------------------- | ------------------------------------------------------------- | -------- |
| 1   | `jobs.list`       | "后台还有几个 job / 有在跑的吗" | 进程内读 `BashJobManager` 快照（`src/bash/manager.ts`）       | readonly |
| 2   | `jobs.status`     | "那个 job 完了吗"               | 同上 + `word` 槽位匹配 label                                  | readonly |
| 3   | `quota.summary`   | "额度还剩多少 / 这周花了多少"   | 进程内读 quota/HUD 快照（`src/quota/`、`src/hud/`）           | readonly |
| 4   | `sessions.recent` | "最近开了哪些会话"              | `list_sessions` 同源数据（`src/tools/list-sessions-tool.ts`） | readonly |
| 5   | `mem.index`       | "记忆里有哪些条目"              | `src/memory` tiered 渲染索引（只读）                          | readonly |
| 6   | `fleet.status`    | "有几个 subagent 在跑"          | `SubagentWorkflow`/run registry 快照                          | readonly |
| 7   | `git.dirty`       | "工作区干净吗 / 改了什么"       | argv `git status --porcelain=v1 --branch`                     | readonly |

理由：这 7 个全部满足"结果唯一 + 数据就在进程内/一条只读命令"，覆盖了三类高频低风险问题，且**没有一条能造成副作用**。它们的 argv 只有 1 条（`git status`），其余是 port。

### 9.2 里程碑

| 阶段             | 交付                                                                                                                | 验收                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **M0**（1–2 天） | 关着的骨架：settings 键 + `wireReflex`（off ⇒ 零注册）+ `reflex-off-golden`（A 级）+ secure 强制关 + `/reflex` 空壳 | `npm test` 绿、trace 金身不变、off golden 逐字节         |
| **M1**（3–4 天） | S0/S1/S4 + `port` 执行 + 两个脚本（`jobs.list`、`git.dirty`）+ shadow 模式 + entry/message 输出 + 回退链            | 单测覆盖 12 条否决；对拍测试：回退路径用户视角与今天一致 |
| **M2**（3–5 天） | 剩余 5 个 port 脚本 + `/reflex stats` + drift canary + 降级逻辑；shadow 跑 1–2 周                                   | shadow 期 FP=0；命中率 ≥5%；p95 ≤ 1.5s                   |
| **M3**（可选）   | 切 `autoresolve`（逐个脚本、逐个开关）+ 分类器辅助（ambiguous band）+ 提取器（离线，仅出报告）                      | 每脚本单独晋升；任何一次 FP ⇒ 立即降回 shadow            |

总量级估算：新增 ~2,500–3,500 行（含测试 1:1），不碰任何现有子系统；唯一"接触面"是 `src/index.ts` 一行装配、`src/config/settings.ts` 一处强制关、`tests/governance` 金身刷新。

### 9.3 明确不进 MVP

- 写类脚本（含"格式化/重命名"这类看起来安全的）；
- `rpc`/web 来源（需先改 web-hub hold 驱动让它识别 `handled`）；
- 自动提取器联网/自动启用；
- 用分类器抽取参数；
- 任何 `shell:true` 的脚本；
- workflow/子会话内的 reflex（子会话 inert）。

---

## 10. 未决问题（需要拍板）

1. **MVP 的第一批脚本选哪 3 个？**（建议 `jobs.list` / `git.dirty` / `quota.summary`）
2. **`handled` 后用户那句提问不再进 transcript**——接受"用 entry 记 digest 而不记正文"，还是"用隐藏 message 记原文"（进上下文、可读、+tokens）？
3. 默认 `mode`：`shadow` 先跑两周（建议），还是直接 `auto` 单脚本上线？
4. 是否允许 `rpc` 来源（涉 web-hub hold 改造，工程量 +2–3 天）？
5. 是否接受"**只做 port 脚本、不做 argv 脚本**"的更小 MVP（纯进程内、零子进程、零 shell；`git.dirty` 用 port 读 `.git` 或直接不做）——最保守，也许足够验证假设。

---

## 附录 A：证据坐标（全部为本次实读）

**pi API（`@earendil-works/pi-coding-agent@1.4.0`）**

| 事实                                                                                            | 坐标                                                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `InputSource` / `InputEvent` / `InputEventResult`（`continue`/`transform`/`handled`）           | `dist/core/extensions/types.d.ts:908-941`                                           |
| `input` 事件是"transform 链 + handled 短路"                                                     | `dist/core/extensions/runner.js:1200-1220`                                          |
| `prompt()` 顺序：`/` 命令 → 压缩检查 → input → 展开 → 入队/起 run                               | `dist/core/agent-session.js:1633-1666`                                              |
| `handled` ⇒ `preflightResult("handled"); return`（不产生 run）                                  | `dist/core/agent-session.js:1649-1655`                                              |
| `_runInputHandlers` 内部 handled → `undefined`                                                  | `dist/core/agent-session.js:1590-1603`                                              |
| `sendCustomMessage` 四种情形（含"不 trigger 就不起 run"）                                       | `dist/core/agent-session.js:1844-1878`                                              |
| `_appendCustomMessage`（写 entry + 发 message 事件）                                            | `dist/core/agent-session.js:1883-1886`                                              |
| `sendUserMessage(..., source:"extension")`                                                      | `dist/core/agent-session.js:1910-1937`                                              |
| RPC prompt 的 `source:"rpc"`                                                                    | `dist/modes/rpc/rpc-mode.js:306`                                                    |
| `disposition==="handled"` ⇒ 客户端不等 `agent_settled`                                          | `dist/modes/rpc/rpc-client.js:132-137`                                              |
| `BeforeAgentStartEventResult` 只有 `message`/`systemPrompt`（不能跳过请求）                     | `dist/core/extensions/types.d.ts:1125-1128`                                         |
| `BoundaryResult` = `{entries?, continue?}`；`turn_end`/`agent_before_settle` 用它               | `dist/core/extensions/types.d.ts:786-800,1085-1087`                                 |
| `ToolCallEventResult.block` / `ToolResultEventResult` / `MessageEndEventResult`                 | `dist/core/extensions/types.d.ts:1089-1098,1114-1124`                               |
| `appendEntry`（不进 LLM）/ `registerEntryRenderer` / `sendMessage` / `sendUserMessage` / `exec` | `dist/core/extensions/types.d.ts:1253-1285`                                         |
| `ExtensionContext.abort()` / `isIdle()` / `hasPendingMessages()`                                | `dist/core/extensions/types.d.ts:213-253`                                           |
| `ExtensionVirtualModel`（只能选物理模型）                                                       | `dist/core/extensions/types.d.ts:1409-1413`；`docs/virtual-models.md:52-70,100-104` |
| `classify()` 契约；答案只有 choice/score/bool                                                   | `dist/core/model-registry.d.ts:47`；`pi-ai/dist/types.d.ts:449-503`                 |
| custom message 的内容在下次请求转成 **user** 角色                                               | `docs/message-types.md:238-245`                                                     |
| 事件生命周期/组合/门/fail-closed                                                                | `docs/extensions.md:110-176,280-300,375-380`                                        |
| 会话格式 v3（`session`/`message`/`custom`/`custom_message`/`model_change`）                     | `docs/session-format.md`；`docs/message-types.md:120-175`                           |

**仓库**

| 事实                                                                  | 坐标                                                                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `initSecureDomain()` 是 `activate()` 第一条语句                       | `src/index.ts:130`                                                                                        |
| `isChildSession = Boolean(g[HOST_KEY])`                               | `src/index.ts:176`                                                                                        |
| 子会话早退（post-guard 全部不可达）                                   | `src/index.ts:302`                                                                                        |
| 现有 `input` 注册顺序（wake → xs → mention → topic-switch）           | `src/index.ts:876-887`                                                                                    |
| topic-switch：handled + hold + 异步重投                               | `src/topic-switch/wire.ts:743-772`；`src/topic-switch/release.ts:40-118`；`src/topic-switch/hold.ts:8-50` |
| 短口令/指代/只受理 interactive\|rpc                                   | `src/topic-switch/filters.ts:13-40`                                                                       |
| `@label` 拦截 + `sendMessage(display:true)` 零-LLM 回复（现成先例）   | `src/mention/mention.ts:145-175`                                                                          |
| 子会话 `session.prompt()` 未传 source ⇒ 默认 `interactive`            | `src/runtime/session-driver.ts:447`；`agent-session.js:1649`                                              |
| Jev client（failover/预算/`DEFAULT_BUDGET_MS=4000`）                  | `src/memory/jev/client.ts:30,145,300-330`                                                                 |
| taxonomy 的 `risk`/`match.commands`/`match.paths`（高危命令与路径表） | `src/memory/jev/taxonomy.ts:34-140`                                                                       |
| 否定/取消/只读意图判定（可直接复用）                                  | `src/memory/jev/predict/clauses.ts:98,138,146`                                                            |
| 命令 shape（`program [subcommand]`，永不带参数）                      | `src/memory/jev/predict/shape.ts:17-45`                                                                   |
| 外发 allowlist 纪律（不外发正文/路径/参数）                           | `src/memory/jev/predict/outbound.ts:1-20`                                                                 |
| 脱敏                                                                  | `src/memory/jev/redact.ts`（`redactForJev`）                                                              |
| argv-only 有界执行器（无 shell、组 kill、输出上限）                   | `src/git/run.ts:3-36,105`                                                                                 |
| secure 域强制关（D8）的集中点                                         | `src/config/settings.ts:425-448`                                                                          |
| activate trace 金身与 `max` profile                                   | `tests/governance/activate-trace.test.ts:15-29`；`tests/governance/trace-profiles.ts:20-60`               |
| 离线评测脚本先例（Tier 3）                                            | `scripts/dev/jev-eval.mjs`、`scripts/dev/predict-eval.mjs`                                                |
| 会话发现基建                                                          | `src/tools/list-sessions-tool.ts:104`                                                                     |
| bash job 管理（`jobs.*` 端口数据源）                                  | `src/bash/manager.ts`、`src/bash/types.ts`                                                                |
| 全局不变式 I1–I12                                                     | `AGENTS.md`「Global invariants」                                                                          |
| 改 `src/x/**` 前必读 README 的规则                                    | `AGENTS.md` 顶部硬规则表                                                                                  |

## 附录 B：复算方式（只读、可重现）

```sh
# 总量 / 角色 / 工具 / 模型分布
node --input-type=module -e '<流式统计脚本，见 §3.2>'   # 在 ~/.pi/agent/sessions 下执行
# 只读 run 面与延迟分位（§3.3）
# 命令形状与「cd 前缀占比」（§3.4）
# 短口令 / 重复提示组（§3.5）
```

复算脚本本身不做任何写操作，也不打印正文；如需再次核对，按 §3.1 的口径重跑即可（扫描 1298 文件约 40–60s/遍）。

---

**给决策者的一句话**：技术上只有一条路能真省下这次请求（`input` → `handled`），它足够安全、工程代价小；收益主要不是钱（2.4% 支出）而是"28 秒 → 1 秒 + 答案可回指"。真正有风险的不是执行，而是**触发**——历史数据表明 17% 的请求是短口令、38% 的支出在重复提示上，这两类正是绝不能碰的。因此第一刀应当是 7 个进程内只读 port 脚本，`shadow` 起步。

---

### 交付说明

- **未写入任何文件**（只读探索）。上文即 `docs/dev/jev-reflex/feasibility.md` 的建议全文。
- 三处最关键的新结论（都有反证支撑）：① pi 里唯一零-LLM 入口是 `input`→`handled`（`agent-session.js:1649-1655`），`before_agent_start`/`turn_end`/`virtual model` 都不能跳过请求；② 「从历史抄命令」在本机会话语料上不成立（只读单命令 run 中仅 1.2% 可静态化为 argv）；③ 收益是延迟与确定性（13.5% 请求 / 28s→≈1s），成本侧只有 2.4%。
