# fabric 二期 XS0（契约）实施报告

- 基线：`dev` @ `dd8f181f`（隔离 worktree `r_JJYGMC8K`），方案 `phase2-plan.md` r2 + §13/§14 拍板 + r3 主会话裁定（B1/M1/M2/S1–S3）。
- 包定义：§11.1 XS0 行 / §11.2 XS0 行。范围：**先采集 off golden → 设置解析 → 帧与 reply 关联契约 → `StatusInfo.xs` → `xsOn` → format-fence 纯搬移**。不碰 `src/stack.ts` / `src/index.ts`（XW）、不碰 `agent/connection.ts`（X2）、不碰 hub 侧路由（X1）。
- 自验：`npx vitest run`（XS0 锚点 + `tests/config` 全目录 + `tests/web-hub/protocol` 全目录 + `tests/web-hub/boundary.test.ts` + `tests/fabric` 全目录 + `tests/integration/fabric-wake*` + `tests/commands`）+ `npx tsc --noEmit` + prettier。**未跑全量 npm test（按包规约）**；全量留 XW/X5 终局闸门。

## 改动文件

| 文件                                             | 类型               | 内容                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/fixtures/fabric-xs-off-golden.json`       | 新增（**先采集**） | xs 关闭状态的逐字节 golden（见下）                                                                                                                                                                                                                     |
| `tests/integration/fabric-xs-off-golden.test.ts` | 新增               | 采集/比对 harness（`FABRIC_XS_GOLDEN_UPDATE=1` 且文件缺失才写盘，与第一期 wake golden 同模式）                                                                                                                                                         |
| `src/config/settings.ts`                         | 修改               | `FabricCrossSessionSettings`（含 `limits` 11 键、`allowFromDenyAll`）、`parseFabricCrossSessionSettings`、`FabricWakeSettings.rootRunMaxS` + 解析 + 注释修正、`DEFAULT_SETTINGS.fabric.crossSession`、`FABRIC_XS_SESSION_ID_RE`/`isValidXsSessionId`   |
| `src/fabric/xs/switch.ts`                        | 新增               | `xsOn` 纯函数（§4.1：fabric ∧ crossSession ∧ webHub ∧ control）                                                                                                                                                                                        |
| `src/web-hub/protocol/xs.ts`                     | 新增               | 帧契约全集：5 帧 schema、cap 常量、截止常量、16 KiB 字节上限、错误码、effect/reason/wakeDowngraded 枚举、`StatusInfo.xs` schema                                                                                                                        |
| `src/web-hub/protocol/messages.ts`               | 修改               | 帧联合加 `XsMemberFrame\|XsReqFrame\|XsAckFrame`（agent→hub）与 `XsResFrame\|XsDeliverFrame`（hub→agent）；decode 表折叠 `XS_AGENT_FRAME_SCHEMAS`/`XS_HUB_FRAME_SCHEMAS`；`decodeWith` 对 `xs_*` 帧追加 16 KiB 字节上限检查；`StatusInfo.xs?` + schema |
| `src/fabric/format-fence.ts`                     | 新增               | `fenceNonce`/`fenceMeta`/`formatWakeResult`/`formatInbox`（自 `wake.ts` **逐字搬移**）                                                                                                                                                                 |
| `src/fabric/wake.ts`                             | 修改               | 删除原格式化函数体，`export { formatInbox, formatWakeResult } from "./format-fence.js"`（re-export 保持一切既有导入路径与输出不变）                                                                                                                    |
| `tests/config/settings-fabric-xs.test.ts`        | 新增               | §11.2 锚点：容错、上下界夹紧、`allowFrom` 完整 id 校验、全非法 ⇒ deny-all、未知键、`discoverScope` 不再解析                                                                                                                                            |
| `tests/config/fabric-wake-settings.test.ts`      | 修改               | 第一期断言更新：`rootRunMaxS` 加入 wake 块（8 叶）；`crossSession` 仍是 fabric 级叶子；新增 rootRunMaxS 0/夹紧/回退测试                                                                                                                                |
| `tests/web-hub/protocol/xs-frames.test.ts`       | 新增               | §11.2 锚点：每帧 decode/reject、方向纪律、16 KiB、`from.run` 拒绝、r3 M2/B1 枚举载面、常量冻结                                                                                                                                                         |
| `tests/fabric/format-fence.test.ts`              | 新增               | §11.2 锚点：模板逐字节钉死（nonce 提取法）、`<<<fab-` 中和、64 字符元数据截断、4000 字符正文截断、re-export 同一性                                                                                                                                     |
| `tests/fabric/xs-switch.test.ts`                 | 新增               | `xsOn` 真值表（§4.1，纯 AND）                                                                                                                                                                                                                          |
| `docs/dev/fabric-cross-session/XS0-report.md`    | 新增               | 本报告                                                                                                                                                                                                                                                 |

## 契约要点

### 帧（§8.1/§8.2，XS0 冻结）

- **`xs_member`**（agent→hub，slot，无应答）：`{sessionId, epoch, joined, receive:"off"|"deliver"|"wake", limits{7}}`；limits 只含发送方 7 键（`sendsOutPerMin/Hour`、`wakesOutPerHour`、`pairMinIntervalMs`、`pairWakesPerHour`、`inFlightPerSession`、`listPerMin`），**schema 上下界即 hub 夹紧界**（§4.6）。
- **`xs_req`**（agent→hub）：`{rid, op:"list"|"resolve"|"send"|"info", origin{sessionId,epoch}, query?, scope?, to?, text?, wake?, level?}`，strict（`additionalProperties:false`，嵌套 origin 同样 strict）。
- **`xs_res`**（hub→agent）：`{rid, ok, code?, effect?, reason?, wakeDowngraded?, rows?, candidates?, target?, hubLimits?}` —— 字段集与 §8.2 表完全一致（无 `woke`；`woke` 只在 `xs_ack`）。
- **`xs_deliver`**（hub→agent）：`{rid, xid, to{sessionId,epoch}, from{sessionId, ref, name?, cwdLabel, agentId}, text, wake, level?, expiresAt}`；`from` strict 无 `run` ⇒ 带 `from.run` 的帧 decode 即拒（§4.2 三期字段，测试钉死）。
- **`xs_ack`**（agent→hub）：`{rid, xid, effect, reason?, wakeDowngraded?, woke}`。
- **reply 关联**（注释冻结在 `protocol/xs.ts` 头部，实现归 X1/X2）：`xs_req.rid → xs_res.rid`（agent 侧 pending）；`xs_deliver.rid → xs_ack.rid`（hub 侧 `registry.onFrame` 新 case，迟到 ack 只计数）；`xs_member` 走 slot 重放。
- **decode 即接线、路由仍惰性**：`messages.ts` 的 decode 表已收编 5 帧（合法帧可通过、非法/超限静默丢弃），但 agent-server/connection/registry 均未改动——X1/X2 之前没有任何 xs 帧被路由。

### 常量

- cap：`XS_HUB_CAP="xs.v1"`（hub 两面，仅当 `HubConfig.crossSession` 存在）、`XS_AGENT_CAPS=["xs.v1"]`（agent hello，仅 `xsOn`）、`XS_SLOT_KIND="xs"`。P9：只加 cap，不升 PROTO。
- 截止：`XS_EXPIRES_MS=5_000`（hub 盖章）、`XS_HUB_DELIVER_MS=5_000`（hub 投递）、`XS_REQ_DEADLINE_MS={list/resolve/info:3_000, send:8_000}` + `xsReqDeadlineMs()`。
- 大小/发现：`XS_MAX_FRAME_BYTES=16*1024`（超限帧 decode 拒绝，hub 侧 `E_XS_TOO_LARGE` 不截断）、`XS_LIST_MAX_ROWS=20`、`XS_RESOLVE_PREFIX_MIN=8`、`XS_RESOLVE_MAX_CANDIDATES=5`。
- `text` schema 上限 16 384（宽于 16 KiB 帧上限）：超限发送由**字节上限**拒绝（可区分、可测），而非 schema 静默丢弃。

### 错误码 / effect / reason / wakeDowngraded 枚举（含 r3 裁定）

- 错误码：`E_XS_OFF` / `E_XS_BAD_FRAME` / `E_XS_BAD_TARGET` / `E_XS_NO_TARGET` / `E_XS_AMBIGUOUS` / `E_XS_STALE_ORIGIN` / `E_XS_TOO_LARGE` / `E_XS_INTERNAL`。
- `XsEffect = "applied"|"none"|"unknown"`。
- `XsNoneReason`：`rejected`、`expired`、`dedup_full`、`session_changed`、`fenced:<compaction|tree|switch|web_exec|topic_switch|goal>`、`inbound_rate`、`inbox_full`、`host_rejected`、**`origin_changed`（send 发出之前，M2）**、**`receiver_error`（dispatch 之前，M2）**。
- `XsUnknownReason`：`queued`（N2）、`start_deferred`、`accept_unverified`、**`origin_changed_after_send`（M2）**、**`receiver_error`（dispatch 之后，M2）**、`client_deadline`、`link_lost`——`receiver_error` 同时出现在 none/unknown 两侧，正是 M2 的「send 前后区分」。
- `XsWakeDowngraded`（13 值）：`wake_disabled`、`controller_disabled`、**`host_unverified`（N1）**、`host_unsupported`、`receiver_policy`、**`busy`**、`goal`、`level_limit`、`inbound_wake_rate`、`outbound_wake_rate`、`pair_wake_rate`、`sender_wake_disabled`、**`ledger_full`（B1）**。
- `StatusInfo.xs?: {joined, receive, blocked}`：append-only 纯展示（P3/#4），hub 授权永不读它；关闭 ⇒ 字段不存在。

### 设置（§4.1/§4.6/§5.2/§5.3）

- `fabric.wake.rootRunMaxS`：默认 900，0 = Controller 关（跨会话 wake 降级只投递），正值夹紧 60..3600，非法回退默认；**只约束跨会话 Controller，树内不受影响（P7，注释已修正）**。
- `fabric.crossSession.*`：`enabled`（默认 false）、`autoJoin`（默认 false，P1）、`receive`（默认 `"wake"`，P2）、`allowFrom` + `allowFromDenyAll`（#14：只收完整 sessionId，regex 与 pi `assertValidSessionId` 一致；非法条目丢弃 + 每次解析一条 console.warn；非空全非法 ⇒ `allowFromDenyAll:true` 拒收一切）、`limits` 11 键（P8 默认值，上下界夹紧；`inboxCap` 独立于树内 `rootInboxCap`，#7）。
- `discoverScope`（r1.1 已删键）确认不解析、不物化（测试钉死）；`xsOn = fabric.enabled ∧ crossSession.enabled ∧ webHub.enabled ∧ webHub.control`（`src/fabric/xs/switch.ts` 纯函数，结构化入参，不导入设置模块）。
- 解析容错与第一期同款：非对象回退默认、不别名 `DEFAULT_SETTINGS`、逐字段回退。

## off golden 采集方法（`fabric-xs-off-golden.json`）

在**任何 src 改动之前**采集（先写 harness、跑 `FABRIC_XS_GOLDEN_UPDATE=1` 生成、再动 src；采集后 src 改动落地，golden 测试重跑仍逐字节通过——XS0 对关闭态零行为变化的自证）。四个面：

1. **`mainSessionTools`**：真 `activate()`（fake pi 记录 `registerTool` 名称序列，sandbox HOME，默认设置 = fabric/webHub 全关）→ 20 个工具名按注册顺序。
2. **`reservedToolNames` + `messageAgentSchema`**：直接导入 `RESERVED_TOOL_NAMES`（11 名，无 `list_sessions`/`message_session`，#12）与第一期冻结的 `message_agent` schema JSON。
3. **`wiring`**：真 `wireWebHub` + fake net/socket（webHub 开、其余默认、fake timers + 固定 `now`）：
   - `hello` 帧（caps：P1 + runtx + cmd/dialog/command + upload + hold——**无 `xs.v1`**；`agentId`/`epoch`/tmp 路径/execPath 归一化）；
   - `slotSequence`：hello_ack 后连接写出的帧类型序列 `session,status,fleet,dialogs,ctl,commands,status,ctl`（SLOT_ORDER 实测投影，**无任何 `xs_*` 帧**）；
   - `statusFrame`：`StatusInfo` 全键（**无 `xs` 键**）；
   - `hubConfig`：autoStart 路径经 stubbed `spawnImpl` 捕获的 `PI_WEBHUB_CONFIG`（**无 `crossSession` 键**）。
4. 第二个测试用例做确定性 + 无-xs 痕迹断言（两次采集相等；工具表/保留名/ caps/slot/StatusInfo/HubConfig 全无 xs 痕迹）。

维护规则与第一期相同：**绝不为修 diff 重生成**；X2/XW 的验收就是让这份 golden 保持绿。

## 测试输出（全部通过）

```
npx vitest run \
  tests/integration/fabric-xs-off-golden.test.ts \
  tests/config/settings-fabric-xs.test.ts tests/config/fabric-wake-settings.test.ts \
  tests/web-hub/protocol/xs-frames.test.ts \
  tests/fabric/format-fence.test.ts tests/fabric/xs-switch.test.ts tests/fabric/wake-result.test.ts
→ 7 files, 55 tests passed

npx vitest run tests/config tests/web-hub/protocol tests/web-hub/boundary.test.ts
→ 76 files, 1929 passed | 3 skipped   （协议 import 闭包边界不受影响）

npx vitest run tests/fabric tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-wake.test.ts
→ 16 files, 244 passed                （第一期 wake golden 与格式测试原样通过）

npx vitest run tests/commands
→ 207 passed                          （status-wake 格式消费方不受搬移影响）

npx tsc --noEmit → 0 errors
npx prettier --check src tests docs → All matched files use Prettier code style!
```

## 偏差与说明

1. **`tests/config/fabric-wake-settings.test.ts` 更新**（计划内）：第一期「phase-2 leaves must NOT exist yet」断言被 rootRunMaxS 的落地取代（8 叶 + 0/夹紧/回退新测试）；其余 7 叶默认值与全部既有语义断言原样保留。
2. **`src/config/setting-specs.ts` 未动**（§11.1 未把它划给 XS0）：`fabric.wake.rootRunMaxS` 与 `fabric.crossSession.*` 暂不在 `/agent settings` 编辑器可见、`isKnownSettingKey` 为 false（静默，无告警路径）。建议 XW/X5 把 spec 登记补上。
3. **`xs_res` 不含 `woke`**：严格按 §8.2 冻结字段集（`woke` 只在 `xs_ack`）；发送方工具若需要「对方是否真被唤醒」由 X3 从 `effect`+`wakeDowngraded` 推导或另行提案。
4. **`fenceMeta(undefined)` 会抛**（`JSON.stringify(undefined).slice`）：原第一期实现即如此、纯搬移保持原状（两个 formatter 从不传 undefined；测试注释注明）。
5. golden 生成后做了一次 prettier 规范化（仅空白差异，内容零变化，比对测试复跑通过）。
6. r3 M1（栅栏只因真实完成事件开窗）与 S1（deferred 的 hop+1 提交时机）属 T1/R1 的落实要求，XS0 只在 `XsFenceName` 枚举与注释里预留位，未实现栅栏本体（按拆包归属）。
