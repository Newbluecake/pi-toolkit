# 集成点地图 — Quota-Aware Dispatch (`src/quota/`)

事实性盘点，供 `docs/dev/quota/quota-plan.md` 与后续开发包直接引用。所有行号基于当前 `master` HEAD（读取时刻）。

---

## 1. compact-hint turn_end 钩子接线

**接线点**：`src/index.ts:200-208`

```ts
const handoffStore = new PendingHandoffStore();
pi.on(
  "turn_end",
  createCompactHintHook(holder, {
    sendMessage: (message, options) => pi.sendMessage(message, options),
    sendUserMessage: (text) => pi.sendUserMessage(text),
    handoffPending: () => handoffStore.hasFresh(),
  }),
);
```

- `createCompactHintHook` 定义在 **`src/stack.ts:512`**（不是 `src/compact-hint/`，那个目录只放纯函数：`pi-settings.ts` + `threshold.ts`）。签名：

```ts
export function createCompactHintHook(
  holder: { current?: Stack },
  deps: {
    sendMessage: (
      message: { customType: string; content: string; display: boolean; details: unknown },
      options: { triggerTurn: false },
    ) => void;
    now?: () => number;
    sendUserMessage?: (text: string) => void;
    handoffPending?: () => boolean;
  },
): (event: unknown, ctx: ExtensionContext) => void;
```

- **`sendMessage` options 形态**：只有 `{ triggerTurn: false }`，**没有** `quiet`/`channel` 字段。所有 hint/tick/force 消息都是 `display: true`，用户和模型看到同一条。`triggerTurn` 恒为 `false`（不主动开新回合，等下一次自然 turn）。
- **`sendUserMessage` 何时用**：仅在 force-compact 成功后的 `ctx.compact({ onComplete })` 回调里，发 `RESUME_TEXT`（`src/tools/compact-tool.ts` 导出）催促模型继续任务（`stack.ts:706-711` 附近）。
- **guard**：`if (ctx.mode === "print" || ctx.mode === "json") return;`（stack.ts:559）——非交互模式直接跳过，quota 注入层如果复用这个钩子模式也要照抄。
- **阶梯（非线性格点）**：`src/compact-hint/threshold.ts:41-60` `usageTickMarks(step, ceiling)` —— 远离天花板用固定 `step` 步长，`ceiling - 2*step` 以内改用 `step/2`，再靠近改用 `step/5`；`usageTickStep(percent, step, ceiling)`（同文件 63-72 行）取 ≤ percent 的最高格点。quota 阶梯（50/75/90）如果要做"越接近耗尽提醒越密"的效果，直接复用这两个函数或抄同一套逻辑。
- **消息去重/防噪音**：`CompactHintState.hintedAt`/`lastHintAt`/`lastTickStep` 三个字段（stack.ts:~305-330）+ `COMPACT_HINT_COOLDOWN_MS = 600_000`（threshold.ts:5）。tick 用 `lastTickStep` latch，只有真实下降超过 `USAGE_TICK_HYSTERESIS_PERCENT=5` 才回落（threshold.ts:15-17,68-71）——quota 的"降位标记持续携带直到窗口重置"可以照这个 latch 思路实现（不同处：quota 要跨会话/跨 turn 持久化，而 compact-hint 的 state 只活在单 session 的 `Stack` 里，见下）。

---

## 2. pi 事件面（`pi.on` 全量清单，从 src/ 归纳）

grep `pi\.on\("` 命中的事件名（全仓库）：

| 事件                                                  | 出现文件                                                                                   | payload 形状线索                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_start`                                       | index.ts, stack.ts(通过index调), hud, memory, todo, reload, cache-ttl, feishu, session-nav | `(event, ctx: ExtensionContext)`；`ctx.sessionManager`/`ctx.cwd`/`ctx.mode`/`ctx.hasUI`/`ctx.ui`/`ctx.modelRegistry`/`ctx.scopedModels` 都在此刻才可用 |
| `session_shutdown`                                    | index.ts, hud, memory-adjacent, reload, feishu                                             | `(event)`，`event.reason`（`"quit"` 等，见 `killBashJobsBounded` 调用点）                                                                              |
| `session_tree`                                        | hud, todo, cache-ttl                                                                       | `(_event, ctx)`；`ctx.sessionManager.getBranch()`                                                                                                      |
| `session_compact` / `session_compact_failed`          | todo, cache-ttl, index.ts(switchTool分支)                                                  | 无强 payload 依赖，多数只用来触发 invalidate/clear                                                                                                     |
| `session_before_compact`                              | index.ts:337 附近（`createSwitchContextCompactHook`）                                      | 返回 `{ compaction }` 覆盖 pi 自己的摘要器（见 §3 邻近机制，context-switch/hook.ts）                                                                   |
| `turn_start` / `turn_end`                             | hud, feishu, index.ts(compact-hint)                                                        | `(_event, ctx)`；`ctx.getContextUsage()` 返回 `{ percent, contextWindow, tokens }`（compact-hint 钩子重度依赖，stack.ts:571）                          |
| `before_agent_start`                                  | index.ts:371, memory/inject.ts, feishu-notify                                              | `(event: BeforeAgentStartEvent, ctx)`；`event.systemPrompt`、`event.systemPromptOptions?.cwd`；返回值可选 `{ systemPrompt }` 覆盖                      |
| `agent_start` / `agent_end` / `agent_settled`         | feishu, cache-ttl, index.ts(goal), hud                                                     | `agent_end`/`agent_settled` 无消息载荷（pi-compat.ts 注释：assumption #3），`agent_settled` 是"无 retry/压缩/续跑待决"的唯一信号                       |
| `message_start` / `message_update` / `message_end`    | index.ts(通知回执), hud, cache-ttl                                                         | `event.message.role`（"user"/"assistant"/"custom"/"toolResult"）、`event.message.usage?.output`、`event.message.customType`/`details`                  |
| `tool_execution_start` / `tool_execution_end`         | hud, cache-ttl, feishu                                                                     | `event.toolName`、`event.isError`                                                                                                                      |
| `model_select` / `thinking_level_select`              | cache-ttl                                                                                  | `(_event, ctx)`，触发 cache invalidate                                                                                                                 |
| `resources_discover` / `session_info_changed`         | cache-ttl                                                                                  | 同上，invalidate 触发器                                                                                                                                |
| `before_provider_request` / `before_provider_headers` | cache-ttl                                                                                  | provider 请求前拦截点（TTL 头注入用）                                                                                                                  |
| `input`                                               | feishu-notify, session-nav, mention/mention.ts                                             | `InputEvent` → 可返回 `InputEventResult`（编辑器改写路径）                                                                                             |

**Quota 相关取用建议（事实，非设计）**：

- 定时刷新用**独立 timer**（不挂 pi 事件），`turn_end` 只做"读缓存 + 注入"。这跟 compact-hint 的 `turn_end` 钩子完全同构，可直接复用 `holder: { current?: Stack }` + `sendMessage` 依赖注入的写法。
- `before_agent_start` 是 memory 用的注入点，`turn_end` 才是本轮唯一确定"已进入新一轮决策前"的钩子——quota 阶梯提示放 `turn_end`（与设计简报一致）。

---

## 3. memory 注入模式（`src/memory/inject.ts`）

- 导出：`createMemoryInjectHook(deps: MemoryInjectDeps): BeforeAgentStartHandler`

```ts
export type BeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined>;
```

- **契约**：返回 `{ systemPrompt: prompt + "\n\n" + block }` 或 `undefined`（无变化）；**永不抛**（顶层 `try { … } catch { return undefined; }`，见 inject.ts 末尾）。
- **子会话判定 `isChildSession` 的来源**：不在 memory 模块内部算，是从 **`src/index.ts:118-124`** 的 HOST_KEY 判定传进来的：

```ts
const HOST_KEY = Symbol.for("pi-subagent:host");
const g = globalThis as Record<symbol, unknown>;
const isChildSession = Boolean(g[HOST_KEY]);
...
if (preGuardSettings.memory.enabled) wireMemory(pi, { settings: preGuardSettings.memory, isChildSession });
```

即：**HOST_KEY 已被认领 ⇒ 当前 activate() 发生在子会话**，因为主会话的 `/reload` 会先 `session_shutdown` 释放再重新 `activate`。`wireMemory` 把这个布尔值一路传进 `MemoryInjectDeps.isChildSession`（memory/index.ts → memory/inject.ts）。

- **sentinel 防重注入**（inject.ts 末段）：

```ts
const slug = toSlug(cwd);
const prompt = event.systemPrompt;
if (prompt.includes(injectionSentinel(slug)) || prompt.includes(`## Memory (${slug})`)) return undefined;
```

`injectionSentinel(slug)` 在 `src/memory/render.ts` 定义，是渲染出的 HTML 注释哨兵；第二个分支是兼容旧插件的 `## Memory (<slug>)` 标题行。**quota 的阶梯提示不走 systemPrompt 注入**（用 `sendMessage`），不需要这套 sentinel；但如果未来要做"HUD/systemPrompt 静态额度概览"，这是唯一的双重注入防护参考实现。

---

## 4. Agent 工具注册与模型解析链

**`src/config/model-hint.ts`** 三个导出：

```ts
export function formatModelCandidates(candidates: readonly ModelCandidate[], limit = 8): string;
export function parseStrictModelRef(value: string): ModelRef | undefined;
export function resolveModelHint(hint: string, candidates: readonly ModelCandidate[]): ModelRef | undefined;
```

纯函数，无 pi 依赖，`ModelCandidate = ModelRef & { name?: string }`，`ModelRef = { provider: string; id: string }`。

**全部调用点**（grep 结果）：

| 调用点                                                                                                | 用途                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `stack.ts:1014` `resolveModelHint(hint, ctx.modelRegistry.getAvailable().map(...))`                   | `StackModelPort.resolveHint` 的唯一实现，喂给 spawn 与 set_model 工具                                                        |
| `stack.ts:1050,1067`                                                                                  | 把 `models.resolveHint` 传给 `createRuntimeRunnerAdapter`（`resolveModelHint`）与 `createSpawnService`（`resolveModelHint`） |
| `service/spawn-service.ts:290-297`                                                                    | spawn 准入阶段：`deps.resolveModelHint?.(modelHint)` 失败即拒绝 spawn（下见 §5）                                             |
| `service/runtime-adapter.ts:70,417`                                                                   | 转发同一个 hint 解析器给 driver（agent-frontmatter `model:` 走这条路）                                                       |
| `tools/agent-tool.ts:184` `parseStrictModelRef(model)`                                                | Agent 工具参数里的 strict `provider/id` 解析（模糊 hint 由 spawn-service 兜底）                                              |
| `tools/set-model-tool.ts:220` `parseStrictModelRef(params.model) ?? deps.resolveHint?.(params.model)` | set_model 工具：先严格解析，不行再走模糊 hint                                                                                |
| `config/agent-types.ts:117`                                                                           | frontmatter `model:` 字段的严格解析（不模糊）                                                                                |

**模糊别名 block 时的错误文案**——在 **`service/spawn-service.ts:290-300`**（spawn 准入路径，唯一构造点）：

```ts
const resolved = deps.resolveModelHint?.(modelHint);
if (!resolved) {
  const suffix = formatModelCandidates(deps.availableModels?.() ?? []);
  return {
    error: {
      kind: "config",
      message:
        `unknown model hint: "${modelHint}" — pass a strict provider/id, or a bare id/substring of an available model ` +
        `(pi /model lists what's available).${suffix ? ` ${suffix}` : ""}`,
      retryable: false,
    },
  };
}
```

这是「self-correcting error」模式的范本（同文件另有 `unknown agent type` 的姊妹实现，spawn-service.ts:~270-278）。**quota 的 spawn 快速失败闸门应该挂在同一个 admission block**（见 §5），错误文案照抄这个 `{ kind: "config", message, retryable: false }` 结构，`formatModelCandidates` 可以直接复用来附加"额度已耗尽，改用以下候选"。

---

## 5. spawn 路径：model 参数从工具调用到实际 spawn 的流转

调用链（自上而下）：

1. **工具层**：`tools/agent-tool.ts` / `tools/set-model-tool.ts` 解析工具参数里的 `model`（strict 或 fuzzy），转成 `req.modelOverride` / `req.modelHintOverride`（或走 frontmatter `config.model`/`config.modelHint`）。
2. **准入层（唯一挂闸门的位置）**：`service/spawn-service.ts` 的 `spawn()`（见上面 §4 代码块所在函数，约 260-320 行区间）——**在任何可变状态写入之前**做检查，顺序是：
   - `req.deadlineAt` 是否已过期
   - `deps.types.get(req.type)` 是否存在（未知 agent type）
   - `admittedModel = req.modelOverride ?? config.model`；若无 strict model 才走 `modelHint` 解析（上面 §4 的错误块）
3. 通过后才进 `pool`/`runner`/写 `store`（`SpawnService.spawn` 剩余部分，spawn-service.ts 300 行以后，未展开）。
4. 真正的 provider 网络请求发生在 `runtime/runner.ts` / `service/runtime-adapter.ts` 里的 `PiSessionDriver`（`runtime/session-driver.ts`），那一层才真正持有 provider/model 去调用 pi-ai。

**快速失败闸门最合适的挂点**：**`service/spawn-service.ts` 的 `spawn()` 准入 block，在 agent-type 检查之后、model-hint 解析之前或之后都可以**——因为：

- 这里已经是"零副作用、直接返回 `{ error: { kind: "config", ... } } }`"的既定模式（不烧 slot、不写 store）；
- `deps` 已经带 `resolveModelHint` / `availableModels` 两个可选依赖注入口，quota 只需要新增一个 `deps.quotaGate?: (provider: string) => { blocked: boolean; alt?: ModelCandidate[] }` 同款可选依赖；
- `admittedModel`（strict provider/id 或已解析的 hint）在这一行之后已经确定，闸门检查发生在 `admittedModel` 确定之后最自然。
- **绝不要**挂在 `runtime/runner.ts` 或 `session-driver.ts` 更靠里的层——那里已经动了 slot/state machine，失败要走完整的 outcome/notify 流程（烧一次 run），违反设计简报"不烧失败 run"的要求。

`SpawnService` 接口（`service/spawn-service.ts` 顶部 type，`stack.ts` 里 `SpawnService` re-export）由 `index.ts` 的 `forwardSpawn(holder)` 转发给 `Agent` 工具与 `@mention` 输入路径，任何 spawn 入口（工具调用、mention 触发、workflow 子 spawn `createWorkflowChildSpawner`）都汇聚到这一个 `spawn()` 函数，闸门只需改一处。

---

## 6. Settings（`src/config/settings.ts` + `src/config/setting-specs.ts`）

**字段定义模式**——照抄哪个现有段：**`MemorySettings`**（`settings.ts:55` 起）最合适，因为它同样是"默认开、多个数值型子字段、无 duration 字段（不进 `TIME_SETTING_MS_PATHS`）"：

```ts
export interface MemorySettings {
  enabled: boolean;
  injectInChildSessions: boolean;
  allowWriteInChildSessions: boolean;
  freezeInjectionAfterWrite: boolean;
  inlineMax: number;
  byteCap: number;
  indexMax: number;
  maxFileBytes: number;
  maxWriteBytes: number;
}
```

若 quota 有 duration 字段（`refreshMinutes`）——**它必须进 `TIME_SETTING_MS_PATHS`**（settings.ts, 约行 460-490），否则 `/agent settings` 编辑器和秒/毫秒换算会跳过它。参考 `hud.autoFetchMinutes` 是**反例**（HUD 自己按分钟存，没走 `*Ms`/`*S` 双轨），而 `bashJobs.autoBackgroundMs` / `cacheTtl.keepaliveIntervalMs` 是**正例**（在 `TIME_SETTING_MS_PATHS` 数组里，对应 `settings.ts:465-490`）。

- **`EnabledGroup` 基接口**（settings.ts:300-302）：`{ enabled: boolean }`，`HudSettings extends EnabledGroup { autoFetchMinutes: number }` 是最简的"开关 + 一个数值"范本。
- **DEFAULT_SETTINGS**（settings.ts:~380-430）里逐段列默认值，quota 段应加在 `memory:` 之后、`reload:` 之前（跟随 AgentSettings 接口里字段声明顺序，settings.ts:241-297）。
- **解析函数模式**：`parseMemorySettings(value.memory)` 一类的 `parseXxxSettings`，在 `mergeSettings`/`readSettingsNoMigrate` 附近调用（settings.ts:605-611），"Field-by-field tolerant parsing... never throws"（memory.ts 顶注释原话，同款风格 `parseBashJobsSettings`）——quota 也要写 `parseQuotaSettings`，同一套"字段级容错，坏字段回退默认值"纪律。
- **`/agent settings` 可编辑项**：进 `setting-specs.ts`，用 `bool(path, description)` / `count(path, min, description)` / `seconds(path, options)` 三个 helper（`setting-specs.ts:1-60` 定义 `seconds`；`bool`/`count` 在同文件更早，未展开但同款签名 `(path, ...args, description?) => SettingSpec`）。参考行：

```ts
// setting-specs.ts:202
"memory.enabled": bool("memory.enabled", "Merged project memory: injection + memory tool + /mem"),
// setting-specs.ts:215
"memory.inlineMax": count("memory.inlineMax", 0, "Memory files inlined in full (pinned first); 0 = index only"),
```

- **持久化**：`persistSettingOverride(key, value)` — 写入 `defaultSettingsPath()`（= `~/.pi/agent/pi-subagent.json`，路径解析在 `defaultSettingsPath()`，未展开但被 `index.ts` 的 `/agent` 命令依赖注入调用）。

---

## 7. `stack.ts` 的 `buildSessionStack` 形状

- **签名**：

```ts
export function buildSessionStack(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: AgentSettings,
  types: AgentTypeRegistry,
  mergedExtensions: readonly SubagentExtensionPoints[],
  sessionReason: GoalSessionStartReason = "reload",
): Stack;
```

- **模块级 `previousXxx` 变量 + dispose-at-top 模式**（stack.ts:106-125 声明区，1180-1188 dispose 区）：每个跨会话存活的服务（`FleetWidgetController`、`UsageBroadcaster`、`Coalescer` x2、`BashJobManager`、`FabricMailbox`、`CacheKeepaliveService`、`CacheAdaptiveService`）都用一个模块级 `let previousXxx: T | undefined` 承接"同模块内 session 切换"（`/new`、fork、resume），在 `buildSessionStack` **顶部**先 `previousXxx?.dispose(); previousXxx = undefined;` 再重建。**`/reload` 这条路径这套 handoff 不生效**（jiti 重新 import 模块，模块级变量清零），必须靠 `Stack` 接口上暴露的字段（如 `fleetWidget?`, `bashJobs?`）在 `index.ts` 的 `session_shutdown` 处理器里显式 `.dispose()`（index.ts:501-527）。
- **quota service 应该怎么挂**：
  1. 在 stack.ts 顶部模块级变量区加 `let previousQuota: QuotaService | undefined;`（如果它要跨会话存活定时器）；
  2. `buildSessionStack` 顶部先 dispose 旧的；
  3. 构造新的 `quota = settings.quota.enabled ? createQuotaService({ clock: systemClock, ... }) : undefined;`（跟 `keepalive`/`adaptive` 同款可选构造，stack.ts 里 `keepalive`/`adaptive` 两段代码，1172-1197 行区间）；
  4. `previousQuota = quota;`
  5. 加进 `Stack` 接口（`export interface Stack { ...; quota?: QuotaService; }`）与函数末尾的 `return { ...; ...(quota ? { quota } : {}) };`（stack.ts 末尾 return 块，1362-1381 行）；
  6. `index.ts` 的 `session_shutdown` 处理器要加 `holder.current.quota?.dispose();`，跟 `keepalive`/`adaptive`/`bashJobs` 并列（index.ts:505-520）。
- **互相注入的方式**：全部通过闭包捕获同一个 `ctx`/`settings`/`pi`，以及像 `runnerRef`/`spawnRef`/`widgetRef` 这样的**晚绑定 ref 对象**解决"A 需要还没构造出来的 B"的循环依赖（stack.ts 里至少 4 处用这个模式，如 `runnerRef: { current?: Runner } = {}`）。quota 若要给 spawn 闸门提供快照读取，同样用一个 `quotaRef: { current?: QuotaService }` 或者直接把 `quota.snapshot` 方法通过 `models`/`spawn` 依赖对象传入 `createSpawnService`（跟 `resolveModelHint`/`availableModels` 同款）。

---

## 8. HUD / status key

**`src/hud/index.ts`** 的机制：

- `wireHud` **全屏接管 footer**（`installFooter(s, ctx)`, 见 footer.ts，未展开），是重量级 API：`ctx.ui.setFooter(...)`，`session_shutdown` 时 `ctx.ui.setFooter(undefined)` 还原 pi 内置 footer（hud/index.ts:476-483）。
- **轻量并存的 status key API**：`ctx.ui.setStatus(id: string, text: string | undefined)`——HUD 自己用 `STATUS_ID = "pi-hud"`（hud/index.ts:38, 用法见 152 行 `ctx.ui.setStatus(STATUS_ID, renderConversationStats(...))`）。**其他模块可以并存注册自己的 status key**：`src/index.ts` 里 `/goal` 用了另一个 key `"goal"`（`stack.ts` 内 `ctx.ui.setStatus("goal", goalBadgeText(rehydratedGoal.record))`，stack.ts:~1250）——两个 key 同时挂着不冲突，pi 的状态栏按 key 分槽渲染。
- **推荐给 quota 用的 API**：`ctx.ui.setStatus("quota", text)`，不需要接管 footer，直接跟 HUD/goal 并列一行。`ctx.ui` 的可用性要判 `if (ctx.hasUI && typeof ctx.ui.setStatus === "function")`（stack.ts 里 goal 分支就是这么写的，try/catch 包一层 best-effort）。
- HUD 消费 subagent 广播事件的方式（`pi.events.on("subagent:usage", onSubUsage)`，hud/index.ts:280 附近）可以作为 quota 想把额度数据也塞进 HUD 费用行的参考，但**本期不需要**（brief 已明确不做费用折算，quota 用独立 status key 即可）。

---

## 9. 凭据读取

- **`pi-compat.ts` 与 `ExtensionContext`/`ExtensionAPI` 里没有任何 `authStore`/`getKey`/`credentials` 相关字段或方法**（`grep -n "auth\|Auth"` 命中的全是 provider 注册用的 OAuth 回调类型 `OAuthCredentials`/`getApiKey(credentials)`——那是**注册 provider 时**用的回调，不是**读已存凭据**的查询 API）。
- pi 的凭据落盘位置（从 pi 包源码确认，非 pi-toolkit 自身代码）：`node_modules/@earendil-works/pi-coding-agent/dist/config.js:437` → `join(getAgentDir(), "auth.json")`，即 **`~/.pi/agent/auth.json`**。
- **实测文件形状**（真实环境）：

```json
{
  "moonshot": { "type": "...", "key": "..." },
  "kimi-coding": { "type": "...", "key": "..." },
  "zai-coding-cn": { "type": "...", "key": "..." },
  "zai": { "type": "...", "key": "..." }
}
```

即顶层键是 provider slug，值 `{ type, key }`，`key` 就是裸的订阅 key（brief 提到的「无 Bearer 前缀」凭据来源）。

- **结论**：**没有正式 pi 扩展 API 能读 auth store**；brief 里"硬编码文件路径为下策——由 Plan 决定具体方式"是准确的，Plan 阶段需要在"直接读 `getAgentDir()/auth.json`（`getAgentDir` 本身是 pi 导出的公开 API，`@earendil-works/pi-coding-agent` 的 `index.d.ts:2` 导出）"与"要求用户手动配置一个独立 env/文件"之间选一个——**前者复用了 `getAgentDir()` 这个真正公开的 API，只是文件内部结构 (`auth.json` 的 schema) 未被文档化/未被类型系统覆盖**，属于非公开契约但比裸写 `~/.pi/agent/auth.json` 字符串路径好一些。
- **对照 `src/web-search/config.ts` 的 env 凭据模式**（config.ts 全文已读）：纯 `process.env` + fallback 文件 `~/.config/pi/web-search.env`（`PI_WEB_SEARCH_ENV_FILE` 可覆盖路径），**完全不接触 pi 的 auth store**——即 web-search 从设计上刻意避开了这个问题（要求用户单独配置凭据文件）。quota 如果想让用户免配置（复用已登录的 zai key），就必须走 `auth.json` 这条非公开路径；如果想保持跟 web-search 一致的"显式凭据文件"哲学，就要在 settings/文档里要求用户单独放一个 quota key。**这是 Plan 阶段唯一需要做决策的开放问题**，本地图只陈述事实。

---

## 10. 失败韧性（`src/web-search/resilience.ts`）

纯函数，无 pi 依赖，可完整复用：

```ts
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_ATTEMPTS = 3;
export class HttpError extends Error { constructor(message: string, readonly status?: number, readonly responseBody?: string) }
export function isRetryableError(error: unknown, status: number | undefined, responseBody: string | undefined): boolean
export function sleep(ms: number, signal?: AbortSignal): Promise<void>          // setTimeout 内部 .unref()
export function backoffDelay(attempt: number): number                          // 500*2^(attempt-1) + jitter
export async function withRequestTimeout<T>(parentSignal, action): Promise<T>   // AbortController + unref'd timeout
export function redactSecrets(message: string, secrets: string[]): string
export function errorMessage(error: unknown, secrets: string[]): string
```

- `isRetryableError` 里已经内置了**429 + quota-exhaustion 正则**分流逻辑（`QUOTA_EXHAUSTION_PATTERN`）——quota 拉取遇到 429/额度用尽本身就该走「不重试」分支，这段逻辑对 quota 模块自身的语义几乎是现成的（"额度耗尽"是它的核心信号而不是错误）。
- quota 拉取可以**直接 import** `sleep`/`backoffDelay`/`withRequestTimeout`/`redactSecrets`（key 绝不能进日志，`redactSecrets` 的 `authorization:\s*bearer\s+` 正则**不覆盖裸 key**场景——quota 的认证头是裸 key 无 Bearer 前缀，若要复用需要新增一条正则或者调用方自己在 catch 里手动 mask）。
- `MAX_ATTEMPTS = 3`（1 次 + 2 次重试）对 quota 定时拉取（10 分钟一次、允许多刷新窗口自然覆盖失败）可能过重——brief 已明确「绝不阻塞 turn_end/spawn 主路径」「静默降级」，倾向于**单次尝试 + 失败即返回 undefined**，不需要真正的重试循环，只需要 `withRequestTimeout` 防止网络挂起阻塞刷新定时器。

---

## 11. 主/子会话判定（HOST_KEY guard）

- **位置**：`src/index.ts:118-160`。

```ts
const HOST_KEY = Symbol.for("pi-subagent:host");
const g = globalThis as Record<symbol, unknown>;
const isChildSession = Boolean(g[HOST_KEY]);      // 118-124行，pre-guard 阶段就要用（memory 需要）
...
if (g[HOST_KEY]) return;                          // 154行：真正的硬 guard —— 子会话到这里直接 return，后面全部代码不跑
const claim = { activatedAt: Date.now() };
g[HOST_KEY] = claim;
...
pi.on("session_shutdown", () => {
  releaseBackgroundStatus();
  if (g[HOST_KEY] === claim) delete g[HOST_KEY];   // 只有认领者自己释放（identity check，防止子会话shutdown误释放）
});
```

- **子会话里跳过的注册**：`if (g[HOST_KEY]) return;`**之后**的所有代码——Agent/get_subagent_result/steer/abort/set_model 工具、`before_agent_start` 的 agent-types 注入、`session_start`/`session_shutdown` 的 stack 构建、HUD/feishu-notify/session-nav（这三个还在 guard 之后额外判断，post-guard）。**guard 之前**（pre-guard）注册的东西子会话仍然拥有：`web_search`（若 `webSearch.enabled`）、`todo`（若 `todo.enabled`）、`memory`（若 `memory.enabled`，但 injection 受 `isChildSession && !injectInChildSessions` 门控）。
- **quota 应该挂在哪一侧**：
  - **注入层（turn_end 阶梯提示）**：只对主会话有意义——挂在 guard **之后**（跟 compact-hint 的 `pi.on("turn_end", createCompactHintHook(...))` 同一处，index.ts:200 附近，天然在 guard 之后）。
  - **数据层（定时拉取 + 缓存）**：构造成本低、无副作用，**也应该挂在 guard 之后**（跟随 `buildSessionStack`，一个 session 一份），因为子会话的派单决策本身就没有意义（brief 已明确「子会话派单无意义」）。不需要 pre-guard。
  - **调用时闸门（spawn 快速失败）**：spawn 只发生在主会话（子会话没有 Agent 工具，见上）——天然只在主会话路径触达，不需要额外判断。

---

## 12. 测试约定

**目录结构对照**（三个现成范本）：

- `tests/compact-hint/` = `{pi-settings.test.ts, threshold.test.ts}`——纯函数单测，**不涉及 fake pi**，直接测 `usageTickMarks`/`usageTickStep`/`effectiveThresholdPercentWithTokens` 等纯计算。quota 的阶梯/速率预测/降位标记纯逻辑测试应照这个抄：新建 `tests/quota/threshold.test.ts`（或等价命名）。
- `tests/integration/compact-hint-wiring.test.ts`——**fake pi 对象**的标准写法（已读全文相关片段）：

```ts
function fakePi() {
  const sent: unknown[] = [];
  return {
    sent,
    pi: {
      sendMessage: (message: unknown) => sent.push(message),
      appendEntry: () => undefined,
      events: { emit: () => undefined, on: () => () => undefined },
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    } as unknown as ExtensionAPI,
  };
}
function ctx(percent: number | null, mode = "interactive", hasUI = false, contextWindow = 200000, notify = vi.fn()) {
  return {
    mode,
    hasUI,
    getContextUsage: () => ({ percent, contextWindow, tokens: null }),
    ui: { notify },
  } as never;
}
```

以及 `holder(state)` 帮手：`{ current: { compactHint: state } as Stack }`——**quota 的等价测试**应该造一个 `{ current: { quota: state } as Stack }` 的 holder，直接测 `createXxxHook(holder, deps)` 返回的处理函数在给定 `ctx`/连续调用序列下发了哪些 `sendMessage` 调用（`sent` 数组断言）。这是唯一覆盖"turn_end 钩子真实行为"的集成测试范式，**必须**照抄以验证阶梯触发时机、cooldown、降位标记持久化。

- `tests/memory/inject.test.ts`——用**真实临时目录**（`mkdtempSync(join(tmpdir(), "pi-mem-inject-"))`）+ 真实文件系统读写，而不是 mock fs；`fakeEvent(systemPrompt, cwd)` 构造 `BeforeAgentStartEvent`。quota 若要测 auth.json 读取（如果 Plan 决定走这条路），应该照这个模式建临时 `auth.json` 文件而不是 mock `readFileSync`。
- `tests/web-search/resilience.test.ts`——纯函数单测 `isRetryableError`/`backoffDelay` 等，**不需要网络** mock，因为这些函数本身是同步/纯逻辑；真正发网络请求的部分（如果有 `tests/web-search/tool.test.ts`）用 `vi.fn()` 替身或者 `global.fetch` mock（未展开该文件，但 `format.test.ts`/`tool.test.ts` 并列存在，命名暗示 tool.test.ts 才是网络层测试所在）。
- **配置测试**：`tests/config/memory-settings.test.ts` 是 `parseMemorySettings` 的字段级容错测试范本（"每个坏字段回退默认值互不影响"）——quota 新建 `tests/config/quota-settings.test.ts` 照抄。

**推荐新模块的测试文件树**：

```
tests/quota/
  threshold.test.ts        # 纯函数：阶梯判定、速率预测 ETA、双窗口独立、格点非线性密度
  adapter-zai.test.ts      # fetchQuota() 静默降级（挂了返回 undefined，never throws）—— fetch mock
  service.test.ts          # TTL 缓存、unref timer、快照读取
tests/integration/
  quota-turn-end-wiring.test.ts   # 照抄 compact-hint-wiring.test.ts 的 fakePi/ctx/holder 三件套
tests/config/
  quota-settings.test.ts   # parseQuotaSettings 字段级容错
```
