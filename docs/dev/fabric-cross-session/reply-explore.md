# fabric 跨会话「请求-回复关联」文件坐标图

## 1. 工具面（message_session / list_sessions）

| 坐标                                      | 作用                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/tools/message-session-tool.ts:21-47` | `MessageSessionParams` 冻结模块常量 schema（`to`/`text`/`wake`，provider 缓存前缀约定，形状永不随设置变）            |
| `src/tools/message-session-tool.ts:50`    | `XS_UNKNOWN_HINT`——`unknown` 裁决的 r3 S3 固定文案（可能已入队、勿盲重发）                                           |
| `src/tools/message-session-tool.ts:53-71` | `createMessageSessionTool`：execute 调 `sender.message`，返回 `JSON.stringify(outcome)+hint`，`details` 携带 outcome |
| `src/tools/list-sessions-tool.ts:19-33`   | `ListSessionsParams`（`query`/`scope: hub\|cwd`，冻结 schema）                                                       |
| `src/tools/list-sessions-tool.ts:36-50`   | `formatXsSessionRows` 行渲染（ref/name/cwd/kind/receive/busy/lastActive）                                            |
| `src/tools/list-sessions-tool.ts:52-78`   | `createListSessionsTool`：execute 调 `sender.list`，`details` 携带 `XsListOutcome`                                   |
| `src/fabric/xs/sender.ts:110-136`         | 工具返回值形状 `XsSendOutcome`（status/effect/reason/code/to/wakeDowngraded/candidates/truncated/woke）              |
| `src/fabric/xs/sender.ts:145-157`         | `XS_MAIN_TOOL_NAMES` + `detectXsToolCollisions`（session_start 同名工具冲突检测）                                    |

## 2. 发送端 sender.ts（origin 守卫 / XsPort / 结果结算）

| 坐标                              | 作用                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/fabric/xs/sender.ts:39-52`   | `XsOriginSnapshot{sessionId,epoch}` + `XsSenderOriginPort`（每次守卫点新鲜读取）                                                                                                            |
| `src/fabric/xs/sender.ts:69-85`   | `XsPortReply`（res/deadline/link_lost/off）与 `XsHubPort`（list/resolve/send，无重试路径）                                                                                                  |
| `src/fabric/xs/sender.ts:159-166` | `xsTargetFormallyRejected`——保留地址形（root/system/main/r_/@/wf_）本地拒绝                                                                                                                 |
| `src/fabric/xs/sender.ts:170-199` | `truncate`（75/25 头尾截断，发送方拥有截断）与 `sendFrameBytesOk`（16KiB 最坏形状预检）                                                                                                     |
| `src/fabric/xs/sender.ts:201-240` | `PROVABLE_NONE_CODES`/`statusForCode`——hub 错误码 → effect none/unknown 映射                                                                                                                |
| `src/fabric/xs/sender.ts:273-284` | `createXsSender` + `guardOk`（signal∧同 session∧同 epoch 的唯一守卫布尔）                                                                                                                   |
| `src/fabric/xs/sender.ts:306-380` | `message()` 主体：resolve 往返（316）→ 守卫失败=none（318-322）→ 本地预检（wake 可用性/level/截断/字节）→ 恰好一次 send（367）→ r3 M2 发送后守卫（374-380：no-verdict ⇒ unknown 永不 none） |
| `src/fabric/xs/sender.ts:382-424` | 效果结算：`ok` ⇒ effect/wakeDowngraded/woke 推导；`!ok` ⇒ provably-none 集合判 none，否则 unknown                                                                                           |

## 3. 帧协议（protocol/xs.ts + decode）

| 坐标                                         | 作用                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/protocol/xs.ts:25-29`           | caps 常量：hub `xs.v1`（仅当 HubConfig.crossSession 存在）、agent caps、`XS_SLOT_KIND="xs"`                                                                     |
| `src/web-hub/protocol/xs.ts:35-55`           | 常量：`XS_EXPIRES_MS=5s`、`XS_HUB_DELIVER_MS=5s`、`XS_REQ_DEADLINE_MS`（list/resolve/info 3s、send 8s）、`XS_MAX_FRAME_BYTES=16*1024`（:48）、list/resolve 上限 |
| `src/web-hub/protocol/xs.ts:66-70`           | `xsFrameBytesOk`——每帧序列化 ≤16KiB 硬检查                                                                                                                      |
| `src/web-hub/protocol/xs.ts:77-86`           | `XsErrorCode`（`E_XS_BAD_FRAME` 注释明确「incl. from.run — phase-3 field」）                                                                                    |
| `src/web-hub/protocol/xs.ts:89-151`          | effect/none/unknown/wakeDowngraded 枚举 + `XsReceiveWire="off"\|"deliver"\|"wake"`（:150）                                                                      |
| `src/web-hub/protocol/xs.ts:188-238`         | `XsMemberSchema`（slot 帧）与 `XsReqSchema`/`XsReqFrame`（op、origin、to/text/wake/level）                                                                      |
| `src/web-hub/protocol/xs.ts:264-298`         | `XsResSchema`/`XsResFrame`（rid 关联、effect/reason/rows/candidates/target/hubLimits）                                                                          |
| `src/web-hub/protocol/xs.ts:301-335`         | `XsDeliverSchema`——`from` 由 hub 盖章、`additionalProperties:false` ⇒ **`from.run` 在此被严格 schema 拒收**（静默忽略，绝不路由）                               |
| `src/web-hub/protocol/xs.ts:338-358`         | `XsAckSchema`（每 deliver 恰好一个 ack，effect/reason/wakeDowngraded/woke）                                                                                     |
| `src/web-hub/protocol/xs.ts:362-369`         | `XS_AGENT_FRAME_SCHEMAS`/`XS_HUB_FRAME_SCHEMAS`——折入 messages.ts 解码表                                                                                        |
| `src/web-hub/protocol/xs.ts:376-388`         | `XsStatusSchema`（StatusInfo.xs 展示投影）                                                                                                                      |
| `src/web-hub/protocol/messages.ts:2243-2257` | `decodeWith`：所有 `xs_*` 帧额外过 16KiB 严格上限（:2249），不合格=未知帧静默忽略                                                                               |
| `src/web-hub/protocol/messages.ts:610-611`   | `StatusInfo.xs?: XsStatusWire` 可选展示槽                                                                                                                       |

## 4. hub 侧（router / 限额 / 盖章 / registry 结算）

| 坐标                                                | 作用                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/hub/xs/router.ts:118-160`              | `resolveTarget`——exact→prefix(≥8)→name→name-ci 四层，歧义/双持有判定                                                                           |
| `src/web-hub/hub/xs/router.ts:186-197`              | ① origin 三重绑定（socket 有效成员∧joined∧sessionId/epoch 相等）否则 `E_XS_STALE_ORIGIN`                                                       |
| `src/web-hub/hub/xs/router.ts:271-292`              | ② 目标唯一有效 joined 成员；③ `receive:"off"` 早拒（`none{rejected}`）                                                                         |
| `src/web-hub/hub/xs/router.ts:294-318`              | 盖章帧构造：`xid` 生成（:296）、`from`（ref/name/cwdLabel/agentId，hub 记录唯一来源）、`expiresAt=now+5s`、`to.epoch`，并预检盖章帧自身 ≤16KiB |
| `src/web-hub/hub/xs/router.ts:319-337`              | ④ `limits.admitSend` 限额预占（含 wake 双窗预占/降级）                                                                                         |
| `src/web-hub/hub/xs/router.ts:339-405`              | ⑤⑥ `registry.request(xs_deliver, 5s)` + xs_ack/截止结算——此后只有接收方 ack 才能证明 none，否则 unknown                                        |
| `src/web-hub/hub/xs/router.ts:424-436`              | `rejectTooLarge`——超 16KiB 的 xs_req 显式答 `E_XS_TOO_LARGE`（rid 合法时）                                                                     |
| `src/web-hub/hub/xs/router.ts:460-494`              | `createXsRelay` 装配（members+limits+router+observer），仅 `config.crossSession` 存在时由 hub.ts 调                                            |
| `src/web-hub/hub/xs/limits.ts:100-165`              | `admitSend` 预占→原子提交（min/hour/inFlight/pair interval/hub 窗 + wake 双窗）与 `settle` 释放规则（woke:false 才退 wake 预占）               |
| `src/web-hub/hub/xs/limits.ts:205-221`              | `normalizeHubCrossSessionConfig`——main.ts 复验，非法 ⇒ 整键丢弃 ⇒ xs off                                                                       |
| `src/web-hub/hub/xs/members.ts:100-189`             | 成员表：`clampMemberLimits`（:100）+ `createXsMembers`（observer 各事件 + `effective()` 读时有效性连接）                                       |
| `src/web-hub/hub/registry.ts:655-669`               | `case "xs_member"` 转发 observer；`case "xs_ack"` 按 rid+xid+目标 agent 三重匹配结算 pending，无 pending ⇒ 只计 `onLateAck`                    |
| `src/web-hub/hub/registry.ts:91-96,180-188,302-306` | `setXsObserver`/`xsView`/`xsNotify`——registry 仅转发，判定全在 members.ts                                                                      |
| `src/web-hub/hub/agent-server.ts:212-219,247-250`   | xs_req 在 registry 之前分发给 router（不进 bus/日志）；解码失败的 oversize xs_req 转 `rejectTooLarge`                                          |
| `src/web-hub/hub/hub.ts:490-492,780-785`            | hub 两面 caps 追加 `xs.v1` 与 relay 构建，均 iff `config.crossSession`                                                                         |
| `src/web-hub/hub/main.ts:193-206`                   | hub 启动复验 crossSession 配置（键缺失即关）                                                                                                   |

## 5. agent 侧桥接（xs.ts + connection.ts）

| 坐标                                                       | 作用                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/agent/xs.ts:53-107`                           | `XsStackPort`（sessionId/member/deliver/status，每次调用新鲜读）与 `XsAgentPort`/`XsAgentBridge` 接口         |
| `src/web-hub/agent/xs.ts:146-162`                          | `refMap`——从 `xs_deliver.from` 学习 ref→完整 sessionId（FIFO cap 64，resolveBlock 用）                        |
| `src/web-hub/agent/xs.ts:164-190`                          | `roundTrip`：`connection.request(frame,"xs.v1")` 归一化为 `XsPortReply`（E_NO_CAP/E_TIMEOUT 分类）            |
| `src/web-hub/agent/xs.ts:220-246`                          | `onDeliver`：learnRef → `stack.deliver`（栈没了=none{session_changed}）→ **恰好一个 xs_ack**，异常也兜底      |
| `src/web-hub/agent/xs.ts:248-261`                          | `publishMember`：`conn.setSlot("xs", xs_member帧)`（slot 机制在 hello_ack 重放，成员只能由新 xs_member 复活） |
| `src/web-hub/agent/xs.ts:274-278`                          | `hubPort()`——X3 的 `XsHubPort` 适配器（list/resolve/send 各一个 xs_req）                                      |
| `src/web-hub/agent/xs.ts:286-345`                          | `resolveBlock`（三级完整 id 推导）与 `hubInfo`（op:info）                                                     |
| `src/web-hub/agent/connection.ts:115-118`                  | `BindingPort.onXsDeliver?` 契约（必须同步答一个 ack）                                                         |
| `src/web-hub/agent/connection.ts:160-167,447-477`          | `request()` 的 xs_req 重载声明与实现：cap 预检（:453 `E_NO_CAP`）、按 op 截止表（:458）、拆链全拒             |
| `src/web-hub/agent/connection.ts:663-672`                  | `case "xs_res"`——按 rid 结算 pending request                                                                  |
| `src/web-hub/agent/connection.ts:711-715`                  | `case "xs_deliver"`——仅 live 链路转 `onXsDeliver`                                                             |
| `src/web-hub/agent/connection.ts:179-181`                  | `SlotKind` 含 `"xs"`，slot 重放顺序 session→xs（epoch 一致性依赖）                                            |
| `src/web-hub/agent/index.ts:330-335,428-434`               | `deps.xs`（存在即 xsOn；未设=字节级无 xs 面）与返回的 xs 表面                                                 |
| `src/web-hub/agent/index.ts:862-867`                       | `StatusInfo.xs` 填充（无栈则字段缺省）                                                                        |
| `src/web-hub/agent/index.ts:1162-1167,1259-1266,1472-1474` | xsBridge 创建+onXsDeliver 绑定；`onHubCaps` 重发布 xs_member；attach 时 publishMember                         |
| `src/web-hub/agent/index.ts:1394-1395,1440-1443`           | `HubConfig.crossSession` 写入与 agent hello caps 追加 `xs.v1`                                                 |

## 6. 接收端 receiver.ts 管道 + format.ts

| 坐标                                | 作用                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/fabric/xs/receiver.ts:24`      | `XS_RECEIVE_CUSTOM_TYPE = "subagent:xs"`（deliver-only 写入会话树的 customType）                                                                                                                 |
| `src/fabric/xs/receiver.ts:44-71`   | `XsDeliverHost`（isIdle/hasPendingMessages/sendMessage/getLeafEntry）与 `XsDeliverInput`                                                                                                         |
| `src/fabric/xs/receiver.ts:214-229` | `deliver()` 入口——单同步块、`dispatched` 边界旗标、异常按 M2 分 none/unknown                                                                                                                     |
| `src/fabric/xs/receiver.ts:237-242` | 阶段1 过期检查（`none{expired}`）                                                                                                                                                                |
| `src/fabric/xs/receiver.ts:244-253` | 阶段2 dedup（重放首 ack 原样回放；满 ⇒ `none{dedup_full}` 不驱逐）                                                                                                                               |
| `src/fabric/xs/receiver.ts:255-263` | 阶段3 membership（joined∧receive≠off∧`senderAllowed`：blocklist→allowFromDenyAll→allowFrom），统一 `none{rejected}`                                                                              |
| `src/fabric/xs/receiver.ts:265-269` | 阶段4 目标身份（to.sessionId/epoch 与当前栈比对，`none{session_changed}`）                                                                                                                       |
| `src/fabric/xs/receiver.ts:271-278` | 阶段5 fence（拒绝窗 `none{fenced:<name>}`；goal 仅 wakeOnly 降级）                                                                                                                               |
| `src/fabric/xs/receiver.ts:280-289` | 阶段6 入站限额+inbox（`none{inbound_rate}`/`none{inbox_full}`）                                                                                                                                  |
| `src/fabric/xs/receiver.ts:291-341` | 阶段7/8 wake 路径：`controller.dispatch`、level 判定、`beginDispatch/verifyDispatch`、applied/start_deferred 证据                                                                                |
| `src/fabric/xs/receiver.ts:343-398` | deliver-only 路径：`sendMessage({triggerTurn:false})`、叶子证据（applied）、流式 `unknown{queued}`、wakeDowngraded 附带                                                                          |
| `src/fabric/xs/format.ts:31-45`     | `formatXsMessage`——不可信头（`[fabric xs from=… wake=…]` + nonce 围栏 + `<<<fab-` 中和），**回复约定就写在这里**（「回复请用 message_session 指向 header 的 from.ref」），details 永不进 content |
| `src/fabric/xs/dedup.ts:33-102`     | `XsDedup`（admit/settle，容量 256 满即拒）                                                                                                                                                       |
| `src/fabric/xs/inbox.ts:40-136`     | `XsInbox`（accept/onRunStart/onRunSettled/releaseTrigger/clear，与树内 rootInbox 完全独立）                                                                                                      |

## 7. membership.ts + /fabric 命令 + 持久化 + slot

| 坐标                                  | 作用                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/fabric/xs/membership.ts:27`      | `XS_MEMBERSHIP_CUSTOM_TYPE = "subagent:xs-membership"`（持久化 entry 类型）                                            |
| `src/fabric/xs/membership.ts:57-66`   | `XsEpochCounter`——进程级单调 epoch（attach/join/leave 跳变，**receive 变更不跳**）                                     |
| `src/fabric/xs/membership.ts:69-117`  | `readXsMembershipEntry`——getBranch 读回（fork 不复活兄弟的 join，P10）                                                 |
| `src/fabric/xs/membership.ts:161-231` | `XsMembership`：attach/restore（异 sessionId 忽略）/join/leave/`setReceive`（:217，不跳 epoch）/block/unblock          |
| `src/fabric/xs/membership.ts:268-276` | `senderAllowed`——阶段3 发送方闸（blocklist→denyAll→allowFrom 空=任意 joined）                                          |
| `src/fabric/xs/membership.ts:290-300` | `toEntryData`/`flush`——appendEntry 持久化 `{v:1,sessionId,joined,receive,blocked,joinedAt}`                            |
| `src/commands/fabric-xs.ts:31-40,124` | 飞书入口硬拒绝（唯一剩余硬闸；web 已由 webCommandPolicy.fabric 管控）                                                  |
| `src/commands/fabric-xs.ts:148-206`   | 子命令分发：status（:149）、join/leave、**receive off\|deliver\|wake 校验（:181）**、block/blocks/unblock、fence reset |
| `src/commands/fabric-xs.ts:208-237`   | `runBlock`——hub resolve→离线完整 id 规则                                                                               |
| xs_member slot 发布                   | 见 §5：`agent/xs.ts:248-261`（构造+setSlot）+ `connection.ts:179-181`（slot 顺序/重放）                                |

## 8. 设置解析（src/config/settings.ts）

| 坐标                                    | 作用                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/settings.ts:984-985`        | `FabricXsReceiveMode = "off"\|"deliver"\|"wake"` 类型定义                                                                              |
| `src/config/settings.ts:987-1013`       | `FabricCrossSessionLimitsSettings`（12 个限额叶子）                                                                                    |
| `src/config/settings.ts:1015-1032`      | `FabricCrossSessionSettings`（enabled/autoJoin/receive/allowFrom/allowFromDenyAll/limits）                                             |
| `src/config/settings.ts:1034-1042`      | `FABRIC_XS_SESSION_ID_RE` + `isValidXsSessionId`（allowFrom 校验用）                                                                   |
| `src/config/settings.ts:1185,1207-1235` | `DEFAULT_SETTINGS.fabric`（crossSession 默认 off、autoJoin false、**receive 默认 "wake"**）                                            |
| `src/config/settings.ts:1778-1839`      | `parseFabricCrossSessionSettings`：receive 合法值校验（:1804-1807，非法回落默认）、limits 逐叶 clamp、allowFrom 无效项告警丢弃+denyAll |
| `src/config/settings.ts:949-982`        | `fabric.wake.*`（rootRunMaxS 60..3600、0=Controller off）                                                                              |
| `src/fabric/xs/switch.ts:44-47`         | `xsOn()`——fabric.enabled∧crossSession.enabled∧webHub.enabled∧control 四开关真值表                                                      |

## 9. RootWakeController + wake-ledger

| 坐标                                       | 作用                                                                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/fabric/root-wake.ts:8-12`             | 常量：idle 轮询 2s、慢启动告警 10s、abort 宽限 10s                                                                                                                                                                                       |
| `src/fabric/root-wake.ts:55-118`           | `observeRootWakeTrigger`——进程级 B1 钩（孤儿/跨会话 token 见即同步 abort）                                                                                                                                                               |
| `src/fabric/root-wake.ts:131-151`          | `RootWakeMessage.details` 形状（xsWake/xid/from/**wakeToken**/level——token 永不进 content）                                                                                                                                              |
| `src/fabric/root-wake.ts:229-312`          | `dispatch()` 唤醒前置条件链：guard/receive off/wakeEnabled/budget/capability/receiver_policy/busy/goal/level_limit/inbound_wake_rate/ledger_full，ledger put+claim 先占坑再 `sendMessage({triggerTurn:true})`，applied vs start_deferred |
| `src/fabric/root-wake.ts:203-228,314-383`  | `recover()`（reload 后认领）与 beforeAgentStart/input/settled/dispose 生命周期                                                                                                                                                           |
| `src/fabric/root-wake.ts:385-499`          | 计时器：绝对 deadline 不顺延、aborting 宽限、stuck 只告警、idle 观察释放                                                                                                                                                                 |
| `src/fabric/xs/wake-ledger.ts:14-16,18-36` | cap 8 与 `XsWakeRecord`（token/sessionId/xid/deadline/started/handed/level…）                                                                                                                                                            |
| `src/fabric/xs/wake-ledger.ts:39-125`      | `XsWakeLedger`：无定时器无驱逐、`release` 需终态证据、`tombstone` 不释放容量、claim 会话级排他                                                                                                                                           |
| `src/fabric/wake-level.ts:37-46`           | `CausalLevel.raise/hopAllowed`（root 因果级）                                                                                                                                                                                            |
| `src/fabric/xs/host-cap.ts:6-10,44-49`     | `XsHostCapabilityState`（unknown→observed→verified/absent，进程粘滞）+ Symbol.for 全局                                                                                                                                                   |

## 10. 装配点（src/stack.ts / src/index.ts）

| 坐标                                   | 作用                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts:266-284`                 | activate 时冻结 `xsEnabled=xsOn(...)`、fencePorts/ledger/capability 持有者                                                                                                    |
| `src/index.ts:285-317`                 | `before_agent_start` B1 钩（有 controller 走 controller，否则回退 `observeRootWakeTrigger`；xs-off reload 仍监管旧 token）                                                    |
| `src/index.ts:319-360`                 | fence pi 事件转发（before_compact/tree/switch/fork、settled、shutdown teardown+ledger.teardown）                                                                              |
| `src/index.ts:564-617`                 | 工具注册（list_sessions/message_session）+ `/fabric` 命令注册 + statusView（hub limits/配额/审计行）                                                                          |
| `src/stack.ts:1609-1625`               | `StackXsInput`/`StackXs` 接口（含 controller/audit/beforeAgentStart/settled/dispose）                                                                                         |
| `src/stack.ts:1627-1775`               | `buildStackXs`：membership 持久化（1638-1657）、restore+autoJoin（1658-1662）、fence/inbox（1663-1666）、receiver（1686）、controller（1697-1722）、StackXs 返回（1729-1775） |
| `src/stack.ts:3199-3235`               | 栈构建处 xsOn 判定 + xs-off reload 的 `rootWakeRecovery`（未执行 token 撤销、已执行保留监管）                                                                                 |
| `src/commands/status.ts:649-667`       | `/agent status` 的 xs 行（joined/recv/cap/in/out/wakes/fenced/stuck/unbound/lateAbort）                                                                                       |
| `src/web-hub/agent/index.ts:1162-1167` | wireWebHub 内 xsBridge 装配（deps.xs 存在才建）                                                                                                                               |

## 11. 进程级 `Symbol.for` 存储先例（「pending 回复凭证账本」可照抄）

| 坐标                                   | 作用                                                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/fabric/xs/wake-ledger.ts:123-129` | `Symbol.for("pi-subagent:xs-wake-ledger")`——**最贴近的先例**：有界、无定时器、release 需证据、tombstone 不释放、跨 /reload 保留、claim 排他                                                                                                         |
| `src/fabric/xs/dedup.ts:104-111`       | `Symbol.for("pi-subagent:xs-dedup")`——xid→verdict 表（一次性凭证语义可参考：admit/settle 各一次）                                                                                                                                                   |
| `src/fabric/xs/membership.ts:60-64`    | `Symbol.for("pi-subagent:xs-epoch")`——进程级单调计数器先例                                                                                                                                                                                          |
| `src/fabric/xs/host-cap.ts:44-49`      | `Symbol.for("pi-subagent:xs-host-cap")`——进程粘滞状态先例                                                                                                                                                                                           |
| 非 xs 先例                             | `src/runtime/io… sysload` 的 `Symbol.for("pi-subagent:sysload-io")`（io-ledger.ts）、topic-switch 的 transfer map（`src/topic-switch/`，cap 4/TTL 10min/FIFO）、`src/child/activation-signal.ts` 计数器——均为「跨 /reload、有界、闭包无模块态」范式 |

## 12. 测试锚点

| 坐标                                                                                                                                                       | 作用                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/fabric-xs-off-golden.json`                                                                                                                 | xs-off agent 形状 golden（**永不再生**）                                                                                                                                                                                                  |
| `tests/fixtures/fabric-wake-off-golden.json`                                                                                                               | 一期 wake-off schema golden（**永不再生**）                                                                                                                                                                                               |
| `tests/integration/fabric-xs-off-golden.test.ts`                                                                                                           | 钉死 xs 关闭时 agent 字节级不变                                                                                                                                                                                                           |
| `tests/conformance/fabric-xs.test.ts:274-684`                                                                                                              | C-X1/X1b（token 形状、同步 !isIdle、abort）、C-X2（栅栏）、C-X3（quiet 不打断 ask_user）、C-X4（membership 无盘持久化/fork 不继承）、**C-X5（details/token/xid/source 不进 provider payload）**、C-X6（一期不回归）、C-X7（同名工具仲裁） |
| `tests/integration/fabric-xs{,-activation,-child-scope,-level-mixed,-lifecycle,-topic-fence}.test.ts`                                                      | 端到端：激活/子会话隔离/level 混合/生命周期/主题栅栏                                                                                                                                                                                      |
| `tests/integration/helpers/fabric-xs-harness.ts` / `fabric-xs-process.ts`                                                                                  | 双进程/多会话测试脚手架                                                                                                                                                                                                                   |
| `tests/fabric/xs-{sender,receiver,dedup,fence,host-cap,inbox,level,switch,truth-table,wake-ledger}.test.ts`                                                | 各纯模块单测（sender 的效果映射 seam 在 xs-sender）                                                                                                                                                                                       |
| `tests/web-hub/protocol/xs-frames.test.ts:131,163,180`                                                                                                     | **from.run 拒收**（:131）、16KiB 上限（:163）、常量冻结（:180）                                                                                                                                                                           |
| `tests/web-hub/hub/xs-{router,members,limits,socket}.test.ts` + `xs-fixtures.ts`                                                                           | hub 侧路由/成员/限额/真实 socket                                                                                                                                                                                                          |
| `tests/web-hub/agent/xs-{client,member-slot}.test.ts`                                                                                                      | agent 桥接与 xs_member slot 重放                                                                                                                                                                                                          |
| `tests/web-hub/ui/agent-card-xs.test.ts` + `src/web-hub/ui/src/components/agents/agentCardModel.ts:135-140`、`AgentCard.vue:26,111`                        | AgentCard `xs wake/deliver` 徽标（cap 门控、display-only、永不作授权）                                                                                                                                                                    |
| `tests/commands/fabric-xs.test.ts` / `tests/commands/status-xs.test.ts` / `tests/config/settings-fabric-xs.test.ts` / `tests/tools/xs-tool-cancel.test.ts` | 命令、状态行、设置解析、取消语义                                                                                                                                                                                                          |

## 13. 文档中回复/三期扩展点原话摘要

- `docs/dev/fabric-cross-session/phase2-plan.md:124`（§2.4 D1）：「发送端 pending 授权持久化——**本期不需要（回复 = 对消息头 `from.ref` 普通发送）；第三期**」——即：当前回复就是普通 send，无凭证、无关联、无 TTL；做「回复期待/一次性凭证」正是补这张表留下的口子。
- `docs/dev/fabric-cross-session/phase2-plan.md:749-757`（§12.3 三期扩展点）：
  - 「子 run 发往别的会话（`from.run`）——帧预留 `run` 字段（**本期拒绝**）；`sender.ts` 的 `SendOrigin` 判别联合（本期只有 `{kind:"root"}`）」；
  - 「**回复给子 run 与回复授权**——`agentId` 已盖章、进审计；`epoch` 已提供会话代际」；
  - 「别的会话投给某个子 run 的 `toRun` 授权——**receiver 是有序阶段数组，`toRun` 作为新阶段插在栅栏与 level 之间**；地址联合 `XsAddress` 本期只有 `{kind:"session"}`」。
- `docs/dev/fabric-cross-session/phase2-plan.md:742`（§12.2 明确不做）：「跨会话 revive / park；自动重试；**结果回传**；跨会话 `wake_result`」——注意 §6.4（:642）与 XR3（:728）的 Q10 裁定「跨会话不回传结果」：请求-回复功能若构成「结果回传」，需显式推翻/修订该拍板项。

---

## 方案需注意的约束（10 条）

1. **两个 off golden 永不再生**（`fabric-xs-off-golden.json`、`fabric-wake-off-golden.json`）：新字段必须可选、关闭时整段缺省，改完必跑 `tests/integration/fabric-xs-off-golden.test.ts`。
2. **工具 schema 是冻结模块常量**（provider 缓存前缀）：给 `message_session` 加 `replyTo/expectReply` 是前缀级变更，形状不得随设置浮动；降级语义放 runtime 字段（如 `wakeDowngraded` 先例）。
3. **帧 schema 全部 `additionalProperties:false`**：向 `xs_req`/`xs_deliver` 加字段会让旧 peer 直接拒帧（静默忽略）；新增 wire 字段需按 `resume.v1`/`cmd.args.v1` 先例走 cap 门控或独立可选帧，且 `protocol/xs.ts` 注释里 `from.run` 已被点名为「phase-3 field」。
4. **16KiB `XS_MAX_FRAME_BYTES` 管所有 xs 帧**：新字段吃掉 text 预算，需同步改 sender 的 `sendFrameBytesOk` 最坏形状预检（sender.ts:177）与 hub 盖章帧预检（router.ts:294）。
5. **C-X5/XI10**：凭证/token/xid/source 永不进 provider payload——回复凭证只能放 `details`，且 format.ts 的 content 头要继续做不可信围栏。
6. **接收管道是严格有序阶段 + 单同步块（XI8）**：新「回复凭证校验」阶段有预留插入位（§12.3：栅栏与 level 之间）；dedup 表满即拒不驱逐（S2），凭证账本应沿用同语义。
7. **receive 词表 `off|deliver|wake` 贯穿 8 处**（protocol/xs.ts:150、membership、/fabric receive、settings 解析、hub list 投影、StatusInfo.xs、AgentCard 徽标、`/agent status`）：新增 `replies` 值需全链一致，且旧 UI 对未知值显示空而非报错。
8. **epoch 不因 receive 变更跳变**（membership.ts:217）：挂到 epoch 的 pending 回复凭证要决定 receive 模式切换是否使其失效；一次性消费语义可照抄 dedup 的 admit/settle 与 wake-ledger 的证据制 release（永不按时间过期放行）。
9. **无重发路径（NQ3）+ r3 M2 边界**：发送侧任何时刻只能恰好一次 send；pre-send 失败才可 none，post-send 无裁决必须 unknown——回复等待/超时同样不得引入自动重试。
10. **人控边界与审计**：membership/receive 变更仍只能人控（`/fabric`，飞书硬拒、web 走 `webCommandPolicy.fabric`），agent 不可自改接收模式；hub 日志只带 `{code, op, textLen}`，回显 reason/wakeDowngraded 过 `TOKEN_RE` token 形状过滤（XI6）。
