# #47 当前轮长按停止方案

## 状态、基线与范围

- **L2，5 分，root 已裁定**：文件数 2 + 单 UI 模块边界 0 + 契约不动 0 + 无直接先例及可访问双路径设计 2 + 可回滚写路径 1。
- 用户已明确同意 700ms + keyboard/AT 显式确认；第二轮 GLM `r_5R0DRHQ2` PASS 7/7，root 已核处置闭合并授权实施。root 已释放 README/build owner；源码候选完成定向145测试、typecheck及真实 compiled App 150项，进入最终构建/哈希冻结与异源delta验收。
- UI 研究基线为 `4b065925`，已包含 #40/#41/#42/#46/#48 的已提交 UI。其后 `bfd7ef09` 为 PG 脚本提交，不改变本方案 UI 基线（提交事实由 root 提供）。
- 用户原话：空闲时开发，停止按钮从两次点击改为长按停止。目标仅为 Composer 内 **current-turn abort**，不是停止 managed session、终止子 agent 或删除会话。
- 不改发送/附件按钮、unknown-slash、mobileframe、其他确认业务、后端、wire、settings、schema 或依赖。#49 新反馈优先让位。

## 实施决策

1. 推荐统一阈值 **700ms**。鼠标/触屏 primary pointer 连续按住达到阈值才发出一次既有 `stop`；短点击、双击和手势后的浏览器合成 pointer click 均不 arm、不停止。
2. ContextRing 合并按钮与无 provider 的 StopButton 回退共用局部 `useHoldStop`。`useArmedConfirm.ts` 仅允许订正 header 注释中迁走的两个 caller，不改逻辑或签名，不给它添加 hold，避免改变 avatar 删除、session revoke 等业务。
3. 键盘 Enter/Space 不要求长按：首次 keydown 记录键并阻止默认合成激活，忽略 repeat；对应 keyup 且仍聚焦、可用时打开显式确认 `role="group"`。AT 语义激活进入同一组，默认 focus 取消，明确确认才停止；Esc 取消，安全恢复焦点。
4. 提供独立、Tab 可达、在可访问树内、focus-visible 时显示的「无需长按：确认中止当前轮」按钮，避免仅凭 `click.detail === 0` 推断 AT 来源。主按钮通过说明关联两条路径。统一 click 合同：独立的 `detail === 0` semantic click 打开显式确认；`detail >= 1` 吞掉；已知来自同一 pointer 手势的衍生 click（包括带 pointer 来源的 detail 0）吞掉，不能重复 stop 或误开 group。keyup 已打开 group 后的合成 click 去重；repeat 不确认。pointer 短点主按钮不打开确认。
5. 使用单手势 pointerId、单次 timer、generation token 与 fired latch。到期先置 fired，再 emit；**host 单飞落在 `Composer.onStopInline`，跨 Ring/Fallback 表面存活**。Composer 捕获 scope，调用既有 abort（mint cmdId）前同步置 singleflight；新 `useHoldStop.ts` 可定义本地 typed injection key/context，由 Composer provide 当前 scope 的只读 `abortPending`，供两个表面统一 cancel/gate。不得以 `view.sending` 作为 abortPending，也不得各实例自认完成。same-scope 未结算不重发；换 scope 可接受新意图，旧 Promise finally 仅能释放自己 token/scope 的锁。无 provider 的独立组件可只有本地 gesture latch，但实际 Composer 最后一道 gate 严格，不允许 fallback 绕过 host 锁。复用原 abort API，不新增跨层协议或全局 ticker。
6. 进度优先 CSS-only，独立于原 context usage arc；显示按住、取消、请求中反馈及队列仍会发送的提醒。reduced-motion 使用静态标记和明确文字，无持续动画、rAF 轮询或新大依赖。
7. 手机 stop 透明命中区至少 44×44，视觉圈、图标和按钮底板不扩大，不移动或覆盖附件/发送。可在现有空隙内调整透明 hit area 的不对称扩张/offset；必须经真实编译 Vue UI 证明，不能用独立 mock 代替。

## 现有链与实现接点

以下坐标来自 UI 研究基线，实施时仅核对相关局部，不重新全树审计。

| 接点                                                         | 事实与约束                                                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Composer.vue:1299–1305,1603–1613`                           | `onStopInline` 直接调用注入的 `view.control.abort(view.agentKey)`；ContextRing busy gate 仅检查 busy/control 非空，尚无完整 connected/pending stop gate。仅修改 stop 局部。 |
| `ContextRing.vue:107–114,195–202,235–243,298–301`            | 当前两击走 `useArmedConfirm`；无 provider 回退 StopButton。保留 usage pending shell、idle details toggle/hover；holding/confirm 隐藏 peek。                                 |
| `StopButton.vue:20–53`                                       | 回退按钮同样需要替换旧两击语法，保持 `stop: []`。                                                                                                                           |
| `AgentDetail.vue:101–144,225–246`、`controlContext.ts:39–67` | 已有 view enabled/busy/agent/agentKey 和 HUB_CTX；连接状态为 `hub.state.value.conn === "open"`。agentKey/control 是 getter，不依赖父组件 remount 防串会话。                 |
| `useControl.ts:109–121,199–206`                              | 每次 abort 生成新 cmdId；同步 dispatch optimistic ctl 后走既有 transport；expect 携带 sessionId。泛化 sending 不等同 abort pending，不应因其他发送而误禁止停止。            |
| `agent/commands.ts:288–315,796–815`                          | 后端仅对同 cmdId 幂等并重查 sessionId。不能把同 id 去重当作前端重复生成新 id 的兜底；本方案不改后端。                                                                       |
| `CommandConfirm.vue:73–138`                                  | 复用显式确认/取消/Esc/焦点恢复范式，不复用其 slash command 业务 props，也不照搬自动 focus 执行或全组 Enter 执行。                                                           |
| `usePreviewWindowLayout.ts:1–20,275–303,343–370`             | 可参考单 pointerId 与 capture/cancel/blur/visibility/unmount 清理原则，非现成 hold API。                                                                                    |
| `control.css:399–411,454–500`、`upload.css:20–40,49–73`      | 当前 ring 宽 32px、min-height 44px，视觉圈 20px、stop 图标 11px；附件占左侧 24px slot。不能把 stop 命中区对称向左扩张。                                                     |

DetailDock 不承担当前 inline stop dispatch，无需改其编排；DetailHeader 的 managed-session stop 不在范围内；不新增 textarea/global abort 快捷键。

## 状态机、取消与单次提交

状态：`unavailable → idle → holding | confirm → fired/pending`。

可用条件为当前 busy、已有 control 权限/agent 活性、连接 open、无当前 abort pending，并绑定本次 `{agentKey, sessionId, epoch}` 作用域。正式集成读取已有 view/hub；不得用 standalone 测试环境的宽松 gate 绕过真实上下文检查。

统一 cancel 清除 timer、pointer/key 引用、capture/临时 listeners、动画 class 与确认组，并递增 generation。取消后必须由新输入开启新意图，恢复连接、移回原位置或恢复原 scope 都不续旧进度。

| 输入或状态变化                                                    | 转移与行为                                                                                                                                           | 新增 stop        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| eligible primary left pointerdown                                 | 进入 holding，记录 pointerId/scope，启动一次 700ms timer；第二指强制忽略、不接管、不取消活跃手势；只匹配当前 pointerId，pointercancel 仍取消当前手势 | 0                |
| 连续达到 700ms                                                    | 重验 generation、scope、eligible，先置 fired 再 emit；持续按住不能重复执行                                                                           | 1                |
| 提前 pointerup、短 click、dblclick、合成 pointer click            | 提前松开取消；click 不提交、不打开旧 arm 窗口；阈值后的 up/click 不再提交                                                                            | 0                |
| mouse 离开、touch 移出或移动超过 8px 滚动意图                     | 立即取消；touch 隐式 capture 下仍按坐标判定，不只依赖 pointerleave                                                                                   | 0                |
| 任意祖先 scroll、pointercancel、lostpointercapture                | 立即取消；scroll 使用捕获阶段监听                                                                                                                    | 0                |
| contextmenu / 原生长按 callout                                    | 活动 touch 手势仅 preventDefault 并继续 hold；活动 mouse/pen 才取消。无活动手势只阻止菜单，不提交                                                    | 0                |
| 按钮失焦/focusout、window blur、页面 hidden、卸载                 | 立即取消并清理，不向其他输入抢焦点                                                                                                                   | 0                |
| busy→idle、readonly/权限失效、断线、agentKey/sessionId/epoch 变化 | 同步取消；旧确认不能作用新会话；scope ABA 也不能复活旧 timer                                                                                         | 0                |
| 已有 abort sending、本地 abort 未结算                             | 不开启新手势，取消旧意图；等待既有结果，不自动 mint 新 cmdId                                                                                         | 0                |
| Enter/Space keydown/repeat                                        | 首次记录键并 preventDefault，repeat 忽略，不启动 hold timer                                                                                          | 0                |
| 对应 keyup 且仍聚焦/eligible；AT 激活或独立无需长按入口           | 进入同一 confirm group，focus 取消；重复打开不提交                                                                                                   | 0                |
| 确认组明确确认                                                    | 再验 scope/gate，先置 pending 再走原 stop；按安全规则恢复焦点                                                                                        | 1                |
| 确认组取消/Escape、确认期间上述作用域变化                         | 取消；原按钮仍存在且合适时恢复焦点，不向新会话抢焦点                                                                                                 | 0                |
| abort 失败/效果未知                                               | 沿既有结果路径，不自动重发；新的明确用户意图才可重试                                                                                                 | 每个新意图最多 1 |

同 tick gate 变化也必须阻止提交。旧异步回调或 Promise finally 通过 token/scope 核对，不得清除新会话的 pending 状态。main abort 保留队列，不误清队列或调用子 agent/managed-session stop。

## touch contextmenu 与焦点约束

移动端 contextmenu 可能约 500ms 出现，早于 700ms；活动 touch 的 contextmenu 必须仅 preventDefault，保留原 timer/generation，不取消、不提交。活动 mouse/pen 的 contextmenu 才取消。未来 CSS 仅在 stop 命中区明确 `-webkit-touch-callout: none`、`user-select: none`（含必要前缀），保留 `touch-action: pan-y`；pointercancel、滚动、移出仍立即取消。独立 mock 的 500ms 注入是规则回归，CDP touch 是桌面 Chromium 仿真，均不代表物理 iOS/Android 已验。

真实 Vue 验证还要覆盖 mouse/touch 按下时焦点：不能因 stop 获焦导致手机键盘收起或目标移动。可保留 composer focus，但不得封死 pan-y 滚动。确认 group 的主动 focus 迁移与 pointer holding 失焦取消分开处理。

## 44px 命中区证明要求

手机/桌面 composer gap 均为 8px；在现有 32px slot 上仅向右扩 12px 后净距约 1px，**不是宽裕空间**。右扩 12px 仅为候选，不是唯一解。允许在现有空隙内调整透明 hit area 的不对称扩张/offset，保持视觉圈及邻按钮位置不变。44×44 目标不变，root **未预批准降为 43px**；静态推导不构成真实 Vue 几何结论。

正式实施在真实编译 UI 验证 collapsed/expanded：390/767/768/1025px、输入空/有、chips 在/不在、fontscale 1/3。测量 stop 至少 44×44、视觉仍为 20px 圈/11px 图标；用四边/四角、相邻区坐标与 `elementFromPoint` 证明 attach/send/hint/transcript 不重叠、不裁切、不挤压输入。现有 min-height 44px 在 34px mobile card 外溢不是新 feature，但必须测纵向与四边命中。记录 mouse/touch 按下前后焦点、软键盘及 target rect 稳定性；不可仅加 min-width 后宣称满足。若不可达，先报 root，不降 43px、不暗改其他 controls 布局或扩大写域。

## 精确预计实施写域

以下是后续获得授权后的实现白名单，**root 已授权以下源码/测试写域；`docs/dev/web-hub/README.md` 已在 #51 提交后由 root 解冻并追加 #47，详细证据见同目录 `runtime-notes.md`；原 tmp `report.md` 不可变**。仓库根为 `/home/bluecake/ai/pi-toolkit`；任何额外文件先报 root。

| 路径                                                       | 预计职责                                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 新 `src/web-hub/ui/src/composables/useHoldStop.ts`         | 局部手势/取消/token/scope、既有 view/hub eligibility；typed injection key/context 承载 host 只读 abortPending，不改冻结 props |
| 新 `src/web-hub/ui/src/components/control/StopConfirm.vue` | 非模态确认 group、明确确认/取消、Esc/焦点行为                                                                                 |
| `src/web-hub/ui/src/components/control/ContextRing.vue`    | 合并 stop 手势及确认入口，保留 idle/hover/usage shell                                                                         |
| `src/web-hub/ui/src/components/control/StopButton.vue`     | 同语法的 provider-absent 回退                                                                                                 |
| `src/web-hub/ui/src/components/control/Composer.vue`       | 仅 stop 注释、onStopInline host singleflight、当前 scope 的 abortPending provide、最终 eligibility/scope guard                |
| `src/web-hub/ui/src/styles/control.css`                    | 仅 scoped stop 进度/确认/命中区/reduced-motion 样式                                                                           |
| `src/web-hub/ui/src/i18n/en/control.ts`                    | holding/cancel/help/请求中描述及确认文案                                                                                      |
| `src/web-hub/ui/src/i18n/zh/control.ts`                    | 对应中文键，保留队列提醒，与英文键集合一致                                                                                    |
| 新 `tests/web-hub/ui/hold-stop.test.ts`                    | 控制器状态/取消/ABA/单次提交矩阵                                                                                              |
| `tests/web-hub/ui/stop-button.test.ts`                     | 替换旧两击契约，保留字号/几何无关断言                                                                                         |
| `tests/web-hub/ui/context-ring.test.ts`                    | 合并手势/回退/peek/idle 回归                                                                                                  |
| `tests/web-hub/ui/composer.test.ts`                        | fake abort 调用、scope/pending/gate 负断言                                                                                    |
| `docs/dev/web-hub/README.md`                               | 正式实施后追加交互不变式与门禁，不搬旧 feature 段落                                                                           |

额外仅允许 `src/web-hub/ui/src/composables/useArmedConfirm.ts` 的 header 注释订正迁走的 ContextRing/StopButton caller；禁止逻辑或签名修改。

冻结不动：`contracts.ts` 的 Composer/ContextRing/StopButton Props/Emits、`types.ts` 的 ControlHandle、`controlContext.ts`、DetailDock/AgentDetail props、`useArmedConfirm.ts` 的逻辑/签名、后端 commands、protocol/caps/settings/schema、A/B golden。不改 PG/governance 文件、其他 docs 或原稿/UI pipeline。

## 验收矩阵与正式门禁

- 时间边界：699ms 为 0，700ms 恰 1，再推进 10s 仍 1；up 后 pointer click、合成 click、keydown repeat 不产生重复 abort；独立 detail 0 semantic click 只进入确认，detail >= 1 吞掉。
- touch 在约 500ms 注入 contextmenu，菜单已阻止且 holding 继续，700ms 恰 1；真实 CDP touch longhold/up 后仍仅 1；mouse/pen contextmenu 取消为 0。物理 iOS/Android 未验必须明示。
- 第二指按下/移动/松开强制忽略，不接管、不取消主指手势；当前 pointercancel 仍取消。
- host 跨 Ring/Fallback 表面切换仍 pending，同 scope 不重复；新 scope 可新意图，旧 finally 不清新锁；不得使用 view.sending 替代。
- 短按/双击为 0，无 data-armed/4s 第二击窗口；回区或重连不续旧 timer。
- 逐项取消负断言：up、move/out、scroll、pointercancel、lostcapture、blur/focusout、hidden、unmount、busy、enabled、conn、pending、agentKey/sessionId/epoch。原阈值后仍 0，timer/listeners/capture 均释放。
- ABA 与竞态：scope 改回原值仍 0；same-key session/epoch 替换取消；旧 Promise finally 不干扰新 scope；gate 同 tick 变化不发出调用。
- 主 ring、usage pending shell、无 provider 回退语法一致；idle details/hover 不变；hold/confirm 不露 peek，取消后的同次 click 不误 pin panel；队列提示保留。
- 键盘/AT：Enter/Space keyup、repeat、IME/组合键、Tab/Shift+Tab、Esc、焦点恢复、取消按钮 Enter、AT 语义 click、独立 focus-visible fallback、确认时 scope 再验。不能仅用 detail 推断替代 AT 路径。
- Composer 注入 fake abort 计数，不调用真实 abort：pending 单飞、失权/断线/换会话为 0；成功/失败/unknown 不自动重发；原 wire-shape 保持。
- 真正编译 Vue UI 的 44px/邻区命中证明，以及 reduced-motion 静态状态、长文/反馈不遮输入。真实移动端 AT 与 iOS 长按/滚动行为需明确记录验证范围，模拟不冒充通过。

正式实现获得授权后执行：

```sh
npm run typecheck
npm run build:web
npm run check:web
node node_modules/vitest/vitest.mjs run --project tier1 tests/web-hub/ui/hold-stop.test.ts tests/web-hub/ui/stop-button.test.ts tests/web-hub/ui/context-ring.test.ts tests/web-hub/ui/composer.test.ts tests/web-hub/ui/use-control.test.ts --no-cache
```

精确 Prettier check 修改路径；日常 `test:tier1` 由 root 统一安排一份，不由并行 agent 启动全量。使用隔离合成数据、fake stop callback 和 loopback 预览验证真实编译 UI，记录 console/network，绝不调用真实 abort/session API；完成后异源验收。需要真实用户界面重启/reload 或安装依赖时先报 root，不默认执行。

## 已有研究证据与限制

原报告 `/tmp/pi-previews/hold-stop/report.md` 不可变。修订前 mock/probe/结果/三张截图及 probe 日志保留于 `/tmp/pi-previews/hold-stop/review1-old/`，修订 mock/probe 与新证据留在原 tmp 目录；不得把旧版结果冒充修订版结果。

修订前研究结果：独立合成 mock 在缓存 Chromium 上 22 项通过，console/pageerror 为空，唯一网络请求为临时 loopback 页面 GET，独立目标 44×44；旧 UI 基线 4 文件 107 测试和 typecheck 通过。临时 browser/server 已清理。

**这些不是正式 Vue 实现验收**：AT 为语义点击模拟，部分取消/卸载为 fixture 状态模拟，独立 mock 未证明真实 Composer 邻区命中。用户已同意核心方案，第二轮独立评审与 root 闭合已完成；正式实现自验门禁另见 `runtime-notes.md`。

修订 mock 保留原 22 项基线（第 12 项明确为活动 mouse contextmenu 取消），新增 9 项，共 **31 项**：touch 约 500ms 注入菜单继续、真实 CDP touch longhold、pen 菜单取消、第二指忽略、keyup/click 去重、pointer 来源 detail 0 排除、host 跨表面 pending、scope/旧 finally 与 ABA。单独记录阈值 elapsed 测量，不计为额外测试。结果见 `/tmp/pi-previews/hold-stop/gesture-results.json`，host 表面切换仍是 fixture 模拟，不冒充 Vue provide/mount 证明；物理 iOS/Android、真实 AT、真实 Vue 几何/软键盘仍待正式阶段验证。

## 第一轮 conditional 七项处置（第二轮 PASS 7/7，root 已闭合）

以下按 root 裁定拆为七项（将几何与焦点分别列项），第二轮 GLM `r_5R0DRHQ2` 已 PASS 7/7，root 已核闭合。行号指本修订 plan 对应规则；mock 仅验证可模拟部分。

| 项                           | 处置                                                                                                        | 规则行号     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------ |
| R1 touch contextmenu blocker | touch 仅阻止菜单继续 hold；mouse/pen 才取消；补 500ms 注入及 CDP longhold                                   | `plan.md:68` |
| R2 click/键盘/AT 合同        | detail 0 semantic 确认、detail >= 1 吞掉、pointer 衍生 click 排除、keyup 去重、repeat 不确认、独立 fallback | `plan.md:16` |
| R3 host 单飞                 | Composer host 锁跨 Ring/Fallback；typed injection 只读 pending；scope/token 防旧 finally 清新锁             | `plan.md:17` |
| R4 44px 几何                 | gap8/right12 仅约1px；允许不对称 offset；不降43；真实 Vue 四边与邻区证明                                    | `plan.md:74` |
| R5 焦点与纵向                | 既有44高/34卡溢出仍验证；按下不收键盘/移动目标；pan-y保留                                                   | `plan.md:70` |
| R6 第二指                    | 强制忽略、不接管、不取消；当前 pointercancel 仍取消                                                         | `plan.md:49` |
| R7 shared composable header  | useArmedConfirm 仅订正两 caller header，逻辑/签名及其他确认业务不变                                         | `plan.md:98` |

## 最终实施补记与 root 接受边界

- 短 tap 仅给中性长按提示；真实取消为“长按已取消，未停止”。本地1500ms反馈 timer 自清，blur/scope/unmount立即清理，不恢复两击确认。
- Composer 同步读取已发布的 hub snapshot，避免 parent props 渲染批处理漏掉中间 scope/权限。root接受：原生 EventSource 每frame独立task，已发布可观察 scope/conn/permission ABA 必取消；同JSstack被既有 renderGate 合并、consumer不可观察的人工事件不要求检测。useHub/renderGate/transport/contracts不解冻。
- 实际几何128格均：rect完整在viewport内，viewport交集宽44、高44–212，有效44×44的1936像素地址均命中，四边角与邻区不覆盖；不排除圆角/屏外点来伪造通过。CSSOM恢复旧32px布局证明图形/slot/attach/send零位移，字体computed16/48px。
- 实际compiled App共150项通过；明确holding/confirm中的1条排队警告，abort后queue仍显示。5帧fake abort的target/expect/id正确，pending/旧finally以可控HTTP ACK验证。
- 另以createDevHub定时fixture.script发出实际loopback SSE B/A，两帧isTrusted=true、在CDP按住后分别到达，0abort，补足public-dispatch模拟与真实网络的区别。
- 物理iOS/Android及VoiceOver/TalkBack未验；viewport模拟不冒充真实软键盘验证。完整日志/截图/冻结哈希及manual步骤见runtime-notes。
