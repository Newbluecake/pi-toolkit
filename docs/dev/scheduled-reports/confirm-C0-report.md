# #61 C0 包报告：协议与端口类型

## 改动

- `src/web-hub/protocol/schedule.ts`：追加 `sched.confirm.v1` 常量（CAP/OFFERS_MAX/CLOSED_MAX/TTL/DECIDE_TTL/ACK_WAIT）、`SchedOffer*`/`SchedOffersFrame`/`SchedDecideFrame`/`SchedDecideAckFrame` 类型与严格 schema（`additionalProperties:false`、数组 maxItems）；注册表追加 agent: `sched_offers`、`sched_decide_ack`，hub: `sched_decide`；`ScheduleTaskProjectionWire.offer?` 可选字段。`SchedChangedSchema` 与 `sched.v1` 既有帧未动，无 PROTO bump，`SCHED_*_CAPS` 不变。
- `src/web-hub/protocol/messages.ts`：`AgentFrame`/`HubFrame` 联合与再导出追加（解码表经 `...SCHED_*_FRAME_SCHEMAS` 自动带上）。
- `src/web-hub/hub/feishu/schedule.ts`：只加类型 `FeishuScheduleOfferRow/OfferClosed`、`ScheduleDecideRequest/Result`，`FeishuSchedulePort` 追加可选 `offers?/closedOffers?/decide?`。
- `src/web-hub/agent/command-policy.ts`：`reject` 与 `approve` 同形（`!all ∧ 3 token ∧ 64hex ⇒ allow`）。
- 测试：`tests/web-hub/protocol/schedule.test.ts`（注册表断言更新）、`schedule-policy.test.ts`（+reject）、新 `schedule-confirm.test.ts`（往返/严格拒绝/上限/方向隔离）。

## 域外最小改动（需知悉）

- `src/web-hub/hub/schedule/service.ts` `onAgentFrame`：`SchedAgentFrame` 联合变宽后原 else 分支把一切当 run_ack，typecheck 红；仅加一行 `if (frame.t !== "sched_run_ack") return;`。H2 按方案改为穷尽 switch 时覆盖它。

## 未做（不在 C0 域）

- `ScheduleDelivery.offersChanged?`：该类型在 `hub/schedule/feishu-port.ts`（`Pick<FeishuSchedule,…>`），属 H2，由 H2 追加。

## 自验

- `npm run typecheck`：0 error
- `vitest run tests/web-hub/protocol tests/web-hub/boundary.test.ts tests/schedule tests/web-hub/hub`：通过
- `vitest run tests/integration/{schedule-off,fabric-xs-off,fabric-wake-off}-golden.test.ts`：3 文件 9 测试通过
- prettier --check 通过；`git diff --quiet HEAD -- tests/fixtures/` 干净

## 建议 commit

`feat(web-hub): schedule confirm offer/decide frames and port types (#61 C0)`
