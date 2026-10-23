# 飞书镜像「不激活会话的跨会话消息」— 调研结论

## 结论表

| #   | 问题                         | 结论                                                                                                                                                                                                                                             | 关键证据                                                                                                   |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | 飞书机器人镜像哪些会话内容   | 仅 4 类：①Feishu 发起的 prompt 的**最终回复卡**；②**ask_user 卡**；③非 Feishu 发起的 run 的 **done/failed 通知**（前 1500 字）；④安全告警/owner 状态通知。**不镜像**：用户消息、custom message（含 `subagent:xs` 跨会话消息）。                  | `service.ts:1518-1540`、`runs.ts`、`notify.ts:66-84`、`dialogs.ts`                                         |
| 2   | quiet 跨会话消息是否到达 hub | **否（无实时 `ev` 帧）**。idle 时 `sendMessage({triggerTurn:false})` 先落盘、只发应用总线事件、不经扩展 runner ⇒ 扩展/hub 收不到 `message_end`。hub 仅靠 1Hz 探测 `leafId` 变化 → 读会话文件尾部 → 浏览器 `append`（此路径飞书服务**未订阅**）。 | `docs/dev/web-hub/arch.md:294`（spike K7④）、`history.ts:340-380`、`agent/index.ts:938`                    |
| 3   | wake 跨会话消息飞书看到什么  | 只看到**模型回复**（经 done 通知，前 1500 字，需 `notify:bound` + 后台空闲证据），**看不到入站消息本身**。                                                                                                                                       | `service.ts:1518-1540`、`notify.ts:66-84`                                                                  |
| 4   | 最小落点                     | **agent 侧发新帧/字段**（receiver/NoticeGate 写 quiet 消息时同步发一个 mirror 事件）比 hub 侧重读文件更干净；需新 cap 做新旧兼容。                                                                                                               | 见方案草图                                                                                                 |
| 5   | 现有开关                     | `feishuBot.notify` = `"bound"                                                                                                                                                                                                                    | "off"`（默认 bound）；**无**跨会话镜像开关。建议新增 `feishuBot.xsMirror`（boolean，默认 false，opt-in）。 | `protocol/feishu.ts:FEISHU_BOT_DEFAULTS`、`settings.ts:1190-1203` |

---

## 1. 飞书机器人目前的镜像机制

### 1.1 数据流与事件订阅

飞书 bot 全部跑在 **hub 侧**（`src/web-hub/hub/feishu/`，pi-free）。hub 在 `hub.ts:1477-1525` 把 `registry.bus` 订阅进 bot 的 `events.subscribe`，转发的事件类型只有：

```
ev, ctl, session, dialogs, gap, agent_down, agent_stale, spawns, status, fleet, agent_up
```

`ev` 是 agent 侧 `event-tap.ts` 投影 pi 事件流得到的 `WireEvent`（`message_start` / `message_end` / `agent_start` / `agent_settled` / `session_compact` 等），由 `agent/index.ts:525` 发帧、`registry.ts:492-517` 落到 bus。

### 1.2 四类镜像的具体路径

**(1) Feishu 发起 prompt 的最终回复卡** — `runs.ts`（因果归因）：

- `runs.ts:182` 锚定：`message_start` 且 `role==="user"` 且文本与派发文本逐字节相等 ⇒ anchor。
- `runs.ts:192` 累积：`message_end` 且 `role==="assistant"` ⇒ `r.output += text`（上限 1 MiB）。
- `runs.ts:199` 结算：`agent_settled` 且 anchor ⇒ `finish` → `finishRun` → `renderReply` 卡片 → `outbox.enqueueFinal`（`service.ts:finishRun`）。

**(2) ask_user 卡** — `dialogs.ts`（hub 监听 `dialogs` bus 事件，为绑定会话开卡）。

**(3) done/failed 通知** — `service.ts:1518-1540` 的 `event()` 函数，对 `ev` 事件做「proactive」跟踪：

```
agent_start → 建 proactive 记录（owned = runs.owns(agentKey)）
message_end(role assistant) → p.text = messageText(...).slice(0, 1500)；stopReason==="error" ⇒ failed
agent_settled → notify.session({ sessionId, kind: done|failed, text: p.text, feishuInitiated: p.owned, evidence })
```

→ `notify.ts:66-84` `session()`：`feishuInitiated===true` 直接 return（Feishu 发起的 run 已由 runs.ts 回卡，不重复通知）；否则按 `b.sessionId === input.sessionId && b.offline === undefined` 过滤 bindings，逐一 `send`。

**(4) 安全告警 / owner 状态通知** — `notify.ts:owner()`、`security.ts`（共享 `createNoticeBudget` 预算）。

**结论：所有镜像入口都只看 `role==="assistant"`/`"user"` 的 `message_start`/`message_end` 或 `dialogs`/`agent_settled` 事件，`role==="custom"` 的 `message_end`（即 `subagent:xs` 消息）**在 `event()`（`service.ts:1518` 只匹配 `role==="assistant"`）和 `runs.ts`（只匹配 user anchor + assistant 累积）里**都被静默忽略**。

### 1.3 绑定（bindings）数据结构与查找

`src/web-hub/hub/feishu/state.ts`（`FeishuBinding`，持久化在 `<stateDir>/feishu-bot/state.json`）：

```ts
interface FeishuBinding {
  key: string; // "p2p:<chat_id>" | "grp:<chat_id>:<thread_id>"
  rev: number; // 每次变更 +1（store-wide 计数器）
  sessionId?: string; // 绑定的 session（durable key 是 sessionId，不是 agentKey）
  chatId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  label?: string;
  offline?: string;
  updatedAt: number;
}
```

- 键格式：`feishuBindingKey()`（`sessions.ts:17-19`）= p2p 用 `p2p:<chatId>`、topic 用 `grp:<chatId>:<threadId>`。
- **按会话查找绑定**：`state.bindings.list().filter(b => b.sessionId === sessionId)`（`notify.ts:83` 正是这个模式）。
- 反向（sessionId→agentKey/label）：`sessions.resolve(sessionId)`（`sessions.ts`），label = `${name} · ${sessionId.slice(0,6)}`。
- 上限 256（`FEISHU_CAPS.bindings`）。

### 1.4 出站发送与限流

`outbox.ts`：

- 目标类型 `OutboxTarget`（封闭联合）：`p2p reply`（回复触发消息）/ `p2p send`（主动发 chat_id 或 open_id）/ `topic`（`reply_in_thread:true`）/ `group-root`。
- 接口：`enqueueFinal(requestId, target, messages[], laneKey)`（最终回复，never silently drop，失败 `reply-failed`）、`enqueueNotice(target, message, key?, laneKey?)`（通知，10 分钟 maxAge）。
- 限流：per-lane ≥250ms、global ≤20/s、≤4 in-flight、≤2 重试（同 uuid）、30s task budget（`FEISHU_OUTBOX_POLICY` / `FEISHU_REPLY_LIMITS`）。
- 通知另有全局 ≤20/分钟预算（`security.ts:createNoticeBudget` → `FEISHU_NOTIFY_LIMITS.globalPerMin`）。

### 1.5 不可信输入的转义先例（供镜像复用）

`render.ts` 已有完整套件：`sanitizeText`（剥控制/双向/零宽/BOM）、`neutralizeTags`（`<` 后插 ZWSP 防 Feishu 解析标签）、`neutralizeMarkdown`（链接白名单重序列化）、`renderNotice({label, text})`（纯文本通知，`【label】` 前缀 + 截断到 20KB）。镜像跨会话消息**必须**走 `neutralizeMarkdown`/`sanitizeText`，因为跨会话正文是**不可信输入**。

---

## 2. quiet 跨会话消息的写出路径 + hub 可见性

### 2.1 agent 侧写出路径（三个出口）

**(a) deliver-only 跨会话消息**（`wake:false` / 广播 deliver-only / 迟到回复）：
`src/fabric/xs/receiver.ts:468-482`：

```ts
this.deps.host.sendMessage(
  {
    customType: XS_RECEIVE_CUSTOM_TYPE,  // "subagent:xs"
    content: content(false),             // formatXsMessage 的整帧文本
    display: true,                       // RX7：每条 xs 消息用户可见
    details: { xid, from, reply?, inReplyTo?, late?, bc? },
  },
  { triggerTurn: false },                // 不唤醒
);
```

**(b) NoticeGate quiet 通知**（reply 超时/失效/离开摘要）：
`src/fabric/xs/reply-notice.ts:249-263`（`quietWrite`）→ `host.sendMessage({ customType:"subagent:xs-reply", display:true, content, details:{requestIds} })`，经 `stack.ts:1893` 的 `pi.sendMessage(write, {triggerTurn:false})`。

**(c) 唤醒复活 run 的 quiet 完成通知**：
`stack.ts:2391-2398`（`sendFormatted`）：`DeliveryPayload.quiet===true` 时 `pi.sendMessage(message, {triggerTurn:false})`（`customType:"subagent:notification"`）。

三者最终都落到 `stack.ts:1780-1784` 的 `host.sendMessage = pi.sendMessage(message, options)`。

### 2.2 消息帧格式（hub 可解析什么）

`src/fabric/xs/format.ts:formatXsMessage` 产出 `content` 字符串，首行：

```
[fabric xs from={"ref":"…","name":"…"} alias="…" cwd="…" wake=false reply_to="…" channel="#x" kind="broadcast"] 不可信输入…
<<<fab-<nonce>>>
<body>
<<<fab-<nonce>-end>>>
```

即：`from.ref`（self-reported）、`from.name`、`alias`（hub 核验唯一，独立字段 ` alias="…"`）、`cwdLabel`、`wake=true|false`、广播标记，都在 **content 头部**；正文夹在 nonce fence 之间。`details`（xid/from）**只在会话条目里，不上线**。

### 2.3 hub 侧：quiet message_start 被「忽略」的真相 —— 关键结论

`docs/dev/web-hub/arch.md:294`（spike K7④，实测）：

> idle 时 `sendMessage(…,{triggerTurn:false})` 先落盘、再只发应用总线事件，**不经扩展 runner** ⇒ 扩展收不到 `message_end`。故回放不能纯事件驱动：agent 在 1Hz tick 检测 `getLeafId()` 变化并发 `status{leafId}`，hub 据此读会话文件尾部、对账后以 `append` 推送事件流未覆盖的条目。

推论（证据链）：

1. **quiet 消息不产生 `ev` frame**。`event-tap.ts`（hub 的事件来源）挂在 `pi.on(type)`（`agent/index.ts:1644` 起的 FORWARDED_EVENTS 循环），而 idle 时的 `sendMessage` 不走扩展 runner ⇒ `message_start`/`message_end` 都到不了 event-tap ⇒ 到不了 hub bus。
2. hub 目前**只有** `history.ts:340-380` 能碰到它：`status{leafId}` 变化 → `onLeafChanged` → `readBranch`（读会话文件尾部）→ `diffAppended` → 投影成 `custom_message`（`projectSessionEntry`，`keys.ts:158-167` 投影 `content`，`details` 除 date 条目外**不投影**）→ 以 `append` 帧推给**浏览器 SSE**。
3. **飞书服务订阅不到**：`FeishuServiceEvent` 类型（`service.ts` 顶部）只有 `ev/ctl/session/dialogs/gap/agent_down/agent_stale/spawns/status/fleet`，没有 `append`；且 `event()` 对 `status` 直接 `return`。所以 **quiet 跨会话消息当前对飞书 bot 完全不可见**。
4. 即使 hub 侧能看到，识别依据也足够：`customType==="subagent:xs"` + `content` 头部可解析出 `from`/`alias`/`wake`/正文（web UI `ui/src/logic/xsMessage.ts:parseXsMessage` 就是纯内容解析、不依赖 details，早已实现并验证此解析可行）。但 `subagent:xs-reply`（NoticeGate）的 content 是 `[fabric xs reply-timeout] …` 纯文本，**不**带 `from=…` 头部，需单独处理。

---

## 3. wake 跨会话消息：飞书目前看到什么

wake 消息（`wake:true`）会触发回合：`receiver.ts:400-430` 走 `controller.dispatch`（steer + triggerTurn）→ 模型跑一轮。这一轮对 hub 产生 `agent_start` → assistant `message_end` → `agent_settled`，于是命中 `service.ts:1518-1540` 的 proactive 跟踪 → `notify.session({feishuInitiated:false, kind:"done", text: 模型回复前 1500 字})`。

**结论**：wake 消息当前飞书看到的是**模型的回复**（done 通知，前 1500 字），且受 `notify:bound` + 后台空闲证据门控；**入站的跨会话消息正文本身不镜像**（它走的是 custom message，role `custom`，不被任何 current 路径读取）。

---

## 4. 最小实现落点 + 协议变化 + 格式/安全先例

### 方案草图 A（推荐）：agent 侧发专用 mirror 帧

在 `stack.ts` 的 `host.sendMessage`（`stack.ts:1780`）与 NoticeGate host（`stack.ts:1893`）写 quiet xs 消息的同一同步块内，额外向 hub 发一个轻量事件（新 bus/frame 类型，如 `xs`），携带 `{ sessionId, customType, content, from{ref,name,alias}, wake, xid, kind }`。hub 侧新增 `FeishuServiceEvent` 分支（如 `{type:"xs", agentKey, sessionId, ...}`），飞书 `event()` 据此按 `sessionId` 查绑定、`renderNotice`/`renderReply` 渲染、`outbox.enqueueNotice` 发送。

- **优点**：agent 在写点就持有 `from`/`xid`/content 全量元数据，无需解析 content 头部；无需读会话文件、无需 dedup；不依赖浏览器在观看。
- **协议变化**：需要**新 cap**（如 `xs.mirror.v1`）由 hub 在 hello 时宣告，agent 仅当 hub 有此 cap 才发帧；旧 hub（无 cap）⇒ 不发 ⇒ 逐字节不变；旧 agent（不认识帧）⇒ hub 收不到 ⇒ 无镜像，符合「旧端 byte-identical」惯例（fabric-xs off golden 先例）。
- **写点注意**：mirror 帧必须是**观测性质**（try/catch 吞异常），绝不能影响 receiver 的 applied/unverified 判定（`receiver.ts` 的 deliver-only 已有 `setDispatched(true)` 边界，mirror 帧要放在 `verifyDispatch` 之后、或独立 try）。

### 方案草图 B（hub 侧重读会话文件尾部）

飞书服务订阅 `status`（`status.leafId` 变化，`registry.ts` 已发），为绑定会话读会话文件尾部、投影 `custom_message`、找新增 `subagent:xs` 条目。

- **缺点**：`history.ts` 的尾读目前被 `st.delivered !== undefined`（有无浏览器在观看）门控，Feishu-only 会话从不读尾；需让飞书服务独立复刻 leaf 跟踪 + 文件读 + `messageKey` 去重（`history.ts`/`keys.ts` 那套），复杂度高、且会话文件可能未落盘/不可读。
- **优点**：无协议变化（status 帧已带 leafId）。

### 格式与安全先例

- 卡片/文本格式：`renderNotice`（纯文本 `【label】` 前缀，20KB 上限）最合适；若要结构化可复用 `simpleCard`（`service.ts` 里 `loginApprovalCard` 同款）。
- **不可信输入**：跨会话 `from.ref`/`name`/`cwd` 均为 self-reported（`format.ts` 头注释明说「不可信输入」），`alias` 才是 hub 核验的；正文任意。展示必须走 `sanitizeText` + `neutralizeMarkdown`（`render.ts`），label 用 `markupSafeLabel` 截断；正文按 `FEISHU_NOTIFY_LIMITS.doneMaxChars`(1500) 或更短截断。
- **隐私/越权注意**：跨会话消息经 xs 发送方 → 接收会话 → 飞书，等于把另一会话的内容泄露到飞书聊天；且接收会话绑定的群成员也能看到（`allowGroups` 已接受群内可见）。建议默认关、且群聊（group）默认不镜像（或沿用 group @ 发送者逻辑）。

---

## 5. 现有开关 + 建议新增开关

现有 `feishuBot.*`（顶层块，非 live，`protocol/feishu.ts:FEISHU_BOT_DEFAULTS` + `settings.ts:1190-1203` 镜像）：

```
enabled:false, allowGroups:true, groupRootTopics:false, securityAlerts:true,
notify:"bound", spawnScope:"known", debounceMs:1500, staleMessageS:300,
files:{outbound:"auto", inbound:true, maxInboundMiB:30}
```

`notify` 只有 `"bound"|"off"`（`FEISHU_NOTIFY_MODES`，`FEISHU_BOT_DEFAULTS.notify="bound"`）。plan v2 已明确砍掉 `notify:"all"`（R1 #21），所以不建议往 `notify` 塞第三态。

**建议新增**：`feishuBot.xsMirror`（boolean，**默认 false**），语义「把送达本会话的 quiet 跨会话消息（deliver-only / 广播 / 迟到回复 / reply 超时通知）镜像到绑定飞书」。需同步改 3 处 + 1 处 spec：

- `src/web-hub/protocol/feishu.ts`：`FEISHU_BOT_DEFAULTS` + `FeishuBotHubConfig` + `normalizeFeishuBotHubConfig`；
- `src/config/settings.ts`：`DEFAULT_FEISHU_BOT_SETTINGS` + `FeishuBotSettings` + `parseFeishuBotBlock`；
- `src/config/setting-specs.ts:1162-1218`：新增 TUI 可编辑 leaf；
- 若走方案 A，还需 `protocol/messages.ts` 新增帧类型 + hub `hello_ack.caps` 增 cap。

默认 false 的理由：跨会话消息是不可信输入、跨会话泄露到飞书聊天是敏感面，必须 opt-in。

---

## 需要用户拍板的取舍点

1. **开关形态**：独立布尔 `feishuBot.xsMirror`（默认 off）还是复用/扩展 `feishuBot.notify`（`bound|off|xs` 之类）？推荐独立布尔。
2. **范围**：只镜像「deliver-only 的 `subagent:xs`」，还是连 NoticeGate 的 `subagent:xs-reply`（超时/失效通知）也镜像？后者 content 无 `from=` 头部、需单独文案。
3. **群聊**：group 绑定的会话是否也镜像（群成员可见，泄露面更大）？建议 v1 仅 p2p，群聊默认不镜像（或沿用 @ 发送者）。
4. **方案 A vs B**：agent 侧新帧（要新 cap，改动面小、数据干净）vs hub 侧重读文件尾（无协议变化，但要复刻 leaf 跟踪/去重，复杂度高）。推荐 A。
5. **正文长度/格式**：纯文本 `renderNotice` 截断（1500 字？更短？）vs 结构化卡片（带 from/alias/来源标注）。

---

### 关键证据文件索引

- 飞书镜像入口/路由：`src/web-hub/hub/feishu/service.ts:1518-1540`、`runs.ts:182-199`、`notify.ts:66-84`、`dialogs.ts`
- 绑定/查找：`state.ts`(`FeishuBinding`)、`sessions.ts:17-19`、`notify.ts:83`
- 出站/限流：`outbox.ts`、`security.ts:createNoticeBudget`、`protocol/feishu.ts:FEISHU_REPLY_LIMITS`
- 转义先例：`render.ts`(`sanitizeText`/`neutralizeTags`/`neutralizeMarkdown`/`renderNotice`)
- quiet 写出路径：`receiver.ts:468-482`、`reply-notice.ts:249-263`、`stack.ts:1780-1784,1893,2391-2398`、`core/types.ts:1564`
- hub 不可见性（核心）：`docs/dev/web-hub/arch.md:294`（K7④）、`history.ts:340-380`、`agent/index.ts:938`、`protocol/keys.ts:158-167`（details 不投影）
- 内容可解析性：`format.ts:formatXsMessage`、`ui/src/logic/xsMessage.ts:parseXsMessage`
- 设置：`protocol/feishu.ts:FEISHU_BOT_DEFAULTS`、`settings.ts:1190-1203`、`setting-specs.ts:1162-1218`

如需我补「把这份产出真正写入 `docs/dev/feishu-xs-mirror/explore.md`」或就方案 A 画更细的改动清单（含帧 schema、cap 名、`FeishuServiceEvent` 分支、新旧兼容测试锚点），请切到可写会话再告诉我。
