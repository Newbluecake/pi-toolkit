# P2 delivery report (dev:web-resume-p2)

所有关卡已验证通过。最终报告：

---

# P2 (web-hub agent side) — 实现报告

## 改动文件清单（绝对路径）

**修改（6 src + 4 test）**

- `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/messages.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/builtin-bridge.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/command-policy.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/commands.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/status.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/{builtin-bridge,command-policy,commands,status}.test.ts`

**新增（2 src + 8 test）**

- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/resume-list.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/resume-exec.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/{resume-fixtures,resume-list,resume-list-bounds,resume-exec,resume-open-discipline,commands-resume,wiring-resume}.test.ts` (+ `tests/web-hub/agent/resume-fixtures.ts` helper)
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/protocol/resume-wire.test.ts`

**未触碰**：`src/session-nav/**`、`src/web-hub/hub/**`、`src/web-hub/ui/**`、`CmdSchema`/`CtlItemSchema`（git diff 0 hits）、`src/commands/webhub.ts`（见偏差 #1）。P1 已落地并提交（fa0e9d6），我按冻结 §2.2 API 直接 import。

## 每文件 diff 摘要

| 文件                   | 变更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol/messages.ts` | 仅追加：`ResumeSessionRowWire`/`ResumeSessionsWire`（§2.4 冻结 wire 形状）、`CmdData` command 变体可选 `sessions`、`StatusInfo.features?` + `StatusInfoSchema.features`（≤32×≤64）+ `RESUME_FEATURE_V1`/`STATUS_FEATURES_*` 常量                                                                                                                                                                                                                                                          |
| `command-policy.ts`    | `builtinPolicy` 的 `resume` 分支：bare/其他参数保持 deny；`__list`/`__pick` ⇒ allow（无 policyBusy——D4 在桥内执行）；override 经现有 `resolveCommandPolicy` 直接生效；`resume-recent` 保持 deny                                                                                                                                                                                                                                                                                           |
| `builtin-bridge.ts`    | `execute` 返回类型加入 `Promise<CmdResultBody>`（仅 `__list`）；新 `resume?` dep + `dispatchBuiltin` case `resume`；`armExec?` 返回 `string\|undefined`（claim 被持有 ⇒ `/new` 回 `E_COMMAND_DENIED exec:in-flight`）；`isQuiet()`（结构性识别 `resume __list`）                                                                                                                                                                                                                          |
| `commands.ts`          | `handleCommand` thenable 分支：race `min(RESUME_LIST_RACE_MS=6000, opTotal)`（unref'd timer），超时 ⇒ `E_DEADLINE` retryable effect none `resume:scanning`（ledger 删除 ⇒ 同 id 重试重新执行），late 完成被丢弃；`settleCommandResult`：quiet 时 ledger 去 `sessions`、回复全文；`notifyCommandSuccess`：quiet 不发 origin notify；`handlePrompt` 增 `switchInFlight?.()` ⇒ `E_STALE_CTX` retryable none（在 mention/hold/native 派发之前）                                               |
| `index.ts`             | `pendingExec` → `execGate = createExecGate`（/new nonce 5s TTL + resume 共享单 claim）；构造 `resumeList`/`resumeExec`（closure 内，`defaultResumeCore()` 为 P1 唯一 import 点；revoke timer unref）；bridge deps 增 `armExec`/`resume`；`internalExec` 路由 `new`/`resume` 两 op；`session_shutdown` 增 `resumeExec.onSessionBoundary()` + `resumeList.onShutdown()`；`resumeFeatures` closure 进两个 `readStatus` 调用点（publishStatus + snapshot）；commands deps 增 `switchInFlight` |
| `status.ts`            | `readStatus` 尾参 `features?: () => string[]\|undefined`，非空 ⇒ `status.features`（≤32×≤64 再裁剪）                                                                                                                                                                                                                                                                                                                                                                                      |
| `resume-list.ts`（新） | §2.4 全量：generation 构建（readdir+lstat 候选 → `advanceProvenance`（2s/64MiB，signal）→ ≤4-fd gate 下 `openSessionNoFollowAsync`+`readSessionHeadFd`）；行过滤（cwd 匹配、D1 sub 剔除、重复 id 全略 + `ambiguous`）；排序 (mtime desc, id asc)；q 标题过滤；分页 ≤100 行/≤32KiB、cursor `<gen>.<offset>.<qHash>`、失效 ⇒ `reset:true`；gen 生命周期（10s 复用/120s 惰性丢弃/单飞/每 scope 1 gen）；shutdown fence（epoch+AbortController，旧 epoch 完成永不安装）                       |
| `resume-exec.ts`（新） | §2.5 全量：`createExecGate`（/new+resume 共享 claim）；同步 `pick`（7 步）；`internalExecResume`（a CAS → b 全同步复验 → c 切换 + `switchInFlight` → d withSession 三重校验 → finally 单一 late 出口）；边界撤销 armed 票据                                                                                                                                                                                                                                                               |

## §2.5 步骤 → 代码

| 步骤                                                                                                                                                                                                             | 位置                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1 expect 检查                                                                                                                                                                                                    | `builtin-bridge.ts:377`（既有），resume 未被调用（测试 builtin-bridge.test.ts "expect mismatch"） |
| 2 busy ⇒ `E_COMMAND_DENIED` retryable `resume:busy`                                                                                                                                                              | `resume-exec.ts:230-233`                                                                          |
| 3 共享 exec claim ⇒ `exec:in-flight`                                                                                                                                                                             | `resume-exec.ts:51`（gate）、`:243`（pick）、`builtin-bridge.ts:335`（/new 侧）、`index.ts:397`   |
| 4 gen 索引查不到 ⇒ `E_NOT_FOUND resume:stale-list`                                                                                                                                                               | `resume-exec.ts:246-250`                                                                          |
| 5 绑定 source+target 的一次性票据                                                                                                                                                                                | `resume-exec.ts:252-268`（含 `deadlineAt = now+min(opTotal,5000)`）                               |
| 6 `pi.sendUserMessage("/webhub __exec resume <nonce>", followUp+expand)`；sync throw ⇒ 撤销+释放+`E_STALE_CTX` none                                                                                              | `resume-exec.ts:269-281`                                                                          |
| 7 同步查 state：rejected ⇒ 同步错误回复；switching ⇒ ok async；armed ⇒ unref'd revoke timer（赢 CAS ⇒ late `E_DEADLINE` retryable:false）                                                                        | `resume-exec.ts:283-303`                                                                          |
| a CAS armed→validating，否则 no-op                                                                                                                                                                               | `resume-exec.ts:291-293`                                                                          |
| b 全同步复验（source id+file、idle、deadline、O_NOFOLLOW 打开、dev/ino、header id/cwd/child、provenance `!has`、非当前文件、D5-a size/mtime+30s 除非 confirm）                                                   | `resume-exec.ts:295-346`（fd `finally` 关闭）                                                     |
| c switching + `switchInFlight` + `await ctx.switchSession(path,{withSession})`                                                                                                                                   | `resume-exec.ts:349-394`；web prompt 拒绝 `commands.ts:263-265`                                   |
| d withSession 验 id+path+**dev/ino** ⇒ late ok / `resume:mismatch` effect unknown / `resume:cancelled` / throw ⇒ unknown；finally：释放 claim、清 flag、drop ticket、**恰好一个** late，失败全部 retryable:false | `resume-exec.ts:363-417`                                                                          |
| 边界：armed 票据撤销 → late `E_SESSION_CHANGED`                                                                                                                                                                  | `resume-exec.ts:419-422` + `index.ts:1289`                                                        |

## §4 P2 测试 → 文件

- **list**（`resume-list.test.ts` 16 例）：共享 sessionDir 异 cwd 排除、重复 id+ambiguous、自定义文件名、**种子 property**（`resume-list-bounds.test.ts`，5 seeds：行集/排序/标题≤120 无 C0 不裂代理对/cursor 走满=total/重复 id 不出现）、宽 CJK 标题触发 32KiB 页上限、2000 行上限+truncated、5s 墙钟（假钟每 open +400ms）⇒ partial、64MiB 预算（真实 66KiB 文件×1100）⇒ partial、5001 文件 ⇒ truncated 且最新保留、双 scope 并发 ⇒ ≤4 fd（held-fd 计数）、边界 abort + 旧 epoch 完成不装 gen + signal.aborted、cursor 在 gen 变更与 q 变更时 reset、稳定排序。
- **open discipline**（`resume-open-discipline.test.ts` 5 例）：list 打开/`exec` 复验/真实 `advanceProvenance` 遇无写者 FIFO 均 2-4s 硬超时内返回；`/dev/null` 符号链接（O_NOFOLLOW）与裸设备节点（非 regular）拒绝；`withHardDeadline` 内嵌 fd 基线断言（每个成功/失败路径后 `/proc/self/fd` 回基线）。
- **pick**（`resume-exec.test.ts` 25 例）：busy/pending/claim/stale-list/坏参数/expect-mismatch 均**不调用 sendUserMessage**；复验拒绝全表（source 变、变忙、删除、temp+rename 换 inode、符号链接换、header id/cwd 变、追加 child 标记、当前文件、D5 touched、D5 mtime<30s、deadline 过）；temp+rename 的**切换后同 id 同路径换新 inode ⇒ `resume:mismatch` effect unknown**（r2 #3）；withSession 异 id ⇒ mismatch；cancelled/throw；**deferred re-entry 超 deadline ⇒ 撤销后永不再切换**（r1 #1 锚点：deferred exec 返回 false、switchCalls 空、lates 恰 1）；并发 pick、pick vs /new（双向）、边界撤销、late 全部 retryable:false、恰好一个 late。
- **commands**（`commands-resume.test.ts` 5 例 + commands.test.ts fake 增 `isQuiet`）：thenable 稳定一次、回复带全量 sessions、ledger 剥离、无 notify、超时 `resume:scanning` + 删除 ledger + late 丢弃、rejected ⇒ `E_UNSUPPORTED` 一次、**其余 op 保持纯同步**（R4 pin）、`switchInFlight` 拒 prompt 且窗口关闭后恢复。
- **policy/bridge/status/protocol**：command-policy.test.ts +5（§2.7 全规则）、builtin-bridge.test.ts +7（含 `exec:in-flight`、`isQuiet`、override deny）、status.test.ts +3（features 缺席/携带/裁剪）、`protocol/resume-wire.test.ts` 6（features 现行 schema 可解码、无 features 帧不受影响、**pre-change schema 接受带 features 的帧**（F9 pin）、上限拒绝、cmd_result 带 `data.sessions` verbatim 通过）。
- **wiring**（`wiring-resume.test.ts` 3 例，真 socket 假 hub）：`__list` 端到端；`__pick` → `/webhub __exec resume <nonce>` → 真 `switchSession` → 恰一个 `cmd_late` ok + nonce 重放拒绝；status `features:["resume.v1"]` 出现/`resume:"deny"` override 下缺席。

## 偏差与理由

1. **`src/commands/webhub.ts` 未改**（在我的独占清单内）：`__exec` 分支已把整个尾部透传给 `internalExec`（`resume <nonce>` 免费搭车），无效 nonce 的终端警告文案也已覆盖 resume；`internalExec` 的 resume 路由在 `index.ts:1601`。
2. **§2.7 feature 信号加了一个合取 `webCommands !== false`**（冻结条文只写 control/persisted/policy）：`webCommands=false` 时 hub 不广播 `command.v1`，resume 的 command op 不可达，广告功能只会暴露必败路径——严格更保守的子集。
3. **行上限 2000 也置 `truncated:true`**（条文只把 truncated 绑定 5000 文件上限）：截断了列表就如实标注；字节/时间预算触发的是 `partial`。
4. **`internalExecResume` 返回 boolean**：`true` = nonce 匹配 armed 票据的合法 re-entry（即使随后被拒绝——结果已同步/late 送出，无终端警告）；`false` = 无效/过期/已撤销 nonce（`{ok:false}` ⇒ 终端警告），与 §2.5 a 的「no-op, terminal warning」对应。
5. **revoke timer 的 late 用 `resume:deadline`**（条文未定消息）：与 `resume:scanning`（读超时）区分。
6. **fs gate 为 wireWebHub 闭包级**（非字面 process-wide）：遵守仓库「模块级无可变状态」铁律；两个 scope 共享同一 gate，provenance advance 在 head 读之前串行完成，我这侧打开的 fd 永不超过 4。
7. **/new 的 arm 语义从「覆盖」变「忙拒」**：即 R4 所述「仅新增 claim 检查」；现有 wiring-control 的 nonce TTL/重放/边界全套测试保持绿。

## 自验（真实输出）

```
$ timeout 600 npx vitest run tests/web-hub/agent tests/web-hub/protocol tests/web-hub/hub/caps-coexist.test.ts
 Test Files  94 passed (94)
      Tests  2206 passed | 3 skipped (2209)
   Duration  8.67s

$ timeout 300 npm run typecheck ; echo EXIT
EXIT=0   （tsc main + tsconfig.typecheck + vue-tsc 全过；期间 P3 的 ui 文件曾报错，属并行包在制文件，终跑时 P3 已修复，非本包改动）

$ npx prettier --check <20 个改动/新增文件>
All matched files use Prettier code style!
```

额外（超出要求、确认共享文件未破坏他人）：`npx vitest run tests/web-hub` → **436 files / 9163 passed**；`npm run build` → **EXIT 0**。

## 遗留问题

- 无已知失败。W1（swap-back 不可检测）与 W2（idle 打开不可检测）按计划 §2.5 作为已披露残差写入 `resume-exec.ts` 模块头注释；P4 负责 AGENTS.md/acceptance 文档化。
- P3 的 UI（`queryCommand`、ResumeDialog 等）与 P4（conformance C1-C5、文档）为并行包范围，尚未合入验收。
