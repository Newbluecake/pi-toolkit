# consult C2 preserve + 精确埋点（专家保活前置）—— 实施方案 v3.1

> 状态：**v3.1（按复评 r_39CZPMJN「有条件通过：0 blocker」收口；v3.1 处置表 §14）**。v3 按复评 r_YAD3SCGC 修订（处置表 §13），v2 处置表 §12 保留。日期 2026-10-10。
> v3 → v3.1（无架构变动）：① 逐请求用量改为**宿主侧请求级采集**（assistant `message_end` + `Agent.onPayload` 只读包装），不再从被子会话保活 ping 污染的累计 `diag.usage` 差分（§4.2-§4.3）；② 冻结 provider 可见字段清单 `PROVIDER_PREFIX_FIELDS`，conformance 与运行时探针共用同一纯函数，conformance 的输入是 HTTP 端点收到的原始 body/headers（§4.3、§8-C1/C9）；③ 删除 v3 的 `testAllow`，对抗测试改用只在测试里存在的守卫实现；生产代码只有一个守卫工厂，并有测试钉住（§3.3-⑤、§8-C10）；④ main 专家的裁决（Q1）成为发布验收的硬前置（§3.7）；⑤ 冻结面干净成为包 B/C 的开工闸门（§7）；⑥ 线级探针从子会话扩展挪到宿主驱动，`src/child/wire.ts` 不再改动（§4.3、§7 包 E）。
> 复评确认 v2 的主体成立并保持不变：C2 standalone + 精确埋点为首个交付物；包拆分；本地 HTTP provider 边界的 conformance；保活延后（§11）。
> v2 → v3 主轴变化：
> ① **R1 的精确口径（主会话裁决 M1/M2，2026-10-10）**：安全保证从「拦截前不运行任何代码」改为精确列出 pi 1.0.x 在拦截前运行的每一步（`agent-loop.js` 行号），并证明其中没有一步会执行专家工具；通知类事件（`tool_execution_start`）可以**观察到**被尝试的调用，这一点被正式接受（§1、§3.3-①）。
> ② **删除运行时字节级 fail-closed 闸门（v2 的 G-request）**：工具定义靠**构造**保持一致；字节级证据由真实 HTTP conformance 提供（每次升级 pi 必跑）；运行时埋点记录每个 consult 请求的 `cache_read/cache_write`，作为实测证据。只保留一道**廉价且无误报**的发送前检查：在会话打开后、首个 prompt 之前，用与 pi agent loop **完全相同**的函数判定「pi 会不会声明工具变更」，会就 fail closed（§3.2）。
> ③ 嵌套 `ctx.executeTool` 路径：consult 中的任何嵌套调用一律拦截，并用真实的对抗测试覆盖，不再依赖 grep 结论（§3.3-⑤、§8-C4）。
> ④ 工具执行强制改为**顺序执行**，允许的工具在打开会话时**固定身份**（对象 + `execute` 引用 + 冻结），去掉了「检查之后、执行之前」的竞态窗口（§3.3-③④）。
> ⑤ `resume()` 在「会话已创建、守卫安装失败」时的清理契约与测试（§3.2-⑥、§8-C5）。

---

## 0. 结论先行

1. **实证（不变）**：traffic.db 中专家 `r_9A0BJ9JN` 的最后一次请求 #191 与三秒后 consult 首请求 #195，model / thinking / system（32,904 字符逐字节相同）/ 消息历史全部相同，只有工具从 9 个变成 4 个，结果 `cache_read 0`、`cache_creation 54,936`。工具块就是这个场景里唯一的失效因子。
2. **能保证什么（M1）**：在 C2 consult 中，专家工具的 `execute` 永远不会被调用，任何扩展的 `tool_call` handler 也不会收到被禁调用；能执行的只有打开会话时固定身份的 pi 内置 read/grep/find/ls。拦截之前 pi 只运行四步：`tool_execution_start` 通知、按名字查找工具对象、经审计的参数预处理（只可能是 pi 内置 `edit` 的纯函数 `prepareEditArguments`）、schema 校验。四步都不会触碰工具实现（§3.3-①）。**不能保证的**：通知监听器能看到被尝试的工具名和参数。M1 已接受这一点，conformance 用一个真的有副作用的监听器把它锁定为「可观察、不可执行」（§8-C2）。
3. **同一性（M2）**：工具定义与专家最后一次请求逐字节相同的保证，来自三方面：(a) **构造**：内置与扩展工具由同一份 pi / pi-toolkit 代码在 consult 子会话里注册；适配层自有工具的声明直接取自专家会话文件里记录的声明。(b) **发送前廉价检查**：用 `agent-loop.js:231` 那一行一模一样的计算判定 pi 会不会声明工具变更，会就 fail closed（零误报）。(c) **证据**：真实 HTTP conformance 逐字节比对 provider 请求；运行时每个请求记录 `cache_read/cache_write`。system 段、model/thinking、cwd 的差异**不再** fail closed（它们不影响安全，也不是「工具定义」），只记录，并在埋点里表现为缓存未命中。
4. **范围（不变）**：首个交付物 = C2 + 埋点。保活只有在数据满足 §11 的条件后才单独立项。

---

## 1. 背景、裁决与实证

- **用户裁决**：
  - **R1**：保留专家最后一次请求的工具定义（完整定义 + 顺序）逐字节一致，在调用时拦截不允许的工具；**任何情况下都不回退 B**；精确定义无法复现或守卫装不上 ⇒ consult fail closed 并给出明确原因。
  - **R2**：只在追加的 user 消息里声明只读模式、允许的工具、其余工具全部禁用（逐个列出），请根据已有上下文回答。
- **主会话对 R1 的解释裁决（2026-10-10，有约束力）**：
  - **M1（拦截的含义）**：R1 的意图是「专家的工具永远不执行、永远不写」。通知类事件（`tool_execution_start` 及同类）可以观察到被尝试的调用；拦截必须发生在扩展 `tool_call` handler 之前、工具 `execute` 之前。方案必须精确列出拦截前会运行什么，并证明其中没有一项执行工具（§3.3-①）。嵌套 `ctx.executeTool` 路径用测试覆盖，并定义「允许的工具调用 executeTool」时的行为（§3.3-⑤）。
  - **M2（一致性的证明方式）**：不做运行时的字节级 fail-closed 闸门。工具定义靠构造保持一致；真实 HTTP conformance 提供字节级证据，每次升级 pi 都在 `test:conformance` 里跑；运行时埋点记录每个 consult 请求的 cache_read/cache_write，作为实测证据。如果发送前的声明不一致检查既廉价又可靠，可以保留为 fail closed（本方案保留一项，理由见 §3.2）。
- **实证**：§0-1。
- **非目标**：保活 / ping / 账本 / HUD / 成本归属（→ §11）；鉴权头捕获仓（删除）；修改 tidy（`toolDomain:"readonly"`）；运行时的字节级 payload 闸门（M2）。

---

## 2. 现状事实（逐条带出处）

### 2.1 consult 今天的 B 形态（将被 C2 取代）

- `isConsultRun`（`src/service/runtime-adapter.ts:603`）、`readonlyDomain`（`:610`）；H2 之后强制只读工具表（`:880-918`）；enforcer + provenance（`:920-935`；`src/runtime/tool-scope.ts:75, 247-260`；应用点 `src/runtime/runner.ts:915-929, 948`）；注入跳过（`runtime-adapter.ts:676-790`）；prompt 绕过类型前缀（`:980`）；早退 onReaped（`:1070`）。
- consult 派发（`src/consult/tool.ts:735-752`）；fork 新 session id（`src/consult/fork-store.ts:264-271`）；当前 prompt（`src/consult/prompt.ts:33-53`）与测试（`tests/consult/consult-tool.test.ts:583`）；轮次帽（`src/consult/watcher.ts:58-70`）。

### 2.2 pi 1.0.x 的工具执行管线（M1 所需的精确事实）

| 步骤                                                                                                                                                                                                                                                                                                                                                        | 出处                                                                                                            | 说明                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 批次分派：`toolExecution === "sequential"` 或批里有声明为 sequential 的工具 ⇒ 顺序执行，否则并行                                                                                                                                                                                                                                                            | `pi-agent-core/dist/agent-loop.js:366-372`                                                                      | `Agent.toolExecution` 是公开字段，每次 prompt 时读入 loop config（`agent.js:121, 145, 315`）   |
| 顺序模式中每个调用：① `await emit(tool_execution_start{toolCallId, toolName, args})` → ② `prepareToolCall` → ③ 若被拦/出错则立即产生结果，否则 ④ `executePreparedToolCall` → ⑤ `afterToolCall`（`tool_result` handler）→ `tool_execution_end`                                                                                                               | `agent-loop.js:374-409`                                                                                         | 拦截后不会进入 ④                                                                               |
| ① 的去向：AgentSession 把 agent 事件转给扩展 runner 的 `tool_execution_start` 监听器，同时转给会话订阅者                                                                                                                                                                                                                                                    | `pi-coding-agent/dist/core/agent-session.js:921-928`；驱动订阅 `src/runtime/session-driver.ts:799-801`          | 只通知；返回值不影响流程                                                                       |
| ② 内部：按名字找第一个匹配的对象（找不到 ⇒ `Tool X not found`）→ `prepareToolCallArguments` → `validateToolArguments` → `config.beforeToolCall`                                                                                                                                                                                                             | `agent-loop.js:481-512`（查找 `:482`，预处理 `:468-479, 491`，校验 `:492`，钩子 `:493-512`）                    | 我们的拦截在 `:493`                                                                            |
| 被拦结果：`createErrorToolResult(reason)` ⇒ `{content:[{type:"text",text}], details:{}}`，`isError:true`；`terminate` 仅当批内全部结果都带它时生效                                                                                                                                                                                                          | `agent-loop.js:507-512, 634-639, 458-462`；`pi-agent-core/dist/types.d.ts:44-52`                                | 结果形状由 pi 固定                                                                             |
| ④ 才调用 `prepared.tool.execute`；`AgentTool.execute` 在调用时读取 `definition.execute`                                                                                                                                                                                                                                                                     | `agent-loop.js:568-590`（调用在 `:572`）；`pi-coding-agent/dist/core/tools/tool-definition-wrapper.js:2-15`     | 身份固定时要同时固定 `definition.execute`（§3.3-③）                                            |
| `Agent.beforeToolCall` 是公开字段；AgentSession 构造时装一次，内部调用全部扩展的 `tool_call` handler                                                                                                                                                                                                                                                        | `agent.d.ts:48`；`agent.js:105, 133, 316`；`agent-session.js:191, 309-334`；`core/extensions/runner.js:957-970` | 宿主在首个 prompt 前包外层 ⇒ 先于全部扩展 handler                                              |
| 嵌套调用：`ctx.executeTool` → `_executeNestedToolCall` → `runToolCall`，钩子是 `(c) => this._beforeToolCall(c, parentId)`，**不经过** `agent.beforeToolCall`                                                                                                                                                                                                | `agent-session.js:314, 375-404`；`agent-loop.js:559-567`；`core/extensions/runner.js:696-721`                   | 需要单独覆盖（§3.3-⑤）                                                                         |
| 可被嵌套调用的工具 = 活跃的 direct 工具 + 所有已注册的 `codemode`/`deferred` 工具（不必活跃）                                                                                                                                                                                                                                                               | `agent-session.js:1105-1114`                                                                                    | 嵌套路径能触达不在工具块里的工具                                                               |
| pi 声明工具变更的唯一判据：`declareToolChanges` 用 `getToolStateChanges(getCurrentTools(transcript), context.tools.map(toToolDeclaration))`，在 prompt 开始（`:44`）与每个 turn（`:116`）调用                                                                                                                                                               | `agent-loop.js:209-247`（判据在 `:231`）                                                                        | §3.2 的发送前检查逐字复用这一判据                                                              |
| 声明相等 = JSON 化后的 `{name, description, parameters, constrainedSampling?}`；无变更时声明顺序沿用 transcript                                                                                                                                                                                                                                             | `pi-ai/dist/utils/transcript.js:41-58, 106-140`                                                                 | 无变更 ⇒ provider 工具块 = 专家的工具块（折叠模式，`transcript.js:96-103`）                    |
| `prepareLoadout` 钩子可以改写已声明工具的描述、隐藏声明，并能拿到注册表里的 `AgentTool` 对象                                                                                                                                                                                                                                                                | `agent-session.js:1116-1166`                                                                                    | C2 遇到它 fail closed（§3.2-③）                                                                |
| `transformContext`（含强制提示投影）在 `prepareRequest` 之后、provider 调用之前；扩展 `before_provider_request` 抛错会被吞                                                                                                                                                                                                                                  | `agent-loop.js:123-141, 259-270`；`agent-session.js:1310-1328`；`core/extensions/runner.js:1066-1093`           | 运行时不可能在最终字节上 fail closed ⇒ M2                                                      |
| `session.dispose()`：中止进行中的动作、使扩展 runner 失效、断开 agent、清理会话资源                                                                                                                                                                                                                                                                         | `agent-session.js:977-995`；驱动的 handle 封装 `session-driver.ts:491-498`                                      | §3.2-⑥ 的清理契约复用它                                                                        |
| 内置 `edit` 的 `prepareEditArguments`：只就地规整参数对象（把字符串形式的 `edits` 做 `JSON.parse`、单个对象包成数组、兼容旧字段名），没有 I/O                                                                                                                                                                                                               | `pi-coding-agent/dist/core/tools/edit.js:43-75, 91`                                                             | pi 内置工具里唯一的 `prepareArguments`；pi-toolkit 没有任何工具定义它（`src/` 全仓 grep 为空） |
| 本机 consult 子会话里 `tool_execution_start` 的扩展监听器：只有 pi-toolkit 的子会话保活计数（`src/cache-ttl/child.ts:155-158`，内存计数）；另一个已安装包 pi-traffic-record 不监听它（它只注册 `session_start / turn_start / message_end / model_select / before_provider_request / before_provider_headers / after_provider_response / session_shutdown`） | `~/.pi/agent/settings.json` 的 `packages`；`~/ai/pi-traffic-record` 的 `pi.on` 列表                             | 2026-10-10 的事实；第三方扩展的通知监听器属于 M1 接受的「可观察」                              |

### 2.3 已有埋点

`diag.consults: ConsultSummary`（`src/core/types.ts:1023`；`src/core/consult-summary.ts:50-78`）；`classifyConsultToolEnd`（`:129`）、`foldConsultCall`（`:183`）；driver 只对 consult 的 `tool_end` 附带分类（`session-driver.ts:392`）；journal 白名单含 `consults`（`src/core/run-journal.ts:81`）。

---

## 3. C2 设计

### 3.1 专家快照与 consult 会话构造（工具定义「靠构造」一致）

**① 专家快照**（consult 工具在 fork 后、spawn 前计算；`scanExpertSnapshot(forkFile)` 放在 `src/consult/fork-store.ts`，同步、有界、从不抛）：

```ts
interface ExpertRequestSnapshot {
  tools: ToolDeclaration[]; // getCurrentTools(transcript)：专家最后一次请求时的声明
  systemSections: Record<string, string>; // getCurrentSystemMessage(...).sections（只用于埋点）
  model?: { provider: string; id: string }; // 最后一个 model_change
  thinkingLevel?: string; // 最后一个 thinking_level_change
  sourceSessionId: string; // 源文件 header id
  lastRequestUsage?: { input: number; cacheRead: number; cacheWrite: number };
}
```

- 只 JSON 解析含 system 消息、`model_change`、`thinking_level_change`、带 usage 的 assistant 的行（子串预筛），按 transcript 顺序回放后交给 pi-ai 的 `getCurrentTools/getCurrentSystemMessage`（`transcript.js:41-58`）。不另写一套语义。
- 没有 system 消息（pi 1.0 之前的会话）⇒ `identity_mismatch:no-recorded-loadout`；解析失败 ⇒ `identity_mismatch:unreadable-snapshot`。两者都**不 spawn**。
- 经新增的 `SpawnRequest.consultSnapshot`（NOT_THREADED）交给 adapter；prompt 也由同一个快照生成。

**② 会话规格**（替换 `runtime-adapter.ts` 的 B 强制逻辑；tidy 分支不动）：

- `sessionSpec.tools` = 快照工具名集合（不加只读四件）。
- **适配层自有工具**（专家声明过的 `set_model / message_agent / Agent / consult / StructuredOutput`）作为 shadow customTools：`name/description/parameters/constrainedSampling` 逐字段取自快照声明（与专家一字不差）；`promptSnippet/promptGuidelines` 取自同一工厂；`execute` 立即返回拒绝结果（不保留任何原实现）；不设 `prepareArguments`；`Object.freeze`。
- 内置工具与子会话扩展注册的工具（pi-toolkit 的 bash 覆盖、bash_job、switch_context、web_search、Task*、memory；MCP / 第三方）**不重建**：由同一份代码在 consult 子会话里注册，由 §3.2 检查判定是否与快照相同。
- H2 / 扩展额外塞进来的 customTools：沿用 6a 收窄（`runtime-adapter.ts:896-917` 的同款实现），只保留本次创建的 shadow。
- `toolScope`：allow = 快照名，granted = 快照里属于 `RESERVED_TOOL_NAMES` 的名字，不带 provenance。consult 下 enforcer 一旦要剥离（`onBlocked/onShadowed`）就中止 run（`identity_mismatch:enforcer-strip`）——剥离会改变工具块。
- model / thinking：显式传 `modelOverride = snapshot.model ?? ref.model`、`thinkingOverride = snapshot.thinkingLevel`（`types.ts:301`）。
- cwd 规则不变（`tool.ts:707-711`）。cwd 或 AGENTS.md 不同只影响 system 段：**不 fail closed**，只记录（§3.2 末尾、§4）。
- `session.agent.sessionId = snapshot.sourceSessionId`（公开字段，`agent.d.ts:57`；只影响 provider 的缓存关联：OpenAI `prompt_cache_key`、可选的关联头；fork 文件 id 不变）——待 Q5 确认，未确认前不设。

### 3.2 发送前检查（G-preflight）与清理契约

位置：`PiSessionDriver.resume()` 里，`createAgentSession` 解析之后、把 handle 交还给 runner 之前（因此先于 bind 与首个 prompt，`runner.ts:836-866, 935-960`）。新模块 `src/consult/preserve-identity.ts` 承载纯函数部分，conformance 测试**复用同一批函数**（复评 #3）。

**fail closed 项（全部发生在任何 provider 请求之前）**：

| #   | 检查                                                                                                                                | 失败码                                                            | 为什么可靠                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `session.agent` 存在，`beforeToolCall` 是函数，会话实例有 `_beforeToolCall` 方法（嵌套路径的唯一拦截点，§3.3-⑤）                    | `guard_unavailable:agent-hooks` / `nested-hook`                   | 守卫装不上 ⇒ R1                                                                                                                                                                                                                                                                                       |
| 2   | 快照里每个工具名都已注册，`exposure === "direct"`                                                                                   | `identity_mismatch:tool-not-registered:<n>` / `tool-exposure:<n>` | 精确定义无法复现 ⇒ R1                                                                                                                                                                                                                                                                                 |
| 3   | 任何活跃或可被嵌套调用的工具定义都没有 `prepareLoadout`                                                                             | `identity_mismatch:prepare-loadout:<n>`                           | 它能改写声明、隐藏声明，并拿到 `AgentTool` 对象（`agent-session.js:1131-1140`）                                                                                                                                                                                                                       |
| 4   | `ALLOWED = CONSULT_READONLY_TOOLS ∩ 快照名` 中每个名字的 `sourceInfo.source === "builtin"`                                          | `identity_mismatch:readonly-not-builtin:<n>`                      | 安全                                                                                                                                                                                                                                                                                                  |
| 5   | 每个非允许工具的 `prepareArguments` 要么为 `undefined`，要么与 pi 内置 `edit` 定义里的那个引用相等                                  | `identity_mismatch:unaudited-prepare-arguments:<n>`               | M1：拦截前运行的代码必须经过审计                                                                                                                                                                                                                                                                      |
| 6   | **声明变更检查**：`getToolStateChanges(getCurrentTools(session.messages), session.state.tools.map(toToolDeclaration))` 的增删都为空 | `identity_mismatch:tool-definition:<names>`                       | 与 pi 自己的判据（`agent-loop.js:231`）逐字相同 ⇒ **零误报**：非空就意味着 pi 一定会为首个请求声明工具变更，工具块必然与专家不同。一次纯计算，在花钱之前完成。会漏掉的只有 provider 转换层面的差异，由 conformance 兜底。顺序无需单独检查：无变更时声明顺序沿用 transcript（`transcript.js:41-58`）。 |

失败时的**清理契约**（复评 #4）：

```ts
let session: AgentSession | undefined;
try {
  ({ session } = await createAgentSession(...));
  const verdict = preflight(session, spec.consultGuard);       // 纯检查，不改会话
  if (!verdict.ok) throw new ConsultPreserveError(verdict.code); // 消息以 [consult-preserve:<code>] 开头
  installGuard(session, spec.consultGuard);                    // §3.3；失败同样抛 ConsultPreserveError
  return new PiSessionHandle(session, ...);
} catch (e) {
  if (session) disposeOnce(session);  // 同 PiSessionHandle.dispose 的封装（session-driver.ts:491-498），幂等，吞异常
  throw e;
}
```

- 失败由 `resume()` 自己 dispose 后再 reject。runner 的迟到处理只对 resolve 的 handle 起作用（`session-driver.ts:837-839`：`p.then(cb, () => undefined)`），reject 路径没有别人会去清理。
- 如果 runner 的 create 预算已经超时、`resume()` 之后才 resolve：沿用既有的 `onLateArrival → reaper.disposeLate`（`runner.ts:845-851`）。
- runner 走 `startup_failed(session_create)`（`runner.ts:852-864`）；fork 文件照常经 runner 的 `onReaped` 删除（既有路径）。
- consult 工具按错误前缀把结局映射为 `identity_mismatch` / `guard_unavailable`（§3.6）。

**只记录、不 fail closed 的项（M2）**：基础 system 段（`session.systemPrompt` 与快照段的渲染比较，`agent-session.js:1042-1044`）、model、thinking、cwd、强制提示是否存在。它们写进 `identity.predicted`（§4.1）。理由：(a) 不影响安全；(b) 不属于 R1 说的「工具定义」；(c) 段的最终文本在 `transformContext` 之后才确定，运行时判定会误报或漏报；(d) 结果只是缓存未命中，代价与今天的 B 相同。这也意味着 v2 里会被拒的「worktree 已回收的专家」「隔离提问方」「AGENTS.md 改过」现在都能照常 consult（只是读不中缓存）。

**不再有** v2 的 G-request（`prepareRequest` 包装）：它在 `transformContext` 之前，不能证明最终字节（复评 #2，M2）。会话中途的声明漂移由埋点记录（§4.3 每个请求的工具哈希）；安全由 §3.3 的身份固定保证，不依赖它。

### 3.3 安全：拦截点、拦截前运行什么、嵌套路径

**① M1 的精确保证。** 在 C2 consult 中，对一个不允许的工具调用 `X(args)`，pi 1.0.x 依次运行（强制顺序模式，`agent-loop.js:374-409`）：

1. `await emit(tool_execution_start{toolCallId, toolName: "X", args})`（`:377-382`）→ 扩展监听器（`agent-session.js:921-928`）与会话订阅者（驱动的 `mapEvent`）。**只通知**：它们能看到 `X` 和 `args`，返回值被忽略；它们没有工具对象的引用，没有办法调用 `X` 的实现。
2. `currentContext.tools.find(name === "X")`（`:482`）：纯查找。
3. `tool.prepareArguments(args)`（`:468-479, 491`）：只可能是 `undefined`，或 pi 内置 `edit` 的 `prepareEditArguments`（就地规整参数对象，无 I/O，`edit.js:43-75`）。其它任何实现在 G-preflight 第 5 项就已经 fail closed；shadow 工具不带它。
4. `validateToolArguments`（`:492`，pi-ai 的 schema 校验，纯函数）。不通过 ⇒ pi 直接返回校验错误，不执行，也不经过我们的拦截（计入 `disallowedInvalidCalls`）。
5. `config.beforeToolCall`（`:493`）= 我们的包装 ⇒ `{ block: true, reason }`，在调用 AgentSession 原钩子**之前**返回，所以**没有任何扩展 `tool_call` handler 运行**（它们只在原钩子里被调用，`agent-session.js:314-334`），也**到不了** `executePreparedToolCall`（`:568-590`）。

这五步都不会调用 `X.execute`、不会调用 `X` 的 `definition.execute`，也不会让任何扩展「代表 X」执行。M1 接受第 1 步的可观察性；第 3 步由审计限定在 pi 内置纯函数上。

**② 安装**（G-preflight 通过后，同一个 `resume()` 里，首个 prompt 之前）：

- `agent.toolExecution = "sequential"`（公开字段，每次 prompt 读入 loop config，`agent.js:315`）：去掉并行模式下「所有调用先 prepare、再一起 execute」造成的检查到执行之间的窗口（`agent-loop.js:411-458`）。只影响执行顺序，不影响请求字节。
- `agent.beforeToolCall = wrap(original)`：先 `decide`，放行时才调用 `original`（扩展 `tool_call` handler 只在这里面运行）。loop config 在每次 prompt 开始时从字段读取（`agent.js:303-320`），consult 只有一个 prompt，所以 run 中途有人替换该字段也不影响本 run（§8-C4 锁定）。
- 会话实例上的 `_beforeToolCall` 换成同一判定（§3.3-⑤）。

**③ 允许工具的身份固定**（复评 #8）：G-preflight 通过时，对 `ALLOWED` 里的每个名字固定 `{ agentTool: session.state.tools 中的对象, definition: session.getToolDefinition(name), execute: definition.execute }`，并 `Object.freeze(definition)`、`Object.freeze(agentTool)`（这些对象由 pi 为本会话单独创建，`agent-session.js:2815-2826`；pi 刷新注册表时会新建对象而不是原地修改）。`decide` 对允许名字的放行条件是：`context.tools` 中按名字查到的**第一个**对象（与 `agent-loop.js:482` 的查找相同，即将被执行的对象）`=== 固定的 agentTool`，且 `session.getToolDefinition(name) === 固定的 definition`，且 `definition.execute === 固定的 execute`。任何替换、晚注册的同名工具、注册表刷新、原地修改 ⇒ 拦截（文本同 §3.4；内部原因计入 `blockedIdentity`）。代价：consult 中途若发生注册表刷新，允许的工具会在本 consult 剩余时间里都被拦——宁可少答，不可越权。顺序模式下，`decide` 返回到 `execute` 之间没有任何外部代码运行（`agent-loop.js:384-395`）。

**④ 禁用名字**：一律拦截，不论注册方、不论名字是否声明过。覆盖：`StructuredOutput`、`consult`、`Agent`、`message_agent`、`set_model`、`bash_job`、`switch_context`、`bash`、`edit`、`write`、`web_search`、`TaskCreate/TaskList/TaskGet/TaskUpdate/TaskDelete`、`memory`、MCP 与第三方工具、模型编造的名字（后者在第 2 步就是 `Tool X not found`，计入 `unknownToolCalls`）。

**⑤ 嵌套 `ctx.executeTool`**（M1、复评 #5）：

- **定义的行为**：在 C2 consult 中，**任何**嵌套调用都被拦截，不论目标名字（包括 read），也不论发起者是谁。reason：`Nested tool calls are disabled in this read-only consult.` consult 从不需要嵌套调用。
- **实现**：嵌套路径用 `(c) => this._beforeToolCall(c, parentId)`（`agent-session.js:392`），在调用时按实例属性查找。守卫把会话实例的 `_beforeToolCall` 换成：`parentToolCallId !== undefined` ⇒ block；否则走 §3.3-② 的同一个 `decide` 后再调原方法（主路径因此被检查两次，无害）。`_beforeToolCall` 是 pi 的私有成员：G-preflight 第 1 项校验它存在，缺失 ⇒ `guard_unavailable:nested-hook`（fail closed）。conformance 在每次升级 pi 时锁定这一行为。
- **可达性**：只有正在执行的工具能发起嵌套调用；C2 下能执行的只有 §3.3-③ 固定身份的 pi 内置 read/grep/find/ls。conformance 用真实执行加计数器断言它们不会进入 `_executeNestedToolCall`（§8-C4），不再只靠 grep。
- **对抗测试与测试缝隔离（v3.1，复评 #3）**：删除 v3 的 `testAllow` 选项——生产源码里不存在任何「放宽允许集合」的参数。驱动只认一个窄接口 `ConsultGuard`（`preflight(session)`、`install(session)`、`counters()`，定义在 `src/consult/preserve-guard.ts`）；生产实现只有一个工厂 `createConsultGuard(snapshot)`，ALLOWED 恒为 `CONSULT_READONLY_TOOLS ∩ 快照名`且必须是内置工具，签名里没有任何可选项。嵌套拦截（替换实例的 `_beforeToolCall`）由独立导出的 `installNestedCallBlock(session)` 完成，生产工厂内部调用它。对抗测试在 `tests/conformance/fixtures/permissive-guard.ts` 里自己实现一个 `ConsultGuard`：主路径放行夹具工具 `nested_probe`，嵌套路径**直接调用生产的** `installNestedCallBlock`。`nested_probe` 在 `execute` 里调用 `ctx.executeTool("write", …)` 与 `ctx.executeTool("bash", …)` ⇒ 断言两者都被拦、`write/bash` 的 execute 计数为 0、文件系统哨兵不变。这个宽松实现只存在于 `tests/` 下；生产路径触达不到它由 §8-C10 钉住（做法同 web-hub 的 `historyProcFs`：只能经 `HubDeps.spawnSeams` 注入，`main.ts` 从不设置，`tests/web-hub/hub/hub-history-assembly.test.ts:239-260` 钉住「config 键永远到不了 seam」）。

**⑥ 残余面（明确声明，M1 已接受）**：被禁调用的工具名与参数会送达 `tool_execution_start` 监听器（与 B 下模型乱调名字时相同）；pi 内置 `edit` 的参数规整与 schema 校验先于拦截运行。除此之外，被禁工具的任何代码、任何扩展的 `tool_call` handler 都不会运行。

### 3.4 被拦调用的契约（与 v2 相同，补充嵌套情形）

- **结果形状**（pi 固定）：`{ content:[{type:"text", text: reason}], details:{} }`，`isError:true`（`agent-loop.js:507-512, 634-639`）。
- **reason 原文**（英文；只出现工具名，**绝不回显参数**；与 §3.5 的 prompt 共用常量）：`Tool "<name>" is disabled in this read-only consult. Allowed tools: <ALLOWED 逗号分隔，或 "none">. Answer from your existing context<ALLOWED 非空时追加 " or use an allowed tool">.` 嵌套调用用 §3.3-⑤ 的原文。
- **终止规则**：连续第 2 个**全被拦**的批次，其中每个 block 都带 `terminate:true` ⇒ pi 在本批后结束 loop（`agent-loop.js:458-462`），不再发起新的付费请求；结局 `blocked_cap`，最后一条 assistant 消息有文本则作为 partial 返回。第一个全被拦的批次不终止。
- **与轮次/成本帽**：`maxTurns`（默认 3）与 `maxCostUsd` 仍在 turn 开始时判定（`watcher.ts:58-70`）。被拦批次照样算一个 turn；同一批里拦多少个都只算一批。最坏情况额外付费请求 ≤ 1 次。
- **埋点**：`blocked.{calls, batches, terminated, identity, nested, costAfterUsd}`。

### 3.5 consult prompt（R2；只在追加的 user 消息里）

不变（v2 §3.5）：`buildConsultPrompt` 新增 `allowed`、`disabled`（由快照派生，`disabled` 按声明顺序完整列出）；固定英文行（`READ-ONLY CONSULT MODE`、`Allowed tools: …`（空时 `none — answer from your existing context only`）、`Every other tool is disabled and any call to it will be refused: …`、`Do not call disabled tools; each refused call wastes a turn. …`、结论先行与长度上限）；`isMain/budgetNote` 子句保留；golden + system 字节稳定测试锁定它不进 system / 工具描述 / schema。

### 3.6 失败码与 consult 结局

`CONSULT_OUTCOMES`（`src/core/consult-summary.ts:9-21`）只增不改，新增 `identity_mismatch`、`guard_unavailable`、`blocked_cap`。

| 结局                | 来源                                       | 原因码                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity_mismatch` | 快照扫描 / G-preflight 2–6 / enforcer 剥离 | `no-recorded-loadout`、`unreadable-snapshot`、`tool-not-registered:<n>`、`tool-exposure:<n>`、`prepare-loadout:<n>`、`readonly-not-builtin:<n>`、`unaudited-prepare-arguments:<n>`、`tool-definition:<names>`、`enforcer-strip` |
| `guard_unavailable` | G-preflight 1 / 安装失败                   | `agent-hooks`、`nested-hook`、`install-failed`                                                                                                                                                                                  |
| `blocked_cap`       | §3.4 终止规则                              | —                                                                                                                                                                                                                               |

给模型的文本：`Expert "<X>" could not be consulted without changing its tool definitions (<reason>); the consult was refused to keep its read-only guarantee and prompt cache. Fall back to your own investigation.`

### 3.7 范围断裂的明确声明（复评 #7）

- **`"main"` 专家暂不支持 C2**：主会话的工具块含子会话里不存在的宿主工具，强制系统提示含子会话没有的段 ⇒ C2 在构造上不可达。**发布说明与验收标准写明**：「C2 上线后，`experts:["main"]` 的 consult 行为由 Q1 决定；在用户裁决前，main 路径保留现有的只读工具表形态，这是 R1 唯一的、有记录的例外」。若 Q1 = fail closed，只需在 consult 工具里把 main 分支改为返回 `identity_mismatch:main-unsupported`（一行分支 + 一个测试）。不得静默改变语义。
- **发布前置（v3.1，复评 #4）**：**Q1 未裁决不得发布**。验收清单第一项：「Q1 已裁决，所选行为（保留只读形态 / `main-unsupported`）已同时写进验收标准、发布说明与 `tests/consult/consult-tool.test.ts` 的 main 用例」。发版脚本跑之前由主会话核对（`scripts/release/release.sh` 不改，属于流程闸门）。
- **tidy** 不变；**pi 1.0 之前的专家会话** fail closed（`no-recorded-loadout`）；声明过 MCP / 第三方工具而该扩展当前未加载的专家 fail closed（`tool-not-registered`）。

---

## 4. 精确埋点（首个交付物的另一半）

### 4.1 每次 consult 的探针 `ConsultCacheProbe`

定义在 `src/core/consult-summary.ts`（pi-free）；`ConsultSummary += { cacheProbes?: ConsultCacheProbe[] (FIFO 上限 8), blockedCalls?: number, identityFailures?: Record<string, number> }`；`foldConsultCall` 签名不变，`src/core/state-machine.ts` 零改动。

```ts
interface ConsultCacheProbe {
  expertRunId: string;
  outcome: ConsultCallResult;
  identity: {
    preflight: "pass" | `fail:${string}`; // §3.2 fail-closed 项
    predicted?: { system: boolean; model: boolean; thinking: boolean; cwd: boolean; forcedPrompt: boolean }; // 只记录项
    wire?: { system: boolean; tools: boolean; model: boolean; thinking: boolean }; // §4.3（同进程有专家记录时）
    expertTools: number;
  };
  api?: string;
  provider?: string;
  model?: string;
  gapSettleMs?: number; // 专家 settledAt → consult 首请求开始
  gapLastRequestMs?: number; // 专家最后一次请求结束 → consult 首请求开始（有线级记录时）
  expertPrefixTokens?: number; // 快照 lastRequestUsage 的 input+cacheRead+cacheWrite，缺失时用 ref.contextTokens
  prefixSource?: "snapshot-usage" | "context-tokens";
  requests?: Array<{
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    costUsd: number;
    toolsDrift?: true;
  }>; // 每个真实 provider 请求（≤ maxTurns+1 个）；来源见 §4.2，不含保活 ping
  keepalivePingUsd?: number; // diag.usage.costUsd − Σ requests[].costUsd：子会话保活 ping 等非请求花费，单列、不混入
  hitRatio?: number | null; // requests[0].cacheRead / expertPrefixTokens，钳到 [0,1]
  blocked?: {
    calls: number;
    batches: number;
    terminated: boolean;
    identity: number;
    nested: number;
    costAfterUsd: number;
  };
  disallowedInvalidCalls?: number;
  unknownToolCalls?: number;
}
```

### 4.2 采集点（零新 timer）

| 字段                                                         | 来源                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requests[]`                                                 | **宿主侧请求级采集**（§4.3）：驱动对 consult 会话订阅 pi 原生事件，只取 `message_end` 且 `message.role === "assistant"` 的 `message.usage`，按顺序与同一请求的 `Agent.onPayload` 捕获配对。**不**再用 `diag.usage` 的相邻差（理由见下） |
| `expertPrefixTokens`                                         | 快照的 `lastRequestUsage`；缺失时 `ref.contextTokens`                                                                                                                                                                                   |
| `gapSettleMs`                                                | 专家 `settledAt`（`types.ts:924`）：live 快照优先，否则专家索引（`ExpertRecord` 加可选 `settledAt`，`src/consult/expert-index.ts:13-26`）                                                                                               |
| `identity.preflight/predicted`                               | G-preflight 的结果（错误前缀解析 / 驱动在 handle 上附带的只记录项）                                                                                                                                                                     |
| `identity.wire`、`requests[].toolsDrift`、`gapLastRequestMs` | §4.3 前缀探针                                                                                                                                                                                                                           |
| `blocked.*`                                                  | 守卫实例计数（经 wireConsult 按 consult runId 读取）+ `requests[]` 按 turn 归集的用量                                                                                                                                                   |
| `keepalivePingUsd`                                           | 结局时的 `diag.usage.costUsd` 减去 `requests[]` 的成本和                                                                                                                                                                                |

**为什么不从 `diag.usage` 差分（v3.1，复评 #1）**：`cacheTtl.keepalive` 与 `cacheTtl.childKeepalive` 默认都开（`src/config/settings.ts:908, 924`），consult 子会话同样会挂子会话保活（`src/cache-ttl/child.ts:66-117`）。保活 ping 的审计条目 `subagent:cache-keepalive` 被驱动映射成 `{t:"message_end", usage:{input:0, output:0, cacheRead, cacheWrite, costUsd}}`（`src/runtime/session-driver.ts:331-343`），进入同一条累计 `diag.usage`。从累计值差分会把 ping 的读写 token 和费用算到 consult 的模型请求上，污染 `cacheRead/cacheWrite`、`hitRatio`，以及未来保活立项要用的数据。

两种修法比较后选**请求级直采**：

| 方案                                                           | 结论                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在 `diag.usage` 差分时排除 `CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE` | ✗ 驱动映射后的 `message_end` 已不带来源；要区分就得给 `DriverEvent` 加来源标签、让 reducer 分账，触碰热文件 `src/core/types.ts` 与 `src/core/state-machine.ts`（还要同步矩阵/属性测试）。差分还依赖「快照与事件一一对应」，一旦快照被节流或合并就会悄悄出错                                                                                                                                    |
| **宿主侧请求级直采**（选用）                                   | ✓ pi 里每个真实 provider 请求都以一条 assistant 消息的 `message_end` 结束，`message.usage` 就是 provider 返回的用量；保活 ping 是 pi 之外的裸 `fetch`（`src/cache-ttl/ping-client.ts`），只产生 `entry_appended` 自定义条目，**不会**产生 assistant `message_end`。两者在源头就是分开的，不需要标签、不改状态机。`diag.usage` 保持原语义（真实总花费，含 ping），差额单列为 `keepalivePingUsd` |

### 4.3 线级前缀探针（只存哈希）

**位置（v3.1：宿主侧，不再经子会话扩展）**：新模块 `src/consult/prefix-probe.ts`（pi-free：字段规范、哈希、注册表 `Symbol.for("pi-subagent:consult-prefix-probe")`，FIFO 64 个 run）+ 驱动接线（`src/runtime/session-driver.ts` 的 `create()`/`resume()` 在 `createAgentSession` 之后，对所有子 run 生效）：

- **请求体**：给 `session.agent.onPayload`（公开字段，`pi-agent-core/dist/agent.d.ts:45`；sdk 把它设为扩展的 `before_provider_request` 链，`pi-coding-agent/dist/core/sdk.js:213-218, 262`；每次 prompt 读入 loop config，`agent.js:306`）套一层**只读**包装：先 `await` 原函数，按 `PROVIDER_PREFIX_FIELDS` 对其返回值（缺省时为原 payload）计算各字段哈希，再**原样返回原函数的结果**。provider 拿这个返回值作为最终请求参数，只补一个 `stream:true`（`pi-ai/dist/api/anthropic-messages.js:428-432`），所以它就是 provider 可见的 body（序列化之前）。包装不改 payload；原函数抛错照旧抛出。
- **用量**：`session.subscribe` 里取 assistant `message_end` 的 `usage`（§4.2），与最近一次捕获的请求配对。
- **保存**：每个 run 保存「首个」「最新」请求的字段哈希，consult run 保存每个请求。为了不在每次请求上把整段消息逐条哈希，**最新请求**只保留 body 引用，run 结算（`agent_settled` / dispose）时才计算消息前缀哈希并丢弃引用；consult run 的首个请求在发出时立即计算。只存哈希与数字。
- **比较**：consult 工具用 `comparePayloadPrefix(expertLast, consultFirst)` 得到 `identity.wire` 的逐字段结果（同进程有专家记录时）。

**冻结的 provider 可见字段清单 `PROVIDER_PREFIX_FIELDS`**（`src/consult/preserve-identity.ts`；依据 `anthropic-messages.js:858-920` 的 `buildParams`，它产生的顶层字段为 `model / messages / max_tokens / stream / betas / system / temperature / tools / thinking / output_config / metadata / tool_choice / fallbacks`）：

| 字段                                                                           | 比较规则                                                                                                                                                                                | 进入「前缀一致」判定                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `model`                                                                        | 相等                                                                                                                                                                                    | 是                                  |
| `tools`                                                                        | 整个数组深度相等（定义、顺序、最后一个工具上的 `cache_control`、strict / eager 标志）                                                                                                   | 是                                  |
| `system`                                                                       | 整个块数组深度相等（文本 + `cache_control`，含 OAuth 身份块）                                                                                                                           | 是                                  |
| `messages`                                                                     | 设专家最后一次请求有 k 条消息：`consult.messages[0..k-1]` 与 `expert.messages[0..k-1]` 逐条深度相等，比较前去掉内容块上的 `cache_control`                                               | 是                                  |
| 消息断点位置                                                                   | 两边各自列出带 `cache_control` 的（消息下标, 块下标, ttl）；规则：两边都只在各自最后一条 user/tool_result 上有断点，且 ttl 相同（pi 的正常多轮模式，`anthropic-messages.js:1176-1196`） | 是                                  |
| `thinking`、`output_config`                                                    | 相等                                                                                                                                                                                    | 是（thinking 变化会使消息缓存失效） |
| `tool_choice`                                                                  | 相等，或两边都缺省                                                                                                                                                                      | 是                                  |
| `betas` 与请求头 `anthropic-beta`                                              | 相等                                                                                                                                                                                    | 是                                  |
| `temperature`、`metadata`、`fallbacks`                                         | 相等，或两边都缺省                                                                                                                                                                      | 只记录，不进判定                    |
| `max_tokens`、`stream`                                                         | 只记录                                                                                                                                                                                  | 否                                  |
| 请求头里的关联字段（`x-session-affinity` 等，`anthropic-messages.js:787-789`） | 只记录（Q5）                                                                                                                                                                            | 否                                  |
| 鉴权与请求 id 类请求头                                                         | 排除，绝不记录                                                                                                                                                                          | —                                   |
| **清单外的任何顶层字段**                                                       | conformance 直接失败（升级 pi 后出现新字段，必须先补进清单）                                                                                                                            | —                                   |

其它 API（openai-responses / completions）在 v3.1 只记录 `model`、`tools`/`instructions` 的哈希，不做判定；需要时按同样方式另立清单。

### 4.4 分析脚本

`scripts/exp/consult-cache-lib.mjs` + `scripts/exp/consult-cache-analyze.mjs`（`[--dir] [--since] [--until] [--json] [--retro]`），复用 `consult-ab-lib.mjs` 的解析/去重/分位（`:55, 95, 158`）。输出：结局分布（含按原因码分组的 `identity_mismatch`）；`hitRatio` 按 `api × preflight × predicted` 的分布与「预检通过但 `hitRatio<0.5`」个案清单；每个 consult 的逐请求 `cacheRead/cacheWrite`；间隔分桶 `<4.25m / 4.25–15 / 15–45 / >45m`（`--retro` 从历史 `subagent:run` 算出「专家结算 → 消费者派发」）；成本 cold / warm；被拦调用数与 `costAfterUsd`；保活可寻址份额（供 §11）。

---

## 5. 不变量

| 不变量                     | 保证                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 专家工具永不执行（M1）     | 只有身份固定的 pi 内置 read/grep/find/ls 会执行；其余在 `beforeToolCall` 外层被拦，先于任何扩展 `tool_call` handler 与 `execute`；嵌套调用一律拦截（§3.3） |
| 永不回退 B                 | consult 分支没有任何删工具 / 强制只读工具表的路径；守卫或工具定义无法保证 ⇒ fail closed（§3.6）；唯一例外 main 已在 §3.7 明示                              |
| 不改写 payload             | 一致性靠构造；探针只读                                                                                                                                     |
| fail closed 零花费、无泄漏 | G-preflight 在首个 prompt 之前；失败时 `resume()` 自己 dispose 会话（§3.2）；conformance 断言零 HTTP 请求、会话与扩展 runner 已失效                        |
| 零挂死                     | 不新增 timer / await 依赖；守卫同步判定；既有 `totalMs` 硬顶                                                                                               |
| tidy 不变                  | 只读域分支原样保留，测试对比改动前深等                                                                                                                     |
| 无模块级可变状态           | 守卫实例随 run；注册表挂 `Symbol.for`；wireConsult 闭包随栈重建                                                                                            |
| 子会话惰性                 | v3.1 起子会话侧零新增：前缀探针与守卫都在宿主驱动里安装，不碰 HOST_KEY                                                                                     |

---

## 6. 设置

不新增设置（同 v2）：C2 是 consult 唯一的形态；`consult.enabled=false` 仍可整体关闭。终止阈值、探针环/注册表大小是内部常量。埋点无开关。保活设置留给 §11。

---

## 7. 分包与文件域

> **热共享文件**（同一时刻只允许一个包持有）：`src/core/types.ts`、`src/service/request-threading.ts`、`src/service/runtime-adapter.ts`、`src/runtime/session-driver.ts`、`src/stack.ts`；`src/core/state-machine.ts`、`src/config/settings.ts`、`setting-specs.ts`、`src/child/wire.ts` **本方案零改动**（v3.1 把探针挪到了驱动）。
>
> **开工闸门（v3.1，复评 #5，取代 v3 的提醒）**：包 A 开工前必须同时满足：① `git status --porcelain -- src/core/types.ts src/service/request-threading.ts src/core/consult-summary.ts` 输出为空（没有未合并的并行改动）；② 本地 `master` 与 `origin/master` 一致。包 A 合并、`npm run typecheck` 通过之后，才派发包 B/C/D/E；`request-threading.ts` 的穷尽断言（新 `SpawnRequest` 字段不分类就编译失败）是机器侧的第二道闸。包 B/C 的派发 brief 里写明这两条，由主会话核对。

| 包                                     | 内容                                                                                                                                                                                                                                                                         | 文件域                                                                                                                                                                                                                                                  | 依赖                 | 并行                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------- |
| **A 冻结面**（L2，热）                 | `SpawnRequest.consultSnapshot`（NOT_THREADED）；`SessionSpec.consultGuard?: ConsultGuard`（窄接口的实例，由 adapter 调 `createConsultGuard` 构造；不可序列化，不属于 `SpawnRequest`，因此不经 threading/RPC/journal）；`CONSULT_OUTCOMES` 三个新值；`ConsultCacheProbe` 与环 | `src/core/types.ts`、`src/service/request-threading.ts`、`src/core/consult-summary.ts` + 测试；state-machine 属性测试加不变量（只动测试）                                                                                                               | —                    | 先行                            |
| **B 守卫与发送前检查**（L3，安全）     | `preserve-identity.ts`（`preflight`、`toolStateChanges`、`comparePayloadPrefix`，纯函数，conformance 复用）；`preserve-guard.ts`（`decide`、reason 常量、计数、终止规则、身份固定）；`resume()` 里的检查 + 安装 + 清理契约                                                   | 新 `src/consult/preserve-identity.ts`、`src/consult/preserve-guard.ts`；**热** `src/runtime/session-driver.ts`（resume 分支）；测试 `tests/consult/preserve-{identity,guard}.test.ts`、`tests/runtime/session-driver-consult-preserve.test.ts`          | A                    | 与 C 并行                       |
| **C adapter consult 分支**（L3，安全） | allowlist = 快照名、shadow customTools、6a 收窄、toolScope（allow + granted、无 provenance、剥离即中止）、传 `consultGuard`                                                                                                                                                  | **热** `src/service/runtime-adapter.ts`；新 `src/consult/shadow-tools.ts`；`src/runtime/tool-scope.ts`（如需「剥离 ⇒ 中止」策略位）；测试 `tests/service/runtime-adapter-consult.test.ts`（改）、`runtime-adapter-readonly-domain.test.ts`（tidy 不变） | A                    | 与 B 并行                       |
| **D consult 工具与 prompt**（L2）      | 快照扫描、`consultSnapshot` 传递、model/thinking 覆盖、R2 prompt、结局映射、main 分支（§3.7）、探针采集                                                                                                                                                                      | `src/consult/tool.ts`、`src/consult/prompt.ts`、`src/consult/fork-store.ts`、`src/consult/index.ts`、`src/consult/expert-index.ts`；测试 `tests/consult/{consult-tool,fork-store,wire}.test.ts`、新 `tests/consult/prompt.test.ts`                      | A                    | B/C 合并后接线                  |
| **E 前缀探针与请求级用量**（L2）       | §4.2-§4.3：`PROVIDER_PREFIX_FIELDS`、只读 `onPayload` 包装、assistant `message_end` 用量采集                                                                                                                                                                                 | 新 `src/consult/prefix-probe.ts`；**热** `src/runtime/session-driver.ts`（与包 B 串行持有）；测试                                                                                                                                                       | A、B（共用比较函数） | 与 C/D 并行                     |
| **F 分析脚本**（L1）                   | §4.4                                                                                                                                                                                                                                                                         | 新 `scripts/exp/consult-cache-{lib,analyze}.mjs`、`tests/exp/consult-cache-analyze.test.ts`、`tests/fixtures/consult-cache/*.jsonl`                                                                                                                     | A（读形状）          | `--retro` 可最先做              |
| **G conformance**（L3）                | §8-C1..C8                                                                                                                                                                                                                                                                    | 新 `tests/conformance/consult-preserve.test.ts`、`tests/conformance/fixtures/anthropic-stub.ts`                                                                                                                                                         | B+C+D                | 收口闸门，进 `test:conformance` |
| **H 文档收口**（L0）                   | 回写 `docs/dev/consult/plan.md`（附录 A）、AGENTS.md 的 `src/consult/` 条目、发布说明中的 main 范围声明                                                                                                                                                                      | 文档                                                                                                                                                                                                                                                    | G                    | —                               |

---

## 8. 测试计划

**G conformance（真实 pi + provider 边界拦截，`npm run test:conformance`，升级 pi 前必跑）**：本地 HTTP 服务充当 Anthropic 端点（临时 agentDir 的 `models.json` 配一个 `api:"anthropic-messages"`、`baseUrl: http://127.0.0.1:<port>` 的 provider），记录每个请求的原始 body/headers，按脚本返回 SSE（`message_start` 带 usage、`tool_use`、文本）。预占 HOST_KEY，让 pi-toolkit 按子会话加载。测试扩展 `spy` 排在 pi-toolkit **之前**加载。

- **C1 字节级一致（M2 的证据）**：专家会话（类型带 canSpawn、fabric 开、`schema:"verdict/v1"`、`thinkingOverride`、中途一次 set_model、两次 bash）→ fork → 真实 adapter + driver 打开 C2 consult。**输入是 HTTP 端点收到的原始请求**（`JSON.parse(body)` + 原始 headers）。用 `comparePayloadPrefix` 按 `PROVIDER_PREFIX_FIELDS` 逐项断言首请求与专家最后一次请求：`model`、`tools`（完整定义 + 顺序 + 工具上的 cache_control）、`system`（全部块）、`messages[0..k-1]`（去掉 cache_control 后）、消息断点位置与 ttl、`thinking`、`output_config`、`tool_choice`、`betas` 与 `anthropic-beta` 头全部相同；清单外的顶层字段一出现就失败；consult transcript 没有新增 tool-change system 消息。**同时**断言：同一请求上宿主探针（只读 `onPayload` 包装）记录的各字段哈希，等于用原始 body 现算的哈希——把运行时埋点与 provider 实际收到的字节绑在一起。
- **C2 拦截全量 + 可观察残余（M1）**：假模型在一批里调用**每一个**禁用工具（快照名 − ALLOWED），再重复一批 ⇒ 每个都得到 §3.4 原文、`isError:true`、`details:{}`；`spy` 的 `tool_call` 计数 = 0；`spy` 的 `tool_execution_start` 监听器**带有明显副作用**（每次往哨兵文件追加一行）⇒ 断言追加行数 = 调用数（M1 接受的可观察面，被锁定为测试事实），同时断言每个禁用工具的 `execute` 计数为 0、bash/write/edit 的目标文件不变、memory/Task* 状态不变。
- **C3 终止与轮次**：两个连续全被拦批次 ⇒ HTTP 请求数 2、`blocked_cap`；先全被拦再文本作答 ⇒ completed；`maxTurns=3` 配合重复被拦调用时，只在第 4 个 turn 开始时截断。
- **C4 嵌套与替换（M1、复评 #5/#8）**：
  - 真实执行 read/grep/find/ls 时，`session._executeNestedToolCall` 的计数为 0；
  - 测试专用的宽松守卫（`tests/conformance/fixtures/permissive-guard.ts`，嵌套拦截调用生产的 `installNestedCallBlock`）放行夹具 `nested_probe`，它调用 `ctx.executeTool("write"/"bash")` ⇒ 均被拦，目标 execute 计数 0，文件不变；
  - 在 `spy` 的 `tool_execution_start` 里原地替换内置 read 定义的 `execute`（冻结 ⇒ 赋值无效；若用 `defineProperty` 绕过 ⇒ `decide` 的 `execute` 引用比较拦截）；
  - turn1 之后 `spy` 注册同名 `read` ⇒ 之后的 read 调用被拦（`blockedIdentity` +1）；
  - run 中途替换 `agent.beforeToolCall` ⇒ 本 run 行为不变（loop config 已固定）；
  - 一批三个调用（read、bash、read），第二个调用的监听器修改 read 定义 ⇒ 第三个调用被拦，且之后没有任何已准备的调用被执行。
- **C5 fail closed：零请求 + 清理（复评 #4）**：(a) 删掉 `session.agent.beforeToolCall` ⇒ `guard_unavailable:agent-hooks`；(b) 删掉实例的 `_beforeToolCall` ⇒ `nested-hook`；(c) 专家声明过的扩展工具在 consult 时未加载 ⇒ `tool-not-registered`；(d) 带 `prepareArguments` 的第三方工具 ⇒ `unaudited-prepare-arguments`；(e) 带 `prepareLoadout` 的工具 ⇒ `prepare-loadout`；(f) 某个扩展工具的描述在专家结束后变了 ⇒ `tool-definition:<n>`。每种情形都断言：HTTP 请求数 0；`session.dispose` 被调用恰好一次（spy）、扩展 runner 已失效（之后访问 ctx 抛 stale）；对同一会话重复 dispose 无副作用；fork 文件被删除。
- **C6 只记录项不 fail**：专家结束后改 AGENTS.md / 隔离提问方 ⇒ consult 照常进行，`identity.predicted.system=false`，C1 的 system 断言相应地不成立（证明这是缓存问题，不是安全问题），工具块仍逐字节相等。
- **C7 prompt**：最后一条 user 消息与 golden 相同；system 不含 prompt 的任何片段。
- **C8 `agent.sessionId`**（仅 Q5 通过后）：关联字段等于专家 session id；fork 文件 header id 是新的。
- **C9 保活 ping 不污染逐请求用量（v3.1，复评 #1）**：
  - 驱动级（`tests/runtime/session-driver-request-usage.test.ts`，假 AgentSession 事件流）：依次发出 assistant `message_end`（usage A）、`entry_appended`（`subagent:cache-keepalive`，`costUsd>0`、`cacheRead=P`）、assistant `message_end`（usage B）⇒ 记录的 `requests` 恰为 `[A, B]`；同一事件流经 `mapEvent` 后，累计 `diag.usage` = A + ping + B；`keepalivePingUsd` = ping 的费用。
  - 集成级（`tests/integration/consult-request-usage.test.ts`，spawn-service + RuntimeRunner + 假 driver）：consult run 在首请求之后、第二个请求之前注入一条保活审计条目 ⇒ consult 工具结果的 `cacheProbes[0].requests` 只有两个真实请求，`hitRatio` 只用 `requests[0]` 计算，`keepalivePingUsd` 等于注入值。
  - conformance 补充：在 C1 的 consult 中，测试直接驱动 consult 子会话的 `CacheKeepaliveService` 做一次 ping（发往同一个 HTTP 端点、可被识别）⇒ 端点上能看到 3 个请求，`requests[]` 只有 2 个，且与端点上的两个 consult 请求的 usage 一一对应。
- **C10 测试缝不可触达（v3.1，复评 #3；单元 `tests/consult/preserve-guard-seam.test.ts`）**：
  - 源码扫描：`src/` 下实现 `ConsultGuard` 的只有 `createConsultGuard`，它的参数只有快照；`src/` 中不出现 `permissive`、`testAllow`、`extraAllowed` 等标识符；`preserve-guard.ts`、`preserve-identity.ts`、`prefix-probe.ts` 不读 `process.env`；
  - adapter 用例：consult 请求经过 `runtime-adapter` 时，传给驱动的 `SessionSpec.consultGuard` 由 `createConsultGuard` 构造（模块 mock 计数），其 ALLOWED ⊆ `CONSULT_READONLY_TOOLS`；
  - schema / 设置扫描：`AgentToolParams`、嵌套 Agent 参数、consult 工具参数、RPC `SpawnParams`（`additionalProperties:false`，`src/rpc/protocol.ts:15-48`）都不含任何守卫相关键，`consultSnapshot` 也不在任何模型或 RPC 可见的 schema 里；`DEFAULT_SETTINGS` 与设置解析不认识任何守卫相关键（写法同 `hub-history-assembly.test.ts:239-260`）；
  - 类型级：`SessionSpec.consultGuard` 不是 `SpawnRequest` 字段，因此不出现在 `request-threading.ts` 的名单里；`consultSnapshot` 在 NOT_THREADED 里，只有 adapter 读取它。

**单元**：B——`preflight` 每个失败码；`toolStateChanges` 与 `agent-loop.js:231` 的计算在同一组夹具上结果相同；`decide` 真值表（允许名 × 身份三项、禁用名、嵌套）；reason 原文；终止规则；清理契约（`createAgentSession` 成功后检查失败 ⇒ dispose 一次且 reject；dispose 抛错仍 reject 原错误）。C——传给 driver 的 `tools` = 快照名；shadow 的声明与快照逐字段相同、无原 execute 引用、frozen、无 `prepareArguments`；H2 注入被丢弃；tidy 深等不变。D——快照扫描（多次 patch、无 system 消息、坏行、最后一个 model/thinking、usage）；结局映射；main 分支；prompt golden；`consult-tool.test.ts:583` 改为新文本。E——FIFO；只存哈希（序列化注册表后不含 payload 片段）；`onPayload` 包装原样返回原函数的结果（返回值身份相等），原函数抛错照旧抛出；最新请求的 body 引用在结算时被丢弃；`PROVIDER_PREFIX_FIELDS` 每一行规则各一个用例。A——宽松解析、环上限、旧 summary 兼容。F——每个结局、`--retro` 分桶边界。

**收口**：`npm run format:check && npm run typecheck && npm test && npm run build`；G 进 `npm run test:conformance`。

---

## 9. 风险

| #   | 风险                                                                                                                  | 缓解                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| R1  | 通知监听器能观察被禁调用的名字与参数（M1 已接受）                                                                     | §3.3-⑥ 明示；C2 锁定为测试事实；参数不进我们的 reason 文本                                         |
| R2  | 依赖 pi 私有成员 `_beforeToolCall` 覆盖嵌套路径                                                                       | G-preflight 校验存在、缺失即 fail closed；C4/C5 在每次升级 pi 时锁定                               |
| R3  | pi 升级改变 `Agent.beforeToolCall`、`toolExecution` 的读取时机，或注册表对象的创建方式                                | G-preflight 校验；C2/C4 锁定                                                                       |
| R4  | 运行时没有字节级闸门（M2）：provider 转换或强制提示差异会造成未命中                                                   | conformance 字节比对；逐请求 cache_read/write 与线级哈希埋点；分析脚本列出「预检通过但未命中」个案 |
| R5  | 注册表在 consult 中途刷新 ⇒ 允许的工具被拦                                                                            | 宁可少答；`blockedIdentity` 计数                                                                   |
| R6  | 强制顺序执行让多个 read 变慢                                                                                          | consult 很少并发读；顺序换来检查与执行之间没有窗口                                                 |
| R7  | 功能收窄：pi 1.0 之前的会话、未加载的 MCP/第三方工具、带 `prepareLoadout/prepareArguments` 的第三方工具 ⇒ fail closed | 原因码可见；埋点统计拒绝率                                                                         |
| R9  | 宿主侧 `onPayload` 只读包装依赖 sdk 把扩展链装在该字段上（`sdk.js:262`）                                              | 包装只读且原样返回；conformance C1 断言探针哈希 = 原始 body 现算哈希，升级 pi 必跑                 |
| R8  | 首请求成本预检仍按冷写估算，可能过严                                                                                  | 埋点出数后再议（Q4）                                                                               |

---

## 10. 需用户确认

- **Q1（main，发布前必须裁决）**：main 保留现有只读形态作为 R1 唯一例外，还是 fail closed（`main-unsupported`，等于停用 `experts:["main"]`）？未裁决不发布（§3.7）。
- **Q3（终止阈值）**：连续第 2 个全被拦批次终止，是否合适？
- **Q4（成本预检）**：暂按冷写估算，等数据再改？
- **Q5（`agent.sessionId`）**：让 OpenAI 路由复用专家的 `prompt_cache_key`？
- **Q6（允许工具 = 交集）**：确认专家没声明的只读工具在 consult 里也没有？
- （v2 的 Q2 已不再需要：system/cwd 差异不再 fail closed。）

---

## 11. 未来阶段：专家保活（以埋点数据为前提，本次不设计）

不变（v2 §11）：上线 ≥ 4 周且 ≥ 30 次 Anthropic 路由 consult 后，四项条件全部满足才立项：C2 生产有效（预检通过且 `gapSettleMs ≤ 4 min` 时 `hitRatio` 中位数 ≥ 0.6）；可续命（D 间隔 ≤ 4.25 min 的需求窗口 ≥ 50%）；可寻址（`gapSettleMs ∈ (4.25m, 45m]` 且预检通过的 consult ≥ 30%）；净收益按真实路由 / 分层价格 / usage / 计费分支重放，给出实际值与保守上界，保守上界下净节省 ≥ consult 总成本的 20% 且 ≥ $2/周。立项硬约束：不得把带鉴权头的原始请求放进跨 reload 的全局对象。

---

## 12. v2 评审处置表（r_FM5WMV9V，保留）

| #   | 严重度  | v2 处置                                     | v3 状态                                              |
| --- | ------- | ------------------------------------------- | ---------------------------------------------------- |
| 1   | blocker | 采纳：工具集合 = 专家声明，无 B 回退        | 复评确认已解决                                       |
| 2   | blocker | 部分采纳：拦截前移到 `Agent.beforeToolCall` | 由 M1 收口（§3.3-①⑥）                                |
| 3   | blocker | 采纳：每请求 + 每次调用的身份校验           | v3 改为打开会话时固定身份 + 顺序执行（§3.3-③）       |
| 4   | major   | 采纳：prompt / 被拦结果 / 轮次帽            | 复评确认已解决                                       |
| 5   | major   | 采纳：C2 standalone                         | 复评确认已解决                                       |
| 6   | major   | 采纳：真实 HTTP conformance                 | 复评确认方向正确；v3 补 C2/C4/C5                     |
| 7   | major   | 采纳：声明深比较                            | v3 改为与 pi 判据同一函数 + 构造 + conformance（M2） |
| 8   | major   | 采纳：捕获仓移出范围                        | 复评确认                                             |
| 9   | major   | 采纳：经济学移入未来阶段                    | 复评确认                                             |
| 10  | minor   | 采纳：`prompt.ts` 进文件域                  | 复评确认                                             |
| 11  | minor   | 采纳：保活只列立项条件                      | 复评确认                                             |

## 13. v3 复评处置表（r_YAD3SCGC，2 blocker + 4 major + 2 minor）

| #   | 严重度  | 处置                                     | 落点                            | 理由                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------- | ---------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | blocker | **采纳（按主会话裁决 M1 改写安全目标）** | §1 M1、§3.3-①⑥、§5、§9 R1       | pi 1.0.x 的公开钩子无法早于 `tool_execution_start`（`agent-loop.js:377-382`）。v3 不再宣称「拦截前零副作用」，而是逐步列出拦截前运行的五步（通知、查找、经审计的参数规整、schema 校验、我们的钩子），证明没有一步会执行工具；通知的可观察性按 M1 正式接受                                                                                                                                                                  |
| 2   | blocker | **采纳（按 M2 删除运行时字节闸门）**     | §1 M2、§3.2、§4.3、§8-C1        | G-request 在 `transformContext` 之前（`agent-loop.js:123-141, 259-270`），无法证明最终字节，已删除。字节级证据 = 真实 HTTP conformance（升级 pi 必跑）+ 逐请求 cache_read/write 与线级哈希埋点。只保留与 pi 判据（`agent-loop.js:231`）逐字相同、零误报、一次性的工具声明检查，用于 fail closed                                                                                                                            |
| 3   | major   | **部分采纳**                             | §3.2 第 2/3/6 项、§4.3、§7 包 B | 硬闸门覆盖 pi 实际声明给 provider 的部分（`name/description/parameters/constrainedSampling`，与 pi 自己的判据相同），并对 `exposure` 与 `prepareLoadout` fail closed；`promptSnippet/promptGuidelines` 只影响 system 段，按 M2 不设运行时字节闸门，改为记录 + conformance；`annotations` 不进 provider 请求；`execute` 身份属于安全层（§3.3-③）而不是一致性层。运行时与 conformance 共用 `preserve-identity.ts` 的比较函数 |
| 4   | major   | **采纳**                                 | §3.2 清理契约、§8-C5、§8 单元 B | `resume()` 用 `try/catch` 在「会话已创建、检查或安装失败」时自行 dispose 再 reject（runner 的迟到处理只覆盖 resolve 路径，`session-driver.ts:837-839`）；测试覆盖 dispose 恰好一次、扩展 runner 失效、重复 dispose 幂等、fork 文件删除、零 HTTP 请求                                                                                                                                                                       |
| 5   | major   | **采纳**                                 | §3.3-⑤、§3.2 第 1 项、§8-C4     | 嵌套调用一律拦截，通过替换实例的 `_beforeToolCall` 实现（`agent-session.js:314, 392`），存在性由 G-preflight 校验、缺失即 fail closed；用 `testAllow` 夹具真实发起 `ctx.executeTool("write"/"bash")` 做对抗测试，并计数断言内置只读工具从不进入嵌套路径                                                                                                                                                                    |
| 6   | major   | **采纳（按 M1）**                        | §8-C2                           | `spy` 的 `tool_execution_start` 监听器带真实副作用（写哨兵文件）；测试断言副作用发生（被接受的可观察面，形成测试事实），同时断言工具 execute 为 0、无文件变更。M1 已正式接受这一残余                                                                                                                                                                                                                                       |
| 7   | minor   | **采纳**                                 | §3.7、§7 包 H                   | main 作为 R1 唯一的有记录例外写进发布说明与验收标准；Q1 决定后一行分支切换，不静默改变语义                                                                                                                                                                                                                                                                                                                                 |
| 8   | minor   | **采纳**                                 | §3.3-②③、§8-C4                  | 强制顺序执行去掉「检查到执行」的窗口；允许的工具在打开会话时固定 `AgentTool` 对象、定义对象与 `execute` 引用，并冻结；测试覆盖原地修改、晚注册替换、守卫字段被替换、批内中途修改后不再执行后续调用                                                                                                                                                                                                                         |

## 14. v3.1 收口处置表（r_39CZPMJN，有条件通过：0 blocker）

| #   | 严重度               | 处置                     | 落点                                                               | 理由                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------- | ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | major                | **采纳（选请求级直采）** | §4.1 `requests[]` / `keepalivePingUsd`、§4.2 方案比较、§4.3、§8-C9 | 子会话保活默认开启（`settings.ts:908, 924`），其审计条目被映射进累计 `diag.usage`（`session-driver.ts:331-343`）。改为在宿主驱动里只取 assistant `message_end` 的 provider 用量：ping 不会产生 assistant 消息，源头就分开了；不改 `types.ts` / `state-machine.ts`；差额单列 `keepalivePingUsd`。驱动级、集成级、conformance 三层测试 |
| 2   | major                | **采纳**                 | §4.3 `PROVIDER_PREFIX_FIELDS`、§8-C1                               | 冻结 provider 可见字段清单与逐项规则（依据 `anthropic-messages.js:858-920`），清单外字段一出现就失败；conformance 的输入是 HTTP 端点收到的原始 body/headers；运行时探针用同一个纯函数；并断言运行时探针哈希 = 原始 body 现算哈希，把埋点和真实字节绑在一起                                                                           |
| 3   | minor                | **采纳**                 | §3.3-⑤、§7 包 A、§8-C10                                            | 删除 `testAllow`。生产只有 `createConsultGuard(snapshot)`，没有可选项；宽松守卫只存在于 `tests/`；源码扫描、adapter 构造计数、schema / 设置 / env 扫描与类型级检查钉住「生产路径触达不到」，做法同 web-hub `historyProcFs`                                                                                                           |
| 4   | minor                | **采纳**                 | §3.7 发布前置、§10 Q1                                              | Q1 未裁决不得发布；所选行为同时写进验收标准、发布说明与测试                                                                                                                                                                                                                                                                          |
| 5   | minor                | **采纳**                 | §7 开工闸门                                                        | 冻结面文件没有未合并改动、且与 `origin/master` 一致，是包 A 的开工前置；包 A 合并并通过 typecheck 后才派发 B/C/D/E；threading 穷尽断言是机器侧第二道闸                                                                                                                                                                               |
| 6   | （复评「已核查项」） | **采纳**                 | §4.3、§7                                                           | 线级探针从子会话扩展挪到宿主驱动：不再依赖子会话里 pi-toolkit 是否激活，`src/child/wire.ts` 不再改动；探针只读，不改 payload                                                                                                                                                                                                         |

注：复评结论写「6 项」，问题表只列了 5 项；第 6 行是把其「已核查项」中探针的位置与依赖一并收口。

---

## 附录 A：需同步回写 `docs/dev/consult/plan.md` 的更正（包 H）

1. §5.4 / §8 / §12：方案 B 被 C2 取代（R1 + M1/M2）；`consult.expertTools` 旋钮不再规划；main 例外见本方案 §3.7。
2. L68 / L702「1h 实测存活 7–13.6min」⇒「确认 ≥23.2min、≤27.5min 死；早期数字是前缀谱系分裂的误判」（memory `cache-ttl.md`）。
3. L66「thinkingLevel 不持久化」⇒ pi 1.0 会话写 `thinking_level_change`（`sdk.js:278-289`）；C2 从快照读回并显式传入。
4. L790 判定线作废，由本方案 §11 取代。
5. provider 名 `cloudrouter-*` ⇒ 本机现为 `cr-*`。
6. §5.4「工具块在前缀头部」⇒ pi 1.0 的机理是「transcript 里的 tool-change system 消息 + provider 折叠」；实证 traffic.db #191/#195。
