## 0. 结论速览与对 arch 的修正

### 0.1 速览

| 议题        | 结论                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态        | 按 arch D1：hub 用 `spawn(launcher[0], [launcher[1], "--mode", "rpc"], {cwd: realpath, detached: true})` 拉起进程，作为 `kind:"rpc"` 卡片自动注册，agent 侧零改动                                                    |
| 端点        | `GET /api/headless`、`GET /api/headless/dirs`、`POST /api/headless`、`POST /api/headless/:spawnId/stop`。未启用时两个 listener 的现有字节都不变（§0.2 C3）                                                           |
| hub 编排    | spawn → `spawn` 事件（5s）→ agent_up 按 pid 绑定 → session 帧 → `live`。整段受 `registerTimeoutS` 约束（默认 30s，范围 [10,120]）。超时走 kill 升级：关 stdin，5s 后 SIGTERM，再 3s 后 SIGKILL，再 5s 后兜底进入终态 |
| 首条 prompt | **由 UI 编排**：进入 `live` 后走现有 `/api/cmd`，这是 arch D5 的选择。brief 里写的「hub 转发首条 prompt」我没有采纳，理由和备选方案见 C6                                                                             |
| SSE         | 新增 `spawns` 事件，覆盖式槽位 `{items, active, max}`（≤24 条终态记录 + 全部非终态）。经 registry bus 转发，连接时紧跟在 `agents` 快照之后发一份                                                                     |
| caps        | 只有启用时才在 `HubInfo.caps` 和 `hello_ack.caps` **两处同时**追加 `spawn.v1`，保持「两处字节一致」这个现有不变量                                                                                                    |
| 设置        | `webHub.spawn.{enabled=false, roots=[], maxProcesses=4, lan="off", ratePerMinute=3, registerTimeoutS=30, idleMinutes=0}`，经 `HubConfig.spawn` 快照下发，不实时生效                                                  |
| 安全        | realpath 之后做按路径段对齐的准入判断；confirm 绑定 `expectCwd`（无状态）；LAN 默认 off，明文直连时最高只能用 `known`，LAN 上一律要求 confirm；`audit:"spawn"` 只记白名单字段                                        |
| 孤儿回收    | `<stateDir>/spawns.json`（0600，tmp+rename）。身份核验用 `bootId + starttime + uid + pgid==pid`，**不看 cmdline**（§0.2 C1）                                                                                         |
| 拆包        | SP1–SP11（S1）加 SP12–SP14（S2），依赖图见 §2                                                                                                                                                                        |

### 0.2 对 arch 的修正（实地核实）

| #   | arch 原文                                               | 事实                                                                                                                                                                                                    | 方案处理                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | §7.3 孤儿回收要求「cmdline 含 `--mode rpc`」            | pi 启动时会执行 `process.title="pi"`（`dist/bundle/cli-runtime.js`，`setupCli`），Linux 下 `/proc/<pid>/cmdline` 会被改写成 `pi` 加填充字节。实测两个运行中的 pi 进程：`cmdline="pi    …"`，`comm=pi`   | 身份核验改为：记录里的 `bootId`（`/proc/sys/kernel/random/boot_id`）一致，`starttime` 一致，`uid` 一致，并且 `/proc/<pid>/stat` 的 pgrp 等于 pid。`comm==="pi"` 只当弱信号写进诊断，不参与判定                                                                                               |
| C2  | 未提及                                                  | hub 进程在 `src/web-hub/hub/main.ts:51` 执行了 `process.umask(0o077)`，子进程会继承。结果是 pi 在项目里新建的文件都变成 0600，目录变成 0700，这是真正的用户可见缺陷                                     | `main.ts:51` 改成 `const inheritedUmask = process.umask(0o077)`，经 `StartHubDeps.childUmask` 传给 supervisor。spawn 前后同步执行 `process.umask(inherited)` / `process.umask(0o077)` 包住这次调用。`child_process.spawn` 是同步 fork/exec，单线程下没有竞态                                 |
| C3  | §8.2 写「GET /api/headless 未启用时 501」               | 现状只有 loopback 的 **POST** 走 csrfOk → readJson → auth 后返回 501（`http.ts:2135`）；loopback 的 GET 返回 404（`:2137-2141` 之后落到 `:2142`）；LAN 的 POST 和 GET 都是 404（`:1225-1228`、`:1266`） | 「未启用」要求完全保持这三种现状字节。`tests/web-hub/http/api.test.ts:318-328` 原样保留                                                                                                                                                                                                      |
| C4  | §4.4：marker select 只要 caps 含 `dialog.v1` 就不应答   | `dialogs.ts:250-254`：agent 没 attach 时 `open()` 返回 undefined，网页对话框根本不会出现，rpc select 会一直挂着。agent 断连时 `detachAll()` 会结束远端记录，本地 select 却还在                          | hub 先把 marker select 挂起，再加三条兜底：(a) 5s 内绑定 agent 的 `dialogs` 槽位没有出现 `open` 项 ⇒ 取消；(b) `linked=false` 持续超过 5s ⇒ 取消；(c) 挂起期间槽位 `open` 清空持续超过 5s ⇒ 取消（对已经 resolve 的 id 重复应答是安全的：`rpc-mode.js:617-629` 里 pending 不存在就直接忽略） |
| C5  | §8.2 只说 hub caps 追加 `spawn.v1`                      | `hub.ts:220-227` 的注释和 `agent-server.ts:153` 要求 `HubInfo.caps` 与 `hello_ack.caps` 逐字节一致，`hub-lan.test.ts:151,322` 钉住了这一点                                                              | 给 `createAgentServer` 加一个依赖 `extraHubCaps?: readonly string[]`，两处都用同一个数组                                                                                                                                                                                                     |
| C6  | brief：「hub 新增 spawn→hello+session→转发首条 prompt」 | arch D5（定稿）：hub 不代为转发，因为 pi 启动可能要 15s 以上，超过 `WRITE_TOTAL_MS=13s`（`http.ts:103`）；cmd 通道「目标在线」这个假设也会被打破                                                        | 按定稿：DirPicker 可以填首条消息，由 `useNewSession` 在 `live` 之后通过 `control.sendPrompt` 发出（时限和回退见 §3.3）。如果用户坚持要 hub 转发，备选是 SP-X（§11 Q1）：`SpawnRequestBody.firstPrompt`，hub 在 `live` 时调用 `commandRouter.request()` 并把结果写进记录。**需要用户确认**    |
| C7  | §11 测试表写 `tests/integration/web-hub-spawn.test.ts`  | 这个文件已经存在（hub 单例 / kill-9 重启的 e2e）                                                                                                                                                        | 改名为 `tests/integration/web-hub-headless.test.ts`                                                                                                                                                                                                                                          |
| C8  | §9.1 / R9 写「AgentList 是进行中的改动」                | `060c33b` 已经提交（「new session」按钮在 `AgentList.vue:94-131`）                                                                                                                                      | 不再需要与他人协调；SP10 直接拥有 `components/agents/**`                                                                                                                                                                                                                                     |
| C9  | 未提及                                                  | registry 先 `publish(agent_up)`（`registry.ts:337`），再 `onVersion`（`:338`）触发 supersede。如果拉起的 agent 加载了比 hub 更新的 pi-toolkit，hub 会立刻进入版本替换，新会话随 stdin EOF 一起结束      | 由受管 agent 触发的 `onVersion` 不送进 `supersede.observe`（hub.ts:151 包一层判断，见 SP8）；同时在记录上加 `hint:"newer-plugin"`                                                                                                                                                            |
| C10 | §4.5 写死 `~/.pi/agent/sessions`                        | pi 支持 `PI_CODING_AGENT_DIR`（`config.js:405-422`）                                                                                                                                                    | hub 环境里有这个变量就用 `$PI_CODING_AGENT_DIR/sessions`；hub 不读 pi 的 settings 里的 `sessionDir`，读不到时已知目录就退化为 registry 和 spawns 历史两个来源                                                                                                                                |

---

## 1. 文件域总表

| 包           | 新文件                                                                                                                                                                    | 修改的文件（行号）                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SP1 协议     | `protocol/spawn.ts`、`protocol/proc-identity.ts`                                                                                                                          | `protocol/http-contract.ts:39,68`、`protocol/version.ts:15`、`protocol/paths.ts:158` 之后、`agent/proc-identity.ts:75-118`（改为 re-export）、`hub/ports.ts:353-362,383-399,465-490`                                                                                            |
| SP2 设置     | `hub/spawn/config.ts`                                                                                                                                                     | `agent/index.ts:77-89,484-505`、`config/settings.ts:653,807-818,1475-1512`、`config/setting-specs.ts:309` 之后、`hub/main.ts:51-70`、`hub/hub.ts:87-96`（只改 StartHubDeps 类型）                                                                                               |
| SP3 目录     | `hub/spawn/dirs.ts`                                                                                                                                                       | —                                                                                                                                                                                                                                                                               |
| SP4 stdio    | `hub/spawn/rpc-stdio.ts`                                                                                                                                                  | —                                                                                                                                                                                                                                                                               |
| SP5 持久化   | `hub/spawn/store.ts`                                                                                                                                                      | —                                                                                                                                                                                                                                                                               |
| SP6 监管     | `hub/spawn/supervisor.ts`                                                                                                                                                 | —                                                                                                                                                                                                                                                                               |
| SP7 路由     | `hub/spawn/routes.ts`                                                                                                                                                     | `hub/http.ts:607-614,662-731,762-769,1122,1810-1866,2080`、`hub/audit.ts:53` 之后                                                                                                                                                                                               |
| SP8 装配     | —                                                                                                                                                                         | `hub/hub.ts:147-153,203-212,218-227,317-336,347-350,622-627,636-648`、`hub/supersede.ts:33-45,193`、`hub/agent-server.ts:40-60,153`、`hub/hub-json.ts:26-43,103`                                                                                                                |
| SP9 UI 逻辑  | `ui/src/logic/spawn.js`、`ui/src/composables/useSpawn.ts`、`ui/src/composables/useNewSession.ts`                                                                          | `ui/src/logic/state.js:81-97,205-`、`ui/src/logic/contract.js:36-46`、`ui/src/logic/token-client.js:246-265`、`ui/src/logic/password-client.js:325-345,492`、`ui/src/transport/{types,token,password}.ts`、`ui/src/types.ts:95,146,183`、`ui/src/composables/useHub.ts:203-215` |
| SP10 UI 组件 | `components/spawn/{NewSessionMenu,DirPicker,SpawnRow,SpawnConfirm}.vue`、`i18n/{en,zh}/spawn.ts`、`styles/spawn.css`                                                      | `components/agents/AgentList.vue:94-131,135-195`、`components/agents/agentCardModel.ts:87`、`components/agents/AgentCard.vue`、`components/detail/DetailHeader.vue`、`components/shell/DashboardView.vue:48`                                                                    |
| SP11 集成    | `tests/integration/web-hub-headless.test.ts`、`tests/integration/fixtures/fake-rpc-pi.mjs`、`tests/conformance/rpc-spawn.test.ts`、`docs/dev/web-hub-spawn/acceptance.md` | `AGENTS.md`（`src/web-hub/` 条目）                                                                                                                                                                                                                                              |

除非特别说明，路径都相对于 `src/web-hub/`。

## 2. 依赖与并行

```
SP1 ──┬─▶ SP2 ───────────────────────────────┐
      ├─▶ SP3 ──────────────┐                │
      ├─▶ SP4 ─┐            │                │
      ├─▶ SP5 ─┴─▶ SP6 ─────┴─▶ SP7 ─────────┴─▶ SP8 ─┐
      └─▶ SP9 ─────────────▶ SP10 ────────────────────┴─▶ SP11
```

- **第一波**（SP1 合入后同时开）：SP2、SP3、SP4、SP5、SP9。五个包的文件域互不相交（SP2 只碰 config 和 agent，SP3/4/5 都是新文件，SP9 只碰 UI）。
- **第二波**：SP6（需要 SP4、SP5）；SP10（需要 SP9），与 SP6–SP8 并行。
- **第三波**：SP7 → SP8 → SP11 串行。SP7 和 SP8 都改 http.ts / hub.ts 这类热点文件，不并行。
- 每个包都走 dev-flow：开发返回后立即派验收，验收模型和开发模型不同；全局闸门 `npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web`。

---

## 3. 状态机与时限（问题 2 的核心）

### 3.1 hub 侧（supervisor，单条记录）

| 步         | 进入条件                                           | 时限                                                                                                                                                                                                                        | 成功 ⇒                                                                                      | 失败 / 超时 ⇒                                                                                                                                          |
| ---------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ① admit    | POST 闸门全部通过                                  | 同步                                                                                                                                                                                                                        | `start()`                                                                                   | 返回 4xx，不建记录                                                                                                                                     |
| ② fork     | `spawnFn(...)`                                     | 同步 try/catch；等 `spawn` 或 `error` 事件 ≤`SPAWN_EVENT_MS=5_000`                                                                                                                                                          | 进入 `starting`，挂好 stdout/stderr/stdin 监听（**在任何 await 之前**，arch R1）            | 同步抛错或 `error`（ENOENT/EACCES）⇒ `failed{spawn_error}`，并计入熔断。5s 内两个事件都没来 ⇒ `child.kill("SIGKILL")` 后同样处理                       |
| ②' 取身份  | `spawn` 事件之后                                   | `readStartTicksNow` + `readBootId`，合计 ≤1s，unref                                                                                                                                                                         | 写进记录（只写盘，不上 wire）                                                               | 拿不到就不写；之后孤儿回收不对这条记录发信号（宁可漏杀也不误杀）                                                                                       |
| ③ hello    | registry bus `agent_up` 且 `agent.pid===child.pid` | 共享总时限 `T_reg = registerTimeoutS*1000`                                                                                                                                                                                  | 绑定 `agentKey`，`linked=true`；**同步检查** `registry.get(key)?.session`，有的话直接进入 ④ | 见 ⑥                                                                                                                                                   |
| ④ session  | bus `session{agentKey}`，或 ③ 已经带着 session     | 共享 `T_reg`                                                                                                                                                                                                                | 进入 `live`；写入 `sessionFile`、`control = card.control === true`；熔断计数清零            | 见 ⑥                                                                                                                                                   |
| ⑤ ready    | 即 `live`                                          | —                                                                                                                                                                                                                           | UI 收到 SSE 后接管（§3.3）                                                                  | `control===false` ⇒ 仍为 `live`，同时设 `hint:"control-off"`（`webHub.control=false`，网页只读）                                                       |
| ⑥ 超时     | `T_reg` 到期时仍在 `starting`                      | —                                                                                                                                                                                                                           | —                                                                                           | `phaseAtTimeout ∈ {"hello","session"}` 写进 hint（§7.2 文案再细分），进入 `stopping{register_timeout}` ⇒ 升级 ⑧ ⇒ `failed{register_timeout}`，计入熔断 |
| ⑦ 提前退出 | 非 `stopping` 状态下收到 `exit`                    | —                                                                                                                                                                                                                           | —                                                                                           | 尚未 `live` ⇒ `failed{exited_early}`（计入熔断）；已 `live` ⇒ `exited{crash}`（**不自动重拉**，理由见 §4.5）                                           |
| ⑧ 停止升级 | stop / 超时 / 空闲 / hub 关停                      | 关 stdin（`end()`）；`STOP_TERM_MS=5_000` 后 `kill(-pid,"SIGTERM")`；`STOP_KILL_MS=3_000` 后 `kill(-pid,"SIGKILL")`；`EXIT_GUARD_MS=5_000` 后仍无 `exit` ⇒ 强制进入终态并标 `exit.unconfirmed=true`，pid 保留给下次孤儿回收 | `exit` ⇒ `exited{user\|idle\|hub}` 或 `failed{…}`                                           | `kill` 抛 ESRCH 直接忽略                                                                                                                               |

所有 timer 都 `unref()`。终态只能由 `exit` 或 ⑧ 的兜底推进。`exit` 之后不再按 pid 查 registry。

### 3.2 熔断（照搬 db-client 的 backoff/熔断形状，`db-client.ts:30-32,175-200`）

- 「启动失败」（`spawn_error` / `register_timeout` / `exited_early`）的时间戳放进滑动窗口 `SPAWN_FAIL_WINDOW_MS=10min`。
- 连续第 n 次失败后进入冷却期，`SPAWN_BACKOFF_MS=[0, 5_000, 30_000]`（取 `min(n-1, len-1)`）。冷却期内 POST 返回 `503 E_LAUNCHER{reason:"cooldown", retryAfterS}`。
- 窗口内累计 ≥4 次 ⇒ 熔断打开，持续 `SPAWN_BREAKER_OPEN_MS=10min`：`policy.allowed=false, reason:"breaker"`。到期后半开，只放行一次，成功（进入 `live`）就清零。
- 和 db-client 的区别：**不会**自动重新拉起已经结束的会话（db 子进程是常驻服务，会话进程是用户意图），只给「再次发起」限速。

### 3.3 UI 侧（`useNewSession` 编排器，状态在本地，不进 reducer）

| 步                                            | 时限                                                                              | 成功 ⇒                                                                                                                               | 失败回退                                                                                                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| submitting：`spawn({id, cwd, model?})`        | `CMD_REQUEST_TIMEOUT_MS=16_000`（`token-client.js:28` / `password-client.js:44`） | 202 ⇒ accepted                                                                                                                       | 409 `E_CONFIRM_REQUIRED` ⇒ confirming；`E_DIR` / `E_SPAWN_DENIED` / `E_LIMIT` / `E_LAUNCHER` / `E_RATE` ⇒ 在 DirPicker 内显示错误，**保留输入**；网络错误或超时 ⇒ 用**同一个 id** 重发一次（幂等，hub 返回 `dup:true`） |
| confirming                                    | 等用户操作                                                                        | 用同一个 id 加 `confirm:true, expectCwd:resolvedCwd` 重发                                                                            | 取消 ⇒ 回到 idle；重发后再次 409（路径变了）⇒ 用新的 resolvedCwd 再确认一次                                                                                                                                             |
| awaiting-live：看 SSE `spawns` 里的 `spawnId` | `policy.registerTimeoutS*1000 + 15_000`（hub 必然在 T_reg+13s 内进入终态）        | `live` 且有 `agentKey` ⇒ navigating                                                                                                  | `failed` ⇒ 显示 hint 和 stderrTail，保留输入；本地时限到了 ⇒ 显示「状态未知，仍在等待」，**不判定失败**，继续监听（SSE 重连后快照会补齐）                                                                               |
| navigating                                    | 同步                                                                              | `win.location.hash = #/agent/<key>`（与 `AgentCard.vue:47` 同一路由），并且只在「我发起的」（`origin.clientId === 本地 id`）时才跳转 | 用户中途手动选了别的 agent ⇒ 不抢焦点                                                                                                                                                                                   |
| forwarding（填了首条消息才有）                | 等卡片 `control===true` ≤5s，然后 `control.sendPrompt(key, text, "steer")`，≤16s  | done                                                                                                                                 | 失败 ⇒ `control.setDraft(key, text)`，把正文放回该 agent 的 composer 草稿，并提示「首条消息未送达，已放入输入框」                                                                                                       |

---

## 4. 施工包

### SP1：协议与契约（小，无依赖）

**新文件 `protocol/spawn.ts`**：纯类型 + typebox schema + 常量，UI 也会 import，所以不能有 node 依赖。

- 类型 `SpawnState`、`SpawnEndReason`（arch §8.1 原样）。`SpawnRecordWire` 在 arch §8.1 基础上追加：`control?: boolean`、`hint?: "register-timeout-hello" | "register-timeout-session" | "control-off" | "newer-plugin" | string`、`exit?.unconfirmed?: true`。
- `SpawnPolicyWire`：在 arch §8.1 基础上，`reason` 追加 `"breaker" | "cooldown"`；新增 `registerTimeoutS: number`、`lanCap?: "known" | "roots"`。
- `SpawnsPayload = { items: SpawnRecordWire[]; active: number; max: number }`：SSE `spawns` 帧的 data，也是 GET `/api/headless` 的 `items` 来源。
- `DirEntryWire` / `DirListingWire` / `SpawnRequestBody`（arch 原样）；`SpawnAccepted = {spawnId, state:"starting", cwd, dup?: true}`。
- `HubSpawnConfig = { roots: string[]; maxProcesses: number; lan: "off" | "known" | "roots"; ratePerMinute: number; registerTimeoutS: number; idleMinutes: number }`。
- `SpawnRequestSchema`（typebox）：`id` 用 `/^[A-Za-z0-9_-]{16,64}$/`（与 `http.ts:1295` `CMD_ID_RE` 同源，复制一份并由测试钉住相等）；`cwd` ≤4096；`model` 用 `SPAWN_MODEL_RE=/^[A-Za-z0-9][\w.-]*\/[\w.:@-]+$/`，≤128；`additionalProperties:false`。
- 常量：`RPC_ASK_USER_TITLE="\0XYZ_ASK_USER"`、`SPAWN_ITEMS_MAX=24`、`SPAWN_TERMINAL_KEEP=20`、`SPAWN_STARTING_MAX=2`、`SPAWN_EVENT_MS`、`STOP_TERM_MS`、`STOP_KILL_MS`、`EXIT_GUARD_MS`、`SPAWN_BACKOFF_MS`、`SPAWN_FAIL_WINDOW_MS`、`SPAWN_BREAKER_OPEN_MS`、`MARKER_HOLD_GRACE_MS=5_000`、`STDERR_TAIL_BYTES=4096`、`SPAWN_BODY_MAX=4096`。
- 纯函数：`toWire(rec)`（白名单投影，丢掉 `procStartTicks` / `bootId` / `uid` / stderr 文件路径）。

**新文件 `protocol/proc-identity.ts`**：把 `agent/proc-identity.ts:75-118` 的 `parseStartTicks` / `parseCmdline` / `parseUidLine` / `readStartTicksNow` 原样搬过来，并新增：

- `parsePgrp(stat)`：取 `)` 之后第 2 个字段；
- `readBootId(deps)`：读 `/proc/sys/kernel/random/boot_id`；
- `verifySpawnedIdentity(expected:{pid, procStartTicks, bootId, uid}, deps)`，返回 `{ok:true} | {ok:false, reason:"non-linux"|"no-proc"|"boot-mismatch"|"starttime-mismatch"|"uid-mismatch"|"pgrp-mismatch"}`。

`agent/proc-identity.ts` 只保留 `looksLikeHubArgv` 和 `verifyProcIdentity`，其余改为 `export { … } from "../protocol/proc-identity.js"`。外部行为字节不变（hub 不能 import `agent/`，arch §4.1）。

**修改**：

- `protocol/http-contract.ts:39` 之后加 `"spawns",`；`:68-69` 之后加 `"E_SPAWN_DENIED", "E_DIR", "E_LIMIT", "E_LAUNCHER", "E_SESSION_IN_USE",`（只追加）。
- `protocol/version.ts:15` 之后：`export const SPAWN_HUB_CAP = "spawn.v1" as const;`（不并入 `P2_HUB_CAPS`）。
- `protocol/paths.ts:158` 之后：`export function webHubSpawnFiles(stateDir: string): { spawnsJson: string; logDir: string }`，分别返回 `${stateDir}/spawns.json` 和 `${stateDir}/spawn`。冻结的 `HubPaths`（`:102-115`）不动。
- `hub/ports.ts:353-362`：`HubConfig` 追加 `spawn?: HubSpawnConfig`；`:383-399` 的 `HubEvent` 追加 `| { type: "spawns"; payload: SpawnsPayload }`；`:465-490` 的 `FrontendDeps` 追加 `spawn?: SpawnFrontendPort`（接口在 SP7 实现，类型先在这里定：`handle(req,res,method,path,query,io): Promise<void>; payload(listener: "loopback"|"lan", scheme?: "http"|"https"): SpawnsPayload | undefined`）。

**vitest 验收**：

- `tests/web-hub/protocol/spawn.test.ts`（新）：
  - schema 正反例：多余字段、`id` 15/65 位、`cwd` 4097 字节、`model` 以 `-` 开头、`model` 含空格或换行；
  - `RPC_ASK_USER_TITLE === ASK_USER_MARKER`（import `src/ask-user/channel-handler.ts:4`，**测试文件可以跨层**）；
  - 复制出来的 `CMD_ID_RE` 与 http.ts 里的正则 `.source` 相等（读源码或另行导出）；
  - `toWire` 不含 `procStartTicks` / `bootId` / `uid`。
- `tests/web-hub/protocol/proc-identity.test.ts`（新）：`parsePgrp` 处理 comm 含空格和括号的情况；`verifySpawnedIdentity` 六个分支（注入 `readFile` / `platform` / `getuid`）。
- 原 `tests/web-hub/agent/proc-identity.test.ts`、`tests/web-hub/ui/logic-contract.test.ts`、`tests/web-hub/protocol/version.test.ts` 全绿。
- `npm run typecheck`（HubEvent 新成员不能破坏 `http.ts:662` 的 switch；那里没有 exhaustive never，所以是增量的）。

### SP2：设置与下发（小，依赖 SP1）

**修改**：

- `agent/index.ts:77-89` 的 `WebHubSettings` 追加 `spawn?: WebHubSpawnSettings`，并在同文件导出：
  ```ts
  export interface WebHubSpawnSettings {
    enabled: boolean;
    roots: string[];
    maxProcesses: number;
    lan: "off" | "known" | "roots";
    ratePerMinute: number;
    registerTimeoutS: number;
    idleMinutes: number;
  }
  ```
- `config/settings.ts`：
  - `:653` 旁边新增 `DEFAULT_WEBHUB_SPAWN_SETTINGS = {enabled:false, roots:[], maxProcesses:4, lan:"off", ratePerMinute:3, registerTimeoutS:30, idleMinutes:0}`；
  - `:807-818` 的 `DEFAULT_SETTINGS.webHub` 加 `spawn: DEFAULT_WEBHUB_SPAWN_SETTINGS`；
  - `:1477` 无输入分支同步展开 `spawn`；
  - `:1500-1512` 的返回值加 `spawn: parseWebHubSpawnBlock(record.spawn)`。
- `parseWebHubSpawnBlock`（新，紧接 `parseWebHubSettings`）的规则：
  - `roots` 复用 `splitLanCsv`（`:1519`），逐项必须是 `/` 或 `~` 开头、无 NUL、≤4096，非法项丢掉，最多 16 项；
  - `maxProcesses` 取整数 1..16；`ratePerMinute` 1..30；`registerTimeoutS` 10..120；`idleMinutes` 0..1440；
  - `lan` 三选一；
  - 任何非法值都回落到默认值，不抛错。
- `config/setting-specs.ts:309` 之后新增：
  - `"webHub.spawn.enabled": bool(…, "web-hub: allow the browser to start new pi sessions in a chosen directory (default off)")`
  - `"webHub.spawn.roots": csvString(…)`
  - `"webHub.spawn.maxProcesses": count(…, 1)`
  - `"webHub.spawn.lan": choice(…, ["off","known","roots"])`
  - `"webHub.spawn.ratePerMinute": count(…, 1)`
  - `"webHub.spawn.registerTimeoutS": count(…, 10)`
  - `"webHub.spawn.idleMinutes": count(…, 0)`

  这些键和 `webHub.*` 其他键一样都不实时生效。描述里注明：修改后需要 `/reload`，再 `/webhub restart` 才会生效。

- `agent/index.ts:484-505` 的 `buildHubConfig`：在 `:502` 之前加 `if (settings.spawn?.enabled === true) config.spawn = { roots, maxProcesses, lan, ratePerMinute, registerTimeoutS, idleMinutes }`。关闭时不写这个键。
- **新文件 `hub/spawn/config.ts`**：`parseHubSpawnConfig(raw): {ok:true, cfg} | {ok:false, detail}`，hub 侧再做一遍防御性校验（形状同 `lan-config.ts:20`）。
- `hub/main.ts:51` 改为 `const inheritedUmask = process.umask(0o077);`。`:53-70` 之后：
  - `config.spawn` 存在就解析；解析失败 ⇒ 删掉这个键，打 warn 日志，spawn 视为关闭；
  - `startDeps.childUmask = inheritedUmask`。
- `hub/hub.ts:87-96` 的 `StartHubDeps` 加 `childUmask?: number`（只改类型，使用放在 SP8）。

**vitest 验收**：

- `tests/config/web-hub-settings.test.ts` 追加：默认值；每个键的越界、类型错误回落；`roots` 支持 CSV 和 JSON 数组两种写法；NUL、相对路径被丢弃；超过 16 项被截断。
- `tests/ui/settings-editor.test.ts` 的 setting-specs 表测试全绿（新键都有 spec）。
- `tests/web-hub/agent/wiring-spawn.test.ts`（新，照 `wiring-lan.test.ts` 的写法）：
  - `spawn.enabled=false` 或缺失时，`PI_WEBHUB_CONFIG` 解析结果与现状**深相等**（没有 `spawn` 键）；
  - `enabled=true` 时，`config.spawn` 正好是那 6 个字段。
- `tests/web-hub/hub/hub-spawn-config.test.ts`（新）：`parseHubSpawnConfig` 的正反例；main 的降级路径（注入 env，断言 startHub 拿到的 config 没有 `spawn`）。

### SP3：目录准入 `hub/spawn/dirs.ts`（中，依赖 SP1）

**导出**：

```ts
createDirService(deps: { home: string; agentDir: string /* $PI_CODING_AGENT_DIR ?? `${home}/.pi/agent` */; roots: string[];
  registry: RegistryView; spawnHistory: () => readonly { cwd: string; updatedAt: number }[]; now; fs?: Partial<DirFs> }): {
  known(): Promise<{ entries: DirEntryWire[]; partial: boolean }>;          // 缓存 60s，单飞，2s deadline
  admit(raw: string, scope: "known" | "roots"): Promise<AdmitResult>;      // arch §4.5 步骤 1-4
  listChildren(path: string, opts: { dot: boolean }): Promise<…>;          // S2（SP12）才接入路由；S1 先实现并测试
  rootsResolved(): Promise<string[]>;                                      // roots 各自 realpath，失败项丢弃并 warn 一次
}
```

- `AdmitResult = {ok:true, cwd, known} | {ok:false, reason:"not-absolute"|"not-found"|"not-dir"|"no-access"|"not-allowed"|"timeout"}`。`scope="known"` 时第 4 步只认已知目录（LAN 明文封顶，§7.2）。
- 段对齐判断：`cwd === root || cwd.startsWith(root.endsWith("/") ? root : root + "/")`。root 为 `/` 的情况单独处理。
- 已知目录扫描（arch §4.5 三个来源）：
  - `opendir(${agentDir}/sessions)` 逐个子目录，每个子目录只取 mtime 最新的一个 `.jsonl`，只读前 4 KiB，按 `\n` 截出首行做 `JSON.parse`，要求 `type==="session"` 且 `typeof cwd==="string"`；
  - 子目录 mtime 早于 30 天的跳过；
  - 总计最多处理 500 个子目录（防爆炸）；
  - 每个结果 `realpath` + `stat.isDirectory()`；
  - 按 `lastActiveAt` 倒序取 50 条。
- 所有 fs 调用都包一层 `withDeadline`（复用 `protocol` 里已有的 helper，或者在本文件里写一个 10 行的 race，带 unref timer）。

**vitest 验收** `tests/web-hub/hub/spawn/dirs.test.ts`（新，真实 tmpdir）：

- `admit`：`~` / `~/x` 展开；`rel/x` 报 not-absolute；NUL；4097 字节；不存在；是文件；`chmod 000`（root 运行时 skip）；
- 符号链接：`roots=[/tmp/r]`，`/tmp/r/link → /etc` 报 not-allowed；`/tmp/r2` 不匹配 `/tmp/r`；
- `scope="known"` 时 roots 内但不在已知集合 ⇒ not-allowed；
- `known()`：fixture sessions 目录覆盖 header 损坏、首行超过 4 KiB、30 天前、cwd 已删除、两个会话目录指向同一个 realpath（去重）；
- 注入慢 fs 让扫描超过 2s ⇒ `partial:true`，并返回已经扫到的部分；
- 60s 缓存命中（fake timers）；并发两次 `known()` 只扫一遍。

### SP4：rpc stdio `hub/spawn/rpc-stdio.ts`（小，依赖 SP1）

**导出**：

```ts
createRpcStdio(deps: { write(line: string): void; now; onUiCancelled(e: {method; title?; at}): void;
  markerPolicy(): "hold" | "cancel" /* supervisor 依据绑定 agent 的 caps 和 dialogs 槽位给出 */ ;
  setTimeout?: … }): {
  push(chunk: Buffer): void;            // 只按 LF 切行（与 pi `jsonl.js` 的严格 JSONL 一致）
  onSlot(open: number, linked: boolean): void;  // supervisor 在 dialogs / agent_down / agent_up 时调用，驱动 C4 的兜底
  dispose(): void;                      // 清掉所有挂起计时
}
```

- 行处理表照 arch §4.4。前缀判断用 `line.startsWith('{"type":"extension_ui_request"')`，pi 的 `output({type:…, id, ...request})` 加 `JSON.stringify` 保证了键顺序（`rpc-mode.js:77`，V1 已核实）。其余行**不做 JSON.parse**。
- 缓冲上限 64 KiB：超过且还没有换行就进入丢弃模式，直到遇到下一个 `\n`。用 `Buffer[]` 加长度计数实现，跨 chunk 时不做字符串拼接的指数复制。
- marker select 的挂起和取消规则见 §0.2 C4：每个挂起项一个 unref timer，`MARKER_HOLD_GRACE_MS`；同一个 id 只应答一次。
- 写回的行：`JSON.stringify({type:"extension_ui_response", id, cancelled:true}) + "\n"`。

**vitest 验收** `tests/web-hub/hub/spawn/rpc-stdio.test.ts`（新）：

- 一行被切成 3 个 chunk；
- 一个 chunk 里有 5 行；
- 1 MiB 的单行没有换行：内存不增长（断言内部缓冲长度 ≤64 KiB），之后的下一行能正常处理；
- 普通事件行不触发 parse（spy `JSON.parse`）；
- 5 个 fire-and-forget method 都不应答；
- select / confirm / input / editor 都应答 `cancelled:true`，并调用 `onUiCancelled`；
- marker 在 `cancel` 策略下立即应答；
- marker 在 `hold` 策略下的三个兜底：5s 内槽位无 open 项、unlink 超过 5s、槽位清空超过 5s；
- 重复应答被去重；`dispose` 之后不再写。

### SP5：持久化与孤儿回收 `hub/spawn/store.ts`（中，依赖 SP1）

**文件格式** `<stateDir>/spawns.json`（0600，tmp+rename，写法照 `hub-json.ts:77-79`）：

```jsonc
{
  "v": 1,
  "writer": { "pid": 4242, "startedAt": 1759550000000, "bootId": "…" },
  "records": [
    {
      "spawnId": "sp_Ab3dEf9hIj0K",
      "cwd": "/home/u/proj",
      "model": "x/y",
      "state": "live",
      "createdAt": 0,
      "updatedAt": 0,
      "pid": 5151,
      "procStartTicks": 123456,
      "bootId": "…",
      "uid": 1000, // 只落盘，不上 wire
      "agentKey": "a5151-abcdef",
      "sessionFile": "/home/u/.pi/agent/sessions/--…--/x.jsonl",
      "origin": { "listener": "loopback", "clientId": "…" },
      "endReason": null,
      "exit": null,
      "hint": null,
      "stderrTail": null, // 只有 failed 才有，≤4 KiB
      "stderrLog": "sp_Ab3dEf9hIj0K.stderr.log", // 相对 <stateDir>/spawn/
    },
  ],
}
```

**导出**：`createSpawnStore({file, logDir, log, now, fs?})`：

- `load()`：≤256 KiB，2s deadline；解析失败 ⇒ 把文件重命名为 `.corrupt-<ts>`（只保留 1 份），按空记录处理；
- `save(records)`：防抖 200ms，unref；
- `saveNow(records)`：同步写，供 shutdown 用；
- `openStderrLog(spawnId)`：`<logDir>` 用 `ensurePrivateDir`（0700）；单文件超过 256 KiB 就截断重写；目录里最多保留 20 个，按 mtime 淘汰最旧的；
- `reclaim(records, proc)`：对每条非终态记录调用 `verifySpawnedIdentity`（SP1）：
  - `ok` ⇒ `kill(-pid, "SIGTERM")`，3s unref timer 之后**再核验一次 starttime**，仍然一致才 `kill(-pid, "SIGKILL")`；
  - 其他结果 ⇒ 不发信号。
  - 两种情况都把记录改成 `exited{orphan}`，并写一条 `phase:"state"` 审计。返回值只等身份核验完成，不等信号流程结束（不阻塞启动）。

**vitest 验收** `tests/web-hub/hub/spawn/store.test.ts`（新，tmpdir + 注入 proc deps）：

- 往返读写；权限 0600 / 0700；
- 损坏文件被重命名，结果为空；超过 256 KiB 被忽略；
- 防抖合并：3 次 `save` 只写 1 次；`saveNow` 立即写；
- stderr 日志截断和 20 个上限；
- `reclaim` 的 6 个身份分支（boot 不一致 / starttime 不一致 / uid 不一致 / pgrp 不一致 / no-proc / ok）：只有 ok 分支调用了注入的 `kill`，而且 SIGKILL 前做了二次核验（在两次核验之间改掉 starttime ⇒ 不发 SIGKILL）；
- 所有 timer `hasRef()===false`。

### SP6：监管与状态机 `hub/spawn/supervisor.ts`（大，依赖 SP1/SP4/SP5）

**导出**：

```ts
createSpawnSupervisor(deps: {
  cfg: HubSpawnConfig; registry: RegistryView & { bus: HubBus; publish(e: HubEvent): void };
  log: HubLog; now: () => number; store: SpawnStore; launcher: [string, string] | undefined;
  env: NodeJS.ProcessEnv; childUmask?: number; spawnFn?: typeof spawn; kill?: (pid: number, sig: string) => void;
  proc?: ProcDeps; audit: (r: SpawnAuditRecord) => void;
}): SpawnSupervisor

interface SpawnSupervisor {
  init(): Promise<void>;                 // store.load + reclaim + 校验 launcher（stat，1s）；bounded
  payload(): SpawnsPayload;
  policyBase(): { allowed: boolean; reason?: "breaker" | "cooldown"; retryAfterMs?: number; active: number; max: number };
  start(req: { cwd: string; known: boolean; model?: string; origin: SpawnRecordWire["origin"]; reqId: string }):
    | { ok: true; rec: SpawnRecordWire } | { ok: false; code: "E_LIMIT" | "E_LAUNCHER"; retryAfterMs?: number; message?: string };   // **同步**
  stop(spawnId: string, force: boolean): { ok: true; state: SpawnState } | { ok: false; code: "E_NOT_FOUND" };
  isManaged(agentKey: string): boolean;  // C9
  liveCount(): number;                   // 非终态记录数（idle 的 headless 位）
  busyCount(): number;                   // 已绑定、live 且 registry status.busy 的记录数（supersede 用）
  shutdown(): Promise<void>;             // 有界，arch §7.3
}
```

**要点**：

- `start()` 必须完全同步：限额检查（非终态数 ≥ `maxProcesses` ⇒ E_LIMIT；`starting` 数 ≥2 ⇒ E_LIMIT）→ 冷却 / 熔断检查 → launcher 检查（`init` 时已验证并缓存，`ENOENT` 之后标记为失效）→ `spawnFn`。这样 routes 在二次鉴权之后不会再出现任何 await（arch §8.2，与 `http.ts:1683-1700` 的「最后一个 await」规则一致）。
- `childEnv`：先删掉所有 `/^PI_WEBHUB_/` 键，再设 `PI_WEBHUB_HEADLESS=1`。argv 构造按 arch §4.2；**绝不**传 `--approve` / `--no-approve` / `-e` / `--no-extensions`。
- umask（C2）：`const prev = deps.childUmask === undefined ? undefined : process.umask(deps.childUmask); try { spawn } finally { if (prev !== undefined) process.umask(prev) }`。
- 绑定：订阅 `registry.bus`。`agent_up` 按 pid 匹配；`session` 推进到 live；`agent_down` 只把 `linked=false` 并调用 `stdio.onSlot`；`dialogs` 事件调用 `stdio.onSlot(open.length, linked)`；`status` 事件刷新 busy。markerPolicy 返回 `"hold"` 的条件：绑定的卡片 caps 含 `dialog.v1`（取 `card.dialogs !== undefined || registry` 的 raw caps，用 `RegistryView` 已有的 caps 查询，`registry.ts:263`）。
- 推送：每次迁移都 `queueMicrotask` 合并，然后 `registry.publish({type:"spawns", payload})`，同时 `store.save()`，同时 `audit({phase:"state", …})`。
- 记录上限：终态记录超过 20 条就淘汰最旧的（`SPAWN_TERMINAL_KEEP`）。
- `shutdown()`：所有活着的子进程先关 stdin，等待 ≤3s；之后对仍然存活的统一 `kill(-pid,"SIGTERM")`；`store.saveNow()`；返回。整体 ≤3.2s，hub 外面还会再套一层 `bounded`。

**vitest 验收** `tests/web-hub/hub/spawn/supervisor.test.ts`（新，假 `ChildProcess` 用 EventEmitter 实现，带 `stdin/stdout/stderr` PassThrough，加 fake timers 和假 registry bus）。表驱动覆盖 §3.1 的每一行：

1. spawn 同步抛错 ⇒ `failed{spawn_error}`，计入熔断；`error` 事件同理；5s 内两个事件都没有 ⇒ SIGKILL 后进入 spawn_error；
2. 不匹配的 pid 发 agent_up ⇒ 不绑定；匹配 ⇒ 绑定；registry 里已经有 session ⇒ 直接 live；
3. `T_reg` 超时，分别处于 hello 阶段和 session 阶段时 hint 不同；随后 0s 关 stdin、5s SIGTERM(-pid)、8s SIGKILL(-pid)、13s 兜底终态 `unconfirmed`；
4. 未 live 就 exit ⇒ exited_early；live 之后 exit ⇒ crash（**不重拉**）；
5. agent_down 只改 `linked`；stop 幂等；`force` 直接 SIGKILL；
6. 限额：第 5 个 ⇒ E_LIMIT；第 3 个同时处于 starting ⇒ E_LIMIT；
7. 冷却 [0,5s,30s] 与熔断（第 4 次失败 ⇒ `breaker`，10min 后半开，放行 1 次，成功后清零）；
8. env：断言子进程 env 里没有 `PI_WEBHUB_CONFIG` / `PI_WEBHUB_LAUNCHER`，有 `PI_WEBHUB_HEADLESS=1`；argv 正好是 `[argv1,"--mode","rpc"]`，加 `--model x/y`；不出现 `--approve`；
9. umask：spy `process.umask` 的调用序列是 `[inherited, 0o077]`；
10. `shutdown()` ≤3.2s（fake timers）；之后 `start()` ⇒ E_LAUNCHER（已关闭）；
11. publish 合并：同一 tick 内 3 次迁移只推 1 帧；
12. 所有 timer 都是 unref。

### SP7：HTTP 路由与审计（中，依赖 SP3/SP6）

**新文件 `hub/spawn/routes.ts`**：

```ts
createSpawnRoutes(deps: { supervisor; dirs; cfg: HubSpawnConfig; limit: CmdLimit; rejectAudit429: Map<string, number>; log; now }): SpawnFrontendPort
```

和 upload plan U3 同一种做法：`http.ts` 把私有 helper 作为 `io` 注入，避免为了导出而重构 `http.ts`。

```ts
io: { listener: "loopback" | "lan"; ip: string; scheme: "http" | "https"; viaTrustedProxy: boolean;
      strictCsrfOk(): boolean; authorize(deadline): Promise<CmdAuthResult | CmdAuthHandled>;
      readJson(maxBytes, ms): Promise<unknown>; sendJson; sendError; HttpError }
```

**路由与闸门**：

- **GET `/api/headless`**、**GET `/api/headless/dirs`**：Host（外层已检查）→ 要求 `X-PWH:1`（不满足 ⇒ 403 E_CSRF；原因是目录名属于敏感枚举，跨源请求带不了这个头）→ `authorize` → 有效策略（§7.2；LAN `off` ⇒ 403 E_SPAWN_DENIED）→ 限流 `${principal}:spawn-read` 10/1s → 返回 `{policy, items}` 或 `DirListingWire`。S1 里 `dirs?path=` 一律 400 `E_DIR{reason:"browse-unavailable"}`，SP12 再放开。
- **POST `/api/headless`**：照 arch §8.2 的写闸门顺序。`reqDeadline = createReqDeadline(now, WRITE_TOTAL_MS)`；body 上限 `SPAWN_BODY_MAX=4096`；`admit` 用 `deriveBudget(remaining, 2_000, FORWARD_MIN_REMAINING_MS)`；幂等 LRU 256 条、10min，键为 `principal|id` → `{spawnId, digest}`，digest 取 `sha256(canonical({cwd, model}))`（`confirm` / `expectCwd` 不参与摘要）；409 确认被拒的那次不写 LRU；限流桶 `${principal}:spawn`，容量 `ratePerMinute`，补充间隔 `60_000/ratePerMinute`；幂等命中不扣令牌。
- **POST `/api/headless/:spawnId/stop`**：strictCsrf → authorize → 有效策略不为 off → 限流共用 `stop` 类别（10/2s，与 `http.ts:1465-1467` 同参数）→ body `{force?: true}` → 二次鉴权 → `supervisor.stop()` → 202。
- 错误码到状态码：`E_SPAWN_DENIED` 403；`E_DIR` 400；`E_LIMIT` / `E_SESSION_IN_USE` / `E_CONFIRM_REQUIRED` 409；`E_LAUNCHER` 503（带 `Retry-After`）；其余沿用。`http.ts:216-240` 的 `statusFor` 追加这几个分支。

**修改 `hub/http.ts`**：

- `:2080` `handleApi` 里 `res.setHeader("Cache-Control"…)` 之后，在 `if (method === "POST")` **之前**插入：
  ```ts
  if (spawnRoutes !== undefined && (path === "/api/headless" || path.startsWith("/api/headless/")))
    return spawnRoutes.handle(req, res, method, path, query, loopbackIo(req, res));
  ```
  `deps.spawn` 缺省时这一段不存在，于是走原来的 `:2135` 501 / GET 404，字节不变（C3）。
- `:1122`（LAN 分支 `res.setHeader("Cache-Control","no-store")` 之后，`:1124` 之前）插入同样的分派。`lanIo` 里的 `authorize` 复用 `:1130-1136` 的闭包，`scheme: ctx.scheme`，`viaTrustedProxy: ctx.viaTrustedProxy`。
- SSE：
  - `createRouteSet` 的 `routeDeps`（`:607-614`）加 `spawns?: () => SpawnsPayload | undefined`；
  - `openEvents`（`:767` 之后）加 `const sp = routeDeps.spawns?.(); if (sp !== undefined) client.send("spawns", sp);`；
  - `onHubEvent`（`:662-731`）加 `case "spawns": if (routeDeps.spawns?.() !== undefined) sse.publish("spawns", e.payload); break;`。
  - loopback 的 routeset（`:1836-1843`）传 `spawns: deps.spawn === undefined ? undefined : () => deps.spawn!.payload("loopback")`；LAN 的（`:1856-1863`）传 `() => deps.spawn?.payload("lan")`，在 LAN 策略为 off 时返回 undefined（C9 / §0.1）。
- `createHttpFrontend`（`:1810`）里 `const spawnRoutes = deps.spawn;`，复用同一个 `cmdLimit` 和 `rejectAudit429`（`:1817-1820`）。

**修改 `hub/audit.ts:53`** 之后：`export interface SpawnAuditRecord {…}`（arch §6.4，加上 `confirmed?: boolean; dup?: boolean; endpoint?: "list"|"dirs"|"spawn"|"stop"`），以及 `auditSpawn(log, r)`，写法是 `log.info("spawn", { audit: "spawn", ...r })`。**字段只从白名单拷贝**：函数体逐字段赋值，不做 `...r` 透传，防止调用方塞进额外字段。

**vitest 验收**：

- `tests/web-hub/http/api-headless.test.ts`（新，复用 `tests/web-hub/http/helpers.ts`，`fakeDeps` 注入 `spawn: createSpawnRoutes({supervisor: 假的, dirs: 假的})`）：
  - 缺 Origin、跨源、缺 X-PWH、`Sec-Fetch-Site: cross-site` ⇒ 403；未登录 ⇒ 401；
  - 登出竞态：注入一个第二次调用返回失败的 `authorize` ⇒ 401，并且 `supervisor.start` 没被调用；
  - 确认流：未知目录未带 confirm ⇒ 409 并带 `resolvedCwd`；`expectCwd` 不一致 ⇒ 409；通过 ⇒ 202；
  - 已知目录 + loopback ⇒ 不需要确认；
  - 同 id 同载荷 ⇒ `dup:true`；同 id 不同 cwd ⇒ 409 `E_BAD_REQUEST`；同 id 只多了 confirm ⇒ 视为同一意图；
  - 第 4 次 ⇒ 429，带 `Retry-After`；E_LIMIT ⇒ 409；E_LAUNCHER ⇒ 503；body 4097 字节 ⇒ 413，连接关闭；
  - GET 缺 X-PWH ⇒ 403；GET 返回体形状；
  - stop：404 / 202 / 幂等。
- `tests/web-hub/http/api.test.ts:318-328` **原样保留**（没有 `deps.spawn` ⇒ POST 仍然 501），另外追加一条「没有 `deps.spawn` 时 GET `/api/headless` ⇒ 404」。
- `tests/web-hub/http/lan-headless.test.ts`（新，`lan-helpers.ts`）：
  - `lan:"off"` ⇒ GET 和 POST 都是 403，且 SSE 不推 `spawns`；
  - `lan:"roots"` + 明文直连 ⇒ roots 内的未知目录 ⇒ 400 `E_DIR{not-allowed}`（被封顶为 known）；
  - 经受信代理走 https ⇒ 允许；LAN 上已知目录也必须确认；
  - 没配 LAN 时，LAN listener 上 `/api/headless` 是 404（字节不变）。
- `tests/web-hub/http/sse.test.ts` 追加：连接时 `spawns` 紧跟在 `agents` 之后发出；bus `spawns` 事件被转发；`deps.spawn` 缺省时没有 `spawns` 帧。
- `tests/web-hub/hub/audit.test.ts` 追加：`auditSpawn` 会丢掉白名单之外的字段（运行时断言），源码中不出现 `stderr`、`text` 字样。

### SP8：hub 装配（中，依赖 SP2/SP6/SP7）

修改 `hub/hub.ts`：

- `:147-153`：`onVersion` 改为 `(v, key) => { if (spawnSupervisor?.isManaged(key) === true) { spawnSupervisor.noteNewer(key, v); return; } supersede?.observe(v, key); }`（C9；`noteNewer` 在 v 大于 hub 版本时设置 `hint:"newer-plugin"`）。
- `:203-212`：`createAgentServer(…, { …, extraHubCaps })`，其中 `extraHubCaps = config.spawn === undefined ? [] : [SPAWN_HUB_CAP]`。
- `:227`：`caps: [...admin.caps(), ...P2_HUB_CAPS, ...extraHubCaps]`。
- `:317` 之后：
  ```ts
  config.spawn !== undefined && (
    store = createSpawnStore(...),
    spawnSupervisor = createSpawnSupervisor({ cfg: config.spawn, registry, …, launcher: config.launcher, env: process.env, childUmask: deps.childUmask }),
    await withSignal(bounded(spawnSupervisor.init()), startup.signal),
    dirs = createDirService({ …, agentDir: process.env.PI_CODING_AGENT_DIR ?? `${config.home}/.pi/agent` }),
    cleanup.push(() => spawnSupervisor.shutdown())
  )
  ```
- `:318-335` 的 `frontend({...})` 追加 `...(spawnRoutes === undefined ? {} : { spawn: spawnRoutes })`。
- `:347-350` 的 `createSupersede` 追加 `managedBusy: () => spawnSupervisor?.busyCount() ?? 0`。
- `:626`：`headless: spawnSupervisor?.liveCount() ?? 0`。
- `:636-648` 的 `close()`：在 `await bounded(fe.close())`（`:648`）**之前**插入 `if (spawnSupervisor) await bounded(spawnSupervisor.shutdown());`。

其他文件：

- `hub/supersede.ts:33-45` 的 `SupersedeDeps` 加 `managedBusy?: () => number`；`:193` 的 quiet 判断追加 `&& (d.managedBusy?.() ?? 0) === 0`。
- `hub/agent-server.ts:40-60` 的 deps 加 `extraHubCaps?: readonly string[]`；`:153` 改为 `caps: [...(deps.admin?.caps() ?? []), ...P2_HUB_CAPS, ...(deps.extraHubCaps ?? [])]`。
- `hub/hub-json.ts:26-43` 的 `HubRecord` 加 `spawn?: { count: number }`；`:103` 的 writer 加 `patchSpawn(s)`（写法照 `patchLan`），supervisor 的 `liveCount` 变化时调用。`/webhub stop|restart` 的提示文案读这个字段：在 `agent/admin-cmds.ts` 里追加一行「N 个网页会话将结束」，只读字段，不阻止操作。

**vitest 验收**：

- `tests/web-hub/hub/hub-spawn.test.ts`（新，照 `hub-lan.test.ts:131-151` 的装配写法，`spawnFn` 注入假进程）：
  - 没有 `config.spawn` ⇒ `info.caps` 和 `hello_ack.caps` 都和现状**深相等**；hub.json 没有 `spawn` 字段；`stateDir` 下没有 `spawns.json`；
  - 有 `config.spawn` ⇒ 两处 caps 都以 `"spawn.v1"` 结尾，且两者相等；
  - 有一个 live 的子进程时 idle 不退出；`close("signal")` 会先关掉子进程，再关 fe（检查调用顺序）；
  - 受管 agent 带着更新的版本发 hello ⇒ `supersede.state()` 仍为 undefined；
  - 受管 agent `status.busy` 时 supersede 不进入 quiet。
- `tests/web-hub/hub/supersede.test.ts` 追加 `managedBusy` 的分支。
- `tests/web-hub/hub/agent-server-admin.test.ts:70-84` 两条原样保留，再追加一条 `extraHubCaps`。
- `tests/web-hub/hub/hub-json.test.ts` 追加 `patchSpawn`。

### SP9：UI 逻辑与传输（中，依赖 SP1，与 SP3–SP8 并行）

**新文件**：

- **`ui/src/logic/spawn.js`**（纯 JS + JSDoc）：
  - `spawnAvailability({hubCaps, policy})`，返回 `{enabled, reason}`；
  - `newSessionActions({hubCaps, policy, selected})`，返回 `NewSessionAction[]`（arch §8.3）；
  - `classifySpawnError(outcome)`，把错误映射到 `"confirm"|"dir"|"denied"|"limit"|"rate"|"launcher"|"network"`；
  - `isMine(rec, localIds)`；`spawnForAgent(spawns, agentKey)`（给 web 徽标和停止按钮用）；
  - `pendingRows(spawns)`：取 starting 和 failed（未关闭）的记录；
  - `recentEnded(spawns)`。
- **`ui/src/composables/useSpawn.ts`**：薄的 handle 层，`policy()` / `dirs()` / `start()` / `stop()`，内部调用 `transport.spawn?.*`；transport 没有这些方法时返回 `{ok:false, error:"E_UNSUPPORTED"}`。
- **`ui/src/composables/useNewSession.ts`**：§3.3 的编排器。对外暴露 `actions`（computed）、`flow`（ref，取值 `idle|submitting|confirming|awaiting|forwarding|done|failed`）、`submit({cwd, model?, firstPrompt?})`、`confirm()`、`cancel()`。请求 id 用 `newCmdId()`（`logic/control.js:39`，不用 `randomUUID`，K18）。由 `ticker` 驱动的本地时限要注入 `setTimeout`。

**修改**：

- `logic/contract.js:36-46` 的 `API` 加 `headless: "/api/headless", headlessDirs: "/api/headless/dirs"`。
- `logic/token-client.js:246-265`：新增 `spawnList()` / `spawnDirs()` / `spawnStart(body)` / `spawnStop(id, force)`。GET 走 `request(url, {headers:{"X-PWH":"1"}})`，POST 走 `postRaw`，都经过 `withRelogin`；`:265` 的 return 导出这四个。
- `logic/password-client.js:325-345,492`：同样四个方法，基于 `postApi` / `request`；503 `E_BUSY` 复用现有退避。
- `transport/types.ts:72-81` 的 `HubTransport` 追加**可选**的 `spawn?: SpawnTransport`（additive，旧测试替身不受影响）。`transport/token.ts:55-80` 和 `transport/password.ts:44-63` 挂上这个字段，final E_AUTH 时 `onConn("auth")`。`password.ts:33` 的 `REST_AUTH_PATHS` 追加两个 headless 路径。
- `logic/state.js`：
  - `:81-97` 的 `initialState` 加 `spawns: null`；
  - `reduceInner`（`:205-`）加 `case "spawns": return { ...s, spawns: isPayload(d) ? d : s.spawns };`；
  - `case "hello"`（`:209`）不清空 `spawns`，后面紧接着的快照会覆盖它。
- `ui/src/types.ts`：
  - `:95` 的 `HubState` 加 `readonly spawns?: SpawnsPayload | null`；
  - `:146` 的 `HubHandle` 加 `readonly spawn?: SpawnHandle`；
  - `:183` 的 `AgentCardView` 加 `readonly managed?: { spawnId: string; state: string }`。
- `composables/useHub.ts:203-215`：`const spawn = createSpawnHandle(transport)`，在 return 里导出。

**vitest 验收**：

- `tests/web-hub/ui/logic-spawn.test.ts`（新）：
  - `newSessionActions` 的真值表：无选中 agent、无 caps、`policy.allowed=false`、选中的是 stale 或 down 的 agent；pick-dir 在 0 个 agent 时仍然 enabled；
  - `classifySpawnError` 全码表；
  - `pendingRows` / `recentEnded` 的排序和截断。
- `tests/web-hub/ui/logic-state.test.ts` 追加：`spawns` 覆盖式更新；hello 不清空；非法 payload 被忽略。
- `tests/web-hub/ui/transport-contract.test.ts` 追加：两个 transport 都暴露同形的 `spawn`；用同一套假 fetch 跑 202、409 确认、401 ⇒ `onConn("auth")`、超时、GET 带 `X-PWH`。
- `tests/web-hub/ui/use-new-session.test.ts`（新）：
  - §3.3 全部迁移，含网络错误时用同一个 id 重试一次、409 带新 resolvedCwd 后再次确认；
  - awaiting 本地超时不判失败；live 后跳转只发生在「我发起的」记录上；
  - forwarding 失败时调用 `setDraft`；spawn failed 时保留输入；
  - 失败后再次提交用的是**新** id。
- `tests/web-hub/ui/source-scan.test.ts` 全绿（无 `randomUUID` / `innerHTML` / `localStorage`）。

### SP10：UI 组件（中，依赖 SP9）

**新文件**：

- `components/spawn/NewSessionMenu.vue`：分裂按钮。主按钮保持现在 `/new` 的行为；下拉菜单两项（arch §9.1）。键盘支持：Enter、Esc、方向键；`aria-haspopup="menu"`。
- `components/spawn/DirPicker.vue`：
  - 路径输入框：预填选中 agent 的 `cwd`，没有就填 `~`；
  - 「最近目录」列表：来自 `spawn.dirs()`，显示 `shortCwd`（复用 `agentCardModel.ts:20`）和相对时间，点击填入输入框；
  - 可选的「首条消息」多行输入（≤48 KiB，与 `http.ts:1297` 的 `PROMPT_TEXT_MAX_BYTES` 一致，在 UI 端预检）；
  - 提交按钮在 `flow!=="idle"` 时禁用；
  - `partial:true` 时提示「目录列表可能不完整」；
  - S1 没有子目录补全（`policy.browse` 恒为 false），SP12 再接上。
- `components/spawn/SpawnConfirm.vue`：显示 `resolvedCwd`（`textContent`）和固定文案「将在此目录启动新的 pi 进程」。LAN 下追加明文警告「局域网明文 HTTP：任何能嗅探此网络的人都可能冒用会话在本机执行命令」。
- `components/spawn/SpawnRow.vue`：starting 显示转圈和 cwd；failed 显示 hint、可展开的 `<pre>` stderrTail（`textContent`）、「关闭」和「重试」（重试会把 cwd 回填到 DirPicker）。
- `i18n/{en,zh}/spawn.ts`：新命名空间，由 `i18n/index.ts` 的 glob 自动收录。行内标记用英文 token：`web`、`starting`、`failed`；提示长文本用中文。
- `styles/spawn.css`：组件自己 import（照 `FleetPanel.vue:27` 的做法），不改 `agents.css`。

**修改**：

- `components/agents/AgentList.vue`：
  - `:94-131` 抽到 `useNewSession`。`newSessionEnabled` 的公式**原样**搬成 `same-cwd` action 的 enabled 字段，`onNewSession` 搬成 action 的执行函数；
  - `:150-158` 的按钮换成 `<NewSessionMenu>`；
  - `:173-183` 的 `EmptyState` 下面追加 pick-dir 入口（只有 `enabled` 时才显示）；
  - `:184` 的 `<ul>` 顶部插入 `<li v-for="row in pendingRows"><SpawnRow/></li>`；
  - `staleOrDown` 分组下面插入最近结束的记录（S1 只显示，不提供「重新打开」）。
- `components/agents/agentCardModel.ts:87`：`toAgentCardView(agent, t, spawns?)` 填 `managed`；`DashboardView.vue:48` 传入 `hub.state.value.spawns`。
- `components/agents/AgentCard.vue`：`managed` 存在时显示 `web` 徽标（`kind==="rpc"` 已经有标记的话，两者并列）。
- `components/detail/DetailHeader.vue`：`managed` 存在时显示「停止会话」按钮，二次确认之后调用 `spawn.stop`；TUI 卡片不显示。

**vitest 验收**（happy-dom + `@vue/test-utils`，注入写法沿用 `tests/web-hub/ui/agent-list.test.ts`）：

- `tests/web-hub/ui/agent-list.test.ts`：现有「new session」用例全部保持绿（主按钮行为字节不变），追加：
  - 菜单两项的 enabled 矩阵；
  - 0 个 agent 时空状态里有 pick-dir；
  - pending 行渲染；
  - live 之后 pending 行消失、卡片带 `web` 徽标。
- `tests/web-hub/ui/dir-picker.test.ts`（新）：
  - 最近目录点击填入；
  - 提交后 409 ⇒ 切到 SpawnConfirm 并显示 resolvedCwd；LAN 显示明文警告；
  - failed 时保留 cwd 和首条消息；
  - 首条消息超过 48 KiB 时提交按钮禁用。
- `tests/web-hub/ui/detail-header.test.ts` 追加：受管卡片有「停止会话」按钮，二次确认后调用 `stop`；非受管卡片没有这个按钮。
- `i18n-parity.test.ts`、`source-scan.test.ts`（无 `<style>` 块、无静态 `style=`、无 `innerHTML`）全绿；`npm run build:web && npm run check:web`。

### SP11：集成、conformance 与文档（中，依赖 SP8/SP10）

- `tests/integration/fixtures/fake-rpc-pi.mjs`：用自己的 pid 连接 hub.sock（复用 `protocol/paths.ts` 的路径推导），发送 `hello{kind:"rpc", caps:[...P1_CAPS, ...P2_AGENT_CAPS]}` 和 `session`；读 stdin，EOF 时退出。通过 argv 或 env 开关支持：
  - `--emit-ui select|confirm|marker`；
  - `--ignore-eof`（拒绝退出）；
  - `--flood N`（向 stdout 写 N MiB）；
  - `--no-hello`（模拟扩展未加载）；
  - `--cmd-echo`（对 `cmd` 帧回 `cmd_result` ok）。
- `tests/integration/web-hub-headless.test.ts`（新，`sandboxHome()`）：真实 `startHub`，`config.launcher=[process.execPath, fake-rpc-pi.mjs]`，端到端覆盖：
  1. spawn ⇒ live ⇒ `/api/cmd` 送达 ⇒ stop ⇒ exited；
  2. `--flood 8` 不卡（live 在 T_reg 内到达）；
  3. `--emit-ui confirm` 被自动取消，`uiCancelled` 有 1 条；
  4. `--no-hello` ⇒ `failed{register_timeout}`，hint 为 hello 阶段（用 `registerTimeoutS=10` 加快测试）；
  5. `--ignore-eof` ⇒ 走完 5s/3s 升级后进入 exited；
  6. `hub.close()` 之后子进程全部退出；
  7. 直接 `kill -9` hub 进程（另起一个 hub 子进程跑）之后，子进程靠 EOF 自己退出；
  8. 写一份有伪造非终态记录的 spawns.json（pid 指向一个 `sleep` 进程，并写入它的真实 starttime）之后重启 hub ⇒ 那个进程被 SIGTERM，记录变成 orphan；把 starttime 改错 ⇒ 不发信号；
  9. 子进程里 `process.umask()` 等于测试进程的 umask，而不是 0o077（fake 脚本通过 stderr 回报）。
- `tests/conformance/rpc-spawn.test.ts`（选跑，`npm run test:conformance`）：真实 `pi --mode rpc`，用临时 HOME 和临时 cwd，settings 里列出本包。断言：注册成 `kind:"rpc"`；stdin EOF 之后 8s 内退出；`extension_ui_request` 行以 `{"type":"extension_ui_request"` 开头（V1）；`/proc/<pid>/comm === "pi"`（C1 回归哨兵）。不需要模型凭据；找不到 pi 的 dist 就 skip。
- `docs/dev/web-hub-spawn/acceptance.md`：tmux 真机验收步骤，参照 memory `live-acceptance-tmux.md`；覆盖 arch §11 末行，并加上 C2 的 umask 检查（`touch` 一个新文件后看权限是不是 0644）。
- `AGENTS.md` 的 `src/web-hub/` 条目末尾加一段 spawn 子系统说明，链接 arch 和本文；写明默认关闭、`spawn.v1` 是条件 cap、C1 和 C2。

---

## 5. 协议细节汇总（问题 3）

| 项           | 定义                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE `spawns` | `event: spawns`，`data: SpawnsPayload = {items: SpawnRecordWire[], active, max}`，覆盖式槽位。发送时机：连接时紧跟在 `agents` 之后，以及每次迁移（同一 tick 内合并）。`agentKey` 不做订阅范围限制，所有通过鉴权的客户端都能收到；LAN 策略为 off 时 LAN 客户端收不到 |
| caps         | `HubInfo.caps` 和 `hello_ack.caps` 在启用时都以 `"spawn.v1"` 结尾。UI 用 `hub caps ∋ spawn.v1` 判断功能是否存在，再用 `policy.allowed` 判断当前 listener 能否使用。agent 侧不读这个 cap                                                                             |
| HubEvent     | `{type:"spawns"; payload}`，只由 supervisor 经 `registry.publish` 发出                                                                                                                                                                                              |
| 端点 schema  | `SpawnRequestSchema`（typebox，`additionalProperties:false`）；回包类型 `SpawnAccepted`，错误体 `{error, message?, resolvedCwd?, reason?, retryAfterS?}`                                                                                                            |
| 新错误码     | `E_SPAWN_DENIED`、`E_DIR`、`E_LIMIT`、`E_LAUNCHER`、`E_SESSION_IN_USE`（S2）。`E_CONFIRM_REQUIRED` / `E_RATE` / `E_NOT_FOUND` / `E_BAD_REQUEST` / `E_DEADLINE` 复用已有的                                                                                           |

## 6. 设置（问题 4）

总表见 SP2。补充三条：

- 所有键都**只在 hub 启动时读取**，经 `PI_WEBHUB_CONFIG` 传入；hub 不读 settings.json（arch D11）。
- `lan` 的有效值 = `min(cfg.lan, scheme==="http" && !viaTrustedProxy ? "known" : cfg.lan)`，序关系 `off < known < roots`。
- `ratePerMinute` 控制每个主体的令牌桶；全局同时 starting 的上限 2 和 `maxProcesses` 是两道独立闸门。

## 7. 安全落地细节（问题 6）

### 7.1 目录解析

- 只用 `realpath` 之后的路径：`admit` → `spawn({cwd: realpath})`。cwd 永远不进 argv（SP3 / SP6）。
- 已知目录和 roots 也都在 realpath 之后再比较；roots 中 realpath 失败的项会被丢弃，并 warn 一次。

### 7.2 有效策略矩阵

| listener              | 有效 lan              | 准入范围                | confirm                    | 浏览子目录                |
| --------------------- | --------------------- | ----------------------- | -------------------------- | ------------------------- |
| loopback              | —                     | known ∪ roots           | 只有未知目录需要           | S2：roots 内可用          |
| LAN https（受信代理） | `cfg.lan`             | off ⇒ 403；known；roots | **一律需要**               | S2：仅当 lan=roots 时可用 |
| LAN 明文直连          | `min(cfg.lan, known)` | off ⇒ 403；known        | **一律需要**，并附明文警告 | 不可用                    |

### 7.3 confirm 绑定

- 无状态。第二次请求必须带 `confirm:true` 和 `expectCwd`，而且 hub **重新** `admit` 后得到的 realpath 必须与 `expectCwd` 严格相等。
- 校验时机：二次鉴权之前做一次比较，`start()` 用的就是这次 `admit` 的结果，比较和使用之间没有 await。
- 409 那一次不写 LRU，所以确认后的重发不会被当成 dup，也不会出现摘要冲突。
- 文档里明确写：confirm 只是防误触，不是安全边界（arch §6.3）。

### 7.4 审计字段

`audit:"spawn"`，字段：`phase(request|reject|state)`、`endpoint`、`reqId`、`listener`、`ip`、`user`、`spawnId`、`cwd`（realpath）、`known`、`confirmed`、`dup`、`model`、`pid`、`state`、`code`、`endReason`、`exitCode`、`signal`、`ms`。

**不记录**：stderr、首条消息（首条消息走 `/api/cmd`，那里有自己的审计，只记 `textLen`）、请求原始的 `cwd` 字符串（只记 realpath，避免日志里出现 `~` 展开前的形态）。429 沿用 `RATE_AUDIT_WINDOW_MS` 去重（`http.ts:1584`）。

### 7.5 LAN 明文

- 默认 `lan:"off"`。即使用户配置了 `roots`，明文直连时也封顶为 `known`，并且每次都要确认、显示警告；子目录浏览不可用（防止目录枚举）。
- `/webhub status` 追加一行 `spawn on · roots=N · lan=off|known|roots(capped)`（S2 可选，放在 `agent/ui-status.ts` 旁边）。

---

## 8. 测试策略汇总（问题 7）

| 层          | 文件                                                                                                                              | 方法                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| protocol    | `tests/web-hub/protocol/{spawn,proc-identity}.test.ts`                                                                            | schema 正反例，marker 常量和 id 正则的同源钉住                                                                                  |
| config      | `tests/config/web-hub-settings.test.ts`、`tests/web-hub/agent/wiring-spawn.test.ts`、`tests/web-hub/hub/hub-spawn-config.test.ts` | 关闭时 `PI_WEBHUB_CONFIG` 深相等                                                                                                |
| hub 纯逻辑  | `tests/web-hub/hub/spawn/{dirs,rpc-stdio,store}.test.ts`                                                                          | 真实 tmpdir、注入 fs/proc、fake timers，并断言 `hasRef()===false`                                                               |
| hub 状态机  | `tests/web-hub/hub/spawn/supervisor.test.ts`                                                                                      | **mock spawn**：EventEmitter 做假 `ChildProcess` + PassThrough 做 stdio + 假 registry bus，表驱动覆盖 §3.1 每一行和 §3.2 的熔断 |
| HTTP        | `tests/web-hub/http/{api-headless,lan-headless}.test.ts`，以及 `api.test.ts`、`sse.test.ts`、`audit.test.ts` 的追加               | 两个 listener 都测；未启用时字节不变                                                                                            |
| 装配        | `tests/web-hub/hub/hub-spawn.test.ts`、`supersede.test.ts`、`agent-server-admin.test.ts`、`hub-json.test.ts`                      | caps 一致、关停顺序、idle、C9                                                                                                   |
| UI          | `logic-spawn`、`logic-state`、`transport-contract`、`use-new-session`、`agent-list`、`dir-picker`、`detail-header`                | 真值表、迁移表、组件交互                                                                                                        |
| 集成        | `tests/integration/web-hub-headless.test.ts` + 假的 rpc pi                                                                        | 真实 hub + 真实子进程                                                                                                           |
| conformance | `tests/conformance/rpc-spawn.test.ts`                                                                                             | 真实 pi，钉住 V1 / C1                                                                                                           |
| 真机        | `docs/dev/web-hub-spawn/acceptance.md`                                                                                            | tmux + 浏览器                                                                                                                   |

---

## 9. 与 web-hub-upload 方案的关系（问题 8）

**结论**：两个方案没有语义冲突，但有 9 个热点文件双方都会改，内容都是追加或相邻的 hunk。规则如下：

1. 新文件包（spawn 的 SP3/SP4/SP5/SP6/SP9，upload 的 U2/U4a）可以任意并行。
2. 热点包按「先合入者为准，后者 rebase」的方式串行：spawn 的 SP1/SP2/SP7/SP8 与 upload 的 U1/U3/U4b **不同时**在两个 worktree 里开发。

**另外两点**：

- upload plan 写的「另一 UI 包未提交，U5 须等待」这个前提已经被 `060c33b` 解除（C8）。两个方案的 UI 组件域互不相交：spawn 拥有 `components/agents/**`、`components/spawn/**`、`DetailHeader.vue`；upload 拥有 `components/control/Composer.vue`、`AttachmentTray.vue`。
- 两个方案的 `io` 注入形状（`readJson`、`sendJson`、`authorize`、`strictCsrfOk`）是同一种，建议先合入的一方把它定义为 `hub/ports.ts` 里的 `WriteGateIo` 类型，后合入的一方直接复用，避免出现两套。

| 热点文件                                                                         | spawn 的改动                                                                           | upload 的改动                                                                               | 冲突性质与约定                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol/http-contract.ts`                                                      | `SSE_EVENTS` 末尾追加 `spawns`；`API_ERRORS` 末尾追加 5 个码                           | `API_ERRORS` 末尾追加 4 个码；`AgentCard` 加 `upload*`                                      | 同一处数组尾部，rebase 时两段都保留，顺序无关                                                                                                                                      |
| `protocol/version.ts`                                                            | `SPAWN_HUB_CAP`                                                                        | `UPLOAD_HUB_CAPS` / `UPLOAD_AGENT_CAPS`                                                     | 相邻追加                                                                                                                                                                           |
| `protocol/paths.ts`                                                              | `webHubSpawnFiles`                                                                     | `webHubUploadsDir`                                                                          | 相邻追加                                                                                                                                                                           |
| `hub/ports.ts`                                                                   | `HubConfig.spawn`、`HubEvent.spawns`、`FrontendDeps.spawn`                             | `FrontendDeps.uploads`                                                                      | 同一个接口的相邻字段                                                                                                                                                               |
| `hub/http.ts`                                                                    | `:2080` 和 `:1122` 两处分派（在 POST 分支**之前**）；routeset 的 `spawns`；`statusFor` | `:2103` 和 `:1145` 两处（在 POST 分支**内部**、csrf 判断之前）；`uploadCsrfOk` 加在 `:1481` | 插入点相距 20 行以上，属于不同 hunk；`statusFor`（`:216-240`）可能相邻                                                                                                             |
| `hub/hub.ts`                                                                     | `:147-153`、`:203-227`、`:317-336`、`:347`、`:626`、`:636-648`                         | `:227` caps、`:317-335` 的 frontend 参数、cleanup                                           | `:227` 与 `agent-server.ts:153` **同一行**都要改。约定：spawn 引入 `extraHubCaps`；upload 如果后合入，改为往 `extraHubCaps` 里追加（无条件的 `UPLOAD_HUB_CAPS`），不再各自改那两行 |
| `hub/agent-server.ts:153`                                                        | `extraHubCaps`                                                                         | `UPLOAD_HUB_CAPS`                                                                           | 同上                                                                                                                                                                               |
| `hub/audit.ts`                                                                   | `auditSpawn`                                                                           | `endpoint` 联合加 `"upload"` 及白名单字段                                                   | 相邻；spawn 用独立的 `SpawnAuditRecord`，不碰 `ControlAuditRecord`                                                                                                                 |
| `config/settings.ts` / `setting-specs.ts` / `agent/index.ts`                     | `webHub.spawn.*`；`buildHubConfig`                                                     | `webHub.uploads`；`capsExtra`                                                               | `buildHubConfig`（`:484-505`）与 `capsExtra`（`:507-515`）相邻但在不同函数里；`DEFAULT_SETTINGS.webHub` 是同一个对象字面量，相邻追加                                               |
| UI `transport/*`、`logic/{contract,token-client,password-client}.js`、`types.ts` | 可选的 `spawn?`、`API.headless*`、`HubState.spawns`、`HubHandle.spawn`                 | 可选的 `upload?`、`API.upload*`、`ControlHandle.uploads`                                    | 都是可选字段的相邻追加；`transport-contract.test.ts` 两边都追加 describe 块                                                                                                        |
| tests                                                                            | `api.test.ts:318` 保留；`agent-server-admin.test.ts`、`hub.test.ts` 的 caps            | 同两个 caps 测试                                                                            | 统一改为基于 `extraHubCaps` 断言                                                                                                                                                   |

---

## 10. S2 包（S1 验收通过后再做）

| 包            | 内容                                                                                                                                                                                                | 文件                                                          | 验收                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| SP12 目录浏览 | `GET /api/headless/dirs?path=` 接入 `dirs.listChildren`（roots 内可用，最多 200 项，默认不含点目录，2s）；`policy.browse`；DirPicker 补全（防抖 200ms）                                             | `hub/spawn/routes.ts`、`DirPicker.vue`、`logic/spawn.js`      | roots 外 ⇒ `E_DIR`；明文 LAN ⇒ 不可用；补全有防抖；超过 200 项时 `truncated` |
| SP13 重新打开 | `reopen` 字段；`E_SESSION_IN_USE`（检查 registry 里所有 live 卡片的 `session.sessionFile`）；argv 追加 `--session <file>`（file 只能来自记录）；「在终端继续」只显示一条可复制命令（`textContent`） | `routes.ts`、`supervisor.ts`、`SpawnRow.vue`、`AgentList.vue` | 两个进程不会同时写同一个 jsonl；reopen 前重新 admit；真机验证 V5             |
| SP14 空闲回收 | `idleMinutes>0` 时：`agent_settled` 且没有 subagent 且没有 SSE 订阅持续 N 分钟 ⇒ `stop{idle}`                                                                                                       | `supervisor.ts`、`hub.ts`                                     | 忙碌的 agent 不会被回收；fake timers 覆盖                                    |
| launcher 回退 | registry 的 Rec 保存 `hello.launcher`（`registry.ts:307-339`），供 supervisor 回退使用                                                                                                              | `registry.ts`、`supervisor.ts`                                | `HubConfig.launcher` 失效时回退到同版本 agent 的 launcher                    |

---

## 11. 待确认问题

1. **（C6，需要用户拍板）** 首条 prompt 由 UI 在 `live` 之后转发（arch D5，本方案默认），还是由 hub 转发（SP-X）？SP-X 的做法：`SpawnRequestBody.firstPrompt?: string`（≤48 KiB，纳入 LRU 摘要）；supervisor 在进入 `live` 时构造 `CmdFrame{op:"prompt", origin: 请求方 principal}`，调用 `commandRouter.request()`；结果写进 `SpawnRecordWire.firstPrompt: {state:"pending"|"sent"|"failed", code?}`；审计只记 `textLen`。好处是标签页关掉、手机切后台也能送达；代价是 hub 要持有正文，`commands.ts` 的 origin 和审计要多一种来源。工作量大约 +1 个中包，放在 SP8 之后。
2. LAN 多用户：任何已登录用户都能停止别人拉起的受管会话（与「任何人都能 prompt 任何 agent」的现有信任模型一致）。是否需要限定只有发起者才能停止？
3. hub 的 env 是一份陈旧快照（arch R4）。是否需要在 `/webhub status` 里显示 hub 的启动时间，提示用户 `/webhub restart` 可以刷新环境？
