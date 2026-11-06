# `/fast` 实施方案（task54，Plan r2）

> 2026-11-07；主树基线 `3fc76437`。**仅方案，未实现、未运行本轮真实 API / 性能实验，未改配置、依赖、Agent 参数或源码。** 本稿消费 [arch.md](./arch.md) r5 及其原文 JSON；不是恢复研究53，也不启动36/45/49的新功能。L3 架构后细化，下一站为独立 Sonnet 方案评审，之后仍须用户实施授权。

## 当前 baseline / V4 同步（2026-11-07，#45）

用户已选择整个 Toolkit 最低 pi 1.5（Breaking Change）：peer `>=1.5.0 <1.6.0`、
三包 dev 精确 `1.5.0`，tested 仅 `1.5.0 - 1.5.0`。P0 `2f65ea9b` 七场景已验证真实1.5 SDK
回滚前提，P4a `80af9ca3` 共享合同已合入；P1/P2 并行原生隔离实现。
旧1.4不再支持，不新增运行时临时IO能力探针/私有rollback/sidecar给它兜底。
V4剩余是生产controller最后成功值、storage-fault、child初始化失败零prompt与清理的集成验证，
**七场景P0不等于生产controller已完成**。全部Responses、native warm follows、默认enabled决定保持。
下文双SDK路线与旧支持范围为原计划历史；本轮只同步baseline/V4，不接管Fast/Workflow README。

## 1. 一页摘要与边界

- 已定：主会话与新建子 agent；随 session 保存、恢复、分支、fork；全部 OpenAI Responses 模型，包括普通/Codex/Azure 构造器，不限 provider 或 Sol。
- **U1已定**：保留 Pi 原生 warming，一并跟随本 session Fast；接受费用/额度 premium 未知。不暂停、不排空、不要求新进程、不新增 Pi origin/cancel 工程，不重新询问。
- 请求三态：`inherit` 原样返回；`on` 请求 `priority`；`off` 显式请求 `default`。不改变 reasoning，不使用 ultrafast，不假设收费倍率。
- 入口是 session provider 链的最终 payload hook，按 arch §4.3 严格 Responses 判形；`ctx.model` 仅辅助，**不存在 event.model/api**。跨 API 虚拟路由及中途 setModel 是已证实能力，不能以选择模型盲注。
- 新 child 取受理时父快照；已有 running/queued 不追随 root；workflow replay/FIFO 前捕获。main 历史恢复与 terminal Agent resume 是不同操作。
- **V4当前前提**：最低1.5，P0七场景已验证SDK回滚；旧1.4 ghost仅为历史证据，生产controller失败处理仍需集成。`getBranch()` 不是持久证明。
- **U2新增用户决定**：`fast.enabled=true` 默认可用；session 初始 `inherit`，不主动改请求、不追加 startup record。显式 `false` 保留为严格 I9 紧急总开关。此为未来实现合同，**现在代码未开发，命令仍不可用**。
- 不新增 web 按钮、工具、模型 catalog、系统 prompt 或 Agent 公共参数；只有通知与紧凑英文 status。

### 输入的证明力

完整读 `/home/bluecake/ai/chat/brain/localcodex-fast-test-report.md`；该报告仅证明 Sol 在单代理链路 36 次多任务对照中 Fast 请求与吞吐改善相关，全部响应 tier=default；另有 fast/priority 等效对照。它不证明全模型效果、官方执行层、质量、长上下文表现或计费。**本轮没有重跑这些请求。** `/tmp/fast54-evidence.json` 仅定向对照已修结论；原探索 openQuestions 不覆盖用户已定范围。证据地图继承 arch 附录，不重复遍历全部 SDK/子系统。

## 2. 可见合同与默认值

| 入口                           | 效果                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `/fast`、`/fast toggle`        | on→off；off/inherit→on，不猜 provider 默认。                                                                   |
| `/fast on`                     | 成功保存后请求 priority，包括后续 native warm。                                                                |
| `/fast off`                    | 成功保存后显式 default；不卸载 hook，不靠删字段继承。                                                          |
| `/fast inherit`、`/fast reset` | 追加 inherit 墓碑；不改原 payload/tier，不删旧历史。                                                           |
| `/fast status`                 | 只读 requested、selection、at-hook 判形/注入、latest observed、storage/unsupported 状态、native warm follows。 |
| 空白/大小写                    | trim、大小写不敏感；其余未知或多参数 usage 错误，零写盘/模式变化/请求。                                        |

幂等同 mode 不 append；startup/status 不 append。失败不是成功切档：保留最后成功 mode，展示 `storage-fault`，不向新 child 继承失败新值。锁域拒绝与非法参数均零效果。

**三个“默认”不同**：总开关默认 true 注册命令/固定 hook；session 无记录默认 inherit，不主动改变 payload/tier、不写 startup record；用户 `/fast off` 是请求 default。显式总开关 false 才是零 Fast 注册/seed/读回/写盘/payload 变化，disabled 不等于 off。

首次使用（**未来实施后**）：默认直接 `/fast status`，需要时 `/fast on`；不需先改配置或 `/reload`。用户主动设置 `fast.enabled=false` 紧急关闭，或之后再开启，仍按现有非 live 设置机制 `/reload`；总关闭时命令未注册，受 #40 未知 slash 文本合同约束，不加拦截破 I9。默认 true 有意增加 command/固定 hook 的激活面，不能要求新默认注册 profile 与旧默认逐字节相同；显式 false profile 与既有 disabled 基线字节相同。现在尚未开发这些命令，以上例子不是当前可执行功能；本轮不改任何实际 settings。

状态用英文片段：`Fast requested`、`Tier default requested`、`Fast suspended`、`storage-fault`；inherit 默认不占 footer。prose 中文说明“已请求 Priority；原生预热也跟随；代理可能改写，落实及费用/额度 premium 未核实”。requested=on、injected=priority、observed=default 可同时成立；缺回显为 unknown。缺公开 request 关联时只叫 latest observed（origin unknown），不能把并发 warm 的观测绑定到某次普通请求。default 不代表没加速，priority 不代表账单认证。

## 3. 数据、持久化与生命周期

### 3.1 最小接口与权威来源

沿用 arch §4：纯数据 `FastMode = inherit|on|off`；`FastRecord/FastSeed={v:1,mode}`；customType=`subagent:fast`。revision/incarnation 只在 activation 内，不写盘/seed/hash。core 保持 pi-free；optional 内部 seed 缺省不写 undefined 键。

| 场景                        | 权威来源/动作                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| main startup/restore/reload | 当前 branch 最后有效版本记录；无记录 inherit，startup 不复制 parentSession header。            |
| tree/fork/clone             | 所选分支截至目标节点的最后记录，不扫全文件 entries；分叉前无记录 inherit。                     |
| malformed/未来记录          | 最后记录不合法则 inherit+invalid-record，不穿透旧 on；只读 own data，不读 accessor/prototype。 |
| compaction/switch_context   | custom 历史保留为权威，模型 messages/摘要不是状态源。                                          |
| new child                   | 受理快照（含 inherit）初始化原 manager，child marker 仍首条；首 prompt 前 receiver ready。     |
| terminal Agent resume       | 新受理父 seed 覆盖旧 child（inherit 也覆盖旧 on），先通过域检查；不等同用户 restore。          |
| live steer/归并             | 未创建新 child，不重新继承；原 resume 互斥不变。                                               |
| child branch 后 nested      | 从该 child 当前 branch 读取；绑定前只用受理 seed，不回查 root。                                |
| storage-fault               | 最后成功内存状态暂为控制权威；不能把 ghost 当历史成功，跨生命周期保证受 V4 阻塞。              |

持久状态只存 v/mode，跟原 session/vault/inMemory；不写 URL、prompt、错误、响应或价格，不逐请求记录。main `appendEntry(...):void`，child `appendCustomEntry(...):string` 都不是 fsync 承诺。正常成功返回按 SDK 合同接受，不承诺进程/机器崩溃的强持久性。

### 3.2 V4：原最小验证路线与当前状态

**当前裁定**：P0七场景在1.5通过，旧1.4无需兼容，不再执行下方旧宿主识别/放行分支；不得新增临时IO能力探针。生产controller/child故障集成断言仍必须完成。以下为原计划审计路线，不是重新安装旧SDK的指令。

已抽验：本地1.4 `_appendEntry` 先改 fileEntries/byId/leafId 后 `_persist`，失败不回滚；隔离1.5 catch 会撤销该 entry。#45已有真实 EISDIR 失败证据，**不是假想风险**。当时1.5修复尚未改变peer；现在#45按新用户决定将全项目floor收紧至1.5。

授权实施后先写一个公开 SDK characterization，使用已安装本地1.4及隔离1.5，不安装、不改依赖/peer：

1. 临时 session 建立最后成功 off/inherit；分别覆盖已 flush 与未 flush 的公开 manager 路径，制造真实文件写失败；断言 append 抛错，controller 留最后成功值+storage-fault，失败 on 不注入/不继承。
2. 恢复可写，安排普通消息/其它 custom append 与分支操作的异步交错；检查 failed record 会否被后续首次 flush 落盘或成为后续 entry 的 parent。不是只测“命令 catch 了”。
3. 公开 getBranch/tree/branch/fork/open/reopen 对照内存与磁盘投影；失败 on 不得通过 reload/restore/fork/nested 快照复活。重复同 sessionId 的新 incarnation 不能绕过。
4. child seed append 或 manager 初始化失败：首 prompt 调用数必须为0，清理 loader/bus/owner；测试并发 child 不误用另一个 ready。
5. 不私有回滚、不直接修 session 文件、不新两阶段提交/庞大 sidecar。若公开 API 无法给出稳定保证，spike **以明确失败结论结束，阻断持久化集成**，不把 characterization 红改 skip 或用后续纠正 entry 宣称解决。

**明确决策分支（交 root，需用户另批）**：A，离线公开API验证满足全部故障不复活断言，则按已证明的宿主能力接线；B，验证不满足，则提出 **Fast功能特定宿主兼容策略**（推荐仅在已证明无ghost的实际loaded宿主能力上放行，旧宿主明确不可用），说明识别依据与用户影响后另批；C，连局部能力识别也无法证明，则暂缓该功能集成，保留阻塞。可复用#45证据，但不等待/偷改整体peer，不新增上游项目。当前global CLI版本不是实际loaded能力证明。用户选择的“全部Responses模型”是可用宿主上的模型范围，不等于所有历史SDK必须立即支持；不得借此收窄为Sol/provider名单或永久disabled冒充完成。仅“fault 后本controller拒绝切档”不足以解决另一activation的历史污染。

### 3.3 请求与失效

- 固定一次注册：main cacheTTL 捕获后 Fast、traffic 前；child 次序 keepalive→Fast→budget→traffic。budget handler 是 lazy install，registry.subscribe 可能同步重放：必须先接 Fast 再让预算注册/重放发生，并验证立即重放、稍后触发、重复 install 均保持此顺序。index 只装配，不在本轮改代码。
- inherit 直接 undefined，不遍历/clone；on/off 通过 arch §4.3 根键+items/tools 严格判形才浅拷贝顶层 tier，保留嵌套引用、samplingParams 原值及 reasoning；不改共享 model/registry/options。
- 非Responses suspended；未知/混合/非法结构 unsupported-payload，无覆写且明确反馈，原请求仍由 SDK 处理；throw 会被扩展 runner 吞掉，不能假装阻断。
- 400/unsupported 不静默探测、删字段降级、付费重试、降 reasoning 或换模型；不把所有400归因 tier。既有 SDK 重试不由 Fast 扩大。
- callback 入口同步取 mode/revision/incarnation。已交付 body（即使尚未发送）不变；之后 onPayload 才看新值。运输重试复用旧 body；下一新 request 才可取新值。不撤回/重发。
- native warm 重放会话 onPayload，采用同一规则，**不增加 warming handler/调度/频率/预算变化**。已有 traffic armed rewrite 自身可能 stop warming，不在 Fast 内改写它或宣称覆盖所有其它插件行为。
- Jev/title/topic judge、toolkit 直连 keepalive/measure、独立 compaction summary 不继承。第三方 hook/traffic rewrite/代理之后可再改 tier，Fast只承诺 at-hook，不保证最终控制上游。
- per-activation incarnation 防 ABA；晚响应不写新 session 展示。最近观察仅有界摘要，不存原始事件。child handle 的 abort/dispose/create失败主动撤销绑定/状态端口，不依赖 session_shutdown。

## 4. 可执行分包与共享冻结面

这是**未来授权后的范围表**，不是本轮可写许可。先测试再实现；每包产物为代码+行为断言+坐标交接，下游不得重复全仓探索。真实 mock 网络/进程测试按 tests/tiers.ts 归属，新增前读对应 README。

| 包/顺序                  | 独占文件域 glob 与允许新建                                                                                                                                              | 先写测试/产物                                                        | 依赖/门                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| P0 持久化 spike          | 仅新 `tests/conformance/fast-storage*.test.ts`；测试临时 session                                                                                                        | §3.2 双SDK公开API故障报告，不产shim                                  | 用户实施授权后才执行；V4闭合前不放行P3持久集成      |
| P1 状态/请求纯逻辑       | 新 `src/fast/{state,payload}.ts`；`tests/fast/{state,payload,command-parser}*.test.ts`                                                                                  | 三态/记录/解析/构造器语料与拒绝集                                    | 不依赖P4b；可与P0/P4a并行                           |
| P4a 共享合同先行         | `src/core/types.ts`、`src/config/{settings,setting-specs}.ts`；新 `src/fast/ports.ts`；必要最小 `src/stack.ts` 端口签名（只声明，无装配）                               | optional seed/端口、默认true与显式false配置合同先冻结；类型/配置断言 | 无P2/P3/P4b产物依赖；接口冻结后交P2/P3              |
| P2 workflow              | `src/workflow/{types,host,spawner-adapter,journal,replay,call-registry}.ts`；`tests/workflow/*fast*.test.ts`                                                            | TaskSemantics/QueuedAgentCall optional字段、replay前快照/FIFO/hash   | 仅依赖P4a合同；与P1/P3可并行；不改worker opts/PROTO |
| P3 child/runtime/service | `src/service/{spawn-service,runtime-adapter}.ts`、`src/runtime/session-driver.ts`；新 `tests/{service,runtime}/*fast*.test.ts`、`tests/integration/fast-child*.test.ts` | V2双loader同bus证据、seed/递归/resume/首prompt阻断/清理              | P4a先行、P0 V4闭合；V2双路径不通则阻塞接线          |
| P4b 装配/命令收尾        | 新 `src/fast/wire.ts`；`src/{index,stack,stack-teardown}.ts`、`src/child/wire.ts`；`tests/fast/wire*.test.ts`；下述governance共享面                                     | I9、lazy budget含同步重放顺序、恢复/status/ABA、默认true trace       | 消费P1/P2/P3，且P4a已完成；不反向作为其前置         |
| P5 验收/文档             | 新 `tests/conformance/fast-*.test.ts`、`tests/integration/fast-*.test.ts`（P0/P3占用除外）；新 `docs/dev/fast-command/README.md`                                        | 最终body/warm/traffic/secure与独立验收                               | P4b完成；异源verifier，仍需实施授权                 |

**唯一owner与时序**：P4a/P4b由同一集中owner串行持有，`src/stack.ts` 在P4a只冻结必要端口签名、P4b才实际装配；P2/P3不得改stack。`src/core/types.ts` 仅P4a改，`src/workflow/types.ts` 仅P2改，不能因同名types跨包抢写。P2仅只读参考 既有 `queue-mirror` 引用，新字段optional，不破原结构；若必须越界改它，先报root冻结协调，不能隐含授权。P3的runtime-adapter由P3唯一拥有，P4b只消费接口。

**共享冻结面**：P4b集中owner另持有 `tests/tiers.ts`、`tests/governance/{trace-profiles,activate-trace.test}.ts`。精确B级fixture例外仅 `tests/fixtures/governance/activate-trace.json`：默认true新增command/固定hook，必须声明有意更新新默认true profile，显式false profile按旧disabled基线逐字节不变；未来授权实施时使用 `PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance` 按规则刷新。不能要求新默认true与旧默认注册面相同。任何A类main/child fixture、nested golden永不重生；其它 `tests/fixtures/**` 均冻结。所有包禁止擅改 `package*.json`、`src/adapters/pi-compat.ts`、Agent公共schema/description、worker公共opts/wire。文件冲突预检必须使用此唯一owner表。

**有向依赖（无环）**：P0/P1/P4a无包依赖；P2依赖P4a；P3依赖P4a和P0（V4），并受V2门约束；P4b依赖P4a/P1/P2/P3；P5依赖P4b。V2/V4未闭合只阻塞实施集成，不阻止方案提交，P4a不依赖P4b。

core 新增 optional `fastSeed` 到内部 SpawnRequest/SessionSpec；不把扩展字段加到 Agent Tool 参数/description 或 promptNotes。跨域数据为纯值；无新全局 registry/Symbol/mutable module state。工作流 host 的 capture 端口不变成 worker 参数。

### P2/P3 必须实现的时点

1. main Agent 同步准入时取快照，拒绝不产生 session；已有内部 seed 不被 SpawnService 出队再覆盖。H2/工作树/鉴权期间不重取。
2. workflow `handleAgent` 完成参数校验后、taskKey/replay及本地FIFO前 capture；QueuedAgentCall 与 spawner adapter 保存同值。workflow FIFO 和 runtime slot queue 分别测试，不能只测其中一层。
3. nested 使用受信 parentRunId 的本栈只读 child-state端口；绑定前seed，绑定后branch（fault时最后成功值）；无进程全局共享。运行中的child不订阅root广播。
4. replay key仅 optional `fastMode:on|off`；inherit/disabled省略，legacy hash字节不变。seed不含volatile nonce/revision/incarnation，不让所有journal缓存失效。命中无请求，只展示 replay，不叫“Fast已加速”。隔离worktree既有verify/chain语义不改。
5. **V2双路径分别取证，不能假定原baseLoader总存在**：driver先secure检查、原manager/child marker、seed。路径A有systemPrompt时，当前toCreateOptions自建 `DefaultResourceLoader({systemPromptOverride,...})`，需公开传同一eventBus并保留原资源/observer。路径B无systemPrompt时，当前依赖SDK默认loader，需证明公开API可将同bus送到该默认发现/扩展链；不能拿A的构造器签名当B已通证据。两条路径各做离线真实SDK验证（含human observer/cwd/settings/发现/清理），不 `-e`、不重造loader覆盖或丢observer。若B或A不存在可满足的公开路径，V2阻塞接线，提交最小替代与影响由root裁定/必要时另批，不能默认可行或把无prompt路径悄悄转成另一资源语义。
6. preguard receiver同步订阅 `subagent:fast-bind`；reload后driver发manager只读视图+同步reply，同manager幂等、异manager拒绝。reply要在bus handler首await前；emit返回无reply即超出就绪截止，on/off首prompt前 `fast_receiver_missing`，无无限等待/轮询timer。inherit保旧missing诊断，不假称注入。
7. 同bus就绪受原create预算/取消约束；逾期/旧incarnation reply无效。handle撤销bus订阅/owner/readMode端口，abort/create失败也清理；复用现有I1预算，不补充免费生命周期。child不注册main命令/UI/host/tool。
8. old optional seed缺失走原路径，不增记录/握手；enabled receiver可读旧branch。old/new optional内部调用兼容；缺失不是off。external droid不携带seed。

## 5. 测试与验收矩阵（未来执行，本轮不跑）

断言必须落到行为或实际body，不用恒真stub/“未抛异常”代替。mock 指本地loopback实HTTP/受控WS，调用真实已安装SDK构造器，不使用模型服务。

| 类别          | 必须断言                                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 三态/命令     | toggle/on/off/status/inherit/reset、trim/大小写、非法/多参数零效果；幂等/无record零写/未来record墓碑；disabled与off不同。                                                                                                                                                                                          |
| 最终body      | 本地1.4、隔离1.5各捕获普通Responses/Codex SSE与WS/Azure部署；最终合参后on=priority/off=default/inherit字节不变；现有samplingParams tier及其它字段复原，model深冻不变、reasoning原样。1.5只对照，不宣称正式支持。                                                                                                   |
| 协议判形      | 实际text/image/function/custom grammar/additional_tools/reasoning/configuration_update/search/空input/native warm语料；单input、混合messages、未知根/variant、accessor、Chat嵌套工具拒绝覆写并反馈，不按provider名单收窄。                                                                                         |
| 路由/切档     | selection与physical API不同；中途setModel后按body不按ctx选择；已交付body保持旧值、待回调用新值、运输重试不重新快照。                                                                                                                                                                                               |
| warming U1    | native warm确实经过hook且跟随child/main自己模式；保留原调度；普通流与warm并发/切档前后已交付不重发，latest observed不假关联，费用prose可见；无新增stop/origin工程。                                                                                                                                                |
| queue/隔离    | 并发main session隔离、父三态、root切档不改running/已受理queued；workflow FIFO与runtime slot queue、递归/nested branch、worktree/auth延迟、terminal resume覆盖与live steer不覆盖。                                                                                                                                  |
| replay        | on/off变化miss；inherit/disabled legacy hash相同；hit网络调用数0，不显示injected/加速；无volatile seed失效。                                                                                                                                                                                                       |
| 持久/ghost    | §3.2两档SDK真实失败，后续并发append/branch/fork/reopen/restore不复活失败新值；失败child prompt=0；不是getBranch即算落盘；V4不闭合不得宣称成功。                                                                                                                                                                    |
| 生命周期/握手 | restore/reload/tree/fork/clone/compaction/context-switch、同id ABA、旧reply/观察拒绝；有systemPrompt自建loader与无systemPrompt SDK默认loader分别证明同bus、错误bus、缺receiver、create失败/abort/dispose与human observer并存；任一路无公开路径即V2阻塞，不依赖child session_start/shutdown。                       |
| cache/traffic | toolkit独立keepalive/measure无Fast注入、原capture/validator/cap保持；child预算包含最终tier，lazy budget的registry同步重放/延迟安装/重复安装均验证keepalive→Fast→budget→traffic；traffic at-hook与实发body一致（无rewrite时），有rewrite时区分original/revised；Codex只承诺既有hook级录制，不虚构fetch/WS记录能力。 |
| secure/locked | 原vault manager路径、域检查先于打开/seed；locked/cross-domain零旁路、零prompt，无D8例外/新明文state；原secure forced-off不被重启。                                                                                                                                                                                 |
| I9/兼容冻结   | 默认true命令/固定hook注册，初始inherit payload不变且startup无record；显式false零注册/读写/seed/prompt/payload变化并保持旧disabled字节；B级精确trace按§4有意刷新；old/new optional seed互操作；core pi-free；Agent面、A类main/child及nested golden永不重生。                                                        |

未来离线门：每包定向 Vitest（真实SDK集成归tier2并登记），`npm run typecheck`、`npm run build`、精确format及 `npm run test:tier1`；触及的 integration/conformance 定向跑。旧支持版本按arch地图补最小构造器语料/签名检查，不安装未知版本；缺环境上报，不能借1.4/1.5两点宣称全范围认证。release全量/真实secure挂载仍由root按授权窗口安排。

未来**另需授权**：真实端到端多模型/provider、代理返回tier/并发/warm费用与额度实验，含认证、付费、外部网络；以及真实mount/安装/reload切换。它们不是本轮或方案review前置，也不能把未做的性能/计费验收写成通过。

## 6. 门禁、独立评审与交接

| 门      | 放行条件                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| G0 文档 | arch两项局部整合与原文JSON同源；本plan不超过约350行；精确两md prettier、JSON解析/字节校验、内部引用通过。         |
| G1 方案 | Sonnet独立review：V4诚实阻塞、判形/默认启用路径、queue/握手/清理/U1快照、文件owner冻结；不得向作者询问pass/fail。 |
| G2 实施 | 用户授权；root集中文件域与接口；V4先行spike结论及兼容策略裁定。#45整体peer支持另属原任务，不越权。                |
| G3 集成 | 各包行为测试和独立异源验收，I1/I4/I5/I7/I10/secure/I9全部闭合；新timer若不可避免必须clamp/unref且走原清理链。     |
| G4 发布 | root依仓库release规则另行授权；不把本方案视为commit/push/安装许可。                                               |

原方案时未决仅技术 V1（真实body识别覆盖）、V2（同bus组合就绪）、V3（warm并发观测）、V4（ghost兼容保证）。V1/V3是离线验证门，V2双loader公开路径若不可满足即实施接线阻塞，V4是已证旧SDK缺陷导致的实施阻塞；**没有待重问的U1/产品范围决定**。若V4公开API确实无解，root按§3.2分支向用户提出Fast功能特定宿主兼容策略另批（不改整体peer）；不能静默降为仅内存或取消保存/fork。现P0已执行且1.5七场景通过；不再重研已证旧ghost，V4只保留生产controller集成门。

本轮交接 `/tmp/fast54-plan-handoff.json` 给独立Sonnet；保留arch原fileIndex/evidence/ruledOut并区分继承与本轮抽验，附ownedhash及整合清单。未改源码、Agent参数、配置、依赖、其它任务文档、git状态；未运行build/源码测试/API/性能实验。
