# #20 xs 错配警告（expectReply × deliver-only × 目标空闲）— 实施计划

> 2026-11-05 · 方案制定 · 输入：`explore.md`（同目录，2026-11-05 dev f86860e4 行号）、`docs/dev/fabric-xs-activation/{arch,plan}.md`（#14 已实现）。
> 本计划只做分包与验收安排；已实现的四阶段/默认 wake/wake_session 契约以 #14 arch 为准，不重开。
> 2026-11-05 r2：按评审（GPT，有条件通过，0 Blocker）5 条修订，主线（无 hub busy、只放 hint、A→B 串行）不变；处置表见 §6。
> 2026-11-05 r3：复审闭合最后 1 条——C12 移出独立合取条件（保留为防御性检查），负例规则改为「独立条件单独翻转 + 蕴含/缺失条件用组合负例」（§2、§3 包 A 测试 1、§6 第 3 条）。

## 0. 需求（用户已确认）与不做项

1. `message_session` 满足「expectReply 已设 ∧ 实际 wake=false（显式或省略后的默认）∧ 发送时目标会话 idle」时，工具结果附 warning，**不阻断**发送；提示大概率超时，补救＝`wake_session` 激活这条已送达请求（未送达时才 `wake:true` 重发）。
2. 不误报：可信人类代发默认升级 wake 的路径不告警；已有 `wakeDowngraded` / 本地降级原因时不重复。
3. 超时通知区分「停在 delivered（没处理）」与「停在 started（处理了没回）」——按**观测口径**表述（§1 D5）；进度未知时文本逐字节不变。

不做：阻断发送；新增 `list`/`resolve` 往返；改 message_session schema / `LEGACY_DESCRIPTION` / 任何工具描述；新工具或注册；改 wire 协议（含 hub `targetOf`）；子会话（human-runtime 代发路径）告警。
验收：A 级 golden（`fabric-xs-off` / `fabric-wake-off` / `fabric-xs-reply-off`）不变；I9 off 与 legacy（老 hub×新 agent、新 hub×老 agent）字节不变；I10 不新增 wire 字段（本方案零 wire 改动）；定向测试 + 全量绿。

**可见面（已接受取舍）**：warning 只出现在 `message_session` 工具结果的**文本**里（模型可见；Web transcript 的 ToolCard 输出可见）。结构化 xs 请求面板（`StatusInfo.xsRequests`）、`details` 以及只读 details 的调用方（mention 投影、web 控制面）**看不到**它。本方案不承诺「所有 UI 面都会告警」。超时通知是会话内的 custom message，在 transcript 中可见。

## 1. 关键决策（与 explore 的偏离先说清）

### D1 「目标 idle」取自接收端投递证据，**不新增 hub `busy` 字段**（偏离 explore §5.1–5.2）

**限定命题**（不是 ⇔）：在**当前接收实现**中，对一个**首次处理的、新的、非回复、deliver-only**请求，`effect:"applied"` 说明三件事：接收端在采样时刻 `idleBefore = safeIsIdle()`（`receiver.ts:534`，在 `sendMessage` 之前采样）判定目标空闲；写入后 leaf 匹配本 xid；fence 校验通过（`receiver.ts:532-609`）。另外这次写入是 `triggerTurn:false`，不会触发回合。

反方向**不成立**：`unknown` 不证明目标忙。反例如下。

- idle 但 leaf 不匹配 ⇒ `unknown{accept_unverified}`（`receiver.ts:594-597`，已有测试 `tests/fabric/xs-receiver.test.ts:287-317`）。
- fence 写后校验失败 ⇒ `unknown{accept_unverified}`。
- 流式中 ⇒ `unknown{queued}`。

dedup 重放（`receiver.ts:372-376`）会原样返回历史判决，其中可能有历史上的 `applied`。但每次新 send 都由 hub 生成新 xid，不会命中本次告警。

竞态：采样时刻到写入完成之间，或写入期间，如果发生重入（例如 sendMessage 回调里有人类输入或续轮启动回合），判决仍是 `applied`，但目标随后会处理这条消息，于是 warning 成为误报。这个残留可以接受（只是 warning），见 §4。

不用 hub `busy` 的理由：

- (a) resolve 时刻的快照有 resolve→send 竞态。
- (b) `registry.ts:318` 在 status 缺失时会把 busy 读成 `false`，导致误报。
- (c) 要改 hub、bridge、`XsPortReply` 三处，并要做 legacy 四组合。

结论：**不加 `busy` 字段，也不存在 busy 门控**。

### D2 放置：**只在 hint 里给 warning，不加 outcome 字段**

| 选项                                  | 模型可见                                 | 影响                                                                         | 结论  |
| ------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- | ----- |
| outcome 新字段                        | 可见（JSON）                             | JSON / `details` 字节变；mention、web 投影要决定透不透；仍需另写散文说明补救 | ✗     |
| **仅 hint（中文散文追加在 JSON 后）** | 可见（与 `xsWakeDowngradedHint` 同通道） | `outcome` / `details` 零变化；判定字段都已在 outcome 中，工具侧用纯函数算    | **✓** |

sender **不改**。

### D3 门控：**最终门控只看 `deps.idleWakeAdvice === true`**（二选一已定）

`MessageSessionToolDeps` 新增可选项 `idleWakeAdvice?: boolean`，值在 activate 时冻结。唯一写入点是 `src/fabric/xs/activate.ts`：在 `activateOn`（= `xsOn ∧ activation.enabled ∧ fabric.wake.enabled`，`activate.ts:99`）时传 `true`。该代码块是 post-guard 主会话注册，所以这个值已经包含「activation ∧ wake ∧ 主会话」。`src/runtime/human-runtime.ts` 不传。

execute 中的最终门控：`deps.idleWakeAdvice === true && xsIdleNoWakeRisk(outcome)`。**不再叠加** `deps.activation` 或 `replyOn` 检查，理由有两点：

- 二者都已被 `idleWakeAdvice` 的写入条件蕴含（activate.ts 只在 `activationOn` 时传 `activation:true`）。
- 「expectReply 已设」由谓词中的 `reply?.state==="pending"` 判定，只有 reply 实例才可能产生这个状态。

只保留一个门控契约，测试和实现才能逐条对应。

### D4 中文 warning 文案（逐字，常量 `XS_IDLE_NO_WAKE_HINT`，导出）

```
注意：本次 expectReply 未请求唤醒，且投递时（接收端采样）对方会话空闲——这次写入不会触发对方处理，大概率等到超时也收不到回复。正文已送达，不要重发；需要对方处理请调用 wake_session（action "activate"，to 用本结果 to.ref，messageId/activationKey 取本结果 track）激活这条请求。只有正文未送达（effect none）时才改用 wake:true 重发。
```

追加方式为 `\n${XS_IDLE_NO_WAKE_HINT}`，位置在现有全部 hint 之后（`message-session-tool.ts:190` 之后）。它与 `wakeDowngraded` hint 互斥（§2）。

### D5 超时通知 phase 标记——**观测口径**（英文紧凑标记，逐字）+ 条件中文尾句

source 镜像中的 phase 是「保留最远事实」的格（`progress.ts:24-36`）。过期记录只在读取时把 `observation` 覆盖成 `"expired"`，不清除 phase（`progress.ts:382-391`）。started 证据依赖 context 扫描（≤2000 条，`stack.ts:678-701`）和 `xs_state` 推送送达，两者都可能漏记。因此标记只表达「最后观测到的事实」，**不声称单凭同步镜像就能确定对方当前没有在处理**。

`buildTimeoutNoticeContent` 在每条明细行 `- <requestId> → <ref>（截止 <iso>）` 末尾追加：

| 端口返回（仅 live 观测，见 D6）           | 行尾追加（逐字，前导一个空格） |
| ----------------------------------------- | ------------------------------ |
| `queued`                                  | ` · last seen queued`          |
| `delivered`                               | ` · last seen delivered`       |
| `started`                                 | ` · started seen`              |
| `replied` / `undefined` / 抛错 / 端口缺省 | 不追加（原样）                 |

正文末尾（现有「…拒收。」之后）每句前加 `\n`，**仅当至少一行带对应标记时追加**，顺序固定为 delivered 句在前：

- delivered：`标 last seen delivered 的请求：最后观测为已送达，尚无对方开始处理（started）的证明——观测可能滞后或漏记，不代表对方此刻一定没在处理。需要的话可在宽限期内用 wake_session（action "activate"，原发送结果的 track.messageId/activationKey）尝试激活（对方若已开始处理会返回 no-op），不要重发正文。`
- started：`标 started seen 的请求：已观测到对方回合上下文包含该请求，但尚未收到回复；不要重发，宽限期内的回复仍会送达。`

头句不改。全部行都未知时，输出逐字节同现状。通知只出现字段名，不出现 sid / xid / messageId / activationKey 的**值**。

### D6 未知 phase 一律不推测

`progressPhaseOf` 在以下任一情况返回 `undefined`，通知保留原字节：

- 匹配行的 `observation !== "live"`（`offline` / `expired` / `unavailable`）；
- 镜像中没有该行；
- 会话已切换（`mirrorSessionId` 不等于请求方 sid）；
- 同一 requestId 有多行且 phase 不一致；
- activation off，或 hub 不具备 `xs.state.v1`。

gate 内用 `try/catch` 包住端口调用，抛错按 `undefined` 处理。扫描超限、推送未到这类 live 状态下的「漏记」检测不出来，只能靠 D5 的观测口径文案兜底。

## 2. 告警判定（工具侧纯函数 `xsIdleNoWakeRisk(outcome)`）

谓词（11 个合取条件 C1–C11，全部成立才返回 true；另有防御性检查 D-q）：

- C1 `status==="sent"`；C2 `effect==="applied"`；C3 `reply?.state==="pending"`；C4 `replyTo===undefined`；
- C5 `wake!==undefined`；C6 `wake.requested===false`；C7 `wakeDowngraded===undefined`；C8 `woke!==true`；
- C9 `track!==undefined`；C10 `track.activationKey!==undefined`；
- C11 `progress?.phase` 为 `undefined` 或 `"delivered"`。

防御性检查 D-q（**不是**独立合取条件）：`progress?.phase!=="queued"`，专门防御「applied 却 queued」的矛盾数据。它已被 C11 蕴含，实现中可以显式写出也可以省略，测试只用 applied+queued 防御用例钉住结果为 false。依赖关系：C6 依赖 C5（缺 `wake` 时 C6 无从判定），C10 依赖 C9（缺 `track` 时 C10 无从判定）。

最终门控是 `deps.idleWakeAdvice===true ∧ 谓词`（D3）。

| #   | wake 参数                                            | 投递时目标 / effect                                                                 | wakeDowngraded | track.key                  | replyTo | expectReply                                                             | 告警   | 说明                        |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------- | -------------------------- | ------- | ----------------------------------------------------------------------- | ------ | --------------------------- |
| 1   | 显式 false                                           | idle / applied                                                                      | 无             | 有                         | 无      | pending                                                                 | **是** | 主场景                      |
| 2   | 省略未升级（agent 普通 / grant 被并行占用 / 多目标） | idle / applied                                                                      | 无             | 有                         | 无      | pending                                                                 | **是** | `requested:false`           |
| 3   | 省略，人类代发升级（defaulted）                      | idle / applied                                                                      | 无             | 有                         | 无      | pending                                                                 | 否     | C6（需求 2）                |
| 4   | 省略升级后被降级                                     | 任意                                                                                | 有             | 有                         | 无      | pending                                                                 | 否     | C6/C7，已有降级 hint        |
| 5   | 显式 true                                            | idle / applied（woke）                                                              | 无             | 有                         | 无      | pending                                                                 | 否     | C6/C8                       |
| 6   | 显式 true，被降级                                    | 任意                                                                                | 有             | 有                         | 无      | pending                                                                 | 否     | 交给 `xsWakeDowngradedHint` |
| 7   | false / 省略                                         | 流式 / unknown(queued)                                                              | 无             | 有                         | 无      | pending                                                                 | 否     | C2                          |
| 8   | false / 省略                                         | idle 但 leaf 不匹配或 fence 失败 / unknown(accept_unverified)；deadline / link_lost | 无             | 有/无                      | 无      | pending                                                                 | 否     | C2，unknown 不推测          |
| 9   | false / 省略                                         | — / none                                                                            | 无             | —                          | 无      | send_failed                                                             | 否     | C2/C3                       |
| 10  | false / 省略                                         | idle / applied                                                                      | 无             | **无**（legacy、关系袋满） | 无      | pending                                                                 | 否     | C9/C10，并保证字节兼容      |
| 11  | false / 省略                                         | idle / applied                                                                      | 无             | 有                         | 无      | 未设                                                                    | 否     | C3                          |
| 12  | 任意                                                 | idle / applied                                                                      | 无             | 有/无                      | **有**  | —                                                                       | 否     | C4                          |
| 13  | false                                                | idle / applied                                                                      | 无             | 有                         | 无      | pending，但 `idleWakeAdvice` 缺省（wake off / activation off / 子会话） | 否     | D3 门控                     |
| 14  | false                                                | applied，但 phase 为 started / replied / queued（防御）                             | 无             | 有                         | 无      | pending                                                                 | 否     | C11（queued 另由 D-q 防御） |
| 15  | mention（human）                                     | —                                                                                   | —              | —                          | —       | —                                                                       | 否     | 不经过工具                  |

## 3. 分包、依赖与文件域

两包**串行（A → B）**。硬依赖只有一处文件级冲突：两包都要改 `src/fabric/xs/activate.ts`（A 改 :409 的 `createMessageSessionTool` 调用，B 改 :663 的 StackXs 输入块）。另外，混合版本差分测试文件由 A 新建、B 追加。语义上两包互不依赖，因此不提供并行冲突预检 spec。每包完成后由 root 派异源 verifier；一包一个 commit（精确路径）；两包都完成后 push 一次。

### 包 A — 工具 warning（feat(fabric)）

源文件（只改这些）：

- `src/tools/message-session-tool.ts`：deps 增加 `idleWakeAdvice?: boolean`；导出 `XS_IDLE_NO_WAKE_HINT`（D4 逐字）和 `xsIdleNoWakeRisk(outcome: XsSendOutcome): boolean`（C1–C11 + 防御 D-q）；execute 在 `:190` 之后增加 `if (deps.idleWakeAdvice === true && xsIdleNoWakeRisk(outcome)) hint += \`\n${XS_IDLE_NO_WAKE_HINT}\``。描述、schema、`details` 不动。
- `src/fabric/xs/activate.ts`：在 `createMessageSessionTool({...})` 里加 `...(activateOn ? { idleWakeAdvice: true } : {})`，不做其他改动。

测试文件（文件域）：

- 改：`tests/tools/message-session-tool.test.ts`、`tests/fabric/xs-receiver.test.ts`、`tests/integration/fabric-xs-activate-session.test.ts`、`tests/integration/fabric-xs-human-default-wake.test.ts`、`tests/integration/fabric-xs-human-child-runtime.test.ts`。
- 新：`tests/integration/xs-idle-wake-warning-compat.test.ts`（混合版本差分，B 会追加）。
- `tests/mention/**` 不改（mention 白名单无变化），仅原样跑。

测试清单：

1. **纯函数谓词测试**（`message-session-tool.test.ts` 内单独的 describe）。
   - 基准正例 fixture 为 §2 第 1 行；独立条件（C1、C2、C3、C4、C5、C7、C8、C9、C11）各自**单独翻转**一个负例；存在蕴含依赖的条件或字段缺失条件采用**组合负例**：C6 用「`wake` 存在且 `requested:true`」（以 C5 成立为前提），C10 用「`track` 存在但无 `activationKey`」（以 C9 成立为前提）；D-q 用 applied+queued 组合负例。
   - 防御用例：applied 且 `progress.phase:"queued"`；缺 `wake`；`status` 为 `"unanswered"`、`"rejected"` 等非 sent 值；`woke:true`；`track` 存在但无 `activationKey`；phase 为 started 或 replied。
   - 按 §2 表逐行断言谓词。
2. **接线 / 最终 content 测试**（fake sender）。
   - `idleWakeAdvice:true` 且正例 ⇒ content 恰好是 `JSON.stringify(outcome) + 既有 hints + "\n" + XS_IDLE_NO_WAKE_HINT`，hint 位于末尾；`details` 与 outcome 深相等。
   - `idleWakeAdvice` 缺省 ⇒ content 等于测试内冻结的 `renderPre20(outcome)`（改动前 hint 拼装的副本），逐字节相等。
   - 负例 outcome 搭配 `idleWakeAdvice:true` ⇒ 同样等于 `renderPre20`。
   - 不写「activation 缺省仍不告警」之类非契约断言。
3. **receiver 反例**（`xs-receiver.test.ts`，追加）。
   - idle 且 leaf 不匹配：沿用 :287-317，断言 `unknown`，并补一条组合断言：该判决经 fake sender 映射后谓词为 false。
   - 采样后、写入期间重入：`sendMessage` 回调中把 `isIdle` 改为 false ⇒ 判决仍为 `applied`。用测试名钉住这个竞态是有意接受的。
   - dedup 重放：同一 xid 第二次 deliver 返回历史 `applied`，并在注释中写明新 send 必然使用新 xid。
4. **集成**（真实 hub + 两个 stack，三端 `xs.state.v1`，wake on）。
   - 显式 `wake:false` + expectReply 发往 idle 目标 ⇒ content 含 hint，`details` 无新键。
   - `wake:true` ⇒ 无 hint。
   - 目标在回合中 ⇒ `unknown/queued`，无 hint。
   - `fabric.wake.enabled:false` ⇒ 无 hint（验证 activate.ts 接线）。
5. **human 路径**。
   - `human-default-wake`：grant 升级那次 ⇒ 无 hint；同一 input 第二个并行目标 ⇒ 有 hint。
   - `human-child-runtime`：子会话代发满足谓词 ⇒ 无 hint（human-runtime 不传 `idleWakeAdvice`）。
6. **混合版本差分**（新文件，`helpers/fabric-xs-process.ts` 的 `XW_STRIP_STATE` / `XW_HUB_STRIP_STATE` 旋钮）。
   - 两个拓扑：「新请求方 × 旧目标（目标 agent 剥除 state cap）」与「旧 hub（剥除 state cap）× 新请求方」。
   - 每个拓扑都发一条 expectReply + `wake:false`、目标 idle 的请求，断言工具结果 content `=== renderPre20(details)`，逐字节相等。
   - 不能只依赖原有的普通 send 套件。
7. **off / 冻结**：三个 off golden 测试、`tests/integration/fabric-xs-activation.test.ts`（tool surface 与描述冻结）、`tests/governance` 原样跑绿。fixtures diff 为零只证明文件未改动，不能替代行为比较。

门禁（dev 只跑定向测试，**禁止并行跑全量**）：

```
npx vitest run tests/tools/message-session-tool.test.ts tests/fabric/xs-receiver.test.ts tests/fabric/xs-sender-human-grant.test.ts \
  tests/integration/fabric-xs-human-default-wake.test.ts tests/integration/fabric-xs-human-child-runtime.test.ts \
  tests/integration/fabric-xs-activate-session.test.ts tests/integration/fabric-xs-activation-compat.test.ts \
  tests/integration/xs-idle-wake-warning-compat.test.ts tests/integration/fabric-xs-activation.test.ts \
  tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts \
  tests/integration/fabric-xs-reply-off-golden.test.ts tests/governance tests/mention
npm run typecheck && npx prettier --check <改动文件> && git diff --quiet origin/dev -- tests/fixtures/
```

### 包 B — 超时通知 phase（feat(fabric)，依赖 A 已 commit）

源文件：

- `src/fabric/xs/reply-notice.ts`
  - 新增本地类型 `type XsNoticePhase = "queued" | "delivered" | "started" | "replied"`，**不 import protocol**。
  - `XsReplyNoticePorts` 增加可选 `progressOf?(requestId: string): XsNoticePhase | undefined`。
  - `buildTimeoutNoticeContent(tickets, phaseOf?)`：缺省 ⇒ 逐字节同现状；传入时按 D5 渲染。
  - `flush()` 在 `:162` 计算 content 时传入 `(id) => { try { return this.ports.progressOf?.(id); } catch { return undefined; } }`：只读同步数据，**不引入 await**；wake 和 quiet 两条路径共用同一份 content。invalidation 与 dropped summary 不动。
- `src/web-hub/agent/xs.ts`
  - `XsAgentBridge` 增加可选方法 `progressPhaseOf(sessionId, requestId): XsPhase | undefined`。
  - 实现：遇到 D6 的全部条件返回 `undefined`（含 `row.observation !== "live"`）；只读，不改动 `mirrorRevision`，不触发 publish。
- `src/fabric/xs/stack.ts`：`StackXsInput.progressPhaseOf?`，按 `listRows` 的方式晚绑定；`:561` 构造 gate 时，若 input 提供该字段，就把 `progressOf` 写进 gate。
- `src/fabric/xs/activate.ts`：StackXs 输入块在 `activationOn` 时加 `progressPhaseOf: (sid, rid) => webHubRef.current?.xs?.progressPhaseOf?.(sid, rid)`。
- 文档：`docs/dev/fabric-cross-session/README.md` 新增小节「Idle deliver-only warning & timeout phase (#20)」，内容为 D1–D6、可见面取舍、C-X15、§4 残留，同时覆盖包 A 的内容。

测试文件（文件域）：

- 改：`tests/fabric/xs-reply-notice.test.ts`、`tests/web-hub/agent/xs-state-bridge.test.ts`、`tests/conformance/fabric-xs.test.ts`（新增 **C-X15**）、`tests/integration/fabric-xs-activate-session.test.ts`、`tests/integration/xs-idle-wake-warning-compat.test.ts`（追加超时用例）。

测试清单：

1. **渲染**。
   - 不传 phaseOf，或 phaseOf 全返回 `undefined` / `replied` ⇒ 与现有期望（`xs-reply-notice.test.ts:127-224,405-422`）逐字节相等。
   - queued、delivered、started 各一个单 ticket 用例。
   - 多 ticket 混合：仍按 dueAt 排序，标记跟随各自的行，尾句只出现对应的那句且顺序固定。
   - 断言文案中**不出现**「尚未开始处理」「没处理」这类断言式措辞，只出现观测口径的措辞。
2. **gate**：`progressOf` 抛错 ⇒ 输出同未知；wake 与 quiet 两条路径的 content 相同；spy 断言所有调用都落在同一次 `flush()` 同步栈内。
3. **bridge `progressPhaseOf`**。
   - 返回 `undefined` 的情形：observation 为 `offline`、`expired`（构造过 deadline 的行，`rows()` 读时覆盖）、`unavailable`；activation off；hub 无 state cap；会话切换；无行；多行 phase 冲突。
   - live 的 delivered / started ⇒ 返回对应 phase。
   - 调用后 `mirrorRevision` 不变，publish 次数不变。
4. **漏记口径**（stack 级）。
   - 扫描超限：context 消息超过 2000 条、xid 在扫描下限之前 ⇒ 行仍是 live delivered ⇒ 通知为 ` · last seen delivered` 加 delivered 尾句，即观测口径，不误称 started。
   - started 更新未到达：source 镜像丢弃接收端的 started `xs_state` 推送 ⇒ 结果同上。
5. **C-X15（conformance，真实 pi + AnthropicStub，沿用 C-X13 的 `host()`）**。
   - 构造 gate：ticket 的 requestId 与 ref 用固定值，镜像行（或 fake `progressOf`）分别给出 delivered 和 started；在 ticket、行、端口参数中注入哨兵 sid / xid / messageId / activationKey（如 `SID_SENTINEL_x9` 等唯一字符串）。
   - wake 路径：通知进入 provider 请求后，序列化后的 `h.stub.requests` 中能看到 phase 标记与尾句，哨兵值一个都不出现。
   - quiet 路径：随后一次自然 `h.session.prompt(...)` 的 provider 请求同样满足上述断言。
   - 既有的 requestId / ref 文案不计为新增泄漏。
6. **端到端与混合版本**。
   - 端到端：expectReply 短超时，`wake:false` 发往 idle 目标且不回复 ⇒ 通知含 ` · last seen delivered`；同一 harness 关闭 activation ⇒ 文本逐字节同改动前。harness 不支持短 timeout 时改用 FakeClock 驱动的 stack 级测试，并写进报告。
   - 混合版本（追加到 compat 文件）：「新请求方 × 旧目标」「旧 hub × 新请求方」两个拓扑下的超时通知，与 `buildTimeoutNoticeContent([ticket])`（无 phaseOf）逐字节相等。
7. **原样绿**：`tests/web-hub/agent/xs-legacy-hub.test.ts`、`tests/integration/stack-teardown-matrix.test.ts`（无新 timer / observer）、C-X1…C-X14、三个 off golden、`tests/governance`。

门禁：

```
npx vitest run tests/fabric/xs-reply-notice.test.ts tests/web-hub/agent tests/fabric/xs-progress.property.test.ts \
  tests/integration/fabric-xs-reply.test.ts tests/integration/fabric-xs-activate-session.test.ts \
  tests/integration/fabric-xs-activation-compat.test.ts tests/integration/xs-idle-wake-warning-compat.test.ts \
  tests/integration/stack-teardown-matrix.test.ts tests/conformance/fabric-xs.test.ts tests/boundary \
  tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts \
  tests/integration/fabric-xs-reply-off-golden.test.ts tests/governance
npm run typecheck && npx prettier --check <改动文件> && git diff --quiet origin/dev -- tests/fixtures/
```

两包完成后，root 在后台跑一次全量：`npm run format:check && npm run typecheck && npm test && npm run build`。

## 4. 风险与残留

- **告警误报**：采样时刻与写入期间可能有重入（D1）；写入后目标也可能被人类输入、goal 续轮或 schedule 激活。文案写的是「大概率」，且不阻断发送，接受此残留。与 hub `busy` 快照相比，少了 resolve→send 竞态。
- **超时标记的观测滞后**：扫描上限 2000 条、推送丢失、过期都可能让镜像停在 delivered。非 live 观测已降为未知（D6）；live 状态下的漏记检测不出来，由观测口径文案和 wake_session 的 started no-op 兜底。
- **目标卡死**：wake_session 可能返回 already_active 或配额拒绝，由 #14 的语义解释。
- **有意漏报**：子会话、本端 wake 关闭、无 track（legacy、关系袋满）时不告警，因为给不出可执行的补救。
- **可见面**：结构化请求面板与 details 消费方看不到 warning（§0 已接受）。
- **wake 关闭时的超时尾句**：delivered 尾句中的 activate 会被明确拒绝，拒绝结果带原因；接受此行为，不为此增加门控。
- **NoticeGate 同步块**（`reply-notice.ts:13-25`）：`progressOf` 只读内存镜像，严禁实现为 receipt 往返或返回 Promise，verifier 必须核查。
- **C-X13 / C-X15**：通知不得带 sid / xid / messageId / activationKey 的值。
- **冻结面**：A 级 golden、`activate-trace.json`、settings corpus 都不刷新；工具描述不变，提示词缓存前缀不受影响。

## 5. 开放问题

无需用户拍板。主线已由用户确认；r2 修订均为评审要求的口径和测试补强。

## 6. 评审处置表（GPT 评审，r2）

| #   | 级别  | 评审意见                                                                                                              | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 改动位置                                                                          |
| --- | ----- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Major | 历史 delivered 不证明当前尚未开始处理（最远 phase 保留、expired 只改 observation、2000 扫描上限、started 推送可能丢） | 采纳。`progressPhaseOf` 遇非 live observation 一律返回未知并保留原字节；标记改为 ` · last seen queued/delivered` / ` · started seen`；尾句改为观测口径（「最后观测为已送达，尚无 started 证明…不代表此刻没在处理」「已观测到对方回合上下文包含该请求」），明确不靠同步镜像断言当前状态；补 observation 非 live、扫描超限、started 推送未到达三类测试，并断言文案不含断言式措辞                                                                                         | §0 需求 3；§1 D5、D6；§3 包 B 源文件（bridge 实现）与测试清单 1、3、4；§4 第 2 条 |
| 2   | Minor | D1 不应写成 ⇔                                                                                                         | 采纳。改为限定命题（当前实现 × 首次处理的新非回复 deliver-only 请求：applied ⇒ 采样时空闲、leaf 匹配、校验通过；unknown 不证明忙）；写明反例（idle 但 leaf 不匹配、fence 失败，`receiver.ts:532-609`、`:594-597`、测试 `xs-receiver.test.ts:287-317`）、dedup 重放（新 xid 不受影响）、采样与写入期间重入的竞态；包 A 补 receiver 反例测试                                                                                                                             | §1 D1；§2 表第 8 行；§3 包 A 测试清单 3；§4 第 1 条                               |
| 3   | Minor | 门控伪代码与测试不一致                                                                                                | 采纳，二选一：最终门控只看冻结的 `idleWakeAdvice`（已含 activation ∧ wake ∧ 主会话），删去 `replyOn` / `activation` 叠加及其非契约断言；谓词列成 C1–C11（r3：原 C12 被 C11 蕴含，降为防御性检查 D-q），测试拆为「纯函数谓词」和「接线 / 最终 content」两类，独立条件各自单独翻转、存在蕴含依赖或字段缺失的条件（C6、C10、D-q）用组合负例，另补 applied+queued、缺 wake、status 非 sent、woke=true 等防御用例                                                           | §1 D3；§2 谓词；§3 包 A 源文件与测试清单 1、2                                     |
| 4   | Minor | 原样跑 C-X13 验证不了新通知的 payload                                                                                 | 采纳。新增 C-X15（真实 pi + stub）：delivered / started 通知在 wake 路径进入 provider 请求时、以及 quiet 路径在后续自然回合中，断言标记和尾句可见、注入的 sid / xid / messageId / activationKey 哨兵值不可见；既有 requestId / ref 文案不计为泄漏                                                                                                                                                                                                                      | §3 包 B 测试文件与测试清单 5；README 小节列入 C-X15；§4                           |
| 5   | Minor | 文件域漏列测试文件；缺 expectReply 混合版本差分；门禁未显式列 off golden 与 governance                                | 采纳。两包都列出「改 / 新」测试文件（`tests/mention/**` 确认不改，仅原样跑）；新建 `tests/integration/xs-idle-wake-warning-compat.test.ts`，在「新请求方 × 旧目标」「旧 hub × 新请求方」两个拓扑下对 expectReply 工具 content（对照 `renderPre20`）与超时文本（对照无 phaseOf 的渲染）做逐字节比较；两包门禁显式列出 `fabric-xs-off-golden` / `fabric-wake-off-golden` / `fabric-xs-reply-off-golden` 测试与 `tests/governance`，并注明 fixtures diff 不能替代行为比较 | §3 包 A 测试清单 6、7 与门禁；§3 包 B 测试清单 6、7 与门禁                        |
| 附  | 说明  | warning 可见面                                                                                                        | 采纳。写明只出现在工具结果文本里（模型可见、ToolCard 输出可见），结构化 xs 请求面板与 details 消费方看不到，属已接受取舍，不表述为「所有 UI 面告警」                                                                                                                                                                                                                                                                                                                   | §0「可见面」；§4                                                                  |
