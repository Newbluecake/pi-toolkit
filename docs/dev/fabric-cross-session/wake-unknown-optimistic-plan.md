# 方案 r2：capability `unknown` 时乐观唤醒 + 首轮校验（wake-unknown-optimistic）

> 落盘：`docs/dev/fabric-cross-session/wake-unknown-optimistic-plan.md`（r2 覆盖 r1）。车道 L2。本次改动的必过门禁有三项：真实 pi 1.0.4、真实 pi 1.1.0 两次 legacy conformance（自门控，只在本地跑），加 pi 1.4.0 上的 C-X12。

## 0. 事实基础（源码级，已核实）

| #   | 事实                                                                                                                                                                                                                                                                                                                                                                                                                                          | 出处                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| F1  | pi 1.0.4 和 1.1.0 上，非 streaming 时 `sendCustomMessage(…,{triggerTurn:true})` 走 `await this._runAgentPrompt(appMessage)`；`_runAgentPrompt` 内**没有** `emitBeforeAgentStart`。BAS 只在 `prompt()` 路径触发（1.1 `:1591`，1.0 `:1587`）                                                                                                                                                                                                    | `/tmp/pi11/package/dist/core/agent-session.js:1380,1782-1808`；`/tmp/pi10/…:1376,1801-1804` |
| F2  | `_runAgentPrompt` 在第一个 await 之前同步执行 `this._isAgentRunActive = true`，而 `isIdle` 的定义是 `!_isAgentRunActive && !isCompacting`。所以 Fpi2（派发后 `!isIdle()` 证明 run 是本次调用起的）在 legacy 上同样成立                                                                                                                                                                                                                        | 1.1 `:1053,1388`                                                                            |
| F3  | `agent.prompt` → `runAgentLoop` → `streamAssistantResponse`：先 `await transformContext`（sdk → `runner.emitContext`），再调 `streamFunction(…,{signal})`                                                                                                                                                                                                                                                                                     | 主会话已核实；1.4 对应 `pi-agent-core/dist/agent-loop.js:268-281`                           |
| F4  | `emitContext` 先 `structuredClone`、过滤掉 system 消息，再按注册顺序串行传给每个 `context` handler；custom 消息的 `role/customType/details/timestamp` 都保留                                                                                                                                                                                                                                                                                  | 1.1 `runner.js:1006-1020`                                                                   |
| F5  | `ctx.abort()` → `agent.abort()` → `activeRun.abortController.abort()`；之后 `streamFunction` 拿到的 signal 已经 aborted                                                                                                                                                                                                                                                                                                                       | 主会话已核实                                                                                |
| F6  | 1.0、1.1、1.4 三版都有 `agent_settled`、`agent_start`、`ctx.isIdle/hasPendingMessages/abort`、`DefaultResourceLoader{extensionFactories,noExtensions}`、`ModelRuntime.create`、`createAgentSession{modelRuntime,model}`、`session.bindExtensions`；1.0/1.1 的 `dist/bundle/index.js` 自包含（只依赖 node 内建模块），并导出 `createAgentSession/SessionManager/SettingsManager/DefaultResourceLoader/ModelRuntime`，**不导出** `streamSimple` | `dist/core/*.d.ts`、`dist/bundle/index.js`                                                  |
| F7  | pi ≥1.2（联合形状）会给 triggerTurn run 发 BAS `{messageType:"custom", message}`，并且发在该 run 第一次 `context` 之前（Fpi3）                                                                                                                                                                                                                                                                                                                | phase2-plan Fpi3、`pi-compat.ts:256-261`                                                    |

**统一安全表述**（§2、§4 的各文档段、XR7、README 都用这一句）：

> 在**已验证形状的宿主**上（1.0.4 / 1.1.0 由 legacy conformance 覆盖，1.4.0 由 C-X12 覆盖），乐观唤醒的首轮 run 在 legacy 宿主上**零 provider 请求**，在联合宿主上正常授权运行。**其它形状未经验证的宿主**退化为**有界受监管**：Controller 从派发时刻起按 `rootRunMaxS` 截止，并配合空闲观察和 abort 宽限期兜底；最多多出一次受监管的 provider 请求，不会挂起。

## 1. 设计

### 1.1 两个观察点

1. **BAS**（联合宿主）：沿用 `observeRootWakeTrigger`。顺序已经正确：先 `capability.observe(event)`（unknown→observed），再 `readBeforeAgentStartTrigger` 授权 token，再 `verify()`。新增两点：授权时写 `authorizedAt`；墓碑 abort 时写 `gateSightAt`。
2. **`context`**（每次 LLM 调用之前，所有宿主都有）：新的 `guardRootWakeContext`。**不按 capability 快速返回**（评审 #4）。每次只读 `messages` 的最后一条，开销 O(1)：
   - 最后一条不是带 `xsWake:true` 的 `subagent:xs` custom 消息 ⇒ `other`，不扫描整张表（评审 #5）。
   - 带标记 ⇒ 核对 token、sessionId、`details.xid === record.xid`。三者都对上，且记录是 live、有 `authorizedAt`、没有 `abortIssuedAt` ⇒ `authorized`，什么都不做。
   - 其余情况一律 fail-closed（见 1.3 的线性化规则）。

联合宿主的正常路径：wake run 第一次 LLM 调用时，最后一条是我们的标记消息且已被 BAS 授权，返回 `authorized`；之后几次调用的最后一条是 assistant 或 toolResult，返回 `other`；非 wake run 都是 `other`。handler 永远返回 `undefined`，所以 payload 和 provider 缓存前缀逐字节不变。每次 LLM 调用的额外开销是一次数组取尾、几个属性读和至多一次 Map 查找。

### 1.2 首轮结局

| 宿主 / 情形                                                | 结局                                                                                                                                                        | capability | 后续 wake                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| 联合 + 乐观派发（`starting` 或 `deferred`）                | BAS 授权 → `bound`，level 记 `+1`                                                                                                                           | `verified` | Controller 正常派发                                            |
| 联合，但 BAS 读不到 custom 的 details                      | 乐观记录：`missingCustomShape` → absent，同步 abort 并进 `aborting`。之后的 `context` 看到 `gateSightAt` 已设置，静默                                       | `absent`   | `host_unsupported`                                             |
| legacy（F1），`starting`                                   | 没有 BAS；第一次 `context` 发现「已知记录、BAS 从未见过」⇒ `triggerSkipped` 标 absent，abort 一次，Controller 进 `aborting`                                 | `absent`   | `host_unsupported`                                             |
| legacy，`deferred`（F2 settle 延迟）                       | 人类 prompt 的 BAS 是 `{prompt}` 旧形状 → absent，但不是我们的 run，不 abort；我们排队的 run 跑到 `context` 时被 abort（截止已过时走墓碑，同样 abort 一次） | `absent`   | `host_unsupported`                                             |
| legacy，已 `handedOver`                                    | 标 absent，**不 abort**，hop 作废；审计只计一次                                                                                                             | `absent`   | `host_unsupported`                                             |
| 首轮在 BAS 和 `context` 之前就失败                         | 空闲观察结束这一轮；capability 仍是 unknown                                                                                                                 | `unknown`  | 再次乐观派发，每次都受监管，受 wakes 12/h 和 pair 2/h 限额约束 |
| 宿主形状未经验证，且守卫漏判（例如别的扩展改写了消息尾部） | Controller 截止、空闲观察和宽限期兜底 = 有界受监管                                                                                                          | 不变       | —                                                              |

**capability 置 absent 的规则（我定的）**：只在「已知的同会话记录，BAS 从未见过它（既没有 `authorizedAt` 也没有 `gateSightAt`），却跑到了 `context`」时才置 absent。这是「宿主没给这个触发发 BAS」的精确证据，即使当前是 `verified` 也置 absent，粘滞。孤儿 token 和被 BAS 墓碑 abort 过的 token **不**改 capability：它们不是形状证据。

### 1.3 线性化与计数口径（写死，评审 #3）

账本记录新增字段：`optimistic?: true`、`authorizedAt?: number`、`gateSightAt?: number`。`gateSightAt` 只写一次，表示某个守卫第一次真正看到这个触发。

| 情形                                                                                           | 第一次看到时                                                                                                                                                                                                                    | 之后再看到                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 已知 token，已授权，没有 `abortIssuedAt`                                                       | `authorized`；0 次 abort，0 条审计                                                                                                                                                                                              | 同左                              |
| 已知 token，未授权，`handed`                                                                   | 写 `gateSightAt`、`levelCommitted:true`；按规则置 absent；+1 `wake_shape_absent_handed`；0 次 abort                                                                                                                             | `gateSightAt` 已有 ⇒ `other`，0/0 |
| 已知 token，其它情况（未授权 live，或墓碑），`abortIssuedAt` 未设或 `!started`                 | 先 tombstone，再一次 update 写入 `started:true, executionPending:true, levelCommitted:true, gateSightAt, abortIssuedAt`；abort 恰好 1 次；审计恰好 1 条：BAS 从未见过 ⇒ `wake_shape_absent_aborted`，否则 ⇒ `wake_late_aborted` | `aborted`，0/0                    |
| 已知 token，`abortIssuedAt` 已设且 `started`（截止 abort 已经发出）                            | 只写 `gateSightAt`；0 次 abort，0 条审计                                                                                                                                                                                        | 0/0                               |
| 孤儿（没有 token、账本里没有、跨会话、xid 对不上）                                             | 走孤儿端口：**本 run 第一次** ⇒ abort 1 次，+1 `wake_orphan_aborted`                                                                                                                                                            | 同一 run 内 ⇒ 0/0                 |
| BAS 已墓碑 abort（`observeRootWakeTrigger` 同时写了 `gateSightAt`），同一 run 又跑到 `context` | —                                                                                                                                                                                                                               | 0/0                               |

**run 的界定**（只用于孤儿去重）：每次 activation 有一个 `RootWakeOrphanWatch`，它的 latch 在发出孤儿 abort 时置位。以下任一事件清除 latch：BAS hook 入口（新 run 开始）、`agent_settled`、空闲观察释放、`session_shutdown`。BAS 先于该 run 的 `context`（F7），legacy 的 custom run 没有 BAS，但 settle 会清除，所以同一 run 里「BAS 判孤儿 → `context` 再判」只 abort 一次。`/reload` 会新建 watch，于是同一 run 最多多 abort 一次。abort 本身幂等，这个代价接受。

### 1.4 无 controller 时的有界监管（评审 #2）

`rootWakeRecovery` 什么时候存在：`src/stack.ts:1820-1846` 中，**仅当**这一代 stack 没有 `xs.controller`（`fabric.wake.enabled=false`），**且**构建 stack 时账本里已有本会话的记录。账本记录只能由 controller 派发产生，所以在已 attach 的状态下，「有本会话已知记录却既没有 controller 也没有 recovery」不会发生。

但下面三个窗口里拿不到 controller：

1. `session_start` 中 `await types.reload()` 之后、`xs.attach()`（`index.ts:876`）之前的 pre-stack 窗口；
2. `session_shutdown` 把 `xsAttached` 置 false 之后；
3. 孤儿：没有记录，或记录属于别的会话。

**因此无法保证总有 controller。选择方案**：新增 pi-free 的 `RootWakeOrphanWatch`（放在 `root-wake.ts`），由 activation 持有。**所有** controller 拿不到的 abort（裸路径上的已知 token 和全部孤儿）都经过它，**controller 路径上的孤儿 abort 也经过它**（通过 `StackXsInput.abortOrphan` 端口注入）。它的语义与 Controller 的 `aborting/stuck` 一致：

- `issue(port:{abort,isIdle}, token?) → boolean`：latch 已置 ⇒ 返回 false（去重）。否则置 latch、`abortNow`，武装 `ROOT_WAKE_ABORT_GRACE_MS` 宽限定时器和 2s 空闲观察；返回 true。
- 宽限到点 ⇒ +1 `abortStuck`、`warn` 一次。**不**二次 abort，只保留空闲观察。
- 连续两次空闲观察 / `settled()` / `runStarted()` ⇒ 释放（清定时器和 latch）；`dispose()` ⇒ 清定时器。
- 定时器全部走 `systemClock`（分段、unref），时长经过 `clampSpanMs`（I1、I5）。watch 是 activation 闭包内的对象，不是模块级状态（I4）。

已知 token 在裸路径被 abort 后，下一代 stack 的 `recover()` 可能又认领它（墓碑 + `executionPending`），此时由 controller 和 watch 双重监管，两者都幂等。

## 2. 改动文件（按顺序）

### 2.1 `src/adapters/pi-compat.ts`

新增 `readContextTrailingCustom(event)`（结构读取，I14）：

```ts
export function readContextTrailingCustom(event: unknown): { customType?: string; details?: unknown } | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const messages = (event as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const last: unknown = messages[messages.length - 1];
  if (last === null || typeof last !== "object" || (last as { role?: unknown }).role !== "custom") return undefined;
  const m = last as { customType?: unknown; details?: unknown };
  return {
    ...(typeof m.customType === "string" ? { customType: m.customType } : {}),
    ...(m.details !== undefined ? { details: m.details } : {}),
  };
}
```

### 2.2 `src/fabric/xs/host-cap.ts`

- `wakeDowngraded` 只在 absent 时返回 `"host_unsupported"`，类型收窄为 `"host_unsupported" | undefined`。
- 新增 `get optimistic(): boolean`（等价于 `value === "unknown"`）。
- 新增 `triggerSkipped(warn = console.warn)`：无条件置 absent，与 `missingCustomShape` 共用 `warned`（每个进程只告警一次）。告警文案：`"[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only"`。

### 2.3 `src/fabric/xs/wake-ledger.ts`

- `XsWakeRecord` 增加 `readonly optimistic?: true; readonly authorizedAt?: number; readonly gateSightAt?: number;`。
- `NewXsWakeRecord` 增加 `optimistic?: true`。
- `MutableFields` 自动覆盖 `authorizedAt` 和 `gateSightAt`。

### 2.4 `src/fabric/root-wake.ts`

1. `RootWakeAudit` 追加 `"wake_optimistic_dispatch" | "wake_shape_absent_aborted" | "wake_shape_absent_handed"`。
2. 新增 `export type OrphanAbortPort = (token: string | undefined) => boolean;`。`RootWakeTriggerDeps` 增加 `orphan?: OrphanAbortPort; warn?: (m: string) => void`。默认值为 `(t) => (abortNow(deps.abort, deps.audit, t), true)`。
3. `observeRootWakeTrigger`：
   - 孤儿分支：`if (orphan(token)) note(audit,"wake_orphan_aborted",token)`。
   - 墓碑分支：在已有的 `update` 中加 `gateSightAt: record.gateSightAt ?? now`。
   - 授权分支：加 `authorizedAt: now`。
4. 新增 `guardRootWakeContext(event, deps)`：

```ts
const tail = readContextTrailingCustom(event);
if (tail?.customType !== XS_WAKE_CUSTOM_TYPE) return { kind: "other" };
const d = tail.details as { xsWake?: unknown; wakeToken?: unknown; xid?: unknown } | null | undefined;
if (d === null || typeof d !== "object" || d.xsWake !== true) return { kind: "other" };
const token = typeof d.wakeToken === "string" ? d.wakeToken : undefined;
const record = token === undefined ? undefined : ledger.get(token);
if (record === undefined || record.sessionId !== deps.sessionId || record.xid !== d.xid) {
  if (orphan(token)) note(deps.audit, "wake_orphan_aborted", token);
  return token === undefined ? { kind: "aborted" } : { kind: "aborted", token };
}
if (record.state === "live" && record.authorizedAt !== undefined && record.abortIssuedAt === undefined)
  return { kind: "authorized", token: record.token };
if (record.gateSightAt !== undefined)
  return record.handed ? { kind: "other" } : { kind: "aborted", token: record.token };
const now = clock.now();
const basNeverSaw = record.authorizedAt === undefined; // gateSightAt 在这里必为 undefined
if (basNeverSaw) capability.triggerSkipped(deps.warn);
if (record.handed) {
  ledger.update(record.token, { gateSightAt: now, levelCommitted: true });
  note(deps.audit, "wake_shape_absent_handed", record.token);
  return { kind: "other" };
}
const issue = record.abortIssuedAt === undefined || !record.started;
ledger.tombstone(record.token);
ledger.update(record.token, {
  started: true,
  executionPending: true,
  levelCommitted: true,
  gateSightAt: now,
  ...(issue ? { abortIssuedAt: now } : {}),
});
if (issue) {
  note(deps.audit, basNeverSaw ? "wake_shape_absent_aborted" : "wake_late_aborted", record.token);
  abortNow(deps.abort, deps.audit, record.token);
}
return { kind: "aborted", token: record.token };
```

5. 新增 `RootWakeOrphanWatch` 类（§1.4），构造参数 `{clock?, audit?, warn?}`，方法 `issue / runStarted / settled / dispose`。
6. `RootWakeDeps` 增加 `abortOrphan?: OrphanAbortPort`。controller 调用两个守卫时传入 `orphan: this.deps.abortOrphan` 和 `warn: this.deps.warn`。
7. `dispatch()`：
   - 删除对 `host_unverified` 的依赖（getter 已不再返回它）。
   - `const optimistic = this.capability.optimistic;`，写账本时附带 `...(optimistic ? { optimistic: true as const } : {})`。
   - `!isIdle()` 分支：`if (record && !record.optimistic) commitLevel(...); else if (dispatchLevel !== undefined && !record?.levelCommitted) this.deps.level?.raise("root", dispatchLevel);`。乐观派发只做 carry，hop 要等 BAS 授权再记。
   - send 成功后两个分支都执行 `if (optimistic) note(audit,"wake_optimistic_dispatch",token)`。
   - ack 形状不变。
8. `recover()`：commitLevel 的条件加上 `(!record.optimistic || record.authorizedAt !== undefined)`。
9. `beforeAgentStart()` 的 shape-loss 分支：当前 token 的记录若 `optimistic`，且状态是 `starting` 或 `deferred` ⇒ `missingCustomShape`、tombstone，再 `update{started, executionPending, levelCommitted:true, gateSightAt, abortIssuedAt}`，+1 `wake_shape_absent_aborted`，状态进 `aborting`，先 `arm()` 再 `abortNow`。非乐观记录保持原逻辑。
10. 新增 `context(event)` 方法：调用 `guardRootWakeContext`（abort 端口为 `host.abort`）。
    - 结果为 `aborted`、token 等于 `this.token`、状态是 `starting/deferred/bound` ⇒ `aborting` 并 `arm()`。
    - 结果为 `aborted`、控制器空闲、记录属于本会话且有 `abortIssuedAt` ⇒ 认领后进 `aborting`（与 `beforeAgentStart` 里晚到墓碑的分支同构）。
11. `input()`：交接时，乐观记录若 `levelCommitted` 未设，在同一次 update 里写 `levelCommitted:true`（人类接管后 hop 作废）。

### 2.5 `src/fabric/xs/stack.ts`

- `StackXsInput` 增加 `abortOrphan?: OrphanAbortPort`，透传给 controller 的 deps。
- `XsStack` 接口增加 `context(event: unknown): void`，实现为 `controller?.context(event)`。

### 2.6 `src/stack.ts:1827`

`rootWakeRecovery` 的 deps 加 `...(xsInput.abortOrphan ? { abortOrphan: xsInput.abortOrphan } : {})`。

### 2.7 `src/fabric/xs/activate.ts`

- 闭包内新建 `const orphanWatch = new RootWakeOrphanWatch({ audit: (e) => console.warn(\`[pi-subagent] fabric xs ${e}\`) });`。
- `stackInput()`（`:494`）注入 `abortOrphan: (t) => orphanWatch.issue({ abort: () => ctx.abort(), isIdle: () => ctx.isIdle?.() ?? true }, t)`。
- BAS hook（`:169`）：在早退判断之后调用 `orphanWatch.runStarted()`。裸分支（`:191`）传入 `orphan`，`abort` 改为经过 `orphanWatch.issue(...)`，保证已知 token 在裸路径上也受监管。
- 在 `if (xsEnabled)` 块（`:201`）里，**`turn_start` 之前**注册 context hook：

```ts
pi.on("context", (event, ctx) => {
  const xs = xsAttached ? holder.current?.xs : undefined;
  if (xs?.controller) xs.context(event);
  else if (xsAttached && holder.current?.rootWakeRecovery) holder.current.rootWakeRecovery.context(event);
  else {
    const port = { abort: () => ctx.abort(), isIdle: () => ctx.isIdle?.() ?? true };
    guardRootWakeContext(event, {
      sessionId: xsSessionOf(ctx) ?? "",
      ledger: xsLedger,
      capability: xsCapability,
      abort: () => void orphanWatch.issue(port, undefined),
      orphan: (t) => orphanWatch.issue(port, t),
      audit: (e) => console.warn(`[pi-subagent] fabric xs ${e}`),
    });
  }
}); // 同步执行，永远返回 undefined
```

- 已有的 `agent_settled` forwarder（`:238`）追加 `orphanWatch.settled()`；`session_shutdown`（`:243`）追加 `orphanWatch.dispose()`。**不新增其它注册**。

### 2.8 只改注释

- `src/fabric/xs/receiver.ts:47`、`src/fabric/xs/switch.ts:9`：去掉「unknown ⇒ host_unverified」的说法。
- `src/web-hub/protocol/xs.ts:285`：注释改为 `// legacy only: emitted by agents before wake-unknown-optimistic; kept append-only (I10)`。不动 `tests/fixtures/legacy-xs-v071/`。

### 2.9 明确不做

- 不加 wire 字段，不改工具描述（工具描述有冻结 golden）。
- 不改 `/agent status`，不加计数（评审 #8）。审计只留在 `stack.audit`。
- 不改 sender、hub、Feishu。
- schedule 只读 `capability.state`，不受影响。

## 3. governance trace（评审 #9，逐个 profile）

`xsEnabled = fabric.enabled ∧ crossSession.enabled ∧ webHub.enabled ∧ webHub.control`（`switch.ts:39`）。默认值：`fabric.enabled=false`（`fabric/settings.ts:517`）、`crossSession.enabled=false`（`:542`）、`webHub.enabled=false`（`web-hub/agent/settings.ts:644`）。

| profile        | 设置要点                                           | xsEnabled | 会走到 `registerTriggerGuard` 吗                 | 现在的 B1 位置及其后两项                       | 预期差异                                                   |
| -------------- | -------------------------------------------------- | --------- | ------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------- |
| default        | `{}`                                               | false     | 是                                               | `calls[42]` → `on(session_tree)`               | 无（191 项）                                               |
| minimal        | BASELINE（`webHub:false`）                         | false     | 是                                               | `calls[12]` → `on(session_tree)`               | 无（112 项）                                               |
| max            | fabric、wake、xs、webHub 全开（control 默认 true） | **true**  | 是                                               | `calls[42]` → `on(turn_start)`, `on(turn_end)` | 在 `[43]` 插入 `on(context)`；`count` 245→246；phase2 不变 |
| child          | BASELINE，`child:true`                             | —         | 否：HOST_KEY 在 `index.ts:276` 早退，先于 `:306` | 没有 B1                                        | 无（32 项）                                                |
| compat-failure | BASELINE 缺 `appendEntry`                          | false     | 是（xs 关）                                      | 同 minimal                                     | 无（50 项）                                                |

刷新命令：`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance`。然后跑 `git diff -U0 tests/fixtures/governance/activate-trace.json`，**只允许**出现 max 的 `+ "on(context)"` 和 `"count": 246` 两处变化，其它任何变化都说明注册条件写错了。commit 里写明原因。A 级 golden 不变。

## 4. 设计文档更新

1. **phase2-plan §4.5 第 6 行**拆成两行：unknown 走乐观 Controller 判定链（§6.7）；absent 只投递 `host_unsupported`。表下加注：
   - `host_unverified` 只由老 agent 产生（I10）；
   - **`woke:true` 的含义是「已接受唤醒派发」**，与 `start_deferred` 同一口径，不保证该 run 发出了 provider 请求（评审 #6）。
2. **§6.2**：
   - 前置条件改为「能力 ≠ absent」；
   - 转移表加入 §1.2、§1.3 的各行（context 守卫、handed 不 abort、乐观 shape-loss abort、空闲时认领）；
   - 写明 B1 墓碑分支要写 `gateSightAt`，授权要写 `authorizedAt`。
3. **§6.5 / B1** 增加「孤儿 abort 由 activation 级 `RootWakeOrphanWatch` 监管（宽限 → stuck，按 run 去重）」。
4. **§6.6** 增加一行：乐观派发同步阶段只 carry，BAS 授权后 `+1`；被 abort 或被人类接管时保持 carry。
5. **§6.7**：
   - unknown 行改为「乐观派发 + 首轮校验」；
   - absent 行的进入条件追加「已知记录 BAS 从未见过却到达 `context`」；
   - 「首次调用协议」段改写为 §0 的统一表述，并附 F1–F7；
   - 删掉「managed rpc 停在 unknown」那条局限。
6. **§11 XR7** 改为统一表述，外加「legacy 首轮的 ack 是 `woke:true`（已接受派发）」。
7. **§14 N1**：原文保留，追加「改判 2026-11」小节（内容见 §7 末段）。
8. **README**：
   - `:91` 那句改为统一表述的英文版；
   - Peer-upgrade gates 加上 C-X12 和 legacy conformance（注明不进 CI、升级 pi 前在本地跑）；
   - 残留风险段加入 §7 的条目；
   - 写明 `woke:true` 的含义。

## 5. 测试

### 5.1 必过门禁：真实 legacy conformance（评审 #1）

**新文件** `tests/conformance/fabric-xs-legacy.test.ts`，用 `describe.skipIf(!process.env.PI_TOOLKIT_LEGACY_PI_DIR)` 自门控。CI 不设这个变量，所以 CI 里跳过。

- **加载方式**：不改 host 依赖，直接 `await import(pathToFileURL(join(dir, "dist/bundle/index.js")).href)`。bundle 自包含（F6）。取出 `createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime`，类型标成 `any`（测试专用）。被测的 `src/fabric/root-wake.ts`、`xs/wake-ledger.ts`、`xs/host-cap.ts`、`adapters/pi-compat.ts` 运行时都不依赖 pi，可以直接 import。
- **provider**：沿用 `tests/conformance/fixtures/anthropic-stub.ts`。
  - **A（首选）**：在 `agentDir` 写 `models.json`：`{"providers":{"xs-local":{"baseUrl":"<stub>/v1","api":"anthropic-messages","apiKey":"local-stub-only","models":[{"id":"claude-xs","contextWindow":1000,"maxTokens":128}]}}}`，再 `ModelRuntime.create({authPath, modelsPath})`、`getModel("xs-local","claude-xs")`。这样用的是 legacy 自己的 provider 管线。
  - **B（退路，A 的 API 不兼容时）**：照现有 `fabric-xs.test.ts:166-178` 注入 `modelRuntime` 垫片，用 host 的 `streamSimple`。被测的是 legacy agent-loop 里 `context → abort → streamFunction` 的时序，计数在 stub 的 HTTP 层，结论仍然有效。用了哪一个要在报告里写明。
- **harness**：照 `fabric-xs.test.ts` 的 `host()` 精简。`extensionFactories` 注册 `before_agent_start`（记录事件并调 controller）、`context`（调 `controller.context`）、`input`、`agent_settled`。controller 用真实的 `RootWakeController`，配新建的 `XsWakeLedger` 和 `XsHostCapability`（初始 unknown），加 FakeClock。
- **用例**（每个版本都必须全绿）：
  - **L1 形状事实**：`controller.wake()` 之后，等到 `agent_settled`；期间 BAS 事件 **0 次**；第一次 `context` 的最后一条满足 `role:"custom"`、`customType:"subagent:xs"`，且 `details` 含 `xsWake`、`wakeToken`、`xid`（F1、F4）。
  - **L2 端到端**：
    - unknown 时 dispatch 返回 `{dispatched:true}`，并按 F2 断言 `effect:"applied"`；
    - stub **0 个请求**；
    - `agent_settled{aborted:true}`；
    - `cap.state === "absent"`；
    - audit 恰好包含 1 条 `wake_shape_absent_aborted`，abort 恰好 1 次（spy）；
    - 账本记录为墓碑，带 `gateSightAt`，`levelCommitted` 为真；
    - 第二次 dispatch 返回 `{dispatched:false, wakeDowngraded:"host_unsupported"}`。
  - **L3 人类不受影响**：新会话里先 `session.prompt("human")`：BAS 是 `{prompt}` 旧形状 → absent；stub 收到 1 个请求，没有 abort。之后的 wake 一律 `host_unsupported`。
  - **L4 deferred**：在 `agent_settled` handler 里派发（让 F2 的 settle 延迟生效）。先断言 `start_deferred`；再让排队的 run 跑到 `context` → abort，stub 0 请求，审计 1 条。
- **命令**（本地必跑，结果写进 `docs/dev/fabric-cross-session/wake-unknown-optimistic-report.md`）：

```sh
PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi10/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts
PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi11/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts
```

目录的复现方式：`npm pack @earendil-works/pi-coding-agent@1.1.0`（1.0.4 同理），然后 `tar xzf` 到 `/tmp/pi11`（`/tmp/pi10`）。

- **最小可行替代**（vitest 无法导入外部 bundle 时，例如 transform 超时）：新建 `scripts/dev/legacy-wake-probe.ts`，用 `node --import tsx` 运行，同样动态导入 bundle 和 stub、跑 L1–L4，失败时 `process.exit(1)`。同一份报告里注明用的是哪种方式。

### 5.2 真实 1.4 conformance：`tests/conformance/fabric-xs.test.ts` 新增 C-X12

- **C-X12**：不调 `prime()`，`cap` 为 unknown；`wake()` 返回 `dispatched:true`；stub 恰好 1 个请求；BAS 为 custom；结果 `verified`；记录带 `authorizedAt`；`context` 守卫返回 `authorized`；`details` 不进 payload。
- **C-X12b**：harness 的 BAS hook 刻意**不**转发给 controller（模拟宿主不发 BAS）；注册 `controller.context`。`wake()` 之后 stub **0 请求**，收到 `agent_settled{aborted:true}`，结果 absent。这一条钉住「当前 peer 上 `context` 里的 abort 先于 provider」。
- 在 harness 的 extension factory 里加一条 `api.on("context", (e) => controller.context(e))`，C-X1…C-X11 必须仍然全绿（证明联合宿主上零行为变化）。

### 5.3 单元测试：需要修改的

| 文件:行                                                | 改法                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fabric/xs-host-cap.test.ts:9-16`                | unknown ⇒ `wakeDowngraded` 为 `undefined`、`optimistic` 为 true；新增 `triggerSkipped` 粘滞，且与 `missingCustomShape` 共用一次告警         |
| `tests/fabric/xs-truth-table.test.ts:215-228`          | unknown ⇒ Controller 派发（`applied`, `woke:true`）；absent ⇒ `host_unsupported`                                                            |
| `tests/fabric/xs-truth-table.test.ts:398`              | 改为 `capability:"absent"` → `host_unsupported`                                                                                             |
| `tests/fabric/root-wake.test.ts:674-685`               | 拆成 §5.4 的新用例，保留 absent 那半                                                                                                        |
| `tests/integration/fabric-xs.test.ts:14-17`            | `"N1"` 那次 send ⇒ `woke:true`，b 变为 `verified`；后面的步骤按 controller 占位和 pair 2/h 重新排；`cap unknown` 的 status 断言留在派发之前 |
| `tests/integration/fabric-xs-lifecycle.test.ts:94-100` | restore 之后 ⇒ `{effect:"applied", woke:true}`，能力 `verified`                                                                             |
| `tests/web-hub/protocol/xs-frames.test.ts:156`         | 不改（I10 守卫）                                                                                                                            |

### 5.4 单元测试：新增

- **`tests/fabric/root-wake.test.ts`**（FakeClock）：
  1. unknown + 联合 BAS ⇒ verified、`bound`、`+1`，记录带 `authorizedAt`；
  2. legacy `starting` ⇒ `context` 后 abort 1 次，进 `aborting`，absent，第二次 `host_unsupported`；
  3. legacy `deferred`：人类旧形状 BAS 不 abort，之后排队的 run 被 `context` abort；截止已过的墓碑同样只 abort 1 次；
  4. 乐观派发 + BAS 缺 details（`starting`、`deferred` 各一）；
  5. handed：不 abort，审计 1 条，之后授权也不抬 level；
  6. **重复 `context`**：同一 token 连续 3 次 ⇒ abort 1 次、审计 1 条；
  7. BAS 墓碑 abort 之后同一 run 又来 `context` ⇒ 0/0；
  8. 截止已经发出 abort（`started`）之后再 `context` ⇒ 0/0；
  9. 孤儿 3 种（没有 token、账本里没有、xid 对不上）⇒ 同一 run 内 1 次；`settled` 之后的新 run 再 1 次；
  10. 已授权的 live 记录重复 `context`（重试）⇒ 永远是 `authorized`，0 次 abort；
  11. `/reload`：乐观 `deferred` → `dispose` → `recover()`（墓碑）→ `context` ⇒ 新 controller 认领并进 `aborting`，recover 不提交乐观 level。
- **`RootWakeOrphanWatch` 单测**（同一个文件，或新建 `tests/fabric/root-wake-orphan-watch.test.ts`）：
  - `issue` 去重；
  - fake abort 永不结束 ⇒ 10s 后 `abortStuck` + warn 一次、不二次 abort，空闲两次后释放；
  - `settled`、`runStarted`、`dispose` 都会清掉定时器（`clock.pendingTimers === 0`）；
  - 计时用 `clampSpanMs`。
- **`tests/fabric/root-wake.property.test.ts`**（评审 #7）：
  - 生成器：capability 初始态取四态之一；controller 取「有 / 只有 recovery / 无（裸 guard + watch）」三者之一；事件字母表包括 dispatch、BAS（union-custom / union-user / legacy-prompt / custom 缺 details / 墓碑 token / 孤儿）、`context`（我们的标记 / 孤儿标记 / 非标记，可重复）、input(human)、settled、空闲观察时钟推进、截止推进；fake abort 可配置为「同步 settle / 永不结束」。
  - 不变式：
    - 每个 token 的 abort 调用 ≤1 次，`wake_shape_absent_aborted + wake_late_aborted` ≤1 条；
    - 每个 run 的孤儿 abort ≤1 次；
    - 被 abort 或被交接的乐观 token 永不提交 hop；
    - `handedOver` 之后 abort 为 0；
    - capability 只沿 unknown→observed→verified 前进，或单向进入 absent，且一旦 absent 就不再派发；
    - 每个占位状态（controller 或 watch）都有活定时器或空闲观察；
    - 永不结束的 abort 最终进入 stuck，不会再次 abort。
  - reload/lease 的全组合不进 property，由第 11 条单测覆盖。
- **`tests/adapters/pi-compat-trigger.test.ts`**：`readContextTrailingCustom` 的边界情况。
- **`tests/fabric/xs-level.test.ts`**：乐观 carry → `+1`；被 abort 时保持 carry。
- **`tests/fabric/xs-wake-ledger.test.ts`**：新字段在 `update` 和 `tombstone` 之后保持不变。
- **集成**：`tests/integration/helpers/fabric-xs-process.ts` 的 fake host 增加 `legacy` 开关（triggerTurn 时不发 BAS，改发 `context{messages:[…,m]}`，并统计「provider 调用」）。`fabric-xs-lifecycle.test.ts` 新增：legacy 首轮被 abort、零调用、第二次 `host_unsupported`。

## 6. 验证命令

```sh
npx vitest run tests/fabric/root-wake.test.ts tests/fabric/root-wake.property.test.ts tests/fabric/xs-host-cap.test.ts \
  tests/fabric/xs-truth-table.test.ts tests/fabric/xs-level.test.ts tests/fabric/xs-wake-ledger.test.ts \
  tests/fabric/xs-receiver.test.ts tests/adapters/pi-compat-trigger.test.ts tests/commands/status-xs.test.ts \
  tests/web-hub/protocol/xs-frames.test.ts tests/schedule/agent/message.test.ts
npx vitest run tests/integration/fabric-xs.test.ts tests/integration/fabric-xs-lifecycle.test.ts \
  tests/integration/fabric-xs-channel.test.ts tests/integration/fabric-xs-reply*.test.ts
npx vitest run tests/conformance/fabric-xs.test.ts tests/conformance/fabric-wake.test.ts tests/conformance/schedule.test.ts
PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi10/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts   # 必过
PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi11/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts   # 必过
PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance && npx vitest run tests/governance tests/boundary
git diff -U0 tests/fixtures/governance/activate-trace.json        # 只允许 max 的 +on(context) 和 count 246
git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/governance/activate-trace.json' && echo A-tier-clean
npm run typecheck && npm run format:check && PI_TOOLKIT_TEST_WORKERS=4 npm test
```

另外推荐（不强制）：`PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi13/package` 跑同一个文件，按 BAS 形状分支断言联合宿主的预期，用来覆盖 1.3。

## 7. 风险与残留

- **R1 形状未经验证的宿主**：1.2、1.3，或未来改了 F1/F4 的版本。按统一表述退化为有界受监管，不承诺零 provider 请求。升级 peer 前必须重跑 C-X12 和 legacy conformance（写进 README 的 gates）。
- **R2 消息尾部被其它扩展改写**：`emitContext` 按注册顺序串行，前面的 handler 可能在我们的标记后面再追加消息，导致漏判。这种情况退化为有界受监管，不测试注册顺序。
- **R3 `woke:true` 的语义**：含义是「已接受派发」，legacy 首轮随后被 abort。和 `start_deferred` 同一口径，文档里写明；不加 wire 字段，不退配额。
- **R4 首轮在 BAS 和 `context` 之前就失败**：capability 停在 unknown，会反复乐观派发，但每次都受监管，并受 12/h 和 pair 2/h 限额约束。
- **R5 xs 关闭后 `/reload`**：context hook 只在 xsEnabled 时注册（I9）。legacy 上 settle 延迟队列里排着的乐观触发没有守卫。窗口极窄（Fpi10），有意接受。
- **R6 收紧**：absent 之后，非乐观的 shape-loss 推定路径也会被 `context` abort（原来是推定 bound 加截止监管）。这只会出现在违反 C-X1 的宿主上，方向更安全。
- **R7 孤儿 latch**：只在 BAS、settle、空闲释放、shutdown 时清除。如果某个 run 结束时没有 settle，空闲释放又还没到（2×2s），紧接着的下一个无 BAS run 里的孤儿会被少 abort 一次。这只涉及孤儿；已知 token 由账本线性化，不受影响。
- **R8 末尾残留标记**：联合宿主上 wake run 在 assistant 回复之前就被 abort，之后有人裸 `continue`、不追加新消息时，那一轮会被当作孤儿或晚到墓碑 abort 一次。方向是 fail-closed，每个 run 一次。

### 与 I14 / N1 原决策的关系

- **I14 不变**：不按版本放行，不发探测 run。两个观察点读的都是「已经发生的事件」的形状。conformance 里按版本跑只是测试手段，运行时代码不读版本号。N1 当年否决的备选「以 pi ≥1.2 版本号放行」**继续否决**。
- **N1 改判**：从「unknown ⇒ 只投递」改为「unknown ⇒ 受监管的乐观派发 + 首轮在 provider 请求之前校验」。review-r1 #1 的两条要求仍然满足：
  - 不起无监管 run：派发即拥有（F2 证明 Fpi2 在 legacy 上也成立），截止从派发起算；孤儿由 watch 监管；
  - 已验证形状的旧宿主上首轮零 provider 请求：由 F1/F3/F4/F5 和必过的 legacy conformance 证明；未验证宿主有界退化。

  原 N1 只考虑了 managed rpc restore，常见的「TUI/web 刚开、只跑过斜杠命令」场景现在可以直接唤醒。

## 评审处置表

| #   | 级别    | 处置                                                                                                                                                                                                                                           | 落点                   |
| --- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | Blocker | **接受**。legacy 真实 conformance 改为必过门禁（1.0.4、1.1.0 各跑一次，自门控、本地跑、不进 CI），动态导入 bundle，provider 有 A/B 两条路，另备 tsx 脚本替代；全文统一表述，§1.2、§4、§7 已改成一致                                            | §0、§5.1、§6、§4.5–4.8 |
| 2   | Major   | **接受**。论证了 `rootWakeRecovery` 的存在条件，以及 pre-stack 窗口、shutdown 之后、孤儿三处无 controller 的情形；新增 activation 级 `RootWakeOrphanWatch`（宽限 → stuck、空闲释放、`clampSpanMs` + unref），裸路径和全部孤儿 abort 都由它监管 | §1.4、§2.4.5、§2.7     |
| 3   | Major   | **接受**。已知 token 通过 `gateSightAt` 在账本层线性化，第一次处理负责 tombstone、`abortIssuedAt`、1 条审计和 1 次 abort；孤儿按 run latch 去重；计数口径表写死                                                                                | §1.3、§2.4.4           |
| 4   | Major   | **接受**。去掉基于 capability 的快速返回，按 token 是否授权（`authorizedAt`）判定；absent 规则：已知记录 BAS 从未见过就置 absent（含 verified 状态）；联合宿主开销 O(1)、零行为变化，由 C-X1…C-X11 加挂守卫后仍全绿证明                        | §1.1、§1.2、§5.2       |
| 5   | Minor   | **部分接受**。核对 token、sessionId、xid 和记录状态，不一致按孤儿 fail-closed；末尾不是我们的标记 ⇒ `other`；扩展改写列为残留 R2，不测试注册顺序                                                                                               | §2.4.4、§7 R2          |
| 6   | Minor   | **按裁定**：不加 wire 字段，不改工具描述；只在 README 和 phase2-plan 写明 `woke:true` = 「已接受唤醒派发」；不做端到端验收                                                                                                                     | §4.1、§4.8、§7 R3      |
| 7   | Minor   | **部分接受**。property 扩展到四态 capability、三种 controller 形态、重复 `context`、BAS/`context` 交错、handover、永不结束的 abort（宽限 → stuck）；reload/lease 由单测覆盖                                                                    | §5.4                   |
| 8   | 建议    | **接受**。删除 `/agent status` 计数，`status.ts` 不改                                                                                                                                                                                          | §2.9                   |
| 9   | 建议    | **接受**。逐个 profile 列出 xsEnabled 真值、B1 位置和预期差异：只有 max 在 `[43]` 多一条 `on(context)`，count 变为 246                                                                                                                         | §3                     |
