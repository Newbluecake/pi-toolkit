# ④ stack.ts 机械下沉 · 实施报告

基线：`3001afde`（dev）。分支 `gov/step4`，6 个提交，未 push。

## 提交

| 步骤 | hash     | 标题                                                                                           |
| ---- | -------- | ---------------------------------------------------------------------------------------------- |
| 4-1  | 3a6685c5 | refactor(stack): move bash job notice formatting out of stack.ts（由 wip a8ad8708 审查后改写） |
| 4-2  | 74f02de4 | refactor(stack): move host bash job manager assembly and recovery out of stack.ts              |
| 4-3  | 960f9a4d | refactor(stack): move the compact hint hook out of stack.ts                                    |
| 4-4  | b11f28c2 | refactor(stack): move buildFabric out of stack.ts                                              |
| 4-5  | 8cc347aa | refactor(stack): move the cross-session stack builder out of stack.ts                          |
| 4-6  | 7b9d5a35 | refactor(stack): move holder-routed delivery hooks out of stack.ts                             |

`stack.ts` 行数：3531 → 1993。

## wip 审查结论

wip 的 4-1 零行为，成立（文本和绑定双检查通过）。要改的地方：

- wip 把检查脚本 `scripts/dev/stack-decl-check.mjs` 提交进了仓库。方案要求脚本放 /tmp 不入库，所以已从提交中移除（脚本副本在 /tmp/sg-decl-check.mjs）。
- `web-hub/agent/redact.ts` 注释里还写着旧位置 `stack.ts's readBashJobTail`，已改成 `bash/notify.ts`。
- 检查脚本扩展了两处：holder 窄类型的比对（见偏差）；`;` 归一化。

## 移动符号

- 4-1 `src/bash/notify.ts`：BASH_JOB_NOTIFICATION_TYPE、BASH_JOB_TAIL_BYTES、BASH_JOB_TAIL_LINES、bashJobElapsedMs、bashJobOutcomePhrase、formatBashJobNotification、BASH_JOB_DEADLINE_NOTIFICATION_TYPE、BASH_JOB_GRACE_SUGGESTED_EXTEND_S、formatBashJobGraceNotice、formatBashJobExtendedNotice、tailOffset、BashJobTail、lastLines、readBashJobTail
- 4-2 `src/bash/host.ts`：BASH_JOB_SEAL_GRACE_MS、BASH_JOB_TOOL_LAG_WARN_MS、checkBashToolReturnLag、bashJobsEnabled、buildBashJobManager（→导出）、BASH_JOB_RECOVERY_DEADLINE_MS、BASH_JOB_RECONCILE_DEADLINE_MS、scheduleBashJobRecovery；`src/adapters/session-id.ts`：currentSessionId
- 4-3 `src/compact-hint/hook.ts`：CompactHintState、createCompactHintHook，新增 CompactHintHolder
- 4-4 `src/fabric/stack.ts`：buildFabric（→导出）
- 4-5 `src/fabric/xs/stack.ts`：StackXsInput、StackXs、StackXsReply、XS_REPLY_INBOUND_SCAN_CAP（保持私有）、buildStackXs（→导出）
- 4-6 `src/delivery/stack-hooks.ts`：createNotificationReceiptHook、createBackgroundCompletionEventHook

调用方 import 路径改动：`src/index.ts`、`src/todo/index.ts`、`src/commands/status.ts`、`src/context-switch/child.ts`、`src/compact-hint/threshold-tool.ts`、`scripts/exp/compact-dynamic-smoke.ts`，以及相关 tests 的 import。注释里的旧位置引用：`bash/child.ts`、`index.ts`（buildBashJobManager）、`todo/index.ts` ×2、`web-hub/agent/redact.ts`。没有垫片，也没有 re-export。

## 证明（`node .sg-decl-check.mjs --base 3001afde --step all`，原样输出）

```
symbol | old | new | text | free identifier bindings
BASH_JOB_NOTIFICATION_TYPE | src/stack.ts | src/bash/notify.ts | identical | 0 identical / 0 diff
BASH_JOB_TAIL_BYTES | src/stack.ts | src/bash/notify.ts | identical | 0 identical / 0 diff
BASH_JOB_TAIL_LINES | src/stack.ts | src/bash/notify.ts | identical | 0 identical / 0 diff
bashJobElapsedMs | src/stack.ts | src/bash/notify.ts | identical | 6 identical / 0 diff
bashJobOutcomePhrase | src/stack.ts | src/bash/notify.ts | identical | 6 identical / 0 diff
formatBashJobNotification | src/stack.ts | src/bash/notify.ts | identical | 17 identical / 0 diff
BASH_JOB_DEADLINE_NOTIFICATION_TYPE | src/stack.ts | src/bash/notify.ts | identical | 0 identical / 0 diff
BASH_JOB_GRACE_SUGGESTED_EXTEND_S | src/stack.ts | src/bash/notify.ts | identical | 0 identical / 0 diff
formatBashJobGraceNotice | src/stack.ts | src/bash/notify.ts | identical | 37 identical / 0 diff
formatBashJobExtendedNotice | src/stack.ts | src/bash/notify.ts | identical | 25 identical / 0 diff
tailOffset | src/stack.ts | src/bash/notify.ts | identical | 3 identical / 0 diff
BashJobTail | src/stack.ts | src/bash/notify.ts | identical | 0 identical / 0 diff
lastLines | src/stack.ts | src/bash/notify.ts | identical | 10 identical / 0 diff
readBashJobTail | src/stack.ts | src/bash/notify.ts | identical | 29 identical / 0 diff
BASH_JOB_SEAL_GRACE_MS | src/stack.ts | src/bash/host.ts | identical | 0 identical / 0 diff
BASH_JOB_TOOL_LAG_WARN_MS | src/stack.ts | src/bash/host.ts | identical | 0 identical / 0 diff
checkBashToolReturnLag | src/stack.ts | src/bash/host.ts | identical | 12 identical / 0 diff
bashJobsEnabled | src/stack.ts | src/bash/host.ts | identical | 5 identical / 0 diff
buildBashJobManager | src/stack.ts | src/bash/host.ts | identical | 70 identical / 0 diff
BASH_JOB_RECOVERY_DEADLINE_MS | src/stack.ts | src/bash/host.ts | identical | 0 identical / 0 diff
BASH_JOB_RECONCILE_DEADLINE_MS | src/stack.ts | src/bash/host.ts | identical | 0 identical / 0 diff
scheduleBashJobRecovery | src/stack.ts | src/bash/host.ts | identical | 36 identical / 0 diff
currentSessionId | src/stack.ts | src/adapters/session-id.ts | identical | 2 identical / 0 diff
CompactHintState | src/stack.ts | src/compact-hint/hook.ts | identical | 1 identical / 0 diff
createCompactHintHook | src/stack.ts | src/compact-hint/hook.ts | whitelisted holder type | 201 identical / 0 diff
buildFabric | src/stack.ts | src/fabric/stack.ts | identical | 140 identical / 0 diff
StackXsInput | src/stack.ts | src/fabric/xs/stack.ts | identical | 3 identical / 0 diff
StackXs | src/stack.ts | src/fabric/xs/stack.ts | identical | 11 identical / 0 diff
StackXsReply | src/stack.ts | src/fabric/xs/stack.ts | identical | 3 identical / 0 diff
XS_REPLY_INBOUND_SCAN_CAP | src/stack.ts | src/fabric/xs/stack.ts | identical | 0 identical / 0 diff
buildStackXs | src/stack.ts | src/fabric/xs/stack.ts | identical | 246 identical / 0 diff
createNotificationReceiptHook | src/stack.ts | src/delivery/stack-hooks.ts | whitelisted holder type | 4 identical / 0 diff
createBackgroundCompletionEventHook | src/stack.ts | src/delivery/stack-hooks.ts | whitelisted holder type | 3 identical / 0 diff
I5 unref occurrences: 7 -> 7
```

- **绑定比对**：和基线在 `/tmp` 的解包树逐个自由标识符比对，全部 `(文件, 声明名)` 一致。
- **文本比对**：声明体去掉 `export` 后逐字一致。
- **holder 窄类型**：只允许三处签名差异，其余字节一致。
- **I5**：unref 出现次数 7 → 7。
- **反向边**：`rg 'from "../stack.js"' src/todo src/context-switch src/compact-hint` 只剩 `context-switch/session-facts.ts`（type）。
- **旧位置引用**：§2.6 的 rg 命中 0。
- **冻结物**：`git diff --quiet dev -- tests/fixtures` 干净。

## 验证

- 每步：`npm run typecheck`、`npm run build`（4-4、4-5、4-6）、`--noUnusedLocals` 过滤新文件为空、对应定向 vitest 全绿。含 bash、todo、compact-hint、context-switch、fabric、delivery 相关套件和 `tests/web-hub/boundary.test.ts`。
- 4-1/4-2 另外补跑 `tests/secure/off-golden.test.ts`、`traffic-lifecycle-process`、`entry-loader`（R4b）。
- 收口：`npm run test:conformance` 33 个文件通过（341 passed / 16 skipped）。skipped 的是 droid-protocol（需要 `PI_TOOLKIT_DROID_CONFORMANCE=1`）。`npm run format:check` 通过。没有跑全量 `npm test`。

## 偏差

1. 没有 4-0（activate-trace golden）：按指示属于 ⑤，已跳过。方案 §2.5-3 的 `tests/governance/activate-trace.test.ts` 因此不存在，没有运行。
2. 检查脚本的 holder 窄类型比对是新增的：
   - 窄化后，函数体里 `holder.current?.<field>` 的属性声明从 Stack 搬到了窄类型里，自由标识符的绑定因此改变（预期内）。
   - 脚本把这些属性名从两侧剔除，同时要求新侧是旧侧的子多重集。
   - 脚本自测覆盖了「字段名被换掉」的情形。
3. `XS_REPLY_INBOUND_SCAN_CAP` 保持私有，因为只有 `buildStackXs` 用它；方案只要求 `buildStackXs` 导出。
4. `buildFabric` 的 `declaration` 构建没有触发 R4a（TS2742/TS4058），不需要显式返回类型。
5. tests 没有被 `npm run typecheck` 覆盖。tests 里的 import 是靠 vitest 运行结果确认的。
