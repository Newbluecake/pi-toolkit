# AF7 交付报告：`/new` 把别名交接给新会话（#72，D3）

基线：`feat/alias-72` @ 9384e144（AF0–AF6 + AFW + AFU）。`tests/fixtures/` 零改动，`governance/activate-trace.json` 不变（没有新增注册），线协议只追加（沿用 AF0 已有的 `intent:"handoff"` / `prevSessionId`，不 bump PROTO）。

## 改动

| 文件                                            | 内容                                                                                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/hub/xs/members.ts`                 | 继承边：`succession`（每个 agentKey 一格，`{from, to?, at}`，TTL 120s，仅内存）；`predecessorOf(agentKey)`、`clearPredecessor(agentKey)` 进入 `XsMembers`                                                                          |
| `src/web-hub/hub/xs/aliases.ts`                 | `store.handoff()` + `planHandoff` + `handoffStale`（plan 时与 rename 前各判一次）；新 dep `isSuccessor`                                                                                                                            |
| `src/web-hub/hub/xs/router.ts`                  | handoff 形状校验（需 alias + prevSessionId，不得带 take/clear）与分派；成功后消费继承边；binding 注入 `isSuccessor`（读 `members.predecessorOf`，**不读帧内容**）                                                                  |
| `src/fabric/xs/alias-handoff.ts`（新，pi-free） | 进程级一次性槽：`stashXsAliasHandoff` / `takeXsAliasHandoff(now)`，容量 1、TTL 60s、消费即清、无可带内容则不写                                                                                                                     |
| `src/fabric/xs/activate.ts`                     | `stashMembershipHandoff` 里（同一时机，仅 `reason:"new"`）放入；`beginSessionStart` 任何 reason 都清槽，只有 `new` 且 sid 不同才采用；`aliasHandoff` 端口（pending/settle，120s 过期）；`aliasHumanDecided`；`handoffPending` 真值 |
| `src/fabric/xs/stack.ts`                        | `aliasDecidedInherit`（`reason==="new"` 时为新 sid 写 `via:"inherit"`）；`aliasHumanDecided` 钩子（人工 set/clear/take/force 取消待发的交接）                                                                                      |
| `src/fabric/xs/types-alias.ts`                  | `XsAliasCachePort.heldFor?(sid)`（见偏差 1）                                                                                                                                                                                       |
| `src/web-hub/agent/xs.ts`                       | `aliasHandoff` 端口；reconcile ①：已应用的 `none` 之后、auto 之前发一次 handoff；`handoffBusy` 阻止并发 reconcile 抢先 auto                                                                                                        |
| 文档                                            | `README.md`（「/new 不交接」改为「别名随 `/new`；fork 不继承」+ AF7 一节）、`alias-acceptance.md`（6.9 改为仅 fork；新增 7.20–7.26）、本报告                                                                                       |
| 测试                                            | 见下                                                                                                                                                                                                                               |

## 防伪造设计（重点）

证据全部是 **hub 自己对同一条 socket 的观察**，不采信帧里的任何声明：

1. **继承边**（`members.predecessorOf`）：一个 `/new` 到 hub 表现为同一 agentKey 上依次出现 `session_detached` → `session(新 sid)` → `xs_member(新 sid)`。`onInvalidate("detached")` 把即将删除的旧记录的 sid 记为 `from`；`onSession`/`onMember` 看到另一个 sid 时在删除/覆盖旧记录**之前**写入 `{from, to, at}`。`from` 来自 hub 此前为**同一 agentKey** 记录的 sid。
2. 每个 agentKey 只有一格；他人 socket 没有边；一个有自己继承链（X→Y）的 socket 只能点名自己的前任 X。`prevSessionId` 只与这条边比较（`e.from === prev` ∧ 边的 `to` 等于该 socket 当前成员 sid ∧ ≤120s）。
3. 边在 socket 因 down/closed/reclaimed 失效时清除；同 sid 回来（reload/resume）视为非继承；成功转移后消费（单次有效）。
4. 在边之上，`store.handoff` 还要求（plan 与 rename 前**两次**复核）：记录是 `held(prev)` 且正是该别名；`prev` 为 `offline`（既不是另一 socket 上的 xs-online，也不是 `linked`）；请求方名下无任何 held；`prev !== 自己`。任何不满足一律 `E_XS_ALIAS_TAKE{stale}`（队列/IO 问题仍是 BUSY/UNKNOWN）。
5. 转移是原地的：`rev+1`、保留 `origin`（human 无、auto 为 `"auto"`）、cwd 标签换成请求方的、不写墓碑、不留 cooling，并清掉 prev 与新 sid 的墓碑（没有冷却窗口，名字不会短暂空出被别人抢）。
6. 无 v2 能力的请求方带 intent 仍是 `E_XS_BAD_FRAME`；audit 只写子操作 `handoff`，不写别名文本与 prevSessionId。

残留（见下）：同 uid 且能自己伪造 `session`/`xs_member` 帧的进程不在威胁模型内（hub 的成员表本来就信任同 uid 进程，见 `clampMemberLimits` 的注释）。

## agent 侧行为

- **fork 与 `/new` 的区分**与 #70 一致：只有 `session_shutdown{reason:"new"}` 放槽；`session_start` 无论 reason 都清槽，只有 `reason==="new"` 才采用，且要求新 sid ≠ 槽里的旧 sid。fork/resume 永远不采用（含 decided 标记）。
- **hub 离线/不支持的降级**：旧 hub（无 `xs.alias.v2`）一帧都不发，待交接 120s 后过期；`/new` 时 hub 不可达 ⇒ 不发帧，过期后走普通 auto；hub 在 `/new` 期间重启 ⇒ 继承边丢失 ⇒ `stale`；hub 对 handoff 回 BAD_FRAME（AF7 之前的 hub）同样当作失败。以上都**落到 AFW 的 autoFromCwd 路径**。
- **回退且不覆盖人工设置**：handoff 只在「已应用的 get 为 `none`」之后发，所以新会话已经有别名（人工 set/auto 先到）就不会发；窗口内发生人工 set/clear/take/force ⇒ `aliasHumanDecided` 清掉 pending；即使发出，hub 在「请求方已有 held」时也拒绝。回退到 auto 时，继承来的 decided 标记仍然压制 auto（人工「不要别名」的决定随 `/new` 走）。
- `autoFromCwd=false` 时 handoff 仍然生效（延续而非认领），`aliasHandoff` 端口按 alias 开关装配，与 `aliasAuto` 无关；alias 关 ⇒ 不放槽、不发帧、不写标记。

## 测试

| 文件                                                         | 覆盖                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/web-hub/hub/xs-aliases-v2.test.ts`（+9）              | store handoff：原地转移字段（owner/rev/label/无墓碑/无 cooling/heldBy）、origin 保留（auto 保留，human 仍无，v1 get 不可见）、落盘重启读回、全部拒绝路径（无证据/证据指向别人/陌生人引用/错别名/非法别名/prev=自己/prev 在线/prev linked）、cooling(P)、请求方已有 held、rename 前复核（证据撤回/P 回线/P linked 三种变异）、两个后继竞争同一旧名恰好一个成功、无 `isSuccessor` dep 永不转移                |
| `tests/web-hub/hub/xs-members.test.ts`（+6）                 | 继承边：detach→session→member 序列、无 detach 的直接切换、onMember 先于 onSession、每 socket 独立、同 sid 回来非继承、TTL 与消费与替换、socket 关闭清除、to 不匹配不应答                                                                                                                                                                                                                                    |
| `tests/web-hub/hub/xs-alias-v2-router.test.ts`（+16，改 1）  | 真 registry×真 store：`/new` 成功（in place、origin、无墓碑、可按别名收发）、**两种伪造**（陌生 socket 点名受害者；有自己继承链的 socket 点名受害者；受害者离线也拒）、错别名、prev=自己、TTL 过期、旧 sid 在另一 socket 在线/linked、别人已 force 抢走、新会话已有别名、reload 非继承、socket 关闭清边、非 v2 BAD_FRAME、单次有效、audit 不含别名/prev。原「AF7 未实现 ⇒ BAD_FRAME」用例改为只保留非法组合 |
| `tests/web-hub/agent/xs-alias-auto.test.ts`（+8）            | 桥：handoff 帧形状与先于 auto、成功静默无 auto、五种失败码都回落 auto 且不重发 handoff、无 `aliasAuto` hook 仍发、已有别名不发、v1 hub 零帧且不消费 pending、在途时并发 reconcile 不 auto、无 pending ⇒ 与 AF7 前一致、端口抛错不影响                                                                                                                                                                       |
| `tests/fabric/xs-alias-handoff.test.ts`（新，6）             | 槽：Symbol.for 键、一次性、无可带内容不写、容量 1、TTL 边界/未来时间戳、脏值不抛                                                                                                                                                                                                                                                                                                                            |
| `tests/integration/fabric-xs-alias-wiring.test.ts`（+11）    | 真 `activate()`×真 stack×假 hub socket：`/new` 后 handoff{alias, prevSessionId=旧 sid, origin=新 sid} 先于 auto；失败回落 auto 恰好一次；fork/resume 不交接且不继承 decided、过期残槽被后续 start 丢弃；decided 继承写 `via:inherit`（新 sid）；非 decided 不写；decided 无别名只继承标记；`autoFromCwd=false`；v1 hub / alias 关；新会话的人工 `--clear` 抢在 hub 应答前 ⇒ 不交接；超过窗口后不再发        |
| `tests/integration/fabric-xs-alias-v2.test.ts`（+2，集成 ⑨） | **真 hub 子进程**：⑨a `/new` 交接（auto 与人工两种，origin 保留，旧 sid 无记录/墓碑，decided 继承 `/reload` 后不 auto，fork 不拿别名且无墓碑）；⑨b 伪造 prevSessionId（在线与离线受害者）被拒、别名纹丝不动；旧会话别名已被 `--force` 抢走（agent 缓存被冻结以制造过期 stash）⇒ hub 拒绝、抢占者保留、新会话不拿回也不抢                                                                                    |
| `tests/integration/helpers/fabric-xs-process.ts`             | 测试夹具新增 `holdAlias`/`releaseAlias`（挂起裸 alias get）与 `rawAlias`（以本 peer 身份发任意 alias 帧）；不在 `tests/fixtures/` 下                                                                                                                                                                                                                                                                        |

### 变异验证（均已还原）

| 变异                                | 结果                 |
| ----------------------------------- | -------------------- |
| router `isSuccessor` 恒真           | 3 例失败（伪造用例） |
| 去掉 `presenceOf(prev) === offline` | 4 例失败             |
| 去掉「请求方已有 held ⇒ stale」     | 2 例失败             |
| 去掉 detach 继承边                  | 11 例失败            |
| 不放槽（`stashAliasHandoff`）       | 6 例失败             |
| 不限 `reason==="new"` 才采用        | 1 例失败             |
| 不调用 `maybeHandoff`               | 9 例失败             |
| 去掉 `handoffBusy`                  | 1 例失败             |

## 自验

均在 `/tmp/alias-afw`，未执行 install。

| 命令                                                                                                                                                                              | 结果                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `npm run format:check`                                                                                                                                                            | 通过                                           |
| `npm run typecheck`                                                                                                                                                               | 通过（TS7 ×2 + vue-tsc）                       |
| `npx vitest run tests/fabric tests/web-hub tests/integration/fabric-xs-alias-v2.test.ts tests/governance tests/conformance/fabric-xs.test.ts`                                     | 759 文件 / 16749 通过 / 4 skip（既有）         |
| `npx vitest run tests/integration/fabric-xs-off-golden.test.ts …/fabric-xs-alias.test.ts …/fabric-xs-alias-wiring.test.ts …/fabric-xs-channel-compat.test.ts …/fabric-xs.test.ts` | 5 文件 / 46 通过                               |
| `git diff --quiet 9ce5abc7 -- tests/fixtures/`                                                                                                                                    | 干净（三份 off golden、activate-trace 等未动） |

## 偏差与说明

1. **`XsAliasCachePort.heldFor?(sid)`**（方案未列）：`session_shutdown` 里 `registerFenceHooks` 的钩子先执行并置 `xsAttached=false`，之后 `aliasCache().current()`（经由 attached stack 取 sid）读不到旧会话，必须按显式 sid 读。纯类型追加 + 一行实现，无 wire 变化。
2. **继承边要覆盖 `detached`**：方案只写 `onSession`/`onMember`。但 `/new` 先发 `session_detached`，`onInvalidate` 会先删成员记录，此时 `onSession` 已看不到旧 sid，边永远写不出来。实现里 `onInvalidate("detached")` 先记下旧 sid（detach-only 边，`to` 之后补），其余 invalidate 原因清边。这是对方案的必要补全，已写入 README。
3. 边的 TTL 从「后继 sid 出现」起算（detach-only 边的 `at` 在补 `to` 时刷新），避免慢 attach 吃掉窗口。
4. 方案 §5.5 写「decided 为新 sid 写 inherit」放在 stack 构建时；实现落在 `buildAliasDecided`（`reason==="new"` ∧ 本会话尚无自己的标记），与读取 `getEntries()` 的 AFW 逻辑同处。

## 残留风险

- **R22**：继承边只在 hub 内存、`/new` 窗口 ≤120s、进程槽 60s；hub 在此期间重启、`/new` 时 hub 不可达、新 stack 迟迟未 attach ⇒ 不交接，旧名留在旧 sid 直到 take/force。
- 威胁模型：同 uid 进程可以自己伪造 `session`/`xs_member` 帧（先自称旧 sid 再切换），hub 无法区分；这与现有成员表信任模型一致。伪造需要旧 sid 恰好处于 offline 且别名仍是它的，且新 sid 此前不持有任何名字。
- `/resume`、`/fork` 在 hub 看来与 `/new` 同形（同 socket 换 sid）：同一进程的会话间别名可被该进程的**新 sid** 请求转移，但 agent 只会在 `reason:"new"` 时发；本进程在 hub 上的身份本来就是同一个 agentKey。
- 被冻结 agent 缓存导致的「旧会话已被抢走但本地缓存仍显示持有」会放出一次被 hub 拒绝的 handoff 帧（集成 ⑨b 覆盖），无副作用。
- 真机验收（alias-acceptance 7.20–7.26）未执行。
