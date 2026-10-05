# web-hub：在列表卡片上删除会话 — 实施方案 v2（r1 评审修订版）

> 2026-10-06 · Plan 子 agent 只读调研产出 · 上游探索：`docs/dev/web-hub-close-session/explore.md`
> v1 → v2：闭合 `review:delete-session`（gpt-5.6-sol）r1 意见：3 Blocker、3 Major、1 Minor，处置表见文末「r1 评审处置」。
> 用户最终决策见文末「用户拍板」，**与正文冲突时以拍板为准**。行号对应调研时的 master HEAD，动手前请用 `rg` 重新定位。

## 0. 口径

### 0.1 用户已拍板（不得更改）

1. **删除 = 停进程（若在跑）+ 从 web 列表移除**。会话 jsonl **保留**（终端 pi 仍可 resume）：不进回收站、不删文件。
2. **可删对象**：hub 托管会话（live / stopping / exited）+ 已离线的 TUI 会话卡片（`down:true` 或 `stale`）。**在线的 TUI 会话不可删**：按钮不显示，hub 侧也拒绝。
3. **入口在列表**，两步确认，交互与 DetailHeader「停止会话」相同：首击 arm，4s 自动解除，Esc 解除（`DetailHeader.vue:83-124`）。详情页头**不新增**入口。
4. 文末「用户拍板」6 条：hub 广播、详情页显示「已删除」空态、unconfirmed ⇒ 放弃删除且卡片恢复、离线 TUI 不发信号、外部离线 rpc 卡片也可删、新增 `E_AGENT_ONLINE`。

### 0.2 三条底线（每条设计都按这三条自检）

- **B-alive**：进程可能还活着时，绝不显示「已删」，也绝不丢掉它唯一的托管身份记录（spawn record）。
- **B-fork**：删除不得导致任何意外的重新 fork（创建端点的幂等不能被破坏）。
- **B-stream**：删除不得破坏历史流基线：同一 agentKey 重现时，必须先拿到 history 快照，再收增量。

### 0.3 v2 的范围补充（r1 #2 导致，**需用户知悉**，见 §10）

托管会话在 `starting`（尚未绑定 agentKey）和 `failed`（绑定前就失败）阶段只以 **SpawnRow** 占位行出现（`AgentList.vue:249-253`，`logic/spawn.js:150-166`），没有 AgentCard。要满足「托管会话任意状态可删」，**SpawnRow 也增加同款两步删除入口**，按 spawnId 删除。现有的本地「关闭」（只在本标签页隐藏）保持不变。

---

## 1. 现状（带证据）

### 1.1 agent 卡片：hub registry 只在内存里保留 ≤60s，之后只活在各标签页的内存里

| 层             | 存储                                                                                                                                   | 生命周期                                                                                                                                                                                               | 证据                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| hub registry   | 进程内 `Map<agentKey, Rec>`，不持久化                                                                                                  | `live` →（断连）`claiming` 10s →`stale`；从断连起算满 `reapMs`=60s，或 tick 发现 pid 已死，就 `down()`：删记录 + 发 `agent_down`                                                                       | `hub/registry.ts:140,221-237,560-581`；`protocol/messages.ts:483-496` |
| 浏览器 reducer | 每个标签页内存里的 `AgentState`，带 `down:true`                                                                                        | `agent_down` 只把卡片标成 down，不删（`ui/src/logic/state.js:327-340`）；每个新的 SSE 连接都会收到 `agents` 快照（`hub/http.ts:843`），reducer 按快照整表重建（`state.js:306-317`），down 卡片随之消失 | —                                                                     |
| SSE 订阅       | 每个 SSE 客户端的 `client.subscribed: Set<agentKey>`（`hub/sse.ts:195-198`），scoped 帧只推给订阅了该 key 的客户端（`sse.ts:228-238`） | 只在 `/api/subscribe`、`/api/unsubscribe` 时增删（`http.ts:835,863,876`）。`dropAgent`（`http.ts:706-709`）只清 `fleetCache` 和 pending，**不清 `subscribed`**                                         | r1 #4                                                                 |

**结论**：离线卡片在 hub 侧要么是 registry 里的 `stale` 记录，要么已经没有记录。所以删除**不需要 tombstone**（tombstone 会挡住同一进程重连后的重现，§3），需要的是 hub 侧的「删卡」广播，外加清掉各连接对这个 key 的 scoped 订阅。

### 1.2 托管会话

- 记录存在 supervisor 内存 Map（`hub/spawn/supervisor.ts:347`）里，以整表快照写入 `spawns.json`。debounce 写 `markDirty`（`:467-474`）；同步写 `saveNow` 用于 L1 路径（`:1066,1138`；`store.ts:174-193`）。hub 重启后由 `init()` 恢复（`:1327-1400`）。
- `store.ts` 的形状校验 `isRecordShapeOk` **只检查已知字段，不拒绝未知字段**（`store.ts:224-296`）⇒ 新增可选字段向旧 hub 兼容（旧 hub 忽略它，下次写盘时自然丢弃）。
- 终态最多保留 20 条（`supervisor.ts:716-721`）。状态推送走 `schedulePush()`，**queueMicrotask 合并**（`:509-521`），推送时读的是当时的 `publicPayload()`。
- **unconfirmed 终态有两个来源**（r1 #1、#6 的关键事实）：①停止梯 guard：身份复验失败或 SIGKILL 后 5s 仍没有 exit 事件，就写 `exit.unconfirmed:true` 并转终态（`:778-807`），**进程可能还活着**；②hub 重启时，每条非终态记录都被 `finalizeRecovered` 置为 `exited/orphan` 加 `unconfirmed:true`（`:1220-1236`），随后由 `recoverEscalate` 异步做身份复验加 TERM/KILL（`:1246-1257`）。另外，**`finalizeTerminal` 会 `reaper.untrack(pid)`**（`:728`），终态记录里的进程不再受 reaper 兜底。
- **`failSpawnError` 可能在 pid 已捕获后发生**（spawn event 超时，`:822-833`：身份复验失败就不发信号，直接转终态，`exit` 保持 undefined）⇒ 「终态」不等于「进程已死」。
- **创建端点幂等**（r1 #3）：`principal|id` 的 LRU 保留 10 分钟（`hub/spawn/routes.ts:80-81,162-180`）。命中但记录不存在时，**会落穿并 fork 一个新进程**（`routes.ts:481-516`，注释写着「defensive — the in-memory map outlives every LRU entry」）。v1 引入的删除让这条前提不再成立。
- UI：`pendingRows` 只渲染 `starting|failed`（SpawnRow），`managedFor` 只匹配 `live|stopping`（`logic/spawn.js:150-198`）。

---

## 2. 目标设计

### 2.1 托管记录的「死亡确认」规则（闭合 r1 #1，B-alive 的核心）

**只有确认进程已死，托管记录才会被删除。** supervisor 新增一个私有判定：

```ts
type Death = "confirmed" | "alive" | "unknown";
function deathOf(rec): Death;
//  rec.pid === undefined：
//    rec.noProcess ∈ {"never-forked","boot-changed"} ⇒ "confirmed"（有持久化的「无进程」证据）
//    否则                                       ⇒ "unknown"（例：fork 后、pid 落盘前 hub 崩溃，重启时 environ 扫描未命中或扫描不完整）
//  rec.exit !== undefined && !rec.exit.unconfirmed ⇒ "confirmed"（收到过真实的 exit 事件）
//  否则 probeIdentity(rec)：
//    身份四元组不全（④ 当时 /proc 不可读）     ⇒ "unknown"
//    platform≠linux / 本机 bootId 不可读       ⇒ "unknown"
//    rec.bootId ≠ hubBootId                    ⇒ "confirmed"（机器重启过）
//    读 /proc/<pid>/stat 抛 ENOENT/ESRCH       ⇒ "confirmed"
//    读取抛其他错误                             ⇒ "unknown"
//    starttime ≠ rec.procStartTicks            ⇒ "confirmed"（pid 已被复用）
//    stat 的 state 字段为 Z 或 X               ⇒ "confirmed"
//    /proc/<pid>/status 的 uid ≠ rec.uid       ⇒ "confirmed"（不是同一个进程）
//    其余（starttime、uid 都对上，非 zombie）    ⇒ "alive"
```

- 新写 `probeIdentity`，**不复用** `verifyIdentityById`：后者把「进程不存在」「/proc 不可读」「pgrp 不符」一律当作 false（`:627-647`），分不出 gone 和 unknown；`readStatSync` 也会吞掉错误码（`protocol/proc-identity.ts:145-154`）。新函数用 `procDeps.readFileSync`（注入的 `readProc`）直接读，并按 `err.code` 分支。**只读不发信号**，因此不涉及 L5 的「验证与信号同段」要求。
- `"alive"` 和 `"unknown"` 都按「可能还活着」处理（fail closed）。
- **「无进程」证据 `noProcess`**（consult 复核补充 C1）：`InternalRecord`/`StoredRecord` 增加 `noProcess?: "never-forked" | "boot-changed"`，持久化。`store.ts` 的形状校验要求存在时必须是这两个值之一；对旧 hub 透明。写入点只有三处：
  - `start()` 的 ② pin 失败分支（`supervisor.ts:1073-1083`，fork 之前）⇒ `"never-forked"`；
  - ③ `spawnFn` 同步抛错、或返回 undefined（`:1109-1119`。node 的 spawn 同步抛错只出现在参数校验阶段，此时尚未 fork；EAGAIN 之类走异步 `error` 事件，那时 pid 已有值，不经过这里）⇒ `"never-forked"`；
  - `init()` 中 `bootChanged` 为真时恢复的记录（`:1348-1351`）⇒ `"boot-changed"`。

  **launching 记录恢复时 environ 扫描未命中**（`:1361-1375`）**不写证据**：`scanEnvironForSpawnId` 在「真未命中」和「预算耗尽、btime 或 readdir 不可读」两种情况下都返回 undefined（`:1277-1290`），分不出来。因此这类 `failed{spawn_error}` 记录的 `deathOf` 为 `unknown`，删除返回 409 exit-unconfirmed，记录保留；SpawnRow 的本地「关闭」仍可把它隐藏（R9）。

### 2.2 supervisor 的删除状态机

`hub/spawn/supervisor.ts`：

- `InternalRecord` 增加 `removePending: boolean`；**持久化**为 `StoredRecord.removeIntent?: true`（闭合 r1 #6，§2.6）。
- 新增公开方法：
  ```ts
  /** Latest record (any state) bound to agentKey — the remove router's managed lookup. */
  lookupByAgentKey(agentKey: string): { spawnId: string } | undefined;
  /** The single deletion entry for a managed record (by spawnId). */
  remove(spawnId: string, deadline: ReqDeadline):
    | { ok: true; outcome: "removed" }                                    // 已删除（死亡已确认）
    | { ok: true; outcome: "pending"; state: "stopping" }                 // 已进入（或本来就在）停止梯，退出后再删
    | { ok: false; code: "E_AGENT_ONLINE"; reason: "exit-unconfirmed" }   // 终态但无法确认进程已死 ⇒ 拒绝，记录保留
    | { ok: false; code: "E_NOT_FOUND" }
    | { ok: false; code: "E_DEADLINE" };                                  // 余量 < INTENT_MIN_REMAINING_MS，没有写盘
  ```
  私有的 `findByAgentKey`（`:886-891`，只查非终态记录，`isManaged`/`noteVersion` 依赖它）**保持不动**。
- `remove(spawnId)` 的分支：
  1. 记录不存在 → `E_NOT_FOUND`。
  2. **非终态**（`launching` 不可达；`starting`/`live`/`stopping`）：先检查 `deadline.remaining() ≥ INTENT_MIN_REMAINING_MS`（`:305`），然后置 `removePending=true`，**`store.saveNow(storedSnapshot())` 同步落盘删除意图**（同 L1 的做法，`:1066`；写失败时 store 自己标 unhealthy 并记日志，删除照常继续，意图只活在内存里，即降级 D-6，§2.6）。不在 stopping 的先 `enterStopping(rec, "user")`，然后 `schedulePush()`。返回 `pending`。已经 pending 的重复调用直接返回 `pending`（幂等）。
  3. **终态**：`deathOf(rec)`：
     - `confirmed` → `deleteRecord(rec)` → `removed`；
     - `alive`/`unknown` → 返回 `E_AGENT_ONLINE{reason:"exit-unconfirmed"}`，**记录不动**。这闭合了 r1 #1 的「第二次删除绕过」：无论 registry 状态如何（stale、reap、absent），终态记录都要过死亡确认这一关。
- `deleteRecord(rec)`（私有，**唯一**删除托管记录的地方）：`records.delete` → `persistDebounced()` → `schedulePush()` → 审计 `{phase:"remove", spawnId}` → `deps.onRemoved?.(spawnId, agentKey)`。
- `finalizeTerminal`（`:723-740`）末尾、`trimTerminalRecords()` 之后：
  ```
  if (rec.removePending) {
    if (deathOf(rec) === "confirmed") deleteRecord(rec);
    else { rec.removePending = false; persistDebounced(); schedulePush(); audit {phase:"remove", spawnId, code:"E_EXIT_UNCONFIRMED"}; }  // 拍板 #3：放弃删除，卡片恢复
  }
  ```
  guard 路径（`exit.unconfirmed`）也会过 `probeIdentity`：进程其实已经消失时（stat ENOENT、starttime 不符）照样能完成删除；只有真的可能还活着时才放弃。
- 公开投影：`SpawnRecordPublic.removing?: true`，`supervisor.publicItem`（`:476-495`）和 `project.ts` 的 `toPublic`/`toViewer`（`:76-150`）**两套投影都要加**。
- `SpawnSupervisorDeps.onRemoved?: (spawnId: string, agentKey: string | undefined) => void`。hub.ts 接线（`:521-540`）：`onRemoved: (_id, key) => { if (key !== undefined) registry.remove(key, { allowConnected: true }); }`。`allowConnected:true` 是安全的：`deleteRecord` 只在死亡已确认时调用，registry 里残留的 live/claiming 记录只是 socket close 还没处理完。**不扩展** `SpawnRegistryPort`（它的 keyof 被 `tests/web-hub/contract/types.test-d.ts:288` 精确钉住）。

### 2.3 registry 的 `remove()`、`agent_removed` 事件与订阅清理（闭合 r1 #4，B-stream）

- `hub/registry.ts` 的 `Registry` 新增：
  ```ts
  /** live|claiming && !allowConnected ⇒ "online"；记录存在 ⇒ down(r,"removed") 复用既有清理，再 publish agent_removed ⇒ "removed"；
   *  记录不存在 ⇒ 只 publish agent_removed ⇒ "absent"（幂等） */
  remove(agentKey: string, opts: { allowConnected: boolean }): "removed" | "absent" | "online";
  ```
- `hub/ports.ts` 的 `HubEvent` 追加 `| { type: "agent_removed"; agentKey: string }`。已核对：所有 bus 订阅者都没有穷尽检查（`commands.ts:218`、`history.ts:344`、`run-transcript.ts:634`、`hub.ts:713/782`、`supervisor.ts:365`）。
- `hub/http.ts` 的 `onHubEvent`（`:729`）新增分支，**严格按此顺序**：
  ```ts
  case "agent_removed":
    dropAgent(e.agentKey);                                        // fleetCache + 进行中的订阅快照（runSnapshot 的 getPending 守卫会让它提前返回，:822）
    for (const c of sse.list()) c.subscribed.delete(e.agentKey);  // ← r1 #4：清掉 scoped 订阅
    sse.publish("agent_removed", { agentKey: e.agentKey });
    break;
  ```
  效果：同一 agentKey 重现（§3）后，hub 不会再把它的 `ev`/`gap`/`append` 推给旧订阅者。浏览器端重现的是 `newAgent`（`history:"none"`、`sub:null`）；该 agent 被选中时，useHub 会重新 `/api/subscribe` → `history` 快照 → 增量，满足 B-stream。LAN 和 loopback 共用同一个 `createRoutes` 产物，两面同时生效。
- **不复用 `agent_down{reason:"removed"}`**：`bye.reason` 是 agent 可以任意填写的字符串（`protocol/messages.ts:404,659`）。
- 补发顺序不受影响：`sse.attach` 先补发 ring（新客户端的 `subscribed` 为空，scoped 帧不补发），然后 `openEvents` 才发权威快照（`sse.ts:217-222`、`http.ts:838-848`）。

### 2.4 删除端点：按 agentKey 或 spawnId 指定目标（闭合 r1 #2）

`POST /api/agents/remove`，body 二选一：`{ "agentKey": "…" }`（AgentCard 用）或 `{ "spawnId": "…" }`（SpawnRow 用）。新模块 `hub/agent-remove.ts` 按下表判定：

判定前先解析目标记录 `rec`，**与 listener 无关**：只要 spawn 功能开启（supervisor 存在）就查（`spawnId` ⇒ 同 id 记录；`agentKey` ⇒ `sup.lookupByAgentKey(key)`）。另算一个布尔量 `managedAllowed = listener === "loopback" || spawnCfg.lan !== "off"`，和 stop 的 LAN 门一致（`routes.ts:715-718,736`、`http.ts:1257`），它**只决定能否对托管进程采取动作，不决定查不查**（consult 复核补充 C2）。

| #   | 条件                                                                                        | 动作                                                                                                                                                                                                                                                           | 响应                                                                             |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `spawnId` 形式，且 spawn 功能关闭或 `!managedAllowed`                                       | 不做任何事                                                                                                                                                                                                                                                     | **404** `E_NOT_FOUND`（与 `/api/headless` 未启用时一致）                         |
| 2   | `spawnId` 形式，`rec` 不存在                                                                | 不做任何事                                                                                                                                                                                                                                                     | **200** `{removed:true}`（幂等）                                                 |
| 3   | 找到 `rec`，且 `managedAllowed`                                                             | `sup.remove(rec.spawnId, deadline)`：`removed` → 200（卡片随 `onRemoved` 广播消失）；`pending` → **202** `{removed:false,pending:true,spawnId,state:"stopping"}`；`exit-unconfirmed` → **409** `E_AGENT_ONLINE{reason:"exit-unconfirmed"}`；`E_DEADLINE` → 504 | 见左                                                                             |
| 4   | 找到 `rec`（`agentKey` 形式），但 `!managedAllowed`（LAN 且 `spawn.lan=off`），`rec` 非终态 | **不删卡片，不停进程**                                                                                                                                                                                                                                         | **403** `E_SPAWN_DENIED{reason:"lan-off"}`（复用既有错误码，`http-contract.ts`） |
| 5   | 同上但 `rec` 为终态：`sup.deathOf(rec)`                                                     | `confirmed` ⇒ `registry.remove(key,{allowConnected:true})`，**只删卡片**，spawn 记录不动（LAN 侧无权改 spawn 面），返回 200；`alive`/`unknown` ⇒ **409** exit-unconfirmed                                                                                      | 见左                                                                             |
| 6   | `agentKey` 形式，没有托管记录（或 spawn 功能关闭）                                          | `registry.remove(key, {allowConnected:false})`：`online` → **409** `E_AGENT_ONLINE{reason:"online"}`；`removed`/`absent` → **200**                                                                                                                             | 见左                                                                             |

为此 supervisor 需要额外公开一个**只读**方法 `deathOf(spawnId): Death | undefined`，与 §2.1 的私有判定共用实现。

- **不变量**：任何托管记录对应的卡片，只有在「supervisor 执行删除（含停止梯）」或「死亡已确认」两种情况下才会被移除；绝不出现「卡片删了、进程照跑」（B-alive）。v2 初稿在 LAN 且 `spawn.lan=off` 时会把托管请求回退到 `registry.remove`，对断连但仍在运行的托管进程只删卡片、不停进程，这一缺口由第 4、5 行闭合。
- **离线 TUI 和外部 rpc 卡片**（拍板 #4、#5）只走第 4 行，**从不发信号**。

### 2.5 删除后不会重新 fork（闭合 r1 #3，B-fork）

`hub/spawn/routes.ts` 的 `handleSpawn` 幂等分支（`:481-516`）：LRU 命中、digest 一致、**但记录已不存在** ⇒ **不再落穿，不 fork**，改为：

```ts
rejectAudit(io, auth, { endpoint: "spawn", reqId: intent.id, spawnId: dup.spawnId, code: "E_BAD_REQUEST" });
io.sendJson(res, 409, { error: "E_BAD_REQUEST", reason: "spawn-gone", spawnId: dup.spawnId });
```

- 不消耗创建令牌：这一步仍在 gate 7 之前，与「幂等命中不扣令牌」一致。
- 这一改动同时收紧了一个既有边角：记录被 retention trim 掉后，同一 id 在 10 分钟内重放也不再 fork。方向更安全，**不需要 tombstone**。模块头注释中「defensive」那段同步改写。
- UI：`logic/spawn.js` 的 `classifySpawnError` 增加：`E_BAD_REQUEST` 且 `reason==="spawn-gone"` ⇒ 新 kind `"gone"`（DirPicker 文案「该会话已被删除，请重新发起」）。
- 测试：删除后在 TTL 内用同一 id 重放 POST ⇒ 409 spawn-gone，`spawnFn` 调用次数不变，`spawns.json` 不出现新记录。

### 2.6 删除意图持久化与重启恢复（闭合 r1 #6）

- `store.ts`：`StoredRecord.removeIntent?: true` 和 `noProcess?: "never-forked"|"boot-changed"`（§2.1）；`isRecordShapeOk` 增加校验：`removeIntent` 存在时必须 `=== true`，`noProcess` 存在时必须是两个枚举值之一。`supervisor.toStored`（`:439-465`）写入这两个字段，`revive`（`:1193-1218`）把 `removeIntent` 映射为 `removePending`，`noProcess` 原样保留。不升级文件版本 `SPAWNS_FILE_VERSION`，因为未知字段对旧 hub 透明（§1.2）。
- `init()` 恢复（`:1340-1381` 循环之后，`recoverEscalate` 都已排队）：
  - **终态记录且带 `removeIntent`**：`deathOf` 为 `confirmed` ⇒ 当场删除；否则放入「待确认」集合。
  - **非终态记录且带 `removeIntent`**：照常 `finalizeRecovered` + `recoverEscalate`（L3–L5 不变），然后放入「待确认」集合。
  - 「待确认」集合在一个 **unref 的单次定时器**里统一处理，延迟 `RECOVER_KILL_AFTER_MS + EXIT_GUARD_MS`（3s + 5s）：逐条 `deathOf`，`confirmed` ⇒ `deleteRecord`；其余 ⇒ 清除意图（拍板 #3 的同构：放弃删除），`persistDebounced`、`schedulePush`，审计 `code:"E_EXIT_UNCONFIRMED"`。定时器在 `shutdown` 里清除。
  - 重启后 registry 是空的，`onRemoved` 发出的 `agent_removed` 只是一个无害的幂等广播；浏览器靠重连时的快照对齐。
- 优雅 shutdown（`:1417-1462`）：预算内退出的子进程走 `finalizeTerminal` 完成删除，并由 `store.flushAndClose` 落盘；没退出的仍以 `stopping + removeIntent` 写盘，由下次启动按上面的流程恢复。
- **降级 D-6（显式口径）**：`saveNow` 失败（磁盘满等）时，意图只在内存里，此时 hub 崩溃会丢失意图。结果是记录以 `exited/orphan` 留下：exited 不渲染，卡片按 registry 的真相显示，进程若存活且重连，卡片会如实重现。**三条底线都不受影响**，只是残留一条不可见的记录，按 20 条保留上限滚掉。

### 2.7 SSE 顺序：冻结一种，测试只在确定性层面断言（闭合 r1 #5）

`schedulePush` 是 microtask 合并（`:509-521`），推送时才读 `publicPayload()`。`registry.publish` 是同步的。因此**实际且冻结的顺序**是：

1. 发起删除的那个宏任务里：`spawns{state:"stopping", removing:true}`（microtask）；
2. 子进程退出的那个宏任务里：同步段 `finalizeTerminal → deleteRecord → onRemoved → registry.remove` 依次产生 [`agent_down{reason:"removed"}`（仅当 registry 记录仍在）] → `agent_removed`；随后 microtask 发出 `spawns`，其中**已不含该记录**。由于读快照发生在删除之后，被删记录**永远不会**以 `exited` 状态出现在任何推送里。
3. 立即删除（终态 confirmed）的路径同理：`agent_removed` 先于不含该记录的 `spawns`。

`agent_down` 可能更早出现（socket 先于 exit 关闭），这不违反上述顺序。

**测试口径**：supervisor 级测试用 fake registry、fake bus 和 fake 时钟，**精确断言上述顺序**（确定性环境）；http 层和真进程集成测试**只断言最终状态**（spawns 不含记录、`agent_removed` 已到达、`agents` 快照不含 key）。UI reducer 对 `agent_removed` 和 `spawns` 的到达顺序不做任何依赖。

### 2.8 live 托管会话删除时序与卡片表现

```
UI 二次确认 ──POST {agentKey}──▶ remover ──▶ sup.remove ⇒ saveNow(removeIntent) + enterStopping ⇒ 202 pending
  所有标签页：卡片保留，显示 chip「removing…」；删除按钮变为禁用的 loader 态（removing:true 驱动）
  停止梯：stdin EOF（通常立即退出）… 最迟 ~13s 进入 guard
  exit ⇒ finalizeTerminal ⇒ deathOf：confirmed ⇒ deleteRecord ⇒ onRemoved ⇒ agent_removed ⇒ 所有标签页卡片消失
                                   alive/unknown ⇒ 清除 removing ⇒ 卡片恢复（拍板 #3）；再删 ⇒ 409 exit-unconfirmed
```

由 hub 编排的理由（同 v1）：发起删除的标签页可能被关掉；移除时机必须锚在 hub 内部的死亡确认上；多端一致。

### 2.9 装配

- `hub/agent-remove.ts`：`createAgentRemoveService({ registry, managed?: { sup, lan }, log, now })` → `{ handle(req, res, io: AgentRemoveIo) }`。`AgentRemoveIo` 是 `SpawnRouteIo` 去掉 `scheme/viaTrustedProxy`（`spawn/ports.ts:48-60`）。限流器在模块内自建（`createCmdLimit(now)`，同 `hub.ts:551`）。
- `hub.ts`：构造 service，经 `FrontendDeps.agentRemove?`（`hub/ports.ts` 中 FrontendDeps 追加可选字段，在 `hub.ts:635` 处组装）传入；LAN 侧经 `LanRuntime`（`http.ts:928`、`:2276`）透传。不要塞进只读的 `FrontendDeps.registry`。
- `http.ts`：两个 listener 都在 file-search 分支之后、通用 `POST` 分支之前插入 `if (deps.agentRemove && method === "POST" && path === AGENT_REMOVE_PATH)`，位置在 loopback `:2540` 附近、LAN `:1320` 附近。authorize 段照抄同 listener 的 cmd 分支。service 缺席时落到原有路径，表现为 404。

---

## 3. 已离线 TUI 被移除后又重新上线

- agentId = `{pid, nonce}`，nonce 是进程级随机数，跨 `/reload`、`/new`、`/resume` 不变（`agent/connection.ts:79-86`）。agentKey = `a${pid}-${nonce.slice(0,6)}`（`registry.ts:239-246`），即「一个 pi 进程实例」。
- `registry.remove` 走 `down()`，会清掉 `byAgentId` 映射（`:223-224`）。同一进程 re-hello 时于是**新建记录**，通常回到同一个 agentKey，发布 `agent_up` → **卡片重现**。重现后历史流是干净的：hub 侧旧的 scoped 订阅已在 §2.3 清掉，浏览器侧是 `newAgent`，需要重新订阅。
- 竞态：remove 和 register 都是同步执行。register 先到 ⇒ 409；remove 先到 ⇒ 卡片重现。

---

## 4. HTTP / 协议契约

### 4.1 端点

| 项    | 规定                                                                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路径  | `POST /api/agents/remove`；常量 `AGENT_REMOVE_PATH` 放在 `protocol/http-contract.ts`，UI 的 `contract.js` 从这里 import                                                                       |
| body  | ≤4 KiB；严格 schema：`{agentKey: /^[A-Za-z0-9_-]{1,128}$/}` **或** `{spawnId: SPAWN_ID_RE}`，二者**恰好其一**，`additionalProperties:false`；413/408 回复后关闭连接（照抄 `sendConnClosing`） |
| CSRF  | `strictCsrfOk`（JSON + `X-PWH:1` + Origin + Sec-Fetch-Site，`http.ts:1185-1201`），失败 403 `E_CSRF`                                                                                          |
| 鉴权  | loopback：`auth.check`；LAN：`requireLanSession`（照抄 cmd 分支 `http.ts:1324-1331`）。单次鉴权（同 stop）                                                                                    |
| owner | 不检查（arch §6.0 #8「同 hub 全信任」）                                                                                                                                                       |
| 限流  | 每主体令牌桶 `${listener}:${user ?? "token"}:remove`，容量 10、每 2s 回填（同 stop，`routes.ts:86-87`），429 + Retry-After，429 审计按 60s 节流                                               |
| 预算  | 总预算 `WRITE_TOTAL_MS`（13s）；body 读取用 `deriveBudget(BODY_CAP_MS, BODY_RESERVE_MS)`；`sup.remove` 需要 ≥ `INTENT_MIN_REMAINING_MS` 的余量，不足时 504 `E_DEADLINE`                       |
| 响应  | 200 `{removed:true}`；202 `{removed:false,pending:true,spawnId,state:"stopping"}`；409 `E_AGENT_ONLINE{reason:"online"                                                                        | "exit-unconfirmed"}`；403 `E_SPAWN_DENIED{reason:"lan-off"}`（LAN 且 `spawn.lan=off`时的非终态托管会话）；404`E_NOT_FOUND`（只出现在 spawnId 形式、托管面不可用时）；400/401/403(CSRF)/429/413/408/504 |
| 幂等  | pending 中重复请求 ⇒ 202；已删除 ⇒ 200                                                                                                                                                        |

### 4.2 审计

- 在 `hub/audit.ts` 新增 `auditRemove` 通道和白名单 `REMOVE_AUDIT_KEYS = ["phase","listener","ip","user","agentKey","spawnId","outcome","code","reason"]`。
- `SpawnAuditRecord.phase` 联合追加 `"remove"`，`endpoint` 联合追加 `"remove"`（`supervisor.ts:97-127`；`SPAWN_AUDIT_KEYS` 无需改动）。
- 「删除后重放」被拒时写一行 `endpoint:"spawn"` 的 reject 审计，带 `spawnId`。

### 4.3 protocol 层改动（冻结面，append-only，不 bump PROTO：没有新增 agent↔hub 帧，见 `protocol/version.ts:10-16`）

| 文件                        | 改动                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol/http-contract.ts` | ① `SSE_EVENTS` 在 `"spawns"` **之前**插入 `"agent_removed"`（`.at(-1)==="spawns"` 被 `spawn.test.ts:225` 钉住）；② `API_ERRORS` **尾部**追加 `"E_AGENT_ONLINE"`；③ `AGENT_REMOVE_PATH`；④ 类型 `AgentRemoveRequest = {agentKey:string} \| {spawnId:string}`、`AgentRemoveResult`、`AgentRemoveErrorReason = "online" \| "exit-unconfirmed" \| "lan-off"`（`lan-off` 随 403 `E_SPAWN_DENIED` 返回）、`AgentRemovedPayload` |
| `protocol/spawn.ts`         | `SpawnRecordPublic.removing?: true`；导出 `SPAWN_GONE_REASON = "spawn-gone"`，给 routes 和 UI 共用                                                                                                                                                                                                                                                                                                                        |
| 测试钉                      | `tests/web-hub/protocol/preview.test.ts:83` 改为断言 `launcher+5 === "E_AGENT_ONLINE"`，`+6` 为 undefined；新增 `tests/web-hub/protocol/agent-remove.test.ts`                                                                                                                                                                                                                                                             |

---

## 5. 前端

### 5.1 reducer（`ui/src/logic/state.js`）

- `State.removed: ReadonlySet<string>`，有界 64 条 FIFO。
- `case "agent_removed"`：从 `agents`/`order` 删除该 key，加入 `removed`，调用 `withSelection`。
- `case "agent_up"` / `case "agents"`：把重新出现的 key 移出 `removed`。重现的卡片走 `newAgent`（`sub:null`、`history:"none"`），由 useHub 现有的订阅逻辑重新订阅。

### 5.2 纯逻辑（新增 `ui/src/logic/remove.js`）

```js
/** AgentCard 用：
 *  {kind:"managed", spawnId, removing} | {kind:"offline"} | null */
export function removalTargetForAgent(agent, spawns)
//  1) spawns 里 agentKey===agent.key 且 state ∈ {starting, live, stopping} 的最新记录 ⇒ managed（覆盖已绑定 key 的 starting）
//  2) agent.down || agent.card?.state === "stale" ⇒ offline（直接看 down/state，不看 visualState）
//     — 终态托管记录的离线卡片也归这里，hub 会按 §2.4 第 3 行查出记录并做死亡确认
//  3) 否则 null（在线的非托管卡片）
/** SpawnRow 用：rec.state ∈ {starting, failed} ⇒ {kind:"spawn", spawnId, removing}；否则 null */
export function removalTargetForSpawn(rec)
export function classifyRemoveError(outcome) // "online" | "unconfirmed" | "managedLan" | "rate" | "unsupported" | "network"
```

v1 的矛盾（`managedFor` 不含 starting，而 v1 测试声称覆盖 starting）在 v2 里消解：AgentCard 只负责「已绑定 agentKey」的记录，未绑定的 starting 和 failed 由 SpawnRow 按 spawnId 负责。两个入口合起来覆盖托管会话的全部状态。

### 5.3 传输层（additive optional）

- `contract.js`：`API.agentRemove = AGENT_REMOVE_PATH`。
- `token-client.js` / `password-client.js`：`removeAgent(target)`，`target = {agentKey} | {spawnId}`，形状照抄 `spawn.stop`（`token-client.js:600-618`），token 端套 `withRelogin`（端点幂等）。
- `transport/types.ts`：`RemoveTarget`、`RemoveAgentOutcome = {ok:true; removed:boolean; pending?:true; spawnId?:string} | {ok:false; error:string; reason?:string; retryAfterS?:number}`，以及 `HubTransport.removeAgent?(target)`。
- `transport/token.ts`（`withAuthNotice`）和 `transport/password.ts`（`REST_AUTH_PATHS` 加入 `API.agentRemove`）。
- `types.ts` 的 `HubHandle.removeAgent?`；`useHub.ts` 提供实现，transport 缺失时降级为 `E_UNSUPPORTED`。

### 5.4 UI 组件

- 新建 `components/agents/RemoveButton.vue`，props `{ target: RemoveTarget; removing: boolean; ariaKind: "agent"|"managed"|"spawn" }`：两步 arm（逐行照抄 `DetailHeader.vue:83-124`，`REMOVE_ARM_MS=4000`，Esc 解除，`onUnmounted` 清理）。三种态：idle（图标 `x`）、armed（「再次点击确认删除」，红底）、busy（loader）。`removing` 为真时显示禁用的「removing…」。失败时显示一行 `role="status"` 的文案，6s 后或下一次 arm 时清除。**不做乐观删除**，一切以 `agent_removed`/`spawns` 为准。
- `AgentList.vue`：卡片 `<li class="agent-item">` 里，在 `<AgentCard>` 之后挂 `<RemoveButton>`（按钮不能嵌进 `<a>`，`AgentCardProps` 冻结），live 组和离线组都要挂（`:268-274`）。
- `components/spawn/SpawnRow.vue`：在现有「关闭」旁加 `<RemoveButton :target="{spawnId}">`，**「关闭」保持原样**。
- `AgentCard.vue`：`removing` 时在 row1 加 chip「removing…」，走 inject 模式，不改 props。
- `DashboardView.vue`（`:199-205`、`:221-227`）：路由 key ∈ `state.removed` ⇒ 渲染「已删除」空态（拍板 #2），否则维持 not-connected。
- 样式 `agents.css`、`spawn.css`：`.agent-item{position:relative}`；`.removable > .agent-card{padding-right:calc(52px*var(--fs-scale,1))}`；按钮绝对定位在右下角，命中区 ≥40×40；`@media(hover:hover)` 下在 hover、focus-within、armed、busy 时显示，`@media(hover:none)` 下始终显示。按钮是兄弟元素，不受 offline 卡片 `opacity:.55` 影响。
- i18n（zh/en 并行，`i18n-parity` 强制一致）：

| key                          | zh                                             | en                                                              |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| agents.remove                | 删除                                           | Delete                                                          |
| agents.removeConfirm         | 再次点击确认删除                               | Click again to delete                                           |
| agents.removeAria            | 从列表删除这个会话（会话文件保留）             | Delete this session from the list (session file is kept)        |
| agents.removeManagedAria     | 停止并删除这个由网页启动的会话（会话文件保留） | Stop and delete this web-started session (session file is kept) |
| spawn.removeAria             | 停止并删除这个网页发起的会话记录               | Stop and delete this web-started session record                 |
| agents.removing              | removing…                                      | removing…                                                       |
| agents.removeFailed          | 删除失败：{reason}                             | Delete failed: {reason}                                         |
| agents.removeErr.online      | 会话仍在线                                     | the session is still online                                     |
| agents.removeErr.unconfirmed | 无法确认进程已退出，已保留                     | could not confirm the process exited; kept                      |
| agents.removeErr.managedLan  | 网页托管的会话，局域网侧无权停止               | web-managed session; cannot be stopped from the LAN             |
| agents.removeErr.rate        | 操作太频繁，稍后再试                           | too many requests, retry shortly                                |
| agents.removeErr.unsupported | hub 版本不支持，请刷新页面                     | hub does not support this, reload the page                      |
| agents.removeErr.network     | 网络错误                                       | network error                                                   |
| spawn.errGone                | 该会话已被删除，请重新发起                     | This session was deleted; start a new one                       |
| detail.removedTitle          | 会话已从列表删除                               | Session removed from the list                                   |
| detail.removedBody           | 会话文件仍保留，可在终端用 pi 恢复。           | The session file is kept; resume it from a terminal with pi.    |

---

## 6. 文件域拆包表

| 包                | 内容                                                                                                                      | 文件域（独占）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 依赖  | 执行者                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------------- |
| **P0 冻结面**     | §4.3                                                                                                                      | `src/web-hub/protocol/http-contract.ts`、`src/web-hub/protocol/spawn.ts`、`tests/web-hub/protocol/preview.test.ts`、`tests/web-hub/protocol/agent-remove.test.ts`（新）                                                                                                                                                                                                                                                                                                                                                        | —     | 主会话 L0 或小包，**先合入**  |
| **P1 后端**       | §2.1–2.7、§2.9、§4.1–4.2                                                                                                  | `src/web-hub/hub/{registry.ts,ports.ts,http.ts,agent-remove.ts(新),audit.ts,hub.ts}`、`src/web-hub/hub/spawn/{supervisor.ts,project.ts,store.ts,routes.ts}`；测试 `tests/web-hub/hub/{registry,agent-remove(新),audit}.test.ts`、`tests/web-hub/hub/spawn/{supervisor,project,store}.test.ts`、`tests/web-hub/http/{api-agent-remove(新),lan-agent-remove(新),api-headless}.test.ts`、`tests/web-hub/http/spawn-kit.ts`（fake supervisor 增加 `remove`/`lookupByAgentKey`）、`tests/web-hub/hub/hub-spawn.test.ts`（重启恢复） | P0    | `general`                     |
| **P2 前端**       | §5、§2.5 的 UI 半边                                                                                                       | `src/web-hub/ui/src/logic/{state.js,remove.js(新),spawn.js,contract.js,token-client.js,password-client.js}`、`ui/src/transport/{types.ts,token.ts,password.ts}`、`ui/src/{types.ts,composables/useHub.ts}`、`ui/src/components/agents/{AgentList.vue,AgentCard.vue,RemoveButton.vue(新)}`、`ui/src/components/spawn/SpawnRow.vue`、`ui/src/components/shell/DashboardView.vue`、`ui/src/i18n/{zh,en}/{agents,detail,spawn}.ts`、`ui/src/styles/{agents,spawn}.css`；测试见 §7.2                                                | P0    | `frontend-dev`，worktree 隔离 |
| **P3 真进程集成** | §7.3                                                                                                                      | `tests/integration/web-hub-headless.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | P1    | P1 收尾或单独小包             |
| **P4 文档**       | AGENTS.md `src/web-hub/` 一节；`docs/dev/web-hub-spawn/arch.md` §8.2 端点表 + §7.7 记录字段 `removeIntent` + 幂等口径变化 | `AGENTS.md`、`docs/dev/web-hub-spawn/arch.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P1+P2 | 主会话                        |

P1 和 P2 在 P0 合入后并行，唯一共享面是 P0（两包都只读）。**v2 新增的冻结约定**：`removing` 字段、`spawn-gone` reason 和 `E_AGENT_ONLINE` 的 reason 取值全部定义在 P0 的 protocol 文件里，P1、P2 不得各自发明字面量。

---

## 7. 测试计划

### 7.1 后端（P1）

- **registry**：`remove` 四个分支，包括 `allowConnected`；stale 删除后同一 agentId 重新 register ⇒ 同 agentKey，`reclaimed:false`，发 `agent_up`。
- **supervisor**（fake 时钟、fake `/proc`、fake registry）：
  - `deathOf` 真值表：pid 缺失；真实 exit；unconfirmed + ENOENT；unconfirmed + EACCES ⇒ unknown；starttime 不符；Z 态；uid 不符；bootId 不同；身份四元组不全；匹配 ⇒ alive。
  - live → `remove` ⇒ `saveNow` 被调用且快照含 `removeIntent`；`removing:true` 被推送；exit 后记录被删，`onRemoved` 调用一次。
  - **r1 #1 回归**：guard 路径（exit unconfirmed，probe alive）⇒ 放弃删除、`removing` 清除、记录保留；随后再次 `remove`（registry 已无该 key）⇒ `E_AGENT_ONLINE{exit-unconfirmed}`，**记录仍在**；把 fake `/proc` 改成 ENOENT 后再 `remove` ⇒ `removed`。
  - 终态 + `exit` undefined + pid 已知（failSpawnError 路径）⇒ 必须走 probe。
  - **r1 #5**：一个宏任务内断言事件顺序：`agent_down`（若有）→ `agent_removed` → `spawns`（不含记录），且被删记录从未以 exited 出现在任何推送中。
  - **r1 #6**：init 时带 `removeIntent` 的四种组合（终态 confirmed ⇒ 立即删；终态 unconfirmed + 定时器到点 probe gone ⇒ 删；非终态 ⇒ finalizeRecovered + escalate，到点 probe alive ⇒ 放弃并清除意图）；shutdown 会清除定时器；`saveNow` 失败 ⇒ 删除照常继续（降级 D-6）。
  - `findByAgentKey` 和 `isManaged` 原有用例不变。
- **store**：`removeIntent`、`noProcess` 的往返读写；非法值 ⇒ 形状失败；旧格式文件（无这两个字段）照常读取。
- **C1 回归**（supervisor）：①pin 失败或 spawnFn 抛错 ⇒ 记录带 `noProcess:"never-forked"`，删除 ⇒ `removed`；②模拟「fork 后、pid 落盘前崩溃」：spawns.json 里只有一条 launching 意图，重启时 environ 扫描未命中 ⇒ 记录为 `failed`、没有 `noProcess` ⇒ 删除返回 409 exit-unconfirmed，**记录保留**；③bootChanged 恢复的 launching 记录带 `noProcess:"boot-changed"`，删除 ⇒ `removed`。
- **project**：两套投影都输出 `removing`；首条 prompt 正文哨兵测试照常通过。
- **agent-remove**（单元）：§2.4 判定表逐行覆盖；LAN 且 `spawn.lan=off` 时的两种情况；body 二选一校验（两个都有、都没有 ⇒ 400）。
- **http/api-agent-remove**：CSRF 四件套、401、413、400、429；SSE 收到 `agent_removed`；**r1 #4 顺序测试**：客户端订阅 K（stale）→ remove → 同 agentId 重新 register → agent 发出 `ev` ⇒ 该客户端**收不到**；重新 `/api/subscribe` 后先收到 `history`，再收到 `ev`。
- **http/api-headless（r1 #3）**：POST id=X 拿到 202 → 删除记录 → 10 分钟内重放 id=X ⇒ 409 `spawn-gone`，`spawnFn` 调用次数不变，没有新记录，不扣创建令牌；digest 不同的情况仍是原来的 409。
- **http/lan-agent-remove**：LAN 鉴权；`spawn.lan=off` 时：spawnId 形式 ⇒ 404；**C2 回归**：托管记录非终态且 registry 为 stale（进程断连但仍在运行）⇒ 403 `E_SPAWN_DENIED{lan-off}`，registry 记录和 spawn 记录都不动，`agent_removed` **不广播**，进程未收到任何信号；托管终态且 `deathOf=confirmed` ⇒ 200，只删卡片，spawn 记录保留；托管终态 unknown ⇒ 409。
- **hub-spawn**（进程内装配）：带 `removeIntent` 的 spawns.json 冷启动后被正确收敛（真实 store + fake `/proc`）。

### 7.2 前端（P2）

- `logic-state.test.ts`：`agent_removed` 会删卡、写入 `removed`；同 key `agent_up` 后卡片回来、`sub:null`、`history:"none"`，且移出 `removed`；`agents` 快照会清理 `removed`；有界淘汰。
- `logic-remove.test.ts`（新）：两个 target 函数的真值表；`classifyRemoveError` 区分 online 和 unconfirmed。
- `logic-spawn.test.ts`：`classifySpawnError` 能识别 `spawn-gone`。
- `agent-list.test.ts`：可删的卡片才有按钮；arm、4s 解除、Esc、二击才调用 `removeAgent({agentKey})`；busy；失败文案；`removing` 时禁用；按钮不在 `<a>` 内。
- `spawn-row.test.ts`（新，或并入 agent-list）：starting 和 failed 行有删除按钮，二击调用 `removeAgent({spawnId})`；「关闭」行为不变。
- `dashboard-view.test.ts`：路由 key ∈ removed ⇒ 「已删除」空态。
- `transport-contract.test.ts` 和两个 client 测试：两种 target、200/202/409(reason)/429/网络错误映射一致；`logic-contract.test.ts` 钉住 `API.agentRemove`。
- `use-hub.test.ts`：transport 缺失时降级为 `E_UNSUPPORTED`。

### 7.3 真进程集成（P3，Linux only，mode B harness `:492+`）

1. live → remove(agentKey) → 202 → 最终状态：spawns 不含记录，`agent_removed` 已到达，spawns.json 不含记录，会话 jsonl 文件仍在。
2. starting 阶段（fake-pi 延迟 hello）→ remove(spawnId) → 202 → 子进程被停止，记录被删除。
3. 删除后在 TTL 内重放创建请求（同一 id）⇒ 409 spawn-gone，进程数不变（通过 spawns.json 和 `/proc` 计数）。
4. 杀掉 hub（SIGKILL）时有一条 `removeIntent` 的 live 记录 → 重启 → reaper 回收进程 → 约 8s 后记录被删除（spawns.json 不含它）。

### 7.4 门禁

`npm run format:check && npm run typecheck && timeout 280 npx vitest run && npm run build && npm run build:web`。

---

## 8. 验收锚点

| #   | 断言                                                                                                                                                                    | 来源                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| A1  | 在线 TUI 卡片没有删除按钮；curl 删除 ⇒ 409 `E_AGENT_ONLINE{online}`                                                                                                     | UI + api + 真机                 |
| A2  | 离线 TUI 两步删除 ⇒ 所有标签页同步去掉卡片，刷新后不再出现                                                                                                              | 真机，两标签 + 手机             |
| A3  | stale TUI 删除后进程重连 ⇒ 卡片重现，且详情页的 transcript 完整、不重复（先 history 后增量）                                                                            | registry + http 顺序测试 + 真机 |
| A4  | 托管 live 删除：卡片显示「removing…」⇒ 卡片消失；jsonl 仍在，终端可 resume                                                                                              | P3-1 + 真机                     |
| A5  | 托管 starting 和 failed 可以从 SpawnRow 删除                                                                                                                            | P3-2 + UI 测试                  |
| A6  | **B-alive**：停止梯 unconfirmed 且进程仍活 ⇒ 卡片恢复；之后无论 registry 状态如何，再删都返回 409 exit-unconfirmed，记录保留                                            | supervisor 回归测试             |
| A7  | **B-fork**：删除后重放创建请求 ⇒ 409 spawn-gone，不 fork                                                                                                                | api-headless + P3-3             |
| A8  | **B-stream**：删除后同 key 重连，旧 SSE 客户端收不到孤立增量                                                                                                            | http 顺序测试                   |
| A9  | hub 崩溃重启后删除意图被完成（进程已回收）或显式放弃（进程仍活）                                                                                                        | supervisor + P3-4               |
| A10 | 被删会话的详情页显示「已删除」空态，不自动跳转                                                                                                                          | dashboard + 真机                |
| A11 | LAN 下可删离线卡片；`spawn.lan=off` 时：live 托管会话没有按钮（hub 返回 409 online），断连中的托管会话删除返回 403 lan-off 且**进程和卡片都不动**，spawnId 形式返回 404 | lan 测试（C2）                  |
| A15 | **B-alive（C1）**：没有「无进程」证据的 pid 缺失记录（崩溃窗口里的 launching）不可删，返回 409，记录保留                                                                | supervisor C1 回归              |
| A12 | arm、4s、Esc、二击才发请求；移动端可点；触屏设备上按钮始终可见；150%/200% 字号不遮挡                                                                                    | UI + 真机                       |
| A13 | 审计：每次请求一行 `audit:"remove"`；supervisor 的 `phase:"remove"`（含 `E_EXIT_UNCONFIRMED`）；删除后重放有 reject 行                                                  | audit + hub.log                 |
| A14 | 不 bump PROTO；`SSE_EVENTS.at(-1)==="spawns"`；`API_ERRORS` 只在尾部追加                                                                                                | protocol 测试                   |

---

## 9. 风险与回滚

| #   | 风险                                                                                                    | 缓解 / 接受理由                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | unconfirmed 的托管会话永远删不掉（进程卡在 D 态）                                                       | 这正是 B-alive 要求的行为：拒绝并保留记录。进程真正消失后，`probeIdentity` 会放行。是否增加「身份复验后重发 SIGKILL」的恢复路径另案处理，见 §10 后续项，v2 不做 |
| R2  | 收紧幂等后，retention trim 掉的记录在 10 分钟内重放也会被拒                                             | 方向更安全；该边角在当前限流下（每主体 3 次/分钟、保留 20 条终态）几乎不可达                                                                                    |
| R3  | `saveNow` 失败时意图只在内存（降级 D-6）                                                                | 三条底线不受影响；残留一条不可见的终态记录                                                                                                                      |
| R4  | 删除终态记录会让 DirPicker 的「已知目录」少一个来源（`hub.ts:487`）                                     | 最坏结果只是多一次确认，属于安全方向                                                                                                                            |
| R5  | 任意已认证主体都能广播无主 key 的 `agent_removed`                                                       | 「同 hub 全信任」；在线卡片会被拒；有限流                                                                                                                       |
| R6  | 冻结面撞车                                                                                              | P0 先单独合入；开工前 `git log` 查重                                                                                                                            |
| R7  | 旧前端缓存遇上新 hub                                                                                    | 未知事件被忽略，卡片停留到刷新                                                                                                                                  |
| R9  | 崩溃窗口里的 launching 记录（扫描未命中、无 `noProcess` 证据）永远删不掉，SpawnRow 会一直显示 failed 行 | 这是 B-alive 要求的保守行为；本地「关闭」可以隐藏它；按 20 条终态保留上限自然滚掉。触发条件是 hub 在「fork 与 pid 落盘之间」的微秒级窗口内崩溃                  |
| R10 | LAN 且 `spawn.lan=off` 时，局域网用户无法删除断连中的托管会话                                           | 与「LAN 不能 stop 托管会话」的既有口径一致；返回 403 明确失败，绝不静默只删卡片                                                                                 |
| R8  | 清 `client.subscribed` 时，正在打开该 agent 详情页的标签页失去订阅                                      | 它的卡片已同时被删除，显示「已删除」空态；卡片重现后会重新订阅                                                                                                  |

**回滚（r1 #7）**：①**代码可回滚**：最小回滚是让两个 `removalTarget*` 恒返回 null，按钮消失；完整回滚按 P2 → P1 → P0 顺序 revert。`spawns.json` 新增的 `removeIntent` 字段对旧 hub 透明，回滚后被忽略，下次写盘时丢弃。②**已删除的 spawn 元数据不可恢复**：记录、退出码、hint、stderr 日志指针一旦删除，回滚也找不回；stderr 日志文件本身按既有 sink 轮转策略留存。③**会话 jsonl 不受影响**：删除从不触碰 `~/.pi/agent/sessions/`，终端 `pi` 始终可以 resume。

---

## 10. 待确认 / 后续

- v1 的 6 个待确认点已由文末「用户拍板」全部裁定。
- **v2 新增，需用户知悉（低风险）**：SpawnRow（starting/failed 的托管占位行）也增加两步「删除」入口，「关闭」保持不变（§0.3）。推荐采纳：不加的话，未绑定 agentKey 的托管会话没有任何删除途径，无法满足「托管会话任意状态可删」。
- 后续项（不在本方案范围）：unconfirmed 且身份复验仍匹配（`alive`）时，是否提供「身份复验后重发 SIGKILL，再删除」的恢复路径。需要单独评审 L5 语义。

---

## r1 评审处置（review:delete-session，gpt-5.6-sol）

| #   | 级别                              | 意见摘要                                                                                                 | 处置                                                                                                                                                                                                                                                                                                               | 改动章节                                |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| 1   | Blocker                           | unconfirmed 终态在 registry 变 absent 后被二次删除绕过，记录被删而进程可能还活着                         | **修复**：引入 `deathOf` 三态死亡确认（§2.1）。`deleteRecord` 是唯一删除点，只在 `confirmed` 时执行；终态记录删除一律先过死亡确认，`alive`/`unknown` ⇒ 409 `E_AGENT_ONLINE{reason:"exit-unconfirmed"}`，记录保留（复用拍板 #6 的错误码加 reason，不新增错误码）。guard 和重启恢复路径同样用 probe 收敛。补回归测试 | §1.2、§2.1、§2.2、§2.4、§4.1、§7.1、A6  |
| 2   | Blocker                           | 未覆盖托管会话的任意状态：未绑定 agentKey 的 starting 和 failed 只有 SpawnRow，无法删除；§5.2 与测试矛盾 | **修复**：端点 body 改为 `{agentKey}\|{spawnId}`，由 supervisor 按 spawnId 判定状态；SpawnRow 增加同款两步删除；拆成 `removalTargetForAgent`/`removalTargetForSpawn` 两个 target 函数，消除矛盾                                                                                                                    | §0.3、§2.4、§5.2、§5.4、§6、§7、A5、§10 |
| 3   | Blocker                           | 删除 spawn 记录后，创建端点幂等 LRU 命中但记录不存在会落穿并重新 fork                                    | **修复**：`routes.ts` 在命中且记录缺失时一律返回 409 `E_BAD_REQUEST{reason:"spawn-gone"}`，不 fork、不扣令牌；P1 文件域加入 `spawn/routes.ts`；补测试（单测 + 真进程）                                                                                                                                             | §1.2、§2.5、§4.3、§6、§7.1、§7.3、A7    |
| 4   | Major                             | `agent_removed` 不清 `client.subscribed`，同 key 重连后旧订阅先收到增量                                  | **修复**：`onHubEvent` 中按 `dropAgent` → 清理所有客户端 `subscribed` → `publish` 的顺序处理；补顺序测试（重连后收不到孤立 `ev`，重订阅后先 history 后 ev）                                                                                                                                                        | §1.1、§2.3、§3、§7.1、A3、A8            |
| 5   | Major                             | SSE 顺序描述与 `schedulePush`（microtask）实际行为不符                                                   | **修复**：按实际机制冻结一种顺序（`agent_down?` → `agent_removed` → 不含记录的 `spawns`，被删记录不会以 exited 推送）；supervisor 级测试精确断言，http 和集成测试只断言最终状态，UI 不依赖顺序                                                                                                                     | §2.7、§7.1                              |
| 6   | Major                             | `removePending` 不持久化，hub 重启后删除意图丢失                                                         | **修复**：持久化 `removeIntent`（同步 `saveNow`），`init` 后在 L3–L5 回收窗口结束时（8s）用 probe 收敛：确认已死 ⇒ 删除，否则放弃（与拍板 #3 同构）；写盘失败作为显式降级 D-6，并论证不违反三条底线；补重启测试                                                                                                    | §1.2、§2.2、§2.6、§7.1、§7.3、A9、R3    |
| C1  | Blocker（consult 复核 v2 时提出） | `pid===undefined ⇒ confirmed` 会误判「fork 后、pid 落盘前崩溃」的记录                                    | **修复**：新增持久化证据 `noProcess`（never-forked / boot-changed）；没有证据的 pid 缺失记录判为 `unknown`，删除返回 409，记录保留；补崩溃窗口测试                                                                                                                                                                 | §2.1、§7.1、A15、R9                     |
| C2  | Blocker（consult 复核 v2 时提出） | LAN 且 `spawn.lan=off` 时，托管请求回退到 `registry.remove`，会只删卡片、不停进程                        | **修复**：托管记录的查找与 listener 无关；`!managedAllowed` 时非终态返回 403 `E_SPAWN_DENIED{lan-off}`，终态在 `deathOf=confirmed` 时只删卡片、否则返回 409；不变量写入 §2.4；补 LAN 回归测试                                                                                                                      | §2.4、§4.1、§5.2、§5.4、§7.1、A11、R10  |
| 7   | Minor                             | 回滚描述不完整                                                                                           | **修复**：写明代码可回滚、已删除的 spawn 元数据不可恢复、session jsonl 不受影响                                                                                                                                                                                                                                    | §9                                      |

## 用户拍板（2026-10-06，主会话 ask_user 记录；覆盖上文对应推荐）

1. 离线卡片删除 **hub 广播**，所有标签页同步（采纳推荐）。
2. 正在查看的会话被删 ⇒ 详情页显示 **「已删除」空态**，不自动跳回列表（采纳推荐）。
3. 托管会话停止升级到 SIGKILL 后仍无法确认退出 ⇒ **放弃删除、卡片恢复**（采纳推荐）。
4. 删离线 TUI 卡片 **不向进程发信号**（采纳推荐）。
5. 外部启动（非 hub fork）的离线 `pi --mode rpc` 卡片 **也可删**，机制相同（采纳推荐）。
6. **新增错误码 `E_AGENT_ONLINE`**（采纳推荐；代价是 `preview.test.ts:83` 尾部断言改一行）。

> 更正记录：ask_user 多选答案回传只带回了第一项（web-hub 多选回传 bug，另案修复），曾误记 5/6 为
> 「不同意」；用户确认四项全选，以本节为准。

- 7.（2026-10-06 追加拍板）**SpawnRow 也加两步删除入口**（覆盖 starting / failed-before-live 托管会话），原有本地「关闭」保留。
