# #20 包 B — 超时通知 phase 实施报告

> 2026-11-05 · dev · 包 A 基准 47406619 · 严格依据 `plan.md` r3 D5–D6 / §3 包 B。
> **状态：共享 facade 补丁已应用；包 B 指定门禁全部通过，READY for independent verification。** 未执行 npm test；无 git 写操作。
> 2026-11-05 12:18 用户确认 #23 P-B 已提交 b84cdb72，授权本 run 接手 `src/web-hub/agent/index.ts`。
> 本次仅三处最小改动（type import、xs 可选接口、同步 facade 透传），未碰 P-B 的 capsExtra/epoch.up.v1 逻辑。
> 真实 activate 18 tests、typecheck/build、plan 1946 tests、广域 1183 tests、九套件 69 tests、附加 commands 384 tests 全部通过。
> 补丁前的失败日志保留在 §4–§5，仅作历史；最终交付状态以 §6 本次复跑为准。

## 1. 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/reply-notice.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/xs.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/stack.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/activate.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/README.md`
- `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-reply-notice.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/xs-state-bridge.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/conformance/fabric-xs.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-xs-activate-session.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/xs-idle-wake-warning-compat.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/xs-idle-wake-warning/B-report.md`

包 A 已提交的逻辑、message_session schema/描述、全部 tests/fixtures、tests/mention 均未改动。
工作区其它 run 的变更/未跟踪文件不属于本包，未编辑/删除/加入清单。执行期间 HEAD 可由 root/其它包前进。

## 2. 实施与测试映射

- NoticeGate 新增本地 XsNoticePhase 与可选同步 progressOf。flush 仍是无 await 的单一同步块；端口抛错降为 unknown。
  wake/quiet 共用同一 content，invalidation/dropped summary 不动。无 timer、hub 往返、wire/cap/PROTO 改动。
- source bridge 的 progressPhaseOf 仅读内存 mirror.rows(Date.now())。activation off、无 state cap、mirror/current sid 不符、
  缺行、任何非 live observation、duplicate requestId phase 冲突均 unknown；没有 publish/revision 写入。
- stackInput 在 activationOn 晚绑定 bridge 查询；gate 只在 input 提供端口时注入 progressOf。
- D5 三种英文 suffix 与 delivered/started 中文尾句逐字实现，尾句只随对应行出现，delivered 在前。
  无 phase/replied/缺端口/抛错输出保留旧字节；仅字段名，不输出任何内部标识值。
- README 新增指定小节，同时覆盖包 A 的 D1–D4、可见面与残留。

| 验收项                 | 行为断言与证据                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 固定旧文本             | xs-reply-notice 的 PRE20_SINGLE 是测试内固定旧文案，不调用生产 renderer；默认/undefined/replied/端口抛错/缺端口精确相等                                                                                              |
| D5 文案                | queued/delivered/started 单 ticket 精确 suffix + 精确尾句；mixed tickets 按 dueAt 排序，尾句 delivered→started 各一次；不含「尚未开始处理」「没处理」                                                                |
| 同步块                 | progressOf 与 host/controller 写入均必须处于调用 flush 的同步栈标志内，调用顺序 progress→write；wake/quiet content 相同且 owed 清空                                                                                  |
| D6/read-only           | bridge live 四 phase、offline/expired/unavailable、deadline 读时 expired、缺 cap/off、无行、wrong/current switched sid、重复 phase 冲突；projection/revision、publish/send 不变                                      |
| context 超限           | 两个真实 stack + relay/bridge；xid 位于 2001 条 context 的首条，target 和 source 均仍 live delivered；超时为 last seen delivered，不虚构 started                                                                     |
| started 推送丢失       | target 真正 context observer 已记 started，source 丢弃 started xs_state 后仍 live delivered；超时只展示最后观测                                                                                                      |
| stack 正常/off         | expectReply timeoutS=60、idle target、wake:false；正常 delivered，activation off 精确旧文案                                                                                                                          |
| C-X15 wake/quiet       | 真实 pi + AnthropicStub；两张固定 requestId/ref ticket 分别 delivered/started，注入 sid/xid/messageId/activationKey 哨兵；通知及 provider 请求无哨兵；quiet 在后续自然 prompt 回合才验证 provider 可见；两句精确断言 |
| real activate / compat | XsHarness 的真实 activate()：旧目标×新 requester、旧 hub×新 requester 的 expectReply 超时精确旧文本；activation off 旧文本；activation on 应用共享 facade 后精确 delivered 文案，断言保持不变且未 skip               |

stack 的新增 timeout 测试走 receive=deliver quiet 路径：既有 deterministic host 的 sendMessage 会同步调用 BAS，
而真实 pi 延后事件；wake 超时用 C-X15 真 pi 与 notice gate 单测覆盖，不让同步 fake 重入制造双写。
stack source bridge 显式 publishMember 采用既有 attach 路径建立 mirrorSessionId；query 本身不初始化身份。

初次测试修复：C-X15 固定 requestId 必须符合 q+18 hex 的 ledger 校验；fake bridge conn 补既有 setSlot；
source test bridge 显式 attach publishMember。没有为变绿修改生产契约。
初次与调试完整输出保存在 `/tmp/xs20-B-first.log`、`/tmp/xs20-B-debug.log`、`/tmp/xs20-B-phase-debug.log`、
`/tmp/xs20-B-actual-debug.log`、`/tmp/xs20-B-second.log`；debug 日志代码全部移除。

## 3. 共享 facade 补丁（已应用）

**唯一必要的文件域扩展**：WebHubWire 的 xs 是手写 facade，并非 XsAgentBridge。首次交付时因并行 #23 P-B
拥有此文件，root 裁定延期；12:18 用户授权后按上下文应用如下三处最小补丁。
只增加 type import、可选同步接口、同步透传；不动 #23 的 capsExtra、任何 wire/注册或其它逻辑。
真实 activationOn/activationOff timeout 与混合版本全文件已复跑通过，TS2339 已消失。
实际 diff 已核查只有以下三处（`/tmp/xs20-B-resume-applied-patch.diff`）：

```diff
diff --git a/src/web-hub/agent/index.ts b/src/web-hub/agent/index.ts
--- a/src/web-hub/agent/index.ts
+++ b/src/web-hub/agent/index.ts
@@ -93,7 +93,7 @@
   XsAliasCachePort,
 } from "../../fabric/xs/types-alias.js";
 import type { XsHubLimitsWire } from "../protocol/xs.js";
-import type { XsStateFrame } from "../protocol/xs-activation.js";
+import type { XsPhase, XsStateFrame } from "../protocol/xs-activation.js";
 import { createRunTranscripts, type RunTxRunInfo, type RunTranscriptPort } from "./run-transcript.js";
 import { createEventTap } from "./event-tap.js";
 import { formatLanStatusLines, type LanStatusPaths } from "./lan-status.js";
@@ -552,6 +552,8 @@
     /** channel-plan §12 (IBP): the unread count changed ⇒ republish status (IBW calls this). */
     notifyUnreadChanged(): void;
     hubPort(): XsHubPort & XsActivationHubPort;
+    /** #20: synchronous read-only source mirror; absent on older bridge facades. */
+    progressPhaseOf?(sessionId: string, requestId: string): XsPhase | undefined;
     resolveBlock(query: string): Promise<XsBlockResolve>;
     hubInfo(): Promise<XsHubLimitsWire | undefined>;
     /** alias-plan §4/§7 (ALW): AL3's `op:"alias"` bridge and per-activate alias cache for `/fabric alias`. */
@@ -2387,6 +2389,7 @@
             publishMember: () => xsBridge.publishMember(),
             notifyUnreadChanged: () => xsBridge.notifyUnreadChanged(),
             hubPort: () => xsBridge.hubPort(),
+            progressPhaseOf: (sid: string, rid: string) => xsBridge.progressPhaseOf?.(sid, rid),
             resolveBlock: (query: string) => xsBridge.resolveBlock(query),
             hubInfo: () => xsBridge.hubInfo(),
             aliasBridge: () => xsBridge.aliasBridge(),
```

**待补丁后复跑清单已全部执行通过**：真实 activate / compat 全文件、typecheck/build、plan 包 B 完整门禁、
广域（含 mention）与九套件、改动文件 prettier、HEAD fixtures/frozen diff；最终结果见 §6。

## 4. 首次交付（补丁前）自验命令与真实完整输出

所有长命令使用 timeout；`set -o pipefail`、`2>&1 | tee /tmp/...`；没有 tail/head 截断，下面嵌入原 tee 文件完整内容。
测试统计重复覆盖不可累加。广域/plan/九套件按顺序执行，不跑全量 npm test。

### 新增 notice / bridge / stack 定向验证 — PASS

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 60 npx vitest run tests/fabric/xs-reply-notice.test.ts tests/web-hub/agent/xs-state-bridge.test.ts tests/integration/fabric-xs-activate-session.test.ts
```

完整日志：`/tmp/xs20-B-units.log`

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/agent/xs-state-bridge.test.ts (22 tests) 36ms
 ✓ tests/integration/fabric-xs-activate-session.test.ts (13 tests) 98ms
 ✓ tests/fabric/xs-reply-notice.test.ts (24 tests) 20ms

 Test Files  3 passed (3)
      Tests  59 passed (59)
   Start at  11:51:32
   Duration  2.10s (transform 1.32s, setup 138ms, collect 1.97s, tests 154ms, environment 1ms, prepare 159ms)

```

### 用户广域定向门禁 — PASS（76 files / 1183 tests）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 360 npx vitest run tests/fabric tests/conformance/fabric-xs.test.ts tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/governance tests/mention
```

完整日志：`/tmp/xs20-B-broad-gate.log`

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/fabric/root-wake.test.ts (68 tests) 53ms
stderr | tests/fabric/threads-settings.test.ts > fabric.threads settings (P0 §11.1) > P4 §8.2 ③: a window clamp marks windowClamped (the ` · cfg clamped` suffix source)
[pi-subagent] fabric.threads.retainMin 5 → 12 (must be ≥ max(handbackWindowMin, startTimeoutMin)+2)
[pi-subagent] fabric.threads.handbackWindowMin 0 → 1 (below min 1)
[pi-subagent] fabric.threads.startTimeoutMin 40 → 30 (above max 30)
[pi-subagent] fabric.threads.retainMin 15 → 32 (must be ≥ max(handbackWindowMin, startTimeoutMin)+2)

 ✓ tests/fabric/threads-settings.test.ts (48 tests) 121ms
 ✓ tests/fabric/xs-sender.test.ts (67 tests) 34ms
 ✓ tests/fabric/xs-receiver.test.ts (50 tests) 36ms
 ✓ tests/fabric/xs-reply-ledger.test.ts (29 tests) 32ms
stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X2: compaction >30s rejects throughout; cancellation emits compact_failed and opens only that window
[pi-subagent] fabric fence stuck: compaction open 30s — still rejecting cross-session deliveries; /fabric fence reset to clear (local only)

stdout | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X6: phase-1 C-P1–C-P5 remain green
C-X6 delegated real-pi gates:

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/conformance/fabric-wake.test.ts (8 tests) 434ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  11:52:41
   Duration  4.30s (transform 2.22s, setup 68ms, collect 3.52s, tests 434ms, environment 0ms, prepare 54ms)



stdout | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X7: record pi's duplicate-tool arbitration without depending on the winner
C-X7 observed arbitration (record-only): {"visible":["Send a message to another joined main session on this machine's web hub (fabric cross-session; the recipient sees it as untrusted input). Reply to an incoming cross-session message by messaging its from.ref. effect \"applied\" = delivery confirmed; \"none\" = provably NOT delivered (safe to retry later); \"unknown\" = the message may have entered the recipient's queue — it usually becomes visible at the recipient's next turn boundary; do NOT blindly resend."],"executed":[],"toolResults":[{"type":"message","id":"ce822d5d","parentId":"6db0aea3","timestamp":"2026-11-05T03:52:46.401Z","message":{"role":"toolResult","toolCallId":"stub-tool-0-message_session","toolName":"message_session","content":[{"type":"text","text":"{\"status\":\"origin_changed\",\"effect\":\"none\",\"reason\":\"origin_changed\"}"}],"details":{"status":"origin_changed","effect":"none","reason":"origin_changed"},"isError":false,"durationMs":1,"timestamp":1793850766401}}],"errors":[]}

stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X12b: no BAS at all ⇒ first context sight aborts with ZERO provider requests; absent + supervised
[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only

stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X14b: a host that loses the custom shape (no BAS) aborts the marker before the provider; the body is not re-sent as a fallback
[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only

 ✓ tests/conformance/fabric-xs.test.ts (27 tests) 46624ms
   ✓ fabric phase-2 real pi contracts > C-X1b: pre-start compaction >10s remains owned, starts with token and deadline aborts the slow provider 10148ms
   ✓ fabric phase-2 real pi contracts > C-X2: compaction >30s rejects throughout; cancellation emits compact_failed and opens only that window 30100ms
   ✓ fabric phase-2 real pi contracts > C-X6: phase-1 C-P1–C-P5 remain green 4725ms
 ✓ tests/fabric/xs-channel-ch3.test.ts (25 tests) 36ms
stderr | tests/fabric/wake.test.ts > W3 reservation admission / ownership transfer > failed trigger claim restoration quarantines rather than returning a deliverable record
[pi-subagent] fabric inbox reservation_quarantined key=r_SENDER01:r_TARGET01:1:1 run=unknown

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > ② accepted then crash: journal-only (even with acceptance) is never retried
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > terminal attempted without acceptance
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > ⑤ 60s timeout rechecks once; still no terminal even if live => audited consume, no rearm
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > an accepted journal on a live session does NOT cause a 1ms recovery spin
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > a rollback-failed reservation survives reload without the memory-only quarantine flag, then consumes as ambiguous
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

 ✓ tests/fabric/wake.test.ts (40 tests) 43ms
 ✓ tests/fabric/root-wake.property.test.ts (2 tests) 1052ms
   ✓ RootWakeController random event invariants > single owner, occupied states supervised, at-most-once abort, zero abort after handover 650ms
   ✓ wake-unknown-optimistic random event invariants > optimistic first-run: per-token ≤1 abort/audit, dead optimistic tokens never hop, capability monotone 401ms
 ✓ tests/fabric/thread/engine.test.ts (29 tests) 23ms
 ✓ tests/fabric/xs-progress.property.test.ts (13 tests) 2004ms
   ✓ xs progress — merge lattice (property) > random out-of-order / duplicate / late / stale-revision writes never regress a fact 1499ms
   ✓ xs progress — activation claims (property) > claim state machine matches the spec across random ops (idempotent consume, at-most-once) 394ms
 ✓ tests/fabric/xs-reply-notice.test.ts (24 tests) 22ms
 ✓ tests/fabric/revive.test.ts (66 tests) 49ms
 ✓ tests/fabric/xs-truth-table.test.ts (34 tests) 30ms
 ✓ tests/mention/session.test.ts (25 tests) 18ms
 ✓ tests/fabric/successor.test.ts (17 tests) 48ms
 ✓ tests/mention/mention.test.ts (20 tests) 17ms
 ✓ tests/fabric/xs-fence.test.ts (25 tests) 15ms
 ✓ tests/fabric/xs-session-activation.test.ts (15 tests) 24ms
 ✓ tests/fabric/router.test.ts (15 tests) 20ms
 ✓ tests/fabric/mailbox.test.ts (16 tests) 20ms
 ✓ tests/fabric/wake-result.test.ts (18 tests) 34ms
 ✓ tests/fabric/xs-reply-receiver.property.test.ts (2 tests) 224ms
 ✓ tests/integration/fabric-xs-reply-off-golden.test.ts (2 tests) 37ms
 ✓ tests/fabric/xs-reply-ledger.property.test.ts (2 tests) 145ms
 ✓ tests/fabric/xs-human-grant.test.ts (20 tests) 20ms
 ✓ tests/fabric/thread/engine.property.test.ts (2 tests) 352ms
   ✓ ThreadEngine seeded property invariants (§11.1 P1) > dedup · at-most-once auto-return · no auto-return over called steers — random op streams 350ms
 ✓ tests/fabric/xs-sender-channel.test.ts (20 tests) 14ms
 ✓ tests/integration/fabric-xs-off-golden.test.ts (3 tests) 73ms
 ✓ tests/fabric/thread/rebind.test.ts (14 tests) 14ms
 ✓ tests/mention/session-off.test.ts (5 tests) 20ms
 ✓ tests/fabric/xs-sender-human-grant.test.ts (26 tests) 23ms
 ✓ tests/fabric/xs-level.test.ts (12 tests) 14ms
 ✓ tests/fabric/thread/subscriptions.test.ts (9 tests) 10ms
 ✓ tests/mention/autocomplete.test.ts (11 tests) 271ms
 ✓ tests/fabric/xs-directory.test.ts (13 tests) 30ms
 ✓ tests/fabric/xs-stack-progress.test.ts (7 tests) 14ms
 ✓ tests/integration/fabric-wake-off-golden.test.ts (2 tests) 22ms
 ✓ tests/fabric/mention.test.ts (14 tests) 15ms
 ✓ tests/mention/autocomplete-session.test.ts (10 tests) 8ms
 ✓ tests/fabric/wake-level.test.ts (20 tests) 11ms
 ✓ tests/fabric/router-wake.test.ts (10 tests) 12ms
 ✓ tests/fabric/xs-unread.test.ts (21 tests) 2548ms
   ✓ property: random event sequences > bounded, per-session isolated, and any entry is cleared once a later-started turn completes 2534ms
 ✓ tests/fabric/xs-inbox.test.ts (10 tests) 8ms
stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-hjptdo/.pi/agent/pi-subagent.json → /tmp/pi-trace-hjptdo/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-hjptdo/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-gy0uEg/.pi/agent/pi-subagent.json → /tmp/pi-trace-gy0uEg/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-gy0uEg/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-Xmh9Ho/.pi/agent/pi-subagent.json → /tmp/pi-trace-Xmh9Ho/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-Xmh9Ho/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-rxqXXC/.pi/agent/pi-subagent.json → /tmp/pi-trace-rxqXXC/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-rxqXXC/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-hrSZ8d/.pi/agent/pi-subagent.json → /tmp/pi-trace-hrSZ8d/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-hrSZ8d/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-y3FhrQ/.pi/agent/pi-subagent.json → /tmp/pi-trace-y3FhrQ/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-y3FhrQ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-GK2WAk/.pi/agent/pi-subagent.json → /tmp/pi-trace-GK2WAk/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-GK2WAk/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-x4XhXG/.pi/agent/pi-subagent.json → /tmp/pi-trace-x4XhXG/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-x4XhXG/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-SXRNo2/.pi/agent/pi-subagent.json → /tmp/pi-trace-SXRNo2/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-SXRNo2/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-QJhX4B/.pi/agent/pi-subagent.json → /tmp/pi-trace-QJhX4B/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-QJhX4B/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-CmwPt3/.pi/agent/pi-subagent.json → /tmp/pi-trace-CmwPt3/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-CmwPt3/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-IuRbRQ/.pi/agent/pi-subagent.json → /tmp/pi-trace-IuRbRQ/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-IuRbRQ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-08u64b/.pi/agent/pi-subagent.json → /tmp/pi-trace-08u64b/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-08u64b/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-fl7LPv/.pi/agent/pi-subagent.json → /tmp/pi-trace-fl7LPv/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-fl7LPv/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-9XeG1G/.pi/agent/pi-subagent.json → /tmp/pi-trace-9XeG1G/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-9XeG1G/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > compat-failure ends with the stub tool and never reaches post-guard wiring
[pi-subagent] settings moved: /tmp/pi-trace-fAIl1p/.pi/agent/pi-subagent.json → /tmp/pi-trace-fAIl1p/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-fAIl1p/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > fabric-thread arch §9.3 (P3): thread-main registers `thread` right after the fabric tool group; thread-child gains no registration
[pi-subagent] settings moved: /tmp/pi-trace-sYFYus/.pi/agent/pi-subagent.json → /tmp/pi-trace-sYFYus/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-sYFYus/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

 ✓ tests/governance/activate-trace.test.ts (4 tests) 470ms
 ✓ tests/fabric/xs-receiver-progress.test.ts (8 tests) 10ms
 ✓ tests/fabric/xs-sender-alias.test.ts (11 tests) 10ms
 ✓ tests/mention/session-alias.test.ts (13 tests) 27ms
 ✓ tests/fabric/xs-channel.test.ts (47 tests) 13ms
 ✓ tests/fabric/thread/directory.test.ts (10 tests) 6ms
 ✓ tests/fabric/xs-wake-ledger.test.ts (12 tests) 10ms
 ✓ tests/fabric/xs-alias-auto.test.ts (9 tests) 27ms
 ✓ tests/fabric/wake-observability.test.ts (8 tests) 15ms
 ✓ tests/fabric/thread/records.test.ts (7 tests) 6ms
 ✓ tests/fabric/xs-membership-handoff.test.ts (5 tests) 7ms
 ✓ tests/mention/notes.test.ts (9 tests) 5ms
 ✓ tests/fabric/thread/decision.test.ts (8 tests) 6ms
 ✓ tests/fabric/xs-alias-format.test.ts (7 tests) 10ms
 ✓ tests/fabric/thread/outcome.test.ts (8 tests) 6ms
 ✓ tests/fabric/thread/lane.test.ts (8 tests) 6ms
 ✓ tests/fabric/format-fence.test.ts (5 tests) 5ms
 ✓ tests/fabric/xs-alias-decided.test.ts (9 tests) 7ms
 ✓ tests/fabric/xs-dedup.test.ts (7 tests) 6ms
 ✓ tests/fabric/xs-host-cap.test.ts (7 tests) 7ms
 ✓ tests/fabric/thread/buffer.test.ts (5 tests) 9ms
 ✓ tests/fabric/xs-alias-handoff.test.ts (6 tests) 5ms
 ✓ tests/fabric/xs-directory-channel.test.ts (5 tests) 6ms
 ✓ tests/fabric/throttle.test.ts (4 tests) 4ms
 ✓ tests/fabric/xs-render.test.ts (5 tests) 10ms
 ✓ tests/fabric/xs-alias-suggest.test.ts (4 tests) 26ms
 ✓ tests/fabric/thread/deadline.test.ts (6 tests) 5ms
 ✓ tests/fabric/legacy-xs-v071-fixture.test.ts (4 tests) 5ms
 ✓ tests/fabric/xs-activate-orphan.test.ts (1 test) 5ms
 ✓ tests/fabric/tree.test.ts (3 tests) 4ms
stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold
[bundle-parity] src-hot: median=10715ms range=10471–12025ms samples=[12025, 10715, 10754, 10482, 10471]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget
[bundle-parity] bundle-hot: median=916ms range=902–967ms samples=[902, 910, 967, 952, 916]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline
[bundle-parity] dispatcher-hot: median=904ms range=897–918ms samples=[897, 918, 899, 904, 905]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold
[bundle-parity] bundle-cold: median=1010ms range=904–1010ms samples=[904, 1010]; src-cold: median=26469ms range=10496–26469ms samples=[26469, 10496]; dispatcher-cold: median=1245ms range=908–1245ms samples=[1245, 908]

 ✓ tests/governance/bundle-parity.test.ts (28 tests) 147350ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > syntactically broken bundle ⇒ exactly one error, zero tools — never a silent source fallback 497ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > bundle that throws at load time ⇒ one error carrying the message, zero tools 463ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > no bundle at all (git-install shape) ⇒ zero errors, the SOURCE path comes up with the real tool set 25146ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > host modules unresolvable ⇒ loud failure naming the pinning, not a partial redirect or a fallback 484ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold 54773ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget 4960ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline 4822ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold 41448ms
 ✓ tests/fabric/xs-switch.test.ts (2 tests) 4ms

 Test Files  76 passed (76)
      Tests  1183 passed (1183)
   Start at  11:51:59
   Duration  150.30s (transform 5.64s, setup 1.03s, collect 15.41s, tests 202.33s, environment 13ms, prepare 4.05s)

```

### plan 包 B 完整门禁 — FAIL（2 failed / 1942 passed；112 files）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 420 npx vitest run tests/fabric/xs-reply-notice.test.ts tests/web-hub/agent tests/fabric/xs-progress.property.test.ts tests/integration/fabric-xs-reply.test.ts tests/integration/fabric-xs-activate-session.test.ts tests/integration/fabric-xs-activation-compat.test.ts tests/integration/xs-idle-wake-warning-compat.test.ts tests/integration/stack-teardown-matrix.test.ts tests/conformance/fabric-xs.test.ts tests/boundary tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/governance
```

完整日志：`/tmp/xs20-B-plan-gate.log`

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/agent/builtin-bridge.test.ts (67 tests) 38ms
 ✓ tests/web-hub/agent/connection.test.ts (55 tests) 2208ms
   ✓ connection over a real unix socket (fake hub) > hub accepts but never acks ⇒ 2s disconnect; ev meanwhile is not queued 2006ms
stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down
[pi-subagent] settings moved: /tmp/pi-matrix-jKBAUx/.pi/agent/pi-subagent.json → /tmp/pi-matrix-jKBAUx/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-jKBAUx/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-jKBAUx/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers)
[pi-subagent] settings moved: /tmp/pi-matrix-LuW3bd/.pi/agent/pi-subagent.json → /tmp/pi-matrix-LuW3bd/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-LuW3bd/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-LuW3bd/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-ptQbHs/.pi/agent/pi-subagent.json → /tmp/pi-matrix-ptQbHs/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-ptQbHs/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-ptQbHs/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-ptQbHs/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-Y35iGn/.pi/agent/pi-subagent.json → /tmp/pi-matrix-Y35iGn/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-Y35iGn/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-Y35iGn/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-Y35iGn/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-J7nHo3/.pi/agent/pi-subagent.json → /tmp/pi-matrix-J7nHo3/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-J7nHo3/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-J7nHo3/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-J7nHo3/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] settings moved: /tmp/pi-matrix-rOixFq/.pi/agent/pi-subagent.json → /tmp/pi-matrix-rOixFq/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-rOixFq/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-rOixFq/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] /tmp/pi-matrix-rOixFq/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] settings moved: /tmp/pi-matrix-dI46cR/.pi/agent/pi-subagent.json → /tmp/pi-matrix-dI46cR/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-dI46cR/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-dI46cR/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] /tmp/pi-matrix-dI46cR/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] settings moved: /tmp/pi-matrix-6LSSzg/.pi/agent/pi-subagent.json → /tmp/pi-matrix-6LSSzg/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-6LSSzg/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-6LSSzg/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] /tmp/pi-matrix-6LSSzg/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] settings moved: /tmp/pi-matrix-wUhjf5/.pi/agent/pi-subagent.json → /tmp/pi-matrix-wUhjf5/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-wUhjf5/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-wUhjf5/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > path A alone (a rebuild with neither B nor C before it) also disposes the wake service through the mailbox
[pi-subagent] /tmp/pi-matrix-pOEPNL/.pi/agent/pi-subagent.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-LWXPFx/.pi/agent/pi-subagent.json → /tmp/pi-matrix-LWXPFx/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-LWXPFx/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-LWXPFx/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-LWXPFx/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-vSSJ6v/.pi/agent/pi-subagent.json → /tmp/pi-matrix-vSSJ6v/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-vSSJ6v/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-vSSJ6v/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-vSSJ6v/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-pcBqtU/.pi/agent/pi-subagent.json → /tmp/pi-matrix-pcBqtU/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-pcBqtU/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-pcBqtU/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-pcBqtU/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-jxBd2z/.pi/agent/pi-subagent.json → /tmp/pi-matrix-jxBd2z/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-jxBd2z/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-jxBd2z/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill)
[pi-subagent] settings moved: /tmp/pi-matrix-ASmYFl/.pi/agent/pi-subagent.json → /tmp/pi-matrix-ASmYFl/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-ASmYFl/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-ASmYFl/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] settings moved: /tmp/pi-matrix-xnylX5/.pi/agent/pi-subagent.json → /tmp/pi-matrix-xnylX5/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-xnylX5/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-xnylX5/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] /tmp/pi-matrix-xnylX5/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] settings moved: /tmp/pi-matrix-NQqGlh/.pi/agent/pi-subagent.json → /tmp/pi-matrix-NQqGlh/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-NQqGlh/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-NQqGlh/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope)
[pi-subagent] settings moved: /tmp/pi-matrix-qf4FLG/.pi/agent/pi-subagent.json → /tmp/pi-matrix-qf4FLG/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-qf4FLG/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-qf4FLG/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5)
[pi-subagent] settings moved: /tmp/pi-matrix-x9z914/.pi/agent/pi-subagent.json → /tmp/pi-matrix-x9z914/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-x9z914/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-x9z914/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever)
[pi-subagent] settings moved: /tmp/pi-matrix-eXf4qc/.pi/agent/pi-subagent.json → /tmp/pi-matrix-eXf4qc/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-eXf4qc/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-eXf4qc/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] settings moved: /tmp/pi-matrix-EHjj8e/.pi/agent/pi-subagent.json → /tmp/pi-matrix-EHjj8e/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-EHjj8e/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-EHjj8e/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] settings moved: /tmp/pi-matrix-njJPLm/.pi/agent/pi-subagent.json → /tmp/pi-matrix-njJPLm/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-njJPLm/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-njJPLm/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] /tmp/pi-matrix-njJPLm/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi
[pi-subagent] settings moved: /tmp/pi-matrix-OvwK9p/.pi/agent/pi-subagent.json → /tmp/pi-matrix-OvwK9p/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-OvwK9p/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-OvwK9p/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown
[pi-subagent] settings moved: /tmp/pi-matrix-cKQY7u/.pi/agent/pi-subagent.json → /tmp/pi-matrix-cKQY7u/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-cKQY7u/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-cKQY7u/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack
[pi-subagent] settings moved: /tmp/pi-matrix-hgCeeM/.pi/agent/pi-subagent.json → /tmp/pi-matrix-hgCeeM/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-hgCeeM/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-hgCeeM/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] settings moved: /tmp/pi-matrix-VfR9qx/.pi/agent/pi-subagent.json → /tmp/pi-matrix-VfR9qx/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-VfR9qx/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-VfR9qx/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] settings moved: /tmp/pi-matrix-rBNU9y/.pi/agent/pi-subagent.json → /tmp/pi-matrix-rBNU9y/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-rBNU9y/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-rBNU9y/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] /tmp/pi-matrix-rBNU9y/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] /tmp/pi-matrix-rBNU9y/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] 子会话 switch_context 已在本进程停用：matrix-probe（pi 运行时能力检测未通过），子会话回退为仅 pi 自动压缩。

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G11: a shut-down activation no longer toasts, and a session_start on it re-arms exactly one subscription
[pi-subagent] settings moved: /tmp/pi-matrix-JJU1mu/.pi/agent/pi-subagent.json → /tmp/pi-matrix-JJU1mu/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-JJU1mu/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-JJU1mu/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

 ❯ tests/integration/stack-teardown-matrix.test.ts (28 tests | 1 failed) 20890ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down 7019ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers) 905ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build 443ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build 425ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build 426ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off 821ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload) 810ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it 845ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A 430ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose 408ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose 480ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose 456ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose 459ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill) 396ms
   ✓ teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent) 446ms
   ✓ teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic) 471ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope) 466ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5) 547ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever) 476ms
   × teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1) 403ms
     → expected [ { …(3) } ] to deeply equal []
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox 865ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi 471ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown 403ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack 391ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds 421ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before 516ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G11: a shut-down activation no longer toasts, and a session_start on it re-arms exactly one subscription 487ms
 ✓ tests/web-hub/agent/wiring-control.test.ts (47 tests) 1798ms
   ✓ wireWebHub — caps broadcast (§3.1/D10) > web-hub-upload plan §5.1: webHub.uploads → upload.v1/upload.lan.v1 caps > uploads:"on" (also the default/unset) advertises both upload.v1 and upload.lan.v1 575ms
 ✓ tests/web-hub/agent/wiring.test.ts (26 tests) 246ms
 ✓ tests/web-hub/agent/capture-commands.test.ts (37 tests) 29ms
 ✓ tests/web-hub/agent/commands.test.ts (54 tests) 52ms
 ✓ tests/web-hub/agent/wiring-hold.test.ts (17 tests) 421ms
 ✓ tests/web-hub/agent/hold-driver.test.ts (51 tests) 632ms
stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X2: compaction >30s rejects throughout; cancellation emits compact_failed and opens only that window
[pi-subagent] fabric fence stuck: compaction open 30s — still rejecting cross-session deliveries; /fabric fence reset to clear (local only)

stdout | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X6: phase-1 C-P1–C-P5 remain green
C-X6 delegated real-pi gates:

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/conformance/fabric-wake.test.ts (8 tests) 416ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  11:55:13
   Duration  4.73s (transform 2.57s, setup 86ms, collect 3.92s, tests 416ms, environment 0ms, prepare 59ms)



stdout | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X7: record pi's duplicate-tool arbitration without depending on the winner
C-X7 observed arbitration (record-only): {"visible":["Send a message to another joined main session on this machine's web hub (fabric cross-session; the recipient sees it as untrusted input). Reply to an incoming cross-session message by messaging its from.ref. effect \"applied\" = delivery confirmed; \"none\" = provably NOT delivered (safe to retry later); \"unknown\" = the message may have entered the recipient's queue — it usually becomes visible at the recipient's next turn boundary; do NOT blindly resend."],"executed":[],"toolResults":[{"type":"message","id":"4279c232","parentId":"ea252235","timestamp":"2026-11-05T03:55:18.245Z","message":{"role":"toolResult","toolCallId":"stub-tool-0-message_session","toolName":"message_session","content":[{"type":"text","text":"{\"status\":\"origin_changed\",\"effect\":\"none\",\"reason\":\"origin_changed\"}"}],"details":{"status":"origin_changed","effect":"none","reason":"origin_changed"},"isError":false,"durationMs":1,"timestamp":1793850918245}}],"errors":[]}

stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X12b: no BAS at all ⇒ first context sight aborts with ZERO provider requests; absent + supervised
[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only

stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X14b: a host that loses the custom shape (no BAS) aborts the marker before the provider; the body is not re-sent as a fallback
[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only

 ✓ tests/conformance/fabric-xs.test.ts (27 tests) 47328ms
   ✓ fabric phase-2 real pi contracts > C-X1b: pre-start compaction >10s remains owned, starts with token and deadline aborts the slow provider 10157ms
   ✓ fabric phase-2 real pi contracts > C-X2: compaction >30s rejects throughout; cancellation emits compact_failed and opens only that window 30116ms
   ✓ fabric phase-2 real pi contracts > C-X6: phase-1 C-P1–C-P5 remain green 5230ms
 ✓ tests/web-hub/agent/resume-exec.test.ts (29 tests) 76ms
 ✓ tests/web-hub/agent/command-capture-recorder.test.ts (19 tests) 31ms
 ✓ tests/web-hub/agent/run-transcript.test.ts (34 tests) 44ms
 ✓ tests/web-hub/agent/xs-alias-auto.test.ts (22 tests) 77ms
 ✓ tests/web-hub/agent/commands-hold.test.ts (27 tests) 41ms
 ✓ tests/integration/fabric-xs-activate-session.test.ts (13 tests) 87ms
 ✓ tests/web-hub/agent/snapshot.test.ts (21 tests) 2008ms
   ✓ buildBranchReply — lazy reverse projection ≡ legacy project-all-then-trim > is byte-identical to the legacy implementation over 200 seeded branches × 5 budgets 1920ms
 ✓ tests/web-hub/agent/worktree-sampler.test.ts (20 tests) 531ms
   ✓ createWorktreeSampler — ★ hard deadline (merge gate) > ★ real executor + a SIGTERM-ignoring fake git script: the deadline's abort settles the underlying call well under hardDeadlineMs + 250ms, and the process group is actually dead afterward 508ms
 ✓ tests/web-hub/agent/prompt-gate.test.ts (27 tests) 33ms
 ✓ tests/web-hub/agent/quota-sampler.test.ts (37 tests) 20ms
 ✓ tests/web-hub/agent/ledger.test.ts (48 tests) 52ms
 ✓ tests/web-hub/agent/bash-jobs-projection.test.ts (24 tests) 697ms
   ✓ archive-aware omitted (2026-10-28) > INVARIANT (seeded sweep): omittedTerminalJobIds ≡ omitted (cap + byte ladder); ids are terminal, unarchived, off-wire 670ms
 ✓ tests/web-hub/agent/wiring-resume.test.ts (9 tests) 224ms
 ✓ tests/web-hub/agent/command-record.test.ts (36 tests) 23ms
 ✓ tests/fabric/xs-progress.property.test.ts (13 tests) 2166ms
   ✓ xs progress — merge lattice (property) > random out-of-order / duplicate / late / stale-revision writes never regress a fact 1652ms
   ✓ xs progress — activation claims (property) > claim state machine matches the spec across random ops (idempotent consume, at-most-once) 407ms
 ✓ tests/web-hub/agent/xs-state-bridge.test.ts (22 tests) 38ms
 ✓ tests/fabric/xs-reply-notice.test.ts (24 tests) 23ms
 ✓ tests/web-hub/agent/feishu-admin.test.ts (30 tests) 35ms
 ✓ tests/web-hub/agent/event-tap.test.ts (21 tests) 21ms
 ✓ tests/web-hub/agent/bash-jobs-sampler.test.ts (16 tests) 40ms
 ✓ tests/web-hub/agent/commands-archive.test.ts (15 tests) 73ms
 ✓ tests/integration/fabric-xs-reply.test.ts (15 tests) 90059ms
   ✓ RXW reply association (real hub × real stacks) > #1 round trip: expectReply+wake ⇒ B header carries reply_to ⇒ B replyTo ⇒ A is woken 4664ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, quiet path: two due tickets of one session merge into ONE notice and clear owed 4673ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, wake path: a primed requester is woken by its own timeout notice 4679ms
   ✓ RXW reply association (real hub × real stacks) > #3a leave before due ⇒ nothing is written; at lateUntil the notice is dropped and counted 4633ms
   ✓ RXW reply association (real hub × real stacks) > #3b compaction window at due time ⇒ no write; the fence-close event replays the owed notice 4723ms
   ✓ RXW reply association (real hub × real stacks) > #3c slow session_before_switch ⇒ no write; a cancelled switch is closed by fence reset, then it flushes 4647ms
   ✓ RXW reply association (real hub × real stacks) > #3d switch away before due, due while away, switch back ⇒ owed notice appears on restore 4586ms
   ✓ RXW reply association (real hub × real stacks) > #3e expiring entirely while away ⇒ one quiet summary on switch back 4691ms
   ✓ RXW reply association (real hub × real stacks) > #4 receive=replies: unsolicited traffic is refused (hub early + injected bypass); a valid reply wakes 7318ms
   ✓ RXW reply association (real hub × real stacks) > #5 late: inside the grace window a reply is delivered without waking; past it the reply is refused 5006ms
   ✓ RXW reply association (real hub × real stacks) > #6 Blocker counterexample: duplicate reply after consumption (and after /tree) stays refused 4925ms
   ✓ RXW reply association (real hub × real stacks) > #7 /reload keeps the credential; a simulated pi restart refuses it with ONE invalidation notice 7465ms
   ✓ RXW reply association (real hub × real stacks) > #8 address pinning: a name rebound between resolve and send never reaches the new holder 7136ms
   ✓ RXW reply association (real hub × real stacks) > #9a old hub without the reply cap: expectReply is refused without a frame; receive=replies degrades to off 7470ms
   ✓ RXW reply association (real hub × real stacks) > #9b old recipient (reply disabled) is refused without delivery; hub restart mid-reply ⇒ unknown ⇒ resend delivers at most once 13441ms
 ✓ tests/web-hub/agent/xs-client.test.ts (24 tests) 40ms
 ✓ tests/web-hub/agent/xs-alias.test.ts (16 tests) 56ms
 ✓ tests/web-hub/agent/cache-keepalive-projection.test.ts (33 tests) 22ms
 ✓ tests/web-hub/agent/steer-queue-drop.test.ts (11 tests) 19ms
 ✓ tests/web-hub/agent/command-complete.test.ts (20 tests) 16ms
 ✓ tests/web-hub/agent/command-policy.test.ts (67 tests) 21ms
 ✓ tests/web-hub/agent/todo-projection.test.ts (18 tests) 25ms
 ✓ tests/web-hub/agent/resume-list.test.ts (16 tests) 97ms
 ✓ tests/web-hub/agent/restart.test.ts (21 tests) 33ms
 ✓ tests/web-hub/agent/wiring-lan.test.ts (17 tests) 144ms
 ✓ tests/web-hub/agent/extension-async-late.test.ts (6 tests) 17ms
 ✓ tests/integration/fabric-xs-reply-off-golden.test.ts (2 tests) 35ms
 ✓ tests/web-hub/agent/admin-cmds.test.ts (16 tests) 108ms
 ✓ tests/web-hub/agent/hold.test.ts (31 tests) 18ms
 ✓ tests/web-hub/agent/passwd-prompt.test.ts (43 tests) 25ms
 ✓ tests/web-hub/agent/commands-mention-session.test.ts (9 tests) 20ms
 ✓ tests/web-hub/agent/queue-mirror.test.ts (22 tests) 14ms
 ✓ tests/integration/fabric-xs-off-golden.test.ts (3 tests) 86ms
 ✓ tests/web-hub/agent/lan-status.test.ts (31 tests) 15ms
 ✓ tests/web-hub/agent/dialogs.test.ts (12 tests) 11ms
 ✓ tests/web-hub/agent/run-transcript-tail.test.ts (8 tests) 94ms
 ✓ tests/web-hub/agent/steer-late.test.ts (10 tests) 16ms
 ✓ tests/web-hub/agent/launcher.test.ts (20 tests) 24ms
 ✓ tests/web-hub/agent/real-command-matrix.test.ts (3 tests) 22ms
 ✓ tests/web-hub/agent/xs-member-slot.test.ts (12 tests) 26ms
 ✓ tests/web-hub/agent/worktrees-projection.test.ts (14 tests) 120ms
 ✓ tests/web-hub/agent/resume-list-bounds.test.ts (10 tests) 2132ms
   ✓ resume-list bounds — seeded property (§4 P2 list) > stops at 2000 rows and reports truncated 502ms
   ✓ resume-list bounds — seeded property (§4 P2 list) > flags partial when the 64 MiB read budget is exhausted 447ms
   ✓ resume-list bounds — seeded property (§4 P2 list) > caps candidate files at 5 000 newest-first and reports truncated 996ms
 ✓ tests/web-hub/agent/xs-legacy-hub.test.ts (10 tests) 27ms
 ✓ tests/web-hub/agent/redact.test.ts (57 tests) 84ms
 ✓ tests/web-hub/agent/wiring-restart.test.ts (12 tests) 97ms
 ✓ tests/web-hub/agent/wiring-cmd-args.test.ts (7 tests) 40ms
 ✓ tests/boundary/pi-free.test.ts (30 tests) 573ms
 ✓ tests/web-hub/agent/tool-timing.test.ts (9 tests) 70ms
 ✓ tests/integration/fabric-wake-off-golden.test.ts (2 tests) 25ms
stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold
[bundle-parity] src-hot: median=10863ms range=10627–11040ms samples=[10896, 10806, 10627, 11040, 10863]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget
[bundle-parity] bundle-hot: median=929ms range=902–1020ms samples=[929, 922, 1020, 950, 902]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline
[bundle-parity] dispatcher-hot: median=886ms range=878–951ms samples=[878, 886, 880, 951, 888]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold
[bundle-parity] bundle-cold: median=932ms range=927–932ms samples=[927, 932]; src-cold: median=26432ms range=11486–26432ms samples=[26432, 11486]; dispatcher-cold: median=1266ms range=988–1266ms samples=[1266, 988]

 ✓ tests/governance/bundle-parity.test.ts (28 tests) 152371ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > syntactically broken bundle ⇒ exactly one error, zero tools — never a silent source fallback 509ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > bundle that throws at load time ⇒ one error carrying the message, zero tools 530ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > no bundle at all (git-install shape) ⇒ zero errors, the SOURCE path comes up with the real tool set 27995ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > host modules unresolvable ⇒ loud failure naming the pinning, not a partial redirect or a fallback 457ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold 54551ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget 5045ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline 4785ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold 42461ms
 ✓ tests/web-hub/agent/slash.test.ts (21 tests) 15ms
 ✓ tests/web-hub/agent/wiring-quota-pools.test.ts (7 tests) 68ms
 ✓ tests/web-hub/agent/commands-resume.test.ts (5 tests) 13ms
 ✓ tests/web-hub/agent/wiring-private-ns.test.ts (7 tests) 48ms
 ✓ tests/web-hub/agent/resume-open-discipline.test.ts (5 tests) 31ms
 ✓ tests/web-hub/agent/wiring-todo-archive.test.ts (7 tests) 66ms
 ✓ tests/web-hub/agent/xs-web-command.test.ts (15 tests) 21ms
 ✓ tests/web-hub/agent/wiring-proxy.test.ts (12 tests) 44ms
 ✓ tests/web-hub/agent/connection-admin.test.ts (15 tests) 28ms
 ✓ tests/web-hub/agent/hold-faults.test.ts (8 tests) 12ms
 ✓ tests/web-hub/agent/wiring-cache-keepalive.test.ts (8 tests) 88ms
stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-AlQ7Zm/.pi/agent/pi-subagent.json → /tmp/pi-trace-AlQ7Zm/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-AlQ7Zm/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-SejPTO/.pi/agent/pi-subagent.json → /tmp/pi-trace-SejPTO/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-SejPTO/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-k9NP93/.pi/agent/pi-subagent.json → /tmp/pi-trace-k9NP93/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-k9NP93/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-eeALH6/.pi/agent/pi-subagent.json → /tmp/pi-trace-eeALH6/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-eeALH6/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-0ekVRS/.pi/agent/pi-subagent.json → /tmp/pi-trace-0ekVRS/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-0ekVRS/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-8KhuJS/.pi/agent/pi-subagent.json → /tmp/pi-trace-8KhuJS/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-8KhuJS/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-lCJuYM/.pi/agent/pi-subagent.json → /tmp/pi-trace-lCJuYM/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-lCJuYM/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-0JupYh/.pi/agent/pi-subagent.json → /tmp/pi-trace-0JupYh/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-0JupYh/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-NGizpi/.pi/agent/pi-subagent.json → /tmp/pi-trace-NGizpi/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-NGizpi/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-tU08Qf/.pi/agent/pi-subagent.json → /tmp/pi-trace-tU08Qf/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-tU08Qf/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-3cNyZr/.pi/agent/pi-subagent.json → /tmp/pi-trace-3cNyZr/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-3cNyZr/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-Woebny/.pi/agent/pi-subagent.json → /tmp/pi-trace-Woebny/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-Woebny/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-JnsZxN/.pi/agent/pi-subagent.json → /tmp/pi-trace-JnsZxN/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-JnsZxN/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-6n76EB/.pi/agent/pi-subagent.json → /tmp/pi-trace-6n76EB/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-6n76EB/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-mm6vIx/.pi/agent/pi-subagent.json → /tmp/pi-trace-mm6vIx/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-mm6vIx/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > compat-failure ends with the stub tool and never reaches post-guard wiring
[pi-subagent] settings moved: /tmp/pi-trace-LiuWxm/.pi/agent/pi-subagent.json → /tmp/pi-trace-LiuWxm/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-LiuWxm/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > fabric-thread arch §9.3 (P3): thread-main registers `thread` right after the fabric tool group; thread-child gains no registration
[pi-subagent] settings moved: /tmp/pi-trace-URGAbL/.pi/agent/pi-subagent.json → /tmp/pi-trace-URGAbL/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-URGAbL/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

 ✓ tests/governance/activate-trace.test.ts (4 tests) 556ms
 ✓ tests/web-hub/agent/lan-status-security.test.ts (22 tests) 11ms
 ✓ tests/web-hub/agent/wiring-spawn.test.ts (4 tests) 32ms
 ✓ tests/web-hub/agent/commands-input-handled.test.ts (6 tests) 11ms
 ✓ tests/web-hub/agent/models-projection.test.ts (9 tests) 689ms
   ✓ projectModels > keeps every generated wire inside the open bounded schema 628ms
 ✓ tests/web-hub/agent/commands-prompt-fabric.test.ts (20 tests) 21ms
 ✓ tests/web-hub/agent/wiring-models.test.ts (6 tests) 94ms
 ✓ tests/web-hub/agent/proc-identity.test.ts (19 tests) 9ms
 ✓ tests/web-hub/agent/origin-entry.test.ts (13 tests) 12ms
 ✓ tests/web-hub/agent/cmd-args-status.test.ts (9 tests) 28ms
 ✓ tests/boundary/result-tool-residue.test.ts (4 tests) 6ms
 ✓ tests/web-hub/agent/wiring-preview.test.ts (7 tests) 31ms
 ✓ tests/web-hub/agent/compaction-state.test.ts (11 tests) 9ms
 ✓ tests/web-hub/agent/wiring-thread-rebind.test.ts (6 tests) 32ms
 ✓ tests/web-hub/agent/ui-status.test.ts (9 tests) 6ms
 ✓ tests/web-hub/agent/xs-activate-bridge.test.ts (6 tests) 14ms
 ✓ tests/web-hub/agent/command-usage.test.ts (17 tests) 9ms
stderr | tests/web-hub/agent/input-order.test.ts > web-hub's input observer registers last (plan §4.1) > exactly one new 'input' handler appears when webHub.enabled flips on, at the tail of the array
[pi-subagent] settings moved: /tmp/pi-toolkit-home-yJxG5h/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-yJxG5h/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-yJxG5h/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

 ✓ tests/web-hub/agent/input-order.test.ts (1 test) 53ms
 ❯ tests/integration/xs-idle-wake-warning-compat.test.ts (5 tests | 1 failed) 36682ms
   ✓ #20 expectReply mixed-version content byte differential > old-target × new requester remains pre20 byte-identical 7444ms
   ✓ #20 expectReply mixed-version content byte differential > old-hub × new requester remains pre20 byte-identical 7409ms
   ✓ #20 real activate() freezes advice on wake setting: wake-off retains qualifying outcome but pre20 content 7388ms
   × #20 real activate timeout wiring: activationOff=false 7144ms
     → expected '[fabric xs reply-timeout] 你发往 01a1a9d…' to be '[fabric xs reply-timeout] 你发往 01a1a9d…' // Object.is equality
   ✓ #20 real activate timeout wiring: activationOff=true 7296ms
 ✓ tests/web-hub/agent/status.test.ts (6 tests) 7ms
 ✓ tests/web-hub/agent/status-xs-inbox.test.ts (10 tests) 11ms
 ✓ tests/web-hub/agent/status-slot-flush.test.ts (1 test) 12ms
 ✓ tests/web-hub/agent/wiring-feishu.test.ts (5 tests) 31ms
 ✓ tests/web-hub/agent/agent-dir-status.test.ts (13 tests) 31ms
 ✓ tests/web-hub/agent/command-policy-fabric.test.ts (6 tests) 5ms
 ✓ tests/web-hub/agent/hold.property.test.ts (6 tests) 50ms
 ✓ tests/web-hub/agent/status-slots-bash-archive.test.ts (3 tests) 9ms
 ✓ tests/web-hub/agent/proxy-status.test.ts (6 tests) 8ms
 ✓ tests/web-hub/agent/cmd-history-status.test.ts (5 tests) 5ms
 ✓ tests/web-hub/agent/launch-home.test.ts (2 tests) 22ms
 ✓ tests/web-hub/agent/privacy-status.test.ts (5 tests) 5ms
 ✓ tests/web-hub/agent/proxy-status-allowlist.test.ts (3 tests) 4ms
 ✓ tests/integration/fabric-xs-activation-compat.test.ts (1 test) 42486ms
   ✓ fabric-xs-activation mixed versions (I10) > every combination delivers the body once; only new×new×new adds tracking, and old-side combos stay on the legacy byte shape 42485ms
 ✓ tests/web-hub/agent/alias-status.test.ts (3 tests) 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
AssertionError: expected [ { …(3) } ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   Object {
+     "ms": 1.0154810000021826,
+     "ref": false,
+     "site": "src/sysload/activation.ts",
+   },
+ ]

 ❯ tests/integration/stack-teardown-matrix.test.ts:739:45
    737|     await fire(a, "session_shutdown", "reload");
    738|     expect(completionsOf(a.h)).toBe(0); // dropped, not flushed (befor…
    739|     expect(notWebHub(timers.outstanding())).toEqual([]); // both hold-…
       |                                             ^
    740|     await vi.advanceTimersByTimeAsync(10_000);
    741|     expect(completionsOf(a.h)).toBe(0);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  tests/integration/xs-idle-wake-warning-compat.test.ts > #20 real activate timeout wiring: activationOff=false
AssertionError: expected '[fabric xs reply-timeout] 你发往 01a1a9d…' to be '[fabric xs reply-timeout] 你发往 01a1a9d…' // Object.is equality

- Expected
+ Received

  [fabric xs reply-timeout] 你发往 01a1a9db-288 的跨会话请求 q5f33e8831d45a9ef98 已超时未收到回复（截止 2026-11-05T03:58:54.780Z）。
- - q5f33e8831d45a9ef98 → 01a1a9db-288（截止 2026-11-05T03:58:54.780Z） · last seen delivered
+ - q5f33e8831d45a9ef98 → 01a1a9db-288（截止 2026-11-05T03:58:54.780Z）
  宽限期（默认 10 分钟）内到达的回复仍会送达（不唤醒，无需轮询）；宽限期过后凭证失效，对方的补发将被拒收。
- 标 last seen delivered 的请求：最后观测为已送达，尚无对方开始处理（started）的证明——观测可能滞后或漏记，不代表对方此刻一定没在处理。需要的话可在宽限期内用 wake_session（action "activate"，原发送结果的 track.messageId/activationKey）尝试激活（对方若已开始处理会返回 no-op），不要重发正文。

 ❯ tests/integration/xs-idle-wake-warning-compat.test.ts:181:37
    179|     expect(notices).toHaveLength(1);
    180|     if (activationOff) expect(notices[0].content).toBe(buildTimeoutNot…
    181|     else expect(notices[0].content).toBe(buildTimeoutNoticeContent([ti…
       |                                     ^
    182|     expect(
    183|       (await b.rpc("inspect")).messages.filter((m: { content: string }…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  2 failed | 110 passed (112)
      Tests  2 failed | 1942 passed (1944)
   Start at  11:54:30
   Duration  246.32s (transform 7.43s, setup 1.65s, collect 33.04s, tests 408.02s, environment 20ms, prepare 6.26s)

```

### teardown-matrix 第一次完整 standalone — FAIL（G10 sysload timer）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 120 npx vitest run tests/integration/stack-teardown-matrix.test.ts
```

完整日志：`/tmp/xs20-B-teardown-standalone.log`

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down
[pi-subagent] settings moved: /tmp/pi-matrix-h7HZC4/.pi/agent/pi-subagent.json → /tmp/pi-matrix-h7HZC4/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-h7HZC4/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-h7HZC4/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers)
[pi-subagent] settings moved: /tmp/pi-matrix-RCBPJP/.pi/agent/pi-subagent.json → /tmp/pi-matrix-RCBPJP/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-RCBPJP/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-RCBPJP/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-Xh0fDR/.pi/agent/pi-subagent.json → /tmp/pi-matrix-Xh0fDR/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-Xh0fDR/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-Xh0fDR/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-Xh0fDR/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-nClnVd/.pi/agent/pi-subagent.json → /tmp/pi-matrix-nClnVd/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-nClnVd/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-nClnVd/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-nClnVd/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-a3HCaN/.pi/agent/pi-subagent.json → /tmp/pi-matrix-a3HCaN/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-a3HCaN/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-a3HCaN/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-a3HCaN/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] settings moved: /tmp/pi-matrix-gRA6D2/.pi/agent/pi-subagent.json → /tmp/pi-matrix-gRA6D2/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-gRA6D2/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-gRA6D2/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] /tmp/pi-matrix-gRA6D2/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] settings moved: /tmp/pi-matrix-Yt0ISi/.pi/agent/pi-subagent.json → /tmp/pi-matrix-Yt0ISi/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-Yt0ISi/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-Yt0ISi/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] /tmp/pi-matrix-Yt0ISi/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] settings moved: /tmp/pi-matrix-iIPNwt/.pi/agent/pi-subagent.json → /tmp/pi-matrix-iIPNwt/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-iIPNwt/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-iIPNwt/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] /tmp/pi-matrix-iIPNwt/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] settings moved: /tmp/pi-matrix-a2NOcM/.pi/agent/pi-subagent.json → /tmp/pi-matrix-a2NOcM/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-a2NOcM/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-a2NOcM/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > path A alone (a rebuild with neither B nor C before it) also disposes the wake service through the mailbox
[pi-subagent] /tmp/pi-matrix-WT9XaP/.pi/agent/pi-subagent.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-Vl8nQU/.pi/agent/pi-subagent.json → /tmp/pi-matrix-Vl8nQU/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-Vl8nQU/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-Vl8nQU/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-Vl8nQU/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-X76oEE/.pi/agent/pi-subagent.json → /tmp/pi-matrix-X76oEE/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-X76oEE/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-X76oEE/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-X76oEE/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-kh1D1W/.pi/agent/pi-subagent.json → /tmp/pi-matrix-kh1D1W/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-kh1D1W/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-kh1D1W/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-kh1D1W/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-XANH8S/.pi/agent/pi-subagent.json → /tmp/pi-matrix-XANH8S/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-XANH8S/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-XANH8S/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill)
[pi-subagent] settings moved: /tmp/pi-matrix-ZPUNEU/.pi/agent/pi-subagent.json → /tmp/pi-matrix-ZPUNEU/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-ZPUNEU/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-ZPUNEU/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] settings moved: /tmp/pi-matrix-9YmFGD/.pi/agent/pi-subagent.json → /tmp/pi-matrix-9YmFGD/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-9YmFGD/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-9YmFGD/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] /tmp/pi-matrix-9YmFGD/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] settings moved: /tmp/pi-matrix-msEYxk/.pi/agent/pi-subagent.json → /tmp/pi-matrix-msEYxk/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-msEYxk/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-msEYxk/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope)
[pi-subagent] settings moved: /tmp/pi-matrix-Qy9tqv/.pi/agent/pi-subagent.json → /tmp/pi-matrix-Qy9tqv/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-Qy9tqv/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-Qy9tqv/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5)
[pi-subagent] settings moved: /tmp/pi-matrix-C6xDcX/.pi/agent/pi-subagent.json → /tmp/pi-matrix-C6xDcX/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-C6xDcX/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-C6xDcX/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever)
[pi-subagent] settings moved: /tmp/pi-matrix-40Ry8H/.pi/agent/pi-subagent.json → /tmp/pi-matrix-40Ry8H/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-40Ry8H/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-40Ry8H/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] settings moved: /tmp/pi-matrix-m90fRp/.pi/agent/pi-subagent.json → /tmp/pi-matrix-m90fRp/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-m90fRp/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-m90fRp/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] /tmp/pi-matrix-m90fRp/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] settings moved: /tmp/pi-matrix-SBkUgP/.pi/agent/pi-subagent.json → /tmp/pi-matrix-SBkUgP/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-SBkUgP/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-SBkUgP/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi
[pi-subagent] settings moved: /tmp/pi-matrix-Xu6K3k/.pi/agent/pi-subagent.json → /tmp/pi-matrix-Xu6K3k/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-Xu6K3k/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-Xu6K3k/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown
[pi-subagent] settings moved: /tmp/pi-matrix-R58IpR/.pi/agent/pi-subagent.json → /tmp/pi-matrix-R58IpR/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-R58IpR/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-R58IpR/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack
[pi-subagent] settings moved: /tmp/pi-matrix-IWzP6y/.pi/agent/pi-subagent.json → /tmp/pi-matrix-IWzP6y/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-IWzP6y/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-IWzP6y/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] settings moved: /tmp/pi-matrix-jz6kkF/.pi/agent/pi-subagent.json → /tmp/pi-matrix-jz6kkF/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-jz6kkF/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-jz6kkF/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] settings moved: /tmp/pi-matrix-tX8avO/.pi/agent/pi-subagent.json → /tmp/pi-matrix-tX8avO/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-tX8avO/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-tX8avO/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] /tmp/pi-matrix-tX8avO/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] /tmp/pi-matrix-tX8avO/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] 子会话 switch_context 已在本进程停用：matrix-probe（pi 运行时能力检测未通过），子会话回退为仅 pi 自动压缩。

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G11: a shut-down activation no longer toasts, and a session_start on it re-arms exactly one subscription
[pi-subagent] settings moved: /tmp/pi-matrix-tZbD9u/.pi/agent/pi-subagent.json → /tmp/pi-matrix-tZbD9u/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-tZbD9u/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-tZbD9u/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

 ❯ tests/integration/stack-teardown-matrix.test.ts (28 tests | 1 failed) 20651ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down 7421ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers) 939ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build 511ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build 460ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build 477ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off 744ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload) 785ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it 822ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A 403ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose 389ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose 412ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose 404ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose 443ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill) 385ms
   ✓ teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent) 433ms
   ✓ teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic) 419ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope) 432ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5) 437ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever) 397ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1) 797ms
   × teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox 444ms
     → expected [ { …(3) } ] to deeply equal []
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi 417ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown 391ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack 400ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds 406ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before 506ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G11: a shut-down activation no longer toasts, and a session_start on it re-arms exactly one subscription 396ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
AssertionError: expected [ { …(3) } ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   Object {
+     "ms": 4963.9303199999995,
+     "ref": false,
+     "site": "src/sysload/activation.ts",
+   },
+ ]

 ❯ tests/integration/stack-teardown-matrix.test.ts:774:45
    772|     await vi.advanceTimersByTimeAsync(600_000);
    773|     expect(sends).toBe(1); // before 7b: 3 (two more attempts after sh…
    774|     expect(notWebHub(timers.outstanding())).toEqual([]);
       |                                             ^
    775|     // I1 (persistent, acknowledgeable delivery) is intact: the record…
    776|     // next session (same session id, /reload ⇒ fresh module) redelive…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 27 passed (28)
   Start at  11:57:25
   Duration  21.29s (transform 5.28s, setup 81ms, collect 209ms, tests 20.65s, environment 0ms, prepare 57ms)

```

### 类型检查 — FAIL（等待 facade 补丁，TS2339）

```sh
timeout 180 npm run typecheck
```

完整日志：`/tmp/xs20-B-typecheck.log`

```text

> pi-toolkit@0.10.6 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json

src/fabric/xs/activate.ts(667,87): error TS2339: Property 'progressPhaseOf' does not exist on type '{ publishMember(): void; notifyUnreadChanged(): void; hubPort(): XsHubPort & XsActivationHubPort; resolveBlock(query: string): Promise<XsBlockResolve>; hubInfo(): Promise<...>; aliasBridge(): XsAliasBridgePort & Partial<...>; aliasCache(): XsAliasCachePort; aliasAutoSkip?(): XsAliasAutoSkipReason | undefined; }'.
```

### 独立测试类型检查 — FAIL（同一 TS2339，无额外 test TS 错误）

```sh
timeout 180 node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json
```

完整日志：`/tmp/xs20-B-test-types.log`

```text
src/fabric/xs/activate.ts(667,87): error TS2339: Property 'progressPhaseOf' does not exist on type '{ publishMember(): void; notifyUnreadChanged(): void; hubPort(): XsHubPort & XsActivationHubPort; resolveBlock(query: string): Promise<XsBlockResolve>; hubInfo(): Promise<...>; aliasBridge(): XsAliasBridgePort & Partial<...>; aliasCache(): XsAliasCachePort; aliasAutoSkip?(): XsAliasAutoSkipReason | undefined; }'.
```

### 构建 — FAIL（等待 facade 补丁，TS2339）

```sh
timeout 180 npm run build
```

完整日志：`/tmp/xs20-B-build.log`

```text

> pi-toolkit@0.10.6 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json && npm run build:bundle

src/fabric/xs/activate.ts(667,87): error TS2339: Property 'progressPhaseOf' does not exist on type '{ publishMember(): void; notifyUnreadChanged(): void; hubPort(): XsHubPort & XsActivationHubPort; resolveBlock(query: string): Promise<XsBlockResolve>; hubInfo(): Promise<...>; aliasBridge(): XsAliasBridgePort & Partial<...>; aliasCache(): XsAliasCachePort; aliasAutoSkip?(): XsAliasAutoSkipReason | undefined; }'.
```

### 改动文件 Prettier — PASS（报告另行检查）

```sh
timeout 60 npx prettier --check src/fabric/xs/reply-notice.ts src/web-hub/agent/xs.ts src/fabric/xs/stack.ts src/fabric/xs/activate.ts docs/dev/fabric-cross-session/README.md tests/fabric/xs-reply-notice.test.ts tests/web-hub/agent/xs-state-bridge.test.ts tests/conformance/fabric-xs.test.ts tests/integration/fabric-xs-activate-session.test.ts tests/integration/xs-idle-wake-warning-compat.test.ts
```

完整日志：`/tmp/xs20-B-prettier.log`

```text
Checking formatting...
All matched files use Prettier code style!
```

### 冻结面 / diff — PASS（只读 tracked diff；其它 run 的 untracked fixture 不属本包）

```sh
git diff --quiet HEAD -- tests/fixtures/
git diff --quiet origin/dev -- tests/fixtures/
git diff --quiet HEAD -- tests/mention/ src/tools/message-session-tool.ts tests/tools/message-session-tool.test.ts tests/fabric/xs-receiver.test.ts tests/integration/helpers/fabric-xs-process.ts
git diff --check
```

完整日志：`/tmp/xs20-B-frozen.log`

```text
git diff --quiet HEAD -- tests/fixtures/: exit=0
git diff --quiet origin/dev -- tests/fixtures/: exit=0
frozen A/mention/helper paths: exit=0
git diff --check: exit=0
```

### 九套件 XsHarness — PASS（9 files / 69 tests）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 600 npx vitest run tests/integration/fabric-xs-alias-v2.test.ts tests/integration/fabric-xs-alias.test.ts tests/integration/fabric-xs-channel.test.ts tests/integration/fabric-xs-inbox.test.ts tests/integration/fabric-xs-level-mixed.test.ts tests/integration/fabric-xs-lifecycle.test.ts tests/integration/fabric-xs-mention.test.ts tests/integration/fabric-xs-reply.test.ts tests/integration/fabric-xs.test.ts
```

完整日志：`/tmp/xs20-B-harness-nine.log`

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/integration/fabric-xs-reply.test.ts (15 tests) 90742ms
   ✓ RXW reply association (real hub × real stacks) > #1 round trip: expectReply+wake ⇒ B header carries reply_to ⇒ B replyTo ⇒ A is woken 4871ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, quiet path: two due tickets of one session merge into ONE notice and clear owed 4881ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, wake path: a primed requester is woken by its own timeout notice 4887ms
   ✓ RXW reply association (real hub × real stacks) > #3a leave before due ⇒ nothing is written; at lateUntil the notice is dropped and counted 4804ms
   ✓ RXW reply association (real hub × real stacks) > #3b compaction window at due time ⇒ no write; the fence-close event replays the owed notice 5243ms
   ✓ RXW reply association (real hub × real stacks) > #3c slow session_before_switch ⇒ no write; a cancelled switch is closed by fence reset, then it flushes 4781ms
   ✓ RXW reply association (real hub × real stacks) > #3d switch away before due, due while away, switch back ⇒ owed notice appears on restore 4916ms
   ✓ RXW reply association (real hub × real stacks) > #3e expiring entirely while away ⇒ one quiet summary on switch back 4833ms
   ✓ RXW reply association (real hub × real stacks) > #4 receive=replies: unsolicited traffic is refused (hub early + injected bypass); a valid reply wakes 6985ms
   ✓ RXW reply association (real hub × real stacks) > #5 late: inside the grace window a reply is delivered without waking; past it the reply is refused 5302ms
   ✓ RXW reply association (real hub × real stacks) > #6 Blocker counterexample: duplicate reply after consumption (and after /tree) stays refused 4998ms
   ✓ RXW reply association (real hub × real stacks) > #7 /reload keeps the credential; a simulated pi restart refuses it with ONE invalidation notice 7182ms
   ✓ RXW reply association (real hub × real stacks) > #8 address pinning: a name rebound between resolve and send never reaches the new holder 7150ms
   ✓ RXW reply association (real hub × real stacks) > #9a old hub without the reply cap: expectReply is refused without a frame; receive=replies degrades to off 6749ms
   ✓ RXW reply association (real hub × real stacks) > #9b old recipient (reply disabled) is refused without delivery; hub restart mid-reply ⇒ unknown ⇒ resend delivers at most once 13156ms
 ✓ tests/integration/fabric-xs-alias-v2.test.ts (8 tests) 95130ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ①②④ concurrent same-cwd auto-claim → one winner, others skip:taken; D5 hint; --force (TUI) → real-time forced notice without reconnect; tombstone blocks re-claim for 30 days 10469ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ③ pin barrier: a send resolved BEFORE a force still reaches the original holder; with the original holder offline it is NO_TARGET — never the new holder 12293ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑤ web force under webCommandPolicy.fabric=confirm: preview and execution each need their own confirm; the confirm line is parseable; the holder is told 7931ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑧a unnotifiable holders: an online pre-v2 agent and a linked holder with xs off refuse --force (take only); a just-offline holder can be forced but not taken; the old agent returns to the legacy notice 15826ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑥ the human 'decided' mark survives /reload and a hub restart: a session that cleared its alias never auto-claims again (a fresh session in the same dir does) 11714ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑧b v1-only hub × new agents: no auto-claim, no force, no v2 hint — plain aliasing and delivery by alias keep working, no frame is lost 9512ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑨a /new hands the alias to the new sid (origin kept, no tombstone, human mark inherited); a human-granted name moves too; fork inherits nothing 12182ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑨b forged prevSessionId is refused (online and offline victims); an alias taken before the /new is not restored by it 15202ms
 ✓ tests/integration/fabric-xs-mention.test.ts (10 tests) 85623ms
   ✓ MW @session mention wiring (real hub × real stacks) > TUI explicit form: B gets a reply_to wake at level 0; B's reply wakes A when A receives in wake mode (RX7 R4 revision) 4513ms
   ✓ MW @session mention wiring (real hub × real stacks) > RX7 R4: a human-origin reply to a deliver-mode A is shown (display:true) but never wakes A 6833ms
   ✓ MW @session mention wiring (real hub × real stacks) > web composer path: `@session:<ref> msg` is routed (never reaches the native prompt) with the same semantics 4472ms
   ✓ MW @session mention wiring (real hub × real stacks) > bare `@name msg`: a unique cache hit routes (cache warmed by completion); completion inserts the bare name 4630ms
   ✓ MW @session mention wiring (real hub × real stacks) > a cwd file with the same name wins over a session: bare form passes through, completion inserts the explicit ref 4679ms
   ✓ MW @session mention wiring (real hub × real stacks) > off states: not joined / left ⇒ every `@` passes through (TUI + web) 7660ms
   ✓ MW @session mention wiring (real hub × real stacks) > xs off: the port is never injected — `@session:` is released verbatim 4542ms
   ✓ MW @session mention wiring (real hub × real stacks) > errors surface as subagent:mention-error{source:mention-session}, display-only 4667ms
   ✓ MW @session mention wiring (real hub × real stacks) > 2026-11-04 mention-handled fix: a handled mention input reports the web dispatch — the ctl entry is consumed and never decays to unconfirmed(unobserved) 38775ms
   ✓ MW @session mention wiring (real hub × real stacks) > a subagent label wins over a same-named session (cache warm, session unique): routed to the subagent, B untouched 4850ms
 ✓ tests/integration/fabric-xs-alias.test.ts (6 tests) 93999ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #1 set, send by alias (sender pins the full sessionId), from.alias header, @alias, validation + conflicts 25080ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #2 channel scope: an alias is invisible without a shared channel (NO_TARGET, no fallback to names); clear ⇒ cooling 9776ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #3 take: online ⇒ refused, offline <10m ⇒ refused, ≥10m ⇒ preview → confirm token → applied; old holder is told once; sends re-route 14575ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #4 a damaged alias file ⇒ degraded across restarts, never falls back; file bytes unchanged; /webhub status line; fixing the file restores 19016ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #5 web origin × webCommandPolicy.fabric=confirm: generic confirm per command, preview output carries the parseable confirm line, take executes 12443ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #6 mixed fleet: an alias-disabled (pre-alias) agent never sees aliases, and is unreachable BY alias without being broken 13108ms
 ✓ tests/integration/fabric-xs.test.ts (8 tests) 53365ms
   ✓ XW real hub child × two activate-built stacks × real sockets > join/list, deliver-only evidence, N1 then applied wake, reply, busy queued, goal downgrade and mutation fences 4942ms
   ✓ XW real hub child × two activate-built stacks × real sockets > not joined is invisible/undeliverable; leave rejects an already stamped in-flight deliver; fork does not inherit 4694ms
   ✓ XW real hub child × two activate-built stacks × real sockets > send resolve racing /new never emits send; reload reclaims Controller and dedup replays the first verdict 5415ms
   ✓ XW real hub child × two activate-built stacks × real sockets > hub death after receiver ack returns unknown; restart reconstructs members without resending; reload dedup survives 8816ms
   ✓ old-cap peers stay invisible and an old-cap hub returns off without sending 11260ms
   ✓ autoJoin publishes the joined member AFTER webhub session_start's session slot; fork never auto-joins 8200ms
   ✓ web /new exec claim fences actual socket ingress before its command trampoline runs 5116ms
   ✓ /new (web 清空) keeps the joined channels: the new sid re-joins and stays reachable; fork still does not inherit 4920ms
 ✓ tests/integration/fabric-xs-channel.test.ts (6 tests) 82035ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #1 same-channel scope, #2 union visibility (rows carry the shared non-default set) 13906ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #3 broadcast: fanout, no loop-back, deliver downgrade, replies invisible, level-0 wake, woken re-broadcast level_limit, sender maxLevel=0 15384ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #4 limits: per-hour cap, min interval, fan-out cap, #default refused 16391ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #5 linearization: leave before stage 3 ⇒ none{rejected}; leave after dispatch ⇒ applied (no rollback) 13787ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #6 a cross-channel double holder is AMBIGUOUS (uniqueness judged before visibility) 9480ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #7 hub restart, /reload, fork (no inheritance), suspend on channels.enabled=false and restore 13087ms
 ✓ tests/integration/fabric-xs-lifecycle.test.ts (9 tests) 51409ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > 8 deferred tombstones survive reload but new teardown frees ALL capacity 4638ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > 8 deferred tombstones survive reload but resume teardown frees ALL capacity 4616ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > 8 deferred tombstones survive reload but fork teardown frees ALL capacity 4558ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > recover aborting→stuck; agent_settled releases owner and ledger without a second abort 4556ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > an already-started wake remains owned after an xs/wake-off reload (wakeOnly=false) 4697ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > an already-started wake remains owned after an xs/wake-off reload (wakeOnly=true) 4675ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > xs-off reload still aborts a marked orphan before any provider work 4717ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > rpc process restore: disk membership is reachable with a new agent id, capability restarts unknown 6848ms
   ✓ wake-unknown-optimistic: legacy host (XW_LEGACY fake — no BAS, context instead) > the first optimistic run is aborted before any provider call; capability goes absent; later wakes are host_unsupported 12104ms
 ✓ tests/integration/fabric-xs-inbox.test.ts (6 tests) 28578ms
   ✓ IBW unread inbox (real stacks) > exit 1 (receiver host): quiet deliver counts, shows badge + web field, clears on a later-started turn 5494ms
   ✓ IBW unread inbox (real stacks) > Controller wake write counts (trigger turn started after the write) 4624ms
   ✓ IBW unread inbox (real stacks) > busy: a write inside turn k survives turn k's end and clears at turn k+1's 4586ms
   ✓ IBW unread inbox (real stacks) > exit 2 (NoticeGate quiet host): a timeout notice counts without an xid 4553ms
   ✓ IBW unread inbox (real stacks) > agent_end fallback clears when turn_end never fires; /reload keeps the count 4587ms
   ✓ IBW unread inbox (real stacks) > a rejected message (effect none) is not counted 4732ms
 ✓ tests/integration/fabric-xs-level-mixed.test.ts (1 test) 8409ms
   ✓ one causal chain: tree mailbox → root → xs wake → tree carry → xs wake → max-level downgrade; only human resets 8408ms

 Test Files  9 passed (9)
      Tests  69 passed (69)
   Start at  11:58:37
   Duration  301.03s (transform 287ms, setup 237ms, collect 288ms, tests 589.29s, environment 2ms, prepare 476ms)

```

### teardown-matrix 第二次完整 standalone — PASS（28 tests）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 120 npx vitest run tests/integration/stack-teardown-matrix.test.ts
```

完整日志：`/tmp/xs20-B-teardown-standalone-second.log`

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down
[pi-subagent] settings moved: /tmp/pi-matrix-FTA3gW/.pi/agent/pi-subagent.json → /tmp/pi-matrix-FTA3gW/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-FTA3gW/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-FTA3gW/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers)
[pi-subagent] settings moved: /tmp/pi-matrix-QrDcKm/.pi/agent/pi-subagent.json → /tmp/pi-matrix-QrDcKm/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-QrDcKm/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-QrDcKm/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-zebTcY/.pi/agent/pi-subagent.json → /tmp/pi-matrix-zebTcY/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-zebTcY/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-zebTcY/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-zebTcY/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-IyuATQ/.pi/agent/pi-subagent.json → /tmp/pi-matrix-IyuATQ/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-IyuATQ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-IyuATQ/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-IyuATQ/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-6Jzkw9/.pi/agent/pi-subagent.json → /tmp/pi-matrix-6Jzkw9/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-6Jzkw9/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-6Jzkw9/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-6Jzkw9/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] settings moved: /tmp/pi-matrix-mmiPHO/.pi/agent/pi-subagent.json → /tmp/pi-matrix-mmiPHO/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-mmiPHO/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-mmiPHO/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] /tmp/pi-matrix-mmiPHO/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] settings moved: /tmp/pi-matrix-pr4Bzp/.pi/agent/pi-subagent.json → /tmp/pi-matrix-pr4Bzp/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-pr4Bzp/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-pr4Bzp/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] /tmp/pi-matrix-pr4Bzp/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] settings moved: /tmp/pi-matrix-klOt0j/.pi/agent/pi-subagent.json → /tmp/pi-matrix-klOt0j/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-klOt0j/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-klOt0j/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] /tmp/pi-matrix-klOt0j/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] settings moved: /tmp/pi-matrix-pUM9ym/.pi/agent/pi-subagent.json → /tmp/pi-matrix-pUM9ym/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-pUM9ym/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-pUM9ym/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > path A alone (a rebuild with neither B nor C before it) also disposes the wake service through the mailbox
[pi-subagent] /tmp/pi-matrix-5oFqxa/.pi/agent/pi-subagent.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-kmy8er/.pi/agent/pi-subagent.json → /tmp/pi-matrix-kmy8er/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-kmy8er/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-kmy8er/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-kmy8er/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-ewGdHy/.pi/agent/pi-subagent.json → /tmp/pi-matrix-ewGdHy/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-ewGdHy/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-ewGdHy/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-ewGdHy/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-c6GVhN/.pi/agent/pi-subagent.json → /tmp/pi-matrix-c6GVhN/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-c6GVhN/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-c6GVhN/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-c6GVhN/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-dG59SQ/.pi/agent/pi-subagent.json → /tmp/pi-matrix-dG59SQ/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-dG59SQ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-dG59SQ/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill)
[pi-subagent] settings moved: /tmp/pi-matrix-5Njrdv/.pi/agent/pi-subagent.json → /tmp/pi-matrix-5Njrdv/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-5Njrdv/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-5Njrdv/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] settings moved: /tmp/pi-matrix-U4HRkW/.pi/agent/pi-subagent.json → /tmp/pi-matrix-U4HRkW/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-U4HRkW/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-U4HRkW/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] /tmp/pi-matrix-U4HRkW/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] settings moved: /tmp/pi-matrix-ak76tZ/.pi/agent/pi-subagent.json → /tmp/pi-matrix-ak76tZ/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-ak76tZ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-ak76tZ/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope)
[pi-subagent] settings moved: /tmp/pi-matrix-va9vli/.pi/agent/pi-subagent.json → /tmp/pi-matrix-va9vli/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-va9vli/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-va9vli/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5)
[pi-subagent] settings moved: /tmp/pi-matrix-nVxuLs/.pi/agent/pi-subagent.json → /tmp/pi-matrix-nVxuLs/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-nVxuLs/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-nVxuLs/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever)
[pi-subagent] settings moved: /tmp/pi-matrix-5a6O8Z/.pi/agent/pi-subagent.json → /tmp/pi-matrix-5a6O8Z/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-5a6O8Z/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-5a6O8Z/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] settings moved: /tmp/pi-matrix-3ijO8i/.pi/agent/pi-subagent.json → /tmp/pi-matrix-3ijO8i/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-3ijO8i/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-3ijO8i/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] /tmp/pi-matrix-3ijO8i/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] settings moved: /tmp/pi-matrix-5CWpSt/.pi/agent/pi-subagent.json → /tmp/pi-matrix-5CWpSt/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-5CWpSt/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-5CWpSt/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] /tmp/pi-matrix-5CWpSt/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi
[pi-subagent] settings moved: /tmp/pi-matrix-dzZFSr/.pi/agent/pi-subagent.json → /tmp/pi-matrix-dzZFSr/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-dzZFSr/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-dzZFSr/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown
[pi-subagent] settings moved: /tmp/pi-matrix-bQbObY/.pi/agent/pi-subagent.json → /tmp/pi-matrix-bQbObY/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-bQbObY/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-bQbObY/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack
[pi-subagent] settings moved: /tmp/pi-matrix-sDL7Sl/.pi/agent/pi-subagent.json → /tmp/pi-matrix-sDL7Sl/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-sDL7Sl/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-sDL7Sl/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] settings moved: /tmp/pi-matrix-Wo7Tr7/.pi/agent/pi-subagent.json → /tmp/pi-matrix-Wo7Tr7/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-Wo7Tr7/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-Wo7Tr7/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] settings moved: /tmp/pi-matrix-GqMmrV/.pi/agent/pi-subagent.json → /tmp/pi-matrix-GqMmrV/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-GqMmrV/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-GqMmrV/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] /tmp/pi-matrix-GqMmrV/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] /tmp/pi-matrix-GqMmrV/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] 子会话 switch_context 已在本进程停用：matrix-probe（pi 运行时能力检测未通过），子会话回退为仅 pi 自动压缩。

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G11: a shut-down activation no longer toasts, and a session_start on it re-arms exactly one subscription
[pi-subagent] settings moved: /tmp/pi-matrix-xemQ81/.pi/agent/pi-subagent.json → /tmp/pi-matrix-xemQ81/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-xemQ81/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-xemQ81/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

 ✓ tests/integration/stack-teardown-matrix.test.ts (28 tests) 18554ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down 6269ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers) 799ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build 415ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build 415ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build 402ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off 744ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload) 693ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it 772ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A 365ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose 354ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose 355ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose 365ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose 355ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill) 367ms
   ✓ teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent) 396ms
   ✓ teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic) 380ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope) 379ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5) 399ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever) 360ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1) 701ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox 722ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi 357ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown 334ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack 348ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds 383ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before 459ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G11: a shut-down activation no longer toasts, and a session_start on it re-arms exactly one subscription 498ms

 Test Files  1 passed (1)
      Tests  28 passed (28)
   Start at  12:03:45
   Duration  19.11s (transform 4.44s, setup 70ms, collect 182ms, tests 18.55s, environment 0ms, prepare 51ms)

```

### 最终改动文件（含报告）Prettier 与 frozen diff — PASS

Prettier 命令同上一节的改动文件列表，另加 `docs/dev/xs-idle-wake-warning/B-report.md`。
完整日志：`/tmp/xs20-B-prettier-final.log`、`/tmp/xs20-B-frozen-final.log`。

```text
Checking formatting...
All matched files use Prettier code style!
git diff --quiet HEAD -- tests/fixtures/: exit=0
git diff --quiet origin/dev -- tests/fixtures/: exit=0
frozen A/mention/helper paths: exit=0
git diff --check: exit=0
```

## 5. 首次交付历史遗留与接受残留

1. **未完成：共享 WebHubWire facade 补丁**。root 明确禁止当前写该文件；当前 typecheck/build 失败仅 TS2339，真实 activationOn timeout 缺 marker。
2. teardown-matrix 的范围外 timer 残留：plan gate G2/G3、第一次完整 standalone G10，site 为 src/sysload/activation.ts；未改测试或源码，保留完整输出。九套件结束后第二次完整 standalone 28 tests 全绿，按环境敏感 triage 记录为 rerun-green；无相关代码或测试改动。
3. 接受的 r3 残留：live delivered 可能因 2000 扫描上限/started 推送丢失而漏记；观测口径不证明此刻未处理。
   采样后的重入/人类/goal/schedule 可使 A warning 误报；不阻断。子会话/wake-off/legacy/袋满 warning 有意漏报。
   activation still on + local wake off 的 delivered 尾句可能建议一个被明确拒绝的 activate，按 plan 接受。
4. 没有刷新 golden、git add/commit/stash/checkout/reset/restore；未执行全量测试。异源验收/任务批次提交由 root 负责。

## 6. 补丁应用后完整复跑（2026-11-05 12:18 起）

所有命令仍用 timeout、pipefail、完整 tee；没有 tail/head 截断或 npm test。
补丁前 typecheck/build/real activationOn 失败均已修复，旧日志保留，不当作本次最终结果。
共享接口还额外实际跑了 `tests/commands`（可选字段避免旧 doubles 的必填破坏；不凭 typecheck 盲区假设）。

### 真实 activate / 混合版本全文件 — PASS（18 tests）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 150 npx vitest run tests/integration/xs-idle-wake-warning-compat.test.ts tests/integration/fabric-xs-activate-session.test.ts
```

完整日志：`/tmp/xs20-B-resume-real-activate.log`；exit=0。

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/integration/fabric-xs-activate-session.test.ts (13 tests) 118ms
 ✓ tests/integration/xs-idle-wake-warning-compat.test.ts (5 tests) 36340ms
   ✓ #20 expectReply mixed-version content byte differential > old-target × new requester remains pre20 byte-identical 8091ms
   ✓ #20 expectReply mixed-version content byte differential > old-hub × new requester remains pre20 byte-identical 7806ms
   ✓ #20 real activate() freezes advice on wake setting: wake-off retains qualifying outcome but pre20 content 6906ms
   ✓ #20 real activate timeout wiring: activationOff=false 6811ms
   ✓ #20 real activate timeout wiring: activationOff=true 6725ms

 Test Files  2 passed (2)
      Tests  18 passed (18)
   Start at  12:19:24
   Duration  36.98s (transform 1.54s, setup 183ms, collect 2.14s, tests 36.46s, environment 0ms, prepare 119ms)

```

### 类型检查 — PASS

```sh
timeout 180 npm run typecheck
```

完整日志：`/tmp/xs20-B-resume-typecheck.log`；exit=0。

```text

> pi-toolkit@0.10.6 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json

```

### 构建 — PASS

```sh
timeout 180 npm run build
```

完整日志：`/tmp/xs20-B-resume-build.log`；exit=0。

```text

> pi-toolkit@0.10.6 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json && npm run build:bundle


> pi-toolkit@0.10.6 build:bundle
> node scripts/build-bundle.mjs

build:bundle ok — dist/bundle/index.js sha256=ffa87a86dfb6736a size=4.69 MB time=222 ms inputs=693
```

### plan 包 B 完整门禁 — PASS（112 files / 1946 tests；含 C-X15、三个 off golden、governance）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 420 npx vitest run tests/fabric/xs-reply-notice.test.ts tests/web-hub/agent tests/fabric/xs-progress.property.test.ts tests/integration/fabric-xs-reply.test.ts tests/integration/fabric-xs-activate-session.test.ts tests/integration/fabric-xs-activation-compat.test.ts tests/integration/xs-idle-wake-warning-compat.test.ts tests/integration/stack-teardown-matrix.test.ts tests/conformance/fabric-xs.test.ts tests/boundary tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/governance
```

完整日志：`/tmp/xs20-B-resume-plan-gate.log`；exit=0。

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/agent/builtin-bridge.test.ts (67 tests) 36ms
 ✓ tests/web-hub/agent/connection.test.ts (55 tests) 2208ms
   ✓ connection over a real unix socket (fake hub) > hub accepts but never acks ⇒ 2s disconnect; ev meanwhile is not queued 2006ms
stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down
[pi-subagent] settings moved: /tmp/pi-matrix-0KRGIo/.pi/agent/pi-subagent.json → /tmp/pi-matrix-0KRGIo/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-0KRGIo/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-0KRGIo/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers)
[pi-subagent] settings moved: /tmp/pi-matrix-KYtS0n/.pi/agent/pi-subagent.json → /tmp/pi-matrix-KYtS0n/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-KYtS0n/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-KYtS0n/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-Ka0PYF/.pi/agent/pi-subagent.json → /tmp/pi-matrix-Ka0PYF/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-Ka0PYF/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-Ka0PYF/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-Ka0PYF/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-SIyhPl/.pi/agent/pi-subagent.json → /tmp/pi-matrix-SIyhPl/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-SIyhPl/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-SIyhPl/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-SIyhPl/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] settings moved: /tmp/pi-matrix-GKm7KA/.pi/agent/pi-subagent.json → /tmp/pi-matrix-GKm7KA/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-GKm7KA/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-GKm7KA/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] /tmp/pi-matrix-GKm7KA/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] settings moved: /tmp/pi-matrix-jfUOwW/.pi/agent/pi-subagent.json → /tmp/pi-matrix-jfUOwW/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-jfUOwW/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-jfUOwW/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] /tmp/pi-matrix-jfUOwW/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] settings moved: /tmp/pi-matrix-uzKyCr/.pi/agent/pi-subagent.json → /tmp/pi-matrix-uzKyCr/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-uzKyCr/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-uzKyCr/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] /tmp/pi-matrix-uzKyCr/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] settings moved: /tmp/pi-matrix-KWRvXZ/.pi/agent/pi-subagent.json → /tmp/pi-matrix-KWRvXZ/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-KWRvXZ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-KWRvXZ/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] /tmp/pi-matrix-KWRvXZ/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] settings moved: /tmp/pi-matrix-zB3y6k/.pi/agent/pi-subagent.json → /tmp/pi-matrix-zB3y6k/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-zB3y6k/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-zB3y6k/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: ordered calls per entry (FULL profile) > path A alone (a rebuild with neither B nor C before it) also disposes the wake service through the mailbox
[pi-subagent] /tmp/pi-matrix-GCXXiA/.pi/agent/pi-subagent.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-sD7pOx/.pi/agent/pi-subagent.json → /tmp/pi-matrix-sD7pOx/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-sD7pOx/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-sD7pOx/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-sD7pOx/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-x4tcS2/.pi/agent/pi-subagent.json → /tmp/pi-matrix-x4tcS2/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-x4tcS2/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-x4tcS2/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-x4tcS2/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-y5Yvvx/.pi/agent/pi-subagent.json → /tmp/pi-matrix-y5Yvvx/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-y5Yvvx/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-y5Yvvx/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] /tmp/pi-matrix-y5Yvvx/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] settings moved: /tmp/pi-matrix-NWqKnl/.pi/agent/pi-subagent.json → /tmp/pi-matrix-NWqKnl/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-NWqKnl/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-NWqKnl/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill)
[pi-subagent] settings moved: /tmp/pi-matrix-M3e1xb/.pi/agent/pi-subagent.json → /tmp/pi-matrix-M3e1xb/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-M3e1xb/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-M3e1xb/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] settings moved: /tmp/pi-matrix-wO50BK/.pi/agent/pi-subagent.json → /tmp/pi-matrix-wO50BK/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-wO50BK/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-wO50BK/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] /tmp/pi-matrix-wO50BK/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] settings moved: /tmp/pi-matrix-ATujmJ/.pi/agent/pi-subagent.json → /tmp/pi-matrix-ATujmJ/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-ATujmJ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-ATujmJ/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "droid" (auth.json or FACTORY_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope)
[pi-subagent] settings moved: /tmp/pi-matrix-YfLMag/.pi/agent/pi-subagent.json → /tmp/pi-matrix-YfLMag/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-YfLMag/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-YfLMag/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5)
[pi-subagent] settings moved: /tmp/pi-matrix-VS3Uyt/.pi/agent/pi-subagent.json → /tmp/pi-matrix-VS3Uyt/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-VS3Uyt/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-VS3Uyt/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever)
[pi-subagent] settings moved: /tmp/pi-matrix-N6VDpe/.pi/agent/pi-subagent.json → /tmp/pi-matrix-N6VDpe/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-N6VDpe/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-N6VDpe/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] settings moved: /tmp/pi-matrix-S8DooD/.pi/agent/pi-subagent.json → /tmp/pi-matrix-S8DooD/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-S8DooD/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-S8DooD/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] /tmp/pi-matrix-S8DooD/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1)
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] settings moved: /tmp/pi-matrix-PtSmu2/.pi/agent/pi-subagent.json → /tmp/pi-matrix-PtSmu2/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-PtSmu2/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-PtSmu2/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] /tmp/pi-matrix-PtSmu2/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi
[pi-subagent] settings moved: /tmp/pi-matrix-RwMR8Z/.pi/agent/pi-subagent.json → /tmp/pi-matrix-RwMR8Z/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-RwMR8Z/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-RwMR8Z/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown
[pi-subagent] settings moved: /tmp/pi-matrix-jMVXwP/.pi/agent/pi-subagent.json → /tmp/pi-matrix-jMVXwP/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-jMVXwP/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-jMVXwP/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack
[pi-subagent] settings moved: /tmp/pi-matrix-36BCjc/.pi/agent/pi-subagent.json → /tmp/pi-matrix-36BCjc/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-36BCjc/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-36BCjc/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] settings moved: /tmp/pi-matrix-fYZc0U/.pi/agent/pi-subagent.json → /tmp/pi-matrix-fYZc0U/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-fYZc0U/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-fYZc0U/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds
[pi-subagent] [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "zai" (auth.json or ZAI_API_KEY) — provider skipped
[pi-subagent] [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] settings moved: /tmp/pi-matrix-lfhqn4/.pi/agent/pi-subagent.json → /tmp/pi-matrix-lfhqn4/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-lfhqn4/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-lfhqn4/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] /tmp/pi-matrix-lfhqn4/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] /tmp/pi-matrix-lfhqn4/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before
[pi-subagent] 子会话 switch_context 已在本进程停用：matrix-probe（pi 运行时能力检测未通过），子会话回退为仅 pi 自动压缩。

stderr | tests/integration/stack-teardown-matrix.test.ts > teardown matrix: activate-level gaps (no timers needed) > G11: a shut-down activation no longer toasts, and a session_start on it re-arms exactly one subscription
[pi-subagent] settings moved: /tmp/pi-matrix-wHPhvC/.pi/agent/pi-subagent.json → /tmp/pi-matrix-wHPhvC/.pi/agent/pi-toolkit.json (kept /tmp/pi-matrix-wHPhvC/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] /tmp/pi-matrix-wHPhvC/.pi/agent/pi-toolkit.json: time settings are now stored in seconds; migrated 2 key(s): coalesceWindowMs → coalesceWindowS (1), ackWindowMs → ackWindowS (2)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

 ✓ tests/integration/stack-teardown-matrix.test.ts (28 tests) 18745ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > startup tears nothing down 6176ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers) 817ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd new (same module): path C of the old stack, then path A in the next build 412ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd resume (same module): path C of the old stack, then path A in the next build 415ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > same-cwd fork (same module): path C of the old stack, then path A in the next build 398ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > /reload (fresh module): path C only — the new module's build has nothing to hand off 713ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload) 749ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it 757ms
   ✓ teardown matrix: ordered calls per entry (FULL profile) > a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A 391ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd new: path C then A, threads.dispose before fabric.mailbox.dispose 375ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd resume: path C then A, threads.dispose before fabric.mailbox.dispose 393ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > same-cwd fork: path C then A, threads.dispose before fabric.mailbox.dispose 385ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > path B (defensive): threads.dispose before fabric.mailbox.dispose 366ms
   ✓ teardown matrix: fabric-thread (arch r3 §9.4) — threads precede fabric on every path > quit: path C with threads before fabric (no kill) 352ms
   ✓ teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent) 386ms
   ✓ teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile) > path B disposes the external port too (between quota and dynamic) 371ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope) 402ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > every timer the stack arms is unref'd (I5) 414ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G1 FIXED: the usage broadcaster of the outgoing stack stops ticking at shutdown (it used to emit 1 Hz on the OLD pi forever) 366ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G2/G3 FIXED: buffered hold-windows are discarded at shutdown (nothing sent through the OLD pi) and the NEXT session redelivers the persisted records (I1) 758ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G10 FIXED: a notifier retry pending at shutdown is cancelled (no more sends through the OLD pi) and the NEXT session redelivers it from the outbox 740ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > G9 FIXED: the /goal delivery watchdog is cancelled at shutdown and no longer talks through the OLD pi 376ms
   ✓ teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown) > GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown 359ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G8 FIXED: session_shutdown clears holder.current — a late holder-routed tool call fails loudly instead of being answered by the dead stack 348ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G8: a second shutdown on the same activation (nothing left to tear down) is a no-op, and the next session_start rebuilds 453ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > GAP-G11 fixed: one disabling event toasts once, on the newest activation, however many reloads came before 438ms
   ✓ teardown matrix: activate-level gaps (no timers needed) > G11: a shut-down activation no longer toasts, and a session_start on it re-arms exactly one subscription 458ms
 ✓ tests/web-hub/agent/wiring-control.test.ts (47 tests) 1733ms
   ✓ wireWebHub — caps broadcast (§3.1/D10) > web-hub-upload plan §5.1: webHub.uploads → upload.v1/upload.lan.v1 caps > uploads:"on" (also the default/unset) advertises both upload.v1 and upload.lan.v1 526ms
 ✓ tests/web-hub/agent/wiring.test.ts (26 tests) 233ms
 ✓ tests/web-hub/agent/capture-commands.test.ts (37 tests) 30ms
 ✓ tests/web-hub/agent/wiring-hold.test.ts (19 tests) 393ms
 ✓ tests/web-hub/agent/commands.test.ts (54 tests) 43ms
 ✓ tests/web-hub/agent/hold-driver.test.ts (51 tests) 631ms
stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X2: compaction >30s rejects throughout; cancellation emits compact_failed and opens only that window
[pi-subagent] fabric fence stuck: compaction open 30s — still rejecting cross-session deliveries; /fabric fence reset to clear (local only)

stdout | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X6: phase-1 C-P1–C-P5 remain green
C-X6 delegated real-pi gates:

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/conformance/fabric-wake.test.ts (8 tests) 406ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  12:21:20
   Duration  4.10s (transform 2.13s, setup 71ms, collect 3.37s, tests 406ms, environment 0ms, prepare 51ms)



stdout | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X7: record pi's duplicate-tool arbitration without depending on the winner
C-X7 observed arbitration (record-only): {"visible":["Send a message to another joined main session on this machine's web hub (fabric cross-session; the recipient sees it as untrusted input). Reply to an incoming cross-session message by messaging its from.ref. effect \"applied\" = delivery confirmed; \"none\" = provably NOT delivered (safe to retry later); \"unknown\" = the message may have entered the recipient's queue — it usually becomes visible at the recipient's next turn boundary; do NOT blindly resend."],"executed":[],"toolResults":[{"type":"message","id":"7d3a613d","parentId":"1134922a","timestamp":"2026-11-05T04:21:25.033Z","message":{"role":"toolResult","toolCallId":"stub-tool-0-message_session","toolName":"message_session","content":[{"type":"text","text":"{\"status\":\"origin_changed\",\"effect\":\"none\",\"reason\":\"origin_changed\"}"}],"details":{"status":"origin_changed","effect":"none","reason":"origin_changed"},"isError":false,"durationMs":1,"timestamp":1793852485033}}],"errors":[]}

stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X12b: no BAS at all ⇒ first context sight aborts with ZERO provider requests; absent + supervised
[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only

stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X14b: a host that loses the custom shape (no BAS) aborts the marker before the provider; the body is not re-sent as a fallback
[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only

 ✓ tests/conformance/fabric-xs.test.ts (27 tests) 46471ms
   ✓ fabric phase-2 real pi contracts > C-X1b: pre-start compaction >10s remains owned, starts with token and deadline aborts the slow provider 10142ms
   ✓ fabric phase-2 real pi contracts > C-X2: compaction >30s rejects throughout; cancellation emits compact_failed and opens only that window 30097ms
   ✓ fabric phase-2 real pi contracts > C-X6: phase-1 C-P1–C-P5 remain green 4539ms
 ✓ tests/web-hub/agent/resume-exec.test.ts (29 tests) 89ms
 ✓ tests/web-hub/agent/command-capture-recorder.test.ts (19 tests) 33ms
 ✓ tests/web-hub/agent/run-transcript.test.ts (34 tests) 41ms
 ✓ tests/web-hub/agent/xs-alias-auto.test.ts (22 tests) 72ms
 ✓ tests/web-hub/agent/commands-hold.test.ts (27 tests) 37ms
 ✓ tests/integration/fabric-xs-activate-session.test.ts (13 tests) 85ms
 ✓ tests/web-hub/agent/snapshot.test.ts (21 tests) 1964ms
   ✓ buildBranchReply — lazy reverse projection ≡ legacy project-all-then-trim > is byte-identical to the legacy implementation over 200 seeded branches × 5 budgets 1882ms
 ✓ tests/web-hub/agent/worktree-sampler.test.ts (20 tests) 529ms
   ✓ createWorktreeSampler — ★ hard deadline (merge gate) > ★ real executor + a SIGTERM-ignoring fake git script: the deadline's abort settles the underlying call well under hardDeadlineMs + 250ms, and the process group is actually dead afterward 508ms
 ✓ tests/web-hub/agent/prompt-gate.test.ts (27 tests) 29ms
 ✓ tests/web-hub/agent/quota-sampler.test.ts (37 tests) 19ms
 ✓ tests/web-hub/agent/ledger.test.ts (48 tests) 46ms
 ✓ tests/web-hub/agent/bash-jobs-projection.test.ts (24 tests) 688ms
   ✓ archive-aware omitted (2026-10-28) > INVARIANT (seeded sweep): omittedTerminalJobIds ≡ omitted (cap + byte ladder); ids are terminal, unarchived, off-wire 662ms
 ✓ tests/web-hub/agent/wiring-resume.test.ts (9 tests) 209ms
 ✓ tests/web-hub/agent/command-record.test.ts (36 tests) 24ms
 ✓ tests/fabric/xs-progress.property.test.ts (13 tests) 1946ms
   ✓ xs progress — merge lattice (property) > random out-of-order / duplicate / late / stale-revision writes never regress a fact 1432ms
   ✓ xs progress — activation claims (property) > claim state machine matches the spec across random ops (idempotent consume, at-most-once) 407ms
 ✓ tests/web-hub/agent/xs-state-bridge.test.ts (22 tests) 37ms
 ✓ tests/fabric/xs-reply-notice.test.ts (24 tests) 24ms
 ✓ tests/web-hub/agent/feishu-admin.test.ts (30 tests) 35ms
 ✓ tests/web-hub/agent/event-tap.test.ts (21 tests) 18ms
 ✓ tests/web-hub/agent/bash-jobs-sampler.test.ts (16 tests) 40ms
 ✓ tests/web-hub/agent/commands-archive.test.ts (15 tests) 70ms
 ✓ tests/integration/fabric-xs-reply.test.ts (15 tests) 86477ms
   ✓ RXW reply association (real hub × real stacks) > #1 round trip: expectReply+wake ⇒ B header carries reply_to ⇒ B replyTo ⇒ A is woken 4435ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, quiet path: two due tickets of one session merge into ONE notice and clear owed 4637ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, wake path: a primed requester is woken by its own timeout notice 4490ms
   ✓ RXW reply association (real hub × real stacks) > #3a leave before due ⇒ nothing is written; at lateUntil the notice is dropped and counted 4768ms
   ✓ RXW reply association (real hub × real stacks) > #3b compaction window at due time ⇒ no write; the fence-close event replays the owed notice 4712ms
   ✓ RXW reply association (real hub × real stacks) > #3c slow session_before_switch ⇒ no write; a cancelled switch is closed by fence reset, then it flushes 4712ms
   ✓ RXW reply association (real hub × real stacks) > #3d switch away before due, due while away, switch back ⇒ owed notice appears on restore 4573ms
   ✓ RXW reply association (real hub × real stacks) > #3e expiring entirely while away ⇒ one quiet summary on switch back 4625ms
   ✓ RXW reply association (real hub × real stacks) > #4 receive=replies: unsolicited traffic is refused (hub early + injected bypass); a valid reply wakes 6791ms
   ✓ RXW reply association (real hub × real stacks) > #5 late: inside the grace window a reply is delivered without waking; past it the reply is refused 4615ms
   ✓ RXW reply association (real hub × real stacks) > #6 Blocker counterexample: duplicate reply after consumption (and after /tree) stays refused 4527ms
   ✓ RXW reply association (real hub × real stacks) > #7 /reload keeps the credential; a simulated pi restart refuses it with ONE invalidation notice 6999ms
   ✓ RXW reply association (real hub × real stacks) > #8 address pinning: a name rebound between resolve and send never reaches the new holder 6949ms
   ✓ RXW reply association (real hub × real stacks) > #9a old hub without the reply cap: expectReply is refused without a frame; receive=replies degrades to off 6929ms
   ✓ RXW reply association (real hub × real stacks) > #9b old recipient (reply disabled) is refused without delivery; hub restart mid-reply ⇒ unknown ⇒ resend delivers at most once 12712ms
 ✓ tests/web-hub/agent/xs-client.test.ts (24 tests) 38ms
 ✓ tests/web-hub/agent/xs-alias.test.ts (16 tests) 50ms
 ✓ tests/web-hub/agent/cache-keepalive-projection.test.ts (33 tests) 21ms
 ✓ tests/web-hub/agent/steer-queue-drop.test.ts (11 tests) 19ms
 ✓ tests/web-hub/agent/command-complete.test.ts (20 tests) 15ms
 ✓ tests/web-hub/agent/command-policy.test.ts (67 tests) 18ms
 ✓ tests/web-hub/agent/todo-projection.test.ts (18 tests) 24ms
 ✓ tests/web-hub/agent/resume-list.test.ts (16 tests) 97ms
 ✓ tests/web-hub/agent/restart.test.ts (21 tests) 30ms
 ✓ tests/web-hub/agent/wiring-lan.test.ts (17 tests) 149ms
 ✓ tests/web-hub/agent/extension-async-late.test.ts (6 tests) 16ms
 ✓ tests/integration/fabric-xs-reply-off-golden.test.ts (2 tests) 36ms
 ✓ tests/web-hub/agent/admin-cmds.test.ts (16 tests) 50ms
 ✓ tests/web-hub/agent/hold.test.ts (31 tests) 17ms
 ✓ tests/web-hub/agent/passwd-prompt.test.ts (43 tests) 26ms
 ✓ tests/web-hub/agent/commands-mention-session.test.ts (9 tests) 20ms
 ✓ tests/web-hub/agent/queue-mirror.test.ts (22 tests) 13ms
 ✓ tests/integration/fabric-xs-off-golden.test.ts (3 tests) 73ms
 ✓ tests/web-hub/agent/lan-status.test.ts (31 tests) 13ms
 ✓ tests/web-hub/agent/dialogs.test.ts (12 tests) 12ms
 ✓ tests/web-hub/agent/run-transcript-tail.test.ts (8 tests) 92ms
 ✓ tests/web-hub/agent/steer-late.test.ts (10 tests) 16ms
 ✓ tests/web-hub/agent/launcher.test.ts (20 tests) 25ms
 ✓ tests/web-hub/agent/real-command-matrix.test.ts (3 tests) 20ms
 ✓ tests/web-hub/agent/xs-member-slot.test.ts (12 tests) 25ms
 ✓ tests/web-hub/agent/worktrees-projection.test.ts (14 tests) 99ms
 ✓ tests/web-hub/agent/resume-list-bounds.test.ts (10 tests) 1968ms
   ✓ resume-list bounds — seeded property (§4 P2 list) > stops at 2000 rows and reports truncated 472ms
   ✓ resume-list bounds — seeded property (§4 P2 list) > flags partial when the 64 MiB read budget is exhausted 412ms
   ✓ resume-list bounds — seeded property (§4 P2 list) > caps candidate files at 5 000 newest-first and reports truncated 921ms
 ✓ tests/web-hub/agent/xs-legacy-hub.test.ts (10 tests) 24ms
 ✓ tests/web-hub/agent/redact.test.ts (57 tests) 81ms
 ✓ tests/web-hub/agent/wiring-restart.test.ts (12 tests) 97ms
 ✓ tests/web-hub/agent/wiring-cmd-args.test.ts (7 tests) 37ms
 ✓ tests/boundary/pi-free.test.ts (30 tests) 565ms
 ✓ tests/web-hub/agent/tool-timing.test.ts (9 tests) 70ms
 ✓ tests/integration/fabric-wake-off-golden.test.ts (2 tests) 22ms
stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold
[bundle-parity] src-hot: median=10778ms range=10490–11205ms samples=[11205, 10490, 10778, 10681, 10802]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget
[bundle-parity] bundle-hot: median=920ms range=901–956ms samples=[909, 934, 901, 920, 956]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline
[bundle-parity] dispatcher-hot: median=910ms range=886–929ms samples=[916, 910, 886, 906, 929]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold
[bundle-parity] bundle-cold: median=964ms range=912–964ms samples=[964, 912]; src-cold: median=25159ms range=10449–25159ms samples=[25159, 10449]; dispatcher-cold: median=1171ms range=891–1171ms samples=[1171, 891]

 ✓ tests/governance/bundle-parity.test.ts (28 tests) 145763ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > syntactically broken bundle ⇒ exactly one error, zero tools — never a silent source fallback 495ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > bundle that throws at load time ⇒ one error carrying the message, zero tools 474ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > no bundle at all (git-install shape) ⇒ zero errors, the SOURCE path comes up with the real tool set 25272ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > host modules unresolvable ⇒ loud failure naming the pinning, not a partial redirect or a fallback 495ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold 54267ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget 4927ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline 4843ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold 39948ms
 ✓ tests/web-hub/agent/slash.test.ts (21 tests) 15ms
 ✓ tests/web-hub/agent/wiring-quota-pools.test.ts (7 tests) 82ms
 ✓ tests/web-hub/agent/commands-resume.test.ts (5 tests) 13ms
 ✓ tests/web-hub/agent/wiring-private-ns.test.ts (7 tests) 46ms
 ✓ tests/web-hub/agent/resume-open-discipline.test.ts (5 tests) 31ms
 ✓ tests/web-hub/agent/wiring-todo-archive.test.ts (7 tests) 78ms
 ✓ tests/web-hub/agent/xs-web-command.test.ts (15 tests) 20ms
 ✓ tests/web-hub/agent/wiring-proxy.test.ts (12 tests) 39ms
 ✓ tests/web-hub/agent/connection-admin.test.ts (15 tests) 27ms
 ✓ tests/web-hub/agent/hold-faults.test.ts (8 tests) 11ms
 ✓ tests/web-hub/agent/wiring-cache-keepalive.test.ts (8 tests) 77ms
stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-FLiTea/.pi/agent/pi-subagent.json → /tmp/pi-trace-FLiTea/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-FLiTea/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-x8wajR/.pi/agent/pi-subagent.json → /tmp/pi-trace-x8wajR/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-x8wajR/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-Qy8khz/.pi/agent/pi-subagent.json → /tmp/pi-trace-Qy8khz/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-Qy8khz/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-SpCnTo/.pi/agent/pi-subagent.json → /tmp/pi-trace-SpCnTo/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-SpCnTo/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-phSsmj/.pi/agent/pi-subagent.json → /tmp/pi-trace-phSsmj/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-phSsmj/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-USa1ok/.pi/agent/pi-subagent.json → /tmp/pi-trace-USa1ok/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-USa1ok/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-o2Uq8L/.pi/agent/pi-subagent.json → /tmp/pi-trace-o2Uq8L/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-o2Uq8L/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-pfZIHM/.pi/agent/pi-subagent.json → /tmp/pi-trace-pfZIHM/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-pfZIHM/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-7t2eAA/.pi/agent/pi-subagent.json → /tmp/pi-trace-7t2eAA/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-7t2eAA/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-caSxbP/.pi/agent/pi-subagent.json → /tmp/pi-trace-caSxbP/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-caSxbP/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-AgpFZR/.pi/agent/pi-subagent.json → /tmp/pi-trace-AgpFZR/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-AgpFZR/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-QgbG0a/.pi/agent/pi-subagent.json → /tmp/pi-trace-QgbG0a/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-QgbG0a/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-GKw7n4/.pi/agent/pi-subagent.json → /tmp/pi-trace-GKw7n4/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-GKw7n4/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-sbgohy/.pi/agent/pi-subagent.json → /tmp/pi-trace-sbgohy/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-sbgohy/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-APtC1Y/.pi/agent/pi-subagent.json → /tmp/pi-trace-APtC1Y/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-APtC1Y/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > compat-failure ends with the stub tool and never reaches post-guard wiring
[pi-subagent] settings moved: /tmp/pi-trace-jV6N8O/.pi/agent/pi-subagent.json → /tmp/pi-trace-jV6N8O/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-jV6N8O/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > fabric-thread arch §9.3 (P3): thread-main registers `thread` right after the fabric tool group; thread-child gains no registration
[pi-subagent] settings moved: /tmp/pi-trace-LTT4dP/.pi/agent/pi-subagent.json → /tmp/pi-trace-LTT4dP/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-LTT4dP/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

 ✓ tests/governance/activate-trace.test.ts (4 tests) 512ms
 ✓ tests/web-hub/agent/lan-status-security.test.ts (22 tests) 11ms
 ✓ tests/web-hub/agent/wiring-spawn.test.ts (4 tests) 32ms
 ✓ tests/web-hub/agent/commands-input-handled.test.ts (6 tests) 11ms
 ✓ tests/web-hub/agent/models-projection.test.ts (9 tests) 687ms
   ✓ projectModels > keeps every generated wire inside the open bounded schema 610ms
 ✓ tests/web-hub/agent/commands-prompt-fabric.test.ts (20 tests) 22ms
 ✓ tests/web-hub/agent/wiring-models.test.ts (6 tests) 99ms
 ✓ tests/web-hub/agent/proc-identity.test.ts (19 tests) 9ms
 ✓ tests/web-hub/agent/origin-entry.test.ts (13 tests) 11ms
 ✓ tests/web-hub/agent/cmd-args-status.test.ts (9 tests) 27ms
 ✓ tests/boundary/result-tool-residue.test.ts (4 tests) 5ms
 ✓ tests/web-hub/agent/wiring-preview.test.ts (7 tests) 30ms
 ✓ tests/web-hub/agent/compaction-state.test.ts (11 tests) 10ms
 ✓ tests/web-hub/agent/wiring-thread-rebind.test.ts (6 tests) 33ms
 ✓ tests/web-hub/agent/ui-status.test.ts (9 tests) 6ms
 ✓ tests/web-hub/agent/xs-activate-bridge.test.ts (6 tests) 15ms
 ✓ tests/web-hub/agent/command-usage.test.ts (17 tests) 9ms
stderr | tests/web-hub/agent/input-order.test.ts > web-hub's input observer registers last (plan §4.1) > exactly one new 'input' handler appears when webHub.enabled flips on, at the tail of the array
[pi-subagent] settings moved: /tmp/pi-toolkit-home-v7A43U/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-v7A43U/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-v7A43U/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context
[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context

 ✓ tests/web-hub/agent/input-order.test.ts (1 test) 61ms
 ✓ tests/integration/xs-idle-wake-warning-compat.test.ts (5 tests) 35265ms
   ✓ #20 expectReply mixed-version content byte differential > old-target × new requester remains pre20 byte-identical 6997ms
   ✓ #20 expectReply mixed-version content byte differential > old-hub × new requester remains pre20 byte-identical 6971ms
   ✓ #20 real activate() freezes advice on wake setting: wake-off retains qualifying outcome but pre20 content 7019ms
   ✓ #20 real activate timeout wiring: activationOff=false 7032ms
   ✓ #20 real activate timeout wiring: activationOff=true 7245ms
 ✓ tests/web-hub/agent/status.test.ts (6 tests) 7ms
 ✓ tests/web-hub/agent/status-xs-inbox.test.ts (10 tests) 15ms
 ✓ tests/web-hub/agent/status-slot-flush.test.ts (1 test) 12ms
 ✓ tests/web-hub/agent/wiring-feishu.test.ts (5 tests) 30ms
 ✓ tests/web-hub/agent/agent-dir-status.test.ts (13 tests) 29ms
 ✓ tests/web-hub/agent/command-policy-fabric.test.ts (6 tests) 5ms
 ✓ tests/web-hub/agent/hold.property.test.ts (6 tests) 45ms
 ✓ tests/web-hub/agent/status-slots-bash-archive.test.ts (3 tests) 9ms
 ✓ tests/web-hub/agent/proxy-status.test.ts (6 tests) 6ms
 ✓ tests/web-hub/agent/cmd-history-status.test.ts (5 tests) 5ms
 ✓ tests/web-hub/agent/launch-home.test.ts (2 tests) 20ms
 ✓ tests/web-hub/agent/privacy-status.test.ts (5 tests) 5ms
 ✓ tests/web-hub/agent/proxy-status-allowlist.test.ts (3 tests) 3ms
 ✓ tests/integration/fabric-xs-activation-compat.test.ts (1 test) 41979ms
   ✓ fabric-xs-activation mixed versions (I10) > every combination delivers the body once; only new×new×new adds tracking, and old-side combos stay on the legacy byte shape 41978ms
 ✓ tests/web-hub/agent/alias-status.test.ts (3 tests) 4ms

 Test Files  112 passed (112)
      Tests  1946 passed (1946)
   Start at  12:20:37
   Duration  235.82s (transform 6.59s, setup 1.55s, collect 30.81s, tests 392.14s, environment 20ms, prepare 5.95s)

```

### 共享接口附加 commands 回归 — PASS（20 files / 384 tests）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 150 npx vitest run tests/commands
```

完整日志：`/tmp/xs20-B-resume-commands.log`；exit=0。

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/commands/fabric-xs-alias.test.ts (73 tests) 59ms
stderr | tests/commands/fabric-xs.test.ts > /fabric: membership commands > fence reset clears a stuck window (local only — web is gated above)
[pi-subagent] fabric fence stuck: tree open 30s — still rejecting cross-session deliveries; /fabric fence reset to clear (local only)

 ✓ tests/commands/fabric-xs.test.ts (37 tests) 28ms
 ✓ tests/commands/webhub-feishu.test.ts (28 tests) 33ms
 ✓ tests/commands/status.test.ts (67 tests) 58ms
 ✓ tests/commands/webhub-2fa.test.ts (26 tests) 28ms
 ✓ tests/commands/capture.test.ts (19 tests) 20ms
 ✓ tests/commands/schedule.test.ts (26 tests) 592ms
 ✓ tests/commands/webhub.test.ts (26 tests) 14ms
 ✓ tests/commands/webhub-lan.test.ts (21 tests) 20ms
 ✓ tests/commands/task.test.ts (14 tests) 15ms
 ✓ tests/commands/webhub-private-ns.test.ts (7 tests) 9ms
 ✓ tests/commands/status-unpriced.test.ts (7 tests) 6ms
 ✓ tests/commands/status-xs.test.ts (4 tests) 7ms
 ✓ tests/commands/webhub-user.test.ts (9 tests) 13ms
 ✓ tests/commands/qr-render.test.ts (7 tests) 11ms
 ✓ tests/commands/webhub-cmd-history.test.ts (3 tests) 5ms
 ✓ tests/commands/fabric-xs-progress.test.ts (4 tests) 6ms
 ✓ tests/commands/webhub-proxy.test.ts (2 tests) 5ms
 ✓ tests/commands/status-thread.test.ts (2 tests) 4ms
 ✓ tests/commands/status-wake.test.ts (2 tests) 4ms

 Test Files  20 passed (20)
      Tests  384 passed (384)
   Start at  12:25:37
   Duration  8.53s (transform 2.06s, setup 391ms, collect 10.58s, tests 936ms, environment 3ms, prepare 1.06s)

```

### HEAD fixtures / 冻结面检查 — PASS（origin 差分见说明）

```sh
git diff --quiet HEAD -- tests/fixtures/
git diff --quiet origin/dev -- tests/fixtures/
git diff --quiet HEAD -- tests/mention/ src/tools/message-session-tool.ts tests/tools/message-session-tool.test.ts tests/fabric/xs-receiver.test.ts tests/integration/helpers/fabric-xs-process.ts
git diff --check
```

完整日志：`/tmp/xs20-B-resume-frozen.log`。

```text
git diff --quiet HEAD -- tests/fixtures/: exit=0
git diff --quiet origin/dev -- tests/fixtures/: exit=1
frozen A/mention/helper paths: exit=0
git diff --check: exit=0
```

origin/dev diff exit=1 的唯一项是 #23 P-B 已提交的新增 `tests/fixtures/web-hub/epoch-up-compat-golden.json`。
本包从未编辑该 fixture；用户本轮要求的 `git diff --quiet HEAD -- tests/fixtures/` exit=0；三个原 A 级 off golden 行为测试亦全绿。
plan 本次 teardown-matrix 28 tests 直接全绿，没有出现 sysload timer 残留，因此不额外重复 Tier2 rerun。

### 广域门禁 — PASS（76 files / 1183 tests；含 mention、C-X15、三个 off golden、governance）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 360 npx vitest run tests/fabric tests/conformance/fabric-xs.test.ts tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/governance tests/mention
```

完整日志：`/tmp/xs20-B-resume-broad-gate.log`；exit=0。

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/fabric/root-wake.test.ts (68 tests) 55ms
stderr | tests/fabric/threads-settings.test.ts > fabric.threads settings (P0 §11.1) > P4 §8.2 ③: a window clamp marks windowClamped (the ` · cfg clamped` suffix source)
[pi-subagent] fabric.threads.retainMin 5 → 12 (must be ≥ max(handbackWindowMin, startTimeoutMin)+2)
[pi-subagent] fabric.threads.handbackWindowMin 0 → 1 (below min 1)
[pi-subagent] fabric.threads.startTimeoutMin 40 → 30 (above max 30)
[pi-subagent] fabric.threads.retainMin 15 → 32 (must be ≥ max(handbackWindowMin, startTimeoutMin)+2)

 ✓ tests/fabric/threads-settings.test.ts (48 tests) 109ms
 ✓ tests/fabric/xs-sender.test.ts (67 tests) 41ms
 ✓ tests/fabric/xs-receiver.test.ts (50 tests) 36ms
 ✓ tests/fabric/xs-reply-ledger.test.ts (29 tests) 33ms
stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X2: compaction >30s rejects throughout; cancellation emits compact_failed and opens only that window
[pi-subagent] fabric fence stuck: compaction open 30s — still rejecting cross-session deliveries; /fabric fence reset to clear (local only)

stdout | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X6: phase-1 C-P1–C-P5 remain green
C-X6 delegated real-pi gates:

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/conformance/fabric-wake.test.ts (8 tests) 490ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  12:25:17
   Duration  4.41s (transform 2.26s, setup 70ms, collect 3.57s, tests 490ms, environment 0ms, prepare 59ms)



stdout | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X7: record pi's duplicate-tool arbitration without depending on the winner
C-X7 observed arbitration (record-only): {"visible":["Send a message to another joined main session on this machine's web hub (fabric cross-session; the recipient sees it as untrusted input). Reply to an incoming cross-session message by messaging its from.ref. effect \"applied\" = delivery confirmed; \"none\" = provably NOT delivered (safe to retry later); \"unknown\" = the message may have entered the recipient's queue — it usually becomes visible at the recipient's next turn boundary; do NOT blindly resend."],"executed":[],"toolResults":[{"type":"message","id":"f875b03c","parentId":"b7cb8921","timestamp":"2026-11-05T04:25:21.844Z","message":{"role":"toolResult","toolCallId":"stub-tool-0-message_session","toolName":"message_session","content":[{"type":"text","text":"{\"status\":\"origin_changed\",\"effect\":\"none\",\"reason\":\"origin_changed\"}"}],"details":{"status":"origin_changed","effect":"none","reason":"origin_changed"},"isError":false,"durationMs":1,"timestamp":1793852721844}}],"errors":[]}

stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X12b: no BAS at all ⇒ first context sight aborts with ZERO provider requests; absent + supervised
[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only

stderr | tests/conformance/fabric-xs.test.ts > fabric phase-2 real pi contracts > C-X14b: a host that loses the custom shape (no BAS) aborts the marker before the provider; the body is not re-sent as a fallback
[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only

 ✓ tests/conformance/fabric-xs.test.ts (27 tests) 46825ms
   ✓ fabric phase-2 real pi contracts > C-X1b: pre-start compaction >10s remains owned, starts with token and deadline aborts the slow provider 10141ms
   ✓ fabric phase-2 real pi contracts > C-X2: compaction >30s rejects throughout; cancellation emits compact_failed and opens only that window 30105ms
   ✓ fabric phase-2 real pi contracts > C-X6: phase-1 C-P1–C-P5 remain green 4874ms
 ✓ tests/fabric/xs-channel-ch3.test.ts (25 tests) 31ms
stderr | tests/fabric/wake.test.ts > W3 reservation admission / ownership transfer > failed trigger claim restoration quarantines rather than returning a deliverable record
[pi-subagent] fabric inbox reservation_quarantined key=r_SENDER01:r_TARGET01:1:1 run=unknown

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > ② accepted then crash: journal-only (even with acceptance) is never retried
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > terminal attempted without acceptance
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > ⑤ 60s timeout rechecks once; still no terminal even if live => audited consume, no rearm
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > an accepted journal on a live session does NOT cause a 1ms recovery spin
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

stderr | tests/fabric/wake.test.ts > W3 five crash windows and recovery disposition > a rollback-failed reservation survives reload without the memory-only quarantine flag, then consumes as ambiguous
[pi-subagent] fabric inbox resume_unverified key=r_SENDER01:r_TARGET01:1:1 run=r_RESUME01

 ✓ tests/fabric/wake.test.ts (40 tests) 44ms
 ✓ tests/fabric/root-wake.property.test.ts (2 tests) 1042ms
   ✓ RootWakeController random event invariants > single owner, occupied states supervised, at-most-once abort, zero abort after handover 638ms
   ✓ wake-unknown-optimistic random event invariants > optimistic first-run: per-token ≤1 abort/audit, dead optimistic tokens never hop, capability monotone 403ms
 ✓ tests/fabric/thread/engine.test.ts (29 tests) 26ms
 ✓ tests/fabric/xs-progress.property.test.ts (13 tests) 2195ms
   ✓ xs progress — merge lattice (property) > random out-of-order / duplicate / late / stale-revision writes never regress a fact 1658ms
   ✓ xs progress — activation claims (property) > claim state machine matches the spec across random ops (idempotent consume, at-most-once) 429ms
 ✓ tests/fabric/xs-reply-notice.test.ts (24 tests) 21ms
 ✓ tests/fabric/revive.test.ts (66 tests) 54ms
 ✓ tests/fabric/xs-truth-table.test.ts (34 tests) 30ms
 ✓ tests/mention/session.test.ts (25 tests) 21ms
 ✓ tests/fabric/successor.test.ts (17 tests) 52ms
 ✓ tests/mention/mention.test.ts (20 tests) 16ms
 ✓ tests/fabric/xs-fence.test.ts (25 tests) 17ms
 ✓ tests/fabric/xs-session-activation.test.ts (15 tests) 21ms
 ✓ tests/fabric/router.test.ts (15 tests) 17ms
 ✓ tests/fabric/mailbox.test.ts (16 tests) 20ms
 ✓ tests/fabric/wake-result.test.ts (18 tests) 34ms
 ✓ tests/fabric/xs-reply-receiver.property.test.ts (2 tests) 229ms
 ✓ tests/integration/fabric-xs-reply-off-golden.test.ts (2 tests) 38ms
 ✓ tests/fabric/xs-reply-ledger.property.test.ts (2 tests) 181ms
 ✓ tests/fabric/xs-human-grant.test.ts (20 tests) 19ms
 ✓ tests/fabric/thread/engine.property.test.ts (2 tests) 336ms
   ✓ ThreadEngine seeded property invariants (§11.1 P1) > dedup · at-most-once auto-return · no auto-return over called steers — random op streams 334ms
 ✓ tests/fabric/xs-sender-channel.test.ts (20 tests) 15ms
 ✓ tests/integration/fabric-xs-off-golden.test.ts (3 tests) 73ms
 ✓ tests/fabric/thread/rebind.test.ts (14 tests) 13ms
 ✓ tests/mention/session-off.test.ts (5 tests) 18ms
 ✓ tests/fabric/xs-sender-human-grant.test.ts (26 tests) 23ms
 ✓ tests/fabric/xs-level.test.ts (12 tests) 14ms
 ✓ tests/fabric/thread/subscriptions.test.ts (9 tests) 10ms
 ✓ tests/mention/autocomplete.test.ts (11 tests) 298ms
 ✓ tests/fabric/xs-directory.test.ts (13 tests) 31ms
 ✓ tests/fabric/xs-stack-progress.test.ts (7 tests) 14ms
 ✓ tests/integration/fabric-wake-off-golden.test.ts (2 tests) 22ms
 ✓ tests/fabric/mention.test.ts (14 tests) 16ms
 ✓ tests/mention/autocomplete-session.test.ts (10 tests) 8ms
 ✓ tests/fabric/wake-level.test.ts (20 tests) 11ms
 ✓ tests/fabric/router-wake.test.ts (10 tests) 12ms
 ✓ tests/fabric/xs-unread.test.ts (21 tests) 2470ms
   ✓ property: random event sequences > bounded, per-session isolated, and any entry is cleared once a later-started turn completes 2457ms
 ✓ tests/fabric/xs-inbox.test.ts (10 tests) 8ms
stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-OJEmuy/.pi/agent/pi-subagent.json → /tmp/pi-trace-OJEmuy/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-OJEmuy/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-OVOZJS/.pi/agent/pi-subagent.json → /tmp/pi-trace-OVOZJS/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-OVOZJS/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-HyYfwP/.pi/agent/pi-subagent.json → /tmp/pi-trace-HyYfwP/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-HyYfwP/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-N5vSJY/.pi/agent/pi-subagent.json → /tmp/pi-trace-N5vSJY/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-N5vSJY/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-0dWJJc/.pi/agent/pi-subagent.json → /tmp/pi-trace-0dWJJc/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-0dWJJc/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-Psx0Ht/.pi/agent/pi-subagent.json → /tmp/pi-trace-Psx0Ht/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-Psx0Ht/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-RoYWRM/.pi/agent/pi-subagent.json → /tmp/pi-trace-RoYWRM/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-RoYWRM/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-ftqwMZ/.pi/agent/pi-subagent.json → /tmp/pi-trace-ftqwMZ/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-ftqwMZ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-PeWWPg/.pi/agent/pi-subagent.json → /tmp/pi-trace-PeWWPg/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-PeWWPg/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-ySvOGX/.pi/agent/pi-subagent.json → /tmp/pi-trace-ySvOGX/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-ySvOGX/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-oG79FD/.pi/agent/pi-subagent.json → /tmp/pi-trace-oG79FD/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-oG79FD/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-N9cYGI/.pi/agent/pi-subagent.json → /tmp/pi-trace-N9cYGI/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-N9cYGI/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-Pw58t3/.pi/agent/pi-subagent.json → /tmp/pi-trace-Pw58t3/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-Pw58t3/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-eyuv3Q/.pi/agent/pi-subagent.json → /tmp/pi-trace-eyuv3Q/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-eyuv3Q/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-X3xm5i/.pi/agent/pi-subagent.json → /tmp/pi-trace-X3xm5i/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-X3xm5i/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > compat-failure ends with the stub tool and never reaches post-guard wiring
[pi-subagent] settings moved: /tmp/pi-trace-omlqsW/.pi/agent/pi-subagent.json → /tmp/pi-trace-omlqsW/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-omlqsW/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > fabric-thread arch §9.3 (P3): thread-main registers `thread` right after the fabric tool group; thread-child gains no registration
[pi-subagent] settings moved: /tmp/pi-trace-gKFGtY/.pi/agent/pi-subagent.json → /tmp/pi-trace-gKFGtY/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-gKFGtY/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

 ✓ tests/governance/activate-trace.test.ts (4 tests) 516ms
 ✓ tests/fabric/xs-receiver-progress.test.ts (8 tests) 10ms
 ✓ tests/fabric/xs-sender-alias.test.ts (11 tests) 10ms
 ✓ tests/mention/session-alias.test.ts (13 tests) 28ms
 ✓ tests/fabric/xs-channel.test.ts (47 tests) 14ms
 ✓ tests/fabric/thread/directory.test.ts (10 tests) 6ms
 ✓ tests/fabric/xs-wake-ledger.test.ts (12 tests) 10ms
 ✓ tests/fabric/xs-alias-auto.test.ts (9 tests) 29ms
 ✓ tests/fabric/wake-observability.test.ts (8 tests) 16ms
 ✓ tests/fabric/thread/records.test.ts (7 tests) 6ms
 ✓ tests/fabric/xs-membership-handoff.test.ts (5 tests) 7ms
 ✓ tests/mention/notes.test.ts (9 tests) 5ms
 ✓ tests/fabric/thread/decision.test.ts (8 tests) 6ms
 ✓ tests/fabric/xs-alias-format.test.ts (7 tests) 10ms
 ✓ tests/fabric/thread/outcome.test.ts (8 tests) 6ms
 ✓ tests/fabric/thread/lane.test.ts (8 tests) 6ms
 ✓ tests/fabric/format-fence.test.ts (5 tests) 5ms
 ✓ tests/fabric/xs-alias-decided.test.ts (9 tests) 8ms
 ✓ tests/fabric/xs-dedup.test.ts (7 tests) 6ms
 ✓ tests/fabric/xs-host-cap.test.ts (7 tests) 7ms
 ✓ tests/fabric/thread/buffer.test.ts (5 tests) 9ms
 ✓ tests/fabric/xs-alias-handoff.test.ts (6 tests) 5ms
 ✓ tests/fabric/xs-directory-channel.test.ts (5 tests) 6ms
 ✓ tests/fabric/throttle.test.ts (4 tests) 4ms
 ✓ tests/fabric/xs-render.test.ts (5 tests) 10ms
 ✓ tests/fabric/xs-alias-suggest.test.ts (4 tests) 25ms
 ✓ tests/fabric/thread/deadline.test.ts (6 tests) 5ms
 ✓ tests/fabric/legacy-xs-v071-fixture.test.ts (4 tests) 6ms
 ✓ tests/fabric/xs-activate-orphan.test.ts (1 test) 5ms
 ✓ tests/fabric/tree.test.ts (3 tests) 4ms
stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold
[bundle-parity] src-hot: median=10726ms range=10501–10899ms samples=[10899, 10726, 10545, 10501, 10735]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget
[bundle-parity] bundle-hot: median=944ms range=900–966ms samples=[925, 944, 900, 966, 946]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline
[bundle-parity] dispatcher-hot: median=942ms range=887–992ms samples=[887, 913, 992, 942, 988]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold
[bundle-parity] bundle-cold: median=964ms range=930–964ms samples=[930, 964]; src-cold: median=26422ms range=10761–26422ms samples=[26422, 10761]; dispatcher-cold: median=1143ms range=911–1143ms samples=[1143, 911]

 ✓ tests/governance/bundle-parity.test.ts (28 tests) 146908ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > syntactically broken bundle ⇒ exactly one error, zero tools — never a silent source fallback 485ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > bundle that throws at load time ⇒ one error carrying the message, zero tools 474ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > no bundle at all (git-install shape) ⇒ zero errors, the SOURCE path comes up with the real tool set 25259ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > host modules unresolvable ⇒ loud failure naming the pinning, not a partial redirect or a fallback 466ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold 53741ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget 4979ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline 5063ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold 41581ms
 ✓ tests/fabric/xs-switch.test.ts (2 tests) 3ms

 Test Files  76 passed (76)
      Tests  1183 passed (1183)
   Start at  12:24:34
   Duration  149.92s (transform 5.86s, setup 1.04s, collect 16.00s, tests 202.30s, environment 13ms, prepare 4.08s)

```

### 九套件 XsHarness — PASS（9 files / 69 tests）

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 600 npx vitest run tests/integration/fabric-xs-alias-v2.test.ts tests/integration/fabric-xs-alias.test.ts tests/integration/fabric-xs-channel.test.ts tests/integration/fabric-xs-inbox.test.ts tests/integration/fabric-xs-level-mixed.test.ts tests/integration/fabric-xs-lifecycle.test.ts tests/integration/fabric-xs-mention.test.ts tests/integration/fabric-xs-reply.test.ts tests/integration/fabric-xs.test.ts
```

完整日志：`/tmp/xs20-B-resume-harness-nine.log`；exit=0。

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/integration/fabric-xs-reply.test.ts (15 tests) 94026ms
   ✓ RXW reply association (real hub × real stacks) > #1 round trip: expectReply+wake ⇒ B header carries reply_to ⇒ B replyTo ⇒ A is woken 4863ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, quiet path: two due tickets of one session merge into ONE notice and clear owed 4978ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, wake path: a primed requester is woken by its own timeout notice 4687ms
   ✓ RXW reply association (real hub × real stacks) > #3a leave before due ⇒ nothing is written; at lateUntil the notice is dropped and counted 4993ms
   ✓ RXW reply association (real hub × real stacks) > #3b compaction window at due time ⇒ no write; the fence-close event replays the owed notice 5016ms
   ✓ RXW reply association (real hub × real stacks) > #3c slow session_before_switch ⇒ no write; a cancelled switch is closed by fence reset, then it flushes 5326ms
   ✓ RXW reply association (real hub × real stacks) > #3d switch away before due, due while away, switch back ⇒ owed notice appears on restore 5119ms
   ✓ RXW reply association (real hub × real stacks) > #3e expiring entirely while away ⇒ one quiet summary on switch back 5034ms
   ✓ RXW reply association (real hub × real stacks) > #4 receive=replies: unsolicited traffic is refused (hub early + injected bypass); a valid reply wakes 7168ms
   ✓ RXW reply association (real hub × real stacks) > #5 late: inside the grace window a reply is delivered without waking; past it the reply is refused 5200ms
   ✓ RXW reply association (real hub × real stacks) > #6 Blocker counterexample: duplicate reply after consumption (and after /tree) stays refused 4991ms
   ✓ RXW reply association (real hub × real stacks) > #7 /reload keeps the credential; a simulated pi restart refuses it with ONE invalidation notice 7495ms
   ✓ RXW reply association (real hub × real stacks) > #8 address pinning: a name rebound between resolve and send never reaches the new holder 7603ms
   ✓ RXW reply association (real hub × real stacks) > #9a old hub without the reply cap: expectReply is refused without a frame; receive=replies degrades to off 7419ms
   ✓ RXW reply association (real hub × real stacks) > #9b old recipient (reply disabled) is refused without delivery; hub restart mid-reply ⇒ unknown ⇒ resend delivers at most once 14130ms
 ✓ tests/integration/fabric-xs-alias-v2.test.ts (8 tests) 97136ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ①②④ concurrent same-cwd auto-claim → one winner, others skip:taken; D5 hint; --force (TUI) → real-time forced notice without reconnect; tombstone blocks re-claim for 30 days 10865ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ③ pin barrier: a send resolved BEFORE a force still reaches the original holder; with the original holder offline it is NO_TARGET — never the new holder 12407ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑤ web force under webCommandPolicy.fabric=confirm: preview and execution each need their own confirm; the confirm line is parseable; the holder is told 8182ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑧a unnotifiable holders: an online pre-v2 agent and a linked holder with xs off refuse --force (take only); a just-offline holder can be forced but not taken; the old agent returns to the legacy notice 16290ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑥ the human 'decided' mark survives /reload and a hub restart: a session that cleared its alias never auto-claims again (a fresh session in the same dir does) 11949ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑧b v1-only hub × new agents: no auto-claim, no force, no v2 hint — plain aliasing and delivery by alias keep working, no frame is lost 9726ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑨a /new hands the alias to the new sid (origin kept, no tombstone, human mark inherited); a human-granted name moves too; fork inherits nothing 12354ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑨b forged prevSessionId is refused (online and offline victims); an alias taken before the /new is not restored by it 15361ms
 ✓ tests/integration/fabric-xs-mention.test.ts (10 tests) 88493ms
   ✓ MW @session mention wiring (real hub × real stacks) > TUI explicit form: B gets a reply_to wake at level 0; B's reply wakes A when A receives in wake mode (RX7 R4 revision) 4990ms
   ✓ MW @session mention wiring (real hub × real stacks) > RX7 R4: a human-origin reply to a deliver-mode A is shown (display:true) but never wakes A 7315ms
   ✓ MW @session mention wiring (real hub × real stacks) > web composer path: `@session:<ref> msg` is routed (never reaches the native prompt) with the same semantics 5007ms
   ✓ MW @session mention wiring (real hub × real stacks) > bare `@name msg`: a unique cache hit routes (cache warmed by completion); completion inserts the bare name 4998ms
   ✓ MW @session mention wiring (real hub × real stacks) > a cwd file with the same name wins over a session: bare form passes through, completion inserts the explicit ref 4879ms
   ✓ MW @session mention wiring (real hub × real stacks) > off states: not joined / left ⇒ every `@` passes through (TUI + web) 7739ms
   ✓ MW @session mention wiring (real hub × real stacks) > xs off: the port is never injected — `@session:` is released verbatim 4793ms
   ✓ MW @session mention wiring (real hub × real stacks) > errors surface as subagent:mention-error{source:mention-session}, display-only 4823ms
   ✓ MW @session mention wiring (real hub × real stacks) > 2026-11-04 mention-handled fix: a handled mention input reports the web dispatch — the ctl entry is consumed and never decays to unconfirmed(unobserved) 39013ms
   ✓ MW @session mention wiring (real hub × real stacks) > a subagent label wins over a same-named session (cache warm, session unique): routed to the subagent, B untouched 4934ms
 ✓ tests/integration/fabric-xs-alias.test.ts (6 tests) 96498ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #1 set, send by alias (sender pins the full sessionId), from.alias header, @alias, validation + conflicts 25815ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #2 channel scope: an alias is invisible without a shared channel (NO_TARGET, no fallback to names); clear ⇒ cooling 10340ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #3 take: online ⇒ refused, offline <10m ⇒ refused, ≥10m ⇒ preview → confirm token → applied; old holder is told once; sends re-route 14897ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #4 a damaged alias file ⇒ degraded across restarts, never falls back; file bytes unchanged; /webhub status line; fixing the file restores 19928ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #5 web origin × webCommandPolicy.fabric=confirm: generic confirm per command, preview output carries the parseable confirm line, take executes 12434ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #6 mixed fleet: an alias-disabled (pre-alias) agent never sees aliases, and is unreachable BY alias without being broken 13083ms
 ✓ tests/integration/fabric-xs.test.ts (8 tests) 50617ms
   ✓ XW real hub child × two activate-built stacks × real sockets > join/list, deliver-only evidence, N1 then applied wake, reply, busy queued, goal downgrade and mutation fences 4955ms
   ✓ XW real hub child × two activate-built stacks × real sockets > not joined is invisible/undeliverable; leave rejects an already stamped in-flight deliver; fork does not inherit 4871ms
   ✓ XW real hub child × two activate-built stacks × real sockets > send resolve racing /new never emits send; reload reclaims Controller and dedup replays the first verdict 4844ms
   ✓ XW real hub child × two activate-built stacks × real sockets > hub death after receiver ack returns unknown; restart reconstructs members without resending; reload dedup survives 8689ms
   ✓ old-cap peers stay invisible and an old-cap hub returns off without sending 10367ms
   ✓ autoJoin publishes the joined member AFTER webhub session_start's session slot; fork never auto-joins 7175ms
   ✓ web /new exec claim fences actual socket ingress before its command trampoline runs 4797ms
   ✓ /new (web 清空) keeps the joined channels: the new sid re-joins and stays reachable; fork still does not inherit 4920ms
 ✓ tests/integration/fabric-xs-channel.test.ts (6 tests) 81453ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #1 same-channel scope, #2 union visibility (rows carry the shared non-default set) 13743ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #3 broadcast: fanout, no loop-back, deliver downgrade, replies invisible, level-0 wake, woken re-broadcast level_limit, sender maxLevel=0 15004ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #4 limits: per-hour cap, min interval, fan-out cap, #default refused 14835ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #5 linearization: leave before stage 3 ⇒ none{rejected}; leave after dispatch ⇒ applied (no rollback) 13419ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #6 a cross-channel double holder is AMBIGUOUS (uniqueness judged before visibility) 10197ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #7 hub restart, /reload, fork (no inheritance), suspend on channels.enabled=false and restore 14253ms
 ✓ tests/integration/fabric-xs-lifecycle.test.ts (9 tests) 53276ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > 8 deferred tombstones survive reload but new teardown frees ALL capacity 4681ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > 8 deferred tombstones survive reload but resume teardown frees ALL capacity 4902ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > 8 deferred tombstones survive reload but fork teardown frees ALL capacity 4868ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > recover aborting→stuck; agent_settled releases owner and ledger without a second abort 4684ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > an already-started wake remains owned after an xs/wake-off reload (wakeOnly=false) 4720ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > an already-started wake remains owned after an xs/wake-off reload (wakeOnly=true) 4855ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > xs-off reload still aborts a marked orphan before any provider work 4843ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > rpc process restore: disk membership is reachable with a new agent id, capability restarts unknown 7184ms
   ✓ wake-unknown-optimistic: legacy host (XW_LEGACY fake — no BAS, context instead) > the first optimistic run is aborted before any provider call; capability goes absent; later wakes are host_unsupported 12538ms
 ✓ tests/integration/fabric-xs-inbox.test.ts (6 tests) 29546ms
   ✓ IBW unread inbox (real stacks) > exit 1 (receiver host): quiet deliver counts, shows badge + web field, clears on a later-started turn 5935ms
   ✓ IBW unread inbox (real stacks) > Controller wake write counts (trigger turn started after the write) 4795ms
   ✓ IBW unread inbox (real stacks) > busy: a write inside turn k survives turn k's end and clears at turn k+1's 4919ms
   ✓ IBW unread inbox (real stacks) > exit 2 (NoticeGate quiet host): a timeout notice counts without an xid 4697ms
   ✓ IBW unread inbox (real stacks) > agent_end fallback clears when turn_end never fires; /reload keeps the count 4656ms
   ✓ IBW unread inbox (real stacks) > a rejected message (effect none) is not counted 4544ms
 ✓ tests/integration/fabric-xs-level-mixed.test.ts (1 test) 8241ms
   ✓ one causal chain: tree mailbox → root → xs wake → tree carry → xs wake → max-level downgrade; only human resets 8240ms

 Test Files  9 passed (9)
      Tests  69 passed (69)
   Start at  12:27:04
   Duration  306.19s (transform 295ms, setup 246ms, collect 304ms, tests 599.29s, environment 2ms, prepare 509ms)

```

### 最终 Prettier / HEAD fixtures / frozen diff — PASS

```sh
timeout 60 npx prettier --check src/fabric/xs/reply-notice.ts src/web-hub/agent/xs.ts src/web-hub/agent/index.ts src/fabric/xs/stack.ts src/fabric/xs/activate.ts docs/dev/fabric-cross-session/README.md tests/fabric/xs-reply-notice.test.ts tests/web-hub/agent/xs-state-bridge.test.ts tests/conformance/fabric-xs.test.ts tests/integration/fabric-xs-activate-session.test.ts tests/integration/xs-idle-wake-warning-compat.test.ts docs/dev/xs-idle-wake-warning/B-report.md
git diff --quiet HEAD -- tests/fixtures/
git diff --quiet HEAD -- tests/mention/ src/tools/message-session-tool.ts tests/tools/message-session-tool.test.ts tests/fabric/xs-receiver.test.ts tests/integration/helpers/fabric-xs-process.ts
git diff --check
```

完整日志：`/tmp/xs20-B-resume-prettier-final.log`、`/tmp/xs20-B-resume-frozen-final.log`。

```text
Checking formatting...
All matched files use Prettier code style!
git diff --quiet HEAD -- tests/fixtures/: exit=0
frozen A/mention/helper paths: exit=0
git diff --check: exit=0
```

## 7. 最终交付状态与残留

- 本轮 WebHubWire 补丁已完成，真实 activationOn 超时 now 精确含 last seen delivered 与 D5 delivered 尾句；
  activationOff、旧目标×新 requester、旧 hub×新 requester 的超时精确保留旧文本。未弱化断言或 skip。
- 类型检查、构建、plan、broad（mention/governance/off golden/C-X15）、九套件、commands、改动文件格式均通过。
  teardown-matrix 本轮 plan 直接 28 tests 全绿；首次计时 flake 及完整 standalone rerun-green 日志保留，不改相关文件。
- 无未修复的包 B 实现缺口或指定门禁失败；异源验收仍由 root 调度，本报告不冒充独立验收。
- 本包 fixtures 未改；HEAD fixtures diff=0。origin/dev 的唯一 fixture 差分属于 #23 已提交的新 epoch-up-compat-golden，非本包刷新。
- r3 的观测滞后/扫描上限/丢失 started 推送、非阻断 warning 误报、子会话/legacy/wake-off 有意漏报等接受残留不变（README）。
- 无 git add/commit/stash/checkout/reset/restore；未跑全量 npm test，未修改 P-B capsExtra 或其它 run 的文件。
