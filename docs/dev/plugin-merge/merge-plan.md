# 三独立 pi 插件融合进 pi-subagent — 实施方案（merge-plan）

> 状态：方案待用户确认（HARD GATE：未经确认禁止开发）。
> 来源插件（已完整读码）：`~/.pi/agent/extensions/pi-hud.ts`（903 行）、
> `~/.pi/agent/extensions/web-search.ts`（886 行）、
> `~/ai/pi-claude-todo/src/{index,state,ui}.ts`（795 行，MIT，作者即本仓库用户）。
> 目标：三者以子目录模块形态并入本仓库，settings 门控，独立版从 `~/.pi/agent/extensions` 移除。

## 0. 读码确认的关键事实（方案前提）

1. **HOST_KEY guard 位置决定工具可见域**：`src/index.ts` 的 `activate()` 在文件顶部
   `if (g[HOST_KEY]) return;`——guard 之后注册的一切（工具/命令/hook）**只在主会话生效**；
   子 agent 会话的 activate() 在 guard 处早退。当前独立插件能被 subagent 使用（本方案的
   制定者就是 subagent，手里有 `web_search`），因为 pi 对每个会话（含子会话）都加载
   全局扩展。**融合后 web_search / TaskCreate 若想保持子会话可用，必须注册在 guard 之前。**
2. **pi 的重复注册行为**（读 `pi-coding-agent/dist` bundle 确认）：
   - 工具：`getAllRegisteredTools()` 是 **first-wins**（`has || set`），后注册的同名工具被
     静默遮蔽，不报错。
   - 命令：重名命令自动改名 `name:2`。
   - 结论：旧独立插件不删不会炸，但行为取决于扩展加载顺序——迁移文档必须把"删除旧插件"
     写成硬步骤，并给出"出现 `tasks:2` 命令 / 工具行为异常"的识别方法。
3. **pi core 无内置 `web_search`**（dist 里仅有无关字符串 `web_search_calls`）；本仓库
   `src/tools/` 也无 web_search / TaskCreate。无工具名冲突。
4. **footer 无人占用**：本仓库没有任何 `setFooter` 调用；pi 的 `setFooter` 语义是
   "替换内置 footer / undefined 恢复内置"。HUD 接管 footer 无内斗。
5. **widget 按 key 共存**：`setWidget(key, content, {placement})` keyed——fleet widget
   （key `pi-subagent:fleet`，aboveEditor）与 todo widget（key `claude-code-todo`，
   aboveEditor）可叠放，不冲突。
6. **status key 无冲突**：仓库现有 key：`feishu-notify` / `cache-ttl` / `goal`；HUD 用
   `pi-hud`。且 HUD footer 通过 `footerData.getExtensionStatuses()` **聚合渲染**所有扩展
   status——cache-ttl/goal/feishu 的状态行在 HUD footer 里继续可见。
7. **subagent 事件源就是本仓库**：`subagent:started/completed/failed`（stack.ts:957/1032）与
   `subagent:usage`（usage-broadcast.ts，1Hz，payload `{runs:[{runId,label?,costUsd,terminal}]}`）
   由本扩展 emit；`feishu-notify` 已在同一扩展内消费这些频道——**同进程事件总线自产自销有
   先例**。HUD 移植继续走 `pi.events`（v1 不改成直接调 stack，理由见 D4）。
8. **settings 是显式白名单解析**：`loadSettings()` 逐字段校验，嵌套组（`fabric`/`goal` 等）
   每组一段解析代码；新增设置组必须同时改：`AgentSettings` 接口、`DEFAULT_SETTINGS`、
   `loadSettings()` 解析段、`SETTING_SPECS`（进 settings editor 与 `/agent settings` 白名单）。
9. **typebox 双版本现实**：pi-ai 0.84 内部用 `typebox`（v1，StringEnum 基于它）；本仓库
   约定 `@sinclair/typebox`（0.34，唯一运行时依赖），仓库工具全部 `Type.Union([Type.Literal…])`
   表达枚举（agent-tool/set-model-tool 先例），不引 StringEnum。两者运行时结构兼容，但 TS 类型
   不兼容，混用会编译错。
10. **模块级可变状态的既有先例**：stack.ts 顶部有 `previousFleetWidget` 等 handoff 变量
    （用于跨 session dispose）。规则不是"绝对禁止"而是"必须随 session 重建正确 dispose"——
    但更干净的闭包模式（wireCacheTtl 的 `let mode`）优先。
11. **tsconfig**：`lib: ["ES2022"]` 无 DOM；`fetch`/`Response`/`Headers`/`AbortController`/
    `crypto.randomUUID` 由 @types/node（Node22）提供，无需改 tsconfig。`exactOptionalPropertyTypes`
    是三个源插件都没开过的旗标（pi-claude-todo 的 tsconfig 只开了 noUncheckedIndexedAccess），
    这是移植类型错误的主要来源。

## D1. 模块落位与文件拆分

**决策：目录名 `src/hud/`、`src/web-search/`、`src/todo/`。**

- `todo` 而非 `claude-todo`：仓库子系统一律以功能命名（bash/fabric/goal/cache-ttl），
  "claude" 是血统不是功能；用户面命令是 `/tasks`、工具是 `TaskCreate`。
- 备选：`claude-todo`（强调血统/来源可溯）。否决理由：与仓库命名语汇不一致；数据键
  `claude-code-todo-state` 原样保留（见 D3），血统在字符串层已经体现。
- `hud` 而非 `pi-hud`：同理，仓库内不需要 `pi-` 前缀。

**文件拆分**：

| 模块              | 文件            | 内容                                                                                                                                            | 行数估 |
| ----------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/hud/`        | `format.ts`     | formatTokens / formatCwdForFooter / sanitizeStatusText / formatDuration / formatSpeed / formatStartTime（纯函数）                               | ~90    |
|                   | `speed.ts`      | `SpeedTracker` 类：pushSample + computeWindowSpeed，**时钟注入**（`now: () => number`），替代散落的 streamSamples 全局态（纯逻辑）              | ~60    |
|                   | `git.ts`        | readRepoState / readWorktrees（pi.exec 包装）                                                                                                   | ~90    |
|                   | `timing.ts`     | LLM/round 计时状态 + restoreTiming + appendEntry 持久化（`pi-hud-llm-time` / `pi-hud-session-start`）                                           | ~180   |
|                   | `footer.ts`     | installFooter + 全部 render* 函数（TUI 重代码）                                                                                                 | ~330   |
|                   | `index.ts`      | `wireHud(pi)`：事件订阅、session 生命周期、`/pi-hud-refresh` 命令、`HudSession` 闭包状态容器                                                    | ~200   |
| `src/web-search/` | `config.ts`     | expandHome / parseCredentialsFile / getSearchConfig                                                                                             | ~70    |
|                   | `resilience.ts` | HttpError / isRetryableError / backoffDelay / sleep / withRequestTimeout / redactSecrets / errorMessage（纯逻辑+可注入 fetch 前的全部重试判定） | ~120   |
|                   | `providers.ts`  | searchCodex/SerpApi/Tavily/Bocha + postCodexJson + codexSearchEndpoint                                                                          | ~330   |
|                   | `format.ts`     | providerLabel / providerOrder / truncateField / formatResponse                                                                                  | ~110   |
|                   | `index.ts`      | `registerWebSearchTool(pi)`：schema + execute（failover 编排）                                                                                  | ~160   |
| `src/todo/`       | `state.ts`      | 直搬 pi-claude-todo/src/state.ts（适配 strict，见 D4）                                                                                          | ~330   |
|                   | `ui.ts`         | 直搬 ui.ts（TodoWidget/TodoPanel/renderTaskLines）                                                                                              | ~130   |
|                   | `index.ts`      | `wireTodo(pi)`：五工具 + `/tasks` + restore hooks                                                                                               | ~350   |

pi-hud 903 行必须拆：单文件超过仓库现有最大模块（stack.ts 1253 是装配例外），且
format/speed 是纯逻辑，拆出来才能单测（D5）。web-search 同理拆出 resilience/format
做无网络单测。

## D2. 门控策略

**决策：三个模块全部 settings-gated，默认全开。**

| 设置键              | 类型 | 默认   | 语义                                                                          |
| ------------------- | ---- | ------ | ----------------------------------------------------------------------------- |
| `hud.enabled`       | bool | `true` | off = 不安装自定义 footer（pi 内置 footer 保持原样）、不注册 status/命令/计时 |
| `webSearch.enabled` | bool | `true` | off = 不注册 `web_search` 工具（所有会话）                                    |
| `todo.enabled`      | bool | `true` | off = 不注册 TaskCreate/List/Get/Update/Delete、`/tasks`、widget              |

理由：

1. 用户当前三个插件全开在用；融合后独立版被移除，默认关 = 升级即功能消失。
2. 仓库先例：`fleetWidget` 默认 true（同样是侵入式 UI）、`bashJobs` 默认开（R4）、
   `goal.enabled` 默认 true。本仓库的哲学是"自己的功能默认开，用设置关"。
3. HUD 接管 footer 虽强侵入，但仓库内无竞争者（事实 4），且 `hud.enabled=false` 一行
   即可完全还原 pi 原生 footer。

备选（记录在案，用户可在评审时推翻）：`hud.enabled` 默认 `false`——对 npm 上非本用户的
安装者更保守。否决倾向：与 fleetWidget/bashJobs 先例不一致，且给主用户制造一次性手动步骤。

**settings editor 暴露**：三个键加入 `SETTING_SPECS`（`bool("hud.enabled", "…")` 等），
自动进入 `/agent settings` TUI 编辑器与文本命令白名单；均为**非 live**（activate 时捕获，
改动后提示 `/reload`），与 cache-ttl/extend 同级。

**注册位置（关键结构变更，归装配包）**：

```ts
export default function activate(pi) {
  const settings = loadSettingsFromFile(); // ← 从 guard 后移到 guard 前（纯读，无副作用）
  if (settings.webSearch.enabled) registerWebSearchTool(pi); // guard 前：子会话也有
  if (settings.todo.enabled) wireTodo(pi); // guard 前：子会话也有
  const HOST_KEY = Symbol.for("pi-subagent:host");
  if (g[HOST_KEY]) return; // 子会话到此为止
  // ……原有全部装配不变……
  if (settings.hud.enabled) wireHud(pi); // guard 后：仅主会话
}
```

- `web_search` 必须在子会话可用（现状如此，subagent 检索是日常路径）。
- todo 同理：子会话各自持有独立 task list（状态存各子会话自己的 session 文件），与独立版
  行为一致。
- HUD 只在主会话：子会话 `ctx.mode !== "tui"` 本来就全 inert，没必要注册。

**迁移步骤（写进 README + 迁移指南，见 D7）**：

1. 升级 pi-subagent 到融合版本。
2. 删除 `~/.pi/agent/extensions/pi-hud.ts`、`~/.pi/agent/extensions/web-search.ts`、
   `~/.pi/agent/extensions/claude-todo`（符号链接 → `~/ai/pi-claude-todo`）。
3. `/reload`（或重启 pi）。
4. 验证：footer 出现 HUD；`web_search` 可用；`/tasks` 可用。
5. 若忘记删除旧插件：工具 first-wins 遮蔽（行为取决于加载顺序）、命令出现 `/tasks:2`
   `/pi-hud-refresh:2`——看到 `:2` 后缀即说明有残留。
6. 可选：在 `~/.pi/agent/pi-subagent.json` 里设 `"hud": {"enabled": false}` 等关闭单个模块。

## D3. 冲突处理与字符串常量

| 面                     | 决策                                                                              | 理由                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| footer                 | HUD 独占；`hud.enabled=false` 时完全不碰                                          | 仓库无人占用（事实 4）                                                                                                               |
| widget                 | todo 保留 `aboveEditor` + key `claude-code-todo`；与 fleet 叠放                   | keyed 共存（事实 5）                                                                                                                 |
| status key             | 保留 `pi-hud`；HUD footer 聚合渲染 `cache-ttl`/`goal`/`feishu-notify` 状态        | 事实 6；仓库各 key 无碰撞                                                                                                            |
| 工具名                 | 不改名（`web_search`、`TaskCreate` 等五件）                                       | 仓库与 pi core 均无冲突（事实 3）；改名会破坏用户现有 prompt 习惯与历史会话里的 toolResult 名                                        |
| 持久化 customType      | **原样保留**：`claude-code-todo-state`、`pi-hud-llm-time`、`pi-hud-session-start` | 继承用户现有会话数据（fork/resume 旧会话时 todo 状态与计时统计无损读回）。利大于弊：字符串里的 "claude-code"/"pi-hud" 血统不影响功能 |
| widget key             | 保留 `claude-code-todo`                                                           | 同上；且若用户忘删旧插件，同 key 互相覆盖比双 widget 叠放的故障形态更轻                                                              |
| LEGACY_STATUS_KEY 清理 | 保留（`claude-code-todo-status` 置 undefined）                                    | 无成本，清掉历史遗留                                                                                                                 |
| 命令                   | 保留 `/tasks`、`/pi-hud-refresh`                                                  | 用户肌肉记忆；`/cache-ttl` 保留独立版名字有先例                                                                                      |
| subagent 事件消费      | 继续走 `pi.events` 总线，不改为直调 stack                                         | v1 最小 diff；同进程总线自产自销有 feishu-notify 先例（事实 7）；同时保留对旧 `subagents:*`（复数）频道的兼容监听                    |
| todo widget 的 UI 门   | 新增 `ctx.mode === "tui"` 判定才 setWidget（独立版无此判定）                      | 子会话是 rpc 模式，避免子会话的 todo widget 写进 RPC UI 桥；行为差异记录在模块注释                                                   |

## D4. 代码适配清单

### D4.1 typebox / schema 适配（web-search + todo）

- `import { Type } from "typebox"` → `import { Type, type Static } from "@sinclair/typebox"`。
- `StringEnum([...])`（pi-ai，typebox v1 类型）→ 仓库惯例
  `Type.Union([Type.Literal("auto"), Type.Literal("codex"), …])`（agent-tool.ts:134 先例）。
  共 3 处（web-search 的 provider / engine；todo 的 StatusSchema）。
- 不新增任何依赖：`@sinclair/typebox` 已是 dependencies；pi-tui/pi-ai/pi-coding-agent
  是既有 peer。
- 备选：加 `typebox` v1 依赖沿用 StringEnum（provider 兼容性略好——Google API 不吃
  anyOf/const）。否决：违反 AGENTS.md "唯一运行时依赖"约定；仓库现有 Union-of-Literal
  工具在用户全部 provider 上日常可用。

### D4.2 严格模式适配预估（三个源插件均未在 exactOptionalPropertyTypes 下编译过）

统一处理策略（按优先级）：

1. **接口字段放宽**：内部数据结构的可选字段声明为 `field?: T | undefined`
   （如 web-search 的 `SearchResult.url`、`SearchResponse.knowledgeGraph`），
   消除构造处 `{url: maybeUndefined}` 成片报错——最小 diff。
2. **noUncheckedIndexedAccess**：`match[1]` / `arr[0]` / `arr[arr.length-1]` 返回
   `T | undefined`——用局部变量 + 显式 undefined 判断，**禁止无脑 `!`**（仓库风格，
   todo 原代码的 `byId.get(blockedId)!` 属于已有断言可保留）。
3. **exactOptionalPropertyTypes 的条件赋值**：`task.activeForm = optionalText(...)`
   （值可能 undefined）必须改成：
   ```ts
   const v = optionalText(input.activeForm, "activeForm", 200);
   if (v === undefined) delete task.activeForm;
   else task.activeForm = v;
   ```

逐文件预估：

| 文件          | 预估修复点 | 主要形态                                                                                                                                                                                                                  |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web-search.ts | ~10 处     | `match[1]`/`match[2]`（parseCredentialsFile）；SearchResult/KnowledgeGraph 接口放宽 `                                                                                                                                     | undefined`（5-6 字段）；其余已写得较防御（`?.`、`if (nextProvider)` 都在） |
| pi-hud.ts     | ~15 处     | `match[1]`/`match[2]`（readRepoState 的 branch.ab 解析）；`streamSamples[0]`、`streamSamples[streamSamples.length-1]`（→ SpeedTracker 内局部判空）；`renderWorktreeLines` 的 `lines.push` 数组类型；`details.runIds` 窄化 |
| todo/state.ts | ~6 处      | updateTask 里 `task.activeForm/owner/metadata = optionalText(...)` 三处条件赋值；`TaskInput` 强转已带 `as`                                                                                                                |
| todo/ui.ts    | ~4 处      | `cachedWidth?: number` / `cachedLines?: string[]` 被赋 `undefined` → 改 `number                                                                                                                                           | undefined` 显式声明（2 字段 × 2 类）                                       |
| todo/index.ts | ~3 处      | typebox/StringEnum 替换；`result.content[0]` 已有 `?.` 防御                                                                                                                                                               |

处理方式：移植后跑一次 `npm run typecheck`，按报错清单逐个修——预估单模块 30-60 分钟内
收敛；任何"看不懂就先 `as never`"的修法禁止入库（仓库已有 `parameters as never` 这类
**有注释说明的**断言先例，新增断言必须附注释）。

### D4.3 timer unref（仓库铁律：ref'd timer 会卡死 `pi -p`）

- pi-hud：`refreshTimer`（5s）、`llmTimer`（1s）两个 `setInterval` → 创建后立即
  `.unref()`。虽然它们只在 tui 模式启动，规则无例外。
- web-search：`sleep()` 与 `withRequestTimeout()` 里的 `setTimeout` → `.unref()`
  （它们都会被 clear，但 print 模式下的工具调用同样经过这里）。
- todo：无 timer。

### D4.4 模块级状态改造

- **pi-hud**：全部 20+ 个 `let`/`Map` 模块级变量收进 `HudSession` 对象；`wireHud(pi)`
  内闭包持有 `let current: HudSession | undefined`，`session_start` 重建、`session_shutdown`
  dispose（清 timer + `setFooter(undefined)` + `setStatus("pi-hud", undefined)`）。
  仿 `wireCacheTtl` 的闭包模式（先例：cache-ttl.ts 的 `let mode`），**不**引入新的模块级
  handoff 变量。`/reload` 路径：旧 activation 的 session_shutdown 释放 → 新 module 的
  activate 重建，无残留。
- **todo**：`state`/`queue`/`currentUI` 本来就在 activate 闭包内，天然合规；子会话各自
  独立闭包 = 独立 task list（与独立版一致）。
- **web-search**：无会话状态（config 在 execute 时读取），无需改造。

### D4.5 inert 约束

- 子会话：guard 前注册的 web_search/todo **故意可用**（见 D2）；HUD 不进入子会话。
- `pi -p` / rpc：HUD 全部 handler 保留 `ctx.mode !== "tui"` 早退；todo 的 setWidget 加
  tui 门（D3）；web_search 无 UI 依赖。
- HOST_KEY 语义不变；settings 加载前移是纯读操作，不改变 guard 语义。

### D4.6 其他移植注意

- pi-hud 的 `pi.exec("git", …)` 在非 git 目录返回 code≠0 → `undefined` 分支已有；
  `pi.exec` 在仓库内 goal/hook.ts 有同款用法先例。
- web-search 的 `DEFAULT_MAX_BYTES` / `truncateHead` / `formatSize` 从
  `@earendil-works/pi-coding-agent` 主入口导入——peer 范围 `>=0.84.0 <0.86.0` 已覆盖，
  移植后在 `src/adapters/pi-compat.ts` 的注释里不需要登记（非未文档化 API）。
- 版权：pi-claude-todo 为 MIT 且作者即本仓库用户；三源均为用户自有代码，无第三方
  授权问题。todo 文件头保留一行来源注释即可。

## D5. 测试策略

`tests/` 镜像 `src/`：`tests/hud/`、`tests/web-search/`、`tests/todo/`。

| 测试文件                              | 内容                                                                                                                                                                                                                                     | 规模估  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `tests/todo/state.test.ts`            | 移植 pi-claude-todo `src/__tests__/state.test.ts` 的 7 个测试（import 路径改 `../../src/todo/state.js`）+ 补 `restoreState` round-trip / 脏数据拒绝用例                                                                                  | ~120 行 |
| `tests/todo/tools.test.ts`（新）      | 用假 ExtensionAPI（参考 tests/tools/ 现有 fake pi 模式）驱动 TaskCreate→Update→Delete 全链路，断言 enqueue 串行化与 persist 调用次数                                                                                                     | ~150 行 |
| `tests/web-search/resilience.test.ts` | isRetryableError 矩阵（401/403 永不重试、429+配额文案不重试、429 普通重试、5xx/408 重试、网络错误码重试、cancel 不重试）；backoffDelay 区间；redactSecrets（query key/bearer/字面密钥）；withRequestTimeout 超时路径（vi.useFakeTimers） | ~150 行 |
| `tests/web-search/format.test.ts`     | providerOrder（auto/指定 provider 置顶）；codexSearchEndpoint 三种 baseUrl 形态；truncateField 边界；formatResponse（answer/kg/results/截断尾注/failover 前言）                                                                          | ~120 行 |
| `tests/web-search/tool.test.ts`       | `vi.stubGlobal("fetch", …)` 驱动 execute：无凭证报错、首选成功、首选 401 → failover 次选成功（断言 onUpdate 文案）、全部失败汇总错误                                                                                                     | ~150 行 |
| `tests/hud/format.test.ts`            | formatTokens 全档位、formatDuration（<1s/s/m/h）、formatSpeed、formatCwdForFooter（home 内/外/相等）、sanitizeStatusText                                                                                                                 | ~100 行 |
| `tests/hud/speed.test.ts`             | SpeedTracker 时钟注入：窗口内速率、跨度 <500ms 返回 undefined、burst 单样本回退、样本裁剪                                                                                                                                                | ~80 行  |
| `tests/hud/timing.test.ts`            | restoreTiming 对 appendEntry 回放（含 legacy `durationMs` 字段兼容）——纯数据进纯数据出                                                                                                                                                   | ~80 行  |

**不测 / 真机验证的部分**：footer.ts 渲染（theme/TUI 耦合重）、git.ts（依赖真实仓库）、
事件订阅编排。真机验证清单（融合后在本仓库会话里逐项过）：

1. V1：启动 pi → footer 显示 pwd/git/上下文用量/model；`hud.enabled=false` + /reload → 恢复内置 footer。
2. V2：跑一个 Agent 子代理 → footer `bg ●1` 出现，`+agents $x` 实时跳动，完结后归零（事件来自本扩展自己的 stack.ts emit——自产自销验证）。
3. V3：`/pi-hud-refresh` 正常；git 仓库外启动不炸。
4. V4：`/reload` 三次 → footer 不闪烁、不重复（HudSession dispose 验证）；`pi -p "hi"` 能正常退出（unref 验证）。
5. V5：子会话里 `web_search` 可用（派一个 subagent 让它搜索）；断网/错 key 时 failover 文案正确。
6. V6：`TaskCreate` 建两个任务 → aboveEditor widget 出现在 fleet widget 旁（共存验证）；`/tasks` 面板滚动正常；fork 旧会话（含 `claude-code-todo-state` 数据）→ 任务列表无损恢复。
7. V7：子会话里 TaskCreate 可用且与主会话任务列表隔离。
8. V8：旧插件残留检测——临时留一份旧 web-search.ts → 确认 first-wins 遮蔽形态与文档描述一致，然后删除。

## D6. 实施拆包（并行 dev 包）

装配点（index.ts / settings / setting-specs）全部归**装配包 D**，A/B/C 三包只定义
入口函数、不碰共享文件——彻底消除写冲突。

| 包                              | 文件域（允许新建/修改）                                                                                                                                                                                                                                                  | 入口契约                                                                                   | 冻结面（禁止触碰）                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **A. web-search**               | `src/web-search/**`、`tests/web-search/**`                                                                                                                                                                                                                               | `export function registerWebSearchTool(pi: ExtensionAPI): void`（src/web-search/index.ts） | `src/index.ts`、`src/config/**`、其他模块、`package.json` |
| **B. todo**                     | `src/todo/**`、`tests/todo/**`                                                                                                                                                                                                                                           | `export function wireTodo(pi: ExtensionAPI): void`                                         | 同上                                                      |
| **C. hud**                      | `src/hud/**`、`tests/hud/**`                                                                                                                                                                                                                                             | `export function wireHud(pi: ExtensionAPI): void`（settings 门在调用侧）                   | 同上                                                      |
| **D. 装配（串行，A-C 合并后）** | `src/index.ts`（settings 前移 + 三个 wire 调用）、`src/config/settings.ts`（AgentSettings + DEFAULT_SETTINGS + loadSettings 解析段，仿 `extend`/`cacheTtl` 组模式）、`src/config/setting-specs.ts`（三个 bool spec）、`AGENTS.md`、`README.md`、`docs/dev/plugin-merge/` | ——                                                                                         | A/B/C 的模块内部                                          |

- A/B/C 可三路并行（文件域零交集）；各自跑 `npm run typecheck && npx vitest run tests/<mod>/`
  自验。注意：A/B/C 开发期间 `npm test` 全量必须保持绿（不碰共享文件即可保证）。
- D 包先合 A/B/C 的 PR/分支，再做装配；装配后跑 CI 四件套（format:check → typecheck →
  test → build）。
- 约定：A/B/C 的入口函数里**不读 settings**（门在 D 的调用侧），保持模块纯化、可独立测。

## D7. 文档与收尾

1. **AGENTS.md**：
   - "What this is" 段尾加一句：仓库同时融合提供 HUD footer / web_search / todo 任务工具
     （均 settings 门控）。
   - Repository layout 增加三行：`src/hud/`、`src/web-search/`、`src/todo/` 简介；
     `docs/dev/` 列表加 `plugin-merge`。
2. **README.md**：
   - "功能" 段加三条（HUD footer / web_search 多 provider failover / Claude Code 风格任务工具）。
   - "命令" 段加 `/tasks`、`/pi-hud-refresh`。
   - "配置" 段加 `hud.enabled` / `webSearch.enabled` / `todo.enabled`。
   - 新增 "从独立插件迁移" 小节（D2 的迁移 6 步 + `:2` 残留识别）。
3. **CHANGELOG**：Conventional Commits 自动生成，提交切分：
   - `feat(web-search): merge standalone web-search extension as src/web-search`
   - `feat(todo): merge pi-claude-todo as src/todo`
   - `feat(hud): merge pi-hud footer HUD as src/hud`
   - `feat(settings): gate merged plugins behind hud/webSearch/todo toggles`（装配包）
     选三条 feat 而非一条：历史可读、可独立 revert；装配单独一条让 settings 变更有独立锚点。
4. **用户侧迁移指南**：即 README "从独立插件迁移" 小节；发布后对用户复述一遍 D2 步骤。

## 风险与不确定点

1. **子会话激活顺序假设**：web_search/todo 注册在 guard 前，依赖"pi 对每个子会话都重新
   activate 全局扩展"这一观察事实（当前独立插件在子会话可用即为证据）。若未来 pi 版本
   改为子会话不加载全局扩展，子会话会失去这两个工具——届时需改走 tool-scope 注入
   （`src/runtime/tool-scope.ts` 的 message_agent 模式）。v1 不做。
2. **rpc 模式子会话的 setWidget 行为**：pi 的 noOpUIContext 对 setWidget 是 no-op，rpc
   模式另有实现；todo 加 tui 门后此路径已封死，残余风险低。
3. **HUD 与本扩展 emit 事件的事件顺序**：`subagent:usage` 的 1Hz 广播由 stack 持有，
   HUD 监听注册在 activate 时——时序上监听先于 emit，无丢帧顾虑；但未做时序单测，
   靠 V2 真机验证。
4. **exactOptionalPropertyTypes 报错量为上表预估值**，实际以 typecheck 清单为准；
   若某模块报错数超出预估 2 倍，回报用户再决定是否调整拆分粒度。
5. **重复 footer 竞争**：若用户另装了其他接管 footer 的扩展（本机未发现），
   setFooter 后注册者胜出——迁移指南提一句即可，不做运行时检测。

---

## 评审修订（opus-5 reviewer，2026-? 轮次；用户已确认）

**Blocker B1（必修，D 包前置）**：`loadSettingsFromFile()` 非纯读——内含迁移写盘（`settings.ts:648-674`，`writeFileSync` 直写 + `rmSync`），前移到 guard 前会让每个子会话并发写全局配置文件。
修法：拆 `readSettingsNoMigrate()`（跳过 migrate/write/rm，复用解析），guard 前只用它；guard 后仍走完整 `loadSettingsFromFile()`。顺手把写盘改 tmp+rename 原子写（独立 commit）。新增集成测试断言「guard 前代码路径零文件写」（预占 HOST_KEY 先例见 tests/integration/*-wiring.test.ts）。

**Should-fix 纳入施工**：

- S1：迁移指南判据更正——重名命令是**全部**加后缀（`/tasks:1`+`/tasks:2`，裸 `/tasks` 消失）；删旧插件升级为升级前置条件。
- S2：guard 前注册仅进入子会话候选集，可见性受 agent type `tools` 白名单截断（Plan 类型会剥掉 Task*——不加，web_search 已在）；merged 工具**不进** `RESERVED_TOOL_NAMES`；D2/D4.5 写明这层语义。
- S3：pi-hud 的 1Hz llmTimer 在非 TUI 路径（onBgStarted 无 mode 门）也会启动；turn_start 在 mode 判定前就 appendEntry。落法：HudSession 收敛单一 `live` 布尔（session_start 判一次），所有 handler/事件回调统一 `if (!session.live) return`；unref 是硬必需。
- S4：pi-hud 的 6+1 个 `pi.events.on` 退订函数全部丢弃、`/reload` 后监听泄漏（事件总线跨 reload 存活）。硬要求：wireHud 收集全部 unsubscribe，session_shutdown 退订；补「activate→shutdown→activate 三轮后监听数不增长」单测（假 events bus）。
- S5：旧 todo 残留故障形态更正——widget 会冻结在陈旧快照（比叠放更难排查），迁移指南补症状。
- S6：新增 `tests/integration/merged-plugins-wiring.test.ts`（①预占 HOST_KEY 仍注册 web_search+Task*、不注册 Agent//agent/HUD；②未占则齐备；③三门控 false 零注册；④guard 前零文件写）。`replayState` 提为纯函数 `replayState(entries)` 入 `src/todo/state.ts`，补三类输入单测。
- S7：A/B/C 各自内联 fake pi，禁止新建跨包 helper；README 写明两处配置源（pi-subagent.json + web-search.env）。
- S8：README「功能」段 HUD 条目第一句写「安装即接管 footer，`hud.enabled=false` 一行还原」。
- N2：todo 源是 Bundler resolution，相对导入须补 `.js`。
- N3：strict 形态补「向外部类型可选字段传 `T|undefined`」（如 ResponseInit.statusText）需条件展开。
- N4：insecureTls 走 node:https，fetch stub 抓不到，单测标注不覆盖。
- N5：todo 的 tui 门落点在 `restore()`——仅 tui 下赋值 `currentUI`。
- N6：`subagent:usage` payload 有 `activeCostUsd`，HUD 可直接使用（可选优化）。
- N7：风险 3 消掉——监听严格先于 emit，结构上不可能丢帧。
