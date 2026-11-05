# #20 包 A — 工具 warning 实施报告

> 2026-11-05 · dev · 依据 `plan.md` r3 §1 D1–D4 / §2 C1–C11、D-q / §3 包 A。
> 状态：包 A 实施及定向门禁通过；未执行全量 npm test；无 git 写操作。供 root / 异源 verifier 验收，不代替独立验收。

## 1. 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/tools/message-session-tool.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/activate.ts`
- `/home/bluecake/ai/pi-toolkit/tests/tools/message-session-tool.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-receiver.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-xs-activate-session.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-xs-human-default-wake.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-xs-human-child-runtime.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/xs-idle-wake-warning-compat.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/helpers/fabric-xs-process.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/xs-idle-wake-warning/A-report.md`

源改动仅两处：tool deps 增加冻结布尔、纯谓词与 D4 导出常量、末尾追加 hint；activate 仅一行 spread。sender / outcome / details / wire / schema / 全部工具描述零修改。

## 2. 真值表与测试映射

基准：`idleRiskBase()` 为 sent + applied + pending + 无 replyTo + requested:false + 无 wakeDowngraded + woke 非 true + track/key 存在 + phase delivered。纯函数测试与 fake-sender 最终 content 测试是两个独立 describe。

| 条件 / 真值表行         | 测试证据                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| C1 / 非 sent            | 单字段改为 unanswered、bad_args；其余基准不变                                                                                    |
| C2 / unknown            | 单字段 effect unknown；表行 7 queued、行 8 accept_unverified 不推测 idle                                                         |
| C3 / 非 pending         | 缺 reply 独立字段负例；表行 9 send_failed + none 组合负例、行 11 未设 expectReply                                                |
| C4 / 回复               | 单字段增加 replyTo；表行 12                                                                                                      |
| C5 → C6                 | 缺 wake 的组合缺失负例，不伪称能独立保持 C6                                                                                      |
| C6（以 C5 成立为前提）  | wake 存在且 requested:true / defaulted:true 的组合负例；表行 3；行 4/5/6 升级/显式 wake/降级                                     |
| C7 / 重复降级警告       | 单字段 wakeDowngraded:pair_wake_rate；content 恰为 pre20（保留既有降级 hint）                                                    |
| C8 / woke               | 单字段 woke:true；基准 woke 缺省以及 woke:false 均正例                                                                           |
| C9 → C10                | 缺 track 的组合缺失负例                                                                                                          |
| C10（以 C9 成立为前提） | track 存在，只有 activationKey 缺失；表行 10 legacy/无 key                                                                       |
| C11                     | 单字段 phase started / replied 负例；phase 缺省及 progress 缺省均正例                                                            |
| D-q                     | applied + queued 矛盾数据负例（由 C11 排除，不额外独立条件）                                                                     |
| 表行 1/2                | 显式 false / 省略未升级的相同 outcome 正例；真实 sender / human 并行第二目标落实省略路径                                         |
| 表行 13                 | 谓词本身仍 true；idleWakeAdvice 缺省/false 时 content === renderPre20；真实 activate wake-off 接线测试                           |
| 表行 14                 | started 表内负例 + started/replied/queued 各自单测                                                                               |
| 表行 15                 | 不经过工具，非谓词职责；tests/mention 原样回归。表内测试明确标注只验证其假设 qualifying outcome，不误把 mention 当作 sender 路径 |

接线 / 最终 content：

- gate true + 正例：content 深精确等于单 text `renderPre20(outcome) + "\n" + XS_IDLE_NO_WAKE_HINT`；D4 常量另与逐字文字断言，details 同一对象且 JSON 字节前后不变。
- gate 缺省/false + 正例及 gate true + 每个谓词负例：content 深精确等于 pre20 单 text，pre20 是测试内冻结的旧 hint 拼装副本，不调用生产 hint renderer。
- 专门验证只看 idleWakeAdvice，不再叠加 activation 或 reply gate。
- `fabric-xs-activate-session`：真实 router + source/target bridge + 两个真实 stack，三端 state cap，显式 false/true、busy unknown/queued 三种结果；正文都只写一次，details 无 warning 新键。
- `human-default-wake`：升级请求无 hint；同一输入后续调用有 hint；两个并行不同 idle 目标的 Promise.all 精确断言 [requested:true, requested:false] 与 [无 hint, 有 hint]。
- `human-child-runtime`：真实 SDK child 显式 false，已观测 tool_result.details 满足谓词，但工具结果无 hint，human-runtime 不注入冻结 gate。
- receiver：idle leaf 不匹配仍 unknown，经 fake-sender outcome 映射后谓词 false；写入中重入 idle 变 false 仍 applied（接受的残留）；同 xid 在已忙时重放仍历史 applied，不重复写（新 hub send 必然生成新 xid）。
- compat：真实 hub 子进程 + activate() 两端 stack；新请求方×旧目标及旧 hub×新请求方，分别发送 expectReply + wake:false，pending/applied 且无 track/progress，最终 content 与 renderPre20(details) 逐字节相等，正文一次。
- wake-off：在 XsHarness sandbox 既有 settings 文件写入 wake.enabled:false，未 reload 时仍产生 warning；reload 后仍观察到满足谓词的 outcome，但最终文本逐字节 pre20。证明确实走 activate.ts 门控，而非 fake 构造 gate=false。

## 3. 偏差与批准的文件域扩展

唯一扩域由 root 在本 run 明确批准：`tests/integration/helpers/fabric-xs-process.ts` 仅追加 toolContent RPC 分支，使用完全相同的工具 execute，返回完整 ToolResult。原 tool op 的表达式/参数/返回 .details 字节原封不动；没有新增 wake settings knob。

```diff
diff --git a/tests/integration/helpers/fabric-xs-process.ts b/tests/integration/helpers/fabric-xs-process.ts
index 21d8eab3..b88eaf99 100644
--- a/tests/integration/helpers/fabric-xs-process.ts
+++ b/tests/integration/helpers/fabric-xs-process.ts
@@ -459,6 +459,8 @@ if (process.argv[2] === "hub") {
   handle = async (m) => {
     if (m.op === "tool")
       return (await tools.get(m.name).execute("xw-call", m.params ?? {}, undefined, undefined, ctx)).details;
+    if (m.op === "toolContent")
+      return await tools.get(m.name).execute("xw-call", m.params ?? {}, undefined, undefined, ctx);
     if (m.op === "cmd") {
       await commands.get(m.name ?? "fabric").handler(m.args ?? "status", ctx);
       return notifications.at(-1);
```

九套件 XsHarness 回归（不含已在包 A 门禁通过的 activation-compat）全部绿：alias-v2、alias、channel、inbox、level-mixed、lifecycle、mention、reply、fabric-xs，9 files / 69 tests。新增 compat 另有 3 tests，activation-compat 另有 1 test。

实施细节 README 更新依计划归包 B，未在 A 越界修改。没有行为方案偏差。

初次自验发现并已修复的测试 harness 假设：

1. child sender 对 wire 的 false 会省略，断言改为非 true；真实 outcome 的 wake.requested:false + 谓词 true 仍独立断言。
2. helper settings 是共享 sandbox home 的 `~/.pi/agent/pi-subagent.json`（兼容 symlink），而非每 peer agentDir 根；改用现有路径。
3. sender 单端 clock skew 不改变 hub pair interval；reload 后第二条请求因 rate_pair_interval 被拒。改为已有 skew RPC 同步推进 hub/source/target 31s，重跑通过，不改任何生产准入。

初次失败完整日志在 `/tmp/xs20-A-first.log`、`/tmp/xs20-A-second.log`、`/tmp/xs20-A-wakeoff-debug.log`、`/tmp/xs20-A-wakeoff-reason.log`；最终门禁见下方（不是仅用 -t 跳过失败测试交付）。

## 4. 自验命令与真实完整输出

所有长命令使用 timeout，输出 `2>&1 | tee /tmp/...`，启用 pipefail；无 tail/head 截断。下面直接嵌入 tee 文件完整内容。重复测试数量不能相加为独立覆盖数。

### 用户要求的广域定向门禁 — PASS

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 240 npx vitest run tests/tools/message-session-tool.test.ts tests/fabric tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/governance tests/mention
```

完整日志：`/tmp/xs20-A-broad-gate.log`

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/fabric/root-wake.test.ts (68 tests) 59ms
 ✓ tests/fabric/xs-sender.test.ts (67 tests) 35ms
stderr | tests/fabric/threads-settings.test.ts > fabric.threads settings (P0 §11.1) > P4 §8.2 ③: a window clamp marks windowClamped (the ` · cfg clamped` suffix source)
[pi-subagent] fabric.threads.retainMin 5 → 12 (must be ≥ max(handbackWindowMin, startTimeoutMin)+2)
[pi-subagent] fabric.threads.handbackWindowMin 0 → 1 (below min 1)
[pi-subagent] fabric.threads.startTimeoutMin 40 → 30 (above max 30)
[pi-subagent] fabric.threads.retainMin 15 → 32 (must be ≥ max(handbackWindowMin, startTimeoutMin)+2)

 ✓ tests/fabric/threads-settings.test.ts (48 tests) 105ms
 ✓ tests/fabric/xs-receiver.test.ts (50 tests) 35ms
 ✓ tests/fabric/xs-reply-ledger.test.ts (29 tests) 33ms
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

 ✓ tests/fabric/wake.test.ts (40 tests) 43ms
 ✓ tests/fabric/root-wake.property.test.ts (2 tests) 1043ms
   ✓ RootWakeController random event invariants > single owner, occupied states supervised, at-most-once abort, zero abort after handover 650ms
   ✓ wake-unknown-optimistic random event invariants > optimistic first-run: per-token ≤1 abort/audit, dead optimistic tokens never hop, capability monotone 391ms
 ✓ tests/tools/message-session-tool.test.ts (65 tests) 23ms
 ✓ tests/fabric/thread/engine.test.ts (29 tests) 22ms
 ✓ tests/fabric/xs-progress.property.test.ts (13 tests) 2017ms
   ✓ xs progress — merge lattice (property) > random out-of-order / duplicate / late / stale-revision writes never regress a fact 1459ms
   ✓ xs progress — activation claims (property) > claim state machine matches the spec across random ops (idempotent consume, at-most-once) 454ms
 ✓ tests/fabric/revive.test.ts (66 tests) 50ms
 ✓ tests/fabric/xs-truth-table.test.ts (34 tests) 30ms
 ✓ tests/mention/session.test.ts (25 tests) 18ms
 ✓ tests/fabric/successor.test.ts (17 tests) 47ms
 ✓ tests/mention/mention.test.ts (20 tests) 15ms
 ✓ tests/fabric/xs-reply-notice.test.ts (18 tests) 17ms
 ✓ tests/fabric/xs-fence.test.ts (25 tests) 18ms
 ✓ tests/fabric/xs-session-activation.test.ts (15 tests) 20ms
 ✓ tests/fabric/router.test.ts (15 tests) 16ms
 ✓ tests/fabric/mailbox.test.ts (16 tests) 19ms
 ✓ tests/fabric/wake-result.test.ts (18 tests) 33ms
 ✓ tests/fabric/xs-reply-receiver.property.test.ts (2 tests) 200ms
 ✓ tests/integration/fabric-xs-reply-off-golden.test.ts (2 tests) 37ms
 ✓ tests/fabric/xs-reply-ledger.property.test.ts (2 tests) 151ms
 ✓ tests/fabric/xs-human-grant.test.ts (20 tests) 19ms
 ✓ tests/fabric/thread/engine.property.test.ts (2 tests) 325ms
   ✓ ThreadEngine seeded property invariants (§11.1 P1) > dedup · at-most-once auto-return · no auto-return over called steers — random op streams 323ms
 ✓ tests/fabric/xs-sender-channel.test.ts (20 tests) 14ms
 ✓ tests/integration/fabric-xs-off-golden.test.ts (3 tests) 75ms
 ✓ tests/fabric/thread/rebind.test.ts (14 tests) 13ms
 ✓ tests/mention/session-off.test.ts (5 tests) 18ms
 ✓ tests/fabric/xs-sender-human-grant.test.ts (26 tests) 27ms
 ✓ tests/fabric/xs-level.test.ts (12 tests) 14ms
 ✓ tests/fabric/thread/subscriptions.test.ts (9 tests) 9ms
 ✓ tests/mention/autocomplete.test.ts (11 tests) 232ms
 ✓ tests/fabric/xs-directory.test.ts (13 tests) 30ms
 ✓ tests/fabric/xs-stack-progress.test.ts (7 tests) 14ms
 ✓ tests/integration/fabric-wake-off-golden.test.ts (2 tests) 22ms
 ✓ tests/fabric/mention.test.ts (14 tests) 15ms
 ✓ tests/mention/autocomplete-session.test.ts (10 tests) 8ms
 ✓ tests/fabric/wake-level.test.ts (20 tests) 10ms
 ✓ tests/fabric/router-wake.test.ts (10 tests) 12ms
 ✓ tests/fabric/xs-unread.test.ts (21 tests) 2500ms
   ✓ property: random event sequences > bounded, per-session isolated, and any entry is cleared once a later-started turn completes 2482ms
 ✓ tests/fabric/xs-inbox.test.ts (10 tests) 8ms
stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-qUZiKJ/.pi/agent/pi-subagent.json → /tmp/pi-trace-qUZiKJ/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-qUZiKJ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-2QzpSj/.pi/agent/pi-subagent.json → /tmp/pi-trace-2QzpSj/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-2QzpSj/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-JcD1jN/.pi/agent/pi-subagent.json → /tmp/pi-trace-JcD1jN/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-JcD1jN/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-e2Q9Ji/.pi/agent/pi-subagent.json → /tmp/pi-trace-e2Q9Ji/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-e2Q9Ji/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-uOHhIT/.pi/agent/pi-subagent.json → /tmp/pi-trace-uOHhIT/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-uOHhIT/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-wldcRp/.pi/agent/pi-subagent.json → /tmp/pi-trace-wldcRp/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-wldcRp/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-KrB7ww/.pi/agent/pi-subagent.json → /tmp/pi-trace-KrB7ww/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-KrB7ww/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-Zbd3va/.pi/agent/pi-subagent.json → /tmp/pi-trace-Zbd3va/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-Zbd3va/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-ShW3Hc/.pi/agent/pi-subagent.json → /tmp/pi-trace-ShW3Hc/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-ShW3Hc/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-5NwQK1/.pi/agent/pi-subagent.json → /tmp/pi-trace-5NwQK1/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-5NwQK1/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-jDcU17/.pi/agent/pi-subagent.json → /tmp/pi-trace-jDcU17/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-jDcU17/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-mMTydi/.pi/agent/pi-subagent.json → /tmp/pi-trace-mMTydi/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-mMTydi/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-lNZJpq/.pi/agent/pi-subagent.json → /tmp/pi-trace-lNZJpq/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-lNZJpq/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-fWYLYq/.pi/agent/pi-subagent.json → /tmp/pi-trace-fWYLYq/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-fWYLYq/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-CDztRc/.pi/agent/pi-subagent.json → /tmp/pi-trace-CDztRc/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-CDztRc/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > compat-failure ends with the stub tool and never reaches post-guard wiring
[pi-subagent] settings moved: /tmp/pi-trace-dAXGBR/.pi/agent/pi-subagent.json → /tmp/pi-trace-dAXGBR/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-dAXGBR/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > fabric-thread arch §9.3 (P3): thread-main registers `thread` right after the fabric tool group; thread-child gains no registration
[pi-subagent] settings moved: /tmp/pi-trace-ZxOah0/.pi/agent/pi-subagent.json → /tmp/pi-trace-ZxOah0/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-ZxOah0/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

 ✓ tests/governance/activate-trace.test.ts (4 tests) 477ms
 ✓ tests/fabric/xs-receiver-progress.test.ts (8 tests) 11ms
 ✓ tests/fabric/xs-sender-alias.test.ts (11 tests) 10ms
 ✓ tests/mention/session-alias.test.ts (13 tests) 27ms
 ✓ tests/fabric/xs-channel.test.ts (47 tests) 13ms
 ✓ tests/fabric/thread/directory.test.ts (10 tests) 7ms
 ✓ tests/fabric/xs-wake-ledger.test.ts (12 tests) 9ms
 ✓ tests/fabric/xs-alias-auto.test.ts (9 tests) 28ms
 ✓ tests/fabric/wake-observability.test.ts (8 tests) 15ms
 ✓ tests/fabric/thread/records.test.ts (7 tests) 7ms
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
 ✓ tests/fabric/xs-activate-orphan.test.ts (1 test) 6ms
 ✓ tests/fabric/tree.test.ts (3 tests) 4ms
stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold
[bundle-parity] src-hot: median=10727ms range=10601–11664ms samples=[11664, 10601, 10622, 10729, 10727]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget
[bundle-parity] bundle-hot: median=908ms range=897–918ms samples=[913, 918, 897, 908, 906]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline
[bundle-parity] dispatcher-hot: median=899ms range=863–917ms samples=[882, 863, 917, 899, 911]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold
[bundle-parity] bundle-cold: median=911ms range=883–911ms samples=[883, 911]; src-cold: median=24749ms range=10500–24749ms samples=[24749, 10500]; dispatcher-cold: median=1128ms range=897–1128ms samples=[1128, 897]

 ✓ tests/governance/bundle-parity.test.ts (28 tests) 144870ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > syntactically broken bundle ⇒ exactly one error, zero tools — never a silent source fallback 495ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > bundle that throws at load time ⇒ one error carrying the message, zero tools 495ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > no bundle at all (git-install shape) ⇒ zero errors, the SOURCE path comes up with the real tool set 25095ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > host modules unresolvable ⇒ loud failure naming the pinning, not a partial redirect or a fallback 465ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold 54636ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget 4842ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline 4754ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold 39466ms
 ✓ tests/fabric/xs-switch.test.ts (2 tests) 3ms

 Test Files  76 passed (76)
      Tests  1215 passed (1215)
   Start at  11:14:19
   Duration  146.71s (transform 5.26s, setup 1.02s, collect 14.21s, tests 153.10s, environment 13ms, prepare 3.97s)

```

### plan 包 A 完整门禁 — PASS

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 360 npx vitest run tests/tools/message-session-tool.test.ts tests/fabric/xs-receiver.test.ts tests/fabric/xs-sender-human-grant.test.ts tests/integration/fabric-xs-human-default-wake.test.ts tests/integration/fabric-xs-human-child-runtime.test.ts tests/integration/fabric-xs-activate-session.test.ts tests/integration/fabric-xs-activation-compat.test.ts tests/integration/xs-idle-wake-warning-compat.test.ts tests/integration/fabric-xs-activation.test.ts tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/governance tests/mention
```

完整日志：`/tmp/xs20-A-plan-gate.log`

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/fabric/xs-receiver.test.ts (50 tests) 37ms
 ✓ tests/integration/fabric-xs-human-child-runtime.test.ts (25 tests) 1118ms
 ✓ tests/tools/message-session-tool.test.ts (65 tests) 23ms
 ✓ tests/integration/fabric-xs-activate-session.test.ts (10 tests) 82ms
 ✓ tests/mention/session.test.ts (25 tests) 18ms
 ✓ tests/mention/mention.test.ts (20 tests) 15ms
 ✓ tests/integration/fabric-xs-reply-off-golden.test.ts (2 tests) 36ms
 ✓ tests/integration/fabric-xs-off-golden.test.ts (3 tests) 73ms
 ✓ tests/integration/fabric-xs-human-default-wake.test.ts (7 tests) 48ms
 ✓ tests/mention/session-off.test.ts (5 tests) 19ms
 ✓ tests/fabric/xs-sender-human-grant.test.ts (26 tests) 22ms
stderr | tests/integration/fabric-xs-activation.test.ts > XW activate-frozen main-session surface > any missing prerequisite removes both tools AND /fabric (false true true true)
[pi-subagent] settings moved: /tmp/pi-toolkit-home-GXxE3c/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-GXxE3c/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-GXxE3c/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > XW activate-frozen main-session surface > any missing prerequisite removes both tools AND /fabric (true false true true)
[pi-subagent] settings moved: /tmp/pi-toolkit-home-ZqfpRR/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-ZqfpRR/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-ZqfpRR/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > XW activate-frozen main-session surface > any missing prerequisite removes both tools AND /fabric (true true false true)
[pi-subagent] settings moved: /tmp/pi-toolkit-home-hagczL/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-hagczL/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-hagczL/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > XW activate-frozen main-session surface > any missing prerequisite removes both tools AND /fabric (true true true false)
[pi-subagent] settings moved: /tmp/pi-toolkit-home-pYipJZ/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-pYipJZ/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-pYipJZ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > XW activate-frozen main-session surface > wake_session is registered under activationOn even when wake=false (query survives)
[pi-subagent] settings moved: /tmp/pi-toolkit-home-c4shuu/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-c4shuu/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-c4shuu/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > XW activate-frozen main-session surface > wake_session is registered under activationOn even when wake=true (query survives)
[pi-subagent] settings moved: /tmp/pi-toolkit-home-TKY9Qs/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-TKY9Qs/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-TKY9Qs/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > XW activate-frozen main-session surface > wake=false never changes either schema; settings edits do not re-register tools
[pi-subagent] settings moved: /tmp/pi-toolkit-home-LZEV3c/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-LZEV3c/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-LZEV3c/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > XW activate-frozen main-session surface > wake=true never changes either schema; settings edits do not re-register tools
[pi-subagent] settings moved: /tmp/pi-toolkit-home-BOevme/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-BOevme/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-BOevme/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > channel-plan §6 (CHW): channels.enabled=false ⇒ legacy list_sessions instance and no message_channel
[pi-subagent] settings moved: /tmp/pi-toolkit-home-9oYMSc/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-9oYMSc/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-9oYMSc/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > channel-plan §6 (CHW): xs off ⇒ message_channel is never registered even with channels on
[pi-subagent] settings moved: /tmp/pi-toolkit-home-gmyQzu/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-gmyQzu/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-gmyQzu/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > reply.enabled=false freezes the legacy (byte-identical) message_session schema
[pi-subagent] settings moved: /tmp/pi-toolkit-home-CH8SU3/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-CH8SU3/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-CH8SU3/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-toolkit-home-aMCtfb/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-aMCtfb/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-aMCtfb/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/integration/fabric-xs-activation.test.ts > xs-off minimal host does not read sessionManager in B1/shutdown hooks
[pi-subagent] settings moved: /tmp/pi-toolkit-home-P0Peim/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-P0Peim/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-P0Peim/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] prompt section persist failed (in-memory state kept): TypeError: pi.appendEntry is not a function

stderr | tests/integration/fabric-xs-activation.test.ts > activation off omits wake_session, state hooks and extra activation registration
[pi-subagent] settings moved: /tmp/pi-toolkit-home-HgSDox/.pi/agent/pi-subagent.json → /tmp/pi-toolkit-home-HgSDox/.pi/agent/pi-toolkit.json (kept /tmp/pi-toolkit-home-HgSDox/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

 ✓ tests/integration/fabric-xs-activation.test.ts (14 tests) 147ms
 ✓ tests/mention/autocomplete.test.ts (11 tests) 233ms
 ✓ tests/integration/fabric-wake-off-golden.test.ts (2 tests) 23ms
 ✓ tests/mention/autocomplete-session.test.ts (10 tests) 9ms
stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-chsSzD/.pi/agent/pi-subagent.json → /tmp/pi-trace-chsSzD/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-chsSzD/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-SBfasp/.pi/agent/pi-subagent.json → /tmp/pi-trace-SBfasp/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-SBfasp/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-TwwgWL/.pi/agent/pi-subagent.json → /tmp/pi-trace-TwwgWL/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-TwwgWL/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > matches the stored trace for every profile
[pi-subagent] settings moved: /tmp/pi-trace-PR9wIz/.pi/agent/pi-subagent.json → /tmp/pi-trace-PR9wIz/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-PR9wIz/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-g6ku32/.pi/agent/pi-subagent.json → /tmp/pi-trace-g6ku32/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-g6ku32/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-aZDRCe/.pi/agent/pi-subagent.json → /tmp/pi-trace-aZDRCe/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-aZDRCe/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-wvwgm8/.pi/agent/pi-subagent.json → /tmp/pi-trace-wvwgm8/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-wvwgm8/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-lO2MWW/.pi/agent/pi-subagent.json → /tmp/pi-trace-lO2MWW/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-lO2MWW/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-tmTj5w/.pi/agent/pi-subagent.json → /tmp/pi-trace-tmTj5w/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-tmTj5w/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-gwAxGw/.pi/agent/pi-subagent.json → /tmp/pi-trace-gwAxGw/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-gwAxGw/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-622icH/.pi/agent/pi-subagent.json → /tmp/pi-trace-622icH/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-622icH/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-UJ1teN/.pi/agent/pi-subagent.json → /tmp/pi-trace-UJ1teN/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-UJ1teN/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-JwDvVQ/.pi/agent/pi-subagent.json → /tmp/pi-trace-JwDvVQ/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-JwDvVQ/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)
[pi-subagent] settings moved: /tmp/pi-trace-CoUTFu/.pi/agent/pi-subagent.json → /tmp/pi-trace-CoUTFu/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-CoUTFu/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > is deterministic across two recordings
[pi-subagent] settings moved: /tmp/pi-trace-fwqhzf/.pi/agent/pi-subagent.json → /tmp/pi-trace-fwqhzf/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-fwqhzf/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > compat-failure ends with the stub tool and never reaches post-guard wiring
[pi-subagent] settings moved: /tmp/pi-trace-AkXcxI/.pi/agent/pi-subagent.json → /tmp/pi-trace-AkXcxI/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-AkXcxI/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

stderr | tests/governance/activate-trace.test.ts > activation call-trace golden > fabric-thread arch §9.3 (P3): thread-main registers `thread` right after the fabric tool group; thread-child gains no registration
[pi-subagent] settings moved: /tmp/pi-trace-ILdyeh/.pi/agent/pi-subagent.json → /tmp/pi-trace-ILdyeh/.pi/agent/pi-toolkit.json (kept /tmp/pi-trace-ILdyeh/.pi/agent/pi-subagent.json as a compatibility symlink for older versions)

 ✓ tests/governance/activate-trace.test.ts (4 tests) 472ms
 ✓ tests/mention/session-alias.test.ts (13 tests) 27ms
 ✓ tests/integration/xs-idle-wake-warning-compat.test.ts (3 tests) 19938ms
   ✓ #20 expectReply mixed-version content byte differential > old-target × new requester remains pre20 byte-identical 6586ms
   ✓ #20 expectReply mixed-version content byte differential > old-hub × new requester remains pre20 byte-identical 6590ms
   ✓ #20 real activate() freezes advice on wake setting: wake-off retains qualifying outcome but pre20 content 6761ms
 ✓ tests/mention/notes.test.ts (9 tests) 5ms
stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold
[bundle-parity] src-hot: median=10639ms range=10544–10757ms samples=[10735, 10544, 10757, 10581, 10639]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget
[bundle-parity] bundle-hot: median=933ms range=916–939ms samples=[916, 933, 934, 939, 926]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline
[bundle-parity] dispatcher-hot: median=892ms range=891–899ms samples=[891, 892, 892, 898, 899]

stdout | tests/governance/bundle-parity.test.ts > §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold
[bundle-parity] bundle-cold: median=1086ms range=958–1086ms samples=[958, 1086]; src-cold: median=26444ms range=10726–26444ms samples=[26444, 10726]; dispatcher-cold: median=1161ms range=975–1161ms samples=[1161, 975]

 ✓ tests/governance/bundle-parity.test.ts (28 tests) 145901ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > syntactically broken bundle ⇒ exactly one error, zero tools — never a silent source fallback 466ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > bundle that throws at load time ⇒ one error carrying the message, zero tools 466ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > no bundle at all (git-install shape) ⇒ zero errors, the SOURCE path comes up with the real tool set 24669ms
   ✓ §7.1 bad bundle / fallback layouts (real loadExtensions) > host modules unresolvable ⇒ loud failure naming the pinning, not a partial redirect or a fallback 459ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > src direct (baseline) — recorded, no threshold 53566ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > bundle direct — hot median under the budget 4943ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > dispatcher (the real path) — hot median under the budget and well under the src baseline 4765ms
   ✓ §6.4 performance (loadExtensions whole segment; hot jiti cache) > cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold 41806ms
 ✓ tests/integration/fabric-xs-activation-compat.test.ts (1 test) 41236ms
   ✓ fabric-xs-activation mixed versions (I10) > every combination delivers the body once; only new×new×new adds tracking, and old-side combos stay on the legacy byte shape 41235ms

 Test Files  21 passed (21)
      Tests  333 passed (333)
   Start at  11:16:53
   Duration  187.86s (transform 4.99s, setup 344ms, collect 12.71s, tests 209.48s, environment 4ms, prepare 1.10s)

```

### 九套件 XsHarness 回归 — PASS

```sh
PI_TOOLKIT_TEST_WORKERS=2 timeout 480 npx vitest run tests/integration/fabric-xs-alias-v2.test.ts tests/integration/fabric-xs-alias.test.ts tests/integration/fabric-xs-channel.test.ts tests/integration/fabric-xs-inbox.test.ts tests/integration/fabric-xs-level-mixed.test.ts tests/integration/fabric-xs-lifecycle.test.ts tests/integration/fabric-xs-mention.test.ts tests/integration/fabric-xs-reply.test.ts tests/integration/fabric-xs.test.ts
```

完整日志：`/tmp/xs20-A-harness-nine.log`

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/integration/fabric-xs-reply.test.ts (15 tests) 84175ms
   ✓ RXW reply association (real hub × real stacks) > #1 round trip: expectReply+wake ⇒ B header carries reply_to ⇒ B replyTo ⇒ A is woken 4502ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, quiet path: two due tickets of one session merge into ONE notice and clear owed 4492ms
   ✓ RXW reply association (real hub × real stacks) > #2 timeout, wake path: a primed requester is woken by its own timeout notice 4508ms
   ✓ RXW reply association (real hub × real stacks) > #3a leave before due ⇒ nothing is written; at lateUntil the notice is dropped and counted 4426ms
   ✓ RXW reply association (real hub × real stacks) > #3b compaction window at due time ⇒ no write; the fence-close event replays the owed notice 4545ms
   ✓ RXW reply association (real hub × real stacks) > #3c slow session_before_switch ⇒ no write; a cancelled switch is closed by fence reset, then it flushes 4509ms
   ✓ RXW reply association (real hub × real stacks) > #3d switch away before due, due while away, switch back ⇒ owed notice appears on restore 4534ms
   ✓ RXW reply association (real hub × real stacks) > #3e expiring entirely while away ⇒ one quiet summary on switch back 4487ms
   ✓ RXW reply association (real hub × real stacks) > #4 receive=replies: unsolicited traffic is refused (hub early + injected bypass); a valid reply wakes 6714ms
   ✓ RXW reply association (real hub × real stacks) > #5 late: inside the grace window a reply is delivered without waking; past it the reply is refused 4485ms
   ✓ RXW reply association (real hub × real stacks) > #6 Blocker counterexample: duplicate reply after consumption (and after /tree) stays refused 4487ms
   ✓ RXW reply association (real hub × real stacks) > #7 /reload keeps the credential; a simulated pi restart refuses it with ONE invalidation notice 6656ms
   ✓ RXW reply association (real hub × real stacks) > #8 address pinning: a name rebound between resolve and send never reaches the new holder 6651ms
   ✓ RXW reply association (real hub × real stacks) > #9a old hub without the reply cap: expectReply is refused without a frame; receive=replies degrades to off 6758ms
   ✓ RXW reply association (real hub × real stacks) > #9b old recipient (reply disabled) is refused without delivery; hub restart mid-reply ⇒ unknown ⇒ resend delivers at most once 12419ms
 ✓ tests/integration/fabric-xs-alias-v2.test.ts (8 tests) 93509ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ①②④ concurrent same-cwd auto-claim → one winner, others skip:taken; D5 hint; --force (TUI) → real-time forced notice without reconnect; tombstone blocks re-claim for 30 days 10233ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ③ pin barrier: a send resolved BEFORE a force still reaches the original holder; with the original holder offline it is NO_TARGET — never the new holder 12215ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑤ web force under webCommandPolicy.fabric=confirm: preview and execution each need their own confirm; the confirm line is parseable; the holder is told 7436ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑧a unnotifiable holders: an online pre-v2 agent and a linked holder with xs off refuse --force (take only); a just-offline holder can be forced but not taken; the old agent returns to the legacy notice 15601ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑥ the human 'decided' mark survives /reload and a hub restart: a session that cleared its alias never auto-claims again (a fresh session in the same dir does) 11676ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑧b v1-only hub × new agents: no auto-claim, no force, no v2 hint — plain aliasing and delivery by alias keep working, no frame is lost 8981ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑨a /new hands the alias to the new sid (origin kept, no tombstone, human mark inherited); a human-granted name moves too; fork inherits nothing 12151ms
   ✓ alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub > ⑨b forged prevSessionId is refused (online and offline victims); an alias taken before the /new is not restored by it 15213ms
 ✓ tests/integration/fabric-xs-alias.test.ts (6 tests) 93494ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #1 set, send by alias (sender pins the full sessionId), from.alias header, @alias, validation + conflicts 25129ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #2 channel scope: an alias is invisible without a shared channel (NO_TARGET, no fallback to names); clear ⇒ cooling 9404ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #3 take: online ⇒ refused, offline <10m ⇒ refused, ≥10m ⇒ preview → confirm token → applied; old holder is told once; sends re-route 14721ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #4 a damaged alias file ⇒ degraded across restarts, never falls back; file bytes unchanged; /webhub status line; fixing the file restores 19123ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #5 web origin × webCommandPolicy.fabric=confirm: generic confirm per command, preview output carries the parseable confirm line, take executes 12354ms
   ✓ alias-plan §9 (AL6): session aliases over a real hub > #6 mixed fleet: an alias-disabled (pre-alias) agent never sees aliases, and is unreachable BY alias without being broken 12762ms
 ✓ tests/integration/fabric-xs-mention.test.ts (10 tests) 85280ms
   ✓ MW @session mention wiring (real hub × real stacks) > TUI explicit form: B gets a reply_to wake at level 0; B's reply wakes A when A receives in wake mode (RX7 R4 revision) 4660ms
   ✓ MW @session mention wiring (real hub × real stacks) > RX7 R4: a human-origin reply to a deliver-mode A is shown (display:true) but never wakes A 6793ms
   ✓ MW @session mention wiring (real hub × real stacks) > web composer path: `@session:<ref> msg` is routed (never reaches the native prompt) with the same semantics 4576ms
   ✓ MW @session mention wiring (real hub × real stacks) > bare `@name msg`: a unique cache hit routes (cache warmed by completion); completion inserts the bare name 4604ms
   ✓ MW @session mention wiring (real hub × real stacks) > a cwd file with the same name wins over a session: bare form passes through, completion inserts the explicit ref 4717ms
   ✓ MW @session mention wiring (real hub × real stacks) > off states: not joined / left ⇒ every `@` passes through (TUI + web) 7523ms
   ✓ MW @session mention wiring (real hub × real stacks) > xs off: the port is never injected — `@session:` is released verbatim 4566ms
   ✓ MW @session mention wiring (real hub × real stacks) > errors surface as subagent:mention-error{source:mention-session}, display-only 4418ms
   ✓ MW @session mention wiring (real hub × real stacks) > 2026-11-04 mention-handled fix: a handled mention input reports the web dispatch — the ctl entry is consumed and never decays to unconfirmed(unobserved) 38806ms
   ✓ MW @session mention wiring (real hub × real stacks) > a subagent label wins over a same-named session (cache warm, session unique): routed to the subagent, B untouched 4614ms
 ✓ tests/integration/fabric-xs.test.ts (8 tests) 48751ms
   ✓ XW real hub child × two activate-built stacks × real sockets > join/list, deliver-only evidence, N1 then applied wake, reply, busy queued, goal downgrade and mutation fences 4692ms
   ✓ XW real hub child × two activate-built stacks × real sockets > not joined is invisible/undeliverable; leave rejects an already stamped in-flight deliver; fork does not inherit 4586ms
   ✓ XW real hub child × two activate-built stacks × real sockets > send resolve racing /new never emits send; reload reclaims Controller and dedup replays the first verdict 4707ms
   ✓ XW real hub child × two activate-built stacks × real sockets > hub death after receiver ack returns unknown; restart reconstructs members without resending; reload dedup survives 8804ms
   ✓ old-cap peers stay invisible and an old-cap hub returns off without sending 10325ms
   ✓ autoJoin publishes the joined member AFTER webhub session_start's session slot; fork never auto-joins 6663ms
   ✓ web /new exec claim fences actual socket ingress before its command trampoline runs 4470ms
   ✓ /new (web 清空) keeps the joined channels: the new sid re-joins and stays reachable; fork still does not inherit 4503ms
 ✓ tests/integration/fabric-xs-channel.test.ts (6 tests) 76204ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #1 same-channel scope, #2 union visibility (rows carry the shared non-default set) 13419ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #3 broadcast: fanout, no loop-back, deliver downgrade, replies invisible, level-0 wake, woken re-broadcast level_limit, sender maxLevel=0 13784ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #4 limits: per-hour cap, min interval, fan-out cap, #default refused 13839ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #5 linearization: leave before stage 3 ⇒ none{rejected}; leave after dispatch ⇒ applied (no rollback) 12690ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #6 a cross-channel double holder is AMBIGUOUS (uniqueness judged before visibility) 9361ms
   ✓ channel-plan §9.2 (CHW): channels over a real hub > #7 hub restart, /reload, fork (no inheritance), suspend on channels.enabled=false and restore 13110ms
 ✓ tests/integration/fabric-xs-lifecycle.test.ts (9 tests) 50187ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > 8 deferred tombstones survive reload but new teardown frees ALL capacity 4417ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > 8 deferred tombstones survive reload but resume teardown frees ALL capacity 4464ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > 8 deferred tombstones survive reload but fork teardown frees ALL capacity 4452ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > recover aborting→stuck; agent_settled releases owner and ledger without a second abort 4447ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > an already-started wake remains owned after an xs/wake-off reload (wakeOnly=false) 4492ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > an already-started wake remains owned after an xs/wake-off reload (wakeOnly=true) 4560ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > xs-off reload still aborts a marked orphan before any provider work 4476ms
   ✓ XW R1 minor: proof-driven ledger teardown and settled forwarding > rpc process restore: disk membership is reachable with a new agent id, capability restarts unknown 6748ms
   ✓ wake-unknown-optimistic: legacy host (XW_LEGACY fake — no BAS, context instead) > the first optimistic run is aborted before any provider call; capability goes absent; later wakes are host_unsupported 12130ms
 ✓ tests/integration/fabric-xs-inbox.test.ts (6 tests) 28225ms
   ✓ IBW unread inbox (real stacks) > exit 1 (receiver host): quiet deliver counts, shows badge + web field, clears on a later-started turn 5548ms
   ✓ IBW unread inbox (real stacks) > Controller wake write counts (trigger turn started after the write) 4518ms
   ✓ IBW unread inbox (real stacks) > busy: a write inside turn k survives turn k's end and clears at turn k+1's 4534ms
   ✓ IBW unread inbox (real stacks) > exit 2 (NoticeGate quiet host): a timeout notice counts without an xid 4565ms
   ✓ IBW unread inbox (real stacks) > agent_end fallback clears when turn_end never fires; /reload keeps the count 4557ms
   ✓ IBW unread inbox (real stacks) > a rejected message (effect none) is not counted 4501ms
 ✓ tests/integration/fabric-xs-level-mixed.test.ts (1 test) 8232ms
   ✓ one causal chain: tree mailbox → root → xs wake → tree carry → xs wake → max-level downgrade; only human resets 8231ms

 Test Files  9 passed (9)
      Tests  69 passed (69)
   Start at  11:20:09
   Duration  291.58s (transform 274ms, setup 222ms, collect 284ms, tests 568.06s, environment 2ms, prepare 479ms)

```

### 类型检查 — PASS

```sh
timeout 180 npm run typecheck
```

完整日志：`/tmp/xs20-A-typecheck.log`

```text

> pi-toolkit@0.10.6 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json

typecheck exit=0
```

### 构建 — PASS

```sh
timeout 180 npm run build
```

完整日志：`/tmp/xs20-A-build.log`

```text

> pi-toolkit@0.10.6 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json && npm run build:bundle


> pi-toolkit@0.10.6 build:bundle
> node scripts/build-bundle.mjs

build:bundle ok — dist/bundle/index.js sha256=4e6e1b2e17e038f2 size=4.68 MB time=172 ms inputs=693
build exit=0
```

### 冻结面 / diff 检查 — PASS

```sh
git diff --quiet HEAD -- tests/fixtures/
git diff --quiet origin/dev -- tests/fixtures/
git diff --quiet HEAD -- tests/mention/ src/fabric/xs/reply-notice.ts src/web-hub/agent/xs.ts src/fabric/xs/stack.ts src/stack.ts
git diff --check
```

完整日志：`/tmp/xs20-A-frozen.log`

```text
git diff --quiet HEAD -- tests/fixtures/: exit=0
git diff --quiet origin/dev -- tests/fixtures/: exit=0
frozen package-B and mention paths: exit=0
git diff --check: exit=0
```

### 改动文件 Prettier — PASS

```sh
timeout 60 npx prettier --check src/tools/message-session-tool.ts src/fabric/xs/activate.ts tests/tools/message-session-tool.test.ts tests/fabric/xs-receiver.test.ts tests/integration/fabric-xs-activate-session.test.ts tests/integration/fabric-xs-human-default-wake.test.ts tests/integration/fabric-xs-human-child-runtime.test.ts tests/integration/xs-idle-wake-warning-compat.test.ts tests/integration/helpers/fabric-xs-process.ts docs/dev/xs-idle-wake-warning/A-report.md
```

完整日志：`/tmp/xs20-A-prettier.log`

```text
Checking formatting...
All matched files use Prettier code style!
```

## 5. 遗留 / 未做

- 没有未修复的包 A 验证失败或实现缺口。
- 采样后重入/人类输入/goal/schedule 可使 warning 成为误报，仍不阻断，按 D1/§4 接受；警告只在工具文本，details/UI 结构化面看不到。
- 子会话、wake off、legacy 无 track/key 有意漏报；没有新增 busy 门控、hub 往返、wire 字段或 timer。
- 包 B 超时 phase、README 及 C-X15 后续由 root 按计划实施。本包未改这些文件。
- 全量测试/全库 format 门禁留给 root，两包完成后统一跑；本包未执行 npm test，没有 commit/add/stash/checkout/reset/restore。
- 工作区出现其它 run 的 `docs/dev/web-update-stuck/` 未跟踪目录；不属于本包，未读取/修改/加入文件清单。
