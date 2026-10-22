# RX7 报告 — R4 修订 + 跨会话消息对用户可见（reply-plan §10.2）

## 改动

- `src/fabric/xs/sender.ts`：人发起 @会话 的 ticket `wakeOnReply` 由 `!isHuman` 改为恒 `true`（origin 仍记 `human`，requesterLevel 仍 0）。接收侧语义不动：receiver 已按 A 的有效模式处理（wake/replies ⇒ 走 RootWakeController 的 solicited 回复，returnLevel=0，前置条件/配额/栅栏/goal 全不变；deliver ⇒ `receiver_policy` 降级为只投递）。
- `src/fabric/xs/receiver.ts`：deliver-only 写入 `display:true`（原为仅 human ticket）；晚到回复在 `details` 加 `late:true`（仅展示用）。
- `src/fabric/root-wake.ts`：`RootWakeMessage.display` 字面类型与实际值改 `true`。
- 新 `src/fabric/xs/render.ts`：TUI 渲染器 `renderXsMessage`（customType `subagent:xs`，wake/deliver/reply 共用）。一行头 `xs ← <name|ref> · <cwd> · wake|deliver|reply to q…|late reply to q…` + 去头去围栏的 body；元数据优先取 `details`，缺失则解析 content 头。`src/index.ts` 在既有 `registerMessageRenderer` 探测块内注册。provider 看到的 content / details 不变。
- web：`ui/src/logic/xsMessage.ts`（content 解析）+ `TxCustom.vue` 对 `subagent:xs` 展示 `xs ← <from>` + cwd/kind chip + 纯正文。**确认**：hub 只投影 `details` 的 `{date,kind,at}`，xs 的 details 不到 web，故只能解析 content 头与围栏（退路，已按 format.ts 实际输出做交叉测试）。回复格式头本身不含 cwd，所以 web/TUI 的回复行无 cwd。`display:true` 后 web 不再过滤这些消息。
- 未改：`subagent:xs-reply`（超时/失效通知）——其 content 本就是 `display:true` 的可读中文散文、无围栏，沿用默认渲染。

## 测试

- 更新：`tests/integration/fabric-xs-mention.test.ts`（A 为 wake ⇒ 回复唤醒 A，triggerTurn:true、turns+1、ticket wakeOnReply:true；新增例：A 为 `XW_RECEIVE=deliver` ⇒ display:true 但不唤醒）、`tests/fabric/root-wake.test.ts`（display:true）、`tests/fabric/xs-sender.test.ts`（wakeOnReply:true）。
- 新增：`tests/fabric/xs-render.test.ts`、`tests/web-hub/ui/tx-xs.test.ts`。

## 自验

- vitest（指定集合：tests/fabric、mention、三份 golden、tests/web-hub/ui）：260 files / 5917 tests passed；golden 未动、未重生成。
- 额外跑 `tests/conformance/fabric-xs.test.ts`（含 C-X5 payload 卫生）+ `tests/integration/fabric-xs{,-reply}.test.ts`：35 passed。
- `npm run typecheck` 通过；`build:web` + `check:web` OK；prettier --check 改动文件通过。

## 遗留 / 需关注

- 副作用：`wakeOnReply` 现对 human ticket 也为 true，而 reply-notice.ts（冻结）按 `wakeOnReply` 选“唤醒式”超时通知，故 human 请求的超时通知现可能唤醒 A，而非静默写入。需 RX6/主会话确认是否要求 human 超时通知仍 quiet（若是，需改 reply-notice.ts 的 wakeEligible 条件，我未碰）。
- 冻结文件内（conformance、reply-receiver.property 测试）仍手工构造 `wakeOnReply:false` 的 human ticket，仍通过，只是不再代表真实 sender 行为。
