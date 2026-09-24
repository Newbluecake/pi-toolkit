# system prompt 稳定化：动态段改为「稳定 section + 尾部更新消息」

> 状态：实施方案（待评审）· 2026-09-26
> 触发：现场复盘 `docs/dev/cache-ttl-adaptive/field-2026-09-24.md` §5（约 6 次整前缀重写来自 agent 类型 / 记忆变化）
> 用户已拍板：**system prompt 保持稳定，变化以消息形式追加到对话尾部**（不是「会话内冻结，下个会话才生效」）。

---

## 1. 背景与目标

### 1.1 问题

每次 `before_agent_start`（用户消息、子 agent / 后台任务完成通知唤醒）pi-toolkit 都往 system prompt 末尾拼接三段动态内容，
并**返回 `{ systemPrompt }`**：

| 段             | 位置                                                                                                                          | 变化来源                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| agent 类型列表 | `src/index.ts:394` → `appendAgentTypesToSystemPrompt(event.systemPrompt, types.list(), …)`（`src/config/agent-types.ts:249`） | `types.list()` 每轮实时读：增删改 agent `.md`                                                 |
| 可用模型列表   | 同一个 handler → `appendAvailableModelsToSystemPrompt`（`src/config/available-models.ts:121`）                                | `ctx.scopedModels` / `holder.current.models.available()` / `ctx.modelRegistry.getAvailable()` |
| 项目记忆块     | `src/memory/inject.ts` 的 `createMemoryInjectHook`（`src/memory/index.ts:50` 注册，pre-guard）                                | 记忆写入后 `cache.delete(cwd)`，下一轮重新渲染                                                |

system prompt 位于请求**开头**，后面紧跟整段对话。任何一个字节变化 ⇒ 之后所有缓存断点都失效 ⇒ 整段对话按 5m 价全量重写
（现场每次 14–42 万 token，$0.7–2.1）。

### 1.2 调研中发现的关键事实（决定了方案形态）

以下均已从 pi 0.85 的 `.d.ts`、未压缩的 `dist/core/*.js` 和 pi-ai 源码核实：

1. **pi 的 system prompt 是按名字分段的结构**（`dist/core/system-prompt.d.ts`）。`systemPromptOptions.sections: Record<string,string>`
   里是扩展自定义的 section，以 `<name>\n…\n</name>` 包裹后**排在所有内置 section（…/skills/cwd）之后**；名字须匹配
   `/^[a-z][a-z0-9_-]*$/` 且不能叫 `preamble`（`system-prompt.js:7,71`）。内容为空串时该 section 会被跳过（`if (content)`）。
2. **pi 自己会做 section 差量**：`agent-session.js:1025 _preparePromptAndToolLoadout` 用 `diffSystemPromptSections(当前记录里重放出的 sections,
本轮期望的 sections)` 比较，**只有变了**才 `unshift` 一条 `{role:"system", content:"", sections: patch}` 到本轮新消息前面；没变就返回 `undefined`，
   什么都不追加。
3. **返回 `{ systemPrompt }` 是最坏的路径**：它会设置 `forceSystemPrompt`，`_installAgentForcedPromptProjection`（`agent-session.js:1044`）
   在**每次请求**时把所有 system 消息折叠成一个开头消息，内容就是强制文本——强制文本一变，开头就变；同时 pi 自己的 section/工具差量也全部
   被折叠（`transformed.filter(m => m.role !== "system")`）。**这就是现在的行为。**
4. **对话中途的 system 消息只有在 `model.compat.supportsMidConvoSystemMessages === true` 时才原地发送**；否则 pi-ai
   `resolveTranscript → collapseSystemMessages` 会把它折叠回开头消息（`pi-ai/dist/utils/transcript.d.ts`，
   `api/anthropic-messages.js:335,953`）。内置目录里只有部分模型开启（anthropic 的 opus-4-8/opus-5/fable-5、kimi-k2.6/k3、openrouter 的
   gpt-5.4+）。**用户实际使用的路由全是 `~/.pi/agent/models.json` 里的自定义条目**（`cloudrouter-anthropic`、`newapi-aws`、`moonshot` …），
   compat 里都没有这个标志；而且 `dist/core/model-config.d.ts` 的 compat schema 里**根本没有这个字段**（grep 结果为 0）⇒ 在用户的路由上，
   **pi 原生的 section 差量同样会被折叠进开头 ⇒ 仍然整段重写**。
5. **`before_agent_start` 可以返回 `message`**（`BeforeAgentStartEventResult.message`）。runner 会把**所有 handler** 返回的 message 收集成数组
   （`runner.d.ts: BeforeAgentStartCombinedResult.messages[]`），pi 把它们作为 `role:"custom"` 消息**排在本轮用户消息之后**
   （`agent-session.js:1283–1320`），持久化为 `custom_message` 条目，`buildSessionContext` 里转换成 user 消息进入 LLM 上下文
   （`session-manager.d.ts:102`）。不唤醒、不额外起一轮、天然在尾部。
6. `session_start.reason ∈ "startup" | "reload" | "new" | "resume" | "fork"`；有 `session_compact`、`model_select`、`session_tree` 事件；
   `ctx.sessionManager`（只读）提供 `getBranch` / `buildContextEntries`。

### 1.3 目标 / 非目标

- **G1** 两次刷新点之间，pi-toolkit 贡献的 system prompt 字节**严格不变**，与 provider 的 compat 无关。
- **G2** 动态段的真实变化在**下一轮开始时**以一条尾部消息告知模型，明确「以这条为准」；同一内容不重复发送。
- **G3** 只在**本来就会整段失效**的时机刷新快照（不额外付费）；压缩后保持一致。
- **G4** 不再返回 `{ systemPrompt }`，改走 pi 文档推荐的 `systemPromptOptions.sections`。
- 非目标：pi 自身 section（skills、AGENTS.md 上下文文件）的变化（归属 pi）；§5 里剩下「约 8 次无法解释」的重写（需要抓线级载荷，另开任务）；
  让自定义路由开启 `supportsMidConvoSystemMessages`（schema 不支持）。

---

## 2. 现状摘要

```
src/index.ts
 ├─ pre-guard:  wireMemory(pi, {settings.memory, isChildSession})      ← src/memory/index.ts
 │                 └─ pi.on("before_agent_start", createMemoryInjectHook)  → return {systemPrompt: prompt + "\n\n" + block}
 │                 └─ pi.on("session_start", frozenBlocks.clear)
 ├─ HOST_KEY guard（子会话到此为止）
 └─ post-guard: pi.on("before_agent_start", (event, ctx) => {
                  sp = appendAgentTypesToSystemPrompt(event.systemPrompt, types.list(), …)
                  sp = appendAvailableModelsToSystemPrompt(sp, scoped || holder.current?.models.available() || registry)
                  return sp === event.systemPrompt ? undefined : { systemPrompt: sp }
                })
```

- 格式化函数都是纯函数：`formatAgentTypesForPrompt`（agent-types.ts:211）、`formatAvailableModelsForPrompt`（available-models.ts:95）、
  `renderMemoryBlock`（memory/render.ts）。内容稳定：agent 类型按文件名 `readdir().sort()`（agent-types.ts:166）；记忆块不含相对时间，
  排序依据 mtime（mtime 变化即内容变化，是真实变化）。
- 模型来源有**首轮字节差异隐患**：`holder.current.models.available()`（stack.ts:1055 `availableEntries`，总是带 `name/reasoning/contextWindow`）与
  `availableModelsFromRegistry`（`pickEntry`，undefined 字段会被丢掉）字段集合可能不同 ⇒ 首轮（stack 还没建好）和之后的轮次可能渲染出不同字节。
- 测试：`tests/integration/system-prompt-injection.test.ts`（断言返回的 `systemPrompt` 里包含类型/模型段）、`tests/memory/inject.test.ts`、
  `tests/memory/wire.test.ts`、`tests/config/available-models.test.ts`。
- cache-ttl 已经在 `model_select` / `session_compact` / `session_compact_failed` 时调用 `invalidateBoth`（`src/cache-ttl/cache-ttl.ts:272–275`）。

---

## 3. 总体设计

### 3.1 核心思路

> **system prompt 里放「快照」，快照只在免费时机刷新；两次刷新之间的变化走 `before_agent_start` 返回的尾部 custom 消息。**

每个动态段是一个**稳定 section**（`StableSection`），维护三个值：

- `snapshot`：写进 `systemPromptOptions.sections[name]` 的文本（刷新点之间不变）；
- `announced`：模型当前「有效视图」中该段的内容（= snapshot，或最近一条更新消息的内容）；
- `stale`：下一轮是否需要刷新快照。

每轮 `before_agent_start`：计算 `live`（实时内容）→ 交给状态机 → 得到 `{ sectionText, message? }` → 设置 `event.systemPromptOptions.sections[name] = sectionText`，
有 message 就作为 `{ message }` 返回。

### 3.2 模块划分与依赖方向

```
src/prompt-sections/                      （新增；按 stable-section.ts 纯函数 / hub.ts 面向 pi 的约定拆分）
 ├─ stable-section.ts   纯函数：状态机 resolveSection(state, live, visible) → {state', sectionText, message?}
 ├─ update-message.ts   纯函数：渲染更新消息文本 + details；解析自己发出的 custom_message
 └─ hub.ts              面向 pi：createPromptSectionHub(pi, opts) —— 持有全部 section 状态（activate 级闭包），
                        每次 activate 注册一次失效钩子（session_start / session_compact / model_select / session_tree），
                        暴露 apply(event, ctx, name, live) 给各段调用
        ▲                                  ▲
        │ opts.sections                    │
src/memory/index.ts + inject.ts        src/index.ts（post-guard before_agent_start）
（pre-guard；子会话也用）               + src/config/agent-types.ts / available-models.ts（新增 format*/resolve* 导出，去掉 append*）
```

- 依赖方向：`memory` / `index.ts` → `prompt-sections/hub` → `stable-section`、`update-message`（后两者不 import pi）。
- `hub` 在 `src/index.ts` 里 **pre-guard** 创建（activate 闭包内，不放模块级——遵守 /reload 不变量），传给 `wireMemory` 和 post-guard 的 handler。
  子会话在 guard 处 return，但已经拿到 hub 给 memory 用。
- 为什么需要 `hub`：失效钩子（尤其 `session_compact`）必须**每次 activate 只注册一次**、被所有段共享（I7）；各段自己注册会重复且容易漏。

### 3.3 section 名称（新增运行时标识符）

| 段         | section 名           | 渲染后标签                                   |
| ---------- | -------------------- | -------------------------------------------- |
| agent 类型 | `pi_subagent_types`  | `<pi_subagent_types>…</pi_subagent_types>`   |
| 可用模型   | `pi_subagent_models` | `<pi_subagent_models>…</pi_subagent_models>` |
| 项目记忆   | `pi_project_memory`  | `<pi_project_memory>…</pi_project_memory>`   |

段内文本就是现有格式化函数的输出（`## Available subagent types (pi-subagent)…`、`## Memory (<slug>)…` 保持原样），只是外面多了 pi 的标签。
沿用 `pi_subagent` 前缀（符合 AGENTS.md「运行时标识符保留旧名」的约定）。

### 3.4 每轮的数据流

```
before_agent_start(event, ctx)
  memory handler (pre-guard):  live = 冻结块 ?? 缓存/渲染块 ?? ""
                               r = hub.apply(event, ctx, "pi_project_memory", live)
                               return r.message ? { message: r.message } : undefined
  core handler (post-guard):   liveTypes  = formatAgentTypesForPrompt(types.list(), …)
                               liveModels = formatAvailableModelsForPrompt(resolvePromptModels(ctx, holder))
                               r1 = hub.apply(event, ctx, "pi_subagent_types", liveTypes)
                               r2 = hub.apply(event, ctx, "pi_subagent_models", liveModels)
                               return 合并消息(r1, r2)   // 一个 handler 只能返回一条 message → 合并成一条
pi: diffSystemPromptSections(recorded, desired) → 刷新点之间 desired == recorded → 不追加 system delta
pi: messages = [user, ...nextTurn, ...custom(更新消息)]   ← 全在尾部
```

---

## 4. 接口契约

### 4.1 `src/prompt-sections/stable-section.ts`（纯函数）

```ts
export interface SectionState {
  /** undefined = 本会话还没取过快照 */
  snapshot: string | undefined;
  /** 模型有效视图中的内容（snapshot 或最近一条更新消息）；与 snapshot 同时初始化 */
  announced: string | undefined;
  stale: boolean;
}

export const initialSectionState = (): SectionState => ({ snapshot: undefined, announced: undefined, stale: true });

/** 上下文中可见的、本段最近一条更新消息（由 hub 从会话条目中解析；没有则为 undefined） */
export interface VisibleUpdate {
  hash: string;
}

export type SectionUpdateKind = "update" | "removed" | "resync";

export interface SectionResolution {
  state: SectionState;
  /** 写进 systemPromptOptions.sections[name] 的值；"" 表示该 section 不存在 */
  sectionText: string;
  /** 需要发尾部消息时存在 */
  update?: { kind: SectionUpdateKind; content: string; hash: string };
}

export function resolveSection(
  state: SectionState,
  live: string, // "" = 本段此刻没有内容
  visible: () => VisibleUpdate | undefined, // 惰性：只在刷新时调用
  hash: (s: string) => string,
): SectionResolution;
```

**状态机（规范性定义，测试以此为准）**：

```
if state.stale || state.snapshot === undefined:          // 刷新点
    snapshot = live; announced = live; stale = false
    v = visible()
    if v !== undefined && v.hash !== hash(live):          // 上下文里还挂着一条内容过期的旧更新消息
        update = { kind: "resync", content: live }        // 重新声明当前真相，覆盖那条旧消息
    return { sectionText: snapshot, update? }
if live === announced: return { sectionText: snapshot }   // 没变 / 已经通知过 → 去重
announced = live
update = live === "" ? { kind: "removed" } : { kind: "update", content: live }
return { sectionText: snapshot, update }
```

不变量：

- **I1** `sectionText` 只在刷新点那一轮可能改变。
- **I2** 每轮结束后，有效视图（snapshot 被最近一条可见更新覆盖后的结果）== `live`。
- **I3** 对同一段，不会连续发出两条内容相同的更新消息。
- **I4** 永不抛异常：`live` 计算失败 ⇒ 调用方传入 `announced ?? ""`（视为没变），而不是 `""`（那会误报「已移除」）。

### 4.2 `src/prompt-sections/update-message.ts`（纯函数）

```ts
export const SECTION_UPDATE_CUSTOM_TYPE = "subagent:prompt-section-update";

export interface SectionUpdateDetails {
  v: 1;
  section: string; // 如 "pi_subagent_types"
  kind: SectionUpdateKind;
  hash: string; // hash(content)；removed 时为 hash("")
}

/** 把本轮一个或多个 section 的更新渲染成一条消息（一个 handler 只能返回一条 message） */
export function renderSectionUpdateMessage(
  updates: ReadonlyArray<{ section: string } & NonNullable<SectionResolution["update"]>>,
): { customType: string; content: string; display: false; details: { v: 1; updates: SectionUpdateDetails[] } };

/** 从一个 custom_message 条目解析出本类型的 details；不是本类型 / 格式不对时返回 undefined */
export function parseSectionUpdate(entry: unknown): { v: 1; updates: SectionUpdateDetails[] } | undefined;
```

消息正文（英文，与现有 prompt 段风格一致；每个更新一块）：

```
[pi-toolkit] System prompt section update. The content below REPLACES the `<pi_subagent_types>` section of your
system prompt and any earlier update of it; treat it as authoritative until a newer update appears.
<pi_subagent_types>
…完整的新内容…
</pi_subagent_types>
```

`removed`：`… The \`<pi_project_memory>\` section of your system prompt no longer applies; ignore it and any earlier update of it.`

- **发送完整新块，不发差量**：这三段都很小（types 约几 KB、models ≤ 30 行、memory ≤ `byteCap`）；差量需要模型自己在脑子里合并，
  而且被压缩之后很难自洽。完整块 + 标签名和 system prompt 里的 section 一一对应，覆盖语义最清楚。
- `display: false`：它是给模型看的上下文同步，不是用户消息；不注册 renderer（TUI 里不显示，会话文件里可见）。

### 4.3 `src/prompt-sections/hub.ts`（面向 pi）

```ts
export interface PromptSectionHubOpts {
  /** 回滚开关：false ⇒ 每轮 sectionText = live、永不发消息（pi 原生 section 差量；非 capable 路由重写开头）*/
  stable: () => boolean;
  hash?: (s: string) => string; // 默认 sha256 前 16 个 hex 字符（node:crypto）
}

export interface PromptSectionHub {
  /** 在 before_agent_start 内调用：设置 event.systemPromptOptions.sections[name] 并返回待发更新 */
  apply(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
    name: string,
    live: string,
  ): { update?: { section: string } & NonNullable<SectionResolution["update"]> };
  /** 仅测试用 */
  _state(name: string): SectionState | undefined;
}

export function createPromptSectionHub(pi: ExtensionAPI, opts: PromptSectionHubOpts): PromptSectionHub;
```

hub 的职责：

1. `Map<name, SectionState>`（activate 闭包内）。
2. 每次 activate 注册一次失效钩子，把所有段标记为 `stale = true`：
   - `session_start`（任意 reason：startup / reload / new / resume / fork）
   - `session_compact`（包括 `switch_context` / `compact_context` / 阈值自动压缩——它们都走 pi 的压缩流程）
   - `model_select`
   - `session_tree`（切分支后可见的更新消息集合变了）
3. `visible(name)`：从 `ctx.sessionManager.buildContextEntries()`（首选，只包含压缩后仍在上下文里的条目；如果形态不符就退回
   `getBranch()` + 最近一条 compaction 条目的 `firstKeptEntryId` 截断）里找本类型最后一条 custom_message，取其中本段的 `hash`。
   **只在刷新点调用**（冷路径）。任何异常 ⇒ 返回 `undefined`。
4. 设置 section：`event.systemPromptOptions.sections[name] = sectionText`（`""` 时 `delete`，保证 pi 生成 `null` 补丁而不是空标签）。
5. **全程 try/catch，永不抛**；失败时退化为「不设置 section、不发消息」（与现有 fail-open 约定一致）。

### 4.4 各段调用方的修改契约

**`src/config/agent-types.ts`**：保留 `formatAgentTypesForPrompt`；删除 `appendAgentTypesToSystemPrompt`（或暂时标记为 deprecated 仅供测试使用——建议直接删掉，同时改测试）。

**`src/config/available-models.ts`**：删除 `appendAvailableModelsToSystemPrompt`；新增

```ts
/** 渲染提示词用的唯一模型来源；所有分支都经过 pickEntry 归一化，保证首轮与后续轮次字节一致 */
export function resolvePromptModels(
  scoped: readonly ScopedModelLike[] | undefined,
  stackAvailable: (() => readonly AvailableModelEntry[]) | undefined,
  registry: ModelRegistryLike | undefined,
): AvailableModelEntry[];
```

优先级不变（scoped → stack port → registry），但 stack port 分支也要 `.map(pickEntry)`。`ctx.scopedModels` 在会话被替换后可能抛（stack.ts:1077 的注释）⇒ try/catch 视为空。

**`src/index.ts`**（post-guard handler，仍然只负责装配）：

```ts
pi.on("before_agent_start", (event, ctx) => {
  const u1 = sections.apply(event, ctx, "pi_subagent_types", safe(() => formatAgentTypesForPrompt(types.list(), {...})));
  const u2 = sections.apply(event, ctx, "pi_subagent_models", safe(() => formatAvailableModelsForPrompt(resolvePromptModels(...))));
  const updates = [u1.update, u2.update].filter(isDefined);
  return updates.length ? { message: renderSectionUpdateMessage(updates) } : undefined;
});
```

（`safe` 失败时返回 `SKIP` 哨兵，hub 看到哨兵就用 `state.announced ?? ""` 作为 live——对应 I4。为了让 index.ts 保持只做装配，
这段拼装可以抽到 `src/prompt-sections/core-sections.ts` 的 `createCoreSectionsHook(hub, deps)`。）

**`src/memory/inject.ts`**：签名改为

```ts
export interface MemoryInjectDeps { …现有字段…; sections: PromptSectionHub }
// handler 不再返回 systemPrompt；
// live = 冻结块 ?? 渲染块 ?? ""；
// 兼容检查：event.systemPrompt 里已有原插件的 `## Memory (<slug>)` 横幅 ⇒ live = ""（不和它重复注入）；
// 自家哨兵检查不再需要（section 按名字替换，天然幂等）——但哨兵仍保留在块文本里，给压缩摘要/外部工具识别用。
return r.update ? { message: renderSectionUpdateMessage([r.update]) } : undefined;
```

`freezeInjectionAfterWrite` 语义保留：为 true 时 live 取冻结块 ⇒ 写入后不会发更新消息（等于旧的「下个会话生效」）；
默认 false ⇒ 写入后下一轮发一条尾部更新。

**`src/config/settings.ts`**：新增 `systemPrompt: { stableSections: boolean }`，默认 `true`（回滚开关）。遵循现有 settings 解析/默认值/TUI 编辑器约定；
在 `src/ui/` 的设置编辑器里加一行（可选，P2）。

### 4.5 错误约定

| 情况                                                         | 行为                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| 格式化 / 读取注册表抛错                                      | 本段 live 视为「未变」（I4），不发消息，section 保持快照            |
| `sessionManager` 读取失败                                    | `visible() = undefined`（刷新时不发 resync）                        |
| section 名不合法（pi 会在 `buildSystemPromptSections` 里抛） | 名字是常量，由单元测试守护；不做运行时校验                          |
| 其它扩展返回了 `{ systemPrompt }`                            | 那轮强制投影会覆盖一切（pi 行为）——不在本方案处理范围，记录在风险里 |

---

## 5. 关键决策

### D1 用 `systemPromptOptions.sections`，不再返回 `{ systemPrompt }`

- 强制 prompt 会让每次请求都把**所有** system 消息折叠进开头（事实 3）：连 pi 自己的工具/section 差量都失效，会话里任何 setActiveTools 都变成
  整段重写。
- section 按名字替换，pi 负责 diff、记录和压缩后的重放；我们的段有了名字，更新消息才能精确地说「替换 `<pi_subagent_types>`」。
- 多个 handler 各改各的 key，与注册顺序无关（现在 memory 依赖 `event.systemPrompt` 字符串拼接，顺序敏感）。
- 代价：上线后每个已有会话的第一轮会多出一次 section 补丁（一次性）。

### D2 光靠 pi 原生 section 差量**不够**，还需要快照 + 尾部消息

pi 的差量是一条 system 消息；在不支持中途 system 消息的模型上会被折叠回开头（事实 4）。用户的全部路由都属于这种情况，
而且 models.json 无法开启这个标志。所以「刷新点之间 section 字节不变」必须由我们自己保证，变化只能走普通对话消息
（custom → user 角色，任何 provider 都原地发送）。

**被否决的备选**：按 `ctx.model.compat.supportsMidConvoSystemMessages` 分支（capable 模型直接用实时 section，交给 pi 差量）。
收益为零（在 capable 模型上两种做法都只影响尾部），却让测试矩阵翻倍，还要处理切换模型时的策略切换。作为扩展点保留（§8）。

### D3 注入方式：`before_agent_start` 返回 `message`，不用 `pi.sendMessage`

| 备选                                      | 否决理由                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sendMessage(..., { triggerTurn: true })` | 会唤醒空闲的主会话、额外起一轮——明确禁止                                                                                                                           |
| `deliverAs: "steer"` / `"followUp"`       | 要在变化发生时（例如 memory 工具写入的回调里）主动推送：需要为每个变化源分别挂钩子，且会插进正在进行的 run；多次变化无法合并                                       |
| `deliverAs: "nextTurn"`                   | 可行但同样是推模式：变化可能在下一轮之前又变回去（发出无意义的消息），而且和刷新点的交互（刷新后已排队的 nextTurn 变成过期内容）要额外处理                         |
| **返回 `{ message }`（选中）**            | 拉模式：只在本来就要开始的一轮里比较 live 与 announced；天然防抖（N 次变化 → 1 条消息）；同一代码路径决定 section 和消息，不可能不一致；位置固定在本轮用户消息之后 |

已知取舍：一次 run 内部（多轮工具循环中）发生的变化要到**下一次** `before_agent_start` 才通知。这类变化基本都是模型自己造成的
（写记忆、编辑 agent `.md`），模型本来就知道。

### D4 刷新点 = 本来就会失效的时机

| 刷新点                                     | 为什么免费                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`（startup/new/resume/fork） | 新会话或冷启动恢复：没有可复用的对话缓存（resume 的会话通常早已过期）                                                                                                                  |
| `session_start`（reload）                  | 用户建议的刷新点；/reload 会重新激活扩展、重新加载 skills/上下文文件，现场观察到开头本来就会变（field-2026-09-24 §5 表中「reload」一行）；cache-ttl 的 adaptive 状态也在 reload 时重置 |
| `session_compact`                          | 压缩后对话 = 摘要 + 保留段，是新字节，本来就要写一遍；section 变化只多花开头那部分（tools+system，约 1–2 万 token）                                                                    |
| `model_select`                             | 换模型 = 换缓存命名空间，全部未命中                                                                                                                                                    |
| `session_tree`                             | 切分支：分支点之后的内容不同；分支之间可见的更新消息集合也不同，必须重新对账                                                                                                           |

**被否决**：「缓存已冷时顺便刷新」（空闲 > TTL 且保活没有命中）。确实免费，但需要读取 cache-ttl 的内部状态（`provenCacheReadAt` 等），
会形成新的跨模块耦合，而且判断错误会直接付出整段重写。列为扩展点。

### D5 发完整块，并用 `resync` 处理遗留消息

在 reload / 带 `keep_recent` 的压缩 / 切分支之后，上下文里可能还挂着一条**比新快照旧**的更新消息，而且它的位置比 system prompt 更「新」，
会误导模型。刷新时对账一次（`visible().hash !== hash(live)` ⇒ 发一条 `resync`），让最近一条可见声明总是等于当前真相。
这一步只在刷新点执行（冷路径），读的是我们自己写的 custom_message 条目，不依赖 pi 内部格式。

### D6 子会话：同一套机制，不做特殊处理

memory 在 pre-guard 注册，子会话也会注入（`injectInChildSessions`）。子会话生命周期短，默认只读（`allowWriteInChildSessions` 默认关闭），
所以记忆在子会话里只有在父会话/兄弟会话写入时才会变——很少见。保持「现状」的最干净形式就是**走同一个 hub**：子会话的 activate 在 guard 之前
创建自己的 hub，行为完全一致，无需任何分支。子会话以 `systemPromptOverride`（promptMode=replace）替换的是基础 prompt（`customPrompt`/preamble），
自定义 section 照常追加——需要在实施时用集成测试确认（§6.3 R4）。

---

## 6. 原任务七个问题的逐条回答

1. **稳定快照**：每个段在本会话第一次 `before_agent_start` 时取快照（不在 `session_start` 取：那时 stack/注册表可能还没就绪，
   正是现在模型来源需要 registry 兜底的原因）。`session_start`（任意 reason，含 reload）、`session_compact`、`model_select`、`session_tree`
   把状态标为 stale，下一轮重新取快照。理由见 D4。
2. **变化消息**：`before_agent_start` 返回 `{ message: { customType: "subagent:prompt-section-update", display: false, content, details } }`；
   不用 sendMessage，不用 triggerTurn（D3）。内容是完整新块 + 覆盖声明（§4.2）。去重靠 `announced`（I3）；reload 后靠 `resync` 对账（D5）。
3. **压缩后的一致性**：`session_compact` ⇒ stale ⇒ 下一轮（包括 pi 在 `emitBeforeAgentStart` 之前做的自动压缩——`agent-session.js` 在同一个 prompt
   流程里先 `_checkCompaction` 再 emit）snapshot = announced = live。论证：刷新后 section 本身就是真相（I2 在不依赖任何压缩前消息的情况下成立）；
   被摘要掉的更新消息不再需要；如果 `keep_recent` 保留了一条旧的更新消息且内容 ≠ live，刷新时的 `resync` 会在它之后重新声明。
   压缩摘要里可能转述旧内容——摘要是对话内容，覆盖声明的优先级（「treat as authoritative」）加上 section 本身就能纠正；这与压缩后任何事实变化的处理方式相同。
   另外，pi 在刷新那一轮会追加一个 section 补丁（非 capable 路由折叠进开头）——这就是 D4 所说「只多花开头那部分」的代价。
4. **子会话**：同一套机制，无需特殊处理（D6）。
5. **模型列表会不会抖**：会，但都是真实变化，而且很少：`ctx.scopedModels` 是实时 getter（会话中途在 `/models` 里改 scope 立即生效）；
   `getAvailable()` 按认证过滤（/login、/logout、token 失效）、models.json 在打开 `/model` 时重新加载、`pi update --models` 的目录覆盖。
   quota 模块**不**过滤这个列表（gate 用的是单独的 `recommendable`）。快照机制同样覆盖：刷新点之间只发尾部更新。
   另有一个**伪抖动**必须修掉：首轮 registry 兜底和后续 stack port 的字段集合不同（§2）⇒ `resolvePromptModels` 统一走 `pickEntry`。
6. **文件清单 / 测试 / 顺序 / 风险**：见 §7、§8。
7. **与 cache-ttl 的交互**：见 §7.4。

---

## 7. 实施要点

### 7.1 文件级改动清单

| 文件                                    | 改动                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/prompt-sections/stable-section.ts` | **新增**，纯状态机（§4.1）                                                                                                                               |
| `src/prompt-sections/update-message.ts` | **新增**，渲染/解析（§4.2）                                                                                                                              |
| `src/prompt-sections/hub.ts`            | **新增**，失效钩子 + apply + visible（§4.3）                                                                                                             |
| `src/prompt-sections/core-sections.ts`  | **新增**（可选），types/models 的 before_agent_start 拼装，保持 index.ts 只做装配                                                                        |
| `src/index.ts`                          | pre-guard 创建 hub；传给 `wireMemory`；post-guard handler 换成 `createCoreSectionsHook`；删除 `append*` 的导入                                           |
| `src/memory/index.ts`                   | `WireMemoryOpts` 增加 `sections: PromptSectionHub`，透传给 inject                                                                                        |
| `src/memory/inject.ts`                  | 改为 hub.apply + 返回 message；去掉 `{systemPrompt}` 返回；保留原插件横幅兼容检查                                                                        |
| `src/config/agent-types.ts`             | 删除 `appendAgentTypesToSystemPrompt`（`formatAgentTypesForPrompt` 不变）                                                                                |
| `src/config/available-models.ts`        | 删除 `appendAvailableModelsToSystemPrompt`；新增 `resolvePromptModels`（统一 pickEntry）                                                                 |
| `src/config/settings.ts`                | `systemPrompt.stableSections`（默认 true）+ 解析/默认值                                                                                                  |
| `src/adapters/pi-compat.ts`             | 登记新依赖的 pi 行为假设：`systemPromptOptions.sections` 可变且会被 diff；`before_agent_start` 的 message 排在用户消息之后；`buildContextEntries` 的形态 |
| `AGENTS.md`                             | 布局一节加 `src/prompt-sections/` 一行                                                                                                                   |
| `docs/dev/memory/memory-plan.md`        | §5.2 注入方式注记「已改为 section + 尾部更新，见 sysprompt-stable」                                                                                      |

### 7.2 测试锚点

**单元（纯函数）** `tests/prompt-sections/stable-section.test.ts`

- 首轮：snapshot = live，无消息。
- live 不变 N 轮：sectionText 字节不变，无消息。
- live 变为 B：sectionText 仍是 A，发一条 update(B)；再来一轮 B：无消息（I3）；变回 A：发 update(A)。
- live 变为 ""：发 `removed`；section 仍是 A。
- stale 刷新，visible 为 undefined：sectionText = live，无消息。
- stale 刷新，visible.hash ≠ hash(live)：发 `resync`；visible.hash == hash(live)：无消息。
- **性质测试**（沿用仓库里带种子的 property 测试风格）：随机序列 {改 live, 开始一轮, compact, model_select, reload, tree} ⇒ 断言 I1（sectionText
  只在刷新后的第一轮变）、I2（有效视图 == live）、I3（不连发相同内容）。

`tests/prompt-sections/update-message.test.ts`：渲染包含对应标签名和覆盖声明；多个更新合并成一条；`parseSectionUpdate` 能往返解析，并拒绝其它 customType / 错误的 `v`。

`tests/prompt-sections/hub.test.ts`（fake pi）

- 每次 activate 失效钩子只注册一次；四种事件都会把所有段标为 stale。
- `apply` 会写/删 `event.systemPromptOptions.sections[name]`，**永远不**返回 `systemPrompt`。
- `stableSections=false`：sectionText = live，从不发消息。
- sessionManager 抛错 ⇒ 无 resync、不抛。

**集成** `tests/integration/system-prompt-injection.test.ts`（改写）

- 断言：handler 结果里没有 `systemPrompt`；`systemPromptOptions.sections.pi_subagent_types` / `pi_subagent_models` 存在，且内容与以前的段文本一致。
- 两轮之间往 agents 目录新增一个 `.md` 文件：第二轮 **sections 对象与第一轮字节相等**，返回的 message 里包含新类型；第三轮无消息。
- 触发 `session_compact` 后的一轮：sections 更新为包含新类型的内容，没有消息（上下文里没有可见的旧更新）。
- 模型首轮兜底（`holder.current` 为空）与后续轮次（stack port）渲染出的模型段**字节相等**。

`tests/memory/inject.test.ts` / `wire.test.ts`（改写）

- 写入后下一轮：`pi_project_memory` 字节不变，message 带新块；再下一轮无消息。
- `freezeInjectionAfterWrite=true`：写入后无消息。
- 子会话且 `injectInChildSessions=false`：不设置 section、不发消息。
- 存在原插件横幅：不设置 section。

**回归护栏**：一个静态/集成断言——对 activate 注册的所有 `before_agent_start` handler 喂同一个事件，没有一个返回 `systemPrompt`（防止以后又有人走回强制 prompt 的路）。

### 7.3 实施顺序

1. `stable-section.ts` + `update-message.ts` + 单测/性质测试（纯函数，无依赖）。
2. `hub.ts` + 单测；`settings.ts` 开关。
3. `available-models.ts` 的 `resolvePromptModels`（先修伪抖动，这一步单独也有价值）。
4. 迁移 core handler（types + models）→ 改写集成测试。
5. 迁移 memory inject → 改写 memory 测试。
6. 删除 `append*`，`pi-compat.ts` 登记假设，更新文档。
7. 手工验证（必须）：开启 `/record on`，在 `cloudrouter-anthropic` 上执行「写一条记忆 → 下一轮」「新增 agent `.md` → 下一轮」，确认
   请求的 `system` 字节不变、`cache_read` ≈ 上一次前缀、更新消息位于最后一条 user 消息之后；再执行一次 `/compact`，确认刷新后的 section 生效。

四个 CI 门禁（format:check → typecheck → test → build）每一步都要保持绿色。

### 7.4 与 cache-ttl keepalive / adaptive 的交互

- **keepalive**（`ping-client.ts`：除 `max_tokens` 外逐字节回放上一次捕获的请求）：开头稳定之后，ping 续期的前缀**仍然是下一次请求的有效前缀**；
  下一次请求只在尾部追加（用户消息 + 可能的更新消息）。以前一旦段落变化，保活花的钱就白付了；现在不会。回放载荷里如果包含上一轮的更新消息也无妨——那只是
  前缀的一部分。
- **adaptive**：刷新点（`model_select`、`session_compact`、reload）与 cache-ttl 已有的 `invalidateBoth` 时机（cache-ttl.ts:272–275）以及 reload 时的状态
  重置**完全重合**，所以不会产生新的「没有信号的冷启动」。更新消息只是给 Δ 增加几 KB，落在现有 `delta-too-large` / 尾巴 + Δ 的判断范围内。
  不改变前缀 ⇒ 不会触发额外的 1h 命名空间重写（参见 plan §16.3 / §18）。
- 预期收益：field-2026-09-24 §5 表中「写了记忆 / 增删了 agent 类型」约 6 次整前缀重写（每次 $0.7–2.1）变成尾部写入（每次几 KB）。
  「改了 skill」属于 pi 自身的 `skills` section，不在本方案范围内（非 capable 路由上仍会重写开头）。

---

## 8. 风险与扩展点

| #   | 风险                                                                                             | 应对                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 依赖 pi 未写进文档的行为（section diff、message 排在用户消息之后、`buildContextEntries` 的形态） | 登记到 `pi-compat.ts`；集成测试覆盖；peer 依赖升级时复查                                                                          |
| R2  | 模型更信 system prompt 而不是后面的 user 角色消息                                                | 覆盖声明写明「REPLACES … authoritative」，标签名一一对应；刷新点会把真相写回 section，影响只持续到下一个刷新点                    |
| R3  | 长会话里频繁变化导致更新消息堆积                                                                 | 每次真实变化最多一条，而且变化本身很少；如果观察到问题，可加「单段更新达到 N 条后在下一个刷新点前不再合并」之类的上限（暂不实现） |
| R4  | 子会话 promptMode=replace 时 custom section 的表现                                               | 集成测试确认 section 仍然追加；不成立的话子会话退回 live 模式（`stable` 对子会话返回 false）                                      |
| R5  | 其它扩展返回 `{ systemPrompt }` 会触发强制投影，把我们的保证全部抵消                             | 无法控制；在 AGENTS.md 里注明，本仓库内由回归护栏保证                                                                             |
| R6  | 上线后已有会话第一轮会多一次 section 补丁                                                        | 一次性成本，可接受                                                                                                                |
| R7  | memory 的 mtime 排序：只 touch 文件也会被视为变化                                                | 这是真实的渲染变化，只产生一条尾部消息，可接受                                                                                    |

**扩展点（本次不实现）**

- E1 缓存已冷时顺便刷新（需要 cache-ttl 暴露只读的 `isPrefixCold()` 端口）。
- E2 capable 模型（`supportsMidConvoSystemMessages`）直接用实时 section，省掉更新消息。
- E3 把同样的机制用于其它每轮动态内容（如果以后新增）：只需要调用 `hub.apply` 并注册一个新的 section 名。
