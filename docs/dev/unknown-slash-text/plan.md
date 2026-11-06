# #40 · 未知斜杠作为普通消息（已实施 / conditional 验收收尾）

2026-11-06 · 用户已确认 Web＋飞书覆盖、接受 TUI 宿主 trim、默认启用；不修改 pi/node_modules、不纳入上游修改。两轮 Sonnet 评审已完成，root 已逐项裁定，不再第三审；本稿合并最后四项技术修订，**root 已 selfcheck 闭合，用户已通过 ask_user 明确批准实施（2026-11-06 17:58）**。

**L2，7 分**：文件数 2、跨模块 1、append-only feature token 1、设计选择 2、输入写路径 1。只新增一项必要的 `StatusInfo.features` token，不增 hub/hello cap、新 prompt 字段、混合 command result 或配置接线，不 bump PROTO。共享文件串行；后续 #40 UI 必须等待 #41/#42 完成写入，或以实际文件清单证明不相交并完成冲突预检；不能因本轮只改 plan 就宣称后续 UI 无冲突。

## 1. 事实与范围

`P=/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent`；上一轮核对实际安装 **1.4.0**，项目本地与全局 agent-session.js、interactive-mode.js SHA-256 一致。已完整阅读其 README、extensions、tui、usage、rpc、rpc-commands、rpc-extension-ui、slash-commands、prompt-templates、skills，以及项目 AGENTS 和 web-hub/reflex/topic-switch/feishu/secure 相关 README。本轮仅补查分流代码，不把安装包实现臆称成未读的上游源码。

- **TUI/RPC 已可直通**：`P/dist/modes/interactive/interactive-mode.js:2502-2728` 先 trim、分派内建；`P/dist/core/agent-session.js:1631-1721` 先查扩展，未知继续 input→skill/template→模型，已知 handler throw 时 emitError 且返回 true，不落入模型。RPC `…/modes/rpc/rpc-mode.js:298-317` 原文 prompt、source=rpc；TUI-only builtin 不由 RPC prompt 执行。上述是 1.4.0 取证坐标，peer 范围 1.0–1.3 **未经验证**，不能据 peer 声明推定行为相同。
- **Web 在两层拒绝未知**：`src/web-hub/ui/src/logic/control.js:72-76,248-252` 名单缺席即 deny；Composer `:1195-1210,1259-1264` 挡发送，DetailDock `:475-485` 再 return。agent `src/web-hub/agent/builtin-bridge.ts:628-658` 在执行前返回 `E_UNKNOWN_COMMAND`；`slash.ts:48-92,96,162-177` 将 getCommands 失败降成 []，并将公布名单截至 400，必须修正“失败＝未知”的错误证据。
- **普通消息链可复用**：`src/web-hub/agent/commands.ts:326-378,583` 含 auth-admin/fabric/session/busy 防线，sendUserMessage 显式 expandPromptTemplates:false；`P/dist/core/agent-session.js:1910-1938` 仍过 input（source=extension），不会执行 slash。
- **飞书不执行任意 pi 命令**：`src/web-hub/hub/feishu/router.ts:29-78,142-160,228-265` 是独立 bot parser/持久请求链；未知回 help，`service.ts:1394` 加未知提示。不能拿 bot 名单冒充完整 agent registry。

非目标：TUI/RPC 运行时改写、上游修改、editor 替换、输入回灌 hook、pi 命令试执行、记忆/#36/#43 编辑、安装/git 写/真实用户输入或设置修改。

## 2. Web：权威未知终态后，一次原文 prompt

### W1 · 分类与 UI 发送门

复用现有 Web parser（不 lowercase、不剥名字后缀）。以下新路由仅在 **commandsEnabled=true 且当前 agent status 含 `unknown-slash-text.v1`** 时开启，缺 token 保留旧未知拒绝；commandsEnabled=false 则维持既有直接 prompt，既不做 A→B，也不启用 W3。Composer、DetailDock、附件 gate 共用路由判定：**名单精确命中且 policy=deny 仍挡住；名单缺席是 unresolved，不是 deny，也不是已证未知**，放行 command 请求让 agent 判断。未到名单与被 400 条截断同样处理；已知 allow/confirm 仍用原命令流程。未知不再显示“未识别/绝不作为文本发送”。浏览器不执行命令来探测存在性。

**保留现有 `classifyCommand` 的签名、返回值及容错行为**；`command-complete.ts:41,267` 和 `agent/index.ts:152,1108` 的 completion/shadow 调用不迁移。另在 slash.ts 新增严格分类函数（如 `classifyCommandStrict`），仅 bridge 与 W3 prompt 验证使用，独立完整读取注册表，返回三态 known/unknown/unavailable；注册表读取异常、缺 port、非数组或畸形结果均 unavailable（复用 E_UNSUPPORTED、effect:none），**不得 E_UNKNOWN_COMMAND**。只有成功读取完整 getCommands、查无精确 invocationName 且不在 builtin bridge∪deny 表时，才可返回权威 unknown。先钉住 builtin 覆盖门禁，再允许客户端使用该证据。

### W2 · 唯一 fallback 条件与归因

对于 wire 可表达的 command，收到 **终态 E_UNKNOWN_COMMAND 且 effect:none** 才发送一次缓存的原始 composer 文本（含换行/空白；附件只 compose 一次），走已有 sendPrompt，expandPromptTemplates:false。禁止 fallback 的结果包括：任意 E_BAD_REQUEST（name/参数/大小错误）、E_COMMAND_DENIED、E_CONFIRM_REQUIRED、E_UNSUPPORTED、handler 异常、timeout、网络错误及 effect:unknown。已知参数错或 handler 报错永远停在 command 流程。两次往返可接受，不隐藏实际 prompt 失败。

command 请求 A 与 prompt 请求 B **必须不同 cmdId**：A 已由命令账本终结，B 才是普通消息的 ctl/recall/history 归属；不改 A 的 op、结果或账本。客户端持有 A→B 的一次性状态（unresolved→unknown-confirmed→prompt-sending→terminal/unknown），收到重复响应/查询不得再生成 B。A 未执行，不伪造“命令执行成功”history 卡；B 的 user message 与 prompt 状态是最终消息证据。普通已知命令的 captured/output、cmd_late、确认、command history 保持不变。

断线/超时在 A 阶段只查询 A，不自动另发 prompt；仅权威查询得到同一未知终态且当前页面仍有未消费的一次性意图时，可首次生成 B。B 发送后效果不明只查询 B，不换 id 重发。reload/页面刷新丢失关联则提示用户核实，不自动恢复 fallback。保留 expect.sessionId、agent identity/epoch；A/B 之间 session/epoch 变化取消自动衔接，不将旧文本送到新会话。资源列表变化不让 B 再次执行命令，因为 B 是 expandPromptTemplates:false 的文本。

**能力证据改为一项 append-only feature token**：StatusInfo 没有可用 agent version，Completed.version 与本能力无关，不设置版本阈值。`src/web-hub/protocol/messages.ts:736-739,1069-1082` 已有 `features?: string[]` 及 token 常量；在同处新增 `UNKNOWN_SLASH_TEXT_FEATURE_V1 = "unknown-slash-text.v1"`，不改 schema。`agent/index.ts:1021-1037` 的 resumeFeatures/publishStatus 链在原 tokens 末尾追加本 token，保持 resume/history 相对顺序；仅 control∧webCommands 开启、ctx 有效且本 activation 已装配严格三态 bridge/W3 路径才 advertise，不要求持久 session，也不借用 resume policy/history recorder 门。单次注册表失败仍返回 unavailable，token 不是“读取永远成功”的保证。

UI 在 `logic/control.js` 新增 status.features 的精确 membership helper，Composer/DetailDock 共用，参照 `logic/resume.ts` 的 resumeAvailable；发送 A 与衔接 B 都复核当前 token/identity/session/epoch，token 消失即取消衔接。旧 agent 缺 token绝不自动 fallback。旧 hub 利用现有开放 StatusInfo/schema 透传（`messages.ts:1877-1881,1988`）；旧 UI 忽略 token。`protocol/version.ts:393-402` 的 cmd.history.v1 是另一个 **hub cap**，本方案不照搬该双面 cap，因此 **version.ts 无需改动**，不增 hello/caps 数组、不 bump PROTO。

### W3 · 非法 command name：独立的可证明分类，不接 E_BAD_REQUEST

现有 command.name 只支持 `[A-Za-z0-9:_.-]{1,64}`；pi 的注册名不应被假设同样受限。因此 Unicode、路径、超长 token 等不能靠 UI 正则证明未知，也不能先取 E_BAD_REQUEST 再 fallback。

这类 raw slash 输入直接用现有 **prompt** 传输。`handlePrompt` 的事实顺序是 `beginOrReply(frame,{text})` 在前（`commands.ts:326-330`），并非分类前无账本写入。W3 必须放在该 begin 之后、ctx/expect/大小/auth-admin/fabric/compaction/switch 检查之后（`:331-378`）、mention/thread/hold 分派及 markDispatched/appendOrigin/sendUserMessage 副作用之前（`:439-583`）。仅“非 Feishu Web origin、无 thread metadata、Web commands 开启、当前 activation 已装配并宣告可信 token、现有 Web parser 可拆出且 name 不符合 command wire regex”才只读严格分类；agent/index.ts 的 handler deps 注入与 advertise 使用同一个本地 readiness 条件，不信客户端自报 token。

确证 unknown 才继续普通消息；known 用 `settleAndReply(E_BAD_REQUEST,effect:none)` 收尾（当前 Web command 无法表达，不执行、不转文本）；unavailable 用 `settleAndReply(E_UNSUPPORTED,effect:none)` 收尾。已有 begin 不得悬挂，不再次 begin。**不在 dispatchHeld 重入、thread 直投或 Feishu origin 运行本分类**；commandsEnabled=false、wire 合法名字普通 prompt、前置空白、单 `/` 与 `/` 后无非空名字都不二次分类。B 本来就是普通消息，不因已知名字重新执行；已知参数错也不会变成 B。此补丁须测试显式文本模式对“已注册但 Web 不可表达名字”的有意拒绝。UI 与 agent 以同一 `[A-Za-z0-9:_.-]{1,64}` 名字约束及边界 corpus 钉一致性，不放宽已有 command schema。

## 3. 飞书与 parser 精确定义

**飞书已启用 bot 命令名单**：固定 `/list /use /cur /new /unbind /file /help`，仅 schedule 启用时加入 `/schedule`，仅 threads 启用时加入 `/main`。先精确识别首行 token，再按原参数语法处理；已知参数错保留 help，执行/授权/绑定错误不 fallback。`/mainx` 不再匹配 `/main`（修掉 startsWith 前缀错误）；非名单斜杠全部普通文本，包括 `/model /reload`、被关闭的 `/main /schedule`，绝不提示 unknown，也绝不执行 pi 命令。未绑定/未授权仍走原拒绝；持久接收、去重、thread 直投与安全 origin 限制不变，无完整 agent registry 也不假称区分 pi 已知/未知。

**固定 parser 用例（foo 为已注册扩展，Model 未注册）**：

- Web `/foo\n`、`/foo\tx`：按 `\s+` 拆为 foo＋参数；foo 已知就保持命令执行/错误语义。pi 扩展 parser 只用 ASCII 空格，RPC 的 `foo\n`、`foo\tx` 是不同名字；TUI `/foo\n` 因宿主 trim 成 `/foo`，但内部 tab 不移除。不在此次统一。
- `/Model` 不等于 `/model`，仅精确存在 Model 才已知；禁止 lowercase。`/foo2` 不等于 `/foo`。重名以 pi getCommands 暴露的实际 invocationName（如 `foo:1`、`foo:2`）匹配；不得去 `:n`、不得从原名猜调用名；裸 foo 依真实注册表与 builtin 表分类。证据：`P/dist/core/extensions/runner.js` 的 resolveRegisteredCommands/getCommand（上一轮安装包约 551–596 行）。
- 前置空白：Web/RPC 不 trim，` /foo` 按现有 parser 为普通文本；TUI 会先 trim 后命令分流，接受此差异。`//foo`：Web 既有 escape 不解析为 command，保留双斜杠正文；飞书既有 escape 去一根斜杠成为 `/foo`；TUI/RPC 不新增去斜杠规则。
- 飞书 `/use\tx` 仍命中已启用 bot token use，但参数不合现有 `/use ` 语法则 help；`/main\nx` 在启用时为 main 正文，关闭时原文文本；CRLF 的参数接受情况按现有 first-line parser 钉现状测试，不偷偷 trim/规范化。`@notify/#notify` 命中仍按既有 input hook 去关键词并 trim（`src/feishu-notify/index.ts:498-506`），无关键词未知文本不由本功能 trim。

## 4. 精确实施域、默认启用与门禁

**最小运行时域（不按整目录授权）**：

- `src/web-hub/agent/{slash,builtin-bridge,commands,index}.ts`：新增严格分类且保留旧分类器、权威未知、W3 安全插点及 readiness/status 构造；必要时 `command-policy.ts` 仅补 conformance 发现的 builtin 名字遗漏。
- `src/web-hub/ui/src/{logic/control.js,components/control/Composer.vue,components/control/CommandPalette.vue,components/detail/DetailDock.vue}`：unresolved 与 deny 分离、共享路由、fallback 衔接及文案；仅在复用发送/去重确有需要时改 `composables/useControl.ts`；`i18n/{zh,en}/control.ts` 只改未知提示。附件 `logic/upload.js` 现有 commandRouted 参数可复用，不预授权编辑。
- `src/web-hub/protocol/messages.ts`：仅新增 feature token 常量/注释，沿用 features string[] 与已有 schema；`protocol/version.ts` 已核对，仅作为 hub cap 对照证据，不授权编辑。UI feature 读取落在上列 control.js/Composer/DetailDock，不改 AgentDetail/FleetDrawer/contracts。
- `src/web-hub/hub/feishu/router.ts`：启用名单、未知文本、main 精确 token。文档域为 `docs/dev/{web-hub,feishu-bot}/README.md`；若纳入 peer bump 强制 conformance，**AGENTS.md 仅在「pi peer bump checklist」第 2 项追加 `tests/conformance/unknown-slash-text.test.ts` 一条**，并跑 `tests/docs/agents-md.test.ts`，不重写其他段落。

**默认行为就是启用**，是用户要求的有意行为变更，不再提默认 false。推荐不引入关闭开关：此修复无需 settings/setting-specs、launcher、ports、hub config 或 protocol/version；必要 wire 增量仅为已有 features 数组中的一个可选 token（常量在 protocol/messages），不新增字段/schema/hub cap。I9 不可用于否定需求；它约束既有设置关闭面的字节一致性：webHub/control 关闭不新增本特性接线/IO；webCommands 关闭不宣告 token、维持原直接 prompt；bot 未组装无飞书行为变化。默认开启下 unknown 的旧拒绝输出、飞书 `/mainx` 误识别是有意变更，新增行为测试记录；**A 级 frozen golden 一律不重录**。实施前若发现 A golden 实际冻结这些必改默认行为，停报 root 裁定冲突，不换默认、不偷偷更新。若 root 后续要求新增关闭开关，需另确认最小设置域与 off 回旧语义测试，当前不扩域。

**测试矩阵（定向先行，均断言正文/次数/错误，不以不抛异常代替）**：

- 新 `tests/conformance/unknown-slash-text.test.ts`：真实 InteractiveMode＋假终端主循环、RPC 子进程＋fake provider；1.4 builtin 名集必须被 bridge∪deny 覆盖（含隐藏内建），重名后缀/大小写/空白/换行差异、已知 handler throw 不 fallback、getCommands 失败不等同空名单。1.0–1.3 未验证须明报，若该测试红不得静默扩大宿主承诺或修改 node_modules。
- 扩展 `tests/web-hub/agent/{slash,builtin-bridge,commands}.test.ts`：旧 classifyCommand/completion/shadow 行为不变、新严格 known/unknown/unavailable、builtin 覆盖、非法 name 已注册/未注册/分类失败、known name/参数 E_BAD_REQUEST 都不送模型；auth-admin/fabric、LOCKED、source=extension、安全检查仍成立。
- 扩展 `tests/web-hub/ui/{logic-control,composer,detail-dock,use-control,composer-upload}.test.ts`：Enter/button 一致，名单未到/400 截断/过期、known deny、unknown 一次 A→B、不同 cmdId、重复响应/断线 query/刷新/epoch/session 变化、已知 throw/late/history 不 fallback、附件一次 compose。默认启用、无 token 保守拒绝、commandsEnabled=false 直接 prompt、token 消失取消衔接、非法 name regex 一致性。
- 扩展 `tests/web-hub/agent/{command-complete,wiring-resume}.test.ts`、`tests/web-hub/protocol/{messages,resume-wire}.test.ts`：旧 completion/shadow 返回值不变；新 token readiness/control/webCommands/非持久 session 矩阵与 token 顺序，旧开放 schema 透传、无 token旧数据仍可解码；新增 token 的精确数组预期属于声明的默认行为变化，不重录 A golden。shadow 调用用 slash.test.ts 的兼容断言加 index 调用点核查，不改旧调用点。
- 扩展 `tests/web-hub/hub/feishu/router.test.ts`，新 `tests/integration/unknown-slash-text.test.ts`：Web→HTTP→agent 与飞书 fake admission/requests 闭环；未知正文一次进入 provider/队列，已知参数/执行错零 fallback，禁用 main/schedule、mainx、pi 命令纯文本、绑定/权限/重复事件、thread 分流。新文件必要时精确登记 `tests/tiers.ts`，不碰 #43 其他测试改动。

secure 最早 handled/blocked 不变（`src/index.ts:184`、`src/secure/guards.ts:333-340`）；不改注册顺序。reflex/topic-switch 保持斜杠 prefix veto（`src/reflex/core/gate.ts:120-125`、`src/topic-switch/filters.ts:129-133`），已有 hold 的 newcomer 只消费一次；不通过剥斜杠诱发 judge/回环。已知扩展原本先于 input，LOCKED 并非禁止所有命令；未知仍走普通安全链、D8 不重启、既有 hub 明文 R12 风险不扩大。

后续门禁：root 自行读核验并闭合→向用户给一页方案确认→定向测试（含 docs gate）→`npm run typecheck`、`npm run build`、`npm run build:web && npm run check:web`、`PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1`＋相关 tier2；只格式化改动文件。真实 mount 测试另约独占环境。**本轮只修本文与检查其格式，不正式编码/测试/安装/git 写**。

剩余风险：两次往返延迟；浏览器刷新后关联丢失只允许核实、不能保证自动续发；旧 agent 缺 feature token 故保守维持旧语义（仅 commandsEnabled=true 的命令路径，不误称 Web commands 关闭时拒绝文本）；1.0–1.3 宿主前提未经实测；非法注册名的显式文本拒绝属于边界收紧。所有已定范围不再反问用户；root 仍需确认这些设计与评审闭合，才可实施。

### 旧新能力矩阵

| UI/agent/hub 条件                                            | 行为                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 新 UI＋新 agent，commandsEnabled=true＋token                 | W1/W2；非法 wire-name 才走 W3；已知 deny 仍拒绝                             |
| 新 UI＋旧 agent 或当前 status 无 token，commandsEnabled=true | 旧未知拒绝；不触发自动 fallback/W3，不靠版本猜能力                          |
| 任意 agent，commandsEnabled=false                            | 现状直接普通 prompt；无 A→B，无 W3，与“旧 agent 保守拒绝”分开               |
| 新 agent＋旧 hub＋新 UI                                      | 开放 status.features 透传即可启用；若 token 未传到，退回无 token 行为       |
| 旧 UI＋新 agent                                              | UI 保持旧未知拒绝；新 token 被忽略，普通直接 prompt 受 W3 既定窄条件保护    |
| control=false / WebHub 未组装                                | 不宣告 token，沿用原控制/连接禁用语义                                       |
| 飞书 bot 已组装                                              | 启用 bot 名单以外均文本，不依赖 Web UI feature token；W3 跳过 Feishu/thread |

## 5. 最终评审处置表

两轮评审已结束；以下记录 root 裁定后的技术落点，不启动 review3、不把作者自检当独立验收。前轮七项（飞书/UNKNOWN-only/parser/conformance/default-on/最小域/trim）保留在正文；最后四尾项单列源码证据如下。

| 尾项（root 全部采纳）                  | 实际源码证据                                                                                                                                                                                                                                                                                                                             | 技术处置 / 精确落点                                                                                                                                                                                                                                                                                                                | 本稿落点                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1 severe：能力门不可虚构版本           | `protocol/messages.ts:685-779` 的 StatusInfo 无 agent version；`:736-739,1069-1082,1877-1881` 已有 optional features；`agent/index.ts:1021-1037,1061,1504` 构造并传递 tokens，`agent/status.ts:147-156` 已通用投影；`ui/src/logic/resume.ts:49-53` 精确读取 token；`protocol/version.ts:393-402` 是 history 的 hub cap，不是本功能必需面 | `protocol/messages.ts` 只增 token 常量，`agent/index.ts` 追加有条件 token 并共享 handler readiness，UI `logic/control.js`/Composer/DetailDock 读 features。status.ts 已泛化无需改，version.ts 不改，无新 PromptArgs/result/PROTO。测试 `protocol/{messages,resume-wire}.test.ts`、`agent/wiring-resume.test.ts` 和 UI feature 矩阵 | 34–36、61–66、73、82–92     |
| 2 legacy classify 行为不可外溢         | `agent/slash.ts:48-92` 现有 safeGetCommands/classifyCommand；`agent/command-complete.ts:41,267` 调用；`agent/index.ts:152,1108` shadow 使用                                                                                                                                                                                              | 原签名/容错/返回值保留；新增 strict 函数独立完整读取，仅 `builtin-bridge.ts`、`commands.ts` 使用。`slash.test.ts` 钉新旧两套结果，`command-complete.test.ts` 与 shadow 调用点回归不变                                                                                                                                              | 24、61、71、73              |
| 3 W3 插点与窄门                        | `agent/commands.ts:326-330` beginOrReply 最先；`:331-378` 验证；`:439-446` thread；`:574-583` origin/send；dispatchHeld 独立路径约 `:633-675`；`agent/index.ts:1265-1289` handler deps                                                                                                                                                   | begin 后/安全验证后做 strict 分类，拒绝 settleAndReply；共享 index readiness，跳过 Feishu/thread/dispatchHeld、合法 wire-name 与 commands-disabled，UI/agent regex 同 corpus 验证。初始 begin 已有账本写入，不谎称零 ledger 副作用                                                                                                 | 38–44、61、71–72            |
| 4 commandsEnabled=false 与旧端不可混淆 | `ui/src/components/control/Composer.vue:198,215,1205-1209` command gate；`components/detail/DetailDock.vue:475-485` commands=false 落普通 prompt；`agent/index.ts:1031,1740` control/webCommands gate                                                                                                                                    | commands=true＋token 才 unresolved/A→B；commands=true 缺 token 旧拒绝；commands=false 直接 prompt、不 A→B、不 W3。测试旧/新 agent、旧 hub透传、token 消失、commands off、control off 各自独立                                                                                                                                      | 22、34–44、66、72–73、82–92 |

以上为方案阶段四项处置记录；root 随后已 selfcheck 闭合，用户于 17:58 明确批准实施。实现已交回并获 Sonnet conditional 通过，本轮仅收尾文档与共同 Web 门禁，不重新打开方案评审或扩大源码域。

## 6. 实施状态与 root 冻结面裁定（2026-11-06）

本稿已获用户实施授权；前文“不编码/仅文档”是此前阶段的历史门禁。实施初期 WebHub README 由 #41/#42 独占冻结，说明先落 `runtime-notes.md`；两包正式交付后，root 已在 2026-11-06 18:35 释放并授权本轮独占合并，Unknown slash text 正文现已合并至 WebHub README，保留 Activity rail 与其他旧内容原顺序。共同 Web 门禁改由本轮唯一 build owner 一次执行，不与 browser verifier 反复争用产物；全量 tests 仍留 root。PG 已改读独立 dist，backend build 已通过。

默认 features 追加 token 与旧 XS A 级快照的完整 status 比较冲突已实际复现（非 fixture 本身改变）。root 亲读后裁定独立包集中处理 `tests/integration/{fabric-xs-off-golden,fabric-xs-reply-off-golden,fabric-xs-channel-compat}.test.ts`：XS 比较投影前先断言本具名 token 恰好一次，只 strip `unknown-slash-text.v1`；其他字段/顺序全部仍按原 golden 比较，默认 on 的原始 features 独立精确断言 `[resume.v1,cmd.history.v1,unknown-slash-text.v1]`。本实现包未编辑这三测试或任何 fixtures，不增生产测试开关、不退默认 false；代码、常量与对应测试最终由 root 同批提交，不拆测试先提交。verifier 须核投影未削弱 XS 覆盖。

新增两个测试位于现有 `TIER2_DIRS`（integration/conformance），因此无需修改 `tests/tiers.ts`；AGENTS 仅 peer bump checklist 追加 unknown-slash conformance 条目。目标及实测安装 pi=1.4.0，不占用 #45 独立 clone 的 1.5 适配工作。

### 实施交回证据

- 本包已实现运行时、UI 与飞书修改，未改宿主、settings/ports/version/contracts/fixtures；原冻结 WebHub README 在本轮获得独占授权后补入说明。两个新增测试沿用 tier2 目录分区，无 tiers.ts 改动。
- 最终联合定向回归：29 文件 **848 tests passed**，涵盖自身 conformance/HTTP+Feishu 闭环、UI/附件/history、secure guards/off golden 与独立包的三 XS 比较；完整日志 `/tmp/unknown-slash-targeted-all-green.log`。早期 test-first 红例与修正后日志保留在 `/tmp/unknown-slash-*.log`，未以 skip/stub 放行。
- 实际安装 pi **1.4.0**；真实 TUI、RPC 子进程、本地 fake provider、重名 invocationName、原 notify trim 与真实 LOCKED input chain 均有断言；1.0–1.3 未验证，1.5 由 #45 独立 clone 处理。
- 初次实施交回时 `npm run typecheck`（TS7×2＋vue-tsc）、`npm run build` 和精确文件 Prettier 检查通过；当时按 root 指示未跑 build:web/check:web/全量 test。Web 门禁已在下节唯一 owner 收尾中补齐，全量 test 仍未运行。
- Sonnet #40 验收（run_id: r_6GC10YKQ）已 conditional 通过，无安全/正确性 blocker；root 剩余两项是 README 合并和共同 Web 门禁。本轮补齐后交 root resume 原 Sonnet 核闭合，不开新 review。未执行 git 写/安装/真实用户输入或设置修改。

## 7. README 合并与共同 Web 门禁闭合（2026-11-06 18:38）

Sonnet #40 验收（run_id: r_6GC10YKQ）conditional 通过后，root 授权本轮只写 WebHub README、本 plan、runtime-notes；不维护 Todo，不改 src/tests/AGENTS/fixtures/其他 docs。Unknown slash text 正文与目录项现已合并，runtime-notes 改为已合并状态；对合并前 README 快照逆向移除新增项，确认包括 #41 Activity rail 在内的全部原内容逐字节且顺序不变。README 本轮精确增量见 `/tmp/40-final-readme.diff`。

唯一一次 `timeout 300 npm run build:web` → `timeout 180 npm run check:web` 均 exit **0**；使用 pipefail＋tee 完整记录 `/tmp/40-final-web-gates.log`。未修改 UI、预算、CSP、manifest/provenance 规则；未额外跑 browser/截图/全量测试。check:web：85 files，first-screen JS 390497 B gzip / 524288 B，lazy JS 84330 B / 131072 B，CSS 39236 B / 65536 B；其他 provenance/license/mermaid 门禁同时通过。

构建冻结后不再重建，供 #40/#41/#42 UI verifier 复用同一产物：

- `dist/web-hub-ui/build-info.json` SHA-256：`56d47a0555716e07deb0f9190c2d20aaae960c73c97f3a109e4690b7fe22c0c7`（freeze SHA，manifest 绑定全部文件 hash）。
- 主 bundle `assets/index-CYbcitnd.js` SHA-256：`428a11dfa66539414fd560b5b86b06410e517b12025ebf74e6f904a00e41480b`。
- builtAt=`2026-11-06T10:37:51.863Z`，commit=`efa12f261496-dirty`，version=`0.10.6`；详细指纹在 `/tmp/40-final-web-freeze.json`。
- 主 bundle 中核实存在 `unknown-slash-text.v1`、`E_UNKNOWN_COMMAND`、`activity-rail`、`data-peek-open`、`data-docked-open`；门禁前后全部 3565 份 src/tests/AGENTS 文件内容 hash 不变。

本轮三 docs 的格式与 diffcheck 通过；交 root resume 原 Sonnet 核剩余两项闭合后再 commit。本轮未执行 git 写、安装或任何源码/测试变更，不将 conditional 擅自改成最终独立验收通过。

## 8. Full Tier1 遗留期望补齐（2026-11-06，HEAD efdcb828）

root 报告 #40 runtime 与 Sonnet 条件复验均已通过，但共同 fullTier1 日志 `/tmp/batch-20261106-tier1.log` 仍有 7 fail / 5 files：均是已批准默认行为的旧期望，**不是 flake、不改 runtime/fixtures 迎合**。root 新增独占授权仅改 `tests/web-hub/agent/reload-result-compat.test.ts` 与 `tests/web-hub/hub/feishu/{schedule-router,schedule-service,service,thread-service}.test.ts`，以及本 plan/runtime-notes 记录 gate；其余源码/文档/测试/AGENTS/package/fixtures 冻结，不 git 写/安装/全量 tiers/Todo、不再 Web build。

reload 是遗漏的第六个冻结比较消费者：live status 的 features 先精确 pin `[resume.v1,cmd.history.v1,unknown-slash-text.v1]` 且新 token 恰一次，仅在浅拷贝的具名历史投影中剥该 token；每个被 reserialize 的 status 先断言原串已是规范 JSON，非 status 原 string 不变。s1 仍全帧/全序列逐字节比较（唯一声明差异为该 token）；s2/s3 保留原 reload-only 与 inserted-status 必须带 reload 的 D6 规则，非 status 更直接比较原字节。辅助负测试拒绝非规范 JSON、额外/缺失/重复 feature；旧 capture 写入分支已禁用，不生成或覆盖 fixture。原 fixture SHA-256=`65a6dcd638096f553c34da8f94d55486a67a5b78ecf258c767a78680c18b46af`，留档 `/tmp/40-reload-rawfixture.sha256`。

四个飞书测试现在验证 disabled `/schedule`、`/scheduler`、未知 `/xxx`、pi `/model /reload`、threads-off `/main` 进入普通 prompt，只派发一次并保留接收后的正文；duplicate 事件不二次派发，启用 bot 的坏参数仍 help，权限/绑定拒绝保留。禁用 schedule facade 不生新 timer/port/receipt key/push；threads-off 无 thread metadata、bypass、main: 合成 member、transport 调用或 post push，状态顶层键不变。原其他正反契约不删除。

**既有群 @mention 归一化边界（root 已裁定，不是新增产品取舍）**：`src/web-hub/hub/feishu/inbound.ts:271-273` 去掉 mention 后，当 mentions 非空会 trim 首尾。测试用真实 `decodeFeishuEvent` 独立固定字面量 pin：`"  @_user_1  /main force\n  /reload raw  "` → `"/main force\n  /reload raw"`，保内部换行/两空格和 /reload 原文；再断言 parser 与 dispatch 精确等于该固定字面量/decoded text，且重复事件一次。另有非 slash 普通 control 同样的两层字面量断言，证明不是 #40 新 trim；DM 的尾空白仍由 schedule/service 用例逐字节保留。Web/TUI/RPC 与 known-error 零 fallback 语义不变，无 runtime 修改。

验证记录见本轮交回段；先前 red 测试日志保留 `/tmp/40-tier1-7fail-fix-first.log`（最后一例是新增 group 边界强断言），root 确认边界后修正为显式 decoder characterization，而非广泛 trim expected。

### 本轮测试 gate 交回

- root 采纳的五个文件最终定向（workers=2，timeout=180）：**5 files / 79 tests passed**，exit=0，`/tmp/40-tier1-fix-five-final.log`。原 7 个红例均有明确新行为断言，不是删 assert 或 flake 重试；reload 另加 2 个投影负向防线测试。
- 原 29 文件＋上述 5 文件联合回归：**34 files / 927 tests passed**，exit=0，`/tmp/40-tier1-fix-final34.log`；随后仅强化 bad-bot-args 回复来自本次新 outbox 消息的断言，再跑上述五文件全绿。
- `npm run typecheck` 与本轮七个精确文件的 Prettier/diffcheck 均通过；最终证据 `/tmp/40-tier1-fix-typecheck-delivery.log`、`/tmp/40-tier1-fix-format-check.log`、`/tmp/40-tier1-fix-audit.log`。fixture 原字节与 hash 未变。
- 仅本轮授权 5 tests＋2 docs 变更；不改 runtime/README/AGENTS/package/fixtures，未触碰 #46 worktree、不 git 写/安装/全量 tiers/Todo，也未重建主树 Web bundle。初始 fullTier1 的 7 fail 日志仍保留，**未声称已重跑 fullTier1**；交 root resume 原 Sonnet 核闭合后再提交。

本轮冻结域审计还检测到 4 份**非本包写入**的并发变化：`docs/dev/memory-governance/pg-report.md`、`docs/dev/web-hub/README.md`、`src/web-hub/ui/src/styles/fleet.css`、`tests/web-hub/ui/activity-rail.test.ts`。已向 root 报告归属核验，本包不修改或回滚它们；不能把共享树审计描述为“所有其他文件完全未变”。本包 write 路径仍严格是授权 5 tests＋2 docs。本包未重建 bundle；但终审检测主树产物已由其他写入更新（builtAt=`2026-11-06T11:03:34.881Z`，manifest SHA=`1deddb5848295fbe28861524c6fd227f55fa2f5f6e821c6a33171de71bf79a36`，main=`assets/index-BZb2aB5Y.js`），已另报 root 核归属，不把历史 freeze SHA 宣称为当前共享树状态。
