# Web Hub 助手 tokens/s：多 API 与总输出口径设计

> 日期：2026-11-08；版本：r4；性质：架构与实施方案，不含实现。
> 最新裁定：P1 `openai-completions` 先行，P2 `anthropic-messages` 随后采用保守隐藏；接受“唯一 open lane + 最终总量严格相等”的落地判据。**不是密码学归属，是高度约束的启发式 + 同源上报总量的严格等值检查**，不声称与 Responses 等价强度，也不声称独立验证了计数。
> 不等待 SDK 能力，不做 witness/epoch 接口，不改 SDK、不伪造 witness。Anthropic 支持**在无歧义时出数、有歧义时隐藏**，不是默认100%隐藏；完整观测、唯一且不与测量重叠的 external lane 可自然关闭，真实污染不清洗。
> 本轮只写本文；源码/SDK只读，未执行测试、构建、安装、reload 或 git。下述门禁均为后续要求，不是测试已通过的证据。
> 本文替代 `plan.md` r3.1 的 reasoning=0、summary/redacted否决、证据B恒false等旧限制；原身份、计时阈值、持久化、安全、恢复和冻结约束继续有效。

## 修订记录 r3：逐条回应上一轮四项评审

| 编号/等级                                   | r3处置与可验收结论                                                                                                                                                                                                                                                                                                                           | 落点                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| R1 blocker：A的延迟stop替B完成              | 删除witness/epoch先决条件；**stop不再是证明成立的必要条件，也不提供正证据**，因此不能替任何消息“完成证明”。保留跨reset的已知open污染、双/重复start否决，并新增无法归属唯一open lane的裸尾立即invalid。分别推演A.start可见/不可见；隐形外流在唯一lane内的同形尾用量不能绝对识别，不声称数学上消除。残余风险表述以r4的“未测量、无法估计”为准。 | §4.4、§6.4、P0-A1/A2/A5 |
| R2 major：Chat中途换ID，normalized/final仍A | 保留每个raw chunk的own合法ID恒等检查；A→B→A首次B即invalid，切回不修复，binding前也检查，不能异ID ignore。                                                                                                                                                                                                                                    | §4.3、P0-C1/C2/C3       |
| R3 major：顺序假设不成立                    | raw与公开start/binding无先后假设。P1由awaited turn_start建立有界capture，按身份join；P2允许raw start先于公开start消费，但真实raw terminal先于raw start属于裸尾，不能晚到start修复。一次性SSE、延迟handler进入P0。                                                                                                                            | §3.2、§4.1、§6.2        |
| R4 major：Responses completed后新增生成     | 保留raw closed后新增语义事件否决；与completed前raw已入队、随后才消费的normalized delta分开。前者invalid，后者正常计时，不恢复旧的一律截断normalized delta规则。                                                                                                                                                                              | §4.2、P0-R1/R2          |
| 最新裁定覆盖r3初稿的部分                    | 不采用“所有匿名尾一律invalid→100%隐藏”。匿名terminal在唯一、未污染、ID可join的主open lane内可形成候选用量；最终严格等值才放行。匿名stop只做矛盾检查。保守启发式仍有可塑性，§6.4明确触发必要条件和验证边界。                                                                                                                                  | §1.2、§4.4、§6.4        |

## 修订记录 r4：收尾落实r3复审的三项finding

r3复审结论为**有条件通过，0 blocker，3条finding**。本轮仅落实以下修订及复审确认的SDK事实，不新增实现范围。

| 编号/等级                            | r4处置与可验收结论                                                                                                                                                                                                                                                                                                                                                                                                        | 落点                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| F1 major：完整external流导致永久污染 | 区分“完整且不重叠的external lane自然关闭”与“已污染guard清洗”。前者须完整观测start→合法terminal→stop、始终唯一、全程未与测量重叠且guard未污染；terminal仅记自身顺序，stop仅关闭自身lane，永不写主proof/usage/terminal/stop证据。双open、裸尾和已知重叠仍整体污染，reset/new turn/匿名stop均不清洗；明确承诺该activation余下Anthropic长期无徽章。新增完整外流后B、C后续轮次准确出数，以及污染后后续轮次继续隐藏的对照测试。 | §3.2、§4.4.1–4.4.2、§4.6、§6.1、P0-A1/A3/A7、§6.4.2 |
| F2 minor：无依据的风险概率与丢帧例子 | 统一为“未测量、无法估计”；删除不能证明可达的极短主回复/代理丢terminal但SDK仍成功例子。区分代理将整条terminal从SDK输入移除（pending并报错）与仅speed回调漏转（SDK仍消费，须故障注入验证）。不以warming预算推断发生概率。                                                                                                                                                                                                   | §2、§6.2、§6.4.1                                    |
| F3 minor：等值不是独立计数验证       | 指标改为“provider按其协议上报的总输出（含推理）”；raw与final可能同源，无法检测同源多报/漏报。严格等值仍保留，不加容差、不做补算、不把reasoning重复相加。                                                                                                                                                                                                                                                                  | 文首、§1.1–1.2、§4.1、§5.2–5.3、§6.4.1              |
| 复审确认事实（设计依据，非新决策）   | SDK默认`cacheWarming: "streaming"`；warming受可重放、TTL可得及经济门约束，约0.9×TTL才触发，streaming在settled停止。Chat采用`responseId                                                                                                                                                                                                                                                                                    |                                                     | = chunk.id`；Responses在completed后继续读流。不能把默认warming等同于每轮并发。 | §2、§4.2–4.3、§6.4.2 |

## 1. 背景与目标

### 1.1 指标与范围

现有实现仅解析Responses完成事件，且要求raw reasoning token严格为0。本次扩展多API解析和含推理的总输出口径，同时保留归属、终结和生命周期的防混流措施。

| 家族               | `api`                                        | raw总输出字段                                                                     | 交付策略                                                  |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Responses          | `openai-responses`、`openai-codex-responses` | `response.completed.response.usage.output_tokens`                                 | P1：ID完成证明 + raw尾后否决                              |
| Chat Completions   | `openai-completions`                         | terminal `usage.completion_tokens`；限定回退 `choices[0].usage.completion_tokens` | P1：逐chunk ID + finish/usage                             |
| Anthropic Messages | `anthropic-messages`                         | terminal `message_delta.usage.output_tokens`                                      | P2：唯一open lane启发式 + 最终等值 + 污染否决；stop非必需 |

```text
tokens = provider按其协议上报的总输出（含推理）
       = raw总输出 = final AssistantMessage.usage.output（严格等值，不重复相加）
genMs = 最后一个非空normalized生成delta的本地摄取时间
      - 第一个非空normalized生成delta的本地摄取时间
speed = tokens * 1000 / genMs
```

产品名统一为**总输出速度（本地观测窗口）**，不是可见文本速度、完整原生thinking耗时、端到端速度或GPU吞吐。首delta前隐藏推理的token含在分子，其不可见耗时不进入分母，不估算不可见时间。这里展示的是provider按其协议上报的计数，不是本模块重新分词得到的独立计数；**无法检测raw与final同源的多报/漏报**。

### 1.2 硬约束和保证边界

- 不改hub网络协议、PROTO、core/metadata schema；core仍为`{v:1,tokens,genMs,deltaCount}`。
- 不新增设置、注册项、计时器、模块级可变状态、provider名白名单、请求拦截器或SDK补丁。状态在activation闭包内、有界，只存标量、不存正文。
- 主session exact-mid metadata持久化；child/run仅live；旧历史不回填；off byte-identical。
- **任何观测到的歧义优先隐藏**：invalid/disabled为吸收态；final成功/总量相等不能覆盖已记录污染。禁止部分覆盖、最近值、重开当前测量后继续出数。完整且不重叠的external lane自然关闭不属于污染恢复，详见§4.4。
- binding只晚于raw、但每条生成delta同步齐备时可join；某条生成delta当时缺binding、后来补齐则invalid，不能追认。
- 数值必须来自合法raw总量且严格等于final output；这是上报值一致性门，不是独立计数验证，无法检测同源多报/漏报；不加容差、不做补算。Anthropic的匿名归属仍是受约束启发式；“保守隐藏”不能表述为已证明在任意不可见外流下零错配，残余风险**未测量、无法估计**，见§6.4。也不能因该残余风险把全部正常流禁用。

## 2. 现状摘要

| 路径                                                                                | 当前职责/设计依据                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/web-hub/agent/message-speed.ts`                                                | 单observation/pending；delta计时、raw证明、end盖章、persist exact-owner写入。目前raw无observation/binding即丢弃；`o.completed`拒绝后续normalized delta |
| `src/web-hub/agent/message-speed-binding.ts`                                        | 每条update同步复制responseId/provider/api/model own-data标量，不读content/usage                                                                        |
| `src/web-hub/agent/message-speed-wire.ts`                                           | 既有公开provider_stream_event注册；同步binding→tap；无request token/producer出生边界                                                                   |
| `src/web-hub/agent/event-tap.ts`                                                    | 合并前delta-only；message_end盖wire副本，不改SDK对象                                                                                                   |
| `src/web-hub/protocol/message-generation.ts`                                        | own-data、ID/core sanitizer、512项历史map                                                                                                              |
| `src/web-hub/ui/src/components/transcript/TxAssistant.vue`                          | speed与费用独立，streaming隐藏，使用既有tooltip key                                                                                                    |
| `src/web-hub/ui/src/i18n/{zh,en}/transcript.ts`                                     | `transcript.generationSpeedTitle`仍为旧“完整可观测”口径，实施时同步                                                                                    |
| `tests/web-hub/agent/{message-speed,message-speed-p0,wiring-message-speed}.test.ts` | 单测、真实SDK fake fetch、接线；现有P0主要硬编码Responses                                                                                              |
| `tests/integration/web-message-speed.test.ts`                                       | live→reducer/entries→branch metadata恢复、删除、replace                                                                                                |
| `docs/dev/web-hub-tokens-speed/plan.md`、`docs/dev/web-hub/README.md`               | 原方案及不变式；后续B包同步，本轮不改                                                                                                                  |

`docs/dev/web-hub-tokens-speed/`当前只有`plan.md`和本文，没有README.md；不得声称已同步不存在的README。

沿用前序证据，并定点核验本轮相关SDK事实。以下SDK路径均相对`node_modules/@earendil-works/`，是设计依据，不是新决策：

- **默认warming与触发/停止条件**：pi 1.5默认`cacheWarming: "streaming"`（`pi-coding-agent/dist/core/settings-defaults.js:60`）。`CacheWarmer.start()`要求请求可安全重放、cache TTL可得且可调度；延迟为`max(1, floor(min(0.9×TTL, TTL−10s)))`，TTL≤10s不调度。到刷新时仍须上下文/模式有效、未过安全deadline并通过经济决策；SDK默认预期收益门为`$0.05`，扩展可覆盖该经济action。`streaming`模式在`onAgentSettled()`停止并abort在途warming（`pi-coding-agent/dist/core/cache-warmer.js:15–19,111–160,200–249,281–299`；`core/agent-session.js:696–697`）。因此**默认开启不等于每轮并发**，约0.9×TTL前已settled通常不会触发；停止也不构成逐帧归属或清洁证明。
- warmer复用`...run.options`使外部raw进入同一回调，warming请求固定`maxTokens:1`、`maxRetries:0`（`pi-coding-agent/dist/core/cache-warmer.js:236–249`）。这是请求预算，不是对所有兼容provider返回计数的可证明上界，更不能据此估计错配概率。
- SDK raw envelope只有provider/api/model/data，没有requestId（`pi-coding-agent/dist/core/extensions/types.d.ts:731–738`）。Anthropic的terminal message_delta和message_stop无ID。
- Chat adapter使用`output.responseId ||= chunk.id`，后续异ID chunk仍可能被成功消费（`pi-ai/dist/api/openai-completions.js:339–359`）。所以normalized/final ID稳定不能代替逐raw chunk检查，见§4.3。
- push(start)只是排队，不等待扩展消费；agent-loop/扩展runner逐handler await。raw可早于公开start/update消费。主请求生产在awaited public turn_start之后，不代表外部请求也从该turn开始。
- Responses raw callback先于对应归一化await；completed只调用finalize而不break，**之后仍继续读流**，可能接受新delta（`pi-ai/dist/api/openai-responses-shared.js:530–533,684–702`）。因此需要§4.2的raw尾后否决，不能在completed截断normalized旧delta。
- Anthropic adapter在message_start初始化usage.output，随后仅在非null message_delta用量存在时更新；stop_reason也由message_delta写入（`pi-ai/dist/api/anthropic-messages.js:495–498,628–647`）。若代理把整条携带终止原因的terminal message_delta从SDK输入移除，且没有其他stop原因，SDK保持pending并在流结束时报错（同文件`:674–709`），不是“SDK成功但仅speed漏证”的路径。仅speed转发漏掉回调则不同，须显式故障注入验证，见§6.2、§6.4.1。start初始计数无论如何都不能充当完整raw终结证据。

只依赖同一adapter流内raw顺序，不依赖不同流之间或raw与normalized消费的相对先后。

## 3. 总体设计

### 3.1 模块职责与依赖方向

```text
awaited public turn_start ───────────> TurnCapture（一个有界候选）
provider_stream_event ─既有wire──────> raw同步归约器（不计时）
                                      ├─ Responses：ID + completed + 尾后否决
                                      ├─ Chat：逐chunk ID + finish/usage
                                      └─ Anthropic：唯一open + terminal总量 + 污染否决
                                          └─ external：仅自身记账/无重叠自然close
public message_start ───────────────> Observation.started（不清预捕获invalid）
public message_update ─同步binding──> 精确身份join + delta-only计时/count
public message_end ────────────────> 所有门合取 → core或undefined
public turn_end ─exact ref/mid/owner> 一次metadata append；隐藏则从不建pending
```

复用`message-speed.ts`，不建通用provider框架/请求跟踪系统。raw证明与normalized计时分开；handler延迟影响本地分母，不改变拒绝条件。P2不增加witness参数/epoch API，不改wire/binding。

### 3.2 内部数据结构与状态契约

以下为拟实现本地类型，不是SDK已有字段：

```ts
type ProofState = "unknown" | "proven" | "invalid";
type Tuple = { provider: string; api: string; model: string };
interface RawProof {
  state: ProofState;
  terminalSeen: boolean;
  tokens?: number;
  rawStop?: "stop" | "length" | "toolUse";
  finishSeen: boolean; // Chat
  usageSeen: boolean; // Chat
  messageStopSeen: boolean; // 主Anthropic矛盾检查，不参与正向必要条件
}
interface TurnCapture {
  identity: MessageSpeedOwner & { loopGeneration: number; turnIndex: number };
  phase: "capturing" | "consumed" | "disabled";
  tuple?: Tuple;
  responseId?: string;
  rawLane: "empty" | "open" | "closed";
  proof: RawProof;
  assistantStarts: number;
}
interface AnthropicGuard {
  tuple?: Tuple; // 容量1，冲突使当前测量污染，不扩容
  lane: "empty" | "open" | "closed";
  id?: string; // raw message_start.message.id
  external: boolean; // 已知在本测量外开始，永不升级主lane
  terminalSeen: boolean; // 仅lane自身顺序记账，不转入RawProof
  overlapped: boolean; // 本lane曾与测量重叠，reset不得清除此事实
  tainted: boolean; // activation吸收态：重叠/裸尾/非法顺序
}
interface Observation {
  // 继承现有完整Identity和count/first/last
  started: boolean;
  binding?: MessageSpeedBinding;
  bindingConfirmed: boolean;
  invalid: boolean;
}
```

- Proof：unknown不出数；proven只是证据暂齐，后续矛盾转invalid；invalid永不恢复。
- 主raw lane：terminal登记用量但**不关闭open**；stop可标记closed，但不使proof从unknown变proven。缺stop不阻止当前消息出数。
- Observation：公开start只建立消费生命周期；raw可已到。晚建observation必须继承capture invalid，不能清洗预捕获污染。
- Guard只记已知在途/顺序/污染，不带tokens、stop原因或计时。旧open在测量end/reset时降为external，保留其已见start、terminalSeen及overlapped；不能因新turn/message/reset/agent_settled认领成新主流。曾是主lane的open已有测量重叠，降级不使其变成可自然关闭的完整external lane。
- **自然关闭例外**：external从自己的合法raw start起，始终唯一、guard未污染，完整观测合法terminal→stop且全程无测量重叠，才允许将自身lane置closed。terminal仅置guard.terminalSeen；stop仅关闭guard.lane；不写capture/observation的proof、tokens/usage、terminalSeen或messageStopSeen。没有正证据可从external转移给下一轮。它本来未污染，关闭不是把tainted改回false。
- “测量窗口”从有效awaited turn_start建立capture起，至对应message_end消费或生命周期reset止，包括public start尚未消费的时间；invalid/disabled不提前解除重叠保护。external尚open时启动测量即记overlapped并污染该Anthropic测量/guard，不能等到主raw start才假定没有重叠。capture不存在时的完整外流才可走自然关闭；仅发生在public start前不够。
- 双open（含同ID重复start）、裸尾或已知重叠一旦使tainted=true，**本activation余下Anthropic测量持续隐藏**；后续匿名stop、完整流、reset/new turn/message/agent_settled均不清洗。该长期无徽章是明确产品承诺，不是可选实现。不会跨API误伤Responses/Chat。
- 若本消息缺stop但其他门齐，可在end出数；未关闭raw lane仍保留为后续测量的外部在途风险，下一start不能无视它。stop非出数必需不等于terminal可释放lane；主lane的合法延迟stop可完成自身顺序记账，但不能撤销重叠污染或向别的测量供证。
- 新activation重建本地状态不是清洁epoch证明；仍采用同一启发式和风险声明，不声称排除不可见外流。

**捕获规则：**有效turn_start建一个TurnCapture；首次public assistant start不清capture；同turn第二次public assistant start disabled。raw-first/normalized-first仅按tuple+ID+turn identity join；候选最多一个，不换最近值。end只消费一次，不跨消息转移proof，必须`started && bindingConfirmed && proof.proven && !invalid`且其他门齐。

**裸尾不能提前丢弃：**raw不得先因无observation/binding就return。先判断是否属于§4.4.1限定的完整external自身记账路径；不是该路径、且没有唯一可接受主open lane时，Anthropic terminal/stop立即污染capture/guard。public start尚未消费时保留污染，后来建立observation即invalid。没有当前capture也要记guard污染，不存用量等待以后认领。已见external start且满足自然关闭全部条件的尾不属于“未见start的裸尾”。

公共签名不变：

```ts
raw(event: unknown): void;
delta(kind: string, delta: string, binding: MessageSpeedBinding | undefined): void;
end(message: unknown): GenerationCore | undefined;
reset(): void;
```

不新增异步等待、raw正文队列、回调包装或witness接口。所有读取/归约异常fail closed，不影响原消息流。

## 4. 接口契约

### 4.1 通用证据与最终门

1. 所有凭证逐层own data property，复用`generationOwnData()`；不调用getter、不coerce/default、不枚举/序列化raw；descriptor/Proxy异常拒绝证明。
2. choices/content先验证数组，索引用own descriptor.value私有helper；现协议helper拒绝数组，不为本功能修改它。
3. ID用`isGenerationId()`；总输出为number安全整数`1..10_000_000`，缺失/null/字符串/负数/NaN/Infinity不供证。
4. 每条生成delta必须本条同步完整binding，四字段与已锁身份全等；缺失/变化立即invalid，后来补齐不修复。非空delta才计时/count，空delta不修复身份。
5. raw可先于公开start/binding捕获标量，不能先于精确join输出，不按“最近/时间接近”关联。Anthropic主raw start ID最终须与每条binding/final全等；external ID永不参与主join。
6. end必须assistant、完整生命周期、成功stopReason `stop|length|toolUse`、proven、final own responseId/provider/api/model与binding全等、own `usage.output === proof.tokens`。Chat/Anthropic raw stop映射也须一致；缺失/pending/error/aborted/未知隐藏。总量等值仅检查provider按其协议上报的同源值一致性，无法检测同源多报/漏报；严格等值、无容差、不补算。
7. final content仅接受text/toolCall/thinking/redacted_thinking；SDK `type:"thinking",redacted:true`也允许。不读推理正文/签名；未知块隐藏。reasoning子计数不读、不作正反凭证。
8. count≥2、500ms≤genMs≤24h、count/token上界、速率正有限由sanitizer兜底。streaming无数值，禁止端到端耗时/估算兜底。
9. message_end只盖wire副本，不污染SDK对象；turn_end仍以exact final引用、public mid、owner和同步secure recheck写一次。不匹配只不持久，不撤销先前合法live。
10. 所有门合取，没有“最后事件获胜”。`delta(kind="error",...)`、匹配raw error、非法/倒退时钟均invalid，后到正确字段不能覆盖。

**顺序无关指拒绝条件不随消费排列失效，不是允许协议乱序：**

| 排列                                                    | 处置                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| raw start/terminal已到，public start仍被前置handler阻塞 | capture保留有界标量；public start不清；每delta binding齐且身份全等才join。Anthropic先前须已有唯一主raw open lane |
| raw terminal先于首次binding，binding在首delta同步到达   | 可按各家族规则待join；不可仅因迟于raw而隐藏                                                                      |
| 某delta无binding，后来update才齐                        | 当场invalid，禁止追认                                                                                            |
| Anthropic terminal/stop真实早于任何raw start            | 裸尾invalid/tainted，晚到raw/public start不重排、不修复                                                          |
| Anthropic raw start早于public start消费                 | 可保存本turn候选，不因public消费时刻误认external；真正turn前已观测start才是external                              |
| external完整start→terminal→stop均在测量窗口外           | 只做自身记账并自然关闭，不供主证据、不污染；后续正常主轮次可出数                                                 |
| external尚open时测量开始，或第二raw start造成双open     | 已知重叠invalid/tainted，后续close/reset不清洗                                                                   |
| Responses completed后消费终结前已入队delta              | 正常计时，尾后新增由raw序列判定                                                                                  |
| 一次性SSE/延迟raw前置handler                            | 同adapter raw仍逐回调await；跨流交错不假定顺序，歧义按规则隐藏，不用handler时间猜来源                            |

### 4.2 Responses：完成证明与raw尾后生成

正向：两个Responses api之一；own tuple/ID与候选和binding一致；own `data.type="response.completed"`、status=completed、合法own usage.output_tokens；仅一个matching completed；end总量严格相等。

- binding未到时，用本turn own `response.created.response.id`建候选；matching completed可提前存标量。无created且无binding的孤立completed不建候选。
- binding已到可锁候选再接matching completed，兼容既有手工fixture。候选与binding不同即invalid。
- 可证明异ID的standalone completed/failed不抢槽；候选期间同tuple另一个created/身份切换invalid，不能final切回修复。
- matching completed把raw lane置closed。移除reasoning_tokens=0、reasoning/summary/redacted旧类型否决，不删除终结/归属门。
- closed后同tuple**任何不能证明异ID的新增语义raw**均invalid：text/thinking/summary/refusal/tool参数delta、item/content新增、done补内容、未知语义；无已验证无语义定义时ping也保守拒绝。传输`[DONE]`/EOF不是provider raw语义事件，不否决。
- 第二matching completed、同ID failed/incomplete/error、冲突用量invalid；不能因“可能是warmer”放过匿名尾后生成。
- SDK在completed后仍继续读流（§2），故必须在raw reducer保留closed后否决。终结前raw已产生并入队、completed后才消费的normalized delta继续计时；由raw reducer的closed状态区分新旧生成，无需新wire字段。

无completed/总量则unknown→隐藏；真实SDK completed→新text delta→EOF即使成功且usage不变也必须无core/metadata。

### 4.3 Chat Completions：逐chunk ID + finish/usage

raw data即chunk，不是data.response。

1. 有效capture内首个own合法data.id锁定，包括role-only/空chunk。同tuple每个后续chunk必须own合法且ID全等；不同/缺失/非法立即invalid，binding前也检查，绝不异ID ignore。
2. A→B→A在首B即不可恢复；SDK采用`output.responseId ||= chunk.id`（§2），不能据此推导raw恒等。独立同tuple warmer同样误伤隐藏，可接受；不同tuple不供证。候选与每条binding/final须全等。
3. own choices为数组；内容/finish chunk仅单个own choices[0]、own index=0；多choice/非0 index fail closed。`choices:[]`须先解析顶层usage，不能提前return。
4. finish：`stop→stop`、`length→length`、`tool_calls|function_call→toolUse`。null/缺失为中间态，未知/content_filter不映射成功。
5. 总量首选非null own data.usage的own completion_tokens；顶层缺失/null才回退own choices[0].usage.completion_tokens。非null非法顶层不能用choice修复；两处合法不同invalid，相同只算一个凭证。
6. 用量只在finish已见或同finish chunk接受；finish前非null用量invalid，中间`usage:null`正常。`finishSeen && usageSeen`才proven；`[DONE]`/normalized done/usage不补证。
7. 重复finish/终结usage、原因或总量冲突invalid；finish后允许无生成的`choices:[]`尾usage，空尾无贡献。
8. 同chunk生成+finish+usage先检查生成再登记终结；仅后续raw chunk新生成才尾后invalid，包含content、reasoning变体、tool/function新调用/名称/参数及不能安全判定的delta扩展。仅role/空字段无贡献。

不读reasoning子计数自算tokens，thinking_delta正常计时。P0中途换ID须证明final仍A、stop成功、usage正常但生产speed无core/append，不能靠SDK报错假通过。

### 4.4 Anthropic：唯一open lane + 最终等值的保守启发式

#### 4.4.1 归约规则与正向门

P2直接用当前公开事件实施，不等SDK，不做witness或epoch接口。先处理guard污染与external自身记账，再处理主lane供证，二者不能共用一个可覆盖的proof槽。

1. own raw message_start.message.id合法，tuple合法，且无已知open/tainted lane时建立唯一open。有效capture内的start可建主候选；无测量窗口时的start标为external。已有open时第二个不同ID start或重复同ID start均立即invalid/tainted；terminal不释放open，不能切最近lane。
2. 主lane可在binding前建立；绑定晚到时须tuple+ID全等。已知turn前/旧observation开始的lane为external，永不升级主lane。external尚open时有效turn_start建立测量，立即记overlapped、污染guard并作废当前Anthropic测量；不能因public start消费晚而视为不重叠。
3. **完整external的有限自然关闭路径**：仅当其合法start已观测、从start起始终唯一、`tainted=false`、`overlapped=false`且全程无测量窗口时，允许顺序消费其合法terminal并置`guard.terminalSeen=true`，随后stop仅将自身lane置closed。terminal仍须合法own stop_reason和usage.output_tokens，但校验后丢弃值，不存tokens/原因。external的生成事件不计主delta/count/时间，terminal/stop不写主proof、usage、terminalSeen、messageStopSeen，不触发end/pending/append。缺terminal、重复terminal/stop、错序、非法字段、尾后新生成均不适用此例外；terminal不提前close。自然close后可在下一轮重新建立主候选，不从external继承任何正证据。
4. **裸尾污染⇒作废当前测量**：带usage的message_delta或message_stop既不满足上一条external自身记账、又无法归属唯一未污染主open lane时，立即invalid/tainted并隐藏；包括未见start、已closed、双open/未知占用，或与测量重叠的external。不是ignore、不缓存后认领。双open和未见start的terminal/stop仍整体污染且不清洗。
5. 在唯一、未污染、非external的主open lane内，匿名terminal按已裁定启发式归入该lane。必须同事件own delta.stop_reason和合法own usage.output_tokens；stop原因映射见下一条。首个合法terminal只登记一次；重复terminal（即使总量相同）invalid，不取最近值。
6. `end_turn|stop_sequence→stop`、`max_tokens→length`、`tool_use→toolUse`。terminal原因缺失/null/未知、usage缺失/null/非法立即拒绝本次证明；start用量/中间累计值不补终结。带usage但没有合法终止原因的message_delta不当作成功terminal，保守invalid。
7. 主lane的`terminalSeen && usageSeen`可使raw proof暂齐；在公开start/binding确认、final成功/stop映射一致、**raw tokens严格等于final usage.output**、计时等通用门齐后出core。**不要求message_stop，不用它使proof成立。**external自身记账不满足此门。
8. 主message_stop只检查矛盾：无唯一可接受主open lane、terminal尚未见、重复stop均invalid；合法stop仅置主proof.messageStopSeen并将主raw lane closed。stop先于terminal必须invalid；terminal在stop后也invalid。旧主lane降为external后，合法延迟stop至多关闭其自身记账，不把证据转给下一测量，也不撤销已有tainted。
9. stop后再出现任何生成delta/新增block/message_delta均invalid；terminal后又新增生成也保守invalid。signature/block close/ping不供证、不计时、不恢复invalid；无法安全识别的语义扩展隐藏。
10. 已知污染不因reset/new message/turn洗白；anonymous stop不能排空不明双lane并恢复当前或后续测量。guard不含正文/用量，容量固定，冲突即隐藏。**tainted=true后，本activation余下Anthropic均无徽章**，即使其后各轮单看完整成功也不恢复；自然close只适用于从未污染的完整非重叠external lane。

```text
无测量窗口，external start(id)，guard清洁/唯一 ─> external/open
external合法terminal，全程不重叠 ─────────────> 只记自身terminalSeen，仍open
external合法stop，仍未污染/不重叠 ─────────────> 自身closed；主proof完全不变
下一轮主start，guard清洁/无open ──────────────> 新candidate/open，unknown
唯一主open内合法terminal ────────────────────> tokens/rawStop已定，proof暂齐
public start + binding精确join + final等值/成功 + 时间门 ─> end可出core
可选主stop（terminal之后）───────────────────> 主raw lane closed；不增加正证据
第二/重复start、裸尾、已知重叠 ───────────────> tainted（activation吸收）
错序、尾后生成、缺/冲突字段 ──────────────────> invalid（当前测量吸收）
```

这里的“归属”是规则内的唯一lane推断，不是逐帧强身份。与§6.4的残余风险同时成立；禁止实施者把它升级成witness要求或降级成最近值匹配。

#### 4.4.2 R1逐步推演与完整external关闭对照

设同tuple，外部A完整有序，B是主消息。区分“A完整结束后才开始B”与“A未stop时B已开始”；不能把两者都写成永久污染。

**A.start可见，且A.stop晚于B测量开始（真实重叠）：**

| 事件                          | 状态与处置                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------- |
| A.start在B有效turn_start前    | A.open/external；不记主proof                                                    |
| A.terminal，尚无A.stop        | 仅记A自身terminalSeen，A仍open；不把terminal当释放lane，不因external本身污染    |
| B有效turn_start，A仍open      | 记录overlapped并tainted，B.invalid；reset只清旧正证据，不清A.open/污染          |
| B.raw start                   | 双open，再次确认invalid；同ID重复也invalid，不能切最近lane                      |
| B生成、B.terminal、延迟A.stop | invalid/tainted吸收，不能以任何后续事件恢复；A.stop不参与B正证据，也不清洗guard |
| B.end及后续C、D正常轮次       | 均无core/pending，append=0；本activation余下Anthropic长期无徽章                 |

**A完整观测、唯一且全程在所有测量窗口外（自然关闭正向）：**

| 事件                                              | 状态与处置                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| 无capture时A.start                                | A.open/external，guard清洁、overlapped=false                         |
| A生成、合法A.terminal                             | 只做自身顺序记账；不计主时间/usage/proof，A仍open                    |
| A.stop，期间没有有效turn_start或第二start         | A自身closed；tainted仍false，没有主terminal/stop证据或pending/append |
| 后续B turn_start→raw start→生成→terminal→stop→end | 全新主候选；其他门齐时exact core及一次exact-mid append               |
| 再后续C正常轮次                                   | 仍能正常出数，不能“一次完整外流后永久丢徽章”                         |

该对照的可用性门为P0-A7；重叠污染保留门为P0-A1/A3。缺A.stop、裸A.terminal/stop或中间reset不能冒充上述完整正向。

**A.start不可见：**

- 若A的terminal或stop在B.raw start前被观察到：未见start，裸尾立即污染capture/guard；B晚到start/binding不能修复。即使此时无测量窗口也不能按完整external关闭路径放过。
- 若仅延迟A.stop落在B.start后、B.terminal前：stop先于terminal，B立即invalid。它不能成为B的完成凭证。
- 若仅延迟A.stop落在B自己的合法terminal后：stop最多改变raw lane closed，不提供用量/证明；B是否出数由B.terminal与final严格等值等门决定。**B无需stop本来即可出数，所以不存在A.stop补齐B完成条件的路径。**若B没有合法terminal，A.stop到来则stop-before-terminal invalid；没有stop也因unknown隐藏。
- 若A.terminal本身也在唯一B.open内到达，启发式不能绝对辨别它与B.terminal；若B自己的terminal后来出现，重复terminal立即invalid；若两者总量不同，final等值门隐藏。只有隐形外流尾用量恰好等于B final且speed未观察到B自身可用terminal等联合条件才可能穿过；这是接受并披露的残余风险，未测量、无法估计。可达性须按§6.4.1区分SDK输入与speed单独漏转，不再以代理丢整帧但SDK仍成功作例子。

因此R1的**延迟stop补完成**路径被删除完成条件直接消除；裸尾规则覆盖无法归属的terminal/stop，不用它声称识别所有不可见外流。完整且非重叠external自然close不改变上述拒绝门。

#### 4.4.3 为什么撤销witness先决条件

r2要求producer token/隔离epoch，是为了对匿名尾做强归属。当前公开端口没有该能力；最新裁定选择可用性与保守启发式，不等待上游。故删除接口、能力开关、BLOCKED_CAPABILITY和SDK改造写域。

未来若需降低§6.4风险或提高warming覆盖率，可另案利用上游原生逐帧请求身份；本期不定义该接口、不伪造requestId、不包装provider、不把未来能力放回P2发布门。

### 4.5 推理与本地计时

- 合并前非空字符串`text_delta|thinking_delta|toolcall_delta`为锚点；thinking-only、thinking→text/tool均可计时。
- thinking_start/end、signature、block start/end、usage/finish/stop、工具执行不是锚点；两锚之间handler/本地等待自然计入。
- 例：0ms thinking、300ms thinking、900ms text、1000ms tool参数，provider上报总输出120（推理80），count=4、genMs=1000、120 tokens/s，不是40可见token/s；不据此独立验证provider计数。
- summary/redacted不按类型否决；没有足够delta按count/时长门隐藏。首delta前隐藏耗时不可恢复，tooltip披露。
- 一次性SSE不必然隐藏；本地摄取压到<500ms就因阈值隐藏。测试DI制造可重复本地窗口，不得伪造生产时间。

### 4.6 隐藏优先级与完整清单

优先级为：**生命周期/身份失效→污染/矛盾invalid→证据不足unknown→最终等值/类型/时间门→全部通过才出数**。低优先级正证据不能覆盖高优先级否决；所有失败对当前测量单调，不部分覆盖、不取最近值。external自然close走独立自身记账分支，不是该优先级的恢复捷径。

| 触发条件                                                                                        | 必须行为                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Anthropic第二start（异ID）、重复start（同ID）、双open或external open与测量重叠                  | invalid/tainted；terminal后未stop仍open，不选择最新lane；本activation后续Anthropic持续隐藏 |
| terminal无lane；未见start的裸terminal/stop；不满足external自然关闭例外且不能归属唯一主open lane | 立即invalid/tainted；不是ignore，不认领，不等晚到start修复；不因后续stop清洗               |
| terminal在stop后、stop在terminal前、重复stop/terminal                                           | invalid，不重开lane/覆盖总量                                                               |
| stop后仍有增量/新block；terminal后新生成；Responses completed后新语义raw；Chat finish后新生成   | invalid，不拼旧用量和新窗口                                                                |
| terminal usage缺失/null/非法；只有start/中间累计usage                                           | 无证明→隐藏，不用final默认用量补证。Chat中间usage:null按§4.3正常中间态处理                 |
| raw tokens !== final usage.output（含缺失/null）                                                | 严格隐藏，无容差/provider特判；相等也不证明不存在同源多报/漏报                             |
| 某delta当时binding缺失/四字段变化，后来才补齐                                                   | invalid；仅raw-first、每条delta当时binding齐不在此列                                       |
| 候选与binding/final ID或tuple不符；Chat A→B→A                                                   | invalid；每chunk检查，final切回不能修复                                                    |
| owner/session/turn/loop/message/activation变化，同turn第二public assistant start                | 旧正证据/pending作废，禁止跨窗口复用；已知在途/污染不清洗                                  |
| SDK error/abort/中断、未知/缺成功stopReason、own/getter失败                                     | 隐藏，不影响原消息/错误流程                                                                |
| 无raw port/未知API；Responses缺completed、Chat缺finish/尾usage、Anthropic缺合法terminal         | unknown/disabled→隐藏；SDK成功不是补证                                                     |
| **只缺Anthropic message_stop**                                                                  | 不因此隐藏；其他门齐可出数。观察到的stop硬矛盾仍优先否决                                   |
| 完整external start→合法terminal→stop，始终唯一且全程不与测量重叠                                | 只关闭自身lane，不写主proof/usage/terminal/stop证据；不污染，后续正常主轮次可出数          |
| count<2、genMs<500ms/超界、时钟非法/倒退、core非法/未知块                                       | 隐藏，正文/费用照常                                                                        |
| 只缺reasoning子字段或其非0                                                                      | 不因此隐藏，其余门不减                                                                     |
| completed后才消费终结前入队delta                                                                | 不因此隐藏；raw无尾后新增且其他门齐可出数                                                  |

所有Anthropic隐藏用例必须断言：live无`piToolkitGeneration`、end=undefined、无pending、turn_end后append=0、branch无该条speed entry、刷新无徽章。**不是显示0，也不是只藏UI却已写metadata。**长期污染用例还须覆盖后续独立正常轮次依然无上述产物。

## 5. 关键决策与文档同步

### 5.1 文件/函数级实施面

| 位置                                         | 动作                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `message-speed.ts` capture/event/reset/clear | P1建turn capture，public start不清预捕获证据；P2分离guard与正证据生命周期，保留重叠/污染           |
| raw dispatcher、Responses/Chat私有reducer    | P1 raw-first join、逐chunk ID、尾后否决；不计时                                                    |
| Anthropic私有reducer/guard                   | P2唯一open、主terminal候选、external自身记账/有限自然关闭、裸尾/错序否决、可选stop；不新增能力接口 |
| delta/end/persist                            | P1总输出/成功stop/严格等值，共用sanitizer/exact ref/mid/secure不放宽；P2复用                       |
| binding/wire/tap/assembly                    | 不改接口/注册/接线；若P0证实不足则报告，不隐式扩域                                                 |
| protocol/schema/reducer/history              | 不改v1/map cap/持久结构，不新增request/reasoning/API字段                                           |
| UI i18n                                      | B只改原tooltip key，不改结构/单位/费用                                                             |

### 5.2 取舍

- 共用身份/计时/持久化，只分raw协议，不做三套引擎。
- 不从请求开始/message_start计时；不伪造隐藏推理耗时。
- 不用normalized reasoning=0/稳定ID当raw凭证，Chat逐chunk否决。
- 计数采用**provider按其协议上报的总输出（含推理）**；raw/final可能同源，严格等值只查一致性，**无法检测同源多报/漏报**。不引入本地tokenizer、容差或补算，不读reasoning子计数重复相加。
- Anthropic采用唯一lane启发式而非强归属；只取一个主终结用量，严格等值，不用stop“增强证明”。风险可塑性如实披露为未测量、无法估计，不称已证明不可能。
- 完整、唯一、非重叠external只关闭自身lane，避免无歧义外流永久损失可用性；不选择“所有external尾一律污染”。也不选择“收到任意stop就恢复”：双open/裸尾污染后本activation长期无徽章是保守代价。
- 不把warmer off/inactive当隔离证明，不以它放宽否决；默认streaming的调度/停止事实用于覆盖率解释，不作为归属凭证。
- 不做witness/SDK补丁，无无界map/正文队列/新timer。未来原生身份是另案扩展点。

### 5.3 文档同步面与tooltip

本轮只改本文；后续B包按真实实施状态同步：

| 文档/文案                                       | 要求                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/dev/web-hub-tokens-speed/plan.md`         | 替换reasoning=0/B恒false、summary/redacted否决和新start自动恢复旧口径；统一provider上报总输出、本地窗口、歧义隐藏、external有限关闭和包顺序 |
| `docs/dev/web-hub/README.md` tokens/s节         | 同步上述口径、同源计数局限、Anthropic启发式/stop非必需、污染后activation长期隐藏；持久化/安全不变                                           |
| `docs/dev/web-hub-tokens-speed/README.md`       | 当前不存在，不为同步专门新建；若实施时别的任务已新增，B负责核对相同口径                                                                     |
| 本文                                            | 实施后记真实结果，不预写已通过                                                                                                              |
| `src/web-hub/ui/src/i18n/{zh,en}/transcript.ts` | 仅原`transcript.generationSpeedTitle`，主/child同口径                                                                                       |

建议文案：

- 中文：“总输出速度（本地观测窗口）：provider按其协议上报的总输出token（含推理）÷ 首个至最后一个非空文本、思考或工具参数增量的本地时间窗。无法检测同源计数的多报或漏报。首增量前的隐藏推理耗时不计入分母；并非完整生成耗时或GPU吞吐。部分provider会因用量或流归属不足而隐藏徽章。”
- 英文：“Total output speed (local observation window): total output tokens reported by the provider under its protocol, including reasoning, divided by the locally observed window from the first to the last non-empty text, thinking, or tool-argument delta. Cannot detect over- or under-reporting shared by the raw and final counts. Hidden reasoning before the first delta is excluded from the denominator; not full generation time or GPU throughput. The badge is hidden for some providers when usage or stream attribution is insufficient.”

不写Anthropic一律隐藏、warmer=off保证可用、已证明与Responses相同强度或独立计数正确。无徽章不是速度0，不为隐藏增加通知/新徽章。

## 6. 实施要点与验收

### 6.1 单测矩阵

fixture参数化api/binding/raw helper，补成功stopReason，保留安全/getter/生命周期负门。

| 分组                       | 必测                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responses正向              | 两api；reasoning=0/非0/缺子字段；thinking/summary/redacted；raw-first join；排队旧delta在completed后消费                                                                                                |
| Responses负向              | 缺/null/非法/非own usage/id/status；failed/incomplete；重复completed；final不等；completed后无ID text/thinking/tool/item/done/未知语义                                                                  |
| Chat正向                   | role-only锁ID；text→finish→空choices usage；thinking/tool；末chunk合包；choice回退/顶层null；terminal-before-binding                                                                                    |
| Chat负向                   | A→B、A→B→A；B只内容/usage/空chunk；final仍A；缺/非法ID；缺finish/usage、早usage、冲突重复、多choice/非法index/未知finish、尾后生成                                                                      |
| Anthropic正向              | 唯一主start→thinking/text/tool→terminal，与final严格等值；有stop和**无观察到stop**两种；raw先于公开start/binding可join；最小合法用量与通常多token用量                                                   |
| Anthropic external自然关闭 | 无capture时完整唯一A.start→合法terminal→stop，不碰主proof/usage/terminal/stop/count/time，无pending/append且guard不污染；随后B、C两轮正常流都准确出core/各自一次append；A的ID/总量与B不同，禁止跨流借证 |
| Anthropic lane             | A→B→A raw start、重复同ID、双open；terminal后仍open；external永不认领；external未close便turn_start即重叠污染；缺stop不妨碍当前出数但旧open影响后续测量                                                  |
| Anthropic裸尾/顺序         | 无start terminal/stop（含无capture时）；落B.start前/后；stop先于terminal、terminal在stop后、stop后增量、重复terminal/stop；usage缺/null；final不等                                                      |
| Anthropic跨生命周期        | A.start/terminal在turn前、延迟A.stop；reset/new turn/message不清已知污染；不可见A.start的裸尾；A.stop不能贡献proof；污染后再送正常B、C仍无数，不能以完整external close消毒                              |
| 顺序/调度                  | raw proof先/后binding；慢public start/首update；一次性SSE；延迟raw handler；相同raw序列消费排列改变不洗掉invalid                                                                                        |
| 共用身份/时间              | 每delta缺binding/四字段变化；owner/session/turn/loop/message/activation；第二public start；error/abort；count={0,1,2,3}×span={0,499,500,501}；倒退/NaN；空/签名不计                                     |
| 计数保证边界               | raw/final不等严格隐藏；同源同时改成另一合法等值数不会由等值门识别，测试只证实其局限，不把它当独立正确计数或为其加容差/补算                                                                              |
| 安全恢复                   | accessor/inherited/Proxy零getter；数组索引getter不调用；不读update content/usage/partial；SDK不污染；exact ref/mid/secure；metadata删除/replace无残留                                                   |

所有隐藏项同时断言无core、无metadata写入，不是0。旧nonzero/summary/redacted/thinking/缺reasoning负例改符合总输出的正例，保留场景不删测试；集成旧缺reasoning负例改缺raw总量，另加缺子字段但总量齐的正例。不得削弱Responses原安全/阈值/隔离门。

### 6.2 P0：真实SDK fake fetch全链路

复用`message-speed-p0.test.ts`真实`createAgentSession`/`DefaultResourceLoader`→公开raw/message/turn→生产wire/tap；禁user context/extensions发现，不联真实网络、不收费。runAgentLoop可补充，不能替代完整边界。final ID/usage/stop不手填。

调度轴：

- S1：可控ReadableStream逐帧释放，不真实长sleep。
- S2：一次性SSE全部写入Response，允许producer跑在公开消费前。
- S3：生产handler前用可控promise延迟public start/首update，raw继续后释放；另延迟raw前置handler，验证同流逐回调有序。trace须证明真实raw-first。

DI时钟在非空normalized delta送生产forward前推进；不在raw推进后期待消费逐帧分布。无DI短消费按<500ms隐藏；同raw序列proof结论不依赖S1/S2/S3。

| ID/包            | 场景                                                                                                                 | 断言                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-P1 / P1       | Responses总输出、Chat text/thinking/tool/合包/choice回退；S1–S3                                                      | DI跨度500ms且证据齐时exact core；message_end当场盖章，turn_end exact final/public mid一次append                                                                                                               |
| P0-C1 / P1       | 单Chat SSE A内容→B内容→A finish/usage；S1–S3                                                                         | final ID=A、成功、usage正常，binding可始终A；无core/append，拒绝来自逐chunk ID                                                                                                                                |
| P0-C2 / P1       | A→B、A→B→A；B内容/usage/空chunk                                                                                      | 每次换ID否决，A切回不修复，不只测final不符                                                                                                                                                                    |
| P0-C3 / P1       | 同tuple独立warmer B复用raw回调，插主A首chunk前/中间/finish后end前                                                    | 捕获窗口内异ID使A隐藏；trace区分独立流；不同tuple不供证                                                                                                                                                       |
| P0-R1 / P1       | completed(usage=10)→新text delta→EOF；S1–S3                                                                          | SDK成功、usage仍10、正文确实新增但无core/append；补thinking/tool raw负例                                                                                                                                      |
| P0-R2 / P1       | 所有生成raw在completed前，normalized延迟至其后；S2/S3                                                                | DI跨度够仍准确出数，不恢复旧completed截断                                                                                                                                                                     |
| P0-O1 / P1       | raw start/terminal早于公开start/binding；反向也测                                                                    | capture不被start清；精确join；delta当时无binding/不匹配/第二公开start隐藏                                                                                                                                     |
| P0-A1 / P2       | 可见A.start/terminal在B有效turn_start前，A.stop延迟至B测量内；B start/生成/terminal；含reset，S1–S3                  | A terminal只做自身记账且仍open；B窗口开始即重叠污染，第二start仍invalid；A.stop不供证也不清洗；B和后续正常C均无core/metadata                                                                                  |
| P0-A2 / P2       | 无start裸terminal/stop，在B.start前（含无capture时）；仅A.stop在B.open但B.terminal前；S1–S3                          | 裸尾/stop-before-terminal当场invalid；晚到binding/start不修复；无core/metadata；后续正常轮次仍隐藏                                                                                                            |
| P0-A3 / P2       | 双open、重复ID、A→B→A starts；terminal后未stop再B start                                                              | 首次重叠即invalid/tainted，A切回/后续所有尾stop/reset均不修复；再送完整正常C仍无core/metadata                                                                                                                 |
| P0-A4 / P2       | 真Anthropic完整start→thinking/text/tool→terminal→stop；S1–S3；缺usage/null/final不等/stop后delta变体                 | 标准无歧义正向exact core与一次exact-mid append，不能全隐藏假通过；负例无core/metadata                                                                                                                         |
| P0-A5 / P2       | A.start不可见，仅延迟A.stop分别在B.terminal前/后；B无合法terminal和有合法terminal两组                                | 无terminal组必隐藏；有B terminal等值组按B自身证据可出数，A.stop不提升proof。外部terminal等值碰撞另做观察器故障注入，按下文区分SDK输入丢整帧与仅speed漏转，不伪断言生产可达或绝对可识别                        |
| P0-A6 / P2       | 真raw terminal→start、stop→terminal、terminal-after-stop、stop后text/thinking/input_json；S2/S3                      | 硬矛盾不被handler延迟洗掉；invalid吸收；无core/metadata                                                                                                                                                       |
| P0-A7 / P2       | 同一activation/callback，所有capture之外完整唯一external A.start→生成→合法terminal→stop，再依次执行正常主B、C；S1–S3 | A自然close且不写任何主proof/usage/terminal/stop/count/time，无pending/append；A不残留污染；B、C由各自证据准确出core、各一次exact-mid append，live/刷新都有徽章。对照A无stop、未见start或与B窗口重叠则不得恢复 |
| P0-O2 / P2       | raw start/terminal早于公开start/binding；晚public handler/一次性SSE                                                  | 唯一主open未污染可join并准确出数；真正turn前external仍不认领；缺本条binding则隐藏                                                                                                                             |
| P0-N1 / 各包家族 | 缺总量、abort、final不等、own/getter失败、binding缺/迟到、owner/turn/message变化                                     | 无core、append=0；原消息/费用/错误流程不受影响                                                                                                                                                                |

**stop非必需的测试边界：**观察器单测可不发送stop而以合法final结束，验证只靠terminal等门即可出core。真实SDK自身可能要求收到message_stop；不要把截断SSE引起SDK错误冒充观察器要求stop。需要全链路验证“观察器未见stop”时，明确由测试harness仅屏蔽向speed转发该raw回调，SDK仍消费真实stop；记录该注入，不修改生产wire或手填final。标准SDK正向仍保留真实stop。

**terminal丢帧故障注入（P0-A5补充边界，不是生产发生率证明）：**

- 从fake fetch送入SDK的SSE中移除整条携带stop_reason的terminal message_delta，保留start/content/stop/EOF且无其他stop原因。断言SDK因pending→error，speed隐藏、append=0；不得把这条当成“SDK成功保留start计数而误出数”的例子。
- 保持SDK输入完整，只在测试harness漏转一次主terminal给speed，SDK仍消费terminal并产生真实成功final；trace分别记录SDK收到与speed漏转。无外部terminal时speed应unknown/隐藏；再在观察器故障注入用例加入未见start、落在唯一主open内的外部terminal，覆盖等值/不等值、stop原因匹配/不匹配、主terminal仍转发导致重复否决的对照。联合门齐时可能无法区分，按§6.4.1记录启发式边界，不承诺生产可达。无需伪造完整SDK生产者/请求路径来制造成功；全链路做不到的组合明确留在观察器单测，不手填全链路final。
- 不修改生产wire/SDK，不把测试harness故障注入称为现有生产漏转机制。报告哪些路径被复现、哪些未复现；未复现不等于概率为零或可忽略。

Codex链仅在对应adapter能注入假流时运行，不换api字符串冒充；parser两api回归保留。P2至少一条真实Anthropic正向且三调度准确出数，另须P0-A7证明完整非重叠外流后后续轮次仍正常出数，不能以全部隐藏宣布支持。

合并集成：真实branch→fresh reducer/entries；P1非0 reasoning Chat及Responses总输出，P2正常Anthropic和完整external后B/C均验证live/刷新同口径；P2污染场景及污染后正常轮次均无speed entry/刷新无徽章。metadata删除/replace清残留，费用独立/streaming隐藏。不新建浏览器框架。

### 6.3 回归与冻结面

- message-speed、P0、wiring、protocol sanitizer、UI generation-speed四组、合并集成；Responses现有用例全绿，仅按裁定调整reasoning期望。
- off、旧agent×新UI、新agent×旧hub双向兼容；PROTO/容器/metadata键/旧字段不变。
- 不刷新`tests/fixtures/governance/activate-trace.json`，无新注册；变化就修接线。
- 不改其他冻结fixture，不生成golden掩盖变化。优先原文件，新文件/tier声明由主会话集中处理。
- 本轮不跑门禁、不部署，后续附真实结果；本文不是测试报告。

### 6.4 残余风险、覆盖率与可接受性

#### 6.4.1 可塑性：未测量、无法估计，不声称已证明不可能

warming请求`maxTokens:1`是已核事实；它约束请求预算，不保证所有兼容provider的返回计数，更不能推出风险概率。总量门只使用**provider按其协议上报的总输出（含推理）**；如果观测到外部尾总量与主final不同，严格等值门会隐藏。反之，同源raw/final同时多报或漏报仍可能全等，**本模块无法检测同源多报/漏报**；不是独立计数验证，不加容差、不做补算。

要使一个隐形外部terminal通过当前启发式，至少需要同时满足：

1. 外部start未在当前守卫中留下open/重叠记录，外部terminal又恰好落在主消息唯一open窗口；
2. 外部usage.output_tokens **恰好等于**本消息final usage.output，raw stop原因也匹配；
3. speed**没有观察到本消息自身可用terminal**；否则第二个terminal会立即invalid；
4. 没有stop-before-terminal、第二start、stop后delta等其他硬矛盾，且binding/生命周期/计时/内容门全齐。

这些是规则层面的联合必要条件，**不是已证实的生产可达轨迹，更不是发生概率估计**。没有生产分布或故障注入结果，风险**未测量、无法估计**；不写定性低概率、数值概率或独立概率乘积。删除原先“极短主回复+代理丢整条terminal但SDK成功保留start计数”的不可证例子，也不虚构SDK当前存在复用同回调的其他重试producer。

| 已核机制/验证层次                                               | 结论与待验证边界                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SDK正常消费并向speed转发主terminal                              | 若唯一open内另到外部terminal，两个terminal触发重复否决；若只接受的候选总量与final不同，严格等值隐藏。不能取最近值覆盖                                                                                                          |
| 代理移除SDK输入中的整条terminal message_delta，且无其他stop原因 | SDK stopReason保持pending，结束时报错；最终成功门不成立。这不是“仅speed回调漏证”的本模块残余成功场景，P0仅验证错误/隐藏，不推断仍能成功                                                                                        |
| SDK收到完整terminal，但测试harness单独不向speed转发该回调       | SDK可以有真实成功final而speed缺自身terminal；无替代候选时隐藏。叠加未见start外部terminal的同形碰撞，只作为观察器故障注入检验联合门的局限；全链路和观察器单测分别标明，不宣称已存在生产漏转机制。须按§6.2验证，当前没有实测结论 |
| 同源计数错误，raw与final同步多报/漏报                           | 等值检查不能识别。展示上报值而非独立核算值；保持严格等值，不以容差或reasoning补算“修正”                                                                                                                                        |

完整且非重叠external自然关闭只处理**已见完整start**的自身lane，不为不可见外流补身份。单独延迟A.stop没有用量，已不参与证明，不构成替B完成的额外来源。残余可塑性集中在不可见外流的**terminal usage碰撞**，不是stop提供了可证性。Anthropic因此不声称与Responses ID关联等价。

#### 6.4.2 什么情况下用户完全看不到徽章

- 默认`cacheWarming: "streaming"`不是每轮并发：可重放、TTL可得、约0.9×TTL的调度与经济门均影响是否真的发请求，settled即停止（§2）。不能写“默认开warming所以多数/全部消息必隐藏”，也不从该事实推导任何隐藏率。
- **完整观测、唯一、全程不与测量重叠的external流**可自然关闭，之后正常主轮次仍能出数（P0-A7）；其close不贡献主proof/usage/terminal/stop证据。
- **一旦双open、未见start的裸terminal/stop或已知重叠造成guard污染，本activation余下Anthropic持续无徽章**。即使只发生一次、后面warming已停止、流完整结束、收到全部stop或后续轮次单看正常，也不清洗、不自动恢复。这是明确接受的长期可用性损失，不能缩成“只隐藏当轮”或“可能隐藏”。仅新activation重建本地状态，但不宣称因此获得清洁epoch证明。
- provider/proxy不给完整终结usage、返回null/非法总量，或raw/final总量不等、终止原因不一致。
- 缺binding、身份/owner/turn/message变化、重试第二公开start、SDK失败/中断，或协议硬矛盾。
- 仅一个非空delta、本地窗口<500ms、一次性消费过快，或没有足够thinking/text/tool参数增量。

不编造隐藏率实测。若N条里K条触发上述任一隐藏门，展示上限为N−K，隐藏率至少K/N；一次真实污染即可使该activation剩余Anthropic轮次K=N，但不因此把完整非重叠external或正常无歧义流全部禁用。用户可见表现是**无徽章**，正文/思考/费用照常；不是0、N/A、估算或toast。

回滚不迁移数据：回退相关raw分支/文案，保留reader/schema。已存合法v1 core旧UI可读；没有API/reasoning标记，不能精准清推理/Anthropic历史，若需清理另授权，不偷偷删metadata。P1/P2可独立回滚。

### 6.5 拆包、写域与先后

顺序为**P1→P2→B合并验收**；B只依赖P1的i18n/Chat集成可在P1验收后与P2并行，但Anthropic集成和最终文档状态等P2落定。无SDK能力等待阶段。

| 写域                                                        | P1独占                                              | P2独占/交接规则                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `message-speed.ts`共用capture/event/reset/delta/end/persist | turn capture、身份/计时/最终等值门；guard边界调用点 | P1落定后仅补Anthropic guard保留/作废调用；不重写共用门。同函数必要分支先P1后P2串行         |
| 同文件raw reducers/dispatcher                               | Responses/Chat reducer和相应分派                    | Anthropic私有reducer/guard；dispatcher只加本分支。不同函数写域；共享入口先P1后P2           |
| `tests/web-hub/agent/message-speed.test.ts`                 | 共用/Responses/Chat describe                        | Anthropic lane/external自然关闭/裸尾/长期污染/stop非必需describe，P1固定后追加，不改P1断言 |
| `tests/web-hub/agent/message-speed-p0.test.ts`              | 共用harness/S1–S3、P1/C/R/O1/N1(P1)                 | A1–A7/O2/N1(Anthropic)，复用冻结harness；helper变更串行交接，不两包各改                    |
| `tests/web-hub/agent/wiring-message-speed.test.ts`          | fixture/既有wire断言                                | 不改，P2没有接线变化                                                                       |
| binding/wire/tap/assembly/protocol/fixtures                 | 两包禁止                                            | 两包禁止                                                                                   |
| i18n/UI测试/合并集成/开发文档                               | B独占，两包不碰                                     | B统一消费两包结果                                                                          |

“不重叠”按函数/describe写域和时间所有权约束，不虚称共享文件独立。共享函数的必要接线改动明确P1完成再由P2修改，禁止并发写`message-speed.ts`/P0 harness。

**P1：completions先行 + 总输出/Responses回归**

- 先capture/三调度P0，再逐chunk ID/finish/usage、Responses尾后防守、thinking总输出。Anthropic此时仍unknown，不造猜测proof。
- 验收P0-P1/C1–C3/R1/R2/O1/N1、原Responses门；准确core/exact-mid、无协议/注册变动。
- 独立交付Chat+Responses，不依赖P2。

**P2：Anthropic保守模式随后**

- 在声明写域实现唯一主open+terminal+最终等值；完整唯一且全程不重叠的external只做自身记账/自然close；裸尾/双open/重复start/已知重叠/错序/stop后delta否决，污染后activation长期隐藏；主stop非必需。不做SDK补丁、不伪造witness、不等待能力。
- 验收A1–A7/O2/N1、标准真SDK三调度正向、完整外流后B/C后续轮次正常出数、污染后后续轮次继续隐藏、缺观察stop单测/明示harness变体；按§6.2区分terminal丢整帧与speed漏转注入。全部隐藏用例无任何metadata写入。
- 回归P1全矩阵，Anthropic guard不跨API误伤。报告“无歧义出数、有歧义隐藏；启发式强度不同于Responses”，附§6.4未测量、无法估计的风险与同源计数局限，不全隐藏冒充可用。

**B：展示、恢复与文档统一收尾**

- 独占`src/web-hub/ui/src/i18n/{zh,en}/transcript.ts`、`tests/integration/web-message-speed.test.ts`、必要的既有`tests/web-hub/ui/generation-speed-*.test.ts`、`docs/dev/web-hub/README.md`、`docs/dev/web-hub-tokens-speed/{plan,multi-api-plan}.md`。
- 不改组件/reducer/恢复实现；测试三家族正常live/刷新、完整external后后续轮次有徽章、metadata删除/replace和Anthropic污染长期隐藏无落盘；费用/固定tokens/s/streaming不变。
- 同步§5.3口径，不再写P2能力阻塞、100%强制隐藏、强归属保证、未经测量的概率或独立计数验证。

开发期建议门禁（本轮未执行）：

```sh
PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/web-hub/agent/message-speed.test.ts tests/web-hub/agent/message-speed-p0.test.ts tests/web-hub/agent/wiring-message-speed.test.ts tests/web-hub/protocol/message-generation.test.ts
PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/integration/web-message-speed.test.ts tests/web-hub/ui/generation-speed-format.test.ts tests/web-hub/ui/generation-speed-view.test.ts tests/web-hub/ui/generation-speed-state.test.ts tests/web-hub/ui/generation-speed-component.test.ts
npm run typecheck
npm run format:check
PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1
```

主会话合并后按仓库要求跑build/build:web/check:web和受影响tier2；本任务不授权这些操作。估时不含未知SDK工程：P1+B可沿用2–3开发人日粗估，P2为局部保守reducer/测试包，具体按trace评估；不得为提高覆盖率擅自扩成SDK改造项目。
