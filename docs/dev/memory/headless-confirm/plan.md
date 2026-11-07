# headless 弹卡确认（memory 用户令守卫 → web 弹卡）方案 v2

> **已作废（2026-11 #26）**：memory 用户令守卫的人工确认（本方案的 web 弹卡，及其替代的 TUI 确认框）已整体移除——agent 改动/删除用户令现在直接写入，主会话 TUI 发一条 warning 通知。见 `../no-user-guard-confirm/plan.md`。本文仅作历史记录保留。

> 状态：v2 修订（评审 r_C5QVZCQ7 打回后修订，逐条闭合 1 Blocker + 5 Major + 2 Minor）。
> 需求：web-hub spawn 的 headless 会话中，memory 用户令守卫的确认从「永远拒绝」变为「web 弹卡，用户点确认/拒绝」。

## 问题机制

`src/memory/tool-v2.ts` `prepareJevGuard` / `prepareJevDeleteGuard` 触及用户令条目时需确认：

- TUI 主会话：`ctx.ui.confirm` 弹框，正常。
- **web-hub spawn headless 会话**：rpc 模式 `hasUI=true`，但 hub `rpc-stdio.ts:273-277` 对除 ask_user marker 外的对话框方法立即回 `cancelled:true` ⇒ 秒回 false ⇒ REFUSE，死锁。
- print 模式（noOp UI）与子会话：硬拒绝，**本 feature 不改变这两个场景**。

## 方案：候选 B —— ask_user 远程通道包装 confirm

复用 `AskUserRemotePort`，把守卫确认表达为「1 问题 2 选项（确认/取消）」的 dialog 卡。对照实现 `src/topic-switch/confirm.ts`。

### 改动清单

| 文件                    | 改动                                                                                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`          | `wireMemory` 传入 `remote: () => askUserRemoteRef.current?.()`（**getter 执行时取**，不得快照未赋值端口）                                                                                                                                                                               |
| `src/memory/index.ts`   | `WireMemoryOpts` + `createMemoryToolV2` deps 加可选 `remote` getter；**闭包管理会话级 AbortController：`session_start` 更换、`shutdown` 时 abort，经 getter 传给工具；每次工具调用捕获当时 signal，不得跨会话沿用**（复审 #2 闭合：现有接线无可复用会话 AbortController，此为新增接线） |
| `src/memory/tool-v2.ts` | 两个 prepare 守卫：touched 非空且 remote 可用 ⇒ 远程确认卡（仲裁/生命周期/敏感保护见下）；remote 不可用 ⇒ 现有路径逐字节不变                                                                                                                                                            |
| `src/memory/tool-v2.ts` | 工具 `execute` 的 `signal` 与 `_toolCallId` 传入两个 prepare 守卫（现状未传）                                                                                                                                                                                                           |

### 敏感内容保护（Blocker #1）

- `touchedUserEntries` 会触及 private/secret 用户令（不排除），现有卡面拼 `firstLineOf(e.body)`——**远程卡/飞书卡一律不得包含条目正文**。
- 远程卡文本只含：文件名 + 触及条目数量 + 不含正文的标识（序号/行号区间；heading 同样视为敏感，不使用）。
- **不得**通过从 touched 集合剔除敏感条目来绕过守卫——敏感条目的确认要求原样保留。
- 测试：private、secret、普通条目混合场景下 web/飞书卡面无泄漏。

### 仲裁契约（Major #4）

对照 `topic-switch/confirm.ts` + `ask-user/remote.ts` 的成品语义，不用裸 `Promise.race`：

- `createDialogRace().claim()` **同步仲裁**：web 回调同步返回是否获胜；web 胜出的关闭由 bridge 完成，其他获胜路径负责 `close`。
- 结算动作：abort 本地框（独立 AbortSignal）、清 timer、移除监听、忽略迟到回调。
- 远程问题 `allowOther:false`、单选；**只有明确肯定选项允许提交**，skip/取消/未知值均拒绝。
- 本地 confirm 与远程自管超时**共用同一 `confirmTimeoutMs` 预算**；远程 port 无自带超时，守卫兜底。
- rpc 单通道以 `open()` 成功取得 session 为准（非仅 getter 非空）。回退分两种条件（复审 #4/#7 裁定）：**getter 无 port**（remote 功能 off/未接线）⇒ 现有路径逐字节不变（含 rpc 下原生 confirm 秒回 cancelled 的现状）；**port 存在但 `open()` 返回 undefined/抛错** ⇒ TUI 回退本地 confirm，rpc 直接拒绝（此场景属「已尝试远程且失败」，不在字节兼容承诺内）。

### 生命周期与取消（Major #2、#3）

- `detachAll()` 只关闭显示记录、**不结算等待中的 Promise**——不得依赖它。
- 守卫持有串联 AbortSignal：**工具 signal + 会话 shutdown/reload 生命周期 signal**。任一触发 ⇒ 先冻结仲裁（此后任何答案无效）→ 关闭远程卡 + abort 本地框 ⇒ 结算 REFUSE。
- 取消检查点：远程确认返回后、目录锁内提交前各查一次；已取消操作绝不落盘。
- 补测：等待时 abort、确认后等锁时 abort、abort 后迟到肯定回答。

### 版本与 CAS 契约（Major #5）

- **确认成功 ≠ 提交成功**。批准只绑定：预读文件 baseline（dev/ino/size/mode/ctime）+ 原请求 + touched 快照。
- 等待期间目标文件**任何**变化（含无关修改、新增/删除用户令、删除重建）⇒ 现有 CAS 保守拒绝，返回并发错误，要求重新 view + 重新请求 + 重新确认。
- **禁止**确认后刷新 baseline、或重算 touched 后沿用旧批准；失败不得覆盖并发写入、不得输出成功 voided 回显。
- 其他文件/侧车变化不影响目标文件批准。

### 确认实例与超时时限（Minor #8）

- 每次确认实例以工具 `_toolCallId` 生成唯一 ID（bridge 以 `ask:${toolCallId}` 为 Map key，重复会覆盖）；两个守卫均需传入。
- 默认 `confirmTimeoutMs` 60s 不支持分钟级作答：需要更长等待时调整 `memory.jev.confirmTimeoutS`（上限 600s），卡面文本提示确认时限。

### wire / golden 表述（Minor #7）

- 准确表述：**wire 协议形状不变**（`DialogWire.source` 保持 `"ask_user"`、应答走既有 `dialog_answer`、caps 沿用 `dialog.v1`，无需改 schema/caps/PROTO）；确认卡本身会新增 dialogs 帧属正常业务流量。
- off 路径（**getter 无 port**）逐字节现状由测试证明，不靠推理；port 存在但 open 失败的 rpc 拒绝属刻意行为变更，需单独测试。
- 可选归因增强（`attributePrompt` 按 title 归因）需传入 `attributionTitle` 并解决同标题并发匹配；若不做则接受双渲染，不宣称天然消除。

## 明确不做

- 不改 `rpc-stdio.ts` 的 D9 行为；不做 owner-only 确权；不做飞书侧新卡；print/子会话维持硬拒绝。

## 验收标准（修订）

1. headless spawn 会话删改用户令条目 ⇒ web 弹卡；点确认 **且文件版本未变** ⇒ 写入生效；版本已变 ⇒ 并发错误需重新确认；点取消/超时/abort/reload ⇒ REFUSE 且文件不变。
2. TUI 主会话：本地弹框与 web 卡竞速，先到先赢、败方完整清理。
3. remote 不可用 ⇒ 现有路径逐字节不变（测试证明）。
4. print、子会话仍硬拒绝。
5. 敏感条目正文不出现在任何远程卡面。

## 测试矩阵（逐项断言，Major #6）

- 两个守卫 ×（TUI 胜 / web 胜 / 冲突回答 / 超时 / 工具 abort / reload / open undefined / open throw）
- rpc 场景 `ctx.ui.confirm` **调用次数为零**
- 超时后迟到答案得 `E_DIALOG_CLOSED`；**有效肯定回答且版本有效时提交一次，其余分支（取消/超时/abort/拒绝）零提交；相同 baseline 的竞争批准最多一次提交，后续调用拒绝并保留已提交版本；锁等待测试的变化发生在取得锁前**（复审 #6 断言措辞修正）
- 敏感内容不外发（private/secret/混合）
- CAS：长等待后同文件无关修改、新增用户令、删除重建、两次确认竞争、锁等待期间变化 ⇒ 全部保守拒绝且保留并发版本
- **真实 managed headless spawn 链路**验证（真 hub + 真 spawn 子进程），不以 `mode:"rpc"` fakeCtx 替代
- frozen golden 不刷新；off 路径字节兼容测试

## 评审记录

- 第一轮（r_C5QVZCQ7）：打回，1 Blocker（敏感正文泄漏）+ 5 Major + 2 Minor ⇒ v2 全部修订。
- 第二轮（r_52J65XBA）：#1/#3/#5/#8 闭合；#2 补生命周期接线入改动清单；#4/#7 rpc 回退两条件区分；#6 断言措辞修正——**按收敛规则两轮后主会话裁定闭合，不开第三轮**。

## 风险

仲裁与生命周期是主要复杂度，全部有 topic-switch 成品对照；敏感保护与 CAS 契约为新增硬约束。
