# 实现备注（headless-confirm plan v2）

> **已作废（2026-11 #26）**：memory 用户令守卫的人工确认（本方案的 web 弹卡，及其替代的 TUI 确认框）已整体移除——agent 改动/删除用户令现在直接写入，主会话 TUI 发一条 warning 通知。见 `../no-user-guard-confirm/plan.md`。本文仅作历史记录保留。

方案：`plan.md`（v2，不动）。本文件记录实现与方案的出入与遗留，按方案评审编号对应。

## 与方案的出入

1. **会话 AbortController 的位置（方案改动清单第 2 行 ⇒ 移至 `src/index.ts`）**
   方案写「`src/memory/index.ts` 闭包管理会话级 AbortController：`session_start` 更换、`shutdown` 时 abort」。实现把 controller 放在 `src/index.ts` 的 activate 闭包，swap/abort **并入主会话现有的 `session_start` / `session_shutdown` 注册**（不新增 hook 注册），经 `wireMemory` opts 的 `sessionSignal` getter 传入工具。
   原因：`tests/memory/jev/off-golden.test.ts`（A 级冻结 golden）按字节钉住 `wireMemory` 的 hook 注册列表——在 `wireMemory` 内新增任何 `pi.on` 注册都会改变 golden 的 `registrations` 数组（实现过程中实测打红过）。并入主会话现有注册使 golden 逐字节不变。
   语义差异：child 会话不持有 session signal（`isChildSession` 守卫在确认之前就硬拒绝，child 从不进入确认流程，不受影响）。governance `activate-trace.json` 亦不受影响（无新增注册）。

2. **锁内取消检查点的携带范围（方案 Major #2/#3）**
   `commitSignal` 只在「确认实际发生」的 plan 上携带（skip 型 plan 不带）。未经过确认的写入行为与现状逐字节一致——包括现状下「工具 signal abort 后仍照常提交」的行为（未改动）；已确认的写入在锁内提交前 re-check（新增 REFUSE，`assertCommitNotAborted`）。「取消检查点 1」（远程确认返回后）在两个守卫内、`guardConfirm` 返回后立即执行。

3. **attributionTitle 未传（方案 Minor #7 允许）**
   接受双渲染：`attributePrompt` 现只匹配 `kind:"custom"`/`"select"` 与 ask_user marker，`kind:"confirm"` 的标题归因需改 `src/web-hub/agent/dialogs.ts`（不在本任务文件域）。TUI 竞速下 web 面板可能出现已归因确认卡 + 本地框的未归因 banner；rpc/headless（本 feature 主场景）单卡，无双渲染。

4. **rpc + `setOnRemote` throw 的退化路径**
   对照 `topic-switch/confirm.ts` 的语义：degrade to local-only。rpc 下该路径会调用一次 `ctx.ui.confirm`（被 hub 立即回 `cancelled` ⇒ false ⇒ REFUSE）。「rpc 场景 confirm 调用次数为零」的矩阵断言针对 web 正常路径（`useWeb=true`），两者不冲突。

## 卡面契约

- 确认 label：`确认执行`；取消 label：`取消`；header：`用户令确认`（web answers 的 key）。
- 卡面：文件名 + 触及条目数 + `条目 #<ordinal>（L<start>-<end>）`（无正文、无 heading）+ 确认时限秒数提示。本地 TUI 弹框保持现状正文（own terminal）。
- bridge 实例 ID：`ask:memory:<toolCallId>`（bridge 以 `ask:` 前缀建 Map key）。

## 测试矩阵落点

- 单测（fake port / controlled confirm，全矩阵）：`tests/memory/tool-v2-jev-remote-confirm.test.ts`（27 tests：两守卫 × TUI 胜/web 胜/冲突/decline/cancel/未知值/超时/open undefined/open throw、rpc confirm 零调用、工具 abort、session abort、abort 后迟到肯定回答、确认后 checkpoint、锁内 checkpoint（外部 `lockCreate` 占锁）、CAS 三场景、敏感内容、实例 ID、off 逐字节、print 拒绝）。
- 集成（真 `wireWebHub` dialogBridge + 真 unix socket + 真 `dialogs` 帧 + 真 `dialog_answer` cmd 回程 × 真守卫真写盘）：`tests/integration/memory-headless-confirm.test.ts`（3 tests：web 确认提交 / web 拒绝保持 / 卡开着并发改文件 CAS 保守拒绝 + wire 帧敏感内容断言）。

## 遗留

- **真 managed spawn 子进程一跳未覆盖**（矩阵最后一条）：hub supervisor fork 真 `pi --mode rpc` 子进程加载本扩展的链路。现有 fake-rpc-pi fixture 不加载扩展；真 pi 需要 scripted model provider（本地 fake 模型端点 + spawn 配置），属新夹具面。本任务交付到 harness 级（见上）。是否补真 spawn 链路由主会话裁定。
- `memory.jev.confirmTimeoutS` 设置键（方案 Minor #8 提到的更长时限调整通道）：现状配置面只有 `confirmTimeoutMs`（settings 已有键），卡面按 `confirmTimeoutMs` 换算秒数提示；未新增 `confirmTimeoutS` 别名键（方案原文为「需要更长等待时调整」的表述，现有键已满足；新增键涉及 settings 表与 golden，未做）。
