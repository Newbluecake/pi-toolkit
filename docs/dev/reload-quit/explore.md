# #24 跨版本 reload 后 pi 进程退出（RC3）· 只读定位

> 任务来源：#23 `docs/dev/web-update-stuck/explore.md` 的 RC3 单列；本文件只做定位，不改任何代码。
> 调研方式：只读（代码 / `~/.pi/agent/web-hub/hub.log*` / `~/.pi/agent/sessions/**` / `~/.zsh_history` / `ps` / `/proc`）。
> **未执行**：任何 reload、任何重启、任何 git 写操作、任何测试。
> 时间基准：本机 TZ=Asia/Shanghai，文中一律标 UTC（日志原生就是 Z）。

---

## 0. 结论摘要

1. **`agent down reason:"quit"` 只有一个来源：pi 进程自己优雅退出**（TUI `/quit`、Ctrl+C/D、extension `shutdown()`、SIGTERM/SIGHUP），
   不是崩溃、不是 reload。[F]
2. **reload 的任何结局都不会产生 `quit`**：成功 ⇒ `bye{handover}` + `agent reclaimed`；失败/新模块没起来 ⇒ `bye{detach-timeout}`。
   `bye{quit}` 只有在 pi 的 `AgentSessionRuntime.dispose()` 里才发。[F]
3. **新 pid 不是 hub 拉起的**：这 4 个会话（身份为 §1.3 的 [I] 推定：4 个 cwd）在 `spawns.json` 里没有任何 managed 记录，hub 在 02:47:40 那次重启也没有跑过 restore/relaunch；
   hub 只会 fork `pi --mode rpc`（kind=rpc），永远 fork 不出 TUI。[F]
4. **事后同构事件给出了决定性证据**：03:34:13Z 与 03:40:25Z 各有一条 `agent down reason:"quit"`，分别在 4.4s / 8.9s 后被新 pid 顶上；
   其中 03:34 那次在 `~/.zsh_history` 里有对应的一条交互式 `pi --session 01a1a966-…`（03:34:18Z），且 brain 转录里用户当轮明说「**我要测试重启**」。
   这就是「quit + 终端里 `pi --session` 重新起」的形态，正好落在 #23 描述的「7–11 秒」区间。[F]
5. 因此**倾向定性：不是跨版本 reload 的缺陷，是「优雅退出 + 终端侧重新起进程」（用户/终端行为），不是 hub 的退出+relaunch 设计路径**。
   留下的真问题不是 RC3，而是 §6 的几个可观测性缺口。[I]（置信度高，理由见 §4 的支持/反对表）

---

## 1. 证据与缺口（先说清楚什么还能证、什么已经不能证）

### 1.1 02:48 那一分钟的原始日志已经不可复核 [F]

- `~/.pi/agent/web-hub/hub.log` 第一行 `2026-11-05T05:47:24.500Z`；`hub.log.1` 覆盖 `03:23:04.079Z` → `05:47:24.095Z`（两文件首尾行实测）。
- 也就是说 **02:47:40Z（本代 hub 启动）到 03:23:04Z 这一段已经被下一次轮转覆盖**（只保留 1 份备份）。
- 本代 hub 从 02:47:40Z 一直活到现在（`pid 3478759`，`ps -o lstart` = `Thu Nov 5 10:47:40`；`spawns.json.writer.startedAt=1793846865228` = `02:47:45.228Z`），它**没有**重启过，
  所以丢失的只是日志文件，不是 hub 的内存状态。
- ⇒ #23 记录的“02:48:13Z 4 条 `op:command name:"agent" ok:true ~9ms`、随后 4 条 `agent down reason:"quit"`”这一段**无法再核**；本报告只能在别处找同构证据（§1.3）。

### 1.2 需要撤回的一条 #23 证据：`agent reclaimed epochChanged:true` 这个字面串在该日志格式里**永远不存在** [F]

- hub 的日志是结构化 JSON：`log.info("agent reclaimed", { agentKey, from, epochChanged })`（`src/web-hub/hub/registry.ts:402`），
  落在文件里是 `{"msg":"agent reclaimed","agentKey":…,"epochChanged":true}` —— 中间隔着 `agentKey` 字段，字面串 **`agent reclaimed epochChanged:true` 匹配不到任何一行**。
- 所以 #23 的「全日志 0 条 `agent reclaimed epochChanged:true`」**不能**当作「没有发生 reload handover」的证据。
- 我能给出的可靠版本：`grep -c '"msg":"agent reclaimed"' hub.log hub.log.1` = **0 / 0**（窗口 03:23Z→16:15Z，约 12.9 小时，期间确实没有任何会话做过 in-process reload，见 §2 的 handover 机制）[F]。
- 同理，「`agent down reason:"quit"`」也是转述而不是原文；原文形如
  `{"t":"2026-11-05T03:40:25.128Z","level":"info","pid":3478759,"msg":"agent down","agentKey":"a3570051-iIZdor","reason":"quit"}`（`hub.log.1:220`）。

### 1.3 事后同构事件：两次「quit + 秒级新进程」，其中一次有用户自述 [F]

| 时刻（Z）           | 事件                                                                                               | 坐标                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 03:34:13.610        | `agent down a3481868-Xa_Q5g reason:"quit"`                                                         | `hub.log.1:196`                                                                                  |
| 03:34:18            | 交互式 shell 命令 `pi --session 01a1a966-0b14-74fe-8850-4bf9ed920eec`（brain 会话）                | `~/.zsh_history:11440`（`: 1793849658:0;`）                                                      |
| 03:34:20.360        | `agent up a3544553-hAbZI6 kind:"tui" cwd:"/home/bluecake/ai/chat/brain" version:"0.10.6"`          | `hub.log.1:197`（进程 `3544553`，`ps` 启动时刻 `11:34:18`）                                      |
| 03:33:36 / 03:34:35 | 同一会话里用户先写「创建一个测试的todo，我要测试重启」，重启后又写「ok，测试通过了，可以关闭todo」 | `~/.pi/agent/sessions/--home-bluecake-ai-chat-brain--/2026-11-05T01-49-59-445Z_01a1a966-….jsonl` |
| 03:40:25.128        | `agent down a3570051-iIZdor reason:"quit"`                                                         | `hub.log.1:220`                                                                                  |
| 03:40:29            | 新 pi 进程 `3550048` 启动（ppid = 一个普通 `/bin/zsh`）                                            | `ps -o lstart -p 3550048`                                                                        |
| 03:40:34.026        | `agent up a3550048-FP9wPu kind:"tui" cwd:"/home/bluecake/ai/pi-toolkit" version:"0.10.6"`          | `hub.log.1:222`                                                                                  |

- down→up 间隔 **6.75s / 8.89s**，与 #23 描述的「7–11 秒后由新 pid 的 0.10.6 进程顶上」同形。
- 03:34 这次有**三重**独立证据（hub 日志 + shell 历史 + 用户自述）指向「用户自己退出并在该终端重新起同一会话」；03:40 这次缺 shell 历史（zsh 历史是退出/定期落盘，`~/.zsh_history` mtime=11:34，不能据此反证）。
- 02:49:57 / 02:50:56 / 03:01:57Z 三条交互式 `pi --session …`（`~/.zsh_history:11433/11434/11436`）与现存进程 `3480980`（cwd claude2api，启动 10:49:57）、`3493361`（cwd warren，启动 11:01:57）**逐秒对齐**；
  02:50:56 那条（brain）对应的进程后来在 03:34:13 退出、由 `3544553` 接手 —— 同一个会话的两次手工重启。[F]
- ⇒ 02:48 那 4 个会话的重启，最省解释就是**同一批手工重启**（4 个 cwd：`ai/claude2api`、`ai/chat/brain`、`ai/warren`、`ai/pi-toolkit`，正是被 reload 的 4 个工作会话）。[I]

### 1.4 一个未解释但不影响结论的细节 [I]

`agentKey` 的 pid 段来自 `hello.agentId.pid === process.pid`（`src/web-hub/agent/connection.ts:87-94`，`registry.ts:285-286` `a${id.pid}-${nonce}`）。
`a3570051`（03:40:25 才 down）比当时的现存进程 `3550048`（03:40:29 起）**pid 更大**，与 PID 单调递增冲突。
本机 PID 空间显然经历过回绕/嵌套（此刻 `echo $$` = `1035124`，而同时在跑的 pi 是 `3480980/3550048`，`cat /proc/sys/kernel/ns_last_pid` 也是小值），
**所以不能拿 pid 大小反推时间先后**。结论不依赖这一点：判定只用「down 之后 ~7–9s 出现一个新 agentKey 的 `agent up`」+ shell 历史时刻。

---

## 2. Q1 · Web「全部重新加载」从按钮到 agent 的完整路径

### 2.1 链路（每会话一条，逐帧）

1. **按钮**：「需更新」chip `src/web-hub/ui/src/components/agents/AgentCard.vue`；汇总入口 `src/web-hub/ui/src/composables/useOutdatedReload.ts` 的 `reloadAll`（对 `outdatedSessions()` 里每一行各发一次）。[F]
2. **transport**：`control.runCommand(key, "agent", "reload", { confirm: true })`（`useOutdatedReload.ts:153`）→ `POST /api/cmd`，`op:"command"`。[F]
3. **hub**：`src/web-hub/hub/http-cmd.ts`（`commands.request(frame)`，:129 / :609 区域）→ 要求该 agentKey **link live** 且 caps 含 `command.v1`（否则 `E_OFFLINE`/`E_UNSUPPORTED`，见 `useOutdatedReload.ts:130-138` 的 `precheck`）。[F]
4. **agent**：`src/web-hub/agent/commands.ts:1056` `handleCommand(frame)` → `deps.builtinBridge.execute(frame)`。[F]
5. **builtin bridge**：`src/web-hub/agent/builtin-bridge.ts:607-618`：
   `pi.sendUserMessage("/agent reload", { expandPromptTemplates: true, deliverAs: "followUp" })`，随即返回
   `{ op:"command", kind:"builtin", completion:"unknown" }`。
   ⇒ **`ok:true` 只代表「把这条斜杠文本塞进了 pi 的输入队列」，不代表 reload 执行过**。[F]
6. **pi-toolkit `/agent reload`**（deferred reload，`docs/dev/deferred-reload/README.md`）：
   `src/reload/command-port.ts`：忙（主会话流式 / 有活跃子 agent·workflow）⇒ `arm()` 挂起并给模型发 `subagent:reload-pending` 消息；
   送达时 TUI 仍在流式 ⇒ `deferFire()` 登记自然等待（`ctx.waitForIdle`，上界 30 分钟）；空闲 ⇒ `reload(ctx, "force")` → **`await ctx.reload()`（`:138`）**。[F]
7. **pi 侧语义**：TUI 宿主的 `ctx.reload` 映射到 `handleReloadCommand()`（`pi-coding-agent/dist/modes/interactive/interactive-mode.js:1528-1530`，实现 :5328+）
   → `AgentSession.reload()`（`dist/core/agent-session.js:2998`）→ 先 `emitSessionShutdownEvent(oldRunner, { type:"session_shutdown", reason:"reload" })`（:3001）
   → `resourceLoader.reload()`（重新 jiti 导入磁盘上的新代码 = 0.10.6）→ `session_start{reason:"reload"}`。[F]

**所以：agent 执行的是 pi 的 in-process `/reload`（同进程重新 activate），不是「退出后由 hub relaunch」。** [F]

### 2.2 一次成功的跨版本 reload 在 wire 上应该长什么样

- 旧 activation 的 `session_shutdown(reason:"reload")` → 本扩展 `conn.detach("reload")`（`src/web-hub/agent/index.ts:1905-1906` + `connection.ts:398-409`）：
  发 `session_detached` slot + 开 `detachGraceMs = 10s` 静默窗口（`protocol/messages.ts:1373`），**不发 bye**。[F]
- 新 activation 起来后 `acquireConnection()`（`connection.ts:257-278`）：若全局槽里还是旧连接，则 `existing.close("handover")`（⇒ `bye{reason:"handover"}`）并新建连接（同 agentId、新 `epoch = MODULE_INSTANCE`）。[F]
- hub `registry.register()` 命中同 agentId ⇒ `log.info("agent reclaimed", {from, epochChanged})`（`registry.ts:402`），
  `epochChanged ∧ prevPhase!=="stale" ∧ (caps∋hold.v1 ∨ caps∋epoch.up.v1)` ⇒ 先 `agent_up` 再 `gap`（`registry.ts:431-436`，即 #23 P-B）。[F]
- 该用户设置里没有 `webHub.control`/`steerRecall` 覆盖（`~/.pi/agent/pi-toolkit.json`），`holdWired = control!==false && steerRecall!==false` ⇒ 默认 `hold.v1` 在位（`src/web-hub/agent/hold.ts:27-29`，`index.ts:1712`），
  所以对**这套配置**，一次成功的 reload 本应在 02:48 就广播 `agent_up`、卡片当场解除「等待更新」。
  （注：`epoch.up.v1` 属于**未发布**改动 —— `git log v0.10.5..v0.10.6 -- src/web-hub/protocol/version.ts` 无提交，`v0.10.5:…/version.ts` 里也没有 `epoch.up`；即 02:48 时段在跑的 0.10.6 hub 还没有 P-B。）[F]
- 失败路径：`AgentSession.reload()` 抛错 ⇒ TUI 自己 catch 成 `"Reload failed: …"`（`interactive-mode.js:5399-5402`），进程继续活着；
  若新模块彻底没起来（旧 runner 已 `invalidate()`、10s 内没有新连接接管）⇒ 旧连接 `close("detach-timeout")`（`connection.ts:408-412`）⇒ hub 记 `reason:"detach-timeout"`。[F]
- **两条结局都不产生 `reason:"quit"`。** [F]

### 2.3 managed 与非 managed 的差别

- **reload 路径完全相同**（都在 agent 侧，与是否托管无关）。[F]
- 差别只在「进程死掉之后」：managed（`webHub.spawn.enabled` + `spawns.json` 里有 record，`kind:"rpc"`）可以被 hub 用 `restore`/`relaunch` 做 kill-old-then-fork
  （`docs/dev/web-hub-spawn/README.md` 的 _Restore across hub restarts_ / _Relaunch_ 两节；hub 关机时的 `mode = restore|terminate` 决策在 `src/web-hub/hub/hub.ts:1001`，`RESTORE_REASONS = {restart, superseded, crash}` 在 `hub.ts:138`）。[F]
- **非 managed（TUI / 外部 rpc）hub 没有任何拉起手段**：它只会 fork `pi --mode rpc`，不会 fork TUI；卡片只能变 down/stale，等人在终端里重新起。[F]
- 本次 4 个会话**都是非 managed**：`~/.pi/agent/web-hub/spawns.json` 共 21 条 record，11-05 只有 `gTDzFqXKtfSXvbNR`（03:32:22 起、cwd pi-toolkit、state live），
  没有任何 02:47–02:48 的 restore/relaunch 记录（restore 会保留原 spawnId 且把 `updatedAt` 刷到当时）。[F]

---

## 3. Q2 · `reason:"quit"` 是谁写的、什么条件下写；新 pid 是谁拉起的

### 3.1 写入者与条件（三段链条，全可查）

1. **hub 写这行**：`src/web-hub/hub/registry.ts` 的 `down(r, reason)`（:266-283），`log.info("agent down", { agentKey, reason })`（:281）+ `publish({type:"agent_down", …})`（:282）。
   `reason` 是从 agent 的 `bye` 帧原样带过来的。[F]
2. **`bye` 帧语义**：`src/web-hub/protocol/messages.ts:1229`
   `{ t:"bye"; reason: "quit" | "handover" | "detach-timeout" | string }`（`handover` = 同进程新模块实例接手，`quit` = 真退出）。[F]
3. **agent 侧唯一的 `bye{quit}` 发送点**：`src/web-hub/agent/connection.ts:398-403`
   ```
   detach(reason) {
     if (reason === "quit") { this.close("quit"); releaseConnection(this); return; }
     this.setSlot("session", { t:"session_detached", reason }); … 10s grace …
   }
   ```
   而 `detach()` 只有一个调用者：`src/web-hub/agent/index.ts:1903-1906`
   ```
   const reason = reasonOf(event);            // session_shutdown 的 reason
   const detachReason = reason === "reload" || reason === "new" || reason === "resume" || reason === "fork" ? reason : "quit";
   conn?.detach(detachReason);
   ```
   ⇒ **只要 pi 发 `session_shutdown` 且 reason 不是 reload/new/resume/fork，就一定记成 `quit`。**（`reasonOf` 见 `index.ts:2429-2432`；0.10.5 的实现一模一样：`git show v0.10.5:src/web-hub/agent/index.ts` 1868-1873 行）[F]

### 3.2 pi 里只有一条路会发出 `reason:"quit"`

- `pi-coding-agent/dist/core/agent-session-runtime.js:298`：`dispose()` 里 `emitSessionShutdownEvent(… { type:"session_shutdown", reason:"quit" })`。[F]
- 调用者：TUI 的 `shutdown()`（`dist/modes/interactive/interactive-mode.js:3444` 起；`:3473` `await this.runtimeHost.dispose()` → `:3479` `process.exit(0)`）。
  入口只有：`/quit`、Ctrl+C、Ctrl+D、扩展调 `shutdown()`、**SIGTERM/SIGHUP**（`fromSignal` 分支 :3449-3472 也走同一 dispose → exit 0）。
  web 通道**发不了**这些命令：`quit` / `exit` 在 `BUILTIN_DENY_NAMES` 里（`src/web-hub/agent/command-policy.ts:57,59`），policy 直接 deny。[F]
- **崩溃不走这条路**：`uncaughtCrash()`（`interactive-mode.js:3499-3533`，注册于 :3572）只 `recordCrash("uncaught_exception")` + `process.exit(1)`，**不 emit session_shutdown**；
  `handleFatalRuntimeError()`（:1609-1623）也只 `recordCrash("fatal_error")` + exit(1)。
  ⇒ 崩溃时 hub 看到的是「socket 关闭但没有 bye」→ `stale`（30s）→ `reapMs`（60s）后才 `agent down`，**reason 不会是 quit**（`protocol/messages.ts:1370-1372` 的 `staleMs/reapMs`，`registry.ts:713-718`）。[F]
- 实证：`~/.pi/agent/crashes.json` 只有 2 条（2026-09-28、2026-10-14），**2026-11-05 没有任何 crash / fatal_error 记录**。[F]

**⇒ `reason:"quit"` ≡ 进程优雅退出（exit code 0），与 reload / 崩溃都无关。** [F]

### 3.3 新 pid 是谁拉起的

- **不是 hub**：无 spawn record（§2.3）；现存 `hub.log.1` 里唯一的 spawn 相位行是 03:32 那条正常 spawn（`hub.log.1:171-175`），而 `spawns.json` 里 11-05 只有 `gTDzFqXKtfSXvbNR` 一条 record ⇒ 02:47–03:23 那段（日志已丢）也不可能有 restore/fork 落库；且 `agent up` 的 `kind:"tui"`。[F]
- **是终端**：03:34 那次的 `pi --session 01a1a966-…` 就在 `~/.zsh_history:11440`（`1793849658` = 03:34:18Z），与进程 `3544553` 的启动时刻同秒；
  pi 优雅退出时本来就会打印 `To resume this session: pi --session …`（`interactive-mode.js:3474-3477`），照抄即可复现「4–9 秒后新 pid」。[F]
- 02:49:57 / 02:50:56 / 03:01:57Z 三条同型命令与现存进程逐秒对齐（§1.3）。[F]

---

## 4. Q3 · 定性：按设计的「退出 + relaunch」，还是崩溃/异常退出？

**结论：都不是。#23 观察到的 down/up 是「优雅退出 + 终端侧重新起进程」，既不是 hub 的退出+relaunch 设计路径，也不是崩溃。** [I]（置信度高）

### 支持

| #   | 证据                                                                                                               | 强度 |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---- |
| S1  | `reason:"quit"` 只能由 `bye{quit}` 产生，而 `bye{quit}` 只来自 pi 的 `dispose()`（优雅退出）；崩溃路径根本不发 bye | [F]  |
| S2  | 崩溃会写 `crashes.json`（`uncaught_exception` / `fatal_error`），11-05 没有任何条目                                | [F]  |
| S3  | reload 的成功/失败两种结局分别对应 `bye{handover}` / `bye{detach-timeout}`，都与观测不符                           | [F]  |
| S4  | 4 个会话都不是 managed（`spawns.json` 无 record、无 restore 日志），hub 物理上无法 fork TUI                        | [F]  |
| S5  | 事后同构事件 03:34：`agent down` 4.4s 后 shell 历史里出现 `pi --session 01a1a966-…`，用户当轮自述「我要测试重启」  | [F]  |
| S6  | 同一批 `pi --session …` 命令在 02:49:57 / 02:50:56 / 03:01:57Z 出现，与现存进程启动时刻逐秒对齐                    | [F]  |
| S7  | web 命令面 deny 了 `quit`/`exit`，用户点按钮不可能直接触发退出                                                     | [F]  |

### 反对 / 仍未闭合

| #   | 疑点                                                                                                                                                       | 说明                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | 02:48 那 4 条的原始日志已丢（§1.1），只有 #23 的转述                                                                                                       | 只能靠 §1.3 的同构证据间接支撑 [I]                                                                                                      |
| O2  | 「为什么 4 个会话会在 reload 之后陆续被重启」没有直接记录                                                                                                  | 最省解释：UI 一直「等待更新」（#23 RC1/RC2），用户依次重启会话自证；也可能是 reload 在 TUI 里报了 `Reload failed: …` 而用户选择重启 [I] |
| O3  | 该用户默认配置带 `hold.v1`，成功 reload 本应立刻 `agent_up` 解除等待；「一直等待」反而说明**reload 根本没跑完**（armed/parked 未到 idle，或 TUI 拒绝执行） | 支持「等待状态」与「进程退出」是两件独立的事 [I]                                                                                        |
| O4  | `agentKey` pid 段与 `ps` 排序冲突（§1.4）                                                                                                                  | 本机 pid 空间回绕过，不能当时间证据；不影响定性 [I]                                                                                     |

### 如果一定要给 RC3 一个「最可能根因」

不是崩溃，而是 **#23 RC1/RC2 的副作用链**：reload 命令 ack 了但会话没到位 ⇒ 前端停留在「等待更新」⇒ 用户手动重启 4 个会话（唯一的拉起点是终端）⇒ hub 依次记下 4 条 `quit` 与 4 个新 agentKey。**RC3 因此更像「验收路径问题」而不是独立缺陷。** [I]

---

## 5. Q4 · 若按设计：#23 前端卡片能否正确处理，还缺什么

### 5.1 已经能处理的（P-A / P-B 现状）

- **P-A 已在盘上**：`src/web-hub/ui/src/logic/outdatedReload.ts`
  - 送达前本地预判离线 ⇒ `fail(key,"E_OFFLINE")`（:425-427）；
  - `notifyTick()` 里 **先判版本到位（done 优先）再判离线**，`queued/sending/awaiting/parked` 任一相遇到 `deps.offline(key)` ⇒ `E_OFFLINE` 并清全部计时器（:464-487）；
  - `offline` 判据 = 不在 `agents` ∨ `down` ∨ `card.state==="stale"`（`useOutdatedReload.ts:62-66,145`）；
  - 文案如实：`outdated.errOffline` = 「会话已离线（进程已退出或正在重启），重新加载未完成；若会话已重启，请在新卡片上查看或重试」（`ui/src/i18n/zh/outdated.ts:25`，en 同义 :24-25）。
    ⇒ **「等 90s/30min 才收场」这个问题已经解决**；下线会在下一次 `notifyTick` 就结算成 failed。[F]
- **P-B 已在盘上但未发布**：`registry.ts:431-436`（`hold.v1 ∨ epoch.up.v1`）+ agent 尾部追加 cap（`agent/index.ts:1734-1737`）。**它只对「reload 成功」有用**，对本文讨论的「进程重启」无效（重启是**新 agentKey**，走 `register()` 新建分支，不是 reclaim）。[F]

### 5.2 仍然缺什么（按重要性）

1. **跨 key 的收敛（缺）**：`isSettled` 被设计成「只在同一个 key 上成立，不跨 key 追认」（`outdatedReload.ts:461-463` 注释 D6），
   而进程重启**必然换 agentKey** ⇒ failed 行永远留在那张已经死掉的卡片上，新卡片上如果版本已到位也不会回写旧行。
   managed 会话有 `successorOf` 兜底（`ui/src/logic/spawn.js`），**非 managed 没有任何 sessionId/cwd 级别的 successor 关联**。[F]
2. **「reload 其实没执行」的可观测性（缺）**：bridge 只回 `completion:"unknown"`（`builtin-bridge.ts:613-618`），
   TUI 侧真实结果（`"Reload failed: …"`、`Wait for the current response to finish before reloading.`）**没有回传通道**；
   前端无法区分「送达未执行」「执行失败」「执行成功但没 ack」。[F]
3. **文案只能二选一（缺）**：`errOffline` 说「进程已退出**或**正在重启」，无法告诉用户「已经在新卡片起来了」——需要 (1) 的关联才能说清。[F]
4. **测试缺口**（#23 已列，仍然成立）：`tests/web-hub/ui/outdated-reload.test.ts` 只测纯协调器；没有「handover→agent_up→done」闭环，也没有「等待期间目标下线」之外的重启换 key 场景。[F]

### 5.3 建议的最小补丁（若要闭合 #24，不再动 reload 本体）

- **必做（低成本、无 wire 变更）**：failed 行增加「在新卡片上继续」入口 —— 用 `sessionId`（同一 `--session` 重启会保 id）+ `cwd` 做一次"best-effort successor"匹配，命中且新卡 `pluginVersion===hubVersion` ⇒ 旧行直接转 `done`（文案改成「已在新的 <key> 上生效」）。判定放在 UI 纯逻辑层，`sessionId` 缺失就退回现在的 `errOffline` 文案。
- **可选**：`builtin-bridge` 的 reload 分支在 TUI 宿主提供 `commandCapture` 时把捕获输出带进 `CmdData`（追加字段，I10 兼容），让前端能显示「Reload failed: …」。
- **不建议**：为了这 4 条 down 去改 reload/deferred 逻辑 —— 证据不支持「reload 导致退出」。

---

## 6. Q5 · 需要用户拍板的点

1. **RC3 定性**：(a) 直接结为「非缺陷：用户/终端侧重启，reload 不退出进程」，只在 `docs/dev/web-hub/README.md` 补一段「三种 reason 的区分表」（quit / handover / detach-timeout）**（推荐）**；
   (b) 继续追 02:48 的原始日志 —— 但那段已被轮转覆盖，除非另有机器级 syslog 副本，否则不可能复原。
2. **是否做 §5.3 的跨 key successor 收敛**：会引入「两个不同 agentKey 视为同一会话」的判定（依据 `sessionId`+`cwd`），
   误判风险是 `/resume` 复用同一 sessionId 的不同进程被归并；需要你决定「宁可误并（体验顺滑）」还是「宁可分开（信息准确）」。**推荐做，且只在 failed 行上做只读提示/收敛，不做自动重发。**
3. **日志保留**：本次定位被 `hub.log` 只留 1 份备份卡死。是否把 web-hub 日志轮转改成保留 3 份（或按天切）？独立小改动，不涉 wire。
4. **是否要 §5.3 可选项的 reload 结果回传**（新增追加字段）：会动 `command` op 的 `data` 形状，需要你确认是否现在做。

---

## 7. 若最终仍判定为 bug：根因假设与验证计划（**未执行**，仅为后续可用）

> 前提：必须先推翻 §3.2 的「`reason:"quit"` 只能由优雅退出产生」。若推翻不了，本节的假设都只是纸面。

- **H1（跨版本 reload 抛错但被误读为退出）**：旧 activation 的 `session_shutdown` 已跑、`resourceLoader.reload()` 抛错 ⇒ 10s 后 `detach-timeout`。
  _验证判据_：02:48 若真有日志，应出现 `"msg":"agent down"…"reason":"detach-timeout"`；实际 #23 记的是 `quit` ⇒ H1 被证伪（若 #23 转述无误）。
- **H2（HOST_KEY 未释放 ⇒ 新实例 inert）**：`src/index.ts:298-300` claim、`:374-377` 释放（`if (g[HOST_KEY] === claim) delete g[HOST_KEY]`）。若旧 activation 的 shutdown handler 抛错，claim 残留 ⇒ 新 activate 早退（`isChildSession=true`）。
  _验证判据_：同样只会导致「没有新连接」⇒ `detach-timeout`，仍非 `quit`。要观测的话：`/webhub status` 该会话是否从 fleet 消失、TUI 里 `/agent` 是否消失。
- **H3（设置了 schema 版本错位）**：`prepareSettingsFile()`/`loadSettingsFromFile()` 在 activate 早期就会写迁移；0.10.6 删了 `schedule confirm`、加了 `reflex`（`git diff v0.10.5 v0.10.6 -- src/index.ts`）。
  _验证判据_：reload 后 TUI 是否出现 `Reload failed: …`；`~/.pi/agent/pi-toolkit.json` 是否被改写异常。
- **可复现的观测脚本（勿在有在跑会话的机器上执行）**：保留一个 0.10.5 进程 → 磁盘升到 0.10.6 → 对该会话点「重新加载」→ 看三件事：
  ① TUI 是否出现 `Reload failed:`；② `hub.log` 是否出现 `"msg":"agent reclaimed"` + `"epochChanged":true` + `agent_up`；③ 超过 10s 无 reclaim ⇒ 应该看到 `reason:"detach-timeout"` 而不是 `quit`。

---

## 附录 A · 时间线（UTC）

| 时刻            | 事件                                                                                                                                          | 证据                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 02:46:28        | v0.10.6 tag（`chore(release): bump version to v0.10.6`，提交时刻 10:46:28 +0800）                                                             | `git log -1 --format='%ci %s' v0.10.6` [F]                       |
| 02:47:40        | 本代 hub 启动（`pid 3478759`，ppid=1）                                                                                                        | `ps -o lstart`；`spawns.json.writer.startedAt=1793846865228` [F] |
| 02:48:13        | 4 条 `op:command name:"agent" ok:true ~9ms`（“全部重新加载”）                                                                                 | #23 记录（原日志已被轮转覆盖）[I]                                |
| 02:48:13.66–.81 | claude2api / brain / warren 三会话各写一条 `subagent:compact-dynamic`（**弱证据**：该 custom entry 平时也周期性写，不能当作 activation 指纹） | 三个 jsonl [F 事实 / 不可用于推断]                               |
| 02:49:53        | claude2api 会话文件最后一次写入（随后进程退出）                                                                                               | jsonl 尾 3 条 `02:49:53.171Z` [F]                                |
| 02:49:57        | shell `pi --session 01a1a721-…`（claude2api）→ 进程 `3480980`                                                                                 | `~/.zsh_history:11433` + `ps` [F]                                |
| 02:50:56        | shell `pi --session 01a1a966-…`（brain）                                                                                                      | `~/.zsh_history:11434` [F]                                       |
| 03:01:57        | shell `pi --session 01a19b95-…`（warren）→ 进程 `3493361`                                                                                     | `~/.zsh_history:11436` + `ps` [F]                                |
| 03:23:04        | `hub.log.1` 起点（02:47:40–03:23:04 已被覆盖）                                                                                                | `head -1 hub.log.1` [F]                                          |
| 03:32:22        | 唯一一条 11-05 的 managed spawn（`gTDzFqXKtfSXvbNR`，cwd pi-toolkit，仍在跑）                                                                 | `spawns.json`；`hub.log.1:172-175` [F]                           |
| 03:34:13.610    | `agent down a3481868-Xa_Q5g reason:"quit"`                                                                                                    | `hub.log.1:196` [F]                                              |
| 03:34:18        | shell `pi --session 01a1a966-…`（brain，第二次）                                                                                              | `~/.zsh_history:11440` [F]                                       |
| 03:34:20.360    | `agent up a3544553-hAbZI6 kind:"tui" cwd chat/brain v0.10.6`                                                                                  | `hub.log.1:197` [F]                                              |
| 03:40:25.128    | `agent down a3570051-iIZdor reason:"quit"`                                                                                                    | `hub.log.1:220` [F]                                              |
| 03:40:34.026    | `agent up a3550048-FP9wPu kind:"tui" cwd pi-toolkit v0.10.6`                                                                                  | `hub.log.1:222` [F]                                              |

## 附录 B · 本次用到的坐标

- **代码**
  - `src/web-hub/agent/builtin-bridge.ts:607-618`（`/reload` → `sendUserMessage("/agent reload")`）
  - `src/web-hub/agent/command-policy.ts:30-70`（`quit`/`exit` deny；`agent reload` 属 confirm 级）
  - `src/reload/command-port.ts:88-148`（`reload()`：force/abort 有界等待 → `await ctx.reload()`；arm/deferFire 在 :57-87）
  - `src/web-hub/agent/connection.ts:257-278`（handover）、`:398-413`（detach 的 quit vs grace + `close("detach-timeout")`）
  - `src/web-hub/agent/index.ts:1903-1906`（detachReason 映射）、`:2429-2432`（reasonOf）、`:298-300/:374-377`（HOST_KEY claim/release）、`:1670-1737`（caps）
  - `src/web-hub/hub/registry.ts:266-283`（down 日志）、`:387-439`（reclaim + epochRefresh）
  - `src/web-hub/hub/hub.ts:138`（RESTORE_REASONS）、`:1001`（hub 关机时的 restore/terminate）
  - `src/web-hub/ui/src/logic/outdatedReload.ts`（OrCoordinator / E_OFFLINE / D6 同 key 限制）
  - `src/web-hub/ui/src/composables/useOutdatedReload.ts:62-66,130-153`
  - `src/web-hub/ui/src/i18n/zh/outdated.ts:25`、`ui/src/i18n/en/outdated.ts:24-25`
- **pi（安装版 1.3）**
  - `dist/core/agent-session.js:2998-3030`（reload：先 `session_shutdown{reason:"reload"}`，再重新导入）
  - `dist/core/agent-session-runtime.js:298`（`dispose()` → `reason:"quit"`）
  - `dist/modes/interactive/interactive-mode.js:1528-1530`（`ctx.reload` → `handleReloadCommand`）、`:3444-3480`（shutdown，含 fromSignal，`To resume this session:` 在 :3474-3477）、`:3499-3533`（uncaughtCrash，不发 shutdown）、`:1609-1623`（fatal_error）、`:5328-5402`（reload 实现与 `Reload failed:`）
- **运行时数据**
  - `~/.pi/agent/web-hub/hub.log`（起点 05:47:24.500Z）、`hub.log.1`（03:23:04.079Z–05:47:24.095Z）
  - `~/.pi/agent/web-hub/spawns.json`（21 条 record；11-05 仅 `gTDzFqXKtfSXvbNR`）
  - `~/.pi/agent/crashes.json`（仅 2026-09-28 / 2026-10-14 两条）
  - `~/.zsh_history:11432-11440`
  - `~/.pi/agent/sessions/--home-bluecake-ai-chat-brain--/2026-11-05T01-49-59-445Z_01a1a966-….jsonl`
  - `~/.pi/agent/sessions/--home-bluecake-ai-claude2api--/2026-11-04T15-16-10-762Z_01a1a721-….jsonl`
