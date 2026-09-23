# cache-ttl keepalive ping — 管线摸查（只读调研）

目的：为"主会话空闲 + 有后台工作时，每 ~4 分钟原样重放上一次 provider payload（`max_tokens: 1`）以续命 Anthropic 提示词缓存"这一功能摸清装配管线。不含设计结论，只列证据。

---

## 1. 新增一个设置项要改哪些地方（以 `cacheTtl.mode` 为样本）

`cacheTtl.mode` 是一个 enum 设置，完整改动点：

1. **类型定义** — `src/config/settings.ts:132-135`

   ```ts
   export type CacheTtlMode = "auto" | "on" | "off";
   export interface CacheTtlSettings {
     mode: CacheTtlMode;
   }
   ```

   并在顶层 `AgentSettings` 接口里挂一个字段：`src/config/settings.ts:223` `cacheTtl: CacheTtlSettings;`

2. **DEFAULT_SETTINGS** — `src/config/settings.ts:327`

   ```ts
   cacheTtl: { mode: "auto" },
   ```

   （在 `export const DEFAULT_SETTINGS: AgentSettings = {` 块内，块起始于 `settings.ts:271`。）

3. **顶层 parse 分发** — `src/config/settings.ts:522`

   ```ts
   cacheTtl: parseCacheTtlSettings(value.cacheTtl),
   ```

   这是 `loadSettings()`（合并 JSON 输入到 `AgentSettings`）内的一行，新设置块必须在这里挂上对应的 `parseXxxSettings(value.xxx)` 调用。

4. **字段级 parse 函数（逐字段回落默认，never throws）** — `src/config/settings.ts:591-596`

   ```ts
   export function parseCacheTtlSettings(input: unknown): CacheTtlSettings {
     const defaults = DEFAULT_SETTINGS.cacheTtl;
     if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
     const mode = (input as Record<string, unknown>).mode;
     return mode === "auto" || mode === "on" || mode === "off" ? { mode } : { ...defaults };
   }
   ```

   同款写法可参照 `parseHudSettings`（`src/config/settings.ts:605-615`）的 `hud.autoFetchMinutes` number 字段容错：`typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0`，非法值回落 default —— 这是"加一个 number 设置"的现成范本。

5. **迁移逻辑（可选，仅当替换/搬迁一个曾经独立存储的旧字段时才需要）** — `src/config/settings.ts:890-923` `migrateLegacyCacheTtlState(...)`，在 `loadSettingsFromFile` 内于 `settings.ts:803` 被调用：

   ```ts
   const cache = migrateLegacyCacheTtlState(timed.value, path, join(dirname(path), "cache-ttl-state.json"));
   ```

   这是把旧的 `cache-ttl-state.json` 文件合并进统一 settings 文件的一次性迁移，**新增设置项一般不需要这一步**（没有历史散落文件的话可以跳过）。测试样本：`tests/config/cache-ttl-migration.test.ts`。

6. **`setting-specs.ts` 的 spec 登记** — `src/config/setting-specs.ts:236-240`：

   ```ts
   "cacheTtl.mode": choice(
     "cacheTtl.mode",
     ["auto", "on", "off"],
     "Anthropic prompt-cache TTL: auto=follow pi/env, on=force 1h, off=provider default (5m)",
   ),
   ```

   这张表（`export const SETTING_SPECS: Record<string, SettingSpec> = { ... }`，起始于 `setting-specs.ts:149`）是 `/agent settings` 文本命令 **和** TUI 设置编辑器（`src/ui/settings-editor.ts`）**共享的唯一登记点** —— 加了这一行两个界面自动都能看到，不需要在 `src/ui/` 里另外注册。证据：`src/ui/settings-editor.ts:5` 直接 `import { SETTING_SPECS, ... } from "../config/setting-specs.js"`，并在 `settings-editor.ts:169/196/294/301` 通过 key 查表渲染/校验/单位换算，没有第二张表。

   `setting-specs.ts` 提供了 4 个 helper 构造函数（`setting-specs.ts:46-77`）：
   - `bool(path, description?)` → `{ kind: "boolean", path, ... }`（`setting-specs.ts:71`)
   - `count(path, min=0, description?)` → `{ kind: "number", path, min, integer: true, ... }`（`setting-specs.ts:68`)
   - `choice(path, values, description?)` → `{ kind: "enum", path, values, ... }`（`setting-specs.ts:74`)
   - `seconds(path, options?)` → 时长专用，`kind: "number"` + `time: true`（**存储态是整数秒**，内部字段是毫秒，见下）（`setting-specs.ts:44-59`)

   **时长字段的特殊规则**：如果新设置是"毫秒时长"，接口里存 `xxxMs`，spec 表用 `seconds("xxx.xxxMs", {...})` 且 **key 用 `xxx.xxxS`**（显示态秒名），`path` 指向内部 `...Ms` 字段。样本：`"bashJobs.autoBackgroundS": seconds("bashJobs.autoBackgroundMs", {...})`（`setting-specs.ts:246-249`）。转换逻辑集中在 `src/config/time-units.ts`（`getPath/setPath/msKeyOf/msToSeconds/secondsKeyOf/secondsToMs`，被 `setting-specs.ts:10` 引入），还需要在 `TIME_SETTING_MS_PATHS`（需要登记进 `TIME_SETTING_MS_PATHS`（`src/config/settings.ts:390`，一个 `readonly string[]`，列出所有"内部存 Ms、显示存 S"的路径），`isTimeSettingKey`（`src/config/settings.ts:421`，供 `setting-specs.ts:464` re-export 后被编辑器用来判断某 key 是否要做秒/毫秒换算）依赖这张表判断。AGENTS.md 提到 goal 模块的 `maxMinutes` 字段"不在时长规约内"，即它是分钟字段，故意不登记进 `TIME_SETTING_MS_PATHS`）登记，否则 `/agent settings` 与编辑器的秒↔毫秒换算会跳过它。

7. **测试**：新增设置项通常至少要补：
   - `tests/config/*-settings.test.ts`（样本：`tests/config/cache-ttl-migration.test.ts`、`tests/config/extend-settings.test.ts`、`tests/config/memory-settings.test.ts`）覆盖 `parseXxxSettings` 的容错矩阵 + `loadSettings`/`loadSettingsFromFile` 集成。
   - `tests/config/extend-settings.test.ts:45-72` 与 `tests/config/memory-settings.test.ts:109-140` 都有一段"断言 `SETTING_SPECS["xxx.yyy"]` 存在且 `kind`/`path`/`min` 符合预期"的用例 —— 新设置项要在 `SETTING_SPECS` 里补同类断言。
   - `tests/ui/settings-editor.test.ts`（`ui/settings-editor.test.ts:14` 引入 `SETTING_SPECS, currentOf, defaultOf, parseSettingValue, settingKeys`）是编辑器层的通用测试，遍历 `settingKeys()`，新 key 一般会被这套通用遍历自动覆盖，无需单独改，除非该 key 有特殊展示逻辑。
   - `tests/cache-ttl/cache-ttl.test.ts:6-25` 里 `describe("cache TTL settings", ...)` 的第一个用例直接测 `parseCacheTtlSettings` 的白名单校验 —— 新设置项如果挂在 `cache-ttl` 模块下（例如 `cacheTtl.keepaliveEnabled` / `cacheTtl.keepaliveIntervalS`），大概率要在这个文件里加同款用例。

### 最小改动清单（"加一个 boolean 设置 + 一个 number 设置"，假设都挂在 `cacheTtl` 块下）

| 步骤 | 文件:行号（锚点）                                                      | 内容                                                                                                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `src/config/settings.ts:133-135`                                       | `CacheTtlSettings` 接口加 `keepaliveEnabled: boolean; keepaliveIntervalS: number;`（或类似字段）                                                                                                                                           |
| 2    | `src/config/settings.ts:327`                                           | `DEFAULT_SETTINGS.cacheTtl` 字面量加上两个字段的默认值                                                                                                                                                                                     |
| 3    | `src/config/settings.ts:591-596`                                       | `parseCacheTtlSettings` 里逐字段容错解析新增两个字段（参照 `parseMemorySettings` 的 `bool()`/`num()` 内联 helper 写法，`src/config/settings.ts:625-643` 附近）                                                                             |
| 4    | `src/config/setting-specs.ts:236-240` 附近                             | `SETTING_SPECS` 里加 `"cacheTtl.keepaliveEnabled": bool(...)` 和 `"cacheTtl.keepaliveIntervalS": count(...)`（若是"毫秒时长"语义则改用 `seconds(...)`，并把对应 `xxxMs` 路径追加进 `TIME_SETTING_MS_PATHS`，`src/config/settings.ts:390`） |
| 5    | `tests/cache-ttl/cache-ttl.test.ts`                                    | 补 `parseCacheTtlSettings` 对新字段的容错断言                                                                                                                                                                                              |
| 6    | `tests/config/*-settings.test.ts`（新建或复用现有 cache-ttl 相关文件） | 补 `SETTING_SPECS["cacheTtl.xxx"]` 的 `kind/path/min` 断言                                                                                                                                                                                 |
| 7    | 不需要动 `src/ui/`                                                     | TUI 编辑器自动读 `SETTING_SPECS`，无需单独登记                                                                                                                                                                                             |

---

## 2. cache-ttl 现有测试：位置与触发方式

- 测试文件：`tests/cache-ttl/cache-ttl.test.ts`（101 行源码对应 121 行测试，覆盖 rewrite 逻辑、dirty 状态机、`/cache-ttl` 命令）+ `tests/config/cache-ttl-migration.test.ts`（settings 文件迁移专测）。
- **没有独立的"mock pi harness"框架**，是手写的极简 stub：
  ```ts
  // tests/cache-ttl/cache-ttl.test.ts:6-18
  function setup(mode: "auto" | "on" | "off" = "auto", persist = vi.fn()) {
    const hooks = new Map<string, (event: any, ctx: any) => unknown>();
    const commands = new Map<string, any>();
    const pi = {
      on: (name: string, handler: any) => hooks.set(name, handler),
      registerCommand: (name: string, value: any) => commands.set(name, value),
    } as unknown as ExtensionAPI;
    const notify = vi.fn();
    const status = vi.fn();
    const ctx = { ui: { notify, setStatus: status } } as unknown as ExtensionContext;
    wireCacheTtl(pi, { ...DEFAULT_SETTINGS, cacheTtl: { mode } }, { persist });
    return { hooks, commands, ctx, notify, status, persist };
  }
  ```
- **触发 `before_provider_request`**：直接从 `hooks` map 里取出注册的 handler 并同步调用，绕开真实 pi 运行时：
  ```ts
  // tests/cache-ttl/cache-ttl.test.ts:33
  const result: any = hooks.get("before_provider_request")!({ payload }, {});
  ```
  第二个参数（`ctx`）在多数用例里传 `{}`（空对象），因为当前 `rewrite()` 逻辑完全不碰 `ctx`。**这意味着如果 keepalive 功能要用到 `ctx.modelRegistry` / `ctx.ui`，现有 hook 签名 `(event) => {...}`（`cache-ttl.ts:55`，只解构了 `event`，未取 `ctx` 参数）需要改成 `(event, ctx) => {...}`，测试 stub 也要跟着把 `ctx` 填充真实字段（目前测试大量位置传的是 `{}` 空对象，`cache-ttl.ts:33/44/47/48/59/71` 等调用点都要评估）。**
- `wireCacheTtl` 的依赖注入口子是 `CacheTtlDeps`（`cache-ttl.ts:10-12`，目前只有一个 `persist` 回调），新功能如果要注入"HTTP 发送函数"以便测试可 mock，应该走同一个 `deps` 参数扩展，而不是引入新的全局依赖。
- 未发现仓库级别的通用"mock ExtensionAPI/ExtensionContext harness"文件（没有找到 `tests/helpers` 或 `tests/fixtures` 下的公共 pi mock，cache-ttl 测试是自己手搓 `Map`-based stub，其它模块测试也是各自手搓，风格一致但没有共享工具）。

---

## 3. HUD 成本统计的数据来源；带外请求能否回填

- **数据来源是 pi 的 session entries，不是自己的累加器**：`src/hud/footer.ts:143-189`，每次 `render()` 都重新遍历 `ctx.sessionManager.getEntries()`：
  ```ts
  // src/hud/footer.ts:143
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "toolResult") { ... tu = entry.message.usage ... }   // 子代理/嵌套调用的 usage，挂在 toolResult 上（footer.ts:146-172）
    if (entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;                                              // 主会话 assistant 消息自带的 usage（footer.ts:178-188）
    ...
  }
  ```
  也就是说 HUD 统计的是 **pi 官方记录进 session transcript 的 assistant/toolResult 消息的 `usage` 字段**，完全依赖 pi 自身的账本，pi-toolkit 侧没有独立的 token/cost 累加状态（唯一的例外是 `src/hud/index.ts:88-92` 的 `subUsage: Map<string, {costUsd, terminal}>`，那是子代理**实时**费用的 1Hz 广播缓存，用于在子代理还没写回 toolResult 之前先估算显示，最终仍以 toolResult 里的 usage 为准，见 `footer.ts:141-142` 注释）。
- **带外（out-of-band）keepalive 请求不会自动出现在这套统计里**：因为它不经过 pi 的 `Agent`/`streamSimple` 流程，不会产生 `session_entry`（`type: "message", role: "assistant"`），`ctx.sessionManager.getEntries()` 遍历不到它。若想让 HUD 把 keepalive 消耗的 tokens/cost 计入总量，唯一途径是**手工构造一条 session entry 追加进去**（未找到任何现成的 API 允许"追加一条不对应真实对话轮次的 usage 记录"，`ctx.sessionManager` 的写入面貌未在本次调研中确认，且这样做会污染上下文历史/多轮计数，**不建议**）。
- **更符合现有规范的展示位是状态栏 `ctx.ui.setStatus(key, text)`**，key 命名规范是"模块短横线 kebab-case 字符串"，与模块目录/日志前缀对齐，样本：
  - `src/cache-ttl/cache-ttl.ts:26-29` → `ctx.ui.setStatus("cache-ttl", "⏱ cache: 1h")`
  - `src/hud/index.ts:158` → `ctx.ui.setStatus(STATUS_ID, ...)`（`STATUS_ID` 是 `"pi-hud"`，据 AGENTS.md）
  - `src/feishu-notify/index.ts:475/477/621` → `setStatus("feishu-notify", ...)`
  - `src/goal/hook.ts:110`、`src/goal/command.ts:111`、`src/stack.ts:1142` → `setStatus("goal", ...)`
  - `src/todo/index.ts:106` → `setStatus(LEGACY_STATUS_KEY, undefined)`
    即：**新功能应该用自己的 key（如 `"cache-ttl-keepalive"` 或复用 `"cache-ttl"` 追加信息），不要试图篡改 HUD 的 token/cost 累计**，keepalive 消耗的 usage 如果要展示，只能自己在闭包里累加一个计数器然后塞进独立状态栏文案，或者干脆只展示"最近一次 ping 时间/成功与否"，不展示 token 数。

---

## 4. 定时器范式 + cache-ttl 现有生命周期

### 4.1 仓库里的 `unref()` + `session_shutdown` 释放范式（两个代表性例子）

**例 1 — `src/hud/index.ts`（session-scoped，per-session 重建/释放）**：

- 创建：`session_start` 里先 dispose 旧 session、建新 `HudSession`、装 `setInterval`、`unref()`：
  ```ts
  // src/hud/index.ts:298-334（节选行号）
  pi.on("session_start", async (_event, ctx) => {
    if (session) disposeSession(session);      // index.ts:299 — 先清理上一个 session
    const s = createHudSession(ctx);           // index.ts:300
    session = s;
    ...
    s.refreshTimer = setInterval(() => {        // index.ts:329
      refresh(s, ctx).catch(() => {});
    }, REFRESH_INTERVAL_MS);
    s.refreshTimer.unref();                     // index.ts:332
  });
  ```
- 释放：`session_shutdown` 里调用 `disposeSession`，内部 `clearInterval`：
  ```ts
  // src/hud/index.ts:457-464
  function disposeSession(s: HudSession): void {
    s.active = false;
    ...
    if (s.refreshTimer) clearInterval(s.refreshTimer);
    s.refreshTimer = undefined;
    stopLlmTimer(s);
    ...
  }
  // src/hud/index.ts:469-478（session_shutdown handler 内调用 disposeSession(s)）
  ```
  这是"整个模块只 `wireHud(pi, ...)` 一次（在 `src/index.ts:494`），但内部自己注册 `session_start`/`session_shutdown` 来管理每会话的定时器"的范式 —— **这正是 cache-ttl keepalive 应该抄的模板**。

**例 2 — `src/workflow/worker-source.ts`（heartbeat/timer 全部 unref）**：

```ts
// src/workflow/worker-source.ts:102/124/310/533（均为 `if (typeof timer.unref === "function") timer.unref();` 或 heartbeatTimer.unref()/cleanup.unref() 同款防御式写法）
```

与 `src/web-search/resilience.ts:54/77`（`timer.unref()`）一起，说明仓库约定是"每个新建的 `setInterval`/`setTimeout` 必须紧跟一行 `unref()`"，防御性判断 `typeof x.unref === "function"` 是因为部分环境/mock 定时器对象没有 `unref`。

### 4.2 cache-ttl 当前的装配层级与生命周期现状

- `wireCacheTtl(pi, settings)` 在 `src/index.ts:164` 被调用，**在 HOST_KEY 主会话守卫之后、一次性执行**（不在 `buildSessionStack` / `stack.ts` 里，也不在每次 `session_start` 里重建）：
  ```ts
  // src/index.ts:159-164
  pi.on("session_shutdown", () => {
    releaseBackgroundStatus();
    if (g[HOST_KEY] === claim) delete g[HOST_KEY];
  });
  wireCacheTtl(pi, settings);
  ```
  即：`wireCacheTtl` 本身只在 `activate()` 里跑一次；它内部注册的 `pi.on("session_start", ...)`（`cache-ttl.ts:54`，只做 `updateStatus`）和 `pi.on("before_provider_request", ...)`（`cache-ttl.ts:55`）是**长期存活的 handler，没有对应的 `session_shutdown` 清理**，因为它目前完全无状态（没有定时器、没有需要跨会话清理的资源），所以"不清理"目前是安全的。
- **一旦加入定时器，这个"无清理"现状就不再安全**：`wireCacheTtl` 没有像 `wireHud` 那样在自己内部维护一个 `session`/`HudSession` 式的每会话状态盒子，也没有在 `session_start`/`session_shutdown` 里做 create/dispose 配对。如果直接在现在的 `pi.on("session_start", ...)`（`cache-ttl.ts:54`）里加 `setInterval`，**每次 session_start 都会新开一个定时器且没有清理旧的**（HUD 之所以安全是因为它显式 `if (session) disposeSession(session)` 在重建前清理，`cache-ttl.ts` 目前完全没有这一步）。
- **结论：新增定时器必须给 `wireCacheTtl` 补上 HUD 同款的"per-session 状态盒子 + session_start 创建/dispose 前清理 + session_shutdown 清理"三件套**，而不能简单地在现有 `session_start`/`before_provider_request` handler 里塞一行 `setInterval`。具体来说：
  1. 在 `wireCacheTtl` 内部维护一个 `let keepaliveTimer: NodeJS.Timeout | undefined`（闭包变量，模仿 `cache-ttl.ts:49-51` 的 `let mode/persisted/dirty` 写法，而不是模块级变量 —— 依据 AGENTS.md "Never keep mutable state at module scope; rebuild per `activate()`"）。
  2. `session_start` handler（`cache-ttl.ts:54`）里先清理旧定时器再按需新建，`unref()`。
  3. 新增一个 `pi.on("session_shutdown", ...)` handler（目前 `cache-ttl.ts` 里没有这一行，需要新增）来 `clearInterval`。
  4. 定时器要用到 `ctx.modelRegistry`（裸 POST 认证）和 `readBackgroundStatus()`（判断是否有后台工作）—— `ctx` 只在 `session_start`/`before_provider_request` 等 hook 回调参数里可得，需要像 HUD 一样把 `ctx` 存进 per-session 状态盒子里以便定时器闭包里使用（`src/hud/index.ts` 的 `HudSession.ctx` 字段是同款需求的证据，见 `disposeSession` 里 `s.ctx = undefined;`，`hud/index.ts:466`）。

---

## 5. `before_provider_request` 多 handler 组合语义 + `max_tokens` 键名

### 5.1 组合语义：**链式替换，最后一次非 `undefined` 的返回值赢，且这就是最终真正发出去的 payload**

证据 — `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:820-851`：

```js
async emitBeforeProviderRequest(payload) {
    const ctx = this.createContext();
    let currentPayload = payload;
    for (const ext of this.extensions) {                       // 按扩展注册顺序遍历
        const handlers = ext.handlers.get("before_provider_request");
        if (!handlers || handlers.length === 0) continue;
        for (const handler of handlers) {                       // 同一扩展内按注册顺序遍历
            try {
                const event = { type: "before_provider_request", payload: currentPayload };
                const handlerResult = await handler(event, ctx);
                if (handlerResult !== undefined) {
                    currentPayload = handlerResult;              // 非 undefined 才替换，链式喂给下一个 handler
                }
            } catch (err) { /* 记录 emitError，不中断链条 */ }
        }
    }
    return currentPayload;                                       // 返回值 = 所有 handler 依次作用后的最终 payload
}
```

调用方直接把这个返回值当成真正发出去的请求体，没有再做二次转换：

```js
// node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:206-213
onPayload: async (payload, _model) => {
    const runner = extensionRunnerRef.current;
    if (!runner?.hasHandlers("before_provider_request")) return payload;
    return runner.emitBeforeProviderRequest(payload);
},
```

而 `onPayload` 又在 provider 层直接用于替换即将发出的 `params`：

```js
// node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:372-376
let params = buildParams(model, context, isOAuth, options);
const nextParams = await options?.onPayload?.(params, model);
if (nextParams !== undefined) {
  params = nextParams;
}
// 紧接着 client.messages.create({ ...params, stream: true }, requestOptions)
```

**结论**：`event.payload`（在 `before_provider_request` hook 里拿到的）在链条末端会被原样送进 `client.messages.create(...)`——只要我们的 handler 不是链条上最后一个改写它的人（或者我们把改写后的结果原样返回），我们捕获到的 `event.payload`（handler 入参）就是"这一次调用时刻的最终 payload"，前提是**我们的 handler 排在所有其它会修改 payload 的 handler 之后**（cache-ttl 自己的 `rewrite()` 就是在改写这个 payload 后再返回，`cache-ttl.ts:66-67`）。如果要"原样重放上一次真正发出去的 payload"，正确做法是：**缓存 `emitBeforeProviderRequest` 返回给 provider 前的最终形态**，即在我们自己的 handler 里，**读到的 `event.payload` 加上我们自己这次的改写结果**才是最终态——因为我们是最后一个 handler 的话，我们 return 的值就是最终值；如果我们不是最后一个，就需要留意后续 handler 还可能再改写一次（当前仓库里除 cache-ttl 外未发现其它注册了 `before_provider_request` 的扩展，见下方证据）。

仓库内 `before_provider_request` 的唯一 handler 就是 cache-ttl 自己：

```
grep -rn "before_provider_request" src/   →  只有 src/cache-ttl/cache-ttl.ts:55
```

所以在**当前代码库范围内**，"cache-ttl 的 handler 返回值 == 最终发出去的 payload"是成立的（没有其它扩展会在它之后再改写）。但如果宿主同时装载了其它第三方扩展（例如 pi 官方或用户自定义 `before_provider_request` 钩子），排序取决于 `this.extensions` 数组顺序（扩展加载顺序），不由 pi-toolkit 控制。

### 5.2 `max_tokens` 键名：Anthropic Messages API 风格（snake_case `max_tokens`），不是 OpenAI 风格

证据链：

1. `event.payload` 就是 Anthropic provider 的 `buildParams()` 输出（见 5.1 的 `anthropic-messages.js:372-376`），字段构造处：
   ```js
   // node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:740-745
   const params = {
     model: model.id,
     messages: convertMessages(...),
     max_tokens: options?.maxTokens ?? model.maxTokens,   // ← 键名是 max_tokens（下划线，Anthropic wire 格式）
     stream: true,
   };
   ```
2. 与 cache-ttl 现有代码的假设吻合：`cache-ttl.ts:56` 检查 `Array.isArray(event.payload.messages)`，说明它已经假定 payload 是 Anthropic messages 格式（`{ messages: [...] }`），同一 payload 上改 `max_tokens: 1` 即可（键名与 `messages`/`cache_control` 同级，都是 snake_case）。
3. 该仓库另在 `node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js:67` 里能看到 pi 对 OpenAI 系模型另有 `maxTokensField: "max_completion_tokens" | "max_tokens"` 的可配置字段名机制——**这只对 OpenAI-兼容 provider 生效**（`extensions/llama/provider.js:52` 里也硬编码了 `maxTokensField: "max_tokens"`），Anthropic provider 路径没有这层可配置，固定就是 `max_tokens`。cache-ttl 场景明确是 Anthropic cache_control/TTL 相关（`cache_control.type === "ephemeral"`，Anthropic 专属字段），因此实际要改写的键名可以确定为 **`max_tokens`**。

---

## 证据来源速查

| 主题                                     | 关键文件                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| cache-ttl 现状                           | `src/cache-ttl/cache-ttl.ts`                                                          |
| 设置类型/默认值/parse/迁移               | `src/config/settings.ts`                                                              |
| 设置 spec 表（TUI+文本命令共用）         | `src/config/setting-specs.ts`                                                         |
| TUI 编辑器消费 spec 表                   | `src/ui/settings-editor.ts`                                                           |
| cache-ttl 测试                           | `tests/cache-ttl/cache-ttl.test.ts`, `tests/config/cache-ttl-migration.test.ts`       |
| HUD token/cost 统计                      | `src/hud/footer.ts`, `src/hud/index.ts`                                               |
| 后台状态查询                             | `src/service/background-status.ts`                                                    |
| 装配入口/HOST_KEY/wireCacheTtl 调用点    | `src/index.ts`                                                                        |
| 定时器 unref 范式                        | `src/hud/index.ts`, `src/workflow/worker-source.ts`, `src/web-search/resilience.ts`   |
| `before_provider_request` 链式语义       | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:820-851` |
| onPayload 接线到 provider                | `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:206-213`               |
| Anthropic payload 构造 + max_tokens 字段 | `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:372-376,727-745`   |

## 未找到 / 待确认

- 未找到仓库内公共的"mock ExtensionAPI/ExtensionContext test harness"文件，各模块测试均手搓 stub。
- 未确认 `ctx.sessionManager` 是否提供任何"追加一条不对应真实回合的 usage 记录"的写入 API（本次调研认为即使存在也不建议用于 keepalive 场景）。
