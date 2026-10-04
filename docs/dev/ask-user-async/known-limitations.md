# ask_user 后台打断：已知限制（plan §9 实测记录）

> 伴随 `plan.md`（v2，评审通过）§9「威胁与风险」。本文记录**实测行为**（pi 0.87.1，
> `tests/conformance/ask-user-interrupt-keys.test.ts` + S0 `tests/conformance/ask-user-interrupt.test.ts`
> 钉死），不是推测。机制设计见 plan.md；本文只写限制与实测结论。

## 1. 关闭瞬间的按键落点（§9「焦点被抢」残余）

打断触发时 `showExtensionCustom.close()` 同步恢复编辑器（焦点 + 用户此前的草稿）。与关闭
同瞬间到达的按键会落在**编辑器**而不是对话框上。实测：

| 按键       | 时机                 | 实测行为                                                                                                                                | 风险                                                       |
| ---------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 可打印字符 | 任意                 | 追加进编辑器草稿（S0 C2/C5b：`draft-xyz` + `abc` = `draft-xyzabc`）                                                                     | 无害                                                       |
| Enter      | agent 仍在 streaming | 编辑器把草稿以 `streamingBehavior:"steer"` 提交，作为 user 文本消息注入**下一次模型请求**；编辑器清空                                   | 草稿被当成新指令发给模型                                   |
| Enter      | agent 已空闲         | 草稿进入 `pendingUserInputs`，由 REPL 输入循环作为下一条用户消息提交（production 行为；conformance harness 不跑该循环，钉的是队列本身） | 同上                                                       |
| Esc        | agent 仍在 streaming | pi 中止在途 agent 工作：挂起的 tool call 以 `Operation aborted` toolResult 落地，run 随后继续模型的下一步；编辑器草稿保留               | **§9 点名残余**：用户连按 Esc 想关对话框，实际中断了 agent |
| Esc        | agent 已空闲         | 清空编辑器草稿                                                                                                                          | 草稿丢失（用户输入的）                                     |

缓解（已在机制内）：安静期 `quietMs`（打字中不落下）、重问驻留 `reaskDwellMs`、框内
`⏸ N bg done · pausing when idle` 预告行、打断后 ask_user 组件草稿按指纹恢复（组件草稿
与编辑器草稿是两份，组件草稿由 parked 注册表恢复）。

残余接受：用户恰好在中断落下瞬间按 Enter/Esc 的概率低，且 Enter 的后果（草稿作为 steer
消息发出）与用户在框关闭后自己按 Enter 完全等价——pi 对「框外按键」的语义本来如此。

## 2. 预算耗尽后的阻塞（§5.2.4，用户拍板的降级）

同一问题打断 `maxPerQuestion`（默认 3）次后，该次 ask_user 回到功能前的阻塞行为：完成
通知照常进 steer 队列等待，框内指示切为 `⏸ N bg done · answer to continue`，直到用户
回答或 Esc。最坏情况 = 今天的行为，不会更坏。

## 3. 模型重问是尽力而非保证（§4，评审 #11）

打断后由**模型**重新调用 ask_user；扩展只做草稿恢复、防抖、parked 持久化、状态栏
`ask⏸N`、`agent_settled` 一次中文 notify、compact 后 `triggerTurn:false` 提醒消息。模型
可能不重问（此时题目留在 parked 注册表与状态栏，等下一轮或用户提起），也可能无视结果
文本自行代答（结果文本明令禁止，真机抽样验收见 plan §10 P1-11，不达标只改文本不改机制）。

## 4. RPC 模式默认关；开启后的客户端残留（§7.1）

`backgroundInterrupt.rpc = false`（默认）：RPC 路径与功能前逐字节一致，不提供中途打断、
不做开框前 deferred。`rpc = true` 时打断经 `localAbort` 生效，但 pi 的 RPC
`createDialogPromise` 只在本地 resolve——**客户端对话框不被撤回**，迟到的回答被丢弃；
重问会产生新的 `extension_ui_request`。撤回/关联需要 pi 的 RPC 协议支持，不在本方案范围。

## 5. 投递记账依赖 pi 内部语义（§2.4、§3.2 兼容假设 A1–A4）

token 确认依赖：streaming 中 `sendMessage(triggerTurn:true)` 同步入队（A1）、注入时
`message_start` 内容不改写（A2）、boundary 顺序=入队顺序（A3）、空闲 send 立即起 run（A4）。
全部由 S0 conformance（C6–C11）钉在当前 pi 版本；pi 升级前必跑
`npm run test:conformance`。运行期兜底：连续 2 次 orphan 自检失败 ⇒ 进程内停用打断
（P2 实现），WARN 一次。

## 6. 旧 web hub 的 dialogs 帧冻结（§7.2，P3 处理）

`closed[].by` 新增 `"background"` 后，运行时 schema 未升级的旧 hub 会丢弃整个 dialogs
帧（`closed` 记录保留 120s / 8 条期间 web 端对话框列表冻结）。P3 用 hub cap
`dialog.bg.v1` 降级为 `"abort"` 解决。P1 单独存在时打断机制没有接线（端口由 P2 注入），
不会触发该路径。
