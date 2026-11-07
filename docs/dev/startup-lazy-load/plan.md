# pi 启动慢：子系统懒加载方案（startup-lazy-load）

> 状态：设计定稿（待开发）。范围：`src/index.ts` 的 activate 时序 + 各子系统装配点。
> 前置实测：run `r_R4MZ4W0E` —— activate() 本体 43ms；4s 几乎全部花在 jiti 模块求值
> （643 文件、约 24 万次 statSync + NodeError 构造）。本方案只处理「谁来求值、什么时候求值」，
> 不改任何子系统的运行逻辑。

---

## 1. 背景与目标

### 1.1 问题

`src/index.ts` 静态 import 了 40 余个子系统入口。pi 用 jiti（`moduleCache: false`）逐文件
解析/编译 TS，模块图是**启动阻塞路径**上的成本，与功能是否被使用无关。

静态可达统计（`src/index.ts` 的值导入闭包，见 §2.2）：

| 口径                            | 文件数         | 字节       |
| ------------------------------- | -------------- | ---------- |
| 全部 import（含 `import type`） | 698 / 1077     | 9.3 MB     |
| 仅值导入（剔除纯类型边）        | **641 / 1077** | **8.5 MB** |

### 1.2 关键前提（决定方案形态）

用户实测配置**几乎全部子系统都开**（webHub/lan/spawn/proxy、fabric+xs+threads、feishuBot、
traffic、schedule、workflow、memory 全 true，仅 droid off）。

因此：

- **「off 才跳过」不是收益来源**，它只是附带收益（次级路径、CI/精简配置、子会话）。
- 主收益必须来自 **「即使 on，也把求值移出启动阻塞路径」**：先让 pi 过一个可交互的启动，
  再在后台把子系统求值/装配跑完。

### 1.3 目标

| 指标                                              | 现状              | 目标                                     |
| ------------------------------------------------- | ----------------- | ---------------------------------------- |
| activate() 返回（pi 可继续启动）                  | 4.0 s（含模块图） | ≤ 0.9 s（静态核心 141 文件）             |
| 首屏可交互（TUI 起来、能输入、能按 `/` 看到命令） | 4.0 s+            | ≤ 1.0 s                                  |
| 首回合准备完成（工具表/提示段/钩子全部就绪）      | 4.0 s             | ≤ 2.0 s（后台 501 文件并行求值）         |
| 功能/输出                                         | —                 | **逐字节不变**（A/B 类 golden 全部不动） |

### 1.4 约束

- I2 assembly only：`src/index.ts` 仍只做「注册」，注册逻辑可以下沉到 `src/bootstrap/`。
- I3 pre/post-guard 边界不变：secure guard、command capture、child wiring 必须在 guard 前，
  且必须在**任何其他 handler 之前**注册（首 `handled`/`block`/`cancel` 胜出）。
- I4 无模块级可变状态：懒加载的「就绪 promise」必须每次 `activate()` 新建（`/reload`
  与 `/new` 都会重新 activate，见 §3.1）。
- I9 off ⇒ byte-identical、I11 secure 强制关闭：本方案不改变任何「是否装配」的判断，
  只改变「何时求值」。
- 零依赖：无新 npm 包。

---

## 2. 现状摘要

### 2.1 pi 侧加载协议（`@earendil-works/pi-coding-agent` dist 实测）

| 事实                                                                                                                                          | 坐标                                                      | 对本方案的意义                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 工厂**可以 async**，pi 会 await                                                                                                               | `core/extensions/loader.js:517` `await factory(load.api)` | 但见下一行：await 期间 pi 仍阻塞                                                                                               |
| factory await 期间 **pi 启动被阻塞**（`loadExtensionsInternal` 逐个 await，`createAgentSessionServices` 在 `createAgentSessionRuntime` 之前） | `loader.js:556-577`、`cli.js` createRuntime               | **「activate 里 await import」= 没省，只是换了个地方等**。必须 `void` 起后台                                                   |
| 加载期（`state==="loading"`）`registerTool/registerCommand/on` 全部允许，写入 `extension.*` 并被 `load.commit()` 接管                         | `loader.js:200-270, 424-440`                              | activate 同步注册是安全的；commit 之后的注册也允许                                                                             |
| `load.commit()` 之后 `registerTool` 会调用真正的 `runtime.refreshTools` → `_refreshToolRegistry()`                                            | `loader.js:243`、`agent-session.js:2803/2870`             | 迟到注册工具会**中途重算工具表**（提示缓存前缀风险），见 §6.1                                                                  |
| 事件 handler 在**派发时**从 `ext.handlers` 现取快照                                                                                           | `runner.js:88`、`runner.js:813-839`                       | 迟到注册的 hook 立刻生效，且**只影响之后的事件**                                                                               |
| `session_start` 由 `agent-session.js:2680` awaited emit，发生在 TUI 初始化（含 autocomplete）之后                                             | `agent-session.js:2680`、`interactive-mode.js:1543`       | **session_start 是天然的「已交互」时机，但命令表已经冻结**                                                                     |
| 命令补全表在 `setupAutocompleteProvider()` **构建一次快照**，只在 editor 替换 / `addAutocompleteProvider` 时重建                              | `interactive-mode.js:465-558`                             | **activate 之后注册的命令不会出现在 `/` 菜单**（仍可直接输入执行，`isExtensionCommand` 现查 `getCommand()`）→ 命令必须同步注册 |
| `hasHandlers()` / `getRegisteredCommands()` 都是现读                                                                                          | `runner.js:521-530, 588`                                  | TUI 其余表面无快照问题                                                                                                         |

**结论（回答问题①）**：pi 不存在「activate 返回后、事件派发前」的可利用空档——返回后紧接着是
`session_manager` 构建、TUI init、`session_start`、`before_agent_start`、首回合。唯一安全的
「后台窗口」是：**activate 返回 → 用户第一次输入的这段时间**（TUI 起来后的人思考时间，通常
数秒），以及 `session_start` 内部允许 await 的装配阶段。因此方案是两段式：
**A 段（同步，工厂内完成）+ B 段（后台，activate 返回后立即开跑，session_start 处设闸门等它）**。

### 2.2 现有代码结构

| 文件                      | 作用                                                                                                                                                                                                                                                                                                                                     | 静态闭包（含自己）                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/index.ts`（1176 行） | 唯一 assembly：pre-guard 段（secure/capture/web_search/date/todo/promptHub/memory/bash-child/child-wiring）→ HOST_KEY → settings 加载 → post-guard 段（xs/ask_user/cache-ttl/compact/quota/bash/tools/schedule/fabric-surface/workflow/goal/agent、task、mention、web-hub、topic-switch、traffic）→ 两个 `session_start/shutdown` 处理器 | 641 文件 / 8.5 MB                                                                                      |
| `src/stack.ts`（2425 行） | 每 `session_start` 构建会话栈；语义上是「运行时胶水」                                                                                                                                                                                                                                                                                    | 297 文件，其中 **159 文件（2.0 MB）仅经 stack.ts 可达**（fabric/bash/cache-ttl/quota/workflow 的实现） |
| `src/holder.ts`           | `StackHolder` 晚绑定                                                                                                                                                                                                                                                                                                                     | 极小（但经类型边牵出 web-hub 类型，可擦除）                                                            |
| `src/config/settings.ts`  | 设置解析：**值导入**了每个子系统的 `*/settings.ts`                                                                                                                                                                                                                                                                                       | 47 文件 / 578 KB（其中 memory 3、fabric 3、sysload 2、web-hub protocol 6）                             |
| `src/commands/capture.ts` | 命令捕获代理（activate 第一梯队）                                                                                                                                                                                                                                                                                                        | 值导入 `web-hub/protocol/messages.ts`（干净，仅协议常量）                                              |

子系统边际成本（相对「守卫核心」闭包 64 文件 / 963 KB 的增量）：

| 入口                                                                                 | 增量文件                                | 增量字节    |
| ------------------------------------------------------------------------------------ | --------------------------------------- | ----------- |
| `src/stack.ts`                                                                       | 238（含 memory/fabric/schedule 等再入） | 3.3 MB      |
| `src/web-hub/agent/index.ts`                                                         | 90                                      | 1.3 MB      |
| `src/memory/index.ts`（+ `memory/` 全部）                                            | 74（共 131）                            | 1.0 MB      |
| `src/child/wire.ts`                                                                  | 58（共 107）                            | 814 KB      |
| `src/todo/index.ts`                                                                  | 40                                      | 758 KB      |
| `src/tools/register.ts`                                                              | 39（共 48）                             | 598 KB      |
| `src/commands/status.ts`（`/agent`）                                                 | 42                                      | 516 KB      |
| `src/fabric/stack.ts`                                                                | 29                                      | 355 KB      |
| `src/bash/host.ts`                                                                   | 17                                      | 354 KB      |
| `src/fabric/xs/activate.ts`                                                          | 22                                      | 338 KB      |
| `src/traffic/index.ts`                                                               | 24                                      | 333 KB      |
| `src/cache-ttl/cache-ttl.ts`                                                         | 23                                      | 307 KB      |
| `src/commands/webhub.ts`                                                             | 15                                      | 308 KB      |
| `src/compact-hint/register.ts`                                                       | 22                                      | 269 KB      |
| `src/quota/index.ts`                                                                 | 20                                      | 232 KB      |
| `src/workflow/orchestrator.ts`                                                       | 10                                      | 229 KB      |
| `src/schedule/agent/wire.ts`                                                         | 14                                      | 223 KB      |
| `src/tools/workflow-tool.ts`                                                         | 26                                      | 461 KB      |
| 其余（hud/title/feishu/session-nav/sysload/reload/goal/mention/date/web-search/rpc） | 各 2–9                                  | < 120 KB/项 |

---

## 3. 总体设计

### 3.1 三段式加载

```
                       pi 进程启动
                            │
        ┌───────────────────▼───────────────────────────────────────────┐
   A 段 │ await factory(api)  —— 同步、无 await、目标 ≤ 0.9s             │
  同步 │ 1. initSecureDomain()（第一句，不变）                          │
        │ 2. wrapCommandApi（capture 代理，不变）                        │
        │ 3. readSettingsNoMigrate → HOST_KEY 判定 isChildSession        │
        │ 4. 子会话：wireChildSession / bashChild / trafficChild（B 段异步化，见 §5）│
        │ 5. 主会话：claim → 全量 settings → 注册顺序骨架（§4）           │
        │    · 所有 pi.on / registerTool / registerCommand / renderer     │
        │    · 全部用 A 段就能拿到的模块；重活进 lazy-core               │
        │ 6. void bootstrap(api, ctx)  ←—— 关键：不 await                │
        └───────────────────┬───────────────────────────────────────────┘
                            │ return
                  pi 继续：sessionManager、TUI init、autocomplete 快照
                            │
        ┌───────────────────▼───────────────────────────────────────────┐
   B 段 │ bootstrap()（后台，单条 await import 链）                      │
  后台 │ import("./bootstrap/deferred.js")  ← 唯一入口桶（§5.2）         │
        │  → memory → fabric/xs → schedule → web-hub → traffic → …       │
        │  → resolve readiness（成功/降级都 resolve，永不 reject）        │
        └───────────────────┬───────────────────────────────────────────┘
                            │
                  pi emit session_start（awaited）
        ┌───────────────────▼───────────────────────────────────────────┐
   C 段 │ 我们的 session_start 处理器（B 段注册的，排第一）              │
  闸门 │ await readiness（总预算上限，§6.2）                            │
        │ → buildSessionStack()（stack.ts 此时才求值）                  │
        └───────────────────┬───────────────────────────────────────────┘
                            │
                  before_agent_start → 首回合（工具表/提示段已完整）
```

**为什么 C 段要 await**：工具表与系统提示段必须在**第一回合之前**完整（否则首回合模型看不到
`message_session`/`schedule` 等工具，且中途补充会打断提示缓存前缀）。`session_start` 是 pi 唯一
保证在「首回合之前、TUI 已就绪」的 await 点，也是栈构建的既有位置。

**为什么 B 段不 await 在 activate 里**：见 §2.1 第 2 行——factory 的 await 仍然阻塞 pi。

### 3.2 与「首次使用时才加载」的取舍

| 形态                                  | 用户感知                                                                                                                                                          | 结论                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 启动时并行 async（本方案）            | 首屏快；首回合最多多等 `max(0, B 段剩余)`；命令、工具、提示段完整                                                                                                 | **采用**                                                                                    |
| 首次使用时才加载（lazy-on-first-use） | 首屏最快；但首次 `/webhub`、第一次派 subagent、第一次发 xs 消息时卡 300–1200ms，且**工具表无法中途补齐**（会撕提示缓存），`before_agent_start` 的提示段也无法后补 | 仅用于「纯 UI/命令、无工具、无提示段」的子系统（web-hub hub 内 UI、`/webhub` 的部分子命令） |

### 3.3 模块划分

```
src/
  index.ts                     A 段：只剩「顺序骨架」，不 import 任何子系统实现
  bootstrap/
    static.ts                  A 段共享的轻东西（settings 切片、holder、caps、clock 再导出）
    deferred.ts                B 段唯一入口桶：按序 import 各子系统并调用其 wire 函数
    readiness.ts               per-activation 的 ReadinessGate（promise + 超时 + 降级记录）
  (各子系统不变)
```

依赖方向：`index.ts → bootstrap/*`；`bootstrap/deferred.ts → 各子系统`；**子系统不得 import
`bootstrap/`**（用 `tests/boundary` 加一条规则钉住）。

### 3.4 稳定性关键：单桶 + 单次 import

jiti `moduleCache: false` 的实测后果（本次用真 jiti 验证）：

| 场景                                                       | 结果                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| 同一模块被静态边与 `import()` 各引一次（同一次 jiti 载入） | **同一实例**（`a.av === lazy1` → true）                   |
| 两个不同入口文件各自 `import()` 同一模块                   | **两份实例**（`fromA === fromB` → false，模块体执行两次） |
| 重新 `jiti.import` 同一入口                                | 新实例                                                    |

⇒ **B 段必须是「一次 `import()` 一个桶」**，不许拆成多个各自 `import()` 的入口，否则
`Symbol.for` 单例的一半（如 `getXsWakeLedger`、`getChildBashRegistry` 之外的模块级 Map）、
`instanceof` 判断、去重集合会分裂成两份，出现「注册了两次/只有一半看到」。这条是硬约束。

### 3.5 per-activation 生命周期（I4）

`/reload`、`/new`、`fork`、`resume` 都会**重新 activate**（`agent-session-runtime.js` 的
`createRuntime` → `resourceLoader.reload()` → jiti 重新 import）。因此：

- `readiness`、`bootstrap` 的 promise **必须**在 `activate()` 内部新建，不得挂 `Symbol.for`；
- B 段每个子系统写入的全局（`Symbol.for("pi-subagent:*")`）必须保持「幂等 + 容量/TTL」，与今天一致；
- `activate()` 的第 N 次调用后，第 N-1 次的 B 段若还没跑完，必须能**自我作废**：每个子系统
  wire 前检查 `activationGeneration === current`（模块内比较 token，不写全局），过期即直接 return。

---

## 4. 接口契约

### 4.1 注册与就绪分离（核心契约）

```ts
// src/bootstrap/readiness.ts —— 每次 activate() 一个实例
export interface ReadinessGate {
  /** B 段 promise；永不 reject（错误被记录为 degraded）。 */
  readonly ready: Promise<void>;
  /** B 段某子系统完成时调用（一次性，重复调用忽略）。 */
  settle(id: DeferredId): void;
  /** 记录降级并立即放行（例：某子系统 import 抛错）。 */
  fail(id: DeferredId, err: unknown): void;
  /** 已降级项（供 HUD `/agent status` 与错误横幅读取）。 */
  degraded(): ReadonlyArray<{ id: DeferredId; reason: string }>;
  /** 强制放行（总预算到期时由闸门调用）。 */
  release(reason: string): void;
}
export type DeferredId =
  | "memory"
  | "fabric-xs"
  | "schedule"
  | "web-hub"
  | "traffic"
  | "quota"
  | "external"
  | "workflow"
  | "compact"
  | "bash"
  | "plugins"
  | "stack";
export function createReadinessGate(budgetMs: number): ReadinessGate;
```

约束：

- `ready` 在**所有 id settle 或 budget 到期**时 resolve，**绝不 reject**（否则一条 `void
bootstrap()` 的未处理拒绝会污染进程）。
- 单个子系统的 `settle` 必须在其**所有注册完成之后**才调用（注册是同步的，所以
  `settle` 紧跟在 wire 返回值之后）。
- 所有 `pi.on` 的 handler 若需要某子系统，统一 `await gate.ready` 或 `await gate.until("id")`：
  ```ts
  until(id: DeferredId): Promise<boolean>   // 该子系统 settle/fail 后 resolve；budget 到期 resolve(false)
  ```

### 4.2 A 段注册骨架的顺序契约

A 段注册的**调用序列必须与今天逐项一致**（`tests/fixtures/governance/activate-trace.json`），
仅当某项的实现来自 B 段时，改为「注册时只捕获 deps，handler 内 await」。为此引入两个最小工具：

```ts
// 1) 工具：把重实现推迟到调用期
export function lazyTool<T>(make: () => Promise<T>, build: (impl: T) => ToolDefinition): ToolDefinition;
//    语义：ToolDefinition 的 name/label/description/parameters 必须在 A 段就能给出（见 §6.1），
//    execute() 内部 await make() 后转交 impl.execute。

// 2) 命令：同上，但更宽松（TUI 只需 name/description/getArgumentCompletions）
export function lazyCommand(make: () => Promise<CommandImpl>, desc: CommandDescriptor): CommandSpec;
```

**A 段可用的静态描述来源**：命令/工具的 `name/label/description/parameters` 必须来自
`src/bootstrap/static.ts` 里的**常量表**（从现有实现搬出，逐字节照抄），由 golden 钉住。
这一条是 I9 的硬门槛：不能在 lazy 之后「现读实现再回填」——注册必须一次成型。

### 4.3 B 段入口

```ts
// src/bootstrap/deferred.ts —— 唯一桶
export interface BootstrapDeps {
  pi: ExtensionAPI;
  gate: ReadinessGate;
  holder: StackHolder;
  settings: AgentSettings; // 已加载的完整设置（A 段同步读到）
  secureDomain: SecureDomain;
  isChildSession: boolean;
  wipe: WipeRefs; // 所有跨段 late-bound ref（askUserRemoteRef、webHubRef、…）
  gen: number; // activation 生成号
}
export async function runBootstrap(deps: BootstrapDeps): Promise<void>;
```

`src/index.ts` 里的调用点（唯一）：

```ts
const gate = createReadinessGate(settings.startup.deferredBudgetMs /* 默认 8000, 0=关闭懒加载 */);
const gen = ++activationGen;
void runBootstrap({ ...deps, gate, gen }).catch((e) => gate.fail("stack", e));
```

`settings.startup.deferredBudgetMs = 0` ⇒ A 段直接 `await runBootstrap(...)`（**逐字节回到今天的
时序**，用于排查与回滚；I9 的逃生门）。

---

## 5. 子系统分级表

判据（按优先级）：

1. **必须 A 段**：I3 要求（pre-guard / 首 handler / capture）、pi 快照要求（命令表、工具表）、
   或字节级输出依赖（提示段顺序）。
2. **B 段**：注册本身是「一次性的 `pi.on/registerTool`」，实现可延迟。
3. **首用时**：无工具、无提示段、纯命令/纯 UI。

### 5.1 主会话

| 子系统                                                                                    | 分级                         | 理由                                                                                                                       | B 段/首用时求值规模        |
| ----------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `secure/domain` `secure/guards`                                                           | **A（第一句）**              | I3/I11：D2/D3/D4 必须首注册                                                                                                | 6 文件                     |
| `commands/capture`                                                                        | **A**                        | activate 首行包装 `registerCommand`，捕获所有命令                                                                          | 值边仅 protocol/messages   |
| `config/settings`                                                                         | **A**                        | 所有门控的前提                                                                                                             | 47 文件（见 §7 包 1 拆分） |
| `adapters/pi-compat`                                                                      | **A**                        | `detectPiCapabilities` / compat gate 决定后续                                                                              | 7 文件                     |
| `holder` + `stack-teardown`（类型）                                                       | **A**                        | 所有晚绑定端口                                                                                                             | ~2 文件                    |
| `sysprompt/hub`                                                                           | **A（骨架）**                | 唯一 `before_agent_start`/`context_with_system` 前注册者；**段内容可后补**（section provider 是函数，B 段完成前返回 SKIP） | 7 文件                     |
| `sysprompt/core-sections`（types/models 段）                                              | **A**                        | 提示段顺序 memory→types→models→schedules                                                                                   | 4 文件                     |
| `date` / `web-search` / `todo`(nudge)                                                     | **A（注册）/ B（实现）**     | 小（17/30/— KB），pre-guard 且 child 也要                                                                                  | ≤ 6                        |
| `memory`                                                                                  | **A（必须）/ B（重实现）**   | 见下方 ⚠️                                                                                                                  | 131 文件                   |
| `bash/child` `child/wire`                                                                 | **A（child 分支）**          | I6：child 无 session_start，必须 activate 期注册                                                                           | 107 文件                   |
| `traffic`(child)                                                                          | **A（child）/ B（main）**    | 子会话只注册录制钩子                                                                                                       | 29                         |
| `fabric/xs/activate`（工具组 + `/fabric`）                                                | **A（工具注册）/ B（实现）** | 工具表顺序是 golden 契约（`message_channel` 之后紧跟 `thread`）                                                            | 46                         |
| `tools/register`（7 个核心 subagent 工具）                                                | **A（注册）/ B（实现）**     | 工具表 + `agent-nested-surface-golden.json` 冻结                                                                           | 48                         |
| `compact-hint/register`（compact 工具 + hooks）                                           | **A（注册）/ B（实现）**     | 与 quota 共 `turn_end`                                                                                                     | 23                         |
| `bash/host`（bash 覆盖 + `bash_job`）                                                     | **A（注册）/ B（实现）**     | golden `bash-tools-golden.json`                                                                                            | 23                         |
| `ask-user`                                                                                | A（工具注册）/ B             | 工具表                                                                                                                     | 14                         |
| `quota` / `sysload`                                                                       | B                            | 纯 `turn_end` hook + 端口                                                                                                  | 20 / 14                    |
| `schedule`（工具 + `/schedule` + 提示段）                                                 | A（注册）/ B                 | 提示段顺序最后；工具表                                                                                                     | 32                         |
| `workflow`（`SubagentWorkflow` 工具）                                                     | A（注册）/ B                 | 工具表（stub/real 二选一在 A 段由 settings 决定）                                                                          | 62                         |
| `goal`（`/goal` + 两个 hook）                                                             | A（注册）/ B                 | 小                                                                                                                         | 3                          |
| `web-hub/agent`（`/webhub` + 连接）                                                       | **A（命令注册）/ B（实现）** | 命令描述必须同步；连接、LAN、spawn 全部 B                                                                                  | 116                        |
| `web-hub/hub` + `web-hub/ui`                                                              | **首用时**                   | 守护进程在独立进程/首次 `/webhub start` 才需要                                                                             | 0（主进程）                |
| `feishu-notify` / `hud` / `session-nav` / `title` / `reload` / `topic-switch` / `mention` | A（注册）/ B（实现）         | 各 ≤ 9 文件，全部 post-guard、纯 hook/editor                                                                               | ≤ 60 合计                  |
| `external-agent`                                                                          | B                            | 只在 spawn 时用                                                                                                            | 24                         |
| `commands/status`（`/agent`）                                                             | A（命令注册）/ B（实现）     | 名字+描述同步；857 行的实现 B 段                                                                                           | 100                        |
| `stack.ts` + `buildSessionStack`                                                          | **C 段闸门内**               | 见 §3.1                                                                                                                    | 297                        |

⚠️ **memory 的特殊性**：`memory` 的提示段（首个系统提示段）与 guard 必须在
**第一次 `before_agent_start` 之前**就位，否则会出现「首回合没有记忆段、第二回合才有」的
提示缓存撕裂。所以：

- A 段：`promptHub.register("memory", provider)`，provider 在 B 段未就绪时返回 `SKIP`；
- C 段闸门：`await gate.until("memory")` 是**强制**的（不参与总预算放行），预算只对其它 id 生效。
- memory 的 74 个实现文件在 B 段求值 → 首回合会为它多等约 200–400ms（占 B 段大头）。

### 5.2 child 会话（I6）

子会话的 activate 走 pre-guard 分支后**立即 return**，因此：

- 静态闭包 = 守卫核心（60 文件）+ `child/wire` 闭包（107，与核心重叠后约 60 增量）≈ **120 文件**；
- B 段只有：`memory`（child 版段）、`traffic`(child)、`bash`(child)、`todo`(nudge)、`web-search`、`date`；
- 收益：每个子会话的启动从 ~4s 量级降到 ~1s 量级。subagent 派发延迟显著下降（这条对用户是
  第二大收益，仅次于主会话首屏）。

### 5.3 「off 跳过」的附带收益

`settings.x.enabled === false` 时 B 段直接不 import 该子树（今天也是不 wire，但模块照求值）。
对默认配置（多数子系统 off）能再省 300+ 文件；对本用户 ≈ 0，故不作为验收指标。

---

## 6. 契约处置

### 6.1 工具表 / 命令表 / 提示段（对外可见面）

| 面                     | pi 行为                                                                                        | 处置                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具表                 | `registerTool` 在 commit 后会触发 `_refreshToolRegistry`，中途变化会改工具声明（提示缓存前缀） | **A 段一次性注册全部工具**；`parameters` 与 `description` 从 `bootstrap/static.ts` 常量取（golden 钉死）；只有 `execute` 延迟取实现                   |
| 命令表                 | autocomplete 在 TUI init 时快照一次；行内执行现查                                              | **A 段一次性注册全部命令**（`name/description/getArgumentCompletions` 同步）。缺 `getArgumentCompletions` 的实现时返回 `[]`（与今天无补全的命令等价） |
| 提示段                 | `promptHub` 注册顺序 = fold 顺序                                                               | 注册（顺序）全在 A 段；provider 内容可延迟（返回 `SKIP`），memory 例外（§5.1 ⚠️）                                                                     |
| message/entry renderer | 现查                                                                                           | A 段注册；渲染函数内部按需 import（渲染是低频路径）                                                                                                   |
| 事件 hook              | 派发时快照                                                                                     | A 段注册；handler 首行 `if (!gate.settled("x")) await gate.until("x")`                                                                                |

**这是本方案最重要的一条取舍**：不做「B 段补注册工具/命令」，因为那会同时踩工具表中途变更
和 autocomplete 快照两个坑；代价是 A 段仍要解析工具/命令的 schema 常量（约 +600–1200ms 中的
一部分，已计入 141 文件）。

### 6.2 就绪闸门与超时（回答问题②）

| 时刻                                     | 用户动作                              | 行为                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| t < B 段完成                             | 按 `/`                                | 命令全在（A 段注册）→ **无差异**                                                                                                                                |
| t < B 段完成                             | 执行 `/agent`、`/webhub`、`/schedule` | handler 内 `await gate.ready`（带总预算）→ UI 显示既有的 working 指示；完成即执行。**不报错**                                                                   |
| t < B 段完成                             | 直接发消息                            | `before_agent_start` → `await gate.ready`；典型完成时间远小于用户打字时间                                                                                       |
| B 段某项失败                             | 任意                                  | `gate.fail(id)` → 放行；该子系统与今天「wire 抛错」同构（已注册的 hook 内部降级为 no-op）；`/agent status` 显示 `deferred degraded: <id>`；**不影响其它子系统** |
| B 段超过 `deferredBudgetMs`（默认 8000） | 任意                                  | `gate.release()` → 放行；未就绪子系统标记 degraded（其工具 `execute` 抛「subsystem not ready」而非挂死，符合 I1 零挂死精神）                                    |

关键：**永不 hang、永不 reject、永不因为懒加载而少注册**（少的是「实现」，不是「表面」）。

### 6.3 `activate-trace.json` 的处置

- 形态：`traceActivation` 目前是 `activate(pi)` 同步记录（`tests/helpers/activation-trace.ts:56`）。
- 改法：`activate()` 返回 `void`，但导出 `export const bootstrapSettled: Promise<void>`（模块级
  **只读** promise，`/reload` 后由新 activate 重新赋值——测试里逐个 `import` 模块即可）。
  测试 helper 在 `activate(pi)` 之后 `await flushActivation()`（内部 `await bootstrapSettled` +
  `setImmediate ×2`）。
- **golden 内容不变**：B 段的注册与 A 段发生在同一个 `pi` 上、同一个顺序，`calls` 数组应逐字节
  相同。若因拆分产生任何差异，**属于声明式变更**：用
  `PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance` 刷新并在 commit 里写明「仅加载时机，
  顺序未变」，同时**在 code review 里逐项确认 diff 只有 "两个相邻注册之间插入了别的子系统" 这种
  不可接受的情况为零**。
- 保护网：新增一条**顺序无关**的断言（`tests/governance/activate-surface.test.ts`）：
  比较「A 段结束时」与「全部 settle 后」的 `calls` 集合差集必须为空（`A ⊆ full` 且 `full == golden`）。

### 6.4 I9（off ⇒ byte-identical）

- 「off 不 import」天然满足：模块未求值 ⇒ 无 hook/无 prompt/无输出。
- 「on 但延迟」的风险点是 §6.1 的三张表，处置后不存在差异。
- 额外的机器证明：新增 golden 对比 `tests/governance/lazy-off-golden`：
  `deferredBudgetMs: 0`（=同步路径）与默认懒加载路径，对同一 profile 跑
  `activate → session_start → before_agent_start → turn_end → session_shutdown`，
  记录 `calls` + `sendMessage` + 提示段全文，两者**必须逐字节相同**。这是本方案的主回归门。

### 6.5 I5 / I11

- I5：B 段不得新增 ref'd timer；`ReadinessGate` 的总预算用 `setTimeout(...).unref()`，
  并在 settle 时 clear。
- I11：B 段的所有 wire 依旧读同一份 `settings`（secure 域已强制关闭的项在 settings 层就是
  `false`），因此 D8 强制关闭项**不会**因为「晚加载」被绕过——它的门控在 settings 解析期已完成。

---

## 7. 实施拆分（按依赖序）

> 每个包可独立合并、独立验收；包 0 是全部前置。

### 包 0 — 就绪闸门与 trace 基础设施（不改变任何加载时机）

- 新增 `src/bootstrap/readiness.ts`、`src/bootstrap/static.ts`（只搬常量，不求值实现）。
- `src/index.ts` 末尾 `void runBootstrap(...)`，`runBootstrap` 暂时**同步调用原来的 post-guard 段**
  （即行为完全不变，只是多了一层 promise）。
- 测试：`readiness` 单测（settle/fail/budget/release/degraded）；`flushActivation` helper；
  `activate-trace` 加 `await flush`。
- 验收：**全部 golden 零 diff**、`npm test` 全绿。这一包证明「闸门本身不改行为」。

### 包 1 — settings 拆分（收益最大、风险最低的物理拆分）

- `src/config/settings.ts` 拆为 `settings-core.ts`（A 段必须：secure/webHub.enabled 判定、
  启动期门控字段）+ 各子系统 `*/settings.ts` 的**惰性 section getter**
  （`loadSubsystemSettings(name)`，A 段只解析「B 段是否需要它」的布尔）。
- 边界：settings 的类型面（`AgentSettings`）不变；只是**值解析**分段。
- 验收：`available-models-golden`、`settings-file-identity`、secure 系列 golden 零 diff；
  新增「settings 解析幂等」性质测试（同一份文件解析两次结果相同）。

### 包 2 — A/B 切分的机械迁移（逐个子系统，可用子包并行）

对每个子系统，只做三件事：

1. 把「注册调用」留在 `index.ts`（顺序不变），参数改成 lazy deps；
2. 把「实现 import」搬进 `bootstrap/deferred.ts`；
3. 用 `lazyTool` / `lazyCommand` / `until(id)` 接上。

推荐子包顺序（每包都自带独立的 off-golden）：
`2a` hud/feishu/session-nav/title/reload/topic-switch/mention/date/web-search（≤60 文件）
→ `2b` compact-hint/quota/sysload/bash → `2c` ask-user/todo → `2d` traffic/external-agent
→ `2e` schedule → `2f` fabric/xs+thread（工具组顺序最敏感，单独一包）
→ `2g` web-hub/agent（最大，116 文件）→ `2h` workflow/goal → `2i` memory（最后，因 §5.1 ⚠️）
→ `2j` `stack.ts` 推迟到 C 段（最大的单块，238 文件）。

- 每个子包验收：该子系统 off-golden + `activate-trace` + 该子系统的既有测试全绿；
  用 `PI_STARTUP_BENCHMARK=1` 或自建计时脚本记录 `activate` 返回时刻。

### 包 3 — 子会话路径

- `child/wire`、`bash/child`、`traffic/child`、`memory`(child) 接同一套闸门；
- 验收：`child-session-marker`、`fabric-xs-child-scope`、spawn 全链路（真实子进程）绿；
  子会话 `activate` 计时对比。

### 包 4 — 文档与可观测

- `/agent status` 增加 deferred/degraded 行；HUD 启动耗时一行（`boot 0.9s+1.4s`，英文 token）。
- 更新 `AGENTS.md`：新增 I13「懒加载契约」——A 段禁止 `await`；B 段单桶；注册在 A、实现在 B；
  `deferredBudgetMs: 0` 必须回到同步路径。README：`docs/dev/startup-lazy-load/README.md`
  （不变式 + 残留风险）。

---

## 8. 验收矩阵

| #   | 场景             | 手段                                                                                             | 阈值/断言                                                              |
| --- | ---------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| V1  | 启动耗时         | `PI_STARTUP_BENCHMARK=1 pi` 计时 + 自建 `activate` 打点（无需改 pi）                             | activate ≤ 0.9s；首屏 ≤ 1.0s；首回合计 ≤ 2.0s                          |
| V2  | 对外可见面零变化 | §6.4 的 `lazy-off-golden`（同步 vs 懒加载全流程对比）                                            | 逐字节相同                                                             |
| V3  | 注册顺序         | `activate-trace.json`（5 profile）+ §6.3 的 surface 断言                                         | 数组逐项相同；`A ⊆ full`                                               |
| V4  | 工具表面         | `agent-nested-surface-golden.json`、`bash-tools-golden.json`、`memory-tool-surface.json`         | 不动                                                                   |
| V5  | off 路径         | `fabric-xs-off`/`fabric-wake-off`/`schedule-off`/`secure-off`/`thread-off`/`compact-hint` golden | 不动                                                                   |
| V6  | 早用命令         | 集成测试：`activate` 后**不** settle 立即执行 `/agent`、`/webhub status`、`/schedule list`       | 阻塞后成功；无异常抛出                                                 |
| V7  | 早发消息         | 集成测试：`activate` 后立即 `before_agent_start` → 首请求                                        | 工具表/提示段完整（含 memory 段）                                      |
| V8  | 子系统失败隔离   | 注入 `import` 抛错（vi.mock 某个 deferred 模块）                                                 | 其余子系统正常；`/agent status` 显示 degraded；进程不崩                |
| V9  | 超预算           | `deferredBudgetMs: 50`                                                                           | 放行、degraded 列表正确、工具 `execute` 给出明确错误                   |
| V10 | reload/new 重入  | 连续 3 次 `session_shutdown(reload)` → `session_start`                                           | 无重复 handler（每事件 handler 计数不变）、无旧 activation 的 B 段落回 |
| V11 | 子会话           | spawn 真实 subagent，检查其 activate 计时与服务可用性                                            | 子会话功能不回退                                                       |
| V12 | 并发首轮         | 两个子 agent 同时启动（B 段并发）                                                                | 无重复注册（`Symbol.for` 单例）、无 module 分歧（§3.4）                |
| V13 | 内存/句柄        | 启动后 30s 内 `process._getActiveHandles()` 无新增 ref'd timer                                   | I5                                                                     |

---

## 9. 风险表

| #   | 风险                                                                                                                                                           | 概率/影响 | 应对                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| R1  | **jiti 多实例导致单例分裂**（§3.4）：拆成多个 `import()` 入口后，同一模块两份实例，`Symbol.for` 之外的注册表（`instanceof`、模块级 Map）成双份 → 双注册/丢消息 | 中/高     | **单桶硬约束**（§3.4）+ V12 测试（并发首轮 + 同一路径双入口探针）                                   |
| R2  | **命令/工具表快照**：B 段补注册命令 → `/` 菜单缺失；补注册工具 → 工具声明中途变化（提示缓存、模型行为漂移）                                                    | 高/高     | §6.1：注册一律 A 段；`lazyCommand/lazyTool` 只延迟实现；V3/V4/V6 钉住                               |
| R3  | **memory/提示段撕裂**：首回合内存段缺失，导致提示前缀与后续回合不同（缓存全失效）                                                                              | 中/高     | §5.1 ⚠️：memory 为强制闸门（不吃总预算）；V7 断言首请求含 memory 段                                 |
| R4  | **激活重入**（`/reload`、`/new`、`fork`）：旧 B 段晚到，往新 activation 的 `pi` 上注册                                                                         | 中/高     | activation `gen` token + 每步检查；V10                                                              |
| R5  | B 段未处理拒绝（一个 `void promise` 崩进程）                                                                                                                   | 中/高     | `ready` 永不 reject；`runBootstrap` 顶层 `catch → gate.fail`；ESLint/测试禁止裸 `void import()`     |
| R6  | 首回合变慢（B 段没跑完就发消息）                                                                                                                               | 中/低     | 预算 + 关键路径排序（memory、tools 面先 settle，web-hub/traffic 后 settle）；benchmark 记录 P50/P95 |
| R7  | 语义拆分破坏既有测试假设（测试假定 activate 返回后一切就绪）                                                                                                   | 高/中     | 包 0 引入 `flushActivation()`，一次性改 helper；跑全套 1.7 万测试                                   |
| R8  | `settings.ts` 拆分引入「同 key 两处解析」分歧                                                                                                                  | 中/中     | 包 1 的幂等性质测试 + `secure-contract-parity` golden                                               |
| R9  | 延迟改变了「警告/诊断输出时机」（`console.warn` 在首屏之后才出现，TUI 可能吞掉）                                                                               | 中/低     | 诊断统一进 `/agent status` 与 HUD；首屏前的诊断仍由 A 段输出                                        |
| R10 | 宿主与子会话代码代际不一致（记忆：jiti `moduleCache:false`，宿主是上次 reload 的代码）                                                                         | 低/中     | 懒加载不改变这个既有性质；B 段代码与 A 段同一代（同一次 activate 的 import），不引入新错位          |
| R11 | 过度设计（为一个 2.5s 收益引入复杂闸门）                                                                                                                       | 中/中     | 闸门只有 5 个方法、降级即放行；`deferredBudgetMs: 0` 完全回退；不做「按需卸载/重载」                |

---

## 10. 待拍板（开发前需确认）

1. **首回合闸门是否包含 web-hub 连接**：`/webhub` 的 LAN 连接、Feishu 长连是否需要「首回合前
   就绪」（影响首回合计时 +200ms）？建议：连接不设闸门（后台建立），只有工具/命令/提示段设闸门。
2. **`deferredBudgetMs` 默认值**：8000 还是 3000？建议 8000（只在异常情况下才生效）。
3. **`/agent status` 的 deferred 行形态**：英文 token（`deferred: web-hub`）还是折进现有
   `stack` 行。

---

## 附：本文用到的实测数据

- `src/index.ts` 值导入闭包：641 文件 / 8.5 MB（全部 import 含类型：698 / 9.3 MB）。
- 守卫核心（secure+settings+capture+holder+compat）闭包：60–64 文件 / ~0.9 MB。
- A 段「核心 + 工具面」闭包（`secure`+`settings`+`compat`+`tools/register`+`compact/register`+
  `bash/host`+`delivery/stack-hooks`）：**141 文件 / 2.1 MB**。
- B 段各桶闭包合计（去重）：**501 文件 / 6.7 MB**。
- 参照：4.0s / 641 文件 ≈ 6.2 ms/文件（含 jiti 解析 + statSync）；据此 A 段 ≈ 0.87s，
  B 段 501 文件在后台并行约 1.2–1.8s → 首回合 1.5–2.0s，与用户预估一致。
