# Jev Reflex（R 层）· 架构设计 v1（只读 MVP）

> 状态：**架构设计**（无代码）· 日期 2026-11-04
> 上游：`docs/dev/jev-reflex/feasibility.md`（探索结论，下称 F）。本文档与 F 冲突处以本文档为准，§5 列出了全部改动及理由。
> 用户已批准的方向：只读 MVP；默认关闭；先 shadow 运行；简单只读的自省请求在 `input` 阶段拦截，交给确定性 port 回答；只要不确定、失败、超时，或遇到权限 / secure / child / rpc / web 不支持的情况，就无损回退给强模型；复杂任务和写类脚本不进 MVP；后台提取只产出「高频意图 + 候选匹配器」报告，不自动启用，也不从历史里提炼 argv。
> 必读：`AGENTS.md`（I1–I12）、`docs/dev/memory/README.md`（Jev 节）、`docs/dev/sysprompt-stable/README.md`、`docs/dev/topic-switch/README.md`、pi 1.4.0 `docs/extensions.md`。

---

## 1. 背景与目标

### 1.1 要解决的问题

用户常问一类**答案唯一、数据就在进程里**的问题，比如"后台还有几个 job"、"额度还剩多少"、"有几个 subagent 在跑"、"工作区干净吗"。现在这类问题每次都要走一轮完整的模型回合：F §3.3 统计只读类 p50 28s、p90 82s。模型还可能漏看或改写结果。R 层要做的是：在 pi 的 `input` 阶段识别出这类请求，由**确定性的只读 port** 当场作答，全程不调 LLM，p95 ≤ 1.5s。只要有一点不确定，就**原样放行**给强模型。

### 1.2 约束（硬性）

| #   | 约束                                                                                                       | 来源                       |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------- |
| C1  | 唯一能跳过 LLM 请求的通道是 `pi.on("input") → {action:"handled"}`                                          | F §2.2                     |
| C2  | 默认关闭；关闭时 hook、命令、提示词、输出都与今天逐字节相同（I9）                                          | AGENTS I9                  |
| C3  | secure / locked 域强制关闭，且无任何设置路径能重新开启（I11 / D8）                                         | AGENTS I11                 |
| C4  | 子会话保持惰性。子会话的 `session.prompt()` 也报 `source:"interactive"`，所以 R 层**只能** post-guard 注册 | F §2.7、I3/I6              |
| C5  | 零挂死：所有 deadline 都经过 `clampSpanMs`，所有计时器都 `unref()`，shutdown 时中止在飞任务                | I1/I5                      |
| C6  | 不从历史抄命令：会话语料里只有 1.2% 的只读单命令 run 能静态化成 argv                                       | F §3.4                     |
| C7  | 短口令（继续 / 好 / ok）是"启动长任务"的开关，误触发后果最严重，必须硬排除                                 | F §3.5                     |
| C8  | 全仓只有 `src/memory/jev/client.ts` 调用 `ctx.modelRegistry.classify()`                                    | memory README Jev 不变式 3 |

### 1.3 MVP 范围

- **进 MVP**：内置的 4 个只读 port 脚本（`jobs.list`、`fleet.status`、`quota.summary`、`git.status`）；shadow 记账；逐个脚本显式晋升为 autoresolve；`/reflex status|explain|reset`；离线报告脚本（R4 包，可选）。
- **不进 MVP**：写类 / 需确认的脚本；`argv` 类脚本（通用命令执行器）；外部脚本目录加载；槽位参数（比如按 label 查某个 job）；接入分类器（只留接口）；`rpc` / web / print / json / 子会话来源；跨会话统计文件。
- `sessions.recent` 放到 R4 包：它要扫描会话目录，I/O 不可控，见 §4.6 与 §8 Q1。

### 1.4 验收判据（沿用 F §1.2，按 MVP 收窄）

| 判据              | 阈值                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 关即字节相同      | `reflex.enabled=false`（默认）或 secure 域：零注册；`reflex-off-golden.json` 与 activate-trace 的 `default`/`minimal`/`child` 档逐字节不变 |
| 零误答            | autoresolve 抽样复核错误数为 0；shadow 期 `diverge` 率按 §4.8 晋升门槛执行                                                                 |
| 命中延迟          | autoresolve 命中路径 p95 ≤ 1.5s（内存 port 实测应 < 50ms；`git.status` ≤ 1.2s 预算）                                                       |
| 未命中开销        | S0/S1 同步判定 p99 ≤ 1ms（纯内存正则，单测计时）                                                                                           |
| shadow 不改变流程 | shadow 下 handler 在任何 await 之前同步返回 `continue`；用户看到的流程与关闭时一致                                                         |

---

## 2. 现状摘要（相关代码坐标）

### 2.1 `input` handler 的现有注册顺序

pi 按注册顺序依次 await 每个 handler；遇到 `handled` 就短路，`transform` 改写的文本向后传（`runner.js:1201-1231`）。主会话在 `activate()` 里的实际顺序：

| 顺序 | 注册点                                                          | 行为                                                                     | pre/post-guard |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------- |
| 1    | `src/secure/guards.ts:333`（`wireSecureGuards`）                | 锁定时返回 `handled`                                                     | pre            |
| 2    | `src/schedule/agent/surface.ts:84`（schedule 开启时）           | 恒 `continue`（确认面记账）；**#16 落地后删除**（plan r2 §2）            | post           |
| 3    | `src/index.ts:877` `createWakeInputHook`                        | 恒 `continue`（人类输入重置因果层级，**必须**先看到）                    | post           |
| 4    | `src/index.ts:883` xs / rootWakeRecovery                        | 恒 `continue`                                                            | post           |
| 5    | `src/mention/mention.ts:145`（`mention.install`）               | async；`@label` 时返回 `handled`                                         | post           |
| 6    | `src/feishu-notify/index.ts:498`（默认关，secure 下强制关）     | 命中关键词时 `transform`（删掉关键词）                                   | post           |
| 7    | `src/session-nav/index.ts:186`                                  | 裸 `exit` 时返回 `handled`                                               | post           |
| 8    | web-hub 块（`src/index.ts:1031` 起，不注册 input）              | —                                                                        | post           |
| 9    | `src/topic-switch/wire.ts:743`（`src/index.ts:1179`，**最后**） | 同步；只受理 `interactive`/`rpc`；hold 期间吞掉新输入并排队（`handled`） | post           |
| 10   | traffic（`assembleTrafficHost`，不注册 input）                  | —                                                                        | post           |

### 2.2 可复用的部件

| 用途                           | 坐标                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 短口令 / 指代表                | `src/topic-switch/filters.ts:19-60`（`SHORT_REPLY_TABLE`、`ANAPHORA_CJK`、`ANAPHORA_EN`，pi-free）                                                                       |
| 否定 / 取消                    | `src/memory/jev/predict/clauses.ts:98,146`（`negationWithinWindow`、`cancelIntent`，pi-free）                                                                            |
| 命令形状（shadow 比对用）      | `src/memory/jev/predict/shape.ts`（`program [subcommand]`，永不带参数）                                                                                                  |
| 脱敏                           | `src/memory/jev/redact.ts:93` `redactForJev(text, field)`                                                                                                                |
| bash job 数据与渲染            | `holder.current.bashJobs`（`BashJobManager.list()`，`src/bash/manager.ts:365`）；`renderBashJobsSection`（`src/commands/status.ts:526`）                                 |
| fleet 数据                     | `holder.current.query.list()`（`QueryService`，`src/service/query-service.ts:24`）                                                                                       |
| quota 数据与渲染               | `holder.current.quota.verdicts(now)`（同步、只读缓存、永不抛，`src/quota/service.ts:82-90`）；`renderProviderLine`/`buildQuotaTickText`（`src/quota/render.ts:136,142`） |
| 有界 git 执行器                | `src/git/run.ts` `createGitRunner`（无 shell、硬期限、进程组 kill、输出上限、unref）；硬化前缀先例 `VERSION_GIT_PREFIX`（`src/web-hub/hub/version-git.ts:15`）           |
| git porcelain 解析先例         | `src/hud/git.ts:27` `readRepoState`（走 pi.exec，不直接复用，见 §4.6）                                                                                                   |
| topic-switch 栅栏              | `wireTopicSwitch(...).fenceActive()`（`src/index.ts:1195`，已有 `xsFencePorts.topicSwitch` 晚绑定先例）                                                                  |
| goal 忙                        | `stack.goal.record?.state ∈ {active, paused}`（`src/index.ts:1188` 同款）                                                                                                |
| D8 强制关集中点                | `src/config/settings.ts:427` `applySecureDomainOverrides`                                                                                                                |
| settings 分片先例              | `src/topic-switch/{settings,setting-specs}.ts` → `src/config/setting-specs.ts:164`                                                                                       |
| custom 消息标签渲染            | `src/ui/toolkit-message-renderer.ts:21` `TOOLKIT_LABELLED_CUSTOM_TYPES`                                                                                                  |
| 真 AgentSession / TUI 测试夹具 | `tests/conformance/agent-session-harness.ts`、`tests/conformance/tui-harness.ts`                                                                                         |
| trace 金身与档位               | `tests/governance/trace-profiles.ts`（`max` 档）、`tests/fixtures/governance/activate-trace.json`                                                                        |
| pi-free 门禁                   | `tests/boundary/pi-free.test.ts:143`（目录清单）                                                                                                                         |

### 2.3 本设计依赖的 pi 1.4.0 事实（实读）

1. `prompt()` 的执行顺序：`/` 扩展命令 → 压缩中直接 throw → `_runInputHandlers` → skill/模板展开 → 入队或起 run（`agent-session.js:1626-1670`）。**压缩中输入根本到不了 input handler**。
2. **pi 会 await async 的 input handler。** handler 返回 `continue` 时，原文继续走后面的 handler 和正常的 run。这是「回退 = 直接 `continue`」能成立的前提。
3. TUI 主循环是串行的：`while(true){ userInput = await getUserInput(); await session.prompt(userInput) }`（`interactive-mode.js:914-918`）。handler await 期间如果用户又提交了输入，它会进 `pendingUserInputs` 排队，**不会并发进入 prompt**。（`isStreaming` 时那条分支走 steer，与本设计无关，因为本设计只在空闲时受理。）
4. `sendMessage(msg)` 在空闲、没有 `triggerTurn` 时直接 `_appendCustomMessage`，不起 run（`agent-session.js:1847-1886`）；它的内容会以 **user 角色**进入下一轮上下文（F §2.3）。
5. `appendEntry` 写入的条目不进 LLM 上下文（`types.d.ts:1271`）。
6. `ctx.mode ∈ "tui"|"rpc"|"json"|"print"`（`types.d.ts:212`）。print 模式的 `session.prompt(text)` 不传 source，默认就是 `"interactive"`，所以光看 source 不够，**必须再看 mode**。

---

## 3. 总体设计

### 3.1 一句话

R 层是挂在 `input` 上的一个 handler，位置在 web-hub 块之后、topic-switch 之前。流程是：同步否决（S0）→ 同步匹配（S1）→（仅 AUTO 脚本）有界 await 一个只读 port（S2）→ `ok` 才返回 `handled` 并写一条 `subagent:reflex` 消息；其余所有情况都返回 `continue`。**R 层从不重放原文，从不调用 `sendUserMessage`，也从不 transform。**

### 3.2 模块划分与依赖方向

```
src/reflex/
├── core/                         ← pi-free（加入 tests/boundary/pi-free.test.ts 目录清单）
│   ├── types.ts                  RScriptV1 / PortId / PortOutcome / ReflexRecordV1 / ReflexAnswerDetailsV1 / Band / ScriptState
│   ├── schema.ts                 RScriptV1 的 typebox schema + validateScript()（只在测试和 catalog 自检时用）
│   ├── settings.ts               ReflexSettings + DEFAULT + parseReflexSettings()（永不抛）
│   ├── normalize.ts              normalizeInput(text) → {norm, chars, lines}（NFKC、小写、去首尾空白和尾标点）
│   ├── gate.ts                   evaluateGate(facts) → {pass:true} | {pass:false, veto: VetoCode}（S0）
│   ├── match.ts                  compileCatalog(scripts) → Matcher；matcher.match(norm) → MatchResult（S1）
│   ├── catalog.ts                BUILTIN_SCRIPTS: readonly RScriptV1[]（数据，冻结）
│   ├── state.ts                  per-script 状态机（纯 reducer）+ repeat/correction 记账
│   ├── budget.ts                 REFLEX_BUDGET_MS 等常量 + raceBudget()（clampSpanMs + unref 注入时钟）
│   ├── render.ts                 renderAnswer(script, outcome, q, ms) → {content, details}
│   ├── agreement.ts              judgeAgreement(script, modelToolShapes) → Agreement
│   ├── git-status-parse.ts       parsePorcelainV2Z(stdout) → GitStatusFacts（纯函数）
│   └── extract/                  （R4）离线报告的纯函数：episode 归一、聚类、候选匹配器草案、shadow 汇总
├── ports/                        ← 不进 pi-free 门禁（依赖 bash/quota/service 类型），但不 import pi
│   ├── index.ts                  createPortRegistry(deps: ReflexPortDeps) → PortRegistry
│   ├── jobs.ts                   jobs.list
│   ├── fleet.ts                  fleet.status
│   ├── quota.ts                  quota.summary
│   ├── git.ts                    git.status（内部用 src/git/run.ts）
│   └── sessions.ts               （R4）sessions.recent
├── setting-specs.ts              REFLEX_SETTING_SPECS（由 src/config/setting-specs.ts 展开）
├── command.ts                    /reflex status | explain <text> | reset [id]
└── wire.ts                       wireReflex(pi, deps)：唯一的 pi 面装配；所有可变状态都在闭包里（I4）
```

依赖方向（只允许向下）：

```
src/index.ts（装配一行，post-guard）
      │
      ▼
reflex/wire.ts ──► reflex/command.ts
      │   └──────► reflex/ports/* ──► src/git/run.ts, src/bash/types.ts, src/quota/{service,render}.ts,
      │                               src/service/query-service.ts（仅类型 + 现有渲染函数）
      ▼
reflex/core/* ──► src/topic-switch/filters.ts, src/memory/jev/predict/{clauses,shape}.ts,
                  src/memory/jev/redact.ts, src/core/deadline.ts（全部 pi-free）
```

- `core/*` 只能 import pi-free 模块；上面列出的跨子系统 import 都已核实为 pi-free。如果其中某个将来引入了 pi，就在 `core/` 下镜像一份，不放宽门禁。
- `ports/*` 不 import pi；依赖通过 `ReflexPortDeps` 晚绑定注入，测试时直接塞假实现。
- `wire.ts` 是唯一碰 `ExtensionAPI`/`ExtensionContext` 的地方。

### 3.3 运行时数据流

```
input(event, ctx)
  │  S0 gate（同步，零 I/O）── veto ─────────────────────────────► continue（不记录）
  │  S1 match（同步，纯正则）
  │     ├─ miss ─────────────────────────────────────────────────► continue（不记录）
  │     ├─ ambiguous（多脚本 / 只有 weak 命中）─ pending(ambiguous) ► continue
  │     └─ high(script s)
  │          ├─ state(s) ∈ {SHADOW, DEMOTED} ─ pending(shadow) ───► continue（同步返回）
  │          │        └─ queueMicrotask：后台跑 port（同样受预算约束）→ 结果写入 pending
  │          ├─ repeat（同一 digest 在 10min 内已由 reflex 答过）──► pending(repeat) ► continue
  │          └─ state(s) = AUTO
  │                 S2 await raceBudget(port.run(env), budget)
  │                   ├─ ok ─► sendMessage(subagent:reflex, display:true) ──► handled
  │                   └─ 非 ok ─► strike(s)；pending(fallback) ─────────► continue
  ▼
agent_settled(ctx)：有 pending 就从 getBranch() 取本轮模型的工具形状 → judgeAgreement
                    → appendEntry("subagent:reflex-record", ReflexRecordV1)，然后清空 pending
```

---

## 4. 接口契约

### 4.1 设置（`reflex.*`，只有 2 个键）

```ts
// src/reflex/core/settings.ts
export interface ReflexSettings {
  /** 非 live；false 时 wireReflex 根本不会被调用（I9）。secure/locked 域强制 false（D8）。 */
  enabled: boolean;
  /** live；允许 autoresolve 的脚本 id 列表（csv 字符串或 JSON 数组）。空 = 全部只跑 shadow。未知 id 忽略，并在 /reflex status 里提示。 */
  autoResolve: readonly string[];
}
export const DEFAULT_REFLEX_SETTINGS: Readonly<ReflexSettings> = Object.freeze({
  enabled: false,
  autoResolve: Object.freeze([] as string[]),
});
export function parseReflexSettings(input: unknown): ReflexSettings; // 逐字段回退默认值，永不抛（parseTopicSwitchSettings 同款）
```

- `src/config/settings.ts`：`AgentSettings.reflex: ReflexSettings`；`DEFAULT_SETTINGS.reflex`；`parseSettingsSource` 里加 `reflex: parseReflexSettings(value.reflex)`。
- `applySecureDomainOverrides` 里新增一行：`reflex: { ...settings.reflex, enabled: false }`，和 `memory.jev`/`traffic` 并列，注释写明 D8。
- `REFLEX_SETTING_SPECS`：`reflex.enabled` 用 `bool(...)`；`reflex.autoResolve` 用 `csvString("reflex.autoResolve", …, live)`。在 `src/config/setting-specs.ts` 末尾展开，不打乱现有顺序。
- **刻意不做成设置的项**（都是代码常量，放在 `core/budget.ts`）：`REFLEX_BUDGET_MS = 1200`（in-band 总预算，`seconds()` 只支持整数秒，表达不了）；`MAX_INPUT_CHARS = 120`；`REPEAT_WINDOW_MS = 600_000`；`DEMOTE_AFTER_STRIKES = 2`；`MAX_ANSWER_LINES = 24`、`MAX_ANSWER_BYTES = 2048`。理由：MVP 先不要调参面；以后加键是追加式的，不破坏兼容。

### 4.2 装配：`wireReflex`

```ts
// src/reflex/wire.ts
export interface ReflexWireDeps {
  settings: () => ReflexSettings; // live getter（autoResolve 每次 input 现读）
  secureDomainKind: "plain" | "secure" | "locked";
  ports: ReflexPortDeps; // 见 §4.6
  fences: {
    topicSwitchActive: () => boolean; // 晚绑定：topic-switch 在 R 层之后才 wire
    goalBusy: () => boolean;
  };
  clock?: { now(): number; setTimer(ms: number, fn: () => void): { cancel(): void } }; // 默认实现 unref
}
export interface ReflexWiring {
  /** 测试 / 命令用的只读快照 */
  snapshot(): ReflexStatusSnapshot;
}
/** 双保险：secureDomainKind !== "plain" ⇒ 直接 return undefined，零注册（与 resolveJevWiring 同构）。 */
export function wireReflex(pi: ExtensionAPI, deps: ReflexWireDeps): ReflexWiring | undefined;
```

`src/index.ts` 的接入方式（只是装配，I2）：

```ts
// 位于 web-hub 块之后、`if (settings.topicSwitch.enabled) wireTopicSwitch(...)` 之前
const reflexFence: { topicSwitch?: () => boolean } = {};
if (settings.reflex.enabled) {
  wireReflex(pi, {
    settings: () => settings.reflex,
    secureDomainKind: secureDomain.kind,
    ports: {
      bashJobs: () => holder.current?.bashJobs,
      fleet: () => holder.current?.query,
      quota: () => holder.current?.quota,
      git: createGitRunner(),
    },
    fences: {
      topicSwitchActive: () => reflexFence.topicSwitch?.() ?? false,
      goalBusy: () => {
        const g = holder.current?.goal.record?.state;
        return g === "active" || g === "paused";
      },
    },
  });
}
// …在 wireTopicSwitch 之后：reflexFence.topicSwitch = () => topicSwitch.fenceActive();
```

`wireReflex` 的注册清单固定为下面 6 项，写进 activate-trace 的 `max` 档（plan r2 PD11：pi 单激活多会话，shutdown 后同一闭包服务新会话）：

1. `pi.on("input", …)`
2. `pi.on("agent_settled", …)`：结算 pending，写 record
3. `pi.on("session_start", …)`：re-arm——`disposed = false`、新 `AbortController`、清残留 pending 与 repeat/correction 窗口记忆、`inFlight = false`
4. `pi.on("session_shutdown", …)`：abort 在飞任务，丢弃 pending，`disposed = true`，`generation++`；只有 async 迟到 settle 检查 `disposed || gen !== generation`，同步入口不检查
5. `pi.registerMessageRenderer("subagent:reflex", renderReflexMessage)`（API 存在时才注册）
6. `pi.registerCommand("reflex", createReflexCommand(...))`

不注册 `session_before_compact`：压缩中输入到不了 input handler（§2.3-1，由 C-R6 钉住）。不注册 `before_agent_start`，不碰 system prompt，与 sysprompt-stable 没有交集。

### 4.3 S0 否决表（`core/gate.ts`）

```ts
export interface GateFacts {
  source: "interactive" | "rpc" | "extension";
  mode: "tui" | "rpc" | "json" | "print";
  streamingBehavior: "steer" | "followUp" | undefined;
  idle: boolean; // ctx.isIdle()
  pendingMessages: boolean; // ctx.hasPendingMessages()
  imageCount: number;
  text: string; // event.text（已经过前面 handler 的 transform）
  topicSwitchActive: boolean;
  goalBusy: boolean;
  inFlight: boolean; // 本激活已有一个 S2 在 await
}
export type VetoCode =
  | "source"
  | "mode"
  | "streaming"
  | "busy"
  | "image"
  | "fence-topic"
  | "fence-goal"
  | "in-flight"
  | "length"
  | "multiline"
  | "prefix"
  | "short-reply"
  | "anaphora"
  | "cancel"
  | "negation"
  | "imperative";
export function evaluateGate(f: GateFacts): { pass: true; norm: NormalizedInput } | { pass: false; veto: VetoCode };
```

按下面顺序判，先命中先返回：

| #   | 否决                                                                                                                                                                                                  | 理由                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `source !== "interactive"`                                                                                                                                                                            | rpc/web 的 hold 驱动不认识 `handled`；extension 是重注入     |
| 2   | `mode !== "tui"`                                                                                                                                                                                      | print/json 的 `prompt()` 也报 interactive（§2.3-6）          |
| 3   | `streamingBehavior !== undefined`                                                                                                                                                                     | 不抢用户在流式过程中的插话                                   |
| 4   | `!idle \|\| pendingMessages`                                                                                                                                                                          | 有队列时插队会打乱顺序                                       |
| 5   | `imageCount > 0`                                                                                                                                                                                      | 带图请求一律交给模型                                         |
| 6   | `topicSwitchActive`                                                                                                                                                                                   | topic-switch hold/releasing 期间新输入必须排在它后面（§4.9） |
| 7   | `goalBusy`                                                                                                                                                                                            | `/goal` 循环期间不插话                                       |
| 8   | `inFlight`                                                                                                                                                                                            | 单飞（TUI 本来就串行，这里是防御）                           |
| 9   | trim 后码点数 `> MAX_INPUT_CHARS` 或 `< 2`                                                                                                                                                            | 不是一句话的问题                                             |
| 10  | 含换行或代码围栏                                                                                                                                                                                      | 同上                                                         |
| 11  | 以 `/ ! @ #` 开头，或含 `@label` 词元                                                                                                                                                                 | 属于命令 / mention / channel 的地盘                          |
| 12  | 整句命中 `SHORT_REPLY_TABLE`                                                                                                                                                                          | C7                                                           |
| 13  | 命中 `ANAPHORA_CJK`/`ANAPHORA_EN`                                                                                                                                                                     | "那个 job 完了吗"要靠上下文才能答                            |
| 14  | `cancelIntent(norm)`                                                                                                                                                                                  | 取消 / 换话题                                                |
| 15  | 命中全局祈使 / 写动词表 `IMPERATIVE_VETO`（杀\|kill\|停\|删\|清理\|提交\|commit\|push\|改\|修\|写\|加\|实现\|创建\|运行\|跑一下\|启动\|重启\|安装\|发布\|merge\|rebase\|reset\|checkout\|切换\|帮我） | 写意图一律交给模型；宁可漏答，不可误答                       |
| 16  | handler 任何异常 → 视同否决（`continue`）                                                                                                                                                             | 这是优化器，不是安全闸，fail-open 才对（F §7.1 注）          |

`IMPERATIVE_VETO` 与 `catalog.ts` 都是冻结的 `readonly string[]` 正则源，在 `wireReflex` 闭包里编译一次。正则一律不带 `/g`，也不用嵌套量词（clauses.ts 同款规则，加一条单测扫描）。

### 4.4 S1 匹配与置信带（`core/match.ts`）

```ts
export type Band = "high" | "ambiguous";
export type MatchResult =
  { kind: "miss" } | { kind: "hit"; band: Band; scriptId: string; candidates: readonly string[] };
export interface Matcher {
  match(norm: string, caps: ReadonlySet<Capability>): MatchResult;
}
export function compileCatalog(scripts: readonly RScriptV1[]): Matcher;
```

判定规则：

- 先过滤掉 `requires` 未满足的脚本。能力集由 wire 每次现算：`bashJobs` = bashJobs 端口存在；`quota` = quota 服务存在；`fleet` = query 存在；`git` 恒真（不是仓库时由 port 自己报 `unavailable`）。
- `exclude` 任一命中，该脚本出局。
- 恰好一个脚本的 `strong`（隐式 `^…$` 全句匹配）命中，且没有其他脚本的 strong/weak 命中，结果是 `band:"high"`。
- 其余命中情况（只有 weak 命中，或命中多个脚本）结果是 `band:"ambiguous"`，`scriptId` 取第一个候选，仅用于记账。**ambiguous 永远不进 S2**，MVP 只记 shadow。分类器的接入点就在这里（§4.10）。

### 4.5 脚本 schema：`rscript/1`（MVP 子集）

```ts
// src/reflex/core/types.ts
export type PortId = "jobs.list" | "fleet.status" | "quota.summary" | "git.status" | "sessions.recent";
export type Capability = "bashJobs" | "fleet" | "quota" | "git" | "sessionDir";

export interface RScriptV1 {
  schema: "rscript/1";
  id: string; // ^[a-z][a-z0-9-]*\.[a-z0-9-]+$，全局唯一
  version: number; // 正整数；改 intent/port/render 必须 bump（record 按版本分组统计）
  origin: "builtin" | "extracted"; // "extracted" 只出现在离线报告草案里；catalog 自检拒绝加载
  risk: "readonly"; // MVP 只有这一个字面量；写类留到 rscript/2 再定义，不预留半成品字段
  intent: {
    strong: readonly string[]; // 全句模板（正则源，作用于 normalize 后文本，隐式锚定）
    weak: readonly string[]; // 子串锚点（只产生 ambiguous）
    exclude: readonly string[]; // 任一命中即否决本脚本
    examples: { hit: readonly string[]; miss: readonly string[] }; // 各 ≥5 条；同时是单测语料
  };
  port: { id: PortId }; // MVP 没有 args / 槽位
  requires: readonly Capability[];
  budgetMs?: number; // ≤ REFLEX_BUDGET_MS；缺省等于它
  render: { title: string; emptyText: string; maxLines: number };
  agreement: {
    // shadow 比对：模型实际用到哪些工具形状算"同意"
    tools: readonly string[]; // 如 "bash_job:list"、"get_run_result"
    bashShapes: readonly string[]; // predict/shape 的 program[ subcommand]，如 "git status"
  };
}
```

与 F §5 相比**删掉**的东西：`exec.kind:"argv"`、`argv`、`env`、`stdin`、`slots`、`success` DSL、`fallback.on`、`guards`、`stats`、`provenance.reviewedBy`。原因：port 是代码，它自己返回机械判定的 `PortOutcome`（§4.6），不需要声明式的判据 DSL；统计放在 record 里，不写回脚本；冷却由 repeat 规则代替。

`catalog.ts` 的初始 4 个脚本（正则由开发据下面的例句编写，例句就是单测语料）：

| id              | port            | requires   | strong 例句（hit）                                             | miss 例句（必须不命中）                                   | agreement                                             |
| --------------- | --------------- | ---------- | -------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `jobs.list`     | `jobs.list`     | `bashJobs` | 后台还有几个 job / 有后台任务在跑吗 / bash jobs / 后台任务状态 | 把后台 job 都停了 / 那个 job 完了吗 / 跑一下测试放后台    | tools `bash_job:list`,`bash_job:status`               |
| `fleet.status`  | `fleet.status`  | `fleet`    | 有几个 subagent 在跑 / 子 agent 状态 / 现在有哪些 agent 在跑   | 派个 agent 去查 / 停掉所有 agent / agent 跑完了吗他说了啥 | tools `get_run_result`,`list_subagents`               |
| `quota.summary` | `quota.summary` | `quota`    | 额度还剩多少 / quota 还有多少 / 5h 额度用了多少                | 额度不够了换个模型 / 这周花了多少钱（费用 ≠ 额度，排除）  | tools 无（模型本来就没有额度工具，按 `no-tool` 统计） |
| `git.status`    | `git.status`    | `git`      | 工作区干净吗 / git status / 有未提交的改动吗 / 当前分支是什么  | 把改动提交了 / 回滚工作区 / 这些改动对吗 / git log 看一下 | bashShapes `git status`,`git diff`                    |

### 4.6 Port 契约

```ts
// src/reflex/core/types.ts
export interface PortEnv {
  cwd: string;
  now: number;
  signal: AbortSignal;
  budgetMs: number;
}
export type PortOutcome =
  | {
      kind: "ok";
      lines: readonly string[];
      facts: Readonly<Record<string, string | number | boolean>>;
      truncated: boolean;
    }
  | { kind: "uncertain"; reason: string } // 数据可能过期 / 不全 → 回退，不记 strike
  | { kind: "unavailable"; reason: string } // 运行时能力缺失（非 git 仓库、manager 尚未建好）→ 回退，不记 strike
  | { kind: "error"; reason: string }; // 抛错 / 解析失败 / 非预期退出码 / 输出超限 → 回退，记 strike
export type ExecOutcome = PortOutcome | { kind: "timeout"; reason: "budget" }; // 由 raceBudget 产生，记 strike

// src/reflex/ports/index.ts
export interface ReflexPort {
  id: PortId;
  version: number;
  run(env: PortEnv): PortOutcome | Promise<PortOutcome>;
}
export interface ReflexPortDeps {
  bashJobs: () => { list(): readonly JobRecord[] } | undefined;
  fleet: () => Pick<QueryService, "list"> | undefined;
  quota: () => Pick<QuotaService, "verdicts"> | undefined;
  git: GitRunner;
  sessionDir?: () => string | undefined; // R4
}
export interface PortRegistry {
  get(id: PortId): ReflexPort | undefined;
  capabilities(): ReadonlySet<Capability>;
}
export function createPortRegistry(deps: ReflexPortDeps): PortRegistry;
/** 永不抛：同步异常与 rejected promise 都转成 {kind:"error"}；超时转成 {kind:"timeout"}；signal 联动 shutdown。 */
export function executePort(port: ReflexPort, env: PortEnv, clock: Clock): Promise<ExecOutcome>;
```

**只读铁律**（每个 port 单测都要断言）：不发网络请求（`quota` 只调 `verdicts()`，**不**调 `refreshIfStale()`）；不写磁盘；不改任何 manager 状态（比如不调 `markBackgrounded`、`setFinalText`）；不 import pi。

各 port 的实现要点：

| port                    | 数据源                                                                                                          | 为 ok 的条件                             | 非 ok 映射                                                                                                                                                                  | 渲染                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `jobs.list`             | `bashJobs().list()`                                                                                             | manager 存在（job 数为 0 也是合法的 ok） | manager 缺席 → `unavailable`                                                                                                                                                | 复用 `renderBashJobsSection`；0 个 job 时用 `emptyText`；命令预览过 `redactForJev`            |
| `fleet.status`          | `fleet().list()`                                                                                                | query 存在                               | 缺席 → `unavailable`                                                                                                                                                        | 按状态计数 + 活跃 run 前 8 条（`label · status · elapsed`）                                   |
| `quota.summary`         | `quota().verdicts(now)`                                                                                         | verdicts 非空                            | 空 → `uncertain`（"no trusted snapshot"，服务已经滤掉了 stale）                                                                                                             | 每个 provider 一行 `renderProviderLine(v, now)`                                               |
| `git.status`            | `git(args, {cwd, timeoutMs, maxStdoutBytes:65536, envPolicy:"minimal", pathOverride: WTDIFF_GIT_PATH, signal})` | `code === 0` 且解析成功                  | `code===128` 或 spawnError → `unavailable`；`killed:"timeout"` → `error`（"timeout"）；`stdoutCapped`/`killed:"overflow"` → `error`（"overflow"）；其他非零退出码 → `error` | `branch · ahead/behind · staged/modified/untracked 计数` + 前 15 条路径；干净时用 `emptyText` |
| `sessions.recent`（R4） | `listRecentSessions(cwd, dir, 24)`（`src/session-nav/recent-sessions.ts:28`）                                   | 在预算内完成                             | 超时 → `timeout`；部分结果 → `uncertain`                                                                                                                                    | 前 8 条 `title · relative time`                                                               |

**git 定论：做成 port，内部使用有界执行器；rscript/1 里不设 `argv` 执行种类。** 固定 argv 如下（在 `ports/git.ts` 里冻结，单测逐字节钉住）：

```
--no-replace-objects --no-pager --no-optional-locks -c core.hooksPath=/dev/null -c core.fsmonitor=false
status --porcelain=v2 --branch -z --untracked-files=normal
```

- 必须带 `--no-optional-locks`，否则 `git status` 会刷新 index stat，写出 `index.lock`，不再是只读。
- 不带 `--no-lazy-fetch`：它要求 git ≥ 2.45，而 status 本来不会触发 lazy fetch。这是与 `VERSION_GIT_PREFIX` 的唯一差异；那个前缀属于 web-hub hub 层，按 I8 不跨层 import，这里镜像一份常量并写注释。
- 解析放在 `core/git-status-parse.ts`（纯函数、`-z` 分隔，可以正确处理带空格的路径）。不复用 `src/hud/git.ts`：它绑定 `pi.exec` 的 ExecFn、3s 超时、非 `-z`，为 R 层改它会牵动 HUD。
- 不做通用 argv 的理由见 §5 D3。

### 4.7 每脚本状态机与单次请求状态机

**每脚本状态（激活级，不落盘；`core/state.ts` 纯 reducer）：**

```
             settings.autoResolve ∌ id                   settings.autoResolve ∋ id
   ┌──────────── SHADOW ◄──────────────────────────────────────► AUTO ─────────────┐
   │              ▲                (live 重读；DEMOTED 覆盖层保留)    │ ok → strikes=0 │
   │              │                                                  │                │
   │              │       连续 DEMOTE_AFTER_STRIKES(2) 次 error|timeout ▼                │
   │              └──────────────────── DEMOTED（行为同 SHADOW）◄────┘                │
   │                                      │  /reflex reset [id] 或 /reload ⇒ 清除覆盖层 │
   └──────────────────────────────────────┴──────────────────────────────────────────┘
```

```ts
export type ScriptState = "shadow" | "auto" | "demoted";
export interface ScriptRuntime {
  strikes: number;
  demoted: boolean;
  demotedAt?: number;
}
export function effectiveState(id: string, autoResolve: readonly string[], rt: ScriptRuntime): ScriptState;
export function onExecOutcome(
  rt: ScriptRuntime,
  o: ExecOutcome,
  now: number,
): { rt: ScriptRuntime; demotedNow: boolean };
// strike：error | timeout；清零：ok；不计：uncertain | unavailable
```

`demotedNow` 为真时，`ctx.ui.notify` 一次（中文散文，比如"reflex：git.status 连续失败，本会话已降回 shadow"），之后 `/reflex status` 能看到。

**单次请求状态（输入维度）：**

```
GATED ──veto──► PASS
  │
MATCHED ──miss──► PASS
  ├─ambiguous──► PENDING(ambiguous) ► PASS
  ├─high ∧ repeat──► PENDING(repeat) ► PASS
  ├─high ∧ state∈{shadow,demoted}──► PENDING(shadow) ► PASS ⟶ 后台 executePort → 结果写入 PENDING.port
  └─high ∧ state=auto──► EXECUTING（inFlight=true；ui.setStatus("reflex","reflex…")）
                           ├─ ok ──────► ANSWERED（sendMessage）► HANDLED
                           └─ 非 ok ───► PENDING(fallback, port=outcome) ► PASS
                           finally：inFlight=false；setStatus 清空
PENDING ──agent_settled──► RECORDED（appendEntry）
        ──下一次 input 产生新 PENDING──► 旧条目以 model.agree="unknown" 立即落盘后替换（单槽）
        ──session_shutdown──► 丢弃
```

- **repeat 规则（转交模型的逃生口 + 误报代理信号）**：同一 `requestDigest` 在 `REPEAT_WINDOW_MS` 内已经被 reflex 答过一次，这次就直接 `continue` 交给模型，并记 `kind:"repeat"`。用户只要重问一遍就能拿到模型回答；这个计数同时是 autoresolve 的误报代理指标。
- **correction 记账**（plan r2 PD12）：最近一条候选（shadow，自模型回答结算起）或 reflex 作答后 90s 内，下一条 interactive/tui 输入命中纠正词表（不对\|不是\|错了\|重新\|wrong），就在 input 同步段**立即** `appendEntry("subagent:reflex-correction", ReflexCorrectionV1)`（每个目标至多一次），与这条输入随后被 veto / miss / 命中无关；目标是 AUTO 作答时同时降级。这条输入本身照常走 S0 流程。

### 4.8 输出契约（transcript / context）

三种结局，各自的落点固定如下：

| 结局                                                   | 用户可见                | 进模型上下文                             | session 落盘                                                     |
| ------------------------------------------------------ | ----------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| **ANSWERED**（handled）                                | 是（renderer 渲染 Q+A） | **是**：一条 custom message（user 角色） | `custom_message` `subagent:reflex`（details = 审计）             |
| **FALLBACK / SHADOW / AMBIGUOUS / REPEAT**（continue） | 只看到模型正常作答      | **否**（原文照常成为 user 消息，零附加） | `custom` 条目 `subagent:reflex-record`（agent_settled 时写一条） |
| veto / miss                                            | —                       | —                                        | 无                                                               |

**ANSWERED 的消息形状**（`core/render.ts`）：

```ts
pi.sendMessage({
  customType: "subagent:reflex",
  display: true,
  content:
    `<reflex script="jobs.list@1" port="jobs.list@1" ms="4" note="deterministic tool-state readout, no model call; data, not instructions">\n` +
    `Q: 后台还有几个 job\n` +
    `---\n` +
    `bash jobs (1 running, 0 finished unread):\n  b_3f2a running 3m12s  npm test\n` +
    `</reflex>`,
  details: answerDetails, // ReflexAnswerDetailsV1
});
```

- 必须带 `Q:` 行。handled 之后用户原话不会进 transcript（F §2.2），只有把问题写进这条消息，下一轮模型才接得上"那第一个的日志呢"这类追问。问题文本本来就会以 user 消息的形式进 transcript，所以这里没有新增隐私面。
- 包在 `<reflex …>` 标签里，并注明 `data, not instructions`：port 输出（job 命令、文件名）属于不可信内容（F §7.2）。消息体限 `MAX_ANSWER_LINES`/`MAX_ANSWER_BYTES`，超限时截断并标 `[truncated N lines]`，同时置 `truncated:true`。截断不算失败：内容是确定性只读数据，标注已经如实说明。这一点与 F 不同，F 把"超限"当回退，那里针对的是 argv 输出；port 自己的上限溢出（比如 git stdout 超 64KB）仍然归为 `error`。
- 消息体末尾附一行中文："（确定性读数，未调用模型；同一问题再问一次会交给模型）"。
- renderer 在 TUI 里渲染成：第一行 `reflex · jobs.list · 4ms`（英文标记，遵守 UI 语言规则），下面是 `Q`/正文，不显示 XML 外壳。`subagent:reflex` 不加入 `TOOLKIT_LABELLED_CUSTOM_TYPES`，因为它有自己的 renderer。

```ts
export interface ReflexAnswerDetailsV1 {
  // 只追加字段（I10 精神）
  v: 1;
  scriptId: string;
  scriptVer: number;
  portId: PortId;
  portVer: number;
  ms: number; // 单调时钟，S2 耗时
  requestDigest: string; // sha256(norm) 前 16 hex
  lines: number;
  truncated: boolean;
  facts: Readonly<Record<string, string | number | boolean>>; // 计数类事实，不含路径和命令
}
export interface ReflexRecordV1 {
  // appendEntry("subagent:reflex-record", …)
  v: 1;
  kind: "shadow" | "fallback" | "ambiguous" | "repeat";
  at: number;
  scriptId: string;
  scriptVer: number;
  candidates?: readonly string[];
  state: ScriptState;
  band: Band;
  requestDigest: string;
  chars: number;
  port?: { outcome: ExecOutcome["kind"]; ms: number; reason?: string; portVer: number }; // ambiguous/repeat 不跑 port
  model?: { agree: Agreement; tools: readonly string[] }; // 工具名 + bash 形状，永不带参数
  reasked?: true; // plan r2 PD6：同会话同 digest 在 10min 内再次成为同脚本候选
}
export type Agreement = "agree" | "no-tool" | "diverge" | "unknown";
```

- record **不存原文**，只存 digest 和长度。continue 路径下用户原文已经作为 user 消息躺在 transcript 里，离线报告按位置关联即可，不需要再存一份。
- 由于从不 `sendUserMessage`，也就**不存在重入问题**。防御性约束仍然保留：第一道否决就是 `source !== "interactive"`；另加一条 governance 测试，扫描 `src/reflex/**`，确认不出现 `sendUserMessage`、`triggerTurn`、`action: "transform"`（§6.3 G4）。

**shadow 一致性判定**（`core/agreement.ts`）：在 `agent_settled` 时从 `ctx.sessionManager.getBranch()` 倒序找到最近一条 user 消息，校验它的 digest 与 pending 一致（不一致就记 `unknown`），收集之后所有 assistant 的 toolCall：`bash` 取 `predict/shape` 的形状，`bash_job` 取 `bash_job:<action>`，其他工具取工具名。然后判定：

- 命中 `agreement.tools`/`bashShapes` 中任意一项，且没有出现 `edit`/`write`：`agree`
- 零工具：`no-tool`（模型凭上下文直接答了，或者答不了）
- 其他情况：`diverge`

**晋升建议门槛**（用户 2026-11-04 拍板，覆盖原 ≥20；唯一实现 `src/reflex/core/promotion.ts`，见 plan r2 R1 步骤 11；**只是建议，晋升由用户改设置完成**）：同一 `scriptVer` 下 shadow 候选 ≥ 50；port `ok` 率 ≥ 99%；`diverge` ≤ 5%，且 diverge 样本人工抽查确认属于"模型多做了无关的事"而不是"问的不是这个"；会话内重复（`reasked` + AUTO `repeat`）、跨会话 digest 重复（R3b 现算）、纠正条目（`subagent:reflex-correction`）均为 0。

### 4.9 与其他 input handler 的优先级 / 冲突

R 层注册在 **web-hub 块之后、topic-switch 之前**（§2.1 表中 8 与 9 之间）。

| 对象                   | 结论与机制                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| secure guards（1）     | 锁定时 guards 先返回 `handled`，R 层根本看不到；而且 secure 域内 R 层已被 D8 关闭，不接线                                                                                                                                                                                                                                                                                                                                                       |
| wake hook / xs（3、4） | 它们排在前面，恒 `continue`，人类输入照常被记账。R 层吞掉输入后语义上仍是"人类输入过"，与它们的假设一致                                                                                                                                                                                                                                                                                                                                         |
| mention（5）           | `@label` 由 mention 先 `handled`；R 层 S0 第 11 条也会否决 `@`，双保险                                                                                                                                                                                                                                                                                                                                                                          |
| feishu-notify（6）     | 排在前面，会 `transform` 掉关键词，R 层看到的是去掉关键词后的文本。残留：它会置 `userInputPending=true`，R 层 handled 后没有 agent_start，这个标志要拖到下一次 run 才被消费（§7 R7）                                                                                                                                                                                                                                                            |
| session-nav（7）       | 裸 `exit` 先被它 `handled`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **topic-switch（9）**  | **R 层在前。** ① R 层 autoresolve 的请求不需要模型，topic-switch 的"贵请求切新会话"判断对它没有意义，不该为一句"后台几个 job"弹出 judge 和确认框；② R 层回退时直接返回 `continue`，原文完整交给 topic-switch 正常判断，什么都没丢；③ topic-switch 处于 hold/releasing 时，新的 interactive 输入必须进它的释放队列以保序，所以 S0 第 6 条 `topicSwitchActive` 会让 R 层退让；④ topic-switch 的重注入都是 `source:"extension"`，R 层第 1 条就放行 |
| schedule surface（2）  | 恒 `continue`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| memory / Jev           | 没有 input handler。handled 的输入不起 run，所以不会触发 U/P 注入，这符合预期。下一轮的 P 层 `previous_request` 只读 user 消息，reflex 消息是 custom 角色，会被忽略，影响仅限 P 层承接少一轮                                                                                                                                                                                                                                                    |
| sysprompt hub          | 不交叉：R 层不注册 `before_agent_start`，也不写 system prompt                                                                                                                                                                                                                                                                                                                                                                                   |

### 4.10 分类器辅助接口（只定义，MVP 不接）

```ts
// src/reflex/core/types.ts
export interface ReflexDisambiguator {
  /**
   * 只在 band==="ambiguous" 且 candidates.length ≤ 3 时调用；预算 = min(800ms, 剩余 in-band 预算)。
   * 只能返回 choice（候选 id 或 "none"）和 score，不能产出参数（classify() 本来也只给 choice/score/bool）。
   * 超时 / 异常 / undefined 一律按 "none" 处理。
   */
  choose(
    input: { text: string /* redactForJev 后再截断到 120cp */; candidates: readonly { id: string; hint: string }[] },
    signal: AbortSignal,
  ): Promise<{ choice: string; score: number } | undefined>;
}
```

- 实现**必须**经过 `src/memory/jev/client.ts`（C8 单一调用点），由 jev 导出一个 choice 型 ask helper；改动时同步更新 memory README 的不变式 3。
- 外发只允许 `text` 与候选 `hint`，port 输出与会话内容永不外发；只在 `memory.jev` 可用时才存在（secure 域天然没有）。
- 结果语义：`score ≥ 0.85` 且 choice ∈ candidates 时，升级为 `band:"classified"`（届时追加到 `Band` 联合，属于追加式变更），**初期只进 shadow**，要由单独的设置键另行晋升。接入时再新增设置，MVP 不预埋键。

### 4.11 `/reflex` 命令

| 子命令               | 行为                                                                                                                                                                                                                                                                               | 副作用       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `/reflex` / `status` | 显示：已启用；每个脚本的有效状态（off 不存在 / shadow / auto / demoted + strikes）；本激活计数（candidates/answered/fallback{reason}/ambiguous/repeat/corrected）；从 `getBranch()` 汇总的本会话 record（agree 率、p50/p95 ms）；autoResolve 里的未知 id；按 §4.8 门槛给出晋升建议 | 无           |
| `explain <text>`     | 用 text 跑一遍 S0（mode/source/idle 等运行时事实按"理想 TUI 空闲"填充）和 S1，输出 veto 码或 band+脚本+命中的模板序号。**不执行 port**                                                                                                                                             | 无           |
| `reset [id]`         | 清除 DEMOTED 覆盖层和 strikes                                                                                                                                                                                                                                                      | 只改闭包内存 |

输出方式跟 `/topic-switch status` 一样（走 command capture，web 端也能显示）。不提供 enable/disable 子命令，开关只走 `/agent settings`，避免两条设置路径。

### 4.12 离线提取器（R4，可选；只出报告）

- 形态：`scripts/dev/reflex-report.mjs`（Tier 3，手动运行，**不进 CI**，不在 pi 进程里跑）。纯逻辑放在 `src/reflex/core/extract/*.ts`（pi-free，有单测）；脚本加载构建产物，没有构建产物就直接报错退出。
- 输入：`~/.pi/agent/sessions/**/*.jsonl`（只读流式扫描），参数 `--days 30 --min-group 3`。
- 输出：写到 `<agentDir>/reflex/reports/<date>.md`，权限 0600。**永不写进仓库**，也不联网。分四节：
  1. **高频意图簇**：筛选严格只读 run（F §3.3 口径），首行归一化（路径→`<path>`、数字→`<n>`、截断 40cp、过 `redactForJev`）后，与工具形状一起双键聚类；每簇给出计数、p50 耗时和工具签名。
  2. **现有 catalog 覆盖度**：每簇被哪个脚本命中（high/ambiguous/miss）；同时用全库首行做负样本扫描，统计 strong 误命中，目标为 0。
  3. **候选匹配器草案**：只对"工具签名同构率 ≥ 80% 且能映射到现有 PortId"的簇输出 `RScriptV1` 草案（`origin:"extracted"`，`intent.strong/weak` 取簇内公共 n-gram，`port` 只能选已有 port）；映射不到的簇只列意图，不出草案。**永不输出 argv。**
  4. **shadow 汇总**：扫描 `subagent:reflex-record` 与 `subagent:reflex`，按 `scriptId@scriptVer` 汇总候选数、port ok 率、p50/p95、agree/no-tool/diverge、repeat/corrected 计数，并给出 §4.8 门槛的达标判断。另做**漂移**检查：对比最近 7 天与之前的 agree 率，下降超过 10 个百分点或 port error 率上升就标注 drift。
- 草案永远不会被自动加载：catalog 自检拒绝 `origin:"extracted"`，而且根本没有外部脚本加载路径。要采纳草案，只能由人把它改写进 `catalog.ts`（`origin:"builtin"`、bump version），走正常的 PR 和测试。

---

## 5. 关键决策（及为什么不选备选）

| #       | 决策                                                                                   | 备选（被否决）                                                                | 理由                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1**  | **回退 = 在 handler 内 `continue`**（in-band await 有界 port）                         | F §2.4：先 `handled`，异步执行，失败后下一 tick 用 `sendUserMessage` 重放原文 | pi 本来就会 await async handler（§2.3-2），TUI 主循环串行（§2.3-3），所以等 ≤1.2s 是安全的。重放方案有三个问题：①原文变成 `source:"extension"`，topic-switch 不再判断（`sourceAllowed`），回退并非无损；②需要防重入、turnKey、去重；③重放的 `expandPromptTemplates` 语义与原生路径有细微差别。in-band 方案下回退与 R 层不存在逐字节一致，代价只是 AUTO 脚本失败时最多多等 1.2s |
| **D2**  | **R 层排在 topic-switch 之前**，并在 topic-switch hold 期间退让                        | F §2.6：topic-switch 先                                                       | F 的结论建立在"回退靠重放"上。D1 之后，回退等于原样交给 topic-switch，什么都不损失；反过来，让 topic-switch 先判断，会给零成本的问题弹出 judge 和确认框                                                                                                                                                                                                                        |
| **D3**  | **只有 port，没有 argv 脚本**；git 通过 port 调用有界执行器，argv 固定                 | F §5：`exec.kind:"argv"` + 白名单 + 槽位                                      | ①F §3.4 已证明 argv 提炼不成立，argv 种类在 MVP 里没有数据来源；②通用 argv 执行面要维护白名单、路径逃逸校验、env 策略、写操作识别，这本身是一个权限系统；③要给出确定性答案本来就需要解析（porcelain → 计数），解析是代码不是 schema；④git 走 port 可以复用 `src/git/run.ts`，I1 合规是现成的                                                                                   |
| **D4**  | **只有内置脚本**，没有 `scriptsDir`                                                    | 从 `~/.pi/agent/reflex/scripts` 加载                                          | 外部加载 = 新的注入面 + schema 迁移负担 + secure 域路径问题。MVP 只有 4 个脚本，内置就够；提取器草案经过 PR 进入 catalog，审阅链天然存在                                                                                                                                                                                                                                       |
| **D5**  | **命中时只写一条 custom message**（details 承担审计），回退和 shadow 只写 custom entry | F §2.3：命中时 entry + message 都写                                           | 少一条落盘，审计数据不重复；`/reflex status` 两类都读                                                                                                                                                                                                                                                                                                                          |
| **D6**  | **命中消息进模型上下文**（`sendMessage`，内含 Q）                                      | 只用 `appendEntry` + entry renderer（不进上下文）                             | handled 之后原话不在 transcript，如果答案也不进上下文，用户追问时模型完全不知道前情；而且 web-hub / 导出对 entry 渲染支持较差                                                                                                                                                                                                                                                  |
| **D7**  | **只设 2 个设置键**；预算、长度、窗口等都是常量                                        | F §4.3 的 14 个键                                                             | MVP 不需要调参面；`seconds()` 只支持整数秒，表达不了 1.2s；以后加键是追加式的                                                                                                                                                                                                                                                                                                  |
| **D8**  | **不建跨会话统计文件**；session 条目是唯一事实源，跨会话汇总交给离线报告               | `<agentDir>/reflex/ledger.jsonl` / `Symbol.for` 统计                          | 省掉新的持久化、锁和 secure 路径问题；I4 天然满足；shadow 期两周的评估本来就是离线做的                                                                                                                                                                                                                                                                                         |
| **D9**  | **晋升靠人改设置**（`autoResolve`），只自动降级、不自动升级                            | 达到门槛后自动晋升                                                            | 用户的批准范围是"不自动启用"；降级方向的误判只损失速度，升级方向的误判会造成误答                                                                                                                                                                                                                                                                                               |
| **D10** | **ambiguous 永不执行**；分类器只做升级判断，而且结果先进 shadow                        | 分类器直接决定是否作答                                                        | 零误答优先；C8 要求经过 jev client，外发纪律复杂，MVP 不接                                                                                                                                                                                                                                                                                                                     |
| **D11** | **新建顶层 `src/reflex/` 与 `reflex.*`**                                               | 放在 `src/memory/jev/reflex/` + `memory.jev.reflex.*`                         | R 层的本质是 input 拦截 + 工具状态读数，不依赖 memory；挂在 memory 下会让 `memory.enabled=false` 连带关掉它，也会把 memory 的 pi-free/门禁规则缠进来。"Jev"只作为产品名，以及将来分类器的来源                                                                                                                                                                                  |

---

## 6. 实施要点

### 6.1 分包（每包独立可验收；括号内为依赖）

| 包                                                   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                   | 验收                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0** 关着的骨架（—）                               | `core/settings.ts` + `setting-specs.ts` + `config/settings.ts` 合并 + D8 一行；`wire.ts` 只有守卫 + 6 项注册（含 session_start re-arm，plan r2 PD11），handler 恒 `continue`；`src/index.ts` 装配；`docs/dev/jev-reflex/README.md`（不变式 + 门禁，见 §6.2）；AGENTS.md 加布局表 `src/reflex/` 行（K9 测试要求）、在 I3 post-guard 清单补上 reflex；conformance C-R1…C-R8；`reflex-off-golden.json`；trace `max` 档刷新；spec pin 刷新 | `npm test` 全绿；`default/minimal/child/thread-child` trace 不变；off golden 新建；secure 测试证明 D8 生效                                                                                                                                            |
| **R1** pi-free 核心（R0 可并行）                     | `core/{types,schema,normalize,gate,match,catalog,state,budget,render,agreement,git-status-parse}.ts` + 全量单测；`pi-free.test.ts` 目录清单加上 `reflex/core`                                                                                                                                                                                                                                                                          | 例句语料 100% 正确（hit 命中 high，miss 为 veto/miss/ambiguous）；全局否决语料（`SHORT_REPLY_TABLE` 全表、指代、取消、祈使）0 命中；性质测试：随机拼接任一否决词的输入永不 `high`；1 万条输入的匹配耗时 p99 ≤ 1ms；regex 无 `/g`、无嵌套量词扫描      |
| **R2** ports + shadow（R1）                          | `ports/*`（4 个）+ `executePort` + shadow 路径（pending 单槽、后台执行、agent_settled 落 record、agreement）+ `/reflex status/explain`                                                                                                                                                                                                                                                                                                 | 每个 port 有只读断言（fs 写入 spy、quota `refreshIfStale` 未被调用、git argv 逐字节钉住、`--no-optional-locks` 存在）；shadow 下 handler 同步返回 `continue`（断言在任何 await 之前就已返回）；record 形状钉住；真实 `activate()` 集成测试（fake pi） |
| **R3** autoresolve（R2）                             | S2 in-band 执行、命中消息 + renderer、状态机（strike/demote/reset）、repeat/correction、setStatus                                                                                                                                                                                                                                                                                                                                      | 集成测试矩阵（§6.3 I1-I8）；超时用假时钟；shutdown 中止在飞任务后不再产生任何 send/append                                                                                                                                                             |
| **R4**（可选）报告 + sessions（R1；可与 R2/R3 并行） | `core/extract/*` + `scripts/dev/reflex-report.mjs` + `ports/sessions.ts` 与 `sessions.recent` 脚本                                                                                                                                                                                                                                                                                                                                     | 报告纯函数单测（含"永不输出 argv"、"草案 origin=extracted"、脱敏）；脚本 Tier 3 手动跑                                                                                                                                                                |
| 未来（不在 MVP）                                     | 分类器 disambiguator（经 jev client）、`rpc`/web 来源（需先改 web-hub hold 驱动）、槽位（`jobs.status <label>`）、写类 rscript/2                                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                                                     |

上线顺序：R0 → R1 → R2 合入后，在用户本机打开 `reflex.enabled=true`，shadow 跑 2 周 → 跑离线报告 → 由用户逐个脚本加进 `autoResolve`（建议先 `quota.summary`、`jobs.list`，它们是纯内存读、零子进程）。

### 6.2 `docs/dev/jev-reflex/README.md` 必须写入的不变式（R0 交付）

- **R-I1** 关闭 / secure / locked / 子会话 ⇒ 零注册（`wireReflex` 不被调用，或守卫直接返回 undefined）。由 `reflex-off-golden.json` + trace 钉住。
- **R-I2** 只受理 `source==="interactive" ∧ mode==="tui" ∧ 空闲 ∧ 无图`。
- **R-I3** 从不 `sendUserMessage`、从不 `triggerTurn`、从不 `transform`；回退 = `continue`（governance 扫描测试）。
- **R-I4** 只有 AUTO 脚本的 port 在预算内返回 `ok` 时才返回 `handled`；其他一切情况（含异常）返回 `continue`。
- **R-I5** shadow 不改变可观察流程：任何 await 之前同步返回 `continue`；副作用只有只读 port 执行和 `agent_settled` 时写一条 custom entry。
- **R-I6** port 只读：不联网、不写盘、不改 manager；git argv 冻结且带 `--no-optional-locks`。
- **R-I7** in-band 预算 ≤ `REFLEX_BUDGET_MS`，经过 `clampSpanMs`；计时器 `unref`；shutdown 中止在飞任务、置 disposed 并推进 generation，之后迟到的 async settle 无副作用；session_start re-arm 后同一闭包继续服务新会话。
- **R-I8** 所有状态都在 `wireReflex` 闭包里，不用 `Symbol.for` 全局。
- **R-I9** 输出只有 `subagent:reflex`（custom message）、`subagent:reflex-record` 与 `subagent:reflex-correction`（custom entry）三种；details 只追加字段；不写 system prompt。
- **R-I10** `src/reflex/core/**` pi-free。
- **R-I11** 注册位置：web-hub 块之后、topic-switch 之前；topic-switch hold 或 goal 活跃时退让。
- **R-I12** 只有内置脚本；`origin:"extracted"` 不可加载；rscript/1 没有 argv 种类。

### 6.3 测试 / golden / conformance / trace 门禁

**Golden 与金身**

| 产物                                             | 等级 | 内容 / 规则                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/reflex-off-golden.json`（新）    | A    | 照 `schedule-off-golden` 的做法：真实 `activate()` 在 `default`、`{reflex:{enabled:false}}`、`secure` 模拟域、`child` 四种场景下的工具表、命令表、逐事件 handler 计数、system prompt，以及"喂一条 `后台还有几个 job` 的 interactive 输入后，无 `subagent:reflex*` 写入"。永不重生 |
| `tests/fixtures/governance/activate-trace.json`  | B    | `trace-profiles.ts` 的 `max` 档加上 `reflex: { enabled: true }`，按规则用 `PI_TOOLKIT_UPDATE_TRACE=1` 刷新；**评审只接受 `max` 条目的 diff**，其余档逐字节不变。commit 正文要说明原因                                                                                             |
| `tests/config/__corpus__/setting-specs-pin.json` | —    | 新增 2 个键（追加在末尾），按声明的功能变更刷新                                                                                                                                                                                                                                   |
| 已有 A 级金身                                    | A    | 全部不变：`git diff --quiet origin/dev -- tests/fixtures/` 除新增文件外必须为空                                                                                                                                                                                                   |

**Conformance：`tests/conformance/reflex.test.ts`（钉住 pi 前提，pi peer bump 时复跑）**

| 编号 | 前提                                                                                                                                                                                                             | 夹具                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| C-R1 | input 返回 `handled` ⇒ `prompt()` 返回，无 `agent_start`，无 user 消息条目                                                                                                                                       | agent-session-harness |
| C-R2 | async input handler 被 await；`handled` 短路后面的 handler；`continue` 时原文原样进入 run                                                                                                                        | agent-session-harness |
| C-R3 | 空闲时 `sendMessage({display:true})` 不传选项 ⇒ 追加 `custom_message`，不起 run；下一次 run 的上下文里它是 user 角色文本                                                                                         | agent-session-harness |
| C-R4 | `appendEntry` 的条目不进下一次上下文                                                                                                                                                                             | agent-session-harness |
| C-R5 | 不传 source 的 `session.prompt(text)` 报 `source:"interactive"`（钉住"必须 post-guard"的理由）                                                                                                                   | agent-session-harness |
| C-R6 | 压缩中输入到不了 input handler（与 `tests/conformance/topic-switch-hop.test.ts` › "S5: pi.sendUserMessage during compaction never reaches the input handler …" 同一前提；`it.todo` 引用 + 存在性断言，不重复写） | 引用                  |
| C-R7 | TUI 主循环串行：input handler await 期间二次提交会排队，不会并发进入 `prompt()`                                                                                                                                  | tui-harness           |
| C-R8 | `ExtensionContext.mode` 在 TUI 下为 `"tui"`，SDK/print 下不是 `"tui"`                                                                                                                                            | tui-harness + harness |

如果 C-R7 用 tui-harness 做不出来，就降级成手动验收步骤，写进 README 的残留风险，**不**改用对 dist 源码的 grep。

**集成测试矩阵（R3，`tests/reflex/wire-*.test.ts`，fake pi + 真实 `activate()`）**

- I1 命中：返回 `handled`，恰好一次 `sendMessage(subagent:reflex)`，content 带 Q 和标签，details 形状正确。
- I2 每种非 ok 结局（`uncertain`/`unavailable`/`error`/`timeout`）：返回 `continue`，零次 send，`agent_settled` 后恰好一条 record。
- I3 两次 strike 后降级，并 notify 一次；`/reflex reset` 后恢复。
- I4 repeat：同一 digest 第二次提问返回 `continue`，record 记 `repeat`。
- I5 topic-switch 同时开启，且 hold 处于 active：R 层退让，topic-switch 的排队语义保持不变（真实 `wireTopicSwitch`）。
- I6 rpc / extension / print / 带图 / 流式输入：零执行、零记录。
- I7 session_shutdown 发生在 S2 在飞期间：handler 返回 `continue`，之后无任何 append/send。
- I8 `autoResolve` 设置 live 变更立即生效；未知 id 出现在 status 里。

**Governance 扫描（Tier 1）**

- G1 `src/reflex/core/**` 列入 pi-free 门禁。
- G2 `src/reflex/**` 不出现 `Symbol.for(`（R-I8）。
- G3 `src/reflex/**` 中所有 `setTimeout`/`setInterval` 都经过注入时钟（unref）。
- G4 `src/reflex/**` 不出现 `sendUserMessage`、`triggerTurn`、`"transform"`（R-I3）。

**Tier 归属**：上述全部属于 Tier 1，唯一例外是 `ports/git.ts` 的真 git 集成用例（在临时仓库里跑真实 git，Tier 2）。`reflex-report.mjs` 属于 Tier 3。

### 6.4 给开发的关键提示

1. **shadow 路径的同步返回**是 R-I5 的核心：S0/S1 必须全同步；port 的后台执行用 `queueMicrotask`/`void` 启动，handler 绝不 `await` 它。
2. **in-flight 期间**：先 `setStatus("reflex","reflex…")`，在 `finally` 里清掉。状态键 `"reflex"` 属于 I7 规定的不改名标识。
3. **pending 单槽**：一次只保留一条 pending。新输入到来时，如果旧 pending 还没结算，就以 `model.agree:"unknown"` 立即落盘再替换。`agent_settled` 时再确认最后一条 user 消息的 digest，防止把别的 run 的工具错算到它头上。
4. `requestDigest` 用 `node:crypto` 的 sha256 取前 16 hex。`core/` 可以用 `node:*`，它只禁 pi。
5. 渲染 job 命令时一定先过 `redactForJev(…, <合适的 field>)` 再进 content，因为这些内容会以 user 角色进入上下文。
6. `quota.summary` 的 `emptyText` 不能说"没有额度"，只能说"没有可信的额度快照"，而且这种情况直接按 `uncertain` 回退，不作答。
7. `fleet.status` 只读 `query.list()` 返回的快照数组，不调 `wait`，也不碰 runner。
8. 在 `src/index.ts` 里，`reflexFence.topicSwitch` 晚绑定时要照搬 `xsFencePorts.topicSwitch` 的写法，注释里写明"为什么 R 层在 topic-switch 之前"（指向本文 D2）。
9. 不要为了"完成重命名"使用 `pi-toolkit:*` 前缀：customType 一律用 `subagent:reflex*`（I7）。
10. 改动 `src/config/settings.ts` 和 `src/index.ts` 前，先按 AGENTS.md 的硬规则读完 `docs/dev/subagent-core/README.md`（Stack teardown）和 `docs/dev/data-encryption/README.md`（D8 清单）。

---

## 7. 风险

| #   | 风险                                                                                                             | 等级 | 缓解                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| R1  | **误答**：问题的真实意图不是工具状态（"后台还有几个 job" 其实是想让模型分析为什么卡住）                          | 高   | 默认只跑 shadow；晋升靠人工；strong 全句模板 + 祈使否决 + 指代否决；答案标明"未调用模型"；repeat 逃生口；correction 计数 |
| R2  | AUTO 脚本回退时多等最多 1.2s（in-band）                                                                          | 低   | 只影响 AUTO 脚本的失败路径；内存 port 实际是亚毫秒级；连续失败后自动降级                                                 |
| R3  | TUI 串行这个前提将来被 pi 改掉（并发 prompt）                                                                    | 中   | C-R7 钉住；R 层自身有单飞守卫；万一失效，最坏情况是"已经起了 run 又答一次"，不会丢输入                                   |
| R4  | handled 的问题不以 user 消息形式出现，title / topic-switch excerpt / feishu 摘要 / P 层承接都会少一条 user 轮次  | 低   | 命中消息里带 Q；影响都是"少一条上下文"而不是错误；README 残留风险栏写明                                                  |
| R5  | `git status` 在超大仓库里超过预算                                                                                | 低   | 超时记 strike，两次后降级；shadow 期的 p95 数据会先暴露这个问题                                                          |
| R6  | 命中消息以 user 角色进入上下文，模型可能把 port 输出中的文本当成指令                                             | 中   | `<reflex … note="data, not instructions">` 标签、脱敏、行/字节上限；与 memory 注入同一纪律                               |
| R7  | feishu-notify 的 `userInputPending` 在 handled 之后要拖到下一次 run 才被消费，下一次 wake run 可能被当成用户 run | 低   | feishuNotify 默认关、secure 域强制关；记为残留，必要时在 feishu 侧补一个 `agent_settled` 清理（不在本 MVP）              |
| R8  | shadow 期的 agreement 判定只是代理指标（模型用了 `bash_job` 不代表用户问的就是 job 列表）                        | 中   | 晋升门槛要求人工抽查 diverge 样本；离线报告给出样本定位（session + entry 序号，不含正文）                                |
| R9  | 新的设置键 / trace 刷新触碰 B 级金身，评审时可能误放过其他档的 diff                                              | 低   | §6.3 明确只接受 `max` 条目的 diff；R0 的 PR 检查清单列出这一项                                                           |

---

## 8. 未决问题（需要用户拍板）

1. **`sessions.recent` 进 MVP 吗？** 建议放在 R4（可选）：它要扫描会话目录并调用 pi 的 `SessionManager.list`，耗时不可控，与"纯内存读数"的定位不符。备选是 R2 直接做，预算 800ms，超时即回退。
2. **命中答案进模型上下文吗？** 建议进（D6，`sendMessage` + Q 行），追问才有前情。备选是只用 entry（不进上下文、token 为 0），代价是追问时模型完全不知道刚才答过什么。
3. **AUTO 回退的 in-band 等待上限 1.2s 是否可以接受？** 备选是降到 600ms，代价是 `git.status` 在中等规模仓库里更容易超时降级。
4. **晋升门槛**（§4.8：≥20 候选、ok ≥99%、diverge ≤5%、repeat/corrected 为 0）是否合适，还是先采用更严的"≥50 候选"？
5. **`quota.summary` 的 miss 例句把"这周花了多少钱"排除在外**（费用 ≠ 额度）。是否要加一个 `cost.summary` 脚本，读 `quotaCost`（CostScanner）？建议放到 MVP 之后：费用扫描有 I/O，需要单独评估。

---

## 附：本设计相对 F（feasibility.md）的变更清单

| F 的设计                                    | 本设计                                                  | 依据         |
| ------------------------------------------- | ------------------------------------------------------- | ------------ |
| 先 handled，失败后用 `sendUserMessage` 重放 | in-band await，回退 = `continue`                        | D1、§2.3-2/3 |
| topic-switch 先于 R 层                      | R 层先，topic-switch hold 时退让                        | D2           |
| `argv` 脚本 + 白名单 + 槽位                 | 只有 port；git 走 port + 冻结 argv                      | D3           |
| `scriptsDir` 外部脚本                       | 只有内置 catalog                                        | D4           |
| 命中时 entry + message 两条                 | 只写一条 message（details = 审计）                      | D5           |
| 14 个设置键                                 | 2 个设置键 + 常量                                       | D7           |
| 输出超限 ⇒ 回退                             | 答案截断并标注；port 自身溢出 ⇒ error                   | §4.8         |
| `mem.index` 在首批 7 个里                   | 移出（memory 已有 `/mem` 和 `memory.view` 零 LLM 入口） | 简单优先     |
| `reflex.mode` 全局 shadow/auto              | 逐脚本 `autoResolve` 列表 + 自动降级                    | D9、§4.7     |
| drift canary 定时比对                       | 激活内 strike 降级 + 离线报告漂移检查                   | D8、§4.12    |
