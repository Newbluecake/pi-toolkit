# consult A/B 埋点方案（L2）

> 来源：`eval-2026-10.md` §6.3 / §7。那次评估之所以只能靠 label 词集 Jaccard 配对包、靠正则从 verifier 文本里抽结论，
> 是因为 `experts` 白名单、consult 结局、车道 / 包 id、验收结论都没有落进 `subagent:run`。
> 本方案只补埋点，让以后按包随机化的 A/B（挂专家 vs 不挂）能**直接从持久化数据**分析，不再需要启发式。
> 约束：字段全部可选、只增不改；旧条目照常解析；字段缺席时零变化；**子会话可见的 prompt 和工具面不变**。

## 0. 给用户的一段话

做完之后，每个 run 的 `subagent:run` 条目会多带四样东西：派发时实际挂上的专家清单（`diag.experts`）、
这次 run 内所有 consult 调用的汇总（`diag.consults`：调用次数、按原因分的结局、截断次数、花费、耗时）、
主会话派发时填的可选元数据（`diag.dispatchMeta`：车道、包 id、特性、A/B 臂），以及结构化的验收结论
（verifier 用 `schema:"verdict/v1"` 派发时，`outcome.structuredResult` 里是 `{verdict, blockers, findings, report}`）。
主会话这边只多一个可选的 `meta` 参数和一个 schema 预设名，子 agent 看到的东西不变。按包抽签由一个确定性脚本完成
（`node scripts/exp/consult-ab-arm.mjs <packageId>`，同一个包永远抽到同一臂）。分析脚本
`scripts/exp/consult-ab-analyze.mjs` 读会话文件，按臂输出首验通过率（带置信区间）、返工轮数、成本和墙钟时间。
按 eval 的估算，每臂大约要 150 个包才能看出 15 个百分点的差异，所以这次的工作只是"让实验做得成"，
实验本身仍需要数周的生产流量。

## 1. 现状与接入点（已核实）

| 事实                                                                                                                                                                                                | 位置                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 解析后的白名单 `SpawnRequest.consultExperts` 只被 adapter 拿来决定是否注入 consult，**不进 diag**                                                                                                   | `src/tools/agent-tool.ts:385-415`；`runtime-adapter.ts:732`           |
| enqueue 时写一次的元数据通道：adapter 构造 `displayMeta` → runner 的 `enqueued.meta` → reducer 折进 diag                                                                                            | `runtime-adapter.ts:966`；`runner.ts:766`；`state-machine.ts:721-726` |
| 持久化面不对称：终态快照写**全量** diag；非终态 journal 条目只投影 `JOURNAL_DIAG_FIELDS` 白名单（崩溃后 `interruptedFromJournal` 种回的 aborted 快照也只有这些字段，而 aborted 是合法的 resume 源） | `src/core/run-journal.ts:36-68,70-75,128-148`                         |
| `SpawnRequest` 每个新字段都必须进 `THREADED` 或 `NOT_THREADED`，否则编译不过（Gate A）                                                                                                              | `src/service/request-threading.ts`                                    |
| consult 的结局只存在于子会话 toolResult 的 `details`（`outcome/costUsd/durationMs/truncated/partial`）                                                                                              | `src/consult/tool.ts:247-279`                                         |
| 白名单不匹配走 throw（`matchExpertRef`）；pi 把它变成 `isError` + `content[0].text=message` + `details:{}`                                                                                          | `tool.ts:339`；`pi-agent-core/dist/agent-loop.js:634`                 |
| driver 已经把 `tool_execution_end` 映射为 `tool_end`（目前丢掉 `result`）；reducer 的 `toolTrailPatch` 在任何 phase 都会 fold                                                                       | `session-driver.ts:378`；`state-machine.ts:156,864`                   |
| consult 花费已经通过 X12 吸收进提问方的 `diag.usage`，`consultRunId` 记在 `absorbedRunIds`                                                                                                          | `session-driver.ts:274`                                               |
| schema 的 host 侧复验在 adapter 里，之后会再 `store.put` 一次（经 `wrapWithRunLog`）⇒ 带 `structuredResult` 的终态条目 `updatedAt` 更晚                                                             | `runtime-adapter.ts:994-1003`；`stack.ts:1566`                        |
| 有 `structuredResult` 时，工具结果和通知直接显示 `JSON.stringify` 的结果                                                                                                                            | `agent-tool.ts:515`；`result-tool.ts:543`；`runtime-adapter.ts:1049`  |
| 字符串形式的 `schema` 如果不是合法 JSON，目前会报错 ⇒ 把预设名做成字符串不会破坏任何现有调用                                                                                                        | `src/core/json-schema.ts:38`                                          |
| 模型可见的字符串只能用英文（`model-facing-strings.test.ts`）                                                                                                                                        | `tests/tools/`                                                        |

## 2. 冻结接口（P1a 落地，其他包据此编码）

```ts
// src/core/dispatch-meta.ts（新，纯函数）
export type DispatchLane = "L0" | "L1" | "L2" | "L3";
export type AbArm = "experts" | "control";
export interface DispatchMeta {
  lane?: DispatchLane;
  packageId?: string;
  feature?: string;
  abArm?: AbArm;
}
export const DISPATCH_META_KEYS = ["lane", "packageId", "feature", "abArm"] as const;
export const DISPATCH_META_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/; // packageId 与 feature 共用
export function parseDispatchMeta(raw: unknown):
  | { ok: true; meta: DispatchMeta | undefined } // {} 或 undefined ⇒ meta 为 undefined，不写字段
  | { ok: false; error: string }; // 未知键、非 plain object、正则不匹配、abArm 没配 packageId
```

```ts
// src/core/consult-summary.ts（新，纯函数；core 不依赖 consult/）
export const CONSULT_OUTCOMES = [
  "completed",
  "unavailable",
  "still_running",
  "busy",
  "context_too_large",
  "cost_too_high",
  "timeout",
  "turn_cap",
  "cost_cap",
  "failed",
  "aborted",
] as const;
export type ConsultCallResult = (typeof CONSULT_OUTCOMES)[number] | "bad_ref" | "invalid" | "unknown";
export const CONSULT_NOT_IN_WHITELIST_MARK = "is not in this run's expert whitelist"; // tool.ts 的 throw 文案引用它
export interface ConsultCallFact {
  result: ConsultCallResult;
  expertRunId?: string;
  costUsd?: number;
  truncated?: true;
  partial?: true;
}
export interface ConsultSummary {
  calls: number;
  byResult: Partial<Record<ConsultCallResult, number>>;
  truncated: number;
  partial: number;
  /** 各次 details.costUsd 之和。已经包含在 diag.usage 里（X12），只是拆分，绝不能再加一次。 */
  costUsd: number;
  /** 发起了 consult 子 run 但 costUsd 缺失或为 0 的次数（例如 zhipu-pool 撞帽） */
  unpricedCalls: number;
  /** 工具墙钟时间（tool_start → tool_end）；取不到起点时记 0，同时计入 latencyUnknown */
  latencyMs: number;
  maxLatencyMs: number;
  latencyUnknown: number;
  byExpert?: Record<string, number>; // 最多 16 个键，超出部分记进 "_other"
}
export function classifyConsultToolEnd(isError: boolean, result: unknown): ConsultCallFact;
//   isError 且 content 文本含 MARK ⇒ bad_ref；isError 但不含 ⇒ invalid（参数校验失败或空问题）
//   !isError ⇒ details.outcome ∈ CONSULT_OUTCOMES ? 原值 : "unknown"
export function foldConsultCall(
  prev: ConsultSummary | undefined,
  f: ConsultCallFact,
  latencyMs: number | undefined,
): ConsultSummary;
```

```ts
// src/core/verdict-schema.ts（新）
export type SchemaPresetId = "verdict/v1";
export const VERDICT_SCHEMA_V1: JsonSchema; // 见 §4
export const SCHEMA_PRESETS: Readonly<Record<SchemaPresetId, JsonSchema>>;
export function resolveSchemaPreset(raw: unknown): { id: SchemaPresetId; schema: JsonSchema } | undefined;
/** host 侧展示：verdict/v1 且形状合法 ⇒ `${report}\n\nverdict: ${verdict} · blockers ${n} · findings ${k}`；否则 JSON.stringify */
export function renderStructuredForHost(structured: unknown, preset: SchemaPresetId | undefined): string;
```

```ts
// src/core/types.ts 增量（全部可选）
export interface RunExpertRecord { runId: RunId; label?: string; agentType: string; kind?: "main"; pending?: true }
SpawnRequest   += { dispatchMeta?: DispatchMeta; schemaPreset?: SchemaPresetId }
RunDisplayMeta += { experts?: { refs: RunExpertRecord[]; granted: boolean }; dispatchMeta?: DispatchMeta;
                    schemaPreset?: SchemaPresetId }
RunDiagnostics += { experts?: {...同上}; dispatchMeta?: DispatchMeta; schemaPreset?: SchemaPresetId;
                    consults?: ConsultSummary }
DriverEvent tool_end += { consult?: ConsultCallFact }
```

`experts.granted=false` 表示派发时挂了专家，但 consult 工具实际没注入（`consult.enabled=false`，或者是只读域）。
分析时这种 run 不能算进 experts 臂。`refs` 最多 16 条。

## 3. 关于"`meta` 要不要复用 displayMeta"

`RunDisplayMeta` 是 adapter 内部构造的结构，不是模型可传的参数；它的价值在于那条"enqueue 时写一次、折进 diag"的通道
（终态快照全量持久化；journal 按白名单投影，所以 P1a 要把新字段加进白名单）。方案是**传输复用 displayMeta，模型面另开一个参数**：Agent 工具新增 `meta`，
校验后写进 `SpawnRequest.dispatchMeta`（`NOT_THREADED`，由 adapter 消费），adapter 再把它放进 `displayMeta.dispatchMeta`，
reducer 的 `enqueued` 分支写一次 `diag.dispatchMeta`。没有另起一条 RunInput。
`meta` **只加在顶层 `AgentToolParams`**，不加在 `NestedAgentToolParams`：子会话的工具 schema 保持逐字节不变，
嵌套 run 本身就会被分析脚本按"被吸收"排除，用不上这个字段。`buildPrompt` 不读 `dispatchMeta`，所以它不会出现在子 prompt 里。

## 4. 验收结论 schema（只定义一次：`src/core/verdict-schema.ts`）

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "blockers", "findings", "report"],
  "properties": {
    "verdict": {
      "enum": ["pass", "conditional_pass", "reject"],
      "description": "pass = accepted · conditional_pass = accepted with listed follow-ups · reject = sent back"
    },
    "blockers": { "type": "integer", "minimum": 0, "description": "Number of findings that block acceptance." },
    "findings": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "summary"],
        "properties": {
          "severity": { "enum": ["blocker", "major", "minor", "nit"] },
          "summary": { "type": "string", "minLength": 1, "maxLength": 300 },
          "location": { "type": "string", "maxLength": 200 }
        }
      }
    },
    "packageId": { "type": "string", "maxLength": 64 },
    "report": {
      "type": "string",
      "minLength": 1,
      "maxLength": 60000,
      "description": "Your full report in your usual output format (matrix, commands, findings)."
    }
  }
}
```

- schema 里所有字符串（enum 和 description）只用英文：StructuredOutput 的参数 schema 会注入子会话，模型可见，
  而且 `model-facing-strings.test.ts` 的 `collectDescriptions`（:18）会递归扫描 schema。
  中文对照（pass=通过、conditional_pass=有条件通过、reject=打回）只写在 `references/consult-ab.md`（P4）。
- 有 `report` 字段，verifier 照常写完整报告，主会话的阅读体验不会退化。host 侧用 `renderStructuredForHost` 渲染成
  "报告原文 + 一行 verdict"，不再显示一坨转义过的 JSON。`details.structuredResult` 保持原始对象不变。
- 用法：`Agent({ subagent_type:"verifier", schema:"verdict/v1", meta:{ lane:"L2", packageId:"..." }, ... })`。
  reviewer 可以复用同一个预设（`pass` / `reject` 对应"通过 / 有 Blocker"）。
- `blockers` 应该等于 `findings` 里 `severity=blocker` 的条数，但 JSON Schema 表达不了这种跨字段约束；分析脚本会核对，不一致的记为 `verdictInconsistent`。

## 5. 分包（文件互不相交）

依赖关系：**P1a →（P1b ∥ P2）**；P3、P4 随时可以并行（P3 只依赖 §2 和 §4 冻结下来的持久化形状）。

### P1a — core 纯层（general，L2）

- 新建 `src/core/dispatch-meta.ts`、`src/core/consult-summary.ts`、`src/core/verdict-schema.ts`，内容按 §2 和 §4。
- `src/core/types.ts`：按 §2 增加字段，JSDoc 写明"写一次 / 只读 / 旧条目可缺"。
- `src/core/run-journal.ts`：把 `experts`、`dispatchMeta`、`schemaPreset`、`consults` 加进 `JOURNAL_DIAG_FIELDS`。
  `projectDiag` 只复制已定义的值，所以字段缺席的 run 在 journal 里仍然没有这些键。不加的后果：崩溃中断的 run 会丢掉
  `dispatchMeta`，D3 的 resume 继承读到 undefined，返工数据被当成 unenrolled。
- `src/core/state-machine.ts`：
  ① `enqueued` 分支在现有的 meta 展开后面追加 `experts`、`dispatchMeta`、`schemaPreset` 的条件展开；
  ② `toolTrailPatch` 的 `tool_end` 分支（现有代码在 `state-machine.ts:173-175`，`!history` 时**提前 `return {}`**）。
  **实现规则**：consult 的折叠必须在 history 的 early-return 之前单独算好。先算出 `consultPatch`：`e.consult` 存在时，
  起点取 toolHistory 里同一个 toolCallId 且 `endedAt` 为空的记录的 `startedAt`；找不到就用 `diag.currentTool`
  （toolCallId 也要相同）；再找不到就是 undefined。然后 `consults = foldConsultCall(diag.consults, e.consult, at - startedAt)`。
  之后再走既有的 history 更新，凡是 return 的地方都合并上 `consultPatch`，包括 `!history` 和"记录已被 ring 逐出"这两条路径。
  不改任何状态迁移。
- 测试：`tests/core/dispatch-meta.test.ts`（未知键、空对象、正则、abArm 缺 packageId）、`tests/core/consult-summary.test.ts`
  （每一种结局、bad_ref/invalid/unknown、byExpert 上限、unpriced、latency 缺失）、`tests/core/verdict-schema.test.ts`
  （合法和非法 payload 过 `validateAgainstSchema`；`renderStructuredForHost` 的两条分支）；
  `tests/core/presentation-diag.test.ts` 新增两个用例：diag 没有 `toolHistory` 时，consult 的 tool_end 仍然 `calls=1`，
  `latencyUnknown=1`（锁住 #2）；记录已被 ring 逐出时同样计数；
  `tests/core/run-journal.test.ts`：投影后四个字段都保留，字段缺席时没有这些键，`interruptedFromJournal` 输出带 `dispatchMeta`；
  在现有 state-machine 矩阵 / property 测试里增加不变量：`consults.calls ≤ toolCounts.consult`，
  而且没有 consult 事件时 diag 里不出现 `consults` 键。

### P1b — 运行时接线（general，L2；依赖 P1a）

- `src/runtime/session-driver.ts`（`mapEvent`）：`tool_execution_end` 且 `toolName==="consult"` 时附加
  `consult: classifyConsultToolEnd(e.isError, e.result)`，其他工具保持原样。
- `src/service/request-threading.ts`：`dispatchMeta`、`schemaPreset` 加进 `NOT_THREADED`，并写一行原因。
- `src/service/runtime-adapter.ts`：
  ① 构造 `displayMeta` 时，在非只读域且 `consultExperts` 非空的情况下写
  `experts:{ refs: toExpertRecords(consultExperts), granted: grantedReserved.includes("consult") }`
  （注入在 732 行，早于 966 行，此时已经知道是否注入）；
  ② 透传 `dispatchMeta`、`schemaPreset`；
  ③ 通知 `textPreview` 改用 `renderStructuredForHost(settled.structuredResult, spec.request.schemaPreset)`，`structuredPreview` 不变。
- `src/consult/tool.ts`：`ConsultOutcome` 改为从 core 的 `CONSULT_OUTCOMES` 派生（用类型等式断言锁住两边一致）；
  `matchExpertRef` 的报错文案引用 `CONSULT_NOT_IN_WHITELIST_MARK`，渲染出来的字节不变（`freeze-surface.test.ts` 应保持绿）。
  当前 throw 文案（`tool.ts:373`，已经包含 `label (r_xxx)` 的匹配，见 `:335`）里有 MARK 子串，P1b 只需要改成引用常量。
- `src/service/spawn-service.ts` 和 `src/service/resolve-target.ts`（**按 D3 的推荐**）：resume 时
  `dispatchMeta = req.dispatchMeta ?? resume.dispatchMeta`。继承来源只取终态快照的 `diag.dispatchMeta`，tombstone 不扩展。
  `schemaPreset` 和 `experts` 都不继承，它们按次派发。
- 测试：`tests/runtime/session-driver.test.ts`（consult 的 tool_end 映射，含 throw 形状 `details:{}`）；
  `tests/service/runtime-adapter-*.test.ts`（diag 里出现 experts、granted、dispatchMeta、schemaPreset；只读域和 consult fork 不写；
  通知 preview 走 report 渲染）；
  集成测试：用 `wrapWithRunLog` 加 fake host，跑一个带 `schema` 的 run，断言 `updatedAt` 最新的那条 `subagent:run` 带有
  `outcome.structuredResult` 和 `diag.schemaPreset`；resume 继承和显式覆盖各一条，另加一条从 journal 种回的 interrupted 快照 resume 时继承 `dispatchMeta`（与 #1 联动）。

### P2 — Agent 工具面（general，L2；依赖 P1a）

- `src/tools/agent-tool.ts`：
  ① `AgentToolParams` 增加 `meta`：`Type.Optional(Type.Object({lane, packageId, feature, abArm}, {additionalProperties:false}))`，
  描述用英文，写明 "Analytics only — never shown to the subagent"；
  ② 顶层的 `schema` 字段单独复制一份，描述末尾加一句 `Or pass the preset name "verdict/v1" for verifier/reviewer verdicts.`；
  nested 继续用原来的字段对象，字节不变；
  ③ `prepareSpawn`：先 `resolveSchemaPreset`，命中就设置 `schema` 和 `schemaPreset`。nested 也会接受预设，
  这只是 `prepareSpawn` 共用带来的副作用，**不是能力承诺**：nested 的描述里不写，测试也不锁定它（以前这里会 throw）；
  `parseDispatchMeta` 严格校验，失败直接 throw，报错里列出允许的键；
  臂与专家必须一致：`abArm:"control"` 时 `experts` 非空要 throw，`abArm:"experts"` 时 `experts` 为空也要 throw；
  ④ 阻塞路径的 `resultText` 改用 `renderStructuredForHost`。
- `src/tools/result-tool.ts`：543 行和 406/468 行这几处文本 body 改用 `renderStructuredForHost(..., outcome.diag.schemaPreset)`。
- 测试：`tests/tools/agent-tool.test.ts`（meta 的校验、两条一致性规则、预设解析、meta 不进 `prompt`）；
  `tests/tools/model-facing-strings.test.ts`（更新顶层 golden；断言 Nested 的 params 和描述**逐字节不变**）；
  `tests/tools/result-tool.test.ts` 和 `result-text.test.ts`（verdict 渲染、非预设 schema 仍然是 JSON）。

### P3 — 抽签与分析脚本（general 或 glm，L1；可以最先并行开工）

- `scripts/exp/consult-ab-arm.mjs <packageId> [--salt consult-ab-v1]`：输出 `experts` 或 `control`。
  规则是 `sha256(salt + "\0" + packageId)` 首字节的最低位，1 为 experts。同一个包恒定同一臂，事后可以复算。
- `scripts/exp/consult-ab-lib.mjs`（纯函数，导出供测试用）和 `scripts/exp/consult-ab-analyze.mjs`
  （命令行：`[--dir ~/.pi/agent/sessions] [--since YYYY-MM-DD] [--until …] [--salt …] [--json]`）：
  1. 递归读取 `*.jsonl`，取 `type:"custom"`、`customType:"subagent:run"` 的条目；每个 runId 全局去重，
     有终态条目时只在终态里选，然后取 `updatedAt` 最大的那条（这样能拿到 post-policy 的 structuredResult）。
     **平局裁决复刻 seed 的语义**（`pi-run-log.ts:115` 用的是 `>=`）：文件按路径排序，文件内按行序扫描，
     `updatedAt` 相等时后扫到的条目胜出。X10 的 post-policy 条目与首条终态条目同一个 generation，写在首条之后，所以平局时它胜出。
     缺字段的旧条目可以解析，只是没有 packageId，计入 `unenrolled`。
  2. 按 `diag.dispatchMeta.packageId` 分组。出现在任何 run 的 `absorbedRunIds` 里的 run 不计成本
     （consult 和嵌套 run 本来也没有 meta）。`absorbedRunIds` 是 FIFO 有界集合（`ABSORBED_RUN_IDS_CAP=100`，
     `state-machine.ts:89`）：单个 run 吸收超过 100 个 id 时，最老的被逐出，对应 run 的成本会被重复计入。
     生产中单个 run 最多 4 次 consult（eval §2），实际风险很低。分析时不处理，只在 `absorbedRunIds.length === 100` 时给该包打
     `absorbed-cap-hit` **警告**（不排除），并在排除清单的说明里写明这个 cap。
     2a. **角色定义（硬规则）**：一个 run 的角色由 `diag.agentType` 决定。
     - work：属于 `--work-types`，默认 `general,frontend-dev`；
     - verify：`verifier`；
     - other：其余类型（reviewer / Plan / architect / Explore 等）。
       **工作 run** 的定义是：`diag.dispatchMeta.packageId` 命中该包，且角色为 work。
       协议检查只看工作 run 和 verify run：
     - experts 臂：没有任何工作 run 的 `experts.granted===true` ⇒ `no-granted-experts`；
     - control 臂：有任何工作 run 的 `experts.refs` 非空 ⇒ `control-has-experts`；
     - 两臂共用：有任何 verify run 挂了专家 ⇒ `verifier-has-experts`（P4 协议规定两臂的 verifier 都不挂专家）。
       other 角色只计成本，不参与协议检查。
       2b. **`partial-unenrolled`（硬规则，整包排除）**：resume 会沿用原会话文件（`SessionManager.open`，`session-driver.ts:769`），
       所以用 `diag.sessionFile` 作为同一工作链的连接键。只要存在一个没有 `dispatchMeta.packageId` 的 work 或 verify run，
       且它的 `sessionFile` 与包 P 内某个同角色 run 相同，P 就被整包排除，原因记为 `partial-unenrolled`，并列出这些缺 meta 的 runId。
       阈值是 1：漏掉的成本或 verdict 无法估算。
       有两类缺口无法用这条规则连接：一是不走 resume 的重派，靠 P4 协议"入组包的每次派发都带 meta"兜底；
       二是 H2 / config 失败的条目，`failedConfigOutcome`（`runtime-adapter.ts:264`）既没有 displayMeta 也没有 sessionFile，
       成本为 0，也没有 verdict，不影响指标。
       另外，脚本按主会话文件输出一个覆盖率提示：入组包时间窗内没有 meta 的 work run 数，只提示，不排除。
  3. 每个包算这些量：臂（取包内 run 的 abArm，不一致就排除，原因 `mixed-arm`）；带 `--salt` 时核对哈希（`hash-mismatch`）；
     违反协议的情况：control 臂但有 run 的 `diag.experts` 非空，或者 experts 臂但工作 run 都没有 `granted:true`；
     verdict 序列（`schemaPreset==="verdict/v1"` 且 completed 的 verifier run，按 `createdAt` 排序）；
     `firstPass`（第一个 verdict 是 pass）、`firstPassOrCond`；`reworkRounds`（第一个非 reject 之前 reject 的次数，从未通过则为 null，标为截尾）；
     `costUsd`（包内各 run 的 `usage.costUsd` 之和）；`wallMs`：包内**有** `settledAt` 的 run 中最大的 `settledAt`，减去全部 run 中最小的 `createdAt`；
     一个 `settledAt` 都没有时为 null，不计入中位数和 P90（`failedConfigOutcome` 的条目没有 `settledAt`）；
     `consult.calls/costUsd/failed` 汇总自各 run 的 `diag.consults`。
  4. 按臂输出，再按车道分层：n、首验通过率及 Wilson 95% 区间、两臂差值和双比例 z 检验的 p 值、返工轮数的均值和中位数、
     成本和墙钟的中位数及 P90、experts 臂里真正发起过 consult 的包所占比例。另外输出排除清单（原因加 runId），
     以及一行功效提示（每臂 n 小于 150 时打印"不足以检测 15pp"）。
- 测试：`tests/exp/consult-ab-analyze.test.ts`，fixture 放 `tests/fixtures/consult-ab/*.jsonl`，手工构造，覆盖：
  旧条目、两个文件里出现同一个 runId、一个 journal 条目加一个终态条目、一条 post-policy 条目、一个被吸收的 consult run、
  两臂各 3 个包、1 个 mixed-arm、每类协议违例各 1 个、1 个从未通过的包；
  1 个 `partial-unenrolled` 包：一个返工 resume 与包内 dev run 共用 `sessionFile`，但它没有 meta；
  1 个 post-policy 条目与首条终态条目 `updatedAt` 相等的平局变体，要断言选中的是带 `structuredResult` 的那条；
  1 个 experts 臂的包，其中 verifier 不挂专家，要断言它**不**被判违例；
  1 个包含没有 `settledAt` 的 config 失败条目的包，用来检查 `wallMs`。哈希规则用一个固定向量锁住。

### P4 — 流程文档（主会话直接改，L0）

- `skills/dev-flow/SKILL.md`：增加约 10 行的「consult A/B 埋点」小节。所有写包的 dev、verifier、reviewer 派发都带
  `meta:{lane, packageId, feature}`（入组包的**每一次**派发都要带，包括不走 resume 的重派）；verifier 一律用 `schema:"verdict/v1"`；
  入组的包按 `references/consult-ab.md` 执行。场景矩阵里"打回重派"那一行末尾加一句：
  「实验入组包的 control 臂例外，见 references/consult-ab.md；实验之外照本行执行」。
- 新建 `skills/dev-flow/references/consult-ab.md`，写实验协议：
  - 入组范围：场景矩阵里标"可选"的 L2 写包，外加主会话预先声明的一批 L3 包；入组要在派发第一个 dev 之前决定。
  - 抽签：运行 `consult-ab-arm.mjs`，同一个包的所有工作 run（包括返工 resume 和重派）都用同一臂。
  - control 臂**覆盖**矩阵里"打回重派必须挂"的规则，改为把打回报告原文推送给下游；两臂推送的交接内容保持一致。
  - 实验期间两臂的 verifier 都不挂专家，避免验收端的差异混进来。
  - 主指标和次要指标沿用 eval §6.3 第 3 条；salt 和起始日期写在文档里，作为预注册。
  - verdict 的中文对照：pass=通过、conditional_pass=有条件通过、reject=打回。schema 里只写英文，见 §4。
- `AGENTS.md`：在 `src/consult/` 条目末尾加一句，指向本方案和 `diag.experts/consults/dispatchMeta`。

## 6. 验收清单（verifier 用；验收模型须与开发模型不同源）

1. `npm run format:check && npm run typecheck && npm test && npm run build` 全部通过；Gate A（threading 分类）能编译过。
2. 字段缺席时零变化：不带 `meta`、`experts` 或预设的 run，diag 里不出现任何新键（快照断言）；旧 fixture 能 seed 进 store 并参与分析。
3. 子会话面不变：`NestedAgentToolParams` 的 JSON 和描述逐字节等于改动前；`buildPrompt` 和最终 prompt 里不含任何 meta 内容（测试断言）。
4. `meta` 严格校验：未知键、非法 id、abArm 缺 packageId、臂与专家不一致，这四种情况都会 throw，且报错文案可以让模型自行纠正。
5. 白名单错误、成本预检拒绝、轮次帽、超时、截断都能在 `diag.consults.byResult` 里分别计数；`costUsd` 不被重复计入 `usage`。
6. 用 `schema:"verdict/v1"` 跑完的 verifier，它最新的 `subagent:run` 条目里有 `outcome.structuredResult.verdict` 和 `diag.schemaPreset`；
   主会话看到的是报告原文加一行 verdict，而不是 JSON。
7. 在 fixture 上运行 `node scripts/exp/consult-ab-analyze.mjs --dir tests/fixtures/consult-ab --json`，输出与测试快照一致；
   排除原因逐项列出。
8. 进程崩溃后的 journal 条目、以及由它种回的 interrupted 快照都带 `dispatchMeta`，从这个快照 resume 时能继承到；
   diag 没有 `toolHistory` 时，consult 调用照样计数。
9. analyzer 在 fixture 上能区分 `partial-unenrolled`、三类协议违例和平局裁决，verifier 不挂专家不会触发违例。
10. state-machine 矩阵和 property 测试同步更新并通过；`tests/conformance` 不受影响（本方案不涉及 pi 版本面）。

## 7. 待定决策（含推荐）

- **D1 验收结论的载体**：
  - (a) 推荐：用预设 `schema:"verdict/v1"`，结构里带 `report`，host 侧渲染。数据最干净，复用了 X10 的双重校验。
    代价是 verifier 忘记提交 StructuredOutput 时，run 会是 `failed(schema)`，需要 resume 补交。试点期统计这个比例，超过 5% 再考虑 (b)。
  - (b) 不用 schema，host 侧确定性地解析 verifier 输出格式里的 `## 验收结论：X`，写进 `diag.verdict`。
    零失败风险，但格式一旦漂移就会静默丢数据，本质上还是正则。
- **D2 谁来抽签**：
  - 推荐：主会话按包运行确定性哈希脚本，在 `meta.abArm` 里声明，工具层只做一致性校验。可复算、可审计，不改变行为。
  - 不推荐：增加一个设置项自动分臂。那样要么在 admission 阶段静默删掉 `experts`（违反"不静默忽略"的先例，consult §4.2），
    要么只打标签不执行，起不到随机化的作用。
- **D3 resume 是否继承 `dispatchMeta`**：
  - 推荐：请求里没给就继承，显式给了就覆盖（与 timeoutPolicy 的 R-inherit 同一个模式）。返工 resume 天然属于同一个包，
    不继承的话主会话每次都得重填，漏填的包会被分析脚本误判为 unenrolled。

## 8. 评审处置表（glm-5.3 评审：有条件通过，无 Blocker）

| #   | 处置                 | 落点 / 说明                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 采纳                 | §1 新增持久化面一行；§3 措辞改为"终态全量 / journal 白名单"；P1a 文件清单加 `run-journal.ts`，并补单测；P1b 增加 interrupted→resume 继承用例；§6 第 8 条                                                                                                                                                                          |
| 2   | 采纳                 | P1a ② 写成实现规则（consult 折叠在 early-return 之前，所有 return 路径都合并）；`presentation-diag.test.ts` 两个用例。核实位置是 `state-machine.ts:173-175`                                                                                                                                                                       |
| 3   | 采纳                 | P3 2a 写死角色和工作 run 的定义，以及三类违例（verifier 单列，不进工作 run）；2b 新增 `partial-unenrolled`，连接键是 `sessionFile`，阈值 1；fixture 补两条。"超阈值"取 1，理由是漏计量无法估算。H2/config 失败的条目经核实成本为 0、没有 verdict，记为已知不可连接，没有扩大 P1b 去给 `failedConfigOutcome` 补 meta（不扩 scope） |
| 4   | 采纳                 | schema 的 description 只留英文；中文对照移到 `references/consult-ab.md`                                                                                                                                                                                                                                                           |
| 5   | 采纳                 | analyzer 复刻 seed 的 `>=`（文件靠后者胜）；平局 fixture。行号更正：seed 比较在 `pi-run-log.ts:115`，不是 :124                                                                                                                                                                                                                    |
| 6   | 采纳（警告，不排除） | P3 第 2 步注明 cap 是 100 及其边界；`absorbed-cap-hit` 只打警告                                                                                                                                                                                                                                                                   |
| 7   | 采纳                 | 删除过期的注记；核实 `PAREN_SUFFIX_RE` 在 `tool.ts:335`、throw 在 `:373`，文案包含 MARK                                                                                                                                                                                                                                           |
| 8   | 采纳                 | P2 ③ 注明 nested 接受预设是副作用、不是能力承诺；`wallMs` 只取有 `settledAt` 的 run，全部缺席时为 null（核实 `failedConfigOutcome` 在 `runtime-adapter.ts:264`）                                                                                                                                                                  |
| 9   | 采纳                 | P4 在 SKILL.md "打回重派"那一行加交叉引用                                                                                                                                                                                                                                                                                         |
