# Fast · 开发者要点

## 当前实现（task55 P4b）

最低宿主为 **pi 1.5**，tested 为 1.5.0。P0/P4a/P1/P2/P3 与集中装配已实现；设计快照见
[plan.md](./plan.md)、[arch.md](./arch.md)。旧文档里的 1.0–1.4 兼容路线仅为历史，不能重新引入
runtime IO probe、私有 rollback 或旁路 store。本实现尚未部署到用户正在运行的会话，不代表真实代理
落实了 Priority、性能提升或收费已核实。

- `fast.enabled` 默认 true，注册 `/fast` 与固定 provider hooks；新 session 初始 **inherit**，不写 startup
  record、不主动请求档位、不占 footer。显式 false 在注册前返回：零 Fast command/hook/bus/owner/seed/
  branch 读回/写盘/payload 变化。该设置非 live，修改需 `/reload`。
- `/fast`、`toggle`：on→off，其余→on；`on` 请求 priority，`off` 请求 default；`inherit`/`reset`
  停止覆写并保留原 tier；`status` 只读。帮助及补全只推荐 `inherit`，旧拼写 `reset` 仍受理。
  trim、大小写、usage、toggle 全部复用 P1 parser/resolver。
  usage/status/同 mode 不追加条目。**例外是最新记录 invalid/future 时，显式 inherit/reset 追加一次有效
  inherit 墓碑修复**；不让 helper 的 undefined 将这个修复误判为普通幂等。
- 只保存原 session 的 `subagent:fast` custom entry，data 恰为 `{v:1,mode}`。主会话用 `pi.appendEntry`，
  child 初始化用 P3 的原 `SessionManager.appendCustomEntry`。SDK1.5 正常返回即按公开合同视为成功，
  **不是 fsync 承诺**，也不拿 `getBranch()` 当磁盘证明。只有 append 成功才应用/回显新模式；异常保留
  最后成功 mode 和 storage-fault，不保存异常文本。notify/setStatus 失败独立吞掉，不将已成功保存误标为存储失败。
- Slash command 在 SDK 中先于 input handler 执行。因此 main/child 装配透传现有
  `secureGuards.recheckForWrite(ctx)` 作为可用性门：LOCKED 不追加、不继承 seed、不注入 tier；不扩 D8
  例外，不在 Fast 重写 secure 判定。command/provider 入口检查当次公开 ctx，owner snapshot 使用仍有效的
  open ctx；失效 ctx 不作无上下文安全推断。原域检查、vault/inMemory manager 与 child 目录保持不变。

## P1 纯逻辑边界

`state.ts` 只读当前 branch 最后 own `type=custom/customType=subagent:fast`；最新畸形或未来版本
返回 inherit+invalid-record，不穿透旧 on。只读 own data descriptor，不执行 accessor/prototype；额外
record 字段忽略。`snapshotToFastSeed` 只投影 v/mode，不传播 revision/incarnation。

`payload.ts` 的 `rewriteFastPayload(payload,snapshot)` 在 inherit 返回裸 undefined，**零访问 payload**。
其它模式每次重新严格识别实际 Responses body，不能拿 stale shape 或 ctx.model 放行。applied 返回浅拷贝
replacement，只覆盖顶层 service_tier；model、reasoning、input、tools 等嵌套引用保持。other 为 suspended，
unsupported 为静态安全原因枚举；均返回 undefined，让 SDK 继续原请求，不 throw 假装阻断，不新增重试/
降级/降 reasoning/ultrafast/价格或 catalog 修改。

根 allowlist、混协议拒绝、items/tools/tool_choice 规则见 P1 测试。reasoning 的可选 content 数组内部
opaque，status 可为 null，保留 SDK thinkingSignature 回放；JSON Schema 和图片正文不遍历。
`ResponsesShape.dialect` 只表示结构，不证明 API/provider/transport。公开 before_provider_request 只有
payload；ctx.model 只用于安全截断的 selection 显示，不是路由权威。

## 固定装配与生命周期

`wire.ts` 无 module mutable、Symbol、timer 或全局 registry。main 在 cacheTTL 之后、traffic host 之前
固定注册；`index.ts` 只组装。`buildSessionStack` 在旧 parts handoff 后 open 一个新 owner，注入：

1. `SpawnServiceDeps.fastParent = owner.parent`，受理时快照；
2. `PiSessionDriver` 第四参数 `owner.childState`，P3 绑定前读已受理 seed，绑定后读 child branch；
3. `createWorkflowChildSpawner(...,{fastWorkflow:owner.workflow})`，由已有
   `deps.fastWorkflow ?? spawner.fastWorkflow` 桥到真实 orchestrator/host。

所有端口闭包绑定**具体 session owner**，不查询 global/holder 当前栈。关闭 owner 后 capture/snapshot
返回 undefined，清空 child reader；旧 workflow A 不可能读新 B。child registry 按 runId+incarnation 绑定，
旧 cleanup 只撤销自己，不能删除替代绑定；P3 的 abort/create-failure/handle.dispose 主动撤销，不等
child session_shutdown。无 port/disabled 仍是旧 optional 语义。Stack 三个 ordered lists 都在
backgroundCompletions 后同步 dispose Fast，早于 drain；重复 C→A 无额外效果，不增加预算/等待/timer。

每次 open 都新建 incarnation，branch mode 改变递增 revision。运行时用公开 sessionId/file 确认当前历史，
不假定 ReadonlySessionManager façade 对象相等；SDK1.5 替换/销毁后旧 ctx getter 会抛 stale，安全丢弃。
宿主/测试 ctx 的 sessionManager 缺失（undefined，或缺 getSessionId/getSessionFile）是**能力缺失**而非运行时
错误：identity 返回 undefined，open 先关闭旧 owner、active 置空、返回 inert ports（不产生 seed/capture/
binding），Fast 对该 session 不生效，session 打开绝不因此失败；main/child 的 get 同样在能力缺失时返回
undefined（无 controller）。存在但抛错的 getter 是真实异常，identity 不掩盖：open 让它上浮，get 由既有
catch 安全丢弃 stale ctx（限 main 的 get；child 的 get 没有 catch，child 侧抛错会从 provider
hook 上浮）——不把真实 bug 伪造成“能力缺失”悄悄关掉 Fast。
**ctx.signal 是当前 turn 的 signal，idle 可以 undefined，不能当 session 身份。** branch/fork/tree/
restore/reload/compaction/context-switch 均从当前 branch 折叠，不读模型摘要；同 ID 重建仍关闭旧 owner。
模式切换不撤回已交付 body，callback 入口同步捕获 mode/revision/incarnation。

child pre-guard 顺序：keepalive capture → Fast receiver/hooks → lazy budget 订阅/同步重放 → traffic。
`subagent:fast-bind` 的同步 reply 是就绪门，不是进程 activation counter。receiver 对同 manager+owner
幂等，对异 manager 拒绝；readMode 实时 branch fold。reply.dispose 同步退订 bus/provider handlers 并关闭
reader；不注册 main command/UI/tool/host。无 seed 的旧 session 可在首次 provider callback 读旧 branch；
无 seed 不制造新记录/握手。terminal Agent resume 的父新 seed（含 inherit）由 P3 覆盖旧 child；用户打开
旧 session 则按旧 history 恢复，二者不同。Droid 不携 seed。

P2/P3 已拥有两层 queue 的时点：workflow 校验后、replay/hash/FIFO 前 capture 并复制冻结 v/mode，adapter
转交，service 不出队重取；已受理 queued/running 不随 root 切档。hash 只加入 on/off；inherit/disabled
保 legacy 字节。命中 replay 不发请求，不显示已加速。

## Warming、观察与 UI

pi 原生 CacheWarmer 重放 session onPayload，因此**一并跟随当前 Fast**；不暂停、排空、改频率、改预算
或新增 warming-decision handler。已过 callback 的正常/warm body 保持旧值，后来 callback 用新模式。
真实 1.5 streamSimple 在本地 fixture 中将 warmer 的 maxTokens=1 clamp 到最终 16；Fast 不改这个 SDK
行为，更不能承诺“一 token”费用。Jev/title/topic judge、toolkit 直接 keepalive/measure 和独立 summary
不经 session provider 链，不注入 Fast；这不是“所有后台都 Fast”。其它插件可按原逻辑影响 warming。

requested、at-hook injected、latest observed **互相独立**。只从公开 provider_stream_event 的 Responses
created/completed 提取有界 tier enum/API hint/时间；不保存原响应、headers、keys、正文。缺 tier 显示
unknown。无公开 request/origin 关联，只叫 latest observed **(origin unknown)**，不将并发 warm 的观察
绑定到某次正常请求。default 不等于没有加速，priority 不作账单确认。

只用既有 notify 与 `setStatus("subagent:fast",...)`，紧凑英文 marker、中文费用说明，TUI/RPC/web
沿已有通道可见；不新增 web 按钮/协议。`FastController.command(args, ui?)` 的可选反馈通道只在
本次调用内使用：main handler 传入调用 ctx 的 notify，让 Web claimed capture 和 TUI observed
commandRecord 都能收集命令反馈，同时终端只通知一次。usage/status/幂等或 invalid 回显/写失败/成功
只选调用 notify 或默认 session notify，不叠加、不保存调用 UI；闭 UI 异常不影响存储判断。
footer 的 setStatus 和 provider 的 suspended/unsupported 通知仍走 open ctx 的 session 通道，后续
provider 回调不会粘住已结束命令的 capture/record window。other/unsupported 通知按有限静态原因
去重。费用/额度 premium 未知，包括 native warm；原 usage/cost 逻辑不改。

## 验证地图与剩余证据

- P1 `tests/fast/{state,command-parser,payload}` 与 `tests/conformance/fast-payload-sdk`：纯语义及真实
  普通/Codex/Azure SSE、受控 WS 最终 body/frame、reasoning replay，非自造 buildParams。
- `tests/fast/wire-{controller,main,order}`：三态、成功/失败/notify-fail、invalid reset、零 startup/status
  记录、expired ctx/ABA/owner 隔离、只读观察、同步 registry replay/延迟安装/重复安装次序。
- `tests/fast/wire-identity-guard`：宿主能力缺失（sessionManager undefined / 缺 getSessionId / 缺
  getSessionFile）下 open 不抛错且 Fast inert（无 seed/capture/binding、命令不写、payload 不覆写）；
  降级 open 后正常宿主仍按原 identity 语义工作。
- `tests/web-hub/agent/fast-command-capture`：真实 wrapper/capture/commandRecord/Fast 接线，独立
  open/callback ctx 的 Web 与 TUI 反馈矩阵、单次终端通知、无 footer/LLM context 旁路、provider
  去重与已结束/下一命令 window 隔离；纯受控 SDK/storage/UI 端口，不含真实浏览器/模型请求。
- `tests/integration/fast-wiring-storage`：真实1.5 buffered 正常返回与 flushed EISDIR 失败、后续 append/
  branch/reopen 不复活失败 on；真实 SDK command、stale ctx。P0 七场景回滚仍是独立前提，不冒称本测试
  重跑了全部七场景。
- `tests/integration/fast-wiring-child`：production receiver，经 settings 发现的双 canonical loader，三态
  seed、并发 child branch、handle cleanup；原 P3 另钉 seed 失败零 prompt/取消/原有有界 reaper。
- `tests/integration/fast-wiring-workflow`：真实 worker/orchestrator/journal 经 **spawner-only** capture
  和生产 adapter；on/off miss、inherit/disabled legacy hit、关闭 A 不读 B。下层 runtime slot queue 的
  保真沿 P3 单独真实 adapter/pool 证据，不将本例 controlled service 声称为真实 slot queue。
- `tests/conformance/fast-wiring-sdk`：真实 AgentSession→production hooks→最终 SSE/WS；native warmer
  与正常在飞重叠、切档快照、cache_warm usage、uncorrelated observed；跨 API setModel、真实 Codex cached
  WS continuation、tier 切换后 SDK 自然 full-body/default、inherit 保原 body。只用 numeric-loopback
  进程内 fetch/WS，真实 Socket.connect 硬拒，无真实模型/认证/外网。
- `stack-teardown-matrix` 原28个 case保留，追加5个 Fast 生命周期 case。测试层自动归属：integration/
  conformance 为 tier2，其它新增纯/接线测试为 tier1，manifest gate通过，无需改 tiers 清单。
- 接线前已用实际SDK1.5捕获显式false七旧 profile，接线后逐 JSON bytes 相等。B级唯一
  `governance/activate-trace.json` 有意刷新 default 的 `/fast`+两 provider hooks，并新增 fast-disabled
  保存旧 default；历史其它 profiles 显式 fast=false、原 bytes 不变。A fixtures 不改。

未做真实性能、账单/代理落实、多 provider 线上、真实 vault/mount、部署/reload。全 T1/T2/web build
由 root 统一安排，本包只做小定向、严格类型检查、build、精确 format。其它历史 A-off 测试若把所有新
feature 的默认注册也冻结，按 root 授权仅在 reflex/schedule off capture 的本地设置输入显式
fast=false；不改共享 BASELINE、A fixture 或过滤无关旧行为。隔离 runner 的 root/workspace/cache/JITI/
HOME/agent 均在本包自己的 `/tmp`，共享 SDK 依赖只读。一般测试 TMPDIR 也独立；四组 legacy off
golden（reflex/schedule/fabric-xs/fabric-xs-reply）以标准 `/tmp` 为父，每例仍 mkdtemp 随机独占 leaf
并精确 cleanup。旧 normalize 正则不支持任意 nested TMPDIR，未修改 normalizer 或宣称该兼容性。
