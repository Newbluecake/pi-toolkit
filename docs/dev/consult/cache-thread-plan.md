# consult 缓存锚点 + 请教线程 + 冷热展示 + 专家保活：实施方案 v2

> 状态：**v2**（2026-10-18）。v1 经 gpt-6.1-sol 评审（r_9KBWBHXZ：REVISE，2 Blocker + 16 Major + 2 Minor），主会话裁定 20 项全部采纳；逐项处置见文末 **§R1**。
> 前置文档：`plan.md`（consult 本体）、`expert-keepalive-plan.md` v3.1（C2 preserve、前缀探针、守卫）。本方案 §6 取代其 §11。
> 用户裁定（文末原文保留）：保活默认**开**；加 `fresh`；追问预检保守按冷写；冷热状态必须对人可见。

## 0. 结论先行与分期

1. **诊断属实**（§1）。pi-ai 对 Anthropic 只在 system、最后一个工具、最后一条 user 消息的最后一块上打断点。consult 首请求写下的条目是「历史 + Q1」，不是「历史 + Q2」的前缀。下一次 consult 只能读到 system/tools 那一档（64,186 tok），其余约 208k 重写。
2. **分期（降低风险）**：
   - **Phase 1** = P0 实测 + (a) 锚点 + (b) 线程 + 冷热展示 + 分析脚本；
   - **Phase 2** = (c) 保活。Phase 2 上线时 `consult.keepalive.enabled` 默认开（用户裁定），但它只在 Phase 1 的锚点被 P0 证实、且已在生产里跑出 `cacheResult` 数据之后才开工。
3. **P0 是硬闸门**（§2）：
   - 中转线路不认 assistant 块上的锚点（矩阵 M2 不过）⇒ (a) 与 (c) **整体停止**，不走 relocated 兜底。
   - 这时 (b) 线程照样有价值：线程第 2 问 = 历史 + Q1 + A1 + Q2。第 1 问在 Q1 末尾写过条目，回看只跨过 A1 的 2–3 个块，所以**同一线程里的续问不依赖锚点也能命中**；专家也能看到自己的完整回答。
   - 跨提问方的复用、超过 5 min 的复用会失去。
4. **(a) 锚点**（§3）：只在 consult run 里，于「专家原始历史末尾的可缓存块」上加断点。
   - 锚点的身份（块哈希 + 前缀哈希）由宿主侧可信坐标确定并逐请求复核。
   - TTL 沿用本请求已有断点的值。
   - 比较器按 `added / relocated / skipped` 三种状态分别冻结规则。
   - OAuth 4 断点线路的降级如实标为 `degraded`，不承诺命中基线。
   - 普通 run 字节不变。
5. **(b) 线程**（§4）：键 = (askerRunId, expertRunId)。
   - 只有确认已 dispose 的 fork 才能成为线程头。
   - 有 close/epoch 栅栏。
   - tool result 首行如实告诉模型：上一轮问答是否保留，或是 reset / branch / fresh。
   - 源文件大小先检查，字节预算把正在复制的也算进去。
   - 软 TTL、惰性回收如实披露。
6. **冷热展示**（§5）：每个 consult run 自己的 diag 上记开始时的预判（`warm / cold / unknown`，绑定路线 + TTL + 锚前缀身份，证据不足一律 `unknown`）和首响应后的 `cacheResult`（与执行结局 `outcome` 分开，阈值冻结，带 metric 版本）；TUI 树、web 树、`get_subagent_result`、consult 记录页都显示，由独立 UI 包负责。
7. **(c) 保活**（§6，Phase 2）：触发 = 被请教过 + 仍有存活白名单提问方；独立捕获通道（不依赖 `cacheTtl.childKeepalive`，缺失原因可见）；续命时刻 = 真实请求开始时刻且由其响应证实，不 ping 未证实或过期的捕获；鉴权只走权威 auth 链按槽位模板重建，做不到即拒绝该路线；付费 ping 恰好结算一次；费用记到提问方，经 `ports.ts` 窄端口投递「只记账」reducer 输入（不碰 phase/心跳/deadline）。
8. **节省（已修正，§3.5/§6.2）**：后续请教只有约 208k（不是 272k）从写变读。opus-5-5 单次省约 $1.00，15 min 保活窗口的盈亏平衡概率约 **16%**。

## 1. 现状事实

| 事实                                                                                                                                                                                                                               | 出处                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 断点：system（非 OAuth 1 个；OAuth 身份块 + system 共 2 个）、最后一个工具、最后一条 user/system 消息的最后一个 text/image/tool_result/tool_addition/tool_removal 块；ttl：`long`+支持 ⇒ `"1h"`，否则省略（5m）；`none` ⇒ 不打断点 | `pi-ai/dist/api/anthropic-messages.js:22-41,926-951,1214-1240,1323`（pi-ai 1.2.0）                                                 |
| 断点总数：非 OAuth 3 个；**OAuth 4 个（已到上限）**                                                                                                                                                                                | 同上推出                                                                                                                           |
| `onPayload` 链 = 扩展 `before_provider_request`；驱动在 `createAgentSession` 之后套只读探针                                                                                                                                        | `pi-coding-agent/dist/core/sdk.js:224-229,274`；`src/consult/prefix-probe.ts:319-357`；`src/runtime/session-driver.ts:836,859,893` |
| 请求头只在子会话扩展的 `before_provider_headers` 里可见                                                                                                                                                                            | `sdk.js:204-209`                                                                                                                   |
| pi 原生 CacheWarmer 默认 `"streaming"`：agent settle 即停；`idle` 模式也随会话 dispose 结束                                                                                                                                        | `pi-coding-agent/dist/core/settings-defaults.js:59`；`cache-warmer.js:136-147`                                                     |
| 子会话保活只在 `cacheTtl.keepalive && cacheTtl.childKeepalive` 时注册，`agent_settled` 即 dispose                                                                                                                                  | `src/cache-ttl/child.ts:66-68,190-200`                                                                                             |
| fork 文件在 `notifyReaped` 里删除；该调用发生在 `reaper.disposeLate` 或会话 dispose 之后                                                                                                                                           | `src/runtime/runner.ts:860-865,1164-1165,1202,1225-1232`；`src/consult/index.ts`（`onReaped`）                                     |
| reducer：`session_event` 的 `message_end` 会改 `lastEventAt/lastEventType`（心跳语义）                                                                                                                                             | `src/core/state-machine.ts:899-925`                                                                                                |
| consult 显示标记：`RunDisplayMeta.consultOf` 在 enqueue 时写入 diag（先例）                                                                                                                                                        | `src/core/types.ts:547,1191`；`state-machine.ts:785`                                                                               |
| d2 已落地：`src/web-hub/agent/consult-transcript.ts` 从 diag 重建问答，依赖 prompt 前缀 `READ-ONLY CONSULT MODE\n` 与标记 `\nQuestion:\n`                                                                                          | commit `2287435`                                                                                                                   |
| 价格（$/M，pi 模型注册表）：`cr-anthropic/claude-opus-5-5` 输入 4、输出 20、读 0.2、写 5；`opus-4-8` 5/25/0.5/6.25；`sonnet-5-5` 3/15/0.3/3.75                                                                                     | `~/.pi/agent/models.json`                                                                                                          |

**核实**：F5 那次 $1.40 ≈ 272,683×$5/M + 输出（opus-5-5）。F0 两次都读到 64,186（system+tools，F5 写入），另外约 208k 都重写了。F0 第 2 问得到「我的上下文里没有之前的回答」，因为每次都重新 fork 专家原 session（`tool.ts` ⑤）。

## 2. P0 实测矩阵（硬闸门，#18）

脚本 `scripts/exp/consult-anchor-probe.mjs`，结果写入 `docs/dev/consult/anchor-probe-results.md`。目标路线：`cr-anthropic/claude-opus-5-5`（必测），以及当时实际用作专家的其它 Anthropic 路线。

**隔离与前提**：

- 每个格子用唯一 nonce 打头 system，与任何既有条目隔离。
- 历史 H 的每一段 ≥ 8k tok，远高于各型号的最小可缓存长度（Opus 4.5+ 为 4096）。
- H 由 thinking 开启的真实生成得到（R-gen），带真实 signature，最后一条是 assistant 文本。
- 记 |H| = R-gen 的 `input + cacheRead + cacheWrite`。
- 预算约 $3。

| 格                    | 请求序列（时间）                                                                                                                     | 通过线                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| M1 写锚               | R1 = H + Q1，断点 {system, tools, 锚@H 末块, last@Q1}（t0）                                                                          | HTTP 200 且 `cacheRead + cacheWrite ≥ 0.95×        | H   | `                                                                                  |
| M2 回看读锚（≤20 块） | R2 = H + Q2，只有 pi 默认断点（t0 + 60 s）                                                                                           | `cacheRead ≥ 0.95×                                 | H   | `；对照组（同构但 R1 不带锚，另一个 nonce）的 `cacheRead ≤ sys+tools + 0.05×       | H   | `   |
| M3 回看超 20 块       | R3 = H + 12 对 tool_use/tool_result（> 24 块）+ Q3，只有 last 断点；R3′ 同构但每请求重放锚点                                         | R3 的 `cacheRead ≤ sys+tools + 0.05×               | H   | `（证明窗口确实存在）；R3′ 的 `cacheRead ≥ 0.95×                                   | H   | `   |
| M4 OAuth 4 断点       | 仅当有 OAuth 路线：R4 = relocated（锚，没有 last），断点总数 4；R5 = H + Q5                                                          | R4 HTTP 200 且断点数 = 4；R5 的 `cacheRead ≥ 0.95× | H   | `。没有 OAuth 路线 ⇒ N/A，OAuth 在显示上一律 `degraded`（§3.4）                    |
| M5 thinking/签名      | M1/M2 的 H 带签名 thinking，最后一条 assistant 只含 thinking + 文本                                                                  | 与 M2 相同的通过线；R2 不返回 400                  |
| M6 跨原 TTL 续命      | R1（t0）→ P1 = H + 固定短尾、只有锚断点（t0 + 240 s）→ P2（t0 + 480 s）→ R6 = H + Q6（t0 + 600 s）；对照组：不 ping，同样 t0 + 600 s | P1、P2、R6 的 `cacheRead ≥ 0.95×                   | H   | `；P1/P2 的 `cacheWrite ≤ 短尾 + 64`；对照组 R6c 的 `cacheRead ≤ sys+tools + 0.05× | H   | `   |
| M7 TTL 继承           | 仅当该路线 provider-evidence 证实 1h 落地：R1 全部断点 ttl 1h                                                                        | 成立 ⇒ 允许 1h 继承，否则 N/A                      |

**停止规则**：

- M1/M2/M5 任何一格不过 ⇒ (a) 与 (c) 停止，不做 relocated 兜底；Phase 1 只交付 (b) + 展示（展示里锚点状态恒为 `n/a`，预判多为 `unknown`）。
- M3 R3′ 不过 ⇒ 逐请求重放锚点的规则作废，锚点只在每个 consult 的首请求放置。
- M6 不过 ⇒ (c) 停止。
- M4 N/A 不阻塞，按降级处理。

## 3. (a) 专家历史末尾锚点

### 3.1 接缝

- 新模块 `src/consult/anchor.ts`（pi-free）：`resolveAnchor(payload, spec): AnchorDecision`，以及 `installConsultAnchor(session, spec)`（结构化访问 `session.agent`）。
- 安装点：`session-driver.ts` 的 `resume()`，**仅当 `isConsultForkSpec(spec)`**（C2 守卫分支与 main 分支都算）。时机在 `createAgentSession` 之后、`installPrefixProbe` 之前，采用**内层包装**：`agent.onPayload = (p, m) => original(apply(p), m) ?? applied`。扩展链（Phase 2 的捕获）看到的是已加锚的 payload，外层探针看到的是最终 payload。
- `create()` 与非 fork 的 `resume()` 一行不改（T-A1 钉住引用相等）。

### 3.2 可信坐标与锚点身份（#3）

坐标只来自宿主，绝不从 payload 里的断点位置倒推。`SessionSpec.consultAnchor`（不可序列化，同 `consultGuard`）由 adapter 根据 `SpawnRequest.consultAnchor`（NOT_THREADED）构造：

```ts
interface ConsultAnchorSpec {
  prompt: string; // 本次 consult 追加的 user 消息原文（host 生成）
  base?: AnchorIdentity; // 线程续问：第一次 consult 记录下来的基线身份
}
interface AnchorIdentity {
  k: number; // 专家原始历史在转换后 payload 中的消息数
  block: number; // messages[k-1] 中锚块的下标
  blockType: "text" | "tool_use" | "tool_result" | "image";
  blockHash: string; // sha256(去掉 cache_control 的锚块)
  prefixHash: string; // sha256(messages[0..k-1] 去 cache_control)
  systemHash: string;
  toolsHash: string;
  route: { provider: string; model: string; api: string };
  ttl: string | ""; // 继承到的 ttl
}
```

- **首次 consult 的首请求**：要求最后一条消息是 user，且它唯一的文本块 **=== `prompt`**，此时 k = len − 1。然后在 `messages[k−1]` 里从末尾往前找第一个 `text|tool_use|tool_result|image` 块（跳过 thinking/redacted_thinking），算出身份。任何一步失败 ⇒ `skipped:shape|block`，本 run 不再加锚。
- **同 run 的后续请求**以及**线程续问**：复核 `messages[0..k−1]` 的 prefixHash、锚块的 blockHash、systemHash/toolsHash、route，**全部相等**才放；不等 ⇒ `skipped:identity`，且该 run 不再尝试。
- 身份写进前缀探针记录（`RunPrefixRecord.anchor`），供比较器（§3.3）、显示预判（§5.1）和保活（§6）使用。三方共用这一份可信坐标。

### 3.3 放置与比较规则（按状态分别冻结，#4）

| 状态                | 放置                                                 | consult 一侧允许的消息断点（比较器）                        | ttl 规则                                 |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| `added`             | 加完后总断点数 ≤ 4                                   | 恰好 {(k−1, block)} ∪ {pi 默认的最后 user/tool_result 断点} | 锚点 ttl === 最后断点 ttl === 专家侧 ttl |
| `relocated`         | 会超 4，且是首请求、不是线程续问：把最后断点挪到锚上 | 恰好 {(k−1, block)}，最后一条消息上没有断点                 | 锚点 ttl === 专家侧 ttl                  |
| `skipped:*` / `n/a` | 不放                                                 | 旧规则：只在最后 user/tool_result 上                        | 旧规则                                   |
| 其它任何形状        | —                                                    | `messages = false`                                          | —                                        |

- `n/a` = 非 `anthropic-messages`，或 payload 本来就没有 `cache_control`（`cacheRetention:none`）。
- ttl：值拷贝本请求最后一个消息断点的 `cache_control`，因此不改 system/tools 字节，也不会违反「1h 必须在 5m 前」。只有当该请求本身带 1h，并且 M7 通过时，才会出现 1h。
- `prefix-probe.ts` 的 `compareRecordedPrefix` 与 `preserve-identity.ts` 的 `comparePayloadPrefix` 都改为：**读取记录里的 anchor 状态与坐标，查上表**。两者用同一张夹具表做等价测试（G 包修过的等价性不能丢）。`PROVIDER_PREFIX_FIELDS` 不变。
- 逐请求重放：每个带锚的请求都重新放（读中即续 TTL），以覆盖 M3 那种超过 20 块的情况。若 P0 的 M3′ 不过，改为只在首请求放。

### 3.4 OAuth 4 断点线路（#5）

优先级：pi 自己的 4 个断点（身份块、system、tools、最后消息）不让位，**唯一例外**是全新 consult 的首请求做 relocated。线程续问和后续轮次一律 `skipped:limit`。如实降级：

- 这些请求的基线命中**不承诺**，只能靠回看（≤ 20 块）。
- 预判一律 `unknown`（reason `oauth-limit`）。
- 显示标记带 `degraded`（§5.3）。
- 若 M4 为 N/A，OAuth 线路的 relocated 也标为 `degraded`（未验证）。

### 3.5 节省模型（已修正，#20）

后续请教首请求原本是 64k 读 + 208k 写，加锚后变成 272k 读 + Q 写。真正从写变读的只有那约 208k。

| opus-5-5，P = 272k     | 今天                     | 加 (a) 后（TTL 内）                                     |
| ---------------------- | ------------------------ | ------------------------------------------------------- |
| 第 1 次                | 272k×5 = $1.36           | 不变（多一个断点不增加写入量）                          |
| 第 2 次及以后          | 64k×0.2 + 208k×5 ≈ $1.05 | 272k×0.2 + ≈2k×5 ≈ $0.065                               |
| 单次节省 S             | —                        | 208k×(5 − 0.2) ≈ **$1.00**                              |
| 今天三次（实测 $3.55） | —                        | ≈ $1.40 + 2×($0.065 + 输出约 $0.03) ≈ **$1.59（−55%）** |

## 4. (b) 请教线程

### 4.1 记录与键

`src/consult/threads.ts`，状态放在 `wireConsult` 闭包里。

```ts
interface ConsultThread {
  id: string;
  askerRunId: RunId;
  expertRunId: RunId;
  epoch: string; // = 本 wireConsult 实例 id（#6）
  head?: { file: string; bytes: number; consultRunId: RunId; tokens: number }; // 只放已 seal 的 fork
  candidate?: { file: string; consultRunId: RunId; eligible?: boolean; sealed?: boolean };
  base?: AnchorIdentity; // 首次 consult 的锚身份（§3.2）
  seq: number;
  busy?: RunId;
  lastUsedAt: Millis;
}
```

- 键 = `askerRunId × expertRunId`。asker 经 resume 换了 runId，就是新线程。
- `"main"` 不建线程：main 是活的，在旧 fork 上续问会把过期视图当成现状。

### 4.2 只认已 seal 的 fork（#7）

1. 线程 consult 在 spawn 前调 `retain(fork.path, epoch)`。`onReaped` 对已 retain 的路径**不删**，只标记 `sealed`：`notifyReaped` 在会话 dispose 之后才调用，这就是正面确认。
2. tool 拿到 outcome 后，判断这次 fork 是否有资格当 head：结局 `completed`、文本非空、`guardCounters.terminated !== true`、没有 `[consult-preserve:` 失败、不是分支、没用 `fresh` 以外的 reset。有资格就标 `eligible`。
3. **晋升**发生在 `eligible && sealed` 都满足的那一刻（两件事谁后到都会触发）。新 head 生效后删除旧 head。
4. 不合格的 candidate 在 seal 后删除。
5. 续问只复制 head（单写者），**绝不复制未 seal 的文件**（删掉 v1 的一致性校验兜底）。续问到来时 candidate 还没 seal，就用上一个 head（或原 session），并在结果首行如实说明（§4.5）。

### 4.3 close/epoch 栅栏（#6）

- `threads.close()` 后，一切晋升、retain、续问都失效。
- 所有回调（`onReaped`、tool 在 `waitOutcome` 之后的续体）都带着 retain 时的 epoch。epoch 不符或已 close ⇒ 只删自己那个 consult 目录下的文件，绝不晋升。
- runner 在新栈建好后才 reap 旧 run 时，回调仍由旧闭包处理（已 close ⇒ 删除）。
- `close()` 由 §7 的三条路径触发。

### 4.4 磁盘与回收（#19：如实披露）

- **复制前查大小**：fork 之前 `statSync` 源文件（head 或原 session）。超过 64 MiB ⇒ 不建或不续线程（reset 原因 `size`）。
- **字节预算**：每栈的 head 加上**正在复制中的** fork，合计 ≤ 512 MiB。复制前先预留源文件大小，失败时释放。超预算时先淘汰最久未用的空闲 head，仍不够就 reset（原因 `budget`）。
- **上限**：每栈最多 32 个线程，每线程最多 8 次晋升（之后原因 `seq-cap`）。
- **软 TTL，惰性回收**：空闲 60 min 只在以下时机检查：consult 入口、`dispatchSnapshot` 看到 asker 终态、`close()`。如果期间没有任何事件，head 可能活过 60 min，最长到 asker 终态、栈关闭，或下一次 build 的 24h `sweepForkDir`（崩溃时也靠它）。不新增 timer。

### 4.5 tool result 如实陈述（#8）与 prompt

结果首行固定为下列之一（给模型看的英文）：

- `[consult thread <id> #n — the expert sees your previous n−1 question(s) and its full answers]`
- `[new consult thread — no earlier Q/A with this expert]`
- `[fresh consult (fresh:true) — earlier Q/A in this thread were dropped and will not be retained]`
- `[thread reset (<reason>) — the expert does NOT see your earlier questions]`，reason ∈ `context|cost|size|budget|seq-cap|identity`
- `[previous answer not yet retained — the expert sees up to #m only]`（candidate 还没 seal）
- `[parallel branch — the expert sees thread #m; this answer will NOT be kept for follow-ups]`

截断提示视保留状态而定：

- 会被保留（eligible）：`⚠ answer truncated at N chars; it will be kept in this consult thread once this consult closes — consult again (e.g. "continue from where you were cut off") to get the rest.`
- 不会被保留：`⚠ answer truncated at N chars; this answer is not retained — ask a narrower follow-up.`

`fresh: boolean`（用户裁定加入）：丢弃本线程并删除其 head，从专家原 session 提问，这一次的结果作为新线程的第 1 问。

`buildConsultPrompt({followUp?: n})` 在 R2 头部之后、`\nQuestion:\n` 之前插入一行 `This is follow-up #n in this consult thread; your earlier answers above are complete even if the asker saw them truncated.`。`READ-ONLY CONSULT MODE\n` 前缀与 `\nQuestion:\n` 标记都保持不变（d2 解析依赖它们，有测试钉住）。

### 4.6 成本与上下文守卫

- 上下文预检（75%）用 `head.tokens` 计算，超线 ⇒ reset 原因 `context`。原 session 本身也超线，才走今天的 `context_too_large`。
- 首请求估算（用户裁定）：**保守按冷写**，`head.tokens × max(input, write)`。超过 `maxFirstRequestUsd` 而原 session 不超 ⇒ reset 原因 `cost`。
- 每次 consult 的 `maxTurns/maxCostUsd` 不变。

### 4.7 与守卫 / 只读的交互

- 续问对新 fork 重新 `scanExpertSnapshot`。consult 不改工具声明（preflight #6），快照、R2 清单、shadow 工具原样复用，不新增任何放宽。
- A1 里被拦截的调用留在线程里。`blocked_cap` 不晋升。守卫计数按 run 计。

## 5. 冷热展示（用户补充要求；#15 #16 #17）

### 5.1 请教前预判：证据绑定（#15）

`src/consult/anchor-ledger.ts`（闭包状态）按 **identity key = expertRunId + route + systemHash + toolsHash + prefixHash** 记录 `lastProvenTouchAt`。只有以下两种证据会写入：

- 真实请求：带了已验证身份的锚（`added|relocated`），HTTP 成功，且响应 `cacheRead + cacheWrite ≥ 0.9 × baseLB`，其中 baseLB = 快照 `lastRequestUsage` 的总和（实测下界）；
- Phase 2 的已证实 ping（§6.4）。

时刻一律取**请求开始**时刻。TTL(route) = 5 min；仅当该请求带 1h、M7 通过、且 provider-evidence 的 `write1hEvidence` 为真时才取 1h。安全余量 15 s。

| 预判      | 条件                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warm`    | 同一 identity key 存在，且 `now < lastProvenTouchAt + TTL − 15 s`                                                                                                 |
| `cold`    | 同一 identity key 存在且已过期；**或者**本进程从未对该专家有过被证实的触达、且专家 `settledAt + MAX_TTL(route) < now`                                             |
| `unknown` | 其它一切：非 Anthropic、OAuth 降级、身份未知（首次 consult 在派发时还算不出 prefixHash ⇒ 按快照的 model/systemHash/toolsHash 部分匹配也算 unknown）、没有路线证据 |

披露：其它 pi 进程的触达本进程看不到，所以 `cold` 的含义是「本进程证据下已过期」。

O(1)：预判在 consult 开始时算一次并写进 run 的 diag（§5.3）。widget 与 web 只读 diag，从不调用 ledger 或 keeper。

### 5.2 请教后实测：新字段（#16）

`outcome` 仍是执行结局，不改。新增 `cacheResult`：

```ts
interface ConsultCacheResult {
  v: 1; // metric 版本；分析脚本遇到未知版本就跳过
  readShare: number | null; // 首请求 cacheRead / (cacheRead + cacheWrite + input)
  label: "hit" | "partial" | "miss" | "n/a"; // 冻结阈值见下
  anchor: "added" | "relocated" | "n/a" | `skipped:${string}`;
  degraded?: true; // OAuth 限额 / M4 未验证
}
```

- 阈值冻结：`hit ≥ 0.80`；`0.20 ≤ partial < 0.80`；`miss < 0.20`；分母为 0 或没有首请求 ⇒ `readShare: null`、`label: "n/a"`。
- 参考：今天 F0 那两次 ≈ 0.235（只有 system/tools 命中），记 `partial`；锚点命中 ≈ 0.99，记 `hit`。
- 旧的 `hitRatio`（cacheRead / expertPrefixTokens）保留，用于连续分析。

### 5.3 落在 consult run 自己的 diag 上（#17）

`RunDiagnostics.consultCache?: { v: 1; predicted: { state: "warm"|"cold"|"unknown"; reason?: string }; first?: ConsultCacheResult & { at: Millis } }`。

- `predicted`：经 `RunDisplayMeta.consultCache` 在 enqueue 时**只写一次**（沿用 `consultOf` 的路径，`state-machine.ts:785`）。
- `first`：驱动在 consult run 的首个 assistant `message_end` 配对到用量后，发出新的 `DriverEvent {t:"consult_cache_first", result}`。reducer 只写 `diag.consultCache.first`（write-once），矩阵与属性测试同步。
- 两者都进 journal 白名单（`src/core/run-journal.ts`），终态记录与重建时保留。
- asker 侧的 `diag.consults[].cacheProbes` 同时带 `cacheResult` 与 `thread`（经 `details.cacheProbe`）。

**显示标记**（纯函数 `src/core/consult-cache-marker.ts`，英文 token）：`warm·hit 96%`、`cold·miss`、`?·partial 24%`；首响应前为 `warm·…`；降级时追加 `·degraded`；`n/a` 时为 `?·n/a`；线程时前缀 `t#2 `。

**展示位置（UI 包独占）**：

- TUI 的 `src/ui/fleet-panel.ts`、`src/ui/fleet-widget.ts`（consult 行备注）；
- `src/tools/result-tool.ts`（`get_subagent_result` 的 consult 段：预判、实测、线程、锚点状态）；
- web 侧 `src/web-hub/agent/status.ts` 与 `src/web-hub/protocol/messages.ts`：行上新增可选 `consultCache` 结构 + `cacheMark` 字符串，只追加字段，不升 proto 版本；
- `src/web-hub/ui/src/components/fleet/FleetTree.vue`；
- `src/web-hub/ui/src/components/drawer/RunTranscript.vue`；
- `src/web-hub/agent/consult-transcript.ts`（d2 回退页增加一行「thread / 冷热」）。

## 6. (c) 专家保活（Phase 2，默认开）

### 6.1 §11 闸门对照（`consult-cache-analyze --since 2026-10-11`：10 个带探针的 consult，全部冷，$11.06）

数据量（≥4 周且 ≥30 次）：1 周 10 次，**未满足**；gap ≤4 min 时 hitRatio 中位数 ≥0.6：0 样本，**无法评估**；gap ≤4.25 min 需求 ≥50%：0/10，**未满足**；gap ∈ (4.25m, 45m] ≥30%：5/10，**满足**；净收益 ≥20% 且 ≥$2/周：事后估算约 $4（36%，未计浪费），理论满足。

据此只做**请教后保活**（T1）。派发时预热（T0）不做（A/B 中派了专家的组 0/5 真去请教）。Phase 2 开工前先用 Phase 1 的 `cacheResult` 和 `--follow-gaps` 复核下表。

### 6.2 盈亏平衡（已修正，#20）

ping ≈ P×read，其中 P = 272k；S = 208k×(write − read)；N = ⌈(H − TTL)/interval⌉，TTL = 5 min，interval = 4 min；盈亏平衡概率 p* = N×ping/S。

| 模型       | ping   | S     | ping/S | H=10m (N=2) | **15m (N=3)** | 30m (N=7) |
| ---------- | ------ | ----- | ------ | ----------- | ------------- | --------- |
| opus-5-5   | $0.054 | $1.00 | 5.4%   | 11%         | **16%**       | 38%       |
| opus-4-8   | $0.136 | $1.20 | 11.4%  | 23%         | 34%           | 80%       |
| sonnet-5-5 | $0.082 | $0.72 | 11.4%  | 23%         | 34%           | 80%       |

默认 H = 15 min。opus-4-x 与 sonnet 线路的回本线是 34%，需要用 F 包的 `--follow-gaps` 校准。按路线分别设 H 列为后续优化，不在本方案内。

### 6.3 独立捕获通道（#9）与鉴权（#11）

- 新模块 `src/consult/child-capture.ts`，由 `src/child/wire.ts` 在**子会话**里注册。它有自己的 `before_provider_request` / `before_provider_headers` 配对，**不依赖** `cacheTtl.childKeepalive`，也不依赖子会话保活服务。
- 生效条件：本会话文件路径（realpath）在 `src/consult/anchor-sink.ts` 的注册表里，且 `consult.keepalive.enabled` 为真。注册表是 `Symbol.for`，只存 `{epoch, sink fn}`，以 fork 路径为键，由宿主在 spawn 前注册，close 或 reap 时注销。
- **优先级**：`cacheTtl.keepalive=false` 是全局总闸，keeper 不 ping，记原因 `global-keepalive-off`。`childKeepalive` 不影响 consult 保活。
- **只捕获本 run 的首个带锚请求**。payload 与 headers 都是值拷贝。
- **鉴权模板（不猜名字）**：
  - 子会话侧用同一条权威链 `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` 取得秘密槽位：`apiKey` 与 `auth.headers` 的每个值。
  - 把捕获头里**包含**这些秘密值的部分替换成占位 `{{slot:i}}`，生成头模板；替换后断言任何头、payload 中都不再含秘密子串。
  - 子会话侧鉴权解析失败、模板化后仍残留秘密、或出现无法模板化的鉴权形状 ⇒ 不交付，原因 `auth-template`。
  - ping 时宿主对专家路线的 Model 走同一条链解析，**槽位集合必须完全一致**才渲染模板；否则这条路线不保活（`auth-slot-mismatch`），绝不按头名补齐。
- 捕获缺失时**原因可见**：`no-sink | not-first | no-anchor | headers-missing | auth-template | child-extension-missing`（后者来自既有 `childExtensionMissing` 诊断）。原因写进 keeper 状态、consult 的 `cacheProbes[].warm.reason`，以及 `/agent` 状态行。

### 6.4 keeper 规则冻结（#2 #10）

`src/consult/keepalive.ts`：每个 identity key（§5.1）一个条目，复用 `CacheKeepaliveService` 的定时、重试、熔断、ledger。

- **续命时刻**（#2）：`touchAt` = 某个真实 consult 请求的**开始**时刻。该请求必须带已验证锚点，其响应还须满足 §5.1 的证实条件（首请求是写入，后续请求是 `cacheRead ≥ 0.9×baseLB`）。已证实的 ping 同样以开始时刻更新 `touchAt`。
- **不 ping 的情形**：没有证实、`now ≥ touchAt + TTL − 15 s`、或身份与捕获不一致时一律不 ping，状态记 `dead`。
- **布防**：candidate 的 consult run 已 seal（会话已 dispose），并且捕获已交付、`touchAt` 已证实，才布防。consult 进行中（有 busy 的 run）不 ping。
- **空闲截止**：`idleDeadline = 最后一次真实 consult 的 touchAt + idleMinutes`。下一次 ping 时刻 = `touchAt + interval`，**仅当** `touchAt + TTL < idleDeadline` 时才排。因此每次真实请教之后最多 N = ⌈(H − TTL)/interval⌉ 次 ping，用 `maxPings` 对该窗口硬封顶。
- **原生 warmer**：pi 的 CacheWarmer 随 consult 会话 dispose 结束（默认 streaming 模式在 settle 时就停），在 keeper 布防之前已经结束，所以 keeper 固定传 `nativeWarmerActive:false`。conformance C-K4 钉住「会话 dispose 后 pi 不再发 warm 请求」。
- **服务接缝**：在 `src/service/cache-keepalive.ts` 新增可选 `model?: () => KeepaliveModelInfo` 与 `nativeWarmerActive?: () => boolean`。缺省时字节不变（T-K1 快照测试）。
- **ping 体**：`messages.slice(0, k)`（保留锚断点）+ 固定短尾 user 文本 `(cache keepalive probe — no answer needed)`（不带断点）；system/tools/thinking 等字段原样；`max_tokens` 交给 `preparePingPayload`。服务里的指纹按这份 body 构造。ping 是裸 fetch，收到 `message_start` 即取消，不可能执行工具，也绝不包含提问。
- **停止条件**：空闲截止；owner 进入终态，且没有其它存活 run 的白名单含该专家（有就转给它）；每专家累计 `maxUsdPerExpert`（$0.5）；进程级共用 `getChildKeepaliveLedger()`（$10/24h，4 并发）；服务自带的熔断；`close()`。

### 6.5 恰好一次结算（#12）

- 每个 ping 有 `pingId`。ledger 的 lease 按 token 幂等。费用归集按 `pingId` 幂等（§6.6）。
- **迟到 epoch**：已被新一轮 consult 重新布防的条目，旧 ping 返回时只结算费用（lease settle + 归集一次），不更新窗口，也不改 `touchAt`。
- **dispose**：中止进行中的 fetch。如果请求已离开本进程（已写入 socket），按「可能已计费」用预估额结算一次，并记 telemetry `possiblyBilled`；没离开就撤销预留。
- 结算回调持有发起时捕获的 cost 端口；端口在栈关闭后返回 `closed` ⇒ 记 `unattributedUsd`。不会重复，也不会丢失。

### 6.6 只记账的费用归集（#13 #14）

- 新增 `RunInput` `{ kind: "usage_accrued"; at; usage: UsageDelta; key: string }`。reducer 只改 `diag.usage`（累加）与 `diag.hostUsage = { keepaliveUsd, pings }`，**不改** `lastEventAt/lastEventType/phase/turns/deadline/status`。在任何终态下都是 no-op。
- runner 侧以每 run 有界集合（FIFO 256）对 key 去重。
- 状态机转移矩阵加一行（新输入 × 全部状态），属性测试加不变量「`usage_accrued` 只改 usage/hostUsage 两个字段」。
- **窄端口**：
  - `src/service/ports.ts` 的 `Runner` 接口新增 `accrueHostUsage(runId, usage, key): "folded" | "duplicate" | "terminal" | "unknown"`；
  - `src/runtime/runner.ts` 实现，以当前 generation 走 `dispatchExternal`；
  - `src/service/runtime-adapter.ts` 透传；
  - `src/stack.ts` 构造 `ConsultCostPort { accrue }` 注入 `wireConsult`；
  - keeper 只能看到这个端口。
- 归属：**提问方（owner）**。专家已是终态，往它的记录上加 usage 会改动已 settle 的数据；提问方是受益者，保活期间也一定存活。

### 6.7 诊断与 telemetry

- `cacheProbes[].warm = { state, reason?, pingsSince, pingUsdSince }`。
- `~/.pi/agent/telemetry/consult-keepalive.jsonl`（0600，只追加，2 MiB 轮转）：每次 ping 一行 `{ts, pingId, expertRunId, ownerRunId, route, outcome, cacheRead, cacheWrite, usd, settled: "folded"|"unattributed"|"possiblyBilled"}`。不含路径，不含 payload。
- `"main"` 不保活；非 Anthropic 线路不保活（服务 gate #5）。

## 7. 生命周期与 /reload（#1）

- `ConsultWiring.close()` 依次关闭 threads（删除全部 head 与已 seal 的 candidate）、anchor-ledger、keeper（Phase 2），并注销 sink。幂等。
- 三条触发路径，`src/index.ts` 与 `src/stack.ts` 都在本方案文件域内：
  ① `pi.on("session_shutdown")`：pi 的 `/reload` 会先发 reason `reload` 的 shutdown；
  ② `session_start` 开头的防御性清理：照 `index.ts:855-860` 那串 `holder.current.*?.dispose()` 再加一条 `holder.current.consult.close()`；
  ③ 同一模块内的栈重建：`buildSessionStack` 处理上一个栈时调用。
- 测试 `tests/integration/consult-reload-dispose.test.ts`：用真实 jiti 加载扩展 → 建 head、ledger 条目（Phase 2 还有 keeper）→ 触发 `session_shutdown(reload)` → 用新的 jiti 实例重新 import 并 `activate()`，模拟同进程、不清模块缓存的 `/reload` → 断言 head 文件已删、sink 注册表为空、旧闭包里迟到的 `onReaped` 只删不晋升、旧 keeper 不再 ping（假时钟推进 10 min，桩收到 0 次请求）。

## 8. 不变量

普通 run 字节不变（锚点只装在 `isConsultForkSpec`，服务接缝缺省等价：T-A1/T-K1/C14）；C2 内容逐字节一致（只加/移动消息断点标记，比较器按状态表，两处等价：C1）；只认已 seal 的 fork；零挂死（无新 await 依赖，新 timer 只有服务内已有的 unref timer）；鉴权不出子会话（模板+槽位，不符即拒）；记账不改运行语义（`usage_accrued` 只改两字段）；无模块级可变状态（闭包状态；sink 注册表只存带 epoch 的函数，`close()` 注销）。

## 9. 与 d2 的交互

- d2 已以 diag 为准（`consult-transcript.ts`）。
- 线程晋升会删除旧 head，consult-1 的 `diag.sessionFile` 会失效，内容此后只在后一次 consult 的文件里。d2 必须按 `diag.consultCache` 与 asker 的 `cacheProbes[].thread.{id,seq}` 分组，绝不假定文件存在，也不读线程头去重建历史（前面一大段是专家原 session）。
- 新增的 follow-up 行放在 `\nQuestion:\n` 之前，不破坏 d2 的解析（测试钉住）。

## 10. 分包与文件域

> 热文件（同一时刻只允许一个包持有）：`src/core/types.ts`、`src/core/state-machine.ts`、`src/service/request-threading.ts`、`src/service/ports.ts`、`src/runtime/session-driver.ts`、`src/runtime/runner.ts`、`src/service/runtime-adapter.ts`、`src/stack.ts`、`src/index.ts`、`src/config/settings.ts`。
> 开工闸门沿用 v3.1 §7：冻结面文件干净，且与 `origin/master` 一致。

**Phase 1**

| 包                            | 内容                                                                                                                                                                                                                                                                                                      | 文件域（独占）                                                                                                                                                                                                                                                                                                                                                             | 依赖                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| P0（L1）                      | §2 矩阵                                                                                                                                                                                                                                                                                                   | 新 `scripts/exp/consult-anchor-probe.mjs`、`docs/dev/consult/anchor-probe-results.md`                                                                                                                                                                                                                                                                                      | —                                    |
| A（L2，热）                   | `SessionSpec.consultAnchor`、`SpawnRequest.consultAnchor`（NOT_THREADED）、`AnchorIdentity`、`RunDisplayMeta/RunDiagnostics.consultCache`、`DriverEvent consult_cache_first`、`ConsultCacheProbe.{anchor,thread,cacheResult,warm}`；reducer 的 enqueue 写入与 first 写入，含矩阵/属性测试；journal 白名单 | `src/core/types.ts`、`src/core/state-machine.ts`、`src/core/consult-summary.ts`、`src/core/run-journal.ts`、`src/service/request-threading.ts` + 对应测试                                                                                                                                                                                                                  | P0 通过（M2 失败则去掉锚点相关字段） |
| B（L3）锚点                   | §3                                                                                                                                                                                                                                                                                                        | 新 `src/consult/anchor.ts`；`src/runtime/session-driver.ts`（安装与发出 `consult_cache_first`）；`src/consult/prefix-probe.ts`、`src/consult/preserve-identity.ts`；`src/service/runtime-adapter.ts`（透传）；测试 `tests/consult/{anchor,prefix-probe,preserve-identity}.test.ts`、`tests/runtime/session-driver-consult-anchor.test.ts`                                  | A                                    |
| C（L3）线程 + 预判 + 生命周期 | §4、§5.1、§7                                                                                                                                                                                                                                                                                              | 新 `src/consult/threads.ts`、`src/consult/anchor-ledger.ts`；`src/consult/{tool,index,prompt,fork-store}.ts`；`src/stack.ts`、`src/index.ts`（`close()` 三条路径）；测试 `tests/consult/{threads,anchor-ledger,consult-tool,prompt,fork-store}.test.ts`、`tests/integration/consult-reload-dispose.test.ts`                                                                | A；与 B 并行（共享的只有类型）       |
| U（L2）展示                   | §5.3                                                                                                                                                                                                                                                                                                      | 新 `src/core/consult-cache-marker.ts`；`src/ui/fleet-panel.ts`、`src/ui/fleet-widget.ts`、`src/tools/result-tool.ts`、`src/web-hub/agent/status.ts`、`src/web-hub/protocol/messages.ts`、`src/web-hub/ui/src/components/fleet/FleetTree.vue`、`src/web-hub/ui/src/components/drawer/RunTranscript.vue`、`src/web-hub/agent/consult-transcript.ts` + 测试（含 `check:web`） | A                                    |
| F（L1）分析                   | `cacheResult`（v1）、warm/cold 分组、线程分组、`--follow-gaps`                                                                                                                                                                                                                                            | `scripts/exp/consult-cache-{lib,analyze}.mjs`、`tests/exp/consult-cache-analyze.test.ts`、fixtures                                                                                                                                                                                                                                                                         | A                                    |
| E1（L3）                      | §11 的 C1、C11–C12、C14                                                                                                                                                                                                                                                                                   | `tests/conformance/consult-preserve.test.ts`、`tests/conformance/fixtures/anthropic-stub.ts`                                                                                                                                                                                                                                                                               | B、C                                 |

**Phase 2**（Phase 1 合并且有 ≥ 1 周 `cacheResult` 数据后开工）

| 包                    | 内容                                                                                                                                                                | 文件域（独占）                                                                                                                                                                                                                                                                                                 | 依赖       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A2（L2，热）          | `RunInput usage_accrued`、`diag.hostUsage`，含矩阵/属性测试；`Runner.accrueHostUsage`；设置 `consult.keepalive.{enabled:true, idleMinutes:15, maxUsdPerExpert:0.5}` | `src/core/types.ts`、`src/core/state-machine.ts`、`src/service/ports.ts`、`src/config/settings.ts`、`src/config/setting-specs.ts` + 测试                                                                                                                                                                       | Phase 1    |
| K1（L3）捕获          | §6.3                                                                                                                                                                | 新 `src/consult/child-capture.ts`、`src/consult/anchor-sink.ts`；`src/child/wire.ts`；测试 `tests/consult/child-capture.test.ts`（鉴权模板真值表）                                                                                                                                                             | A2         |
| K2（L3）keeper + 端口 | §6.4–§6.7                                                                                                                                                           | 新 `src/consult/keepalive.ts`、`src/consult/keepalive-telemetry.ts`；`src/service/cache-keepalive.ts`（两个接缝）；`src/runtime/runner.ts`；`src/service/runtime-adapter.ts`；`src/stack.ts`；`src/consult/index.ts`；测试 `tests/consult/keepalive.test.ts`、`tests/runtime/runner-accrue-host-usage.test.ts` | A2、K1     |
| E2（L3）              | C13、C-K1..K4                                                                                                                                                       | conformance 两个文件（在 E1 之后持有）                                                                                                                                                                                                                                                                         | K2         |
| G（L0）               | AGENTS.md 的 `src/consult/` 段；`expert-keepalive-plan.md` §11 加「已被本方案 §6 取代」                                                                             | 文档                                                                                                                                                                                                                                                                                                           | 各阶段收尾 |

## 11. 测试计划

**单元**

- B：`resolveAnchor` 真值表，覆盖 api / 无断点 / prompt 不等 / thinking 末块 / 3→4 / 4→relocated（首请求）/ 4→skipped（续问或后续轮）/ ttl 复制 / 身份复核失败；比较器状态表，两个实现用同一夹具；T-A1。
- C：retain→eligible/sealed 两种到达顺序的晋升矩阵；epoch 不符与 close 后的回调；复制前大小检查；字节预算含在途；软 TTL 的三个检查点；6 种结果首行与 2 种截断提示的 golden；`fresh`；main 不建线程；follow-up 行不破坏 d2 解析；预判三态真值表，含 OAuth、无证据、跨 route、TTL 边界 ±15 s。
- U：marker 纯函数的 golden（含 `degraded`、`…`、`n/a`、`t#n`）；TUI 行与 web 行的投影；`get_subagent_result` 的 consult 段。
- A/A2：矩阵新行；`consult_cache_first` 只写一次；`usage_accrued` 属性不变量；journal 往返。
- K1：鉴权模板真值表，覆盖 x-api-key / Bearer / 自定义 auth.headers / 残留秘密 / 槽位不符 / 解析失败，以及注册表只存函数。
- K2：§6.4 每条规则一个用例（布防前置、touchAt 只取证实请求、过期不 ping、N 封顶、owner 转移、全局总闸）；§6.5 迟到 epoch 与 dispose 中途的结算；T-K1。

**conformance（真实 pi + 本地 Anthropic 桩；升级 pi 前必跑）**

- C1 更新：按 §3.3 状态表断言首请求断点；其余字段规则不变；探针哈希等于原始 body 现算的哈希。
- C11 OAuth：apiKey 以 `sk-ant-oat` 开头 ⇒ 首请求 relocated、断点数 = 4；续问 `skipped:limit`，展示 `degraded`。
- C12 线程：第 2 问的 messages = 第 1 问 messages + A1 + Q2；完整 A1 超过 `maxAnswerChars` 时仍在；只有 seal 后才晋升；consult-1 的 fork 在晋升 consult-2 时删除。
- C13 ping（Phase 2）：body = 首请求 `messages[0..k−1]` + 短尾；system/tools 逐字节相同；不含问题；鉴权头由宿主经模板重建；之后没有工具回路；owner settle 后不再 ping；费用进 owner 的 `diag.usage`，**不改** owner 的 `lastEventAt`。
- C14 普通 run：断点与改动前逐字节一致。
- C-K1 `childKeepalive=false` 时捕获照样工作；C-K2 `cacheTtl.keepalive=false` 时 0 次 ping 且原因可见；C-K3 鉴权槽位不符时 0 次 ping；C-K4 consult 会话 dispose 后 pi 原生 warmer 不再发请求。
- 收口：`npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web && npm run check:web`，再跑 `npm run test:conformance`。

## 12. 风险

- R1 中转线路对 assistant 块断点 / thinking 剥离的行为不同 ⇒ P0 硬闸门，不过即停；`cacheResult` 持续观察。
- R2 回看 20 块窗口 ⇒ 逐请求重放（M3 验证）；OAuth 如实降级。
- R3 线程头占磁盘、软 TTL 下可能活过 60 min ⇒ 64 MiB / 512 MiB 含在途 / 32 个上限，三个惰性检查点 + 24h sweep（§4.4 已披露）。
- R4 保活浪费 ⇒ T1 + 15 min + $0.5/专家 + 共用 $10/24h；Phase 2 开工前复核 `--follow-gaps`。
- R5 未覆盖的鉴权形状 ⇒ 拒绝保活、原因可见，永不猜。R6 跨进程触达不可见 ⇒ `cold` 语义写明「本进程证据下」。R7 pi 升级改断点规则 ⇒ C1/C11/C14 钉住。

## 13. 需用户确认

无新问题（v1 三问已裁定，见下）。

## 用户裁定（2026-10-18）

方向确认（评审后开工，先做 P0 实测）。§10 三问：`consult.keepalive.enabled` **默认开**；consult 工具**加**可选 `fresh: boolean`；追问前成本预检**保守按冷写入**估算，待有数据再放宽。

**用户补充（2026-10-18）：被咨询专家的冷热状态要对人可见。** 每次 consult 记两样并展示出来：

1. **请教前预判**：`warm` / `cold` / `unknown`（来源：keeper 状态 + `cache-ttl/warmth.ts` 的 `provenCacheReadAt()`；无证据一律 `unknown`，不猜），在请教开始时就写入 run 记录；
2. **请教后实测**：首请求 `hitRatio`（`cacheRead / (cacheRead + cacheWrite + input)`），据此标 `hit` / `partial` / `miss`。

展示位置：agent 树（TUI fleet widget + web FleetTree）里 consult 行的备注、`get_subagent_result` 的 consult 段、web consult 记录页（含 d2 的回退问答页）。紧凑标记一律英文 token（如 `warm·hit 96%`、`cold·miss`、`?·partial 24%`），按 AGENTS.md 的 UI 文案分工。字段放在已规划的 `ConsultCacheProbe.warm` / 新增 `ConsultCacheProbe.outcome` 上，不另开存储；为此改动的展示文件计入相应 UI 包的文件域。

> v2 落实注（不改上面的裁定原文）：
>
> - 预判的证据源在 Phase 1 是 `anchor-ledger`（与 keeper 共用同一份 identity key），Phase 2 再叠加 keeper；`cache-ttl/warmth.ts` 只服务主会话，不复用（R1#15）。
> - 实测比值取名 `readShare`，以免与旧的 `hitRatio` 混淆。
> - 字段名按 R1#16 定为 `cacheResult`，`outcome` 保持为执行结局。
> - 同一份数据还写在 consult run 自己的 `diag.consultCache` 上（R1#17）。语义不变。

## §R1 处置表（r_9KBWBHXZ，20 项全部采纳）

| #   | 级别    | 问题要点                                              | 处置                                                                                                                                  | 落点            |
| --- | ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | Blocker | 栈与 `/reload` 时线程、keeper、sink 没有 dispose      | `ConsultWiring.close()` 三条路径（session_shutdown、session_start 防御、同模块重建），`src/index.ts` 纳入文件域；真实 jiti 换模块测试 | §7、§10 C       |
| 2   | Blocker | keeper 续命时刻不可靠，可能 ping 未证实或已过期的捕获 | `touchAt` = 真实请求的开始时刻，并由其响应证实；未证实或过期一律不 ping，记 `dead`                                                    | §6.4、§5.1      |
| 3   | Major   | 锚点只靠裸消息下标                                    | `AnchorIdentity`（块哈希 + 前缀哈希 + system/tools + route），宿主可信坐标，逐请求复核                                                | §3.2            |
| 4   | Major   | 比较器放宽规则含糊                                    | `added/relocated/skipped` 三种状态分别冻结，比较器读记录里的可信坐标；两处同夹具等价                                                  | §3.3            |
| 5   | Major   | OAuth 4 断点下的承诺不诚实                            | 优先级明确；续问与后续轮次 `skipped:limit`；预判 `unknown`，展示 `degraded`；不承诺基线命中                                           | §3.4、§5.2      |
| 6   | Major   | 线程缺 close/epoch 栅栏                               | epoch + closed；迟到回调只删不晋升                                                                                                    | §4.3            |
| 7   | Major   | 未 seal 的 fork 可能被采纳或复制                      | 晋升 = eligible ∧ sealed（dispose 后的 `notifyReaped` 作为正面确认）；删除未 seal 复制兜底                                            | §4.2            |
| 8   | Major   | 模型不知道上一轮是否保留                              | 6 种固定结果首行 + 2 种截断提示，如实说明 reset/branch/fresh/未 seal                                                                  | §4.5            |
| 9   | Major   | 捕获依赖 childKeepalive 开关                          | 独立的 `child-capture.ts`；明确优先级（只认全局总闸）；缺失原因可见                                                                   | §6.3            |
| 10  | Major   | keeper 布防、空闲、次数、原生 warmer 规则未冻结       | 全部冻结：布防前置、idleDeadline、N 公式与封顶、`nativeWarmerActive:false` 及其测试                                                   | §6.4、C-K4      |
| 11  | Major   | 按头名剥离和补齐鉴权属于猜测                          | 权威 auth 链 + 槽位模板；残留或槽位不符 ⇒ 拒绝在该路线保活                                                                            | §6.3、C-K3      |
| 12  | Major   | 付费 ping 的结算可能重复或遗漏                        | `pingId` 幂等；迟到 epoch 只结算；dispose 按 possiblyBilled 结算一次；`unattributed` 兜底                                             | §6.5            |
| 13  | Major   | 复用 message_end 会改心跳                             | 新增只记账输入 `usage_accrued`，只改两个字段；矩阵与属性测试                                                                          | §6.6、A2        |
| 14  | Major   | 费用端口文件域不闭合                                  | `ports.ts` → runner → runtime-adapter → stack → wireConsult，窄端口                                                                   | §6.6、§10 A2/K2 |
| 15  | Major   | warmth 证据没有绑定                                   | 绑定 route + TTL + 锚前缀身份；其余一律 `unknown`；diag 内 O(1)                                                                       | §5.1            |
| 16  | Major   | `outcome` 被挪作缓存结论                              | 新字段 `cacheResult`（v1），冻结阈值与零分母规则                                                                                      | §5.2            |
| 17  | Major   | 展示数据位置与 UI 文件域缺失                          | consult run 自己 diag 上的 `consultCache`（开始时与首响应时各写一次）；独立 U 包独占 8 个展示文件                                     | §5.3、§10 U     |
| 18  | Major   | P0 不可判定                                           | 逐请求矩阵 M1–M7 + 数值通过线 + 对照组；M2 不过 ⇒ 锚点停止，不做 relocated 兜底                                                       | §2、§0-3        |
| 19  | Minor   | 软 TTL / 磁盘上限需披露                               | 惰性回收如实披露；复制前查大小；512 MiB 预算含在途                                                                                    | §4.4            |
| 20  | Minor   | 节省数学错误                                          | 只有约 208k 从写变读：单次约 $1.00；15 min 盈亏线约 16%                                                                               | §3.5、§6.2      |

## §R2 主会话收口（第二轮评审 r_WGDCGPAN：10 项 closed、9 项 partially、1 项 open；不再开第三轮）

以下裁定**覆盖**正文中与之冲突的表述，实现以本节为准。

- **R2-1（#7 seal 证明，Phase 1）**：`RunnerDeps.onReaped` 回调增加 `{ disposed: boolean }`（reaper 返回 `disposed:false` 或 reap rejection ⇒ `false`），现有调用方忽略该字段即可；只有 `disposed:true` 才能把 candidate 视为 sealed、晋升为 head 或启动 keeper。`runner.ts` 的这处小改动划入线程包文件域，状态机文件不动。
- **R2-2（#6 单线程栅栏，Phase 1）**：每个线程记录带 `gen`；asker 终态、FIFO 淘汰、reset、`fresh` 都让 `gen+1` 并标记 closed；candidate 在开始时记下 `gen`，晋升要求 `candidate.gen === thread.gen && !closed`，否则只删文件、不复活线程。补 asker abort / dispose / 淘汰 / 成功结果交错的测试。
- **R2-3（#19 磁盘预算，Phase 1）**：预算计入**所有**自有 candidate（含仍在追加的），seal/晋升前按实际大小重新核算，超限不采纳（删文件，`fallback:"size"`）。
- **R2-4（#17 线程关联，Phase 1）**：派发时把 `{ threadId, seq }` 写进 **consult run 自己的 diag**（`consultThread`），UI 分组和 `t#2` 标记只读这一字段；补「同专家并发」和 asker 环淘汰后的展示测试。
- **R2-5（#18 conformance，Phase 1）**：C1、C11–C14 必须经过生产安装链（SpawnService → consult 工具 → fork-store → 线程注册表 → 费用端口）；手工构造只允许作为额外的 raw-body / hash 断言，不能替代生产链验收。
- **R2-6（#2 触达时间接缝，Phase 2）**：keepalive-state 的 `noteRequest` 增加可选 `touchedAt`，窗口按 `touchedAt + ttl` 计算；`touchedAt + ttl − 安全余量 ≤ now` 时不 arm。测试延迟交付的捕获不得延长 TTL。`keepalive-state.ts` 划入 D 包。
- **R2-7（#9 捕获缺失，Phase 2）**：consult 子会话注册捕获 hook 时登记到按 consult runId 索引的进程内表；首请求结束仍无捕获 ⇒ consult diag 记 `keepalive:"capture-missing"`，该 consult 不保活。consult 对 child-extension-missing 诊断的既有豁免不变，但这条原因单独可见。
- **R2-8（#10 arming 与 reset）**：keeper 仅在「该专家已被请教过」且「存活 asker 数 > 0」时 armed；并发请求用 in-flight 请求 id 集合计数，不用布尔量。`/cache-ttl keepalive reset` 通过注册表端口扇出到所有 consult keeper；命令文件划入 D 包并补测试。
- **R2-9（#11 鉴权，Phase 2）**：ping 的请求头改为**白名单**：只保留捕获到的非秘密头（`anthropic-version`、`anthropic-beta`、`content-type`），其余一律丢弃；凭据头在 ping 时经 pi 鉴权链**现取**（5 s 超时、可取消、失败即关闭）。旧秘密从不保存，轮换后自然用新秘密。路线需要白名单以外的自定义头 ⇒ 该路线不保活，原因可见（`keepalive:"route-headers"`）。
- **R2-10（#12 结算，Phase 2）**：调用 `fetch()` 即视为 issued；已 issued 但用量未知的 ping 按保守估算计费（缓存 token × 读价 + 少量输出），按 ping id 在用量到达时**恰好一次**以实际值替换估算。窗口更新与结算解耦：旧 epoch / dispose 后到达的用量照样结算；dispose 最多等在途 ping 2 s，其余按估算结清。D 包文件域明列 `cache-keepalive.ts` 中这些结算改动。

Phase 1 的开工顺序：P0 实测（用户无需操作，主会话派单执行，花费上限 $5）→ A 冻结面 → 线程 / 锚点 / UI 各包。
