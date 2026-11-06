# `/fast` 会话级服务档位架构（task54，r5）

> 2026-11-07；调研基线`a8fc1dac`。**仅架构/交接，待Plan细化、独立Sonnet评审及实施授权；未开发。**
> 非恢复已取消研究53，不启动22/39/50，不改变36/45/49。**本稿已纳入真实ask_user决定：保留本会话原生预热，一并跟随Fast。** 不暂停warming、不要求新进程开启、不新增Pi上游origin/cancel工程。

## 1. 背景与目标

### 1.1 已拍板范围

- 目标**pi-toolkit**；主会话及其**新建子agent**都受Fast状态影响。
- 模式随原session保存；恢复、分支、fork/clone按对应历史，不保存为全局模式默认值。
- **U2新增用户决定**：fast.enabled默认true、session初始inherit；未来实现后命令默认可用，不主动改请求/不写startup record。显式false紧急总开关严格I9；现在仍仅文档、代码未开发，命令尚不可用。
- **所有OpenAI Responses模型开放请求**，不限localcodex/Sol/tested provider。协议许可不代表上游已支持或落实服务档。
- **U1已真实拍板：保留预热，一并跟随Fast。** 本会话公开provider链上的合法Responses请求统一应用当前模式，包括pi原生warm；保留即时切换和原预热，费用/额度premium未知。
- 不新增Agent参数、模型tool、网页按钮、系统prompt、模型catalog、价格倍率或provider注册；不改thinking/reasoning，不请求ultrafast。
- 本轮仅架构/交接，不自动开发；后续Plan、独立Sonnet评审、实施授权不能跳过。

### 1.2 输入与证明力

完整读入`/home/bluecake/ai/chat/brain/localcodex-fast-test-report.md`、`/tmp/fast54-evidence.json`。报告36次真实请求均成功，Fast组吞吐提高约30–57%，响应tier全default；另有fast/priority对照。这是该代理链路的关联证据，不证明官方Priority落实、倍率、机制或所有代理支持。

**本轮无模型/API/性能实验、认证读取、测试/build/install、真实memory操作或依赖修改。**

### 1.3 已选择核实的关键结论

1. pi 1.0–1.5的before_provider_request只有`{type,payload}`，无event.model/api；SDK丢弃pi-ai onPayload第二个model参数，不能强转虚构。
2. SDK setModel与toolkit setModelForRun无streaming期间禁止切换条件。真实AgentSession.prepareRequest保持selection却返回本次physical model；ModelRuntime.resolveModel允许任意有凭据physical catalog目标，无同API限制。跨API虚拟路由是源码真实能力，**未读取用户真实注册表，不声称本机配置了某条路由**。
3. 采用**最终payload严格Responses判形**作为能力闸，ctx.model只辅助显示/一致性提示，参考现有cacheTTL风格；不只看input、不盲按selection注入、不要求支持任意畸形自定义provider，不默认新增上游工程。
4. api.on确实返回unsubscribe；仍固定注册，不能动态后挂绕traffic，off不卸载。
5. 原生warmer确实重放会话onPayload。按已确认U1，**无需区分warm与conversation origin**；均按进入onPayload时mode快照。已交付body不变，后续回调按新mode，不额外重发。

## 2. 现状摘要

| 路径                                               | 现状与利用点                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/index.ts`                                     | assembly only；secure最先；child pre-guard后HOST_KEY return；main cacheTTL早于末尾traffic。 |
| `src/child/wire.ts`                                | child最小组合keepalive捕获/预算/context-switch，不能依赖main session_start。                |
| `src/core/types.ts`                                | pi-free SpawnRequest/SessionSpec，可加optional内部纯数据seed，不扩Agent schema。            |
| `src/service/spawn-service.ts`                     | 同步准入后预留关系并void start；与workflow FIFO是两层queue。                                |
| `src/service/runtime-adapter.ts`                   | request→SessionSpec→ResolvedSpawnRequest及nested工具注入；Fast不进promptNotes。             |
| `src/runtime/session-driver.ts`                    | manager create/inMemory/open后创建SDK；secure检查先行，公开manager初始化是seed落点。        |
| `src/stack.ts`                                     | 每session spawn/runtime/workflow装配，nested同一spawn port；清理沿原I1栈。                  |
| `src/workflow/{host,spawner-adapter,journal}.ts`   | replay早于本地FIFO，再调用SpawnService；taskKey显式字段，须早捕获seed。                     |
| `src/goal/store.ts`                                | appendEntry/getBranch范式；不照搬active→paused及仅内存容错策略。                            |
| `src/cache-ttl/{cache-ttl,child,pipeline-ping}.ts` | messages严格捕获；Responses通常invalidate；toolkit ping/measure独立options/validator。      |
| `src/traffic/index.ts`                             | 持payload引用惰性stringify；Fast必须先替换，fetch rewrite仍可再改实际body。                 |
| `src/secure/**`                                    | 原session/child已有vault路径；Fast不用旁路store、不放宽LOCKED/cross-domain、不增D8例外。    |
| `src/adapters/pi-compat.ts`                        | TESTED_PI_RANGE仍1.0–1.4，peer仍>=1.0<1.5，#45独立拥有扩范围门禁。                          |

相关README（subagent-core、context-switch、cache-ttl-keepalive、workflow、data-encryption、traffic-merge、plugin-merge）均全文读。无web-hub变更，不引入新控制面/wire。

SDK证据：loader.js:216–232真退订；runner.js:1066–1093链式替换且异常吞并，throw不是阻断；simple-options.js:11–44合参model→thinking→request并保留onPayload/丢serviceTier；openai-responses.js最后Object.assign后才onPayload。simple与底层再次resolve不改变hook最后覆盖优先级。普通/Codex/Azure均构造body后调用onPayload；Codex随后才stringify分SSE/WS。官方本地README及extensions/models/custom-provider/sdk/sessions/session-format/virtual-models全文已读。

## 3. 总体设计

### 3.1 最小模块与依赖

建议`src/fast/`三个文件，Plan可合并小文件，不新建框架：

- state.ts：模式、record校验、branch折叠、toggle、快照；纯函数无pi依赖。
- payload.ts：Responses严格识别及浅拷贝tier；不读认证、不改模型/推理/价格。
- wire.ts：main命令/固定hook/恢复、最小child receiver、展示/错误观察。

跨层FastMode/FastSeed放core/types.ts纯数据，core不反向依赖wire；service/runtime/workflow携带数据/窄端口；index/stack仅装配。**无模块全局、Fast进程registry、Symbol共享状态、timer或明文旁路。**

| 路径                          | 有序步骤                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| main activate（fast.enabled） | cacheTTL捕获；Fast固定hook、/fast与session状态端口；stack；traffic host（Fast之后）。                                      |
| stack直派                     | SpawnService受理快照；runtime adapter；PiSessionDriver通过原manager追加seed、原child loader接收。                          |
| stack workflow                | handleAgent先seed/replay；queue(call,seed)；spawner。                                                                      |
| child pre-guard               | keepalive捕获；Fast receiver；最终预算测量；traffic child。branch模式供最终body判形和浅拷贝tier，nested受理读此child模式。 |
| session native warm           | 重放同一公开onPayload，采用同一模式、判形与快照策略。                                                                      |

### 3.2 disabled、默认、inherit分开

| 概念         | 合同                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| fast.enabled | activation冻结；U2已定默认true注册命令/固定hook。显式false紧急总开关零Fast命令/hook/读回/seed/写盘/prompt/请求变化（I9），不是“请求标准档”。 |
| 默认模式     | 新main无record→inherit；startup无人操作不append/通知/请求付费档。                                                                            |
| inherit      | hook undefined，保留原payload及已有tier，不等于off。                                                                                         |
| on           | 请求service_tier=priority。                                                                                                                  |
| off          | 显式请求service_tier=default，不删字段。                                                                                                     |

enabled activation内命令/hook常驻一次注册；off不卸载。设置只管装配，不持久化mode。U2默认true有意改变默认command/固定hook激活面：B级 `tests/fixtures/governance/activate-trace.json` 新默认true profile需按规则声明刷新（未来实施时 `PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance`），不能要求它与旧默认注册面逐字节相同。显式false profile与旧disabled基线字节不变；所有A类及nested golden永不重生。未来实现后首次直接 `/fast status` 再按需 `/fast on`，无需先改配置/reload；用户主动总关闭或再开启仍按现有非live机制reload。当前代码未开发，命令不可用，本轮不改实际settings。

### 3.3 作用范围与请求数据流

覆盖openai-responses、openai-codex-responses、azure-openai-responses的**明确Responses结构**，不限provider/model/URL。三个构造器分别核验，不把Codex SSE/WS/Azure部署当同一个实测代理。结构识别只声称responses-family，不假造唯一api/provider。

本会话公开provider hook收到的合法Responses请求统一策略：main/child正常回复、工具后续轮、既有repair continuation、**pi原生warm**。非Responses不改，mode保留suspended；切回合法Responses恢复。400/unsupported原错误可见，**Fast不新增探测/retry/删tier/降reasoning/换模型或付费重试**。

- main session_start/session_tree从getBranch恢复；compaction/context-switch不从模型messages投影读模式。
- 命令同步校验incarnation、append后更新内存；无网络等待、不waitForIdle、无warming排空/新进程前置。
- 每次onPayload入口同步读mode/revision/incarnation，严格判形，浅拷贝一次交付。**snapshot点是回调入口，不是网络发出时刻**：body已交付但尚在SDK等待发送，也保持原快照；尚未进入onPayload的warm/普通请求使用当时新mode。
- 同一body运输重试保持快照；SDK下一新request可取新mode；Fast不撤回、不自动重发、不改变原warm调度。
- child创建受理复制父mode（父suspended也复制）；queue/H2/工作树/鉴权不重取root。nested读该child当前branch。

### 3.4 后台路径边界与已拍板U1

| 调用                         | 行为                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| pi原生自动cache warmer       | 源码重放run.options含会话onPayload，**跟随本session当前Fast模式**；保留原预热与即时切档。 |
| title/Jev/topic judge        | 独立registry complete/streamSimple/classify，没有会话onPayload，不继承。                  |
| toolkit keepalive/measure    | 独立pipeline/onPayload，不经本hook；正常捕获/预算/cap/validator不变，不额外注入Fast。     |
| pi compaction/branch summary | summarization独立options无会话onPayload；不因共享模型改变tier。                           |
| external droid               | 不适用，不下传seed/参数、不改外部transcript。                                             |

U1费用告知：原生warm也可能按priority消耗premium额度/费用；代理真实计费未知，不能硬乘2。inherit/off同样影响下一次warm的hook覆写，但不改warm频率、寿命、预算或已发送请求。工具自有keepalive/measure与native warm不同，不能混为“所有后台都Fast”。

已核stop语义仅作排除证据：stop在decision消费时清run/abort，不能排空此前已过decision在飞warm；失败无可靠完成扩展事件。**本稿不使用stop、不新增cache_warming_decision handler、不读私有warmer、不写全局warming设置，不需要origin/cancel能力。** 旧稿暂停warming/新边界门禁全部撤销，不传给Plan作为前置。

## 4. 接口契约

以下为设计签名，非实现补丁；optional缺省不写undefined键，保持append-only。

### 4.1 状态与持久化

```ts
type FastMode = "inherit" | "on" | "off";
interface FastRecord {
  readonly v: 1;
  readonly mode: FastMode;
}
interface FastSeed {
  readonly v: 1;
  readonly mode: FastMode;
}
// customType: subagent:fast（旧runtime命名不迁移）
interface FastSnapshot {
  readonly mode: FastMode;
  readonly revision: number; // 仅activation内存
  readonly incarnation: object; // 每次绑定新身份，不仅sessionId
}
interface FastPersistPort {
  appendEntry(type: string, data?: unknown): void;
}
function readFastMode(branch: readonly unknown[]): FastMode;
function toggleFast(mode: FastMode): "on" | "off";
```

branch最后subagent:fast权威，只认v1+三枚举；最后畸形/未来版本→inherit+invalid-record，不穿透旧on。未知附加字段忽略，不读accessor/prototype。无record为inherit；reset追加inherit墓碑，不删历史。

记录仅v/mode，无prompt/认证/URL/父内容/价格/错误/响应，不逐request写。main pi.appendEntry，child公开manager.appendCustomEntry，secure跟原session，ephemeral用inMemory。void返回不承诺fsync/事务。**#45真实P0已证pi 1.4 append写盘失败可留内存ghost，1.5修复；getBranch重读不是持久证明**，不能把失败ghost校准成成功。失败保留最后成功状态并标storage-fault，不应用/向child继承失败新值；child初始化失败不得prompt。后续append、branch、fork、restore也不得复活failed mode。当前公开兼容策略尚未证明，列为实施前阻塞V4：先以已安装双SDK离线验证，不能声称1.0–1.5事务可靠，不用私有rollback、全局settings、明文旁路或大型sidecar绕过SDK bug，也不在Fast任务偷扩peer。

### 4.2 命令/UI

| 命令                       | 行为                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| /fast、/fast toggle        | on→off；off/inherit→on，不猜provider默认。                                                                                     |
| /fast on                   | 保存on，后续hook请求priority，包括native warm。                                                                                |
| /fast off                  | 保存off，后续hook请求default，不卸载hook。                                                                                     |
| /fast inherit、/fast reset | 保存inherit，停止本功能覆写，保留原tier。                                                                                      |
| /fast status               | 只读requested、selection、最近payloadModel/判形/注入、observed tier/API或unknown、unsupported/error，注明native warm follows。 |
| 未知/多参数                | usage错误，零变更/请求；trim+case-insensitive，不加auto/ultrafast别名。                                                        |

同mode幂等不追加record；startup/status零写。总开关false不注册命令。仅现有notify及setStatus("subagent:fast",...)，不改HUD/UI控制面。compact英文：Fast requested、Tier default requested、Fast suspended；inherit默认不占footer。

prose可中文：已请求Priority（Fast），**本会话原生预热也跟随**；代理可能重写，落实及费用/额度premium未核实；off只请求default，不保证代理停止加速，已交付/已发送请求不受影响。

requested=on、injected=priority、observed=default分离；缺回显unknown。default不是no acceleration，priority不是账单认证。只保本incarnation最近有界观察摘要，不改usage/cost、不存原始事件。native warm与普通流可能重叠，缺公开request关联时不得将某次observed硬绑定某次注入；status标为latest observed（origin unknown），不伪造逐请求确认。

### 4.3 严格Responses判形与覆写

```ts
interface ResponsesShape {
  readonly family: "responses";
  readonly payloadModel: string;
  readonly dialect: "common" | "codex-compatible";
}
type ShapeResult =
  | { readonly kind: "responses"; readonly value: ResponsesShape }
  | { readonly kind: "other" }
  | { readonly kind: "unsupported"; readonly reason: string };
function classifyResponsesPayload(payload: unknown): ShapeResult;
function rewriteFastPayload(
  payload: unknown,
  state: FastSnapshot,
  shape: ResponsesShape,
): { readonly replacement?: unknown; readonly requestedTier?: "priority" | "default" };
```

根必须同时满足：

1. 普通record（Object/null prototype），只读own data descriptor；拒绝accessor/非普通根，异常catch→unsupported。不扩可信扩展到恶意Proxy新威胁模型。
2. own model非空string、input array、stream===true、store boolean（SDK默认false，合法sampling可true）。单input绝不够。
3. 不存在其它协议根键messages/contents/prompt/system/generationConfig/generation_config/inferenceConfig/anthropic_version，即便undefined也拒混合。
4. 根键集合仅：model,input,stream,store,instructions,tools,tool_choice,parallel_tool_calls,reasoning,include,text,max_output_tokens,temperature,top_p,service_tier,prompt_cache_key,prompt_cache_retention,prompt_cache_options,metadata,user,safety_identifier,truncation,max_tool_calls,previous_response_id,conversation,background,stream_options。未知键unsupported；background=true不属已核流式会话构造器，不注入（**这不是native warm，native warm仍stream=true**）。
5. 采样数字finite，max_output_tokens正整数；instructions string、parallel_tool_calls boolean、include string[]；reasoning/text/prompt_cache_options/metadata/stream_options普通record；service_tier string/null；undefined可省略。不判断/修改reasoning强度。

input项为普通record，只接受已核变体；空input允许，其余根标记仍强制：

| 变体                                         | 关键判形                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无type或message                              | role=system/developer/user/assistant；content string或array，array仅input_text{text}、output_text{text,annotations?:array}、input_image{image_url,detail?:string}。 |
| function_call/custom_tool_call               | call_id/name string，arguments/input string，id/namespace可选string。                                                                                               |
| function_call_output/custom_tool_call_output | call_id string，output string或input_text/input_image数组。                                                                                                         |
| reasoning                                    | summary数组（summary_text文本项），encrypted_content若有string/null，id/status可选；signature不改写。                                                               |
| additional_tools                             | role=developer，tools通过下述检查。                                                                                                                                 |
| configuration_update                         | reasoning普通record、effort string。                                                                                                                                |
| tool_search_call/output                      | call_id string、execution=client；call.arguments普通record，output.tools通过检查。                                                                                  |

tools若有array；function顶层name string、parameters普通record、strict省略/boolean/null；custom要求name string、format={type:grammar,syntax:string,definition:string}。拒ChatCompletions嵌套function:{...}。tool_choice string或{type:function|custom,name:string}；其它对象本期unsupported。SDK伴随id/status/phase/description/defer_loading等保留，不遍历parameters JSON Schema/base64，不stringify全请求。

Plan用1.0–1.4三构造器实际本地body语料（text/image/tools/grammar/additional_tools/reasoning/sampling/native warm）核表，合法SDK遗漏补明确variant，不限模型名单。未知/混合自定义协议unsupported，不要求证明恶意provider不能伪装。

- inherit直接undefined，无须遍历/clone/删字段。
- on/off仅识别通过且incarnation有效才浅拷贝顶层priority/default，保嵌套引用、不写共享model。
- other→不注入+suspended；unsupported→不注入+明示unsupported-payload，原请求仍由SDK处理。fail-closed针对**覆写**，不是阻断原请求，不能显示injected。
- selection非Responses但body明确Responses以body为准；selection说Responses但body为messages绝不注入。id不一致仅提示，不能拒Azure部署/虚拟路由。
- priority取证于SDK别名/报告/Codex resolver；不代表填了options.serviceTier，成本原逻辑。
- traffic/后续插件/代理可再改tier，状态只叫at-hook注入；traffic原体/revised沿原规则。

### 4.4 child内部seed、递归与queue

```ts
// 内部字段，不进Agent schema/description
interface SpawnRequestExtension {
  readonly fastSeed?: FastSeed;
}
interface SessionSpecExtension {
  readonly fastSeed?: FastSeed;
}
interface FastParentPort {
  snapshot(parentRunId?: string): FastSeed | undefined;
}
interface FastWorkflowPort {
  capture(): FastSeed | undefined;
} // host-only依赖
```

**新执行受理时父mode权威，含inherit；既有running/任意queued不回写。**

- main Agent在SpawnService同步准入区取快照写resolved request，拒绝不写session。
- nested按受信parentRunId读父child当前branch。现有per-stack run ownership附optional只读child-state端口，绑定前读seed，绑定后读manager.getBranch，销毁撤销，不加global。
- workflow handleAgent在replay/FIFO前capture，QueuedAgentCall/internal spawn保存；adapter不丢弃，SpawnService不出队重取。
- terminal Agent resume新受理：打开child后追加新父seed覆盖旧mode，父inherit也覆盖旧on。main用户/resume/fork/tree按对应历史，不混淆。
- live steer/归并未新建child则保原mode，resume互斥不变；oldseed缺省不增seed记录/绑定通道，保持旧调用路径，enabled receiver可读旧branch，缺seed不等于off。
- droid不产生/转交seed，不改transcript。

driver先secure校验，保留child marker首条，再appendCustomEntry，之后首prompt；child不依赖main session_start，branch变更后nested读当时mode。child的原生warming同样跟随其自身模式，不追随root后来切档。

#### 公共就绪握手

不能用process-wide activation counter证明具体child就绪，不能假设不同loader默认同bus。

seed存在时driver拟通过公开createEventBus实现同bus，但**V2必须区分双loader路径，不能假定原baseLoader总存在**：A，有systemPrompt时当前toCreateOptions自建DefaultResourceLoader（含systemPromptOverride），验证公开传eventBus且保留资源/observer；B，无systemPrompt时当前使用SDK默认loader，必须另证公开API可把同bus送入该默认发现/扩展链，不能以A的构造器签名代证B。两路径分别做真实SDK离线证据，保留cwd/settings/systemPromptOverride/settings.json发现及human observer，不加-e/新toolkit路径、不重造loader覆盖资源；无seed不改旧路径。若任一路无公开可满足路径，V2阻塞接线并交root决策/必要时另批，不默认可行。receiver在wireChildSession factory同步订阅subagent:fast-bind；对应loader完成reload、首prompt前driver发{v:1,manager,reply}，manager为本child公开manager只读视图，reply进程内同步回调。

receiver绑定并reply{v:1,wired:true,readMode,dispose}，同manager幂等、异manager拒绝。bus safeHandler在首await前调用handler，reply须同步；无timer/promise轮询。无reply时on/off首prompt前fast_receiver_missing，inherit可保旧extension-missing诊断且无覆写。

不是inline替代payload extension，不注册mainUI/host/tool；human supplemental observer独立bus不用来代握手。child预算handler为lazy install，registry.subscribe可能同步重放；接线须先keepalive再Fast，再允许budget订阅/重放，最后traffic，并测试同步重放、延迟安装及重复install，不能只测常规异步顺序。handle dispose/abort/create失败清理bus/receiver/child-state端口，不只等child session_shutdown。createEventBus/eventBus option在1.0/1.4类型已核，同bus传configured extension源码已核，Plan仍补组合SDK测试。

### 4.5 replay、生命周期及错误

TaskSemantics/taskKeyOf加optional fastMode:on|off，从host seed计算；on/off入hash，inherit/disabled省略保legacy hash。模式变化miss；hit无请求不能显示已发priority。不改worker opts allowed keys/PROTO/旧JournalEntry，不迁移旧journal。

| 场景                      | 合同                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| startup/new               | 无record inherit零写；new不因parentSession header复制mode。                                 |
| main restore/reload       | 新controller按branch恢复，零重复record，无新warming前置。                                   |
| fork/clone/tree           | 对应branch最后record，分叉前无record inherit，不扫全部entries。                             |
| compaction/switch_context | 原branch custom保留，不从模型messages恢复。                                                 |
| inflight切档              | body已交付保持原快照，尚未进入onPayload按当前mode；native warm同规则，不撤回/重发。         |
| ABA/晚响应                | 每次不同incarnation，相同sessionId不复活旧闭包；旧响应不写新状态，旧child沿I1栈处理不重派。 |
| unsupported/400           | 明示错误，无Fast新增retry/fallback/降推理，不把所有400归因tier。                            |
| secure/locked             | 原manager域/child目录，LOCKED/cross-domain不变，无旁路/D8例外。                             |

## 5. 关键决策

- 最终body判形而非虚构event.model/selection盲注；无默认上游工程，未知结构明示unsupported。
- 固定hook+三态，off/default、inherit/no-op、disabled/零注册分离，不破traffic顺序。
- priority统一值、三构造器分别验证；不限provider模型，不假支持畸形协议。
- 原session custom随branch/fork/secure，不存全局mode/旁路文件。
- 受理child快照，不实时广播，两层queue/递归/terminal resume时点明确，frozen Agent surface不动。
- **U1已选择保留warming跟随Fast**：不禁warm、不要求排空，不需origin；明确premium未知和回调快照边界，后台独立pipeline仍不继承。
- requested/injected/observed分离，不硬乘2，不把default当no acceleration。

## 6. 实施要点（交Plan，非开发授权）

### 6.1 分包与共享冻结面

按Plan §4：P4a先冻结core/types、配置/spec、Fast窄端口与必要最小stack端口签名；P2持有workflow/{types,host,spawner-adapter,journal,replay,call-registry}.ts（TaskSemantics/QueuedAgentCall新增optional字段，queue-mirror引用只读），P3独占runtime-adapter/session-driver/准入。P4b最后消费P1/P2/P3实际接线index/stack/teardown/child wire/command/trace。P4a与P4b同唯一owner串行，不给P2/P3修改stack/core类型，不以P4b反向阻塞P4a形成环；Plan列精确路径，不为分包造框架。

#45可能动compat/cacheTTL类型/支持文档；Fast不改peer/package/lock/TESTED_PI_RANGE，仍>=1.0<1.5。globalCLI1.5/localSDK1.4不代表当前loaded已知。初始B3 pending三文件(memory gate脚本/测试/pg-report)不是本任务资产，不接管并行变化。

### 6.2 测试门禁（本阶段未运行）

| 门禁             | 覆盖                                                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| state/command    | 三态/toggle/错误/reset墓碑/幂等/畸形未来record；append失败保留最后成功状态及storage-fault，ghost后并发后续append/branch/fork/restore不复活failed mode，child初始化失败不得prompt；切档即时无warming前置。                                                                                                                        |
| 判形             | 三构造器text/image/tool/grammar/additional_tools/reasoning/sampling/native warm/空input；单input/混合协议/嵌套Chat工具/accessor/未知variant拒；合法SDK遗漏补表不限模型。                                                                                                                                                         |
| 本地真实SDK stub | 1.0–1.4及#45隔离1.5对照；合参后注入、Codex SSE/WS、Azure部署；stream切模型/跨API虚拟路由按body。无外部API。                                                                                                                                                                                                                      |
| 快照/生命周期    | body引用/推理不变，deep freeze model；inflight/运输重试；restore/reload/fork/clone/tree/compaction/switch_context/ABA。                                                                                                                                                                                                          |
| child            | 直派/递归/workflow/terminal resume父三态；两层queue不重取，root不回写running/queued；child branch后nested正确；oldseed/缺receiver/双loader公开同bus/失败dispose，无mainUI/host/tool；lazy budget含registry同步重放顺序。                                                                                                         |
| replay           | on/off miss，inherit/disabled legacy hash不变，hit无请求。                                                                                                                                                                                                                                                                       |
| warming          | 保留原调度/频率；原生warm before/after onPayload切档快照：已交付body不变、待回调用新mode；warm与普通流重叠仍不靠origin猜；费用提示/观察不逐请求假关联；不注册stop handler/改global设置。                                                                                                                                         |
| cache/traffic    | toolkit正常capture/ping/measure不注入；预算含tier；traffic记录与发送/revised一致，Fast固定先注册。                                                                                                                                                                                                                               |
| secure/I9/frozen | 原manager路径/LOCKED/cross-domain不变；默认true新增命令/固定hook，初始inherit不改payload/无startuprecord；显式false零注册/seed/读写/prompt/请求且旧disabled字节不变；nested frozen永不改、A类不重生；B级tests/fixtures/governance/activate-trace.json新默认true profile按PI_TOOLKIT_UPDATE_TRACE=1有意更新、tests/tiers.ts登记。 |

实施时typecheck/format/tier1+触及定向tier2；release全量/secure由root按授权环境安排。本阶段不跑这些命令、不做真实mount/API/性能。Sonnet重点：判形完整性、queue/child状态、同bus/cleanup、U1保warm快照边界、冻结面与#45支持界线。

### 6.3 剩余项

**无未决产品问题；U1已拍板，不再询问。** V4持久化兼容是实施前技术阻塞，不是已批准的上游改造。Plan定向核验识别表完整性、公共child握手及native warm组合快照测试，给出V4最小验证路线及无法满足时的root决策建议；不泛调研、不新增上游工程。旧暂停/新边界前置全部排除。后续评审/用户实施闸门仍保留。

## 附录A：结构化交接原文

root仅机械提取以下HTML标记之间JSON正文（不含标记，无代码围栏）到`/tmp/fast54-arch-handoff.json`，下一Plan读同份原文。architect本轮只写.md，未自行创建JSON。

<!-- FAST54_ARCH_HANDOFF_JSON_BEGIN -->

{
"task": 54,
"revision": 5,
"phase": "architecture-only",
"base": "a8fc1dac",
"document": "/home/bluecake/ai/pi-toolkit/docs/dev/fast-command/arch.md",
"conclusion": "公开before_provider_request对最终Responses payload严格判形，固定顺序浅拷贝priority/default；ctx.model仅辅助，不虚构event.model/api、不默认上游工程。三态随session历史，child受理seed、两层queue/replay隔离，Agent公共surface不动。U1已真实ask_user选择保留原生预热并跟随Fast：session hook合法Responses统一策略，native warm同回调快照；不暂停/排空、不要求新进程、不改Pi。独立title/Jev/judge/toolkit ping/measure不继承。仅架构，Plan+独立Sonnet评审及实施授权前不开发。",
"confirmedUserDecisions": ["pi-toolkit", "主会话与新建子agent", "随session历史恢复/分支/fork", "所有Responses模型不限provider/Sol", "最终payload严格判形，ctx.model仅辅助", "不默认新增Pi上游工程", "U1已ask_user：(Recommended) 保留预热，一并跟随Fast；接受native warm当前on/off与premium未知", "已交付body不变，尚未进入onPayload按当时mode快照", "U2已ask_user：fast.enabled默认true使命令未来开箱可用；session初始inherit、不主动改payload/无startuprecord；显式false紧急总开关严格I9", "交接原文在arch附录，机械提取", "仅架构/Plan/独立Sonnet评审，不自动开发"],
"fileIndex": [
{"path":"/home/bluecake/ai/chat/brain/localcodex-fast-test-report.md","role":"实测输入不重跑","readFully":true},
{"path":"/tmp/fast54-evidence.json","role":"探索全文；openQuestions非事实","readFully":true},
{"path":"skills/agent-handoff/SKILL.md","role":"核验纪律","readFully":true},
{"path":"skills/dev-flow/SKILL.md","role":"L3门禁","readFully":true},
{"path":"docs/dev/subagent-core/README.md","role":"core/runtime/service/teardown","readFully":true,"lines":"1–127单独read，128–207合并输出"},
{"path":"docs/dev/context-switch/README.md","role":"child boundary","readFully":true},
{"path":"docs/dev/cache-ttl-keepalive/README.md","role":"capture/ping/measure/#45","readFully":true},
{"path":"docs/dev/workflow/README.md","role":"FIFO/replay/预算","readFully":true},
{"path":"docs/dev/data-encryption/README.md","role":"session/vault/D8","readFully":true},
{"path":"docs/dev/traffic-merge/README.md","role":"录制/rewrite/Codex","readFully":true},
{"path":"docs/dev/plugin-merge/README.md","role":"pre/postguard","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/README.md","role":"官方入口","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md","role":"3347行全文四段read","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md","role":"合参/选择","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md","role":"onPayload义务","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md","role":"公共SDK/loader/manager","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md","role":"restore/tree/fork","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md","role":"custom/branch/compaction","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md","role":"selection/physical","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/06-extensions.ts","role":"loader示例","readFully":true},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/11-sessions.ts","role":"manager示例","readFully":true},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts","role":"event仅payload/on/无warming end","readFully":false,"lines":"685–725,1190–1220；ExtensionEvent/warming/isStreaming grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js","role":"on退订/bus","readFully":false,"lines":"213–234,412–435；eventBus/loadExtensionFromFactory grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js","role":"替换/懒getter","readFully":false,"lines":"613–655,1055–1095；createContext grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js","role":"丢model/warmer复用onPayload","readFully":false,"lines":"185–365及关键grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts","role":"公共options","readFully":true},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js","role":"route/setModel/dispose/warming定位","readFully":false,"lines":"435–486,1008–1030,1990–2030,3310–3355,3540–3590；warming等grep(186,684,1042–1049等)"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts","role":"SDK warming端口非ctx","readFully":false,"lines":"396–399及warming grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.d.ts","role":"warming全局setter排除","readFully":false,"lines":"150–152及warming grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js","role":"真实跨API physical route能力","readFully":false,"lines":"495–523,728–761及virtual grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/virtual-models.js","role":"pi-virtual selection","readFully":false,"lines":"1–100"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js","role":"selector直接setModel","readFully":false,"lines":"4380–4455及相关grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts","role":"公开manager","readFully":false,"lines":"appendCustomEntry/getBranch grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js","role":"custom/branch/fork","readFully":false,"lines":"890–920,1054–1078,1200–1255及grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts","role":"eventBus公共option","readFully":false,"lines":"35–142及grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js","role":"同bus传配置扩展","readFully":false,"lines":"860–891；eventBus grep(248,511,530,883等)"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.d.ts","role":"emit/退订契约","readFully":true},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js","role":"同步前缀reply","readFully":true},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts","role":"公开createEventBus","readFully":false,"lines":"7 grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js","role":"复用options/在飞/stop排除证据","readFully":false,"lines":"1–96,100–181,175–278；warming grep"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.d.ts","role":"warming类型","readFully":true},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js","role":"独立summary options","readFully":false,"lines":"448–467；streamFn/onPayload/onResponse/sessionId grep(463–486等)"},
{"path":"node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/branch-summarization.js","role":"独立summary","readFully":false,"lines":"streamFn/onPayload/onResponse/sessionId grep(188–225等)"},
{"path":"node_modules/@earendil-works/pi-ai/dist/api/simple-options.js","role":"合参/onPayload保留/serviceTier丢","readFully":true},
{"path":"node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js","role":"body构造与hook","readFully":false,"lines":"130–165,195–220,240–337"},
{"path":"node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js","role":"items/tools/cost/events","readFully":false,"lines":"1–329,333–374,510–550及type/role grep"},
{"path":"node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js","role":"Codex body/SSE/WS hook","readFully":false,"lines":"158–192,370–439,459–465及grep"},
{"path":"node_modules/@earendil-works/pi-ai/dist/api/azure-openai-responses.js","role":"Azure部署/body/合参","readFully":true},
{"path":"node_modules/openai/resources/responses/responses.d.ts","role":"tier语义","readFully":false,"lines":"960–996"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js","role":"最低版缺model参数","readFully":false,"lines":"transformProviderPayload至handleProviderResponse段及grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js","role":"版本对照","readFully":false,"lines":"transformProviderPayload段"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.2.0/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js","role":"版本对照","readFully":false,"lines":"transformProviderPayload段"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js","role":"版本对照","readFully":false,"lines":"transformProviderPayload段"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js","role":"独立对照","readFully":false,"lines":"transformProviderPayload段"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts","role":"最低版event/on","readFully":false,"lines":"BeforeProviderRequestEvent后7行及on grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts","role":"event对照","readFully":false,"lines":"BeforeProviderRequestEvent后7行"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.2.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts","role":"event对照","readFully":false,"lines":"BeforeProviderRequestEvent后7行"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts","role":"event对照","readFully":false,"lines":"BeforeProviderRequestEvent后7行"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts","role":"event对照","readFully":false,"lines":"BeforeProviderRequestEvent后7行"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js","role":"能力定位","readFully":false,"lines":"emitBeforeProviderRequest grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts","role":"最低版eventBus option","readFully":false,"lines":"74 grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts","role":"最低版createEventBus","readFully":false,"lines":"7 grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js","role":"warming版本核验，最终不新增stop","readFully":false,"lines":"isReplayable/cache_warming_decision grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js","role":"warming版本对照","readFully":false,"lines":"isReplayable/cache_warming_decision grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.2.0/node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js","role":"warming版本对照","readFully":false,"lines":"isReplayable/cache_warming_decision grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js","role":"warming版本对照","readFully":false,"lines":"isReplayable/cache_warming_decision grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js","role":"warming版本对照","readFully":false,"lines":"isReplayable/cache_warming_decision grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.0.0/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js","role":"最低版hook","readFully":false,"lines":"onPayload/service_tier/processResponsesStream grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.0.0/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js","role":"最低版Codex","readFully":false,"lines":"onPayload/service_tier/processResponsesStream grep"},
{"path":"/tmp/pi-adapt-lPbUM0/pi1.0.0/node_modules/@earendil-works/pi-ai/dist/api/azure-openai-responses.js","role":"最低版Azure","readFully":false,"lines":"onPayload/service_tier/processResponsesStream grep"},
{"path":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-44DLKSKE.js","role":"1.5仍缺model","readFully":false,"lines":"892内transformProviderPayload/onPayload片段，非整条超长行"},
{"path":"src/index.ts","role":"装配顺序","readFully":false,"lines":"130–310,420–450,1210–1240"},
{"path":"src/child/wire.ts","role":"最小child","readFully":true},
{"path":"src/goal/store.ts","role":"持久化范式","readFully":true},
{"path":"src/core/types.ts","role":"内部request/session","readFully":false,"lines":"200–240,1370–1435及grep"},
{"path":"src/service/spawn-service.ts","role":"准入/queue/nested","readFully":false,"lines":"595–645,800–900,1050–1145及grep"},
{"path":"src/service/runtime-adapter.ts","role":"映射/nested","readFully":false,"lines":"640–725,730–770,1000–1085及grep"},
{"path":"src/runtime/session-driver.ts","role":"manager/create/resume","readFully":false,"lines":"85–185,330–405,430–480,690–860及grep"},
{"path":"src/runtime/human-runtime.ts","role":"原loader先例非同bus","readFully":false,"lines":"1–190,198–245及grep；700–770为空"},
{"path":"src/runtime/runner.ts","role":"setModel无stream闸","readFully":false,"lines":"538–557及SessionSpec grep"},
{"path":"src/runtime/input-budget-registry.ts","role":"预算/dispose旁证","readFully":false,"lines":"1–80"},
{"path":"src/tools/set-model-tool.ts","role":"切模型定位","readFully":false,"lines":"setModel/isStreaming grep(251,268,302等)"},
{"path":"src/workflow/spawner-adapter.ts","role":"请求转发","readFully":true},
{"path":"src/workflow/host.ts","role":"replay先FIFO","readFully":false,"lines":"889–1010,1120–1215,1270–1320及grep"},
{"path":"src/workflow/journal.ts","role":"taskKey字段表","readFully":false,"lines":"1–130"},
{"path":"src/stack.ts","role":"runtime/spawn装配","readFully":false,"lines":"1530–1548,1568–1595,1620–1665及grep"},
{"path":"src/cache-ttl/cache-ttl.ts","role":"严格messages闸","readFully":false,"lines":"530–610"},
{"path":"src/cache-ttl/child.ts","role":"capture-only/dispose","readFully":false,"lines":"100–160,179–225"},
{"path":"src/cache-ttl/pipeline-ping.ts","role":"独立ping/measure","readFully":false,"lines":"350–410"},
{"path":"src/traffic/index.ts","role":"惰性引用记录","readFully":false,"lines":"660–704"},
{"path":"src/title/index.ts","role":"独立registry","readFully":false,"lines":"streamSimple/complete/errorMessage grep"},
{"path":"src/title/title.ts","role":"成功消息旁证","readFully":false,"lines":"errorMessage/stopReason grep"},
{"path":"src/topic-switch/wire.ts","role":"独立judge","readFully":false,"lines":"streamSimple/complete/errorMessage grep"},
{"path":"src/topic-switch/hold.ts","role":"错误检查旁证","readFully":false,"lines":"errorMessage/stopReason grep"},
{"path":"src/memory/jev/client.ts","role":"独立classifier","readFully":false,"lines":"291–338及grep"},
{"path":"src/adapters/pi-compat.ts","role":"范围1.0–1.4","readFully":false,"lines":"TESTED_PI_RANGE grep"},
{"path":"docs/dev/pi-version-adaptation/plan.md","role":"#45旧计划仅定位","readFully":false,"lines":"1.5/peer/TESTED_PI_RANGE/history grep前25条"},
{"path":"tests/governance/activate-trace.test.ts","role":"B级刷新规则","readFully":false,"lines":"1–100"},
{"path":"tests/governance/trace-profiles.ts","role":"激活profiles","readFully":true},
{"path":"docs/dev/fast-command/arch.md","role":"唯一仓库写入r4全文与交接","readFully":true}
],
"evidence": [
{"id":"E1","claim":"event只有payload，无model/api","file":"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts","lines":"692–696；sdk.js:224–229"},
{"id":"E2","claim":"实际setModel无streaming禁令","file":"node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js","lines":"2008–2022；src/runtime/runner.ts:538–557；interactive-mode.js:4413–4426"},
{"id":"E3","claim":"虚拟路由真实支持跨API目标，未读用户真实配置","file":"node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js","lines":"435–484；model-runtime.js:738–759；virtual-models.js:1–8"},
{"id":"E4","claim":"普通Responses完整根结构/合参后hook","file":"node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js","lines":"247–315；139–143"},
{"id":"E5","claim":"Codex同族body且hook先于SSE/WS stringify","file":"node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js","lines":"174–187,375–436,459–465"},
{"id":"E6","claim":"Azure同族且body model为部署名","file":"node_modules/@earendil-works/pi-ai/dist/api/azure-openai-responses.js","lines":"27–56,151–159及最后sampling Object.assign段"},
{"id":"E7","claim":"items/tools具体构造提供严格判形依据","file":"node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js","lines":"91–329,333–370"},
{"id":"E8","claim":"api.on真退订，throw不阻断，固定先traffic注册","file":"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js","lines":"216–232；runner.js:1066–1093"},
{"id":"E9","claim":"model→thinking→request，Simple保onPayload丢serviceTier","file":"node_modules/@earendil-works/pi-ai/dist/api/simple-options.js","lines":"11–44；openai-responses.js:200–214,309–315"},
{"id":"E10","claim":"priority/fast别名/default语义不证明代理落实","file":"node_modules/openai/resources/responses/responses.d.ts","lines":"965–993"},
{"id":"E11","claim":"traffic持引用，Fast须先返回替换体","file":"src/traffic/index.ts","lines":"675–704；src/index.ts:1231–1234"},
{"id":"E12","claim":"toolkit cacheTTL独立capture/ping/measure，不经过Fast session hook","file":"src/cache-ttl/cache-ttl.ts","lines":"552–590；child.ts:124–150；pipeline-ping.ts:357–410"},
{"id":"E13","claim":"native warm复用含onPayload的run.options，按U1自然跟随session模式","file":"node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js","lines":"208–245；sdk.js:261–273"},
{"id":"E14","claim":"stop不排空已获准在飞warm；最终不采用stop或排空前置","file":"node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js","lines":"110–149,172–188,208–260"},
{"id":"E15","claim":"warm与普通流无可靠请求关联，latest observed不能假逐请求确认","file":"node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js","lines":"247–258；agent-session.js:186；extensions/types.d.ts:1081,1202"},
{"id":"E16","claim":"child preguard先traffic，不依赖main start","file":"src/index.ts","lines":"266–282；src/child/wire.ts:1–68"},
{"id":"E17","claim":"公开manager/secure检查是seed落点","file":"src/runtime/session-driver.ts","lines":"752–831"},
{"id":"E18","claim":"eventBus/createEventBus有公共类型源码依据；不等于已证明无systemPrompt的SDK默认loader可传同bus，双路径仍受V2验证门","file":"node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts","lines":"74；resource-loader.js:248,511,530,883；dist/index.d.ts:7；1.0对应声明同位置"},
{"id":"E19","claim":"bus同步前缀可reply，dispose invalidate runtime","file":"node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js","lines":"1–24；extensions/loader.js:420–430；agent-session.js:1011–1030"},
{"id":"E20","claim":"replay早于FIFO，seed须早捕获，hash显式字段","file":"src/workflow/host.ts","lines":"889–1010,1164–1215,1292–1320；journal.ts:69–84"},
{"id":"E21","claim":"custom按branch随历史，不进模型context","file":"src/goal/store.ts","lines":"1–21,51–66；session-manager.js:901–913,1062–1075,1205–1245"},
{"id":"E22","claim":"成本看响应tier/options，不伪造倍率","file":"node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js","lines":"516–525"},
{"id":"E23","claim":"1.5也缺event模型，Fast不提前扩peer","file":"/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-44DLKSKE.js","lines":"892的transformProviderPayload片段；src/adapters/pi-compat.ts:130"},
{"id":"D1","claim":"U1真实ask_user已选择保留预热并跟随Fast，撤销暂停/新边界前置","file":"docs/dev/fast-command/arch.md","lines":"§1.1、§3.4；依据调用方最新明确转达的用户决定，非源码推断"}
],
"ruledOut": [
{"target":"缺event.model默认必须改上游","why":"撤销，已核构造器严格body门禁可行，不扩恶意provider威胁模型"},
{"target":"ctx.model盲注/单input识别","why":"真实切模型/跨API路由；根/items/tools严格判形，selection仅辅助"},
{"target":"on动态后挂/off卸载","why":"破traffic且off要default，退订真实不代表该策略正确"},
{"target":"共享samplingParams/provider注册/克隆setModel","why":"隔离/后台范围/恢复不一致，不重走已排除路径"},
{"target":"SimpleStreamOptions.serviceTier","why":"streamSimple丢弃，onPayload保留"},
{"target":"暂停native warming/要求fresh process/在飞排空/新增origin API","why":"U1已真实拍板保留预热跟Fast；统一session onPayload策略，无这些前置，不改Pi"},
{"target":"native warm天然旁路/stop等于排空/逐请求上游确认","why":"复用onPayload且并发缺关联；展示requested/at-hook/latest observed，不假确认"},
{"target":"不同loader隐含同bus/counter证明具体child ready","why":"默认独立bus/counter并发误判；显式公共bus同步reply"},
{"target":"新增Agent参数/prompt代替payload/改nested frozen","why":"用户禁止，frozen永不动"},
{"target":"root广播running/queued/出队重取","why":"受理快照不可变，两层queue必须保存"},
{"target":"onlymain/onlylocalcodex/Sol/tested provider","why":"违反全部Responses范围，合法结构闸不是模型名单"},
{"target":"全局mode/明文旁路/网页按钮/硬乘2/ultrafast","why":"超范围且不满足历史/secure/费用证据"}
],
"settledInterfaces": {
"mode":"inherit | on | off；priority/default/不改payload",
"record":"subagent:fast data={v:1,mode}；主appendEntry，child公开manager.appendCustomEntry。#45实证1.4 append失败留内存ghost、1.5修复；getBranch非持久证明。失败保留最后成功状态+storage-fault，不应用/继承失败新值，child初始化失败不得prompt；后续append/branch/fork/restore不得复活failed mode。公开兼容策略为实施前阻塞V4，不偷扩peer/私有rollback/全局settings/明文旁路。",
"config":"U2已拍板fast.enabled默认true，未来命令默认可用；session初始inherit不改payload/无startuprecord。显式false紧急总开关严格I9零注册/seed/read/write/payload；非live设置主动关闭/再开启仍reload。B级tests/fixtures/governance/activate-trace.json新默认true profile有意按PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance刷新，显式false旧disabled字节不变；A类及nested golden不重生。当前代码未开发命令不可用。",
"recognizer":"model/input[]/stream=true/store:boolean + 根键/混合协议拒绝 + 已核items/tools；未知unsupported，ctx.model仅辅助",
"nativeWarming":"U1已定保留并跟随Fast，session hook合法Responses统一当前模式；已交付body不变，尚未进入onPayload按当时快照；无暂停/排空/新进程前置",
"backgroundBoundary":"title/Jev/topic judge/toolkit keepalive/measure不经该hook，仍不继承；不改原warming频率/预算",
"seed":"SpawnRequest.fastSeed?与SessionSpec.fastSeed?内部纯数据，不进Agent schema",
"admission":"Agent同步准入；workflow replay/FIFO前；nested读父child branch；queue不重取",
"resume":"terminal Agent resume新父seed覆盖旧child含inherit；main用户restore/fork/tree按历史",
"readiness":"V2双路径分别公开验证：有systemPrompt时toCreateOptions自建DefaultResourceLoader传eventBus；无systemPrompt时SDK默认loader需另证同bus路径，不假定baseLoader总存在。任一路无公开路径则阻塞接线交root决策，不重造loader/丢observer。subagent:fast-bind(manager,reply)同步readMode/dispose；缺on/off receiver首prompt前失败；handle清理。child lazy budget含registry同步重放保持keepalive→Fast→budget→traffic。",
"workflow":"fastMode?仅on/off入hash，inherit/disabled省略保legacy；worker opts/PROTO不变",
"ui":"command notify/setStatus，compact英文；requested/injected/latest observed区分，native warm跟随及premium未知明示，不逐请求假确认",
"cleanup":"peractivation incarnation，handle撤销child-state/bus，无timer/global registry"
},
"openQuestions": [
{"id":"V1","kind":"technical-validation","question":"Plan以1.0–1.4三构造器本地body语料核识别表，补合法variant，含native warm，不转provider名单。"},
{"id":"V2","kind":"technical-validation","question":"真实SDK本地stub验证同bus同步bind、branch/nested、缺receiver/失败/dispose、有systemPrompt自建loader和无systemPrompt SDK默认loader分别公开同bus/human wiring并存；任一路无公开路径即V2阻塞接线。"},
{"id":"V3","kind":"technical-validation","question":"native warm与普通流并发、切档跨onPayload快照、latest observed不假关联，toolkit capture/ping/measure/traffic原合同不变；无真实模型/性能实验。"},
{"id":"V4","kind":"implementation-blocker","question":"公开API如何在旧SDK append ghost下证明失败新值不会经后续并发append/branch/fork/restore复活？先双SDK离线spike；保留最后成功状态+storage-fault，child初始化失败不得prompt。无法证明则交root裁定兼容放行策略，不默许上游工程/私有rollback/sidecar/peer扩域。"}
],
"needsNewUserDecision": [],
"nextSteps": ["root机械提取FAST54_ARCH_HANDOFF_JSON_BEGIN/END之间JSON原文到/tmp/fast54-arch-handoff.json", "Plan读同份原文并按坐标选择核验，细化精确分包/门禁", "独立Sonnet评审与实施授权，U1不再重问", "本轮停止，不开发/实验/扩peer"],
"untouchedInitialPending": ["docs/dev/memory-governance/pg-report.md", "scripts/dev/memory36-gate.mjs", "tests/memory/govern/gate-script.test.ts"],
"validationThisPhase": "只读官方本地文档/源码/git状态；唯一仓库写入arch.md；无test/build/install/API/性能/认证读取；未创建/tmp JSON"
}
<!-- FAST54_ARCH_HANDOFF_JSON_END -->
