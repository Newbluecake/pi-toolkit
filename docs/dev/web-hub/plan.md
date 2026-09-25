# web-hub 实施方案（plan v1 · 本期 = P1 MVP 只读）

> 输入：`web-hub-requirements.md`（D1/D2/D3）、`explore.md`、`arch.md`（v1）、`AGENTS.md`。本文只定**怎么做**；架构理由见 arch，不重复。
> pi 源码坐标相对 `~/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/`（0.87.1）。
> 注意：运行时实际执行的是 `bundle/chunks/*.js`，arch/本文引用的 `core/*.js` 行号来自同包的非打包副本，语义一致。

## 0. 总览

| 波次 | 内容                                                                                                  | 并行度     | 闸门                                          |
| ---- | ----------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------- |
| W0   | spike：K1-git / K4 / K7 / K8 真机核实（§1）——**已完成**，结果见 `spike-results.md`，吸收见 §1.1 / §10 | 4 项可并行 | K7 结论已落 A 的 `messageKey`/对账规则        |
| W1   | 包 A protocol + hub ports（先行定稿，冻结）                                                           | 单包       | A 的测试绿 + 接口评审通过后冻结               |
| W2   | 包 B hub 核心 ∥ C hub HTTP ∥ D agent-client ∥ E 前端                                                  | 4 包并行   | 每包自带单测绿；`conflict-check` 无交集（§3） |
| W3   | 包 I 装配（settings / index.ts / /webhub / hub main.ts / e2e）                                        | 单包串行   | 全量四件套绿                                  |
| W4   | verifier 按 §5 验收                                                                                   | —          | §5 全部勾选                                   |

P1 功能范围 = arch §13.1 P1 行：protocol、hub 单例/空闲退出/auth/SSE/静态、agent-client（连接/握手/心跳/事件 tap/快照/fleet）、历史回放、网页只读渲染（对话、工具、subagent 树、成本、`blocked on dialog` 横幅）、`/webhub status|open`。
**P1 不做**：任何命令（prompt/abort/steer）、ask_user 双通道、headless、版本替换、token rotate。

---

## 1. W0 spike（进入 P1 前必须真机核实）

公共探针扩展 `/tmp/webhub-probe/probe.ts`（`pi -e` 加载，只写 `/tmp` 日志，不进仓库）：

```ts
import { appendFileSync } from "node:fs";
const LOG = process.env.PROBE_LOG ?? "/tmp/webhub-probe.log";
const inst = Math.random().toString(36).slice(2, 8); // 模块实例 id：变了 = 模块被重新求值
const g = globalThis as Record<string, any>;
const log = (o: object) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, inst, ...o }) + "\n");
export default function (pi: any) {
  g.__probeAct = (g.__probeAct ?? 0) + 1;
  log({ ev: "activate", act: g.__probeAct, argv1: process.argv[1], execPath: process.execPath });
  pi.on("session_start", (e: any, ctx: any) =>
    log({ ev: "session_start", reason: e.reason, mode: ctx.mode, file: ctx.sessionManager.getSessionFile() }),
  );
  pi.on("session_shutdown", (e: any) => log({ ev: "session_shutdown", reason: e.reason }));
  pi.on("message_end", (e: any, ctx: any) => {
    const leaf = ctx.sessionManager.getLeafEntry();
    log({
      ev: "message_end",
      role: e.message.role,
      ts: e.message.timestamp,
      customType: e.message.customType,
      leafIsThis: leaf?.message === e.message,
      leafId: leaf?.id,
      leafType: leaf?.type,
    });
  });
  pi.on("turn_end", (e: any, ctx: any) =>
    log({ ev: "turn_end", entryId: e.messageEntryId, leaf: ctx.sessionManager.getLeafId() }),
  );
  pi.on("session_compact", (e: any, ctx: any) =>
    log({ ev: "session_compact", id: e.compactionEntry?.id, leaf: ctx.sessionManager.getLeafId() }),
  );
  pi.on("ui_prompt_start", (e: any) => log({ ev: "ui_prompt_start", kind: e.kind, title: e.title }));
  pi.on("ui_prompt_end", (e: any) => log({ ev: "ui_prompt_end", kind: e.kind }));
  pi.registerCommand("probe-custom", {
    description: "K7",
    handler: async () =>
      pi.sendMessage({ customType: "probe:custom", content: "hello", display: true }, { triggerTurn: false }),
  });
  pi.registerCommand("probe-ui", {
    description: "K8",
    handler: async (_a: string, ctx: any) => {
      await ctx.ui.select("probe select", ["a", "b"]);
      await ctx.ui.custom((_t: any, _th: any, _kb: any, done: (v: null) => void) => {
        setTimeout(() => done(null), 1500);
        return { render: () => ["probe custom"], invalidate() {} };
      });
    },
  });
}
```

| K          | 事项                                                                                                                                          | 探针 / 命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 通过判据                                                                                                                                                                                                                                                           | 阻塞                                                                              | 读码预判（未真机）                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K1-git** | `pi install git:` 形态下 hub 能被 pi 自带 jiti 运行，且能解析本包 `node_modules/@sinclair/typebox`                                            | `SB=$(mktemp -d); HOME=$SB PI_CODING_AGENT_DIR=$SB/.pi/agent pi install git:github.com/Newbluecake/pi-toolkit`；`CL=$(dirname $(find $SB -path '*pi-toolkit/package.json' -not -path '*/node_modules/*' \| head -1))`；`ls $CL/node_modules/@sinclair/typebox`；把 `probe-hub.ts`（`import {Type} from "@sinclair/typebox"; import "./dep.js"; import net from "node:net"; console.log("ok", typeof Type.Object, typeof net.createServer)`）与 `dep.ts` 拷入 `$CL/src/__probe/`，执行 `node <pi全局>/node_modules/jiti/lib/jiti-cli.mjs $CL/src/__probe/probe-hub.ts`；再 `HOME=$SB pi -e /tmp/webhub-probe/probe.ts -p hi` 取日志里 `argv1` 并按 D 包 `resolveJitiCli` 算法（realpath → 向上找 `@earendil-works/pi-coding-agent/package.json` → `createRequire(...).resolve("jiti/package.json")`）手算 | ① typebox 目录存在（pi 按 packages.md「installs package dependencies」装了 deps）② 输出 `ok function function`、exit 0、< 3s ③ `argv1` realpath 后能定位到 pi 包并解析出 `jiti-cli.mjs`                                                                            | D `launcher.ts` 的自动拉起路径、I e2e。**不阻塞** A/B/C/E（它们只在 vitest 内跑） | npm 全局已通过（K1/K2）。失败时回落：`webHub.nodeLoader` 逃生口 + 状态 `web✗loader`；`dist/bun` 表明存在 bun 单文件分发形态，该形态下必然找不到 jiti → 同样走逃生口                                                                                                                                                                                                                                                                                                                     |
| **K4**     | 会话替换时序：`/new` `/resume` `/fork` `/reload` 时 `session_shutdown → activate → session_start` 的顺序，模块是否重求值，globalThis 是否存活 | tmux 起 `pi -e /tmp/webhub-probe/probe.ts`，依次 `/new`、`/resume`、`/fork`、`/agent reload now`（本机 `reload.defer` 会把裸 `/reload` parked）；`jq -c . /tmp/webhub-probe.log`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 每次替换序列与 `inst`/`act` 写实                                                                                                                                                                                                                                   | D 测试矩阵、I e2e 时序；**不阻塞设计**                                            | **已实测（推翻上一版读码预判）**：`/new` `/resume` `/fork` 的 `inst` 不变（仅 activate 重跑），只有 `/reload` 重求值；globalThis 全程存活（act 单调）。读码解释：pi 进程级 `extensionCache`（`core/extensions/loader.js:85-100`）按路径缓存模块，会话替换新建的 ResourceLoader `loaded=false` 不清；`reload()` 在 `loaded=true` 时 `clearExtensionCache()`（`resource-loader.js:263-267`）；`useExtensionCacheCwd` 在 cwd 变化时也清 ⇒ **跨 cwd 的 /resume /fork 也会重求值**（未实测） |
| **K7**     | 扩展 `message_end` 早于持久化；`messageKey` 能否在「事件消息」与「jsonl 条目」两侧一致                                                        | `pi -e probe.ts -p "read package.json and summarize in 1 line"`（产生 user/assistant/toolResult）；TUI 内 `/probe-custom`；小会话读大文件后 `/compact`；然后 node 脚本逐条比对：日志中 `message_end{role,ts}` 与 session jsonl（`getSessionFile()`）里对应条目的 `message.timestamp`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ① 所有 `message_end` 均 `leafIsThis=false`（确认先事件后落盘）② `turn_end.entryId == leaf`（`messageEntryId` 可作"已落盘栅栏"）③ user/assistant/toolResult：`role:timestamp(+toolCallId)` 两侧相等 ④ custom 消息：记录 jsonl `custom_message` 是否带可对齐的时间戳 | A `keys.ts` 规则、B `mergeSnapshot`                                               | 已读码确认 ①（`core/agent-session.js:579-595`）；compaction 先 `appendCompaction` 后发 `session_compact`（一致）；**新发现**：jsonl 的 `custom_message` 条目**没有** `message.timestamp`，只有落盘时刻的条目 ISO `timestamp` ⇒ `role:timestamp` 对 custom 必然失配。A 预置备选规则：custom = `custom:<customType>:<fnv1a(canonical content)>`                                                                                                                                           |
| **K8**     | TUI 下 ask_user 的 `custom()` 是否也触发 `ui_prompt_start/end`                                                                                | TUI 内 `/probe-ui`；再让模型调用一次 `ask_user`（单题）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 日志出现 `ui_prompt_start{kind:"select",title}` / `{kind:"custom"}`（无 title）及配对 end；记录与 tool_execution_start 的相对顺序                                                                                                                                  | P1 仅影响 E 横幅文案（非阻塞）；**阻塞 P2 包 G**（dialog_open 与横幅去重）        | `core/extensions/runner.js:318-326` `wrapUIPromptContext` 包了 `custom()` ⇒ 会触发 `kind:"custom"`，且经 `queueMicrotask` 异步发出（可能晚于同 tick 的其他事件）。P1 网页对 ask_user 显示 `blocked on dialog (custom)`，可接受                                                                                                                                                                                                                                                          |

spike 产出：已由另一 agent 真机执行，原始结果见 `docs/dev/web-hub/spike-results.md`（本文不复制日志）。

### 1.1 实测结论（吸收自 spike-results.md）

| K                | 结论                                                                                                                                                                                                                                                                                                                                                                                                              | 对 plan 的影响                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1-git           | ✅ 全通过：`pi install git:` 装了 deps（typebox 在位）；pi 自带 jiti-cli 跑 TS + 相对 `.js` + `node:*` 0.27s；`realpath(argv1)=…/dist/bundle/cli.js` 可定位 pi 包并解析 jiti-cli                                                                                                                                                                                                                                  | D `resolveJitiCli` 按原算法实现；`nodeLoader` 仍保留作 bun 单文件形态的逃生口                                                                                 |
| K4               | `/new` `/resume` `/fork`：同模块实例、activate 重跑；`/reload`：模块重求值；globalThis 存活；pid 不变；activate 次数可多于 session_start（`/resume` 时 act 2→4）；`/resume` 续写原文件，`/fork` 新文件且 entry id 原样复制                                                                                                                                                                                        | D 连接两条路径都要覆盖（见包 D「K4 两路径」）；连接只在 `session_start` 取得                                                                                  |
| K7               | ① message_end 恒早于落盘；② `turn_end.messageEntryId` **工具轮 ≠ leaf**（指向 assistant(toolCall)，leaf 已是 toolResult），只证明该条目已落盘；③ user/assistant/toolResult/system 的 `role:timestamp` 两侧对齐；④ `custom_message` 与 `custom`(data) 均无 `message.timestamp`，且 **idle `sendMessage(triggerTurn:false)` 先落盘、只发应用总线事件，扩展收不到 message_end**；compaction 先落盘后事件，`id==leaf` | A：custom 内容键转正且覆盖两型；B：对齐点=快照同 tick leafId，不用 turn_end 判追平；A/B/D：新增「leaf 变化 → 读文件尾部补齐」路径（事件流对 custom 可能缺席） |
| K8               | ask_user 在 TUI 触发 `ui_prompt_start{kind:"custom"}`（无 title），`tool_execution_start{ask_user}` 先于它；但 `/resume` 选择器等内置 UI 同样是 `kind:"custom"`                                                                                                                                                                                                                                                   | P1 横幅 `blocked on dialog (custom)` 不变；P2 包 G 归因须叠加 `tool_execution_start{ask_user}`（§4）                                                          |
| `-e` vs 已安装包 | 两者都经 `loadExtensionsCached(extensionPaths,…)`（`resource-loader.js:404-412`）同一缓存，读码判断行为一致；但只实测了 `-e`                                                                                                                                                                                                                                                                                      | 设计保持「同实例复用 / 重求值 handover」两条路径都成立，不依赖任一结论                                                                                        | K3/K5/K6/K9 属 P2/P3，不在本期。 |

---

## 2. 包拆分（P1）

依赖：`A → {B, C, D, E} → I`。`src/web-hub/protocol/**` 与 `src/web-hub/hub/ports.ts` 在 W2 期间**冻结**（需改 → 退回 orchestrator 统一改，其余包 rebase）。
**全局冻结面（spike 吸收 #6）**：工作树存在与 web-hub 无关的他人未提交改动，**所有包（含 I）一律只读、不得格式化/暂存/提交**：`src/stack.ts`、`src/runtime/runner.ts`、`src/runtime/session-driver.ts`、`src/service/spawn-service.ts`、`src/config/available-models.ts`、`src/config/model-hint.ts`、`src/core/state-machine.ts`、`src/quota/render.ts`、`tests/quota/render.test.ts`、`tests/runtime/runner-start-errors.test.ts`、`scripts/exp/**`、`docs/dev/consult/exp-trim/**`（开工前以 `git status --short` 重新核对，名单以实际为准）。各包提交只 `git add` 自己文件域内的路径，禁止 `git add -A`/`npm run format`（改用 `npx prettier --write <自己的文件>`）。**P1 不需要改 `src/stack.ts`**：fleet 数据经 `src/index.ts` 里已有的 `holder.current?.query.list()` 读取，连接不进 stack（K-2），I 只改 `index.ts`。
全局约束（每包都适用）：TS strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`；相对 import 带 `.js`；**hub/protocol 只允许 import `node:*`、`@sinclair/typebox(/value)` 与同层/protocol 相对路径**（由 A 的 boundary 测试强制）；不新增 npm 依赖；无模块级可变状态（常量除外）。

### 包 A — protocol（W1，先行）

| 项       | 内容                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件域   | `src/web-hub/protocol/{version,ndjson,paths,messages,keys,http-contract}.ts`、`src/web-hub/hub/ports.ts`、`tests/web-hub/protocol/**`、`tests/web-hub/boundary.test.ts` |
| 允许新建 | 仅上述；`src/web-hub/protocol/` 下可再加私有 helper                                                                                                                     |
| 冻结面   | 全仓库其他文件只读                                                                                                                                                      |

```ts
// version.ts
export const PROTO = { major: 1, minor: 0 } as const;
export const P1_CAPS = ["ev.v1", "fleet.v1", "snapshot.v1", "branch.v1"] as const;
export const RESERVED_FRAME_TYPES = [
  "cmd",
  "cmd_result",
  "dialog_open",
  "dialog_closed",
  "dialog_answer",
  "superseded",
] as const; // P2/P3，P1 解码时忽略
export function compareVersions(a: string, b: string): -1 | 0 | 1; // semver 核心三段，非法串按 0.0.0
export function protoCompatible(remote: { major: number }): boolean;

// ndjson.ts —— 按字节 0x0A 切帧（去尾 \r），跨 chunk 拼接，不用 readline
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export type NdjsonError = { code: "E_FRAME_TOO_LARGE"; bytes: number } | { code: "E_BAD_JSON"; sample: string };
export class NdjsonDecoder {
  constructor(opts: { maxFrameBytes?: number; onFrame: (value: unknown) => void; onError: (err: NdjsonError) => void });
  push(chunk: Buffer | string): void; // E_FRAME_TOO_LARGE 后进入 poisoned 态，调用方应断开
  readonly bufferedBytes: number;
}
export function encodeFrame(frame: object): string; // JSON.stringify + "\n"

// paths.ts
export const SOCKET_PATH_MAX_BYTES = 100;
export interface HubPaths {
  stateDir: string;
  socketPath: string;
  hubJson: string;
  tokenFile: string;
  logFile: string;
  startLock: string;
}
export function resolveHubPaths(env: { home: string; uid: number; xdgRuntimeDir?: string | undefined }): HubPaths; // 纯函数，含 >100B 回落链
export function ensurePrivateDir(dir: string): void; // mkdir -p 0700；已存在则 chmod 0700 并校验 owner==uid，否则 throw
export function webHubStateDir(home: string): string; // <home>/.pi/agent/web-hub

// messages.ts —— typebox schema + Static 类型；两端 Value.Check；未知 t 返回 undefined（忽略）
export type AgentId = { pid: number; nonce: string };
export type AgentKind = "tui" | "rpc";
export interface WireMessage {
  role: string;
  timestamp?: number;
  toolCallId?: string;
  customType?: string;
  [k: string]: unknown;
}
export interface WireEntry {
  id: string;
  parentId: string | null;
  type:
    | "message"
    | "custom_message"
    | "custom"
    | "compaction"
    | "branch_summary"
    | "model_change"
    | "thinking_level_change"; // custom(data) 投影为不渲染条目（无 data，仅 customType + dataKey），参与对账不参与显示
  timestamp: string;
  message?: WireMessage;
  summary?: string;
  firstKeptEntryId?: string;
  customType?: string;
  content?: unknown; // custom_message 的载荷（渲染用）
  dataKey?: string; // custom(data)：customKey(customType, data) 预算值，data 本体不下发
  display?: boolean;
  truncated?: boolean;
}
export interface SessionInfo {
  sessionId: string;
  sessionFile?: string;
  name?: string;
  cwd: string;
  reason: string;
  leafId: string | null;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  mode: "tui" | "rpc";
}
export interface StatusInfo {
  leafId: string | null; // spike K7④：leaf 变化是 idle custom_message 的唯一信号（不经扩展事件）
  busy: boolean;
  pending: boolean;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  costUsd?: number;
  subagentCostUsd?: number;
}
export interface FleetRowWire {
  runId: string;
  label?: string;
  type?: string;
  model?: string;
  status: string;
  phaseLabel: string;
  parentRunId?: string;
  elapsedMs: number;
  phaseMs: number;
  costUsd?: number;
  toolTrail?: string;
  streamLine?: string;
  highlight: "none" | "warn" | "crit";
  terminal: boolean;
}
export interface WireEvent {
  type: (typeof FORWARDED_EVENTS)[number];
  [k: string]: unknown;
} // payload 只校验 type + 大小
export const FORWARDED_EVENTS: readonly [
  /* arch §4.1.1 白名单 */ "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "session_compact",
  "session_compact_failed",
  "model_select",
  "thinking_level_select",
  "session_info_changed",
  "input",
  "ui_prompt_start",
  "ui_prompt_end",
];
export interface InflightState {
  message?: WireMessage;
  tools: Array<{ toolCallId: string; toolName: string; args: unknown; partial?: string }>;
}
export interface SnapshotReplyBody {
  seq: number;
  leafId: string | null;
  sessionFile?: string;
  recent: Array<{ seq: number; message: WireMessage }>;
  inflight?: InflightState;
  prompts: Array<{ kind: string; title?: string; since: number }>;
  status: StatusInfo;
  fleet: FleetRowWire[];
}
// agent→hub
export type AgentFrame =
  | {
      t: "hello";
      proto: { major: number; minor: number };
      pluginVersion: string;
      buildId: string;
      agentId: AgentId; // 进程级纯数据，跨重激活不变
      epoch: string; // = 模块实例 nonce；hub 见 epoch 变化 ⇒ 向订阅者推 gap 触发重新快照
      kind: AgentKind;
      ticket?: string;
      launcher: [string, string];
      cwd: string;
      caps: string[];
    }
  | { t: "bye"; reason: "quit" | "handover" | "detach-timeout" | string } // handover = 同进程新模块实例接手，hub 进入 10s 静默认领窗口
  | ({ t: "session" } & SessionInfo)
  | { t: "session_detached"; reason: string }
  | { t: "ev"; seq: number; e: WireEvent }
  | ({ t: "status" } & StatusInfo)
  | { t: "fleet"; runs: FleetRowWire[] }
  | ({ t: "snapshot_reply"; rid: string } & SnapshotReplyBody)
  | { t: "branch_reply"; rid: string; entries: WireEntry[]; truncated: boolean }
  | { t: "gap"; fromSeq: number }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number };
// hub→agent
export type HubFrame =
  | {
      t: "hello_ack";
      hubVersion: string;
      buildId: string;
      proto: { major: number; minor: number };
      agentKey: string;
      pingMs: number;
      leaseMs: number;
      http: { port: number };
    }
  | { t: "hello_reject"; code: "E_PROTO" | "E_BAD_HELLO" | "E_TICKET"; message: string; retryAfterMs: number }
  | { t: "snapshot_req"; rid: string }
  | { t: "branch_req"; rid: string; maxBytes: number }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number };
export function decodeAgentFrame(raw: unknown): AgentFrame | undefined;
export function decodeHubFrame(raw: unknown): HubFrame | undefined;
export const TIMING = {
  connectMs: 1_000,
  helloAckMs: 2_000,
  pingMs: 10_000,
  silenceMs: 30_000,
  staleMs: 30_000,
  reapMs: 60_000,
  detachGraceMs: 10_000,
  snapshotMs: 5_000,
  backoffMinMs: 500,
  backoffMaxMs: 30_000,
  spawnThrottleMs: 30_000,
  spawnWindowMs: 8_000,
} as const;
export const LIMITS = {
  writeQueueBytes: 1 << 20,
  textTruncateBytes: 64 << 10,
  recentMessages: 64,
  branchReplyBytes: 2 << 20,
  hardQueueBytes: 4 << 20,
  deltaCoalesceMs: 50,
  toolUpdateMs: 250,
  fleetMs: 1_000,
} as const;

// keys.ts —— agent 与 hub 共用，保证两侧同键
export function messageKey(m: WireMessage): string; // user/assistant/system: `${role}:${timestamp}`；toolResult 追加 `:${toolCallId}`；role==="custom": customKey(customType, content)
export function customKey(customType: string, payload: unknown): string; // `custom:<customType>:<fnv1a32(canonicalJson(payload))>`；spike K7④ 转正：唯一可行规则，内容键可重复
export function entryKey(e: WireEntry): string | undefined; // message → messageKey(e.message)；custom_message → customKey(type, content)；custom → e.dataKey 已预算的 customKey(type, data)；其他类型 undefined
// 评审修订：去重不能用集合（同 type 同内容的连续 custom 会被吞），改为多重集 + 出现序对账
export function reconcileRecent(
  branchTail: readonly WireEntry[], // 分支尾部最后 |recent| 条消息类条目（按序）
  recent: ReadonlyArray<{ seq: number; message: WireMessage }>, // 按 seq 升序
): Array<{ seq: number; message: WireMessage }>; // 返回「尚未落盘」需补尾的项：对 branchTail 建 key→计数，逐条 recent 命中则计数-1，未命中才补尾
export function projectSessionEntry(raw: unknown): WireEntry | undefined; // jsonl 行 / getBranch() 条目 → WireEntry；custom(data) 投影为 {type:"custom", customType, dataKey, display:false}（丢 data 本体）；丢弃 label/session 头等；超大文本截断标 truncated
export function diffAppended(delivered: readonly string[], tail: readonly WireEntry[]): WireEntry[]; // 多重集：tail 中 entryKey 计数超出 delivered 计数的条目（按序）⇒ 需 append 推送（用于 idle custom 等事件盲区）
export function truncateText(s: string, maxBytes: number): { text: string; truncated: boolean };

// http-contract.ts —— hub↔浏览器契约（E 以 web/contract.js 手工镜像，E 的测试比对）
export const SSE_EVENTS = [
  "hello",
  "hub",
  "agents",
  "agent_up",
  "agent_down",
  "agent_stale",
  "session",
  "history",
  "ev",
  "status",
  "fleet",
  "prompt",
  "gap",
  "resync",
  "append", // spike K7④：hub 从会话文件尾部补出的、事件流未覆盖的条目 {agentKey, entries: WireEntry[]}
  "ping",
] as const;
export const API_ERRORS = [
  "E_AUTH",
  "E_CSRF",
  "E_HOST",
  "E_RATE",
  "E_NOT_FOUND",
  "E_BAD_REQUEST",
  "E_DEADLINE",
  "E_AGENT_GONE",
  "E_NOT_IMPLEMENTED",
] as const;
export interface AgentCard {
  agentKey: string;
  kind: AgentKind;
  pid: number;
  cwd: string;
  state: "live" | "stale";
  pluginVersion: string;
  outdated: boolean;
  session?: SessionInfo;
  status?: StatusInfo;
  prompts: SnapshotReplyBody["prompts"];
}
export interface HistoryPayload {
  agentKey: string;
  entries: WireEntry[];
  tailMessages: WireMessage[];
  inflight?: InflightState;
  fromSeq: number;
  hasMore: boolean;
  oldestEntryId?: string;
  source: "file" | "agent";
}
```

```ts
// src/web-hub/hub/ports.ts —— hub 内部端口（B 实现、C 消费），只含类型
export interface HubConfig {
  v: 1;
  home: string;
  port: number;
  idleExitMinutes: number;
  pluginVersion: string;
  buildId: string;
  launcher?: [string, string];
}
export interface HubLog {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}
export interface AgentView extends AgentCard {
  agentId: AgentId;
  connectedAt: number;
  lastFrameAt: number;
  seq: number;
}
export interface RegistryView {
  list(): readonly AgentView[];
  get(agentKey: string): AgentView | undefined;
}
export type HubEvent =
  | { type: "agent_up"; agent: AgentCard }
  | { type: "agent_down"; agentKey: string; reason: string }
  | { type: "agent_stale"; agentKey: string }
  | { type: "session"; agentKey: string; session: SessionInfo }
  | { type: "ev"; agentKey: string; seq: number; e: WireEvent }
  | { type: "status"; agentKey: string; status: StatusInfo }
  | { type: "fleet"; agentKey: string; runs: FleetRowWire[] }
  | { type: "prompt"; agentKey: string; prompts: AgentCard["prompts"] }
  | { type: "gap"; agentKey: string; fromSeq: number }
  | { type: "append"; agentKey: string; entries: WireEntry[] };
export interface HubBus {
  subscribe(fn: (e: HubEvent) => void): () => void;
}
export interface HistoryService {
  snapshot(agentKey: string): Promise<HistoryPayload>; // §7 步骤 1-4；deadline TIMING.snapshotMs → reject E_DEADLINE
  page(agentKey: string, beforeEntryId: string, limit: number): Promise<HistoryPayload>;
  onLeafChanged(agentKey: string, leafId: string | null): void; // status.leafId 变化时调用；有订阅者才工作，500ms 去抖；结果经 bus `append` 事件发出
}
export interface HubInfo {
  version: string;
  buildId: string;
  pid: number;
  startedAt: number;
  proto: typeof PROTO;
}
export interface FrontendDeps {
  config: HubConfig;
  paths: HubPaths;
  registry: RegistryView;
  bus: HubBus;
  history: HistoryService;
  log: HubLog;
  info: () => HubInfo;
  now: () => number;
}
export interface HttpFrontend {
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
  clientCount(): number;
}
export type FrontendFactory = (deps: FrontendDeps) => HttpFrontend;
```

实现要点：

- schema 对 `ev.e`、`WireMessage` 只校 `type/role` 字面量与总长度（same-user 可信，重校验成本大）；`hello` 全字段严格校验（`nonce` 16–64 字符 base64url）。
- `projectSessionEntry` 同时服务 hub（读 jsonl）与 agent（`getBranch()` 回落），两侧产出必须逐字节一致。
- spike K7④ 已定稿：custom 规则 `custom:<customType>:<fnv1a32(JSON 规范化 content)>`（实测若 jsonl 有可对齐时间戳再改）。该键**不唯一**，只能配合 `reconcileRecent` 的多重集对账使用（持久化严格按事件顺序，故尾部计数对账正确）；浏览器端「同键去重兜底」只对非 custom 生效，custom 以 seq 去重。

测试（`tests/web-hub/protocol/`）：

| 文件                  | 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ndjson.test.ts`      | 半包/多帧一包/逐字节喂入；U+2028/2029 不切帧；`\r\n`；多字节 UTF-8 跨 chunk；恰好 4 MiB 通过、+1 字节 `E_FRAME_TOO_LARGE` 且 poisoned；坏 JSON 继续后续帧                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `messages.test.ts`    | 每种帧正反例；未知 `t` → undefined；RESERVED 类型 → undefined；`exactOptionalPropertyTypes` 下可选字段缺省可过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `paths.test.ts`       | 短 HOME 用 stateDir；>100B 回落 XDG；XDG 缺省回落 `/tmp/pi-webhub-<uid>`；`ensurePrivateDir` 修正 0755→0700、owner 不符 throw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `keys.test.ts`        | 四种 role 的 key；`projectSessionEntry` 对真实格式 fixture（`tests/fixtures/web-hub/session-sample.jsonl`，手工脱敏构造，含 session 头/model_change/custom/custom_message/message×3/compaction）；**连续两条同 type 同内容 custom 不丢**：分别在 0/1/2 条已落盘时 `reconcileRecent` 补尾 2/1/0 条；**两型 custom**：`custom_message`（content）与 `custom`（data）对同载荷得同 `customKey`、不同 type 不同键；fixture 取 spike 实测形态（顶层 ISO timestamp、无 message.timestamp）；**事件盲区**：idle custom_message 只出现在 tail、从未经 recent ⇒ `reconcileRecent` 不补、`diffAppended` 恰好返回它一条；连续两条同内容 idle custom ⇒ `diffAppended` 返回两条；system 角色键 |
| `version.test.ts`     | compareVersions 表驱动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `../boundary.test.ts` | `fs.globSync("src/web-hub/{protocol,hub}/**/*.ts")` 逐文件扫 import：只允许 `node:`、`@sinclair/typebox`、相对路径且不出 `src/web-hub/{protocol,hub}`；`src/web-hub/agent/**` 不得 import `../hub/**`（`ports.ts` 类型除外，用 `import type`）                                                                                                                                                                                                                                                                                                                                                                                                                                   |

验收：`npx vitest run tests/web-hub/protocol tests/web-hub/boundary.test.ts && npm run typecheck`。规模 ~550 LOC src + ~450 test；thinking **high**。

### 包 B — hub 核心（W2）

| 项     | 内容                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------- |
| 文件域 | `src/web-hub/hub/{hub,singleton,agent-server,registry,history,idle,log}.ts`、`tests/web-hub/hub/**` |
| 冻结面 | protocol/**、ports.ts 只读；不得碰 `http/sse/auth/static/main.ts`                                   |

```ts
// singleton.ts
export type SingletonResult =
  | { kind: "owner"; server: import("node:net").Server; inode: number; release(): Promise<void> } // release: close + unlink sock（inode 仍是自己时）
  | { kind: "exists"; hubPid?: number }
  | { kind: "failed"; error: string };
export function acquireSingleton(
  paths: HubPaths,
  deps?: { probeMs?: number; lockStaleMs?: number; now?: () => number },
): Promise<SingletonResult>;
export function startFence(socketPath: string, inode: number, onLost: () => void, intervalMs?: number): () => void; // 30s stat 比对

// registry.ts
export interface Registry extends RegistryView {
  register(hello: Extract<AgentFrame, { t: "hello" }>, conn: AgentConn): { agentKey: string; reclaimed: boolean };
  onFrame(agentKey: string, frame: AgentFrame): void; // session/status/fleet/ev/gap/session_detached → 更新记录 + bus 广播；ev 维护 prompts（ui_prompt_*）
  onClose(agentKey: string, hadBye: boolean): void;
  tick(now: number): void; // stale/reap + pid 存活探测
  readonly bus: HubBus;
  request<R extends AgentFrame>(agentKey: string, frame: HubFrame & { rid: string }, deadlineMs: number): Promise<R>; // P2 cmd 复用
}
export interface AgentConn {
  send(frame: HubFrame): void;
  close(reason: string): void;
}
export function createRegistry(deps: { now: () => number; log: HubLog; pidAlive?: (pid: number) => boolean }): Registry;

// agent-server.ts —— 每连接：NdjsonDecoder → 2s 内须 hello → 校验 → hello_ack；10s ping；30s 静默断开
export interface AgentServer {
  connectionCount(): number;
  close(): Promise<void>;
}
export function createAgentServer(
  server: import("node:net").Server,
  deps: { registry: Registry; config: HubConfig; log: HubLog; now: () => number; httpPort: () => number },
): AgentServer;

// history.ts
export function readBranchFromFile(
  file: string,
  leafId: string,
  opts?: { maxFileBytes?: number },
): Promise<
  { ok: true; entries: WireEntry[] } | { ok: false; reason: "ENOENT" | "LEAF_NOT_FOUND" | "TOO_LARGE" | "PARSE" }
>;
export function mergeSnapshot(
  branch: readonly WireEntry[],
  reply: SnapshotReplyBody,
  buffered: ReadonlyArray<{ seq: number; e: WireEvent }>,
): { entries: WireEntry[]; tailMessages: WireMessage[]; inflight?: InflightState; fromSeq: number }; // 纯函数，§7 步骤 4
export function createHistoryService(deps: {
  registry: Registry;
  log: HubLog;
  tailEntries?: number; /* 400 */
}): HistoryService;

// idle.ts
export function createIdleMonitor(opts: {
  counts: () => { agents: number; sse: number; headless: number };
  idleMs: number;
  checkMs?: number;
  now: () => number;
  onIdle: () => void;
}): { stop(): void };
// log.ts
export function createHubLog(
  file: string,
  opts?: { maxBytes?: number /* 1 MiB, 轮转 .1 */ },
): HubLog & { close(): void };

// hub.ts —— 组合根（不 import http.ts；前端经工厂注入）
export interface RunningHub {
  paths: HubPaths;
  httpPort: number;
  info: HubInfo;
  close(reason: string): Promise<void>;
  readonly closed: Promise<string>;
}
export function startHub(
  config: HubConfig,
  frontend: FrontendFactory,
  deps?: { now?: () => number; uid?: number; xdgRuntimeDir?: string },
): Promise<RunningHub | { exists: true }>;
```

实现要点：

- 单例 arch §3.3 三步；`start.lock` 用 `open(...,"wx")`，陈旧判据 = 内容 pid 不存活 或 mtime >10s；`EADDRINUSE` 探测用 `net.connect` + 发 `hello`? **不**——探测只需 connect 成功即视为活（500ms deadline），避免给对方注册脏记录。
- `hub.json` 在 socket 与 HTTP 都 listen 后原子写（`writeFile tmp` + `rename`，0600），`close()` 时仅当内容 pid==self 才删除。
- registry：`agentKey = "a" + pid + "-" + nonce.slice(0,6)`；同 `agentId` 重连 = 认领（关旧 conn）。**认领窗口（评审修订）**：`bye{handover}` 或无 bye 断开 ⇒ 记录进入 `claiming` 态 `TIMING.detachGraceMs`(10s)，期间**不推** `agent_stale/agent_down/agent_up`；窗口内同 agentId 重连 ⇒ 静默改绑（agentKey 不变），若 `epoch` 变化则向该 agent 订阅者推 `gap` 触发重新快照；窗口超时 ⇒ `stale` + 广播，`reapMs` 后 reap；任何时刻 `pidAlive(pid)=false`（`process.kill(pid,0)` ESRCH，每 tick 5s）立即 reap。`bye{quit|detach-timeout}` → 立即 down。`session_detached` → 保持 live 标记 detached（agent 侧 10s 宽限后自己 bye）。
- `request()`：rid = 递增串；pending 表 + unref 定时器；conn 关闭时全部 reject `E_AGENT_GONE`。
- history.snapshot：先 `bus` 侧开缓冲（订阅该 agent 的 ev）→ `request(snapshot_req)` → 按 reply.sessionFile+leafId 读文件（失败 → `request(branch_req)`）→ `mergeSnapshot` → 取尾部 400 条。文件读取只接受**agent 上报的** `sessionFile`（浏览器永远不能指定路径），且须以 `.jsonl` 结尾、`realpath` 后仍为常规文件。按 `(file,size,mtimeMs)` 缓存解析结果（LRU 4）。
- **对齐点（spike K7②）**：以 `snapshot_reply` 同 tick 的 `leafId` 为唯一对齐点——从文件中该 leaf 回溯（leaf 之后新追加的条目忽略，由随后的 ev / append 覆盖）；leaf 不在文件（未 flush）⇒ `branch_req` 回落。**禁止**用 `turn_end.messageEntryId == leaf` 判「文件已追平」（工具轮中它指向 assistant(toolCall)，leaf 已是 toolResult），它只可证明该条目已落盘；`session_compact` 的 `compactionEntry.id` 恒等于 leaf，收到后可作硬对齐点（订阅者推 `gap` 重新快照，替代增量拼接）。
- `mergeSnapshot` 规则：调用 A 的 `reconcileRecent(branch 尾部 |recent| 条消息类条目, reply.recent)` 取未落盘项按 seq 补尾（多重集对账，不用集合）；**快照合并必含会话文件读取路径**（文件是 idle custom_message 的唯一来源，不能纯事件驱动）；`inflight` 附加；`buffered` 中 `seq > reply.seq` 的原样返回给调用方在 SSE 上按序补推（C 负责推送），返回 `fromSeq = reply.seq + 1`。
- **尾部补齐（spike K7④）**：registry 为每个 agent 维护 `delivered`（最近 512 条已下发条目/消息的 entryKey，来自 snapshot 结果、ev `message_end`、已发 append）。`status.leafId` 变化 ⇒ `history.onLeafChanged`：有订阅者时 500ms 去抖 → `readBranchFromFile(tail 64)` → A 的 `diffAppended(delivered, tail)` → 非空则 bus `append` 并并入 delivered。文件读不到 leaf ⇒ 静默跳过（下次 leaf 变化再试）。ev 中已转发的 message_end 与随后文件出现的同条目靠多重集计数抵消，不会重复推。
- 空闲：`idleExitMinutes*60e3`，30s 检查；到期 `close("idle")`。hub 进程内定时器可 unref，但 server 保持 ref（hub 本就该常驻直到空闲）。
- SIGTERM/SIGINT → `close("signal")`；`uncaughtException` → 记日志后 `close("crash")` 并 `process.exit(1)`（由 main.ts 挂，B 提供 `installProcessHandlers(hub, log)` 于 `hub.ts`）。

测试（`tests/web-hub/hub/`，全部用 `mkdtemp` 临时 HOME + 显式 paths，端口 0）：

| 文件                   | 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `singleton.test.ts`    | 同进程并发 3 次 `acquireSingleton` → 恰 1 owner、2 exists；残留死 socket 文件 → unlink 后成功；陈旧 lock（死 pid / 老 mtime）被清；活 lock → 退避一次后 exists/failed；fence：替换 socket 文件 inode → `onLost` 触发                                                                                                                                                                                                                                                                                                       |
| `agent-server.test.ts` | 真 unix socket：2s 不发 hello 被断；坏 hello → `hello_reject E_BAD_HELLO`；major≠1 → `E_PROTO`；hello_ack 带 `http.port`；30s 静默断开（fake timers）；超 4 MiB 帧断开                                                                                                                                                                                                                                                                                                                                                     |
| `registry.test.ts`     | 表驱动状态矩阵：live→(close 无 bye)→stale→(reapMs)→down；stale→(同 agentId 重连)→live 且 agentKey 不变；bye→down；pidAlive=false→下一 tick down；`request` 超时 reject、conn 关闭 reject；bus 事件序列断言；认领窗口：`bye{handover}` 后 10s 内同 agentId 重连 ⇒ bus 零 `agent_down/up`、epoch 变 ⇒ 推 `gap`；窗口超时 ⇒ `agent_stale`                                                                                                                                                                                     |
| `history.test.ts`      | fixture 分支回溯（含废弃分支不读）；leaf 不存在 → LEAF_NOT_FOUND；**K7 时序**：message_end 已转发但 leaf 未前移 → recent 补尾且不重复；custom 消息去重；buffered seq 过滤；连续同内容 custom 两条均保留；**对齐点**：工具轮 `turn_end.messageEntryId≠leaf` 的 fixture 下合并结果只以快照 leafId 为准；leaf 之后的文件条目不进快照；`session_compact` ⇒ 推 `gap`；**尾部补齐**：idle custom_message（无对应 ev）经 `onLeafChanged` 推 `append` 一次、重复 leaf 变化不重推；已由 ev 转发的消息落盘后不重推；无订阅者不读文件 |
| `idle.test.ts`         | 三计数任一 >0 重置；全 0 持续 idleMs 触发一次                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `hub.test.ts`          | `startHub` + 假 FrontendFactory：hub.json 内容/权限 0600、stateDir 0700；`close` 删 sock 与 hub.json；第二个 `startHub` 返回 `{exists:true}`                                                                                                                                                                                                                                                                                                                                                                               |

验收：`npx vitest run tests/web-hub/hub && npm run typecheck`。规模 ~1000 LOC + ~700 test；thinking **high**。

### 包 C — hub HTTP（W2）

| 项     | 内容                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| 文件域 | `src/web-hub/hub/{http,sse,auth,static}.ts`、`tests/web-hub/http/**`                   |
| 冻结面 | protocol/**、ports.ts；B 的文件只经 `ports.ts` 类型耦合（测试用手写假 `FrontendDeps`） |

```ts
// http.ts
export const createHttpFrontend: FrontendFactory;
// auth.ts
export interface Auth {
  token(): string; // 首次 wx+0600 创建（32B base64url）；mode 宽于 0600 → chmod + warn
  login(candidate: unknown, now: number): { ok: true; sid: string } | { ok: false; code: "E_AUTH" | "E_RATE" }; // sha256 后 timingSafeEqual；5 失败/60s
  check(cookieHeader: string | undefined, now: number): boolean; // pwh_sid，12h 滑动
  logout(sid: string): void;
}
export function createAuth(opts: { tokenFile: string; randomBytes?: (n: number) => Buffer; log: HubLog }): Auth;
// sse.ts
export interface SseClient {
  id: string;
  subscribed: Set<string>;
  send(event: (typeof SSE_EVENTS)[number], data: unknown): boolean;
  close(): void;
}
export interface SseHub {
  attach(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    lastEventId: number | undefined,
  ): SseClient;
  publish(event: (typeof SSE_EVENTS)[number], data: unknown, agentKey?: string): void; // agentKey 存在时仅推给订阅者；全局 ring（≤8192 条 且 ≤16 MiB 序列化字节，任一超限丢最旧）按 id 补发
  get(clientId: string): SseClient | undefined;
  count(): number;
  closeAll(): void;
}
export function createSseHub(opts: {
  ringSize?: number /* 8192 */;
  ringMaxBytes?: number /* 16 MiB，按已序列化 SSE 帧字节计 */;
  maxBufferedBytes?: number /* 2 MiB */;
  pingMs?: number /* 15s */;
  now: () => number;
}): SseHub;
// static.ts
export function webRoot(): string; // fileURLToPath(new URL("../web/", import.meta.url))
export function serveStatic(root: string, urlPath: string, res: import("node:http").ServerResponse): Promise<boolean>;
```

端点（P1）：

| 端点                                                                 | 鉴权           | 行为                                                                                                                      |
| -------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /` `GET /assets/*`                                              | 无             | `static.ts`；扩展名白名单 `.html .js .css .svg .ico`；`decodeURIComponent` 后拒 `..`/NUL/反斜杠，`resolve` 后须在 root 内 |
| `GET /healthz`                                                       | 无             | `{ok:true, version}`                                                                                                      |
| `POST /api/login` / `POST /api/logout`                               | token / cookie | Set-Cookie `pwh_sid=…; HttpOnly; SameSite=Strict; Path=/`                                                                 |
| `GET /api/events`                                                    | cookie         | SSE；首帧 `hello{clientId}` + `hub` + `agents`（全量卡片）；`Last-Event-ID` 在 ring 内补发，否则 `resync`                 |
| `POST /api/subscribe {clientId, agentKey}` / `POST /api/unsubscribe` | cookie+CSRF    | 加入订阅集 → `history.snapshot()` → SSE 推 `history`，随后补推 buffered ev；失败推 `history{error}`                       |
| `GET /api/history?agent=&before=&limit=`                             | cookie         | `history.page()`，limit ≤ 400                                                                                             |
| `POST /api/cmd` `/api/dialog` `/api/headless*`                       | cookie+CSRF    | **501 `E_NOT_IMPLEMENTED`**（P2/P3 预留，已过中间件）                                                                     |

实现要点：

- 每响应：`Content-Security-Policy`（arch §9 原文）、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；`/api/*` 加 `Cache-Control: no-store`。
- `Host` ∉ {`127.0.0.1:<port>`, `localhost:<port>`} → 421（先于鉴权）；POST 须 `Content-Type: application/json` + `X-PWH: 1` + `Origin`（若有）同源，否则 403 `E_CSRF`；body ≤ 64 KiB，超限 413。
- `listen(config.port, "127.0.0.1")`，`EADDRINUSE` → `listen(0)`；`config.port===0` 直接随机。绑定地址不可配。
- ring（评审修订）：条目存**已序列化**帧字符串并累计字节；`count > ringSize || bytes > ringMaxBytes` ⇒ 丢最旧；重连客户端 `Last-Event-ID < ring 最旧 id - 1`（被淘汰区间）⇒ 发 `resync`。`history` 帧是单客户端定向推送，**不入 ring、不占 id**。
- bus → SSE 映射：`agent_up/down/stale/session/status/fleet/prompt` 全局推；`ev/gap` 仅推订阅者。SSE `writableLength > 2 MiB` → 关闭该客户端。
- `clientCount()` 供 idle。

测试（`tests/web-hub/http/`，真 `node:http` 端口 0 + `fetch`/`http.get`）：

| 文件               | 覆盖                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security.test.ts` | Host 伪造 421；无 cookie 401；缺 X-PWH / 错 Content-Type / 异源 Origin 403；登录限流第 6 次 429；错 token 与对 token 比较耗时同阶（只断言走 timingSafeEqual 分支）；安全头齐全；token 文件 0644 → 被修正为 0600；监听地址 `127.0.0.1` |
| `static.test.ts`   | `/assets/../../package.json`、`%2e%2e`、NUL、非白名单扩展名 → 404                                                                                                                                                                     |
| `sse.test.ts`      | 补发（ring 内）/ resync（ring 外）；订阅过滤；慢消费者关闭；ping 15s（fake timers）；ring 字节上限：推入累计 >16 MiB（用 1 MiB 大帧）⇒ 最旧被淘汰、条数 <8192、落在淘汰区间的 Last-Event-ID ⇒ `resync`；history 不入 ring             |
| `api.test.ts`      | subscribe → history 推送顺序先于 buffered ev；snapshot 超时 → `history{error:"E_DEADLINE"}`；P2 端点 501；bus `append` → 仅推订阅者 SSE `append`（入 ring）                                                                           |

验收：`npx vitest run tests/web-hub/http && npm run typecheck`。规模 ~800 LOC + ~550 test；thinking **high**（安全面）。

### 包 D — agent-client（W2）

| 项     | 内容                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件域 | `src/web-hub/agent/{index,connection,launcher,event-tap,snapshot,status}.ts`、`tests/web-hub/agent/**`                                                                     |
| 冻结面 | protocol/**；只读复用 `src/ui/fleet-panel.ts`（`buildFleetViewModel`）、`src/hud/plugin-info.ts`、`src/core/types.ts`；**不改** `src/index.ts`/`src/stack.ts`/任何现有文件 |

```ts
// index.ts
export interface WebHubSettings {
  enabled: boolean;
  autoStart: boolean;
  port: number;
  idleExitMinutes: number;
  nodeLoader: string;
} // I 在 settings.ts 定义同形接口并 re-export 给这里用：D 先在本文件定义，I 让 settings.ts `import type` 它（避免 D 改 settings.ts）
export interface WebHubDeps {
  settings: WebHubSettings;
  fleet: () => readonly RunSnapshot[]; // I: () => holder.current?.query.list() ?? []
  fleetTypeOf?: (runId: string) => string | undefined;
  hubMainPath?: string; // 默认 fileURLToPath(new URL("../hub/main.ts", import.meta.url))
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}
export interface WebHubStatusView {
  state: "off" | "connecting" | "live" | "backoff" | "loader" | "proto";
  agentKey?: string;
  hubVersion?: string;
  httpPort?: number;
  lastError?: string;
  attached: boolean;
}
export interface WebHubControl {
  status(): WebHubStatusView;
  url():
    | { url: string }
    | {
        hint: string;
      }; /* http://127.0.0.1:<port>/#t=<token>；端口：live 用 hello_ack.http.port，否则读 hub.json（校验 pid 存活）；两者皆无 ⇒ hint；token 同步读 tokenFile，缺失 ⇒ 无 fragment URL + hint */
}
export function wireWebHub(pi: ExtensionAPI, deps: WebHubDeps): WebHubControl;

// connection.ts —— 两个 global（评审修订）：
//   globalThis[Symbol.for("pi-subagent:web-hub:agent-id")] = { pid, nonce }  纯数据，进程内首次创建后只读
//   globalThis[Symbol.for("pi-subagent:web-hub")]          = 当前 HubConnection（模块实例级，identity-checked）
export const MODULE_INSTANCE: string; // 模块作用域 const = randomUUID()；每次模块求值（K4：每次会话替换）都不同
export function processAgentId(): AgentId; // 读或首次创建 agent-id global
export interface BindingPort {
  onSnapshotReq(rid: string): void;
  onBranchReq(rid: string, maxBytes: number): void;
  onStateChange(v: WebHubStatusView): void;
}
export interface HubConnection {
  readonly implVersion: string; // = `${buildId}#${MODULE_INSTANCE}`（仅 buildId 无法区分同源码的模块重求值，dirty 改码时 buildId 也不变）
  attach(binding: BindingPort, session: SessionInfo): void; // 取消宽限定时器；live 时立即发 session
  detach(reason: "quit" | "reload" | "new" | "resume" | "fork"): void; // quit → bye+close+release；其余 → session_detached + 10s unref 宽限
  send(frame: AgentFrame, opts?: { droppable?: boolean }): void; // 同步，永不 throw、永不 await；非 live 态不入队（见背压）
  setSlot(kind: "session" | "status" | "fleet" | "prompts", frame: AgentFrame): void; // 覆盖式状态槽，进入 live 时补发
  readonly bufferedBytes: number; // socket.writableLength + 合并缓冲；测试用
  nextSeq(): number;
  readonly seq: number;
  status(): WebHubStatusView;
  close(reason: string): void;
}
export function acquireConnection(opts: {
  buildId: string;
  pluginVersion: string;
  kind: AgentKind;
  cwd: string;
  paths: HubPaths;
  settings: WebHubSettings;
  launcher: LauncherPlan | { error: string };
  now: () => number;
  netConnect?: typeof import("node:net").connect;
}): HubConnection; // global 中实例 implVersion 相同 ⇒ 复用（同一模块实例内的 detach→attach）；不同 ⇒ 旧实例 bye{handover}+close，新建（同 agentId、新 epoch）
export function releaseConnection(conn: HubConnection): void; // identity-checked delete

// launcher.ts
export interface LauncherPlan {
  execPath: string;
  jitiCli: string;
  argv1: string;
}
export function resolveJitiCli(opts: {
  argv1: string | undefined;
  override: string;
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
}): { ok: true; jitiCli: string } | { ok: false; reason: string };
export function spawnHub(
  plan: LauncherPlan,
  mainTs: string,
  config: HubConfig,
  spawnImpl?: typeof import("node:child_process").spawn,
): void; // detached, stdio ignore, env PI_WEBHUB_CONFIG / PI_WEBHUB_LAUNCHER, .unref()

// event-tap.ts
export interface EventTap {
  handle(event: { type: string } & Record<string, unknown>): void; // 同步：投影→合并→send；绝不 stringify 累计 message
  recent(): SnapshotReplyBody["recent"];
  inflight(): InflightState | undefined;
  prompts(): SnapshotReplyBody["prompts"];
  costUsd(): number;
  resetForSession(initialCostUsd: number): void;
  dispose(): void;
}
export function createEventTap(
  sink: (e: WireEvent, droppable: boolean) => void,
  opts: { now: () => number; setTimer: (ms: number, fn: () => void) => { cancel(): void } },
): EventTap;

// snapshot.ts
export function buildSnapshotReply(
  rid: string,
  parts: { seq: number; ctx: ExtensionContext; tap: EventTap; status: StatusInfo; fleet: FleetRowWire[] },
): Extract<AgentFrame, { t: "snapshot_reply" }>;
export function buildBranchReply(
  rid: string,
  ctx: ExtensionContext,
  maxBytes: number,
): Extract<AgentFrame, { t: "branch_reply" }>; // getBranch() → projectSessionEntry，超限取尾部并 truncated

// status.ts
export function readStatus(ctx: ExtensionContext, tap: EventTap, fleet: readonly RunSnapshot[]): StatusInfo;
export function projectFleet(
  snaps: readonly RunSnapshot[],
  now: number,
  typeOf?: (id: string) => string | undefined,
): FleetRowWire[]; // buildFleetViewModel → 字段子集
export function fleetFingerprint(rows: readonly FleetRowWire[]): string; // 去掉 elapsed/phaseMs 的秒级抖动后比较，1Hz 有变化才发
```

实现要点：

- `wireWebHub` 在 activate 时一次性 `pi.on(...)` 注册：`session_start`（attach）、`session_shutdown`（detach）、白名单事件（→ tap）、`turn_end`/`agent_settled`（→ status）。`ctx.mode ∉ {"tui","rpc"}` ⇒ 永不 attach（print/json 零 socket）；未 attach 时所有 handler 首行 return。
- Binding 保存最新 `ctx`（每个事件刷新），所有 ctx 调用 `try/catch`（会话替换后的 stale ctx 抛错时静默）。
- attach 时 `resetForSession(initialCost)`：一次 `getBranch()` 汇总 assistant `usage.cost.total`；此后 `message_end` 增量累加。复杂度 **O(branch entries)**（`getBranch()` 本身即 O(n) 回溯），单遍、只看 `type==="message" && message.role==="assistant"` 的 `usage.cost.total`，不序列化、不读废弃分支、不扫 `getEntries()`；放在 `setImmediate` 里执行，`session_start` handler 立即返回，汇总完成前 `costUsd` 缺省（网页显示 `—`）。
- 拉起：connect 1s 失败(ENOENT/ECONNREFUSED) 且 `settings.autoStart` 且 `env.PI_WEBHUB_HEADLESS!=="1"` 且距上次拉起 ≥30s ⇒ `spawnHub`，250ms→4s 退避重连共 8s，之后进常规退避。launcher 解析失败 ⇒ 状态 `loader`，不再尝试拉起（仍按退避尝试连接已存在的 hub）。
- buildId：activate 时 `readPluginInfo(defaultPluginInfoDeps())`（自带 3s git 超时）异步得到 `${version}@${commit ?? "nogit"}${dirty ? "*" : ""}`；首次 connect 等它最多 3s，超时用 `${version}@unknown`。
- **K4 两路径（spike 吸收 #1）**：
  - 路径 1 同模块实例（实测 `/new`、`/resume`、`/fork`）：`session_shutdown` → `detach(reason)` 发 `session_detached` + 起 10s 宽限；activate 重跑时 `acquireConnection` 见 implVersion 相同 ⇒ 复用；`session_start` → `attach` 取消宽限、发新 `session` 帧（新 sessionFile/leafId）。**不重连、不重握手**；hub 收 `session` 后对订阅者推 `session` + `gap`，浏览器按新会话文件重新快照。event-tap `resetForSession` 清 recent/inflight。
  - 路径 2 模块重求值（实测 `/reload`；读码推断跨 cwd 的 /resume /fork 也属此路径）：implVersion 不同 ⇒ 旧实例 `bye{handover}` + close，新实例同 agentId、新 epoch 重连，hub 认领窗口静默改绑。
  - activate 未伴随 session_start（实测存在）：只注册 handler，不取连接。
- leaf 探测（spike K7④）：1Hz tick（与 fleet 同一个 unref 定时器，仅 attached 且 live 时运行）读 `ctx.sessionManager.getLeafId()`，变化 ⇒ 写 status 槽并发送 `status{leafId,…}`（非 droppable）；turn/agent 边界的 status 也带 leafId。idle 直发的 custom_message 不经扩展事件，这是 hub 发现它的唯一信号。
- 背压（评审修订：内存有界，同 arch §4.1）：
  - **只有 `live` 态写 socket**；`connecting/handshaking/backoff` 态不入队：`session/status/fleet/prompts` 写覆盖式状态槽（各 1 份），`ev` 丢弃但 `seq` 照常递增并记 `gapFrom`；进入 live ⇒ 发 hello_ack 后依次补发状态槽 → `gap{fromSeq:gapFrom}`（若有）。
  - socket `close`/`error` ⇒ 立即清空合并缓冲并丢弃 socket（其内部写缓冲随之释放），`seq` 不回退，记 `gapFrom`，转 backoff。
  - live 软上限 `bufferedBytes > LIMITS.writeQueueBytes`(1 MiB) ⇒ 丢 droppable（message_update delta、tool_execution_update）并记 `gapFrom`，`drain` 后发 `gap`；非 droppable 在软上限下仍写。
  - live 硬上限 `bufferedBytes > LIMITS.hardQueueBytes`(4 MiB，A 的 `LIMITS` 新增) ⇒ `socket.destroy()` + 清空 + 记 `gapFrom` + backoff。
  - 结果：hub 被 `kill -STOP`（内核照常 accept、进程不读）时，handshaking 最多 2s（无 hello_ack 即断）、live 最多 30s 静默或 4 MiB 即断，agent 常驻缓冲 ≤ 4 MiB + 一帧。
- 状态行（仅 `ctx.mode==="tui"` 且 `ctx.hasUI`）：`ctx.ui.setStatus("pi-subagent:web-hub", "web ●" | "web ○" | "web ✗loader" | "web ✗proto" | "web ✗")`，英文 token（AGENTS UI 文案规约）；detach 时清除。
- 所有 socket `unref()`、所有定时器 `.unref()`；`detach("quit")` 同步 `write(bye)` + `end()`，不等 flush。

测试（`tests/web-hub/agent/`，假 hub = 测试内 `net.createServer` + protocol 解码器；fakePi 同 `tests/integration/merged-plugins-wiring.test.ts` 形状；临时 HOME 用 `sandboxHome()`）：

| 文件                 | 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection.test.ts` | 状态机表驱动（connecting→handshaking→live→backoff…）；hello_ack 2s 超时断开退避；退避序列 0.5→30s±20%；30s 无帧断开；reconnect 后重发 hello+状态槽+gap；**K4 两路径**：路径 1 同实例 detach("new")→attach 复用同一 socket（零 `net.connect` 增量）、发 `session_detached` 后接新 `session`；路径 2 **模块重求值**：`vi.resetModules()` 后二次 import 得到新 `MODULE_INSTANCE`，同 buildId 下 `acquireConnection` 仍关旧建新（旧实例发 `bye{handover}`），两实例 `processAgentId()` 相同、hello.epoch 不同；同一模块实例内 detach("reload")→attach 复用；宽限 10s 无 attach → `bye{detach-timeout}`；identity-checked release（旧实例 release 不删新实例）；**背压有界**：假 net 接受连接并回 hello_ack 后 `socket.pause()` 永不读，持续灌 10k 条 ev + status → `bufferedBytes` 恒 ≤ 4 MiB + 最大帧、触发 destroy→backoff、每次 `send`/handler 同步返回（< 5ms）；假 net 接受但从不回 hello_ack ⇒ 2s 断开、期间 ev 不入队只记 gapFrom；close/error 后缓冲清零、seq 单调、重连首批含 `gap{fromSeq}`；**所有句柄 unref**（断言 `socket.unref`/timer `hasRef()===false`） |
| `event-tap.test.ts`  | text/thinking/toolcall delta 按 contentIndex 转 delta-only、50ms 合并；`message_update` 从不序列化累计 message（传入 getter 计数的 Proxy 断言）；tool update 250ms latest-wins；>64 KiB 截断；recent 环 64；inflight 在 message_end 清除；ui_prompt 嵌套/配对                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `launcher.test.ts`   | argv1 为 symlink（`bin/pi` → `dist/cli.js`）解析成功；找不到 pi 包 → reason；override 优先；`spawnHub` 参数（detached/stdio ignore/env/unref）；30s 节流；`PI_WEBHUB_HEADLESS=1` 永不拉起                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `wiring.test.ts`     | fakePi：`mode:"print"` 与 `"json"` 全程零 `net.connect` 调用；`tui` 下 session_start → hello+session 帧；session_shutdown(quit) → bye；handler 在 hub 不可达时同步返回（< 5ms，fake net 永不回调）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `snapshot.test.ts`   | leafId/seq 同 tick；branch_reply 超 2 MiB 取尾 truncated；fleet 投影与 fingerprint 抖动过滤；leaf 探测：leafId 变化才发 status、不变不发；非 live 态只写槽                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

验收：`npx vitest run tests/web-hub/agent && npm run typecheck`。规模 ~1000 LOC + ~750 test；thinking **high**（生命周期/零 hang）。

### 包 E — 前端（W2）

| 项     | 内容                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件域 | `src/web-hub/web/{index.html,app.js,contract.js,state.js,style.css}`、`src/web-hub/web/render/{agents,transcript,markdown,tools,fleet,banner}.js`、`tests/web-hub/web/**` |
| 冻结面 | 只经 HTTP 契约（`http-contract.ts`）耦合；不 import 任何 TS                                                                                                               |

模块接口（JSDoc 注解，ES modules，无构建）：

```js
// contract.js —— 手工镜像 http-contract.ts
export const SSE_EVENTS = [/* 与 protocol/http-contract.ts 完全相同 */];
// state.js —— 纯函数，无 DOM，可在 vitest(node) 直接测
/** @returns {State} */ export function initialState() {}
/** @param {State} s @param {{event:string,data:any,id?:number}} msg @returns {State} */ export function reduce(
  s,
  msg,
) {} // agents/history/ev(delta 拼接)/status/fleet/prompt/gap(→needsResync)
// render/markdown.js
/** @returns {MdNode[]} */ export function parseMarkdown(text) {} // 白名单：代码块/行内码/粗斜体/列表/链接(http|https only)/段落
/** @param {MdNode[]} nodes @param {Document} doc @returns {DocumentFragment} */ export function toDom(nodes, doc) {} // 只 createElement + textContent
// app.js —— 启动：读 location.hash `#t=` → POST /api/login（X-PWH:1）→ localStorage 存 token → history.replaceState 清 hash；EventSource('/api/events')；45s 无帧重连；401 → 用 localStorage token 静默重登一次
```

实现要点：

- 布局：左栏 agent 卡片（kind/cwd/session 名/busy/成本/stale 置灰/`outdated` 标记），右栏选中 agent 的对话流 + 工具卡（折叠，截断标记）+ subagent 树（按 `parentRunId` 缩进，同 fleet-widget 语义）+ 顶部 `blocked on dialog (kind, title)` 横幅（K8：`custom` 显示为 `custom`）。
- **只读**：P1 不渲染输入框（留占位 `<div id="composer" hidden>` 供 P2）。
- 安全：全部 `textContent`；禁止 `innerHTML`/`insertAdjacentHTML`/`document.write`/内联事件；无内联 `<script>`/`<style>`（CSP `script-src 'self'`）。
- 上翻：滚到顶部调 `/api/history?before=`。一个标签页只开一条 EventSource。

测试（`tests/web-hub/web/`，vitest node 环境直接 import .js；tests 不在 tsconfig include 内，不影响 typecheck）：

| 文件                   | 覆盖                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contract.test.ts`     | `web/contract.js` 的 `SSE_EVENTS` 与 `protocol/http-contract.ts` 深相等                                                                                                                                            |
| `state.test.ts`        | delta 累积 = 最终文本；history 后续 ev 按 seq 去重；gap → needsResync；stale/down 卡片变迁；`append` 事件按 entryKey 并入 transcript，custom 不按键去重；`session` 变更 ⇒ 清空该 agent transcript 并等待新 history |
| `markdown.test.ts`     | `javascript:`/`data:` 链接降级为纯文本；`<script>` 原样成文本节点；嵌套/未闭合代码块                                                                                                                               |
| `no-innerhtml.test.ts` | 扫描 `src/web-hub/web/**/*.{js,html}`：无 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`eval(`、`new Function`、`on\w+=` 内联事件、内联 `<script>` 正文                                                         |

验收：`npx vitest run tests/web-hub/web && npm run format:check`。规模 ~1000 LOC（JS/CSS/HTML）+ ~250 test；thinking **medium**。

### 包 I — 装配（W3，串行，单包独占热点文件）

| 项     | 内容                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件域 | `src/config/settings.ts`、`src/config/setting-specs.ts`、`src/index.ts`、`src/commands/webhub.ts`（新）、`src/web-hub/hub/main.ts`（新）、`tests/config/web-hub-settings.test.ts`、`tests/commands/webhub.test.ts`、`tests/integration/web-hub-*.test.ts`、`AGENTS.md`（layout 增 `src/web-hub/` 条目） |
| 冻结面 | A–E 全部文件只读（发现缺陷 → 退回对应包修）                                                                                                                                                                                                                                                             |

```ts
// settings.ts（新增，沿 HudSettings 体例；P1 只加 5 键，P2/P3 键随期加入，不留死旋钮）
import type { WebHubSettings } from "../web-hub/agent/index.js";
export type { WebHubSettings };
// AgentSettings 增：webHub: WebHubSettings;
// DEFAULT_SETTINGS.webHub = { enabled: false, autoStart: true, port: 7878, idleExitMinutes: 10, nodeLoader: "" }
export function parseWebHubSettings(input: unknown): WebHubSettings; // 逐字段回落，never throws；port 整数 0..65535；idleExitMinutes finite ≥1
// setting-specs.ts：webHub.enabled / autoStart / port / idleExitMinutes / nodeLoader 五条 spec（非 live：改后 /reload）

// commands/webhub.ts
export function createWebHubCommand(deps: { control: () => WebHubControl | undefined }): RegisteredCommand; // "status" | "open"（默认 status）

// hub/main.ts —— hub 进程入口（被 jiti-cli 执行），只做：解析 env PI_WEBHUB_CONFIG → startHub(config, createHttpFrontend) → installProcessHandlers；{exists:true} ⇒ exit 0
```

`src/index.ts` 改动（仅两处，均 post-guard）：

1. 文件末尾 `reloadRef.current = wireDeferredReload(...)` **之后**（保证 web-hub 的 `session_start` 在 stack 构建之后执行、fleet port 可读）：
   ```ts
   const webHubRef: { current?: WebHubControl } = {};
   if (settings.webHub.enabled)
     webHubRef.current = wireWebHub(pi, {
       settings: settings.webHub,
       fleet: () => holder.current?.query.list() ?? [],
     });
   ```
2. `/webhub` 命令**仅在 enabled 时**注册：`if (settings.webHub.enabled) pi.registerCommand("webhub", createWebHubCommand({ control: () => webHubRef.current }))`。
   `/webhub status` 输出（`ctx.ui.notify`）：state、agentKey、hub 版本、URL（不含 token）；`/webhub open`：打印含 `#t=` 的 URL（`url()` 返回 `hint` 时原样提示，如「hub 未运行：state=backoff，见 ~/.pi/agent/web-hub/hub.log」），并 best-effort `xdg-open`/`open`（detached、stdio ignore、unref、3s 内不回调即忽略）。

测试：

| 文件                                         | 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/config/web-hub-settings.test.ts`      | 默认值；非法字段逐项回落；`loadSettings({})` 含 `webHub.enabled=false`；settings-editor 行出现 5 键                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tests/commands/webhub.test.ts`              | status/open 文案；control 为 undefined 时的提示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tests/integration/web-hub-disabled.test.ts` | 两次 activate + session_start 对照：①基线 = `vi.mock` 把 `src/web-hub/agent/index.js` 的 `wireWebHub` 换成 no-op spy ②默认设置（enabled=false）真实模块。对每个事件类型取 handler 源码（`fn.toString()`）多重集，断言 ②−① 与 ①−② **逐事件类型差集均为空**，且 spy 未被调用；无 `webhub` 命令；`$HOME/.pi/agent/web-hub` 不存在；零 `net.connect`（spy）。另跑 enabled=true 一次，断言差集非空且只落在 D 注册的事件类型上（证明对照有效）                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tests/integration/web-hub-e2e.test.ts`      | `sandboxHome()`；进程内 `startHub(config, createHttpFrontend)`；activate(fakePi, enabled) ×2（两个不同 agentId 模拟两 TUI）→ SSE `agents` 含 2；喂 message_start/update/end → 浏览器侧 SSE 收到 delta 且 `/api/subscribe` 的 history 与 jsonl fixture 一致；`/reload` 模拟 3 次 → 始终 2 个 agent；关闭 hub → agent 状态 backoff 且 handler 仍同步返回；**K4 两路径**：`session_shutdown(new)`+同实例 activate+`session_start(new)` ⇒ 连接对象同一、hub 零 agent_down/up；`/reload` 模拟 = `session_shutdown(reload)` + `vi.resetModules()` 后重新 import activate + `session_start(reload)` ⇒ handover 且 agentKey 不变；**idle custom**：直接往会话 fixture 文件追加 custom_message 行并推进 fake `getLeafId()` ⇒ ≤2s 内 SSE 收到 `append`；沙盒 `pi-subagent.json` 写 `"reload":{"defer":false}`，避免 defer 把 reload 改写成 parked 命令 |
| `tests/integration/web-hub-spawn.test.ts`    | 真子进程：以 `node_modules/@earendil-works/pi-coding-agent/dist/cli.js` 作 argv1 走 `resolveJitiCli` + `spawnHub`；并发拉起 3 个 → 10s 内仅 1 个 pid 存活且 hub.json 一致；`kill -9` hub → agent 8s 窗口内重拉起并重注册；测试结束按 hub.json pid 清理。CI 无 pi dev 依赖时 `skipIf` 并打印原因                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

验收：四件套全绿 + §5。规模 ~350 LOC + ~500 test；thinking **medium**。

### 测试总表（按包归属，避免同文件多包写）

`tests/web-hub/{protocol,boundary}`→A · `tests/web-hub/hub`→B · `tests/web-hub/http`→C · `tests/web-hub/agent`→D · `tests/web-hub/web`→E · `tests/config/web-hub-*`、`tests/commands/webhub*`、`tests/integration/web-hub-*`→I · fixture `tests/fixtures/web-hub/**`→A（B/D 只读）。

---

## 3. 冲突预检 spec.json 草案

脚本实际位置是**仓库内** `skills/dev-flow/scripts/conflict-check.mjs`（`~/.agents/skills/dev-flow/` 不存在，AGENTS.md 也禁止第二份副本）；格式为数组、键名 **`id`**（不是 `name`）、glob 只支持 `** * ?`（**不支持花括号**，故逐文件列出）。保存为 `/tmp/web-hub-spec.json` 后：
`node skills/dev-flow/scripts/conflict-check.mjs /tmp/web-hub-spec.json --cwd /home/bluecake/ai/pi-toolkit`

```json
[
  {
    "id": "A:protocol",
    "globs": [
      "src/web-hub/protocol/**",
      "src/web-hub/hub/ports.ts",
      "tests/web-hub/protocol/**",
      "tests/web-hub/boundary.test.ts",
      "tests/fixtures/web-hub/**"
    ]
  },
  {
    "id": "B:hub-core",
    "globs": [
      "src/web-hub/hub/hub.ts",
      "src/web-hub/hub/singleton.ts",
      "src/web-hub/hub/agent-server.ts",
      "src/web-hub/hub/registry.ts",
      "src/web-hub/hub/history.ts",
      "src/web-hub/hub/idle.ts",
      "src/web-hub/hub/log.ts",
      "tests/web-hub/hub/**"
    ]
  },
  {
    "id": "C:hub-http",
    "globs": [
      "src/web-hub/hub/http.ts",
      "src/web-hub/hub/sse.ts",
      "src/web-hub/hub/auth.ts",
      "src/web-hub/hub/static.ts",
      "tests/web-hub/http/**"
    ]
  },
  { "id": "D:agent", "globs": ["src/web-hub/agent/**", "tests/web-hub/agent/**"] },
  { "id": "E:web", "globs": ["src/web-hub/web/**", "tests/web-hub/web/**"] },
  {
    "id": "I:assembly",
    "globs": [
      "src/config/settings.ts",
      "src/config/setting-specs.ts",
      "src/index.ts",
      "src/commands/webhub.ts",
      "src/web-hub/hub/main.ts",
      "tests/config/web-hub-settings.test.ts",
      "tests/commands/webhub.test.ts",
      "tests/integration/web-hub-*",
      "AGENTS.md"
    ]
  }
]
```

预期：exit 0，无「已存在文件交集」；A 与 B/C 同在 `src/web-hub/hub/` 但全是字面文件名，不应报潜在交集（若脚本按目录前缀报警告，属已知可接受——ports.ts 在 W1 已存在、W2 冻结）。

---

## 4. P2 / P3 里程碑（不展开）

| 期          | 里程碑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 依赖                                                                                                                                      | P1 已预留的接口点                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| P2 控制     | F：`cmd` 帧 + `/api/cmd`（prompt/abort/steer_subagent/abort_subagent）+ 乐观队列；G：`wireAskUser(pi,{remote})` 双通道（**前置（spike K8）**：`ui_prompt_start{kind:"custom"}` 不专属 ask_user——`/resume` 选择器等内置 UI 同型；dialog_open 与横幅的归因须叠加 `tool_execution_start{toolName:"ask_user"}` 与 `toolCallId`，仅 ask_user 执行窗口内的 custom prompt 视为 ask_user，其余保持 blocked 横幅） + `dialog_open/closed/answer`；版本替换 `superseded`；`/webhub stop\|token rotate`；settings 加 `remoteAskUser`；K3/K5/K8(去重)/K9 核实 | A 增 cmd/dialog schema（从 RESERVED 转正，minor+1 + caps `cmd.v1`/`dialog.v1`）；D 的 BindingPort 增 `onCmd`；B `registry.request()` 复用 | RESERVED_FRAME_TYPES；`registry.request()`；C 的 501 端点已过 CSRF 中间件；D Binding 持最新 ctx；E `#composer` 占位；`auth.rotate` 位置 |
| P3 完全接管 | H：headless spawn/注册（ticket）/rpc-stdio extension_ui 客户端/空闲回收/8s 关停；切会话/新会话注入命令（`/webhub __exec <nonce>`）；`/api/sessions`；notify/status 转发；`set_model`；settings 加 `headlessIdleMinutes/maxHeadless/piCommand`；K3/K6 核实                                                                                                                                                                                                                                                                                         | B（idle 计数已含 headless 位）、D（`PI_WEBHUB_HEADLESS` 分支已在 P1 生效）、F                                                             | hello 的 `ticket?`/`kind:"rpc"`/`launcher` 字段；`HubConfig.launcher`；idle `counts().headless`                                         |

---

## 5. P1 验收清单（verifier 用）

### 5.1 自动

```sh
cd /home/bluecake/ai/pi-toolkit
npm run format:check && npm run typecheck && npm test && npm run build
npx vitest run tests/web-hub tests/integration/web-hub-*.test.ts tests/config/web-hub-settings.test.ts tests/commands/webhub.test.ts
git diff --stat master -- src ':!src/web-hub' # 只应出现 settings.ts / setting-specs.ts / index.ts / commands/webhub.ts
grep -rnE "innerHTML|insertAdjacentHTML|\beval\(" src/web-hub/web && echo FAIL || echo ok
ls dist/web-hub/hub/main.js >/dev/null && echo "build 产物存在（pi 不读 dist，仅确认可编译）"
```

### 5.2 真机（tmux，草稿 cwd 在 /tmp；记 `H=~/.pi/agent/web-hub`）

| #   | 步骤                                                                                                                                                                                            | 判据                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **关闭态**：默认设置起一个 TUI pi                                                                                                                                                               | `ls $H` 不存在；`ss -xlp \| grep -c pi-webhub` = 0；无 `/webhub` 命令；HUD 无 `web` 状态                                                                                                                                                                                                                                                                                                                                                           |
| 2   | `pi-subagent.json` 设 `"webHub":{"enabled":true,"idleExitMinutes":1}`；tmux 起 TUI-A（/tmp/wa）、TUI-B（/tmp/wb）                                                                               | 两边状态行 `web ●`；`/webhub status` 同一 hub 版本；`jq . $H/hub.json` 单一 pid                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | 权限/绑定                                                                                                                                                                                       | `stat -c '%a %n' $H $H/token $H/hub.sock` → `700/600/600`；`ss -ltnp \| grep 7878` 仅 `127.0.0.1`                                                                                                                                                                                                                                                                                                                                                  |
| 4   | 安全校验（curl）                                                                                                                                                                                | `curl -si -H 'Host: evil:7878' 127.0.0.1:7878/` → 421；`curl -si 127.0.0.1:7878/api/events` → 401；错 token 登录 6 次第 6 次 429；`curl -si -c /tmp/j -H 'Content-Type: application/json' -H 'X-PWH: 1' -d "{\"token\":\"$(cat $H/token)\"}" 127.0.0.1:7878/api/login` → 200 + `HttpOnly; SameSite=Strict`；不带 `X-PWH` 的 subscribe → 403；响应头含 CSP / `X-Frame-Options: DENY`；`/assets/..%2f..%2fpackage.json` → 404；`POST /api/cmd` → 501 |
| 5   | **多 TUI 接入**：`/webhub open` 的 URL 在浏览器打开                                                                                                                                             | 左栏 2 张卡；TUI-A 发一轮带工具调用的 prompt → 浏览器流式文本、工具卡、最终成本；TUI-A 派一个 Agent → subagent 树出现并随完成变灰；让模型调 ask_user → 浏览器横幅 `blocked on dialog (custom)`，TUI 作答后消失                                                                                                                                                                                                                                     |
| 6   | 历史回放：刷新浏览器页                                                                                                                                                                          | 对话与 TUI 一致（无重复、无缺失）；streaming 中刷新也一致；上翻加载更早条目                                                                                                                                                                                                                                                                                                                                                                        |
| 7   | **kill -9 hub**：`kill -9 $(jq .pid $H/hub.json)`                                                                                                                                               | TUI-A/B 立即可继续输入、模型正常响应（无卡顿）；≤10s 新 hub pid 出现（autoStart）；浏览器自动恢复（必要时静默重登）；两张卡重新出现且无重复                                                                                                                                                                                                                                                                                                        |
| 8   | **kill -9 pi**：kill TUI-B 的 pid                                                                                                                                                               | ≤10s 浏览器 B 卡消失（pid 探测）；A 不受影响；`$H/hub.log` 有 reap 记录                                                                                                                                                                                                                                                                                                                                                                            |
| 9   | **/reload 无幽灵**：TUI-A 连续 `/agent reload now` ×3（本机 `reload.defer` 开启时裸 `/reload` 会被 parked；或在草稿设置里设 `"reload":{"defer":false}` 后用裸 `/reload`），再 `/new`、`/resume` | 15s 后 `curl -s -b /tmp/j 127.0.0.1:<port>/api/events --max-time 3` 的 `agents` 仅含存活 TUI 数；A 的 agentKey 不变、session 字段随 `/new` 更新；`/new` `/resume` 期间 hub.log 无该 agent 的重连记录（路径 1 复用），`/reload` 有 handover 记录                                                                                                                                                                                                    |
| 9b  | **idle custom 可见**：TUI-A 空闲时执行 `/task 写一行 hello`（`sendMessage(triggerTurn:false)` 写入启动记录）                                                                                    | ≤3s 浏览器 A 的对话流出现该自定义消息（经 `append`），刷新页面后仍在且不重复                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | **`pi -p` 不被拖住**：hub 运行中与 hub 未运行时各跑 `time pi -p "say hi"`（enabled=true）                                                                                                       | 耗时与 enabled=false 基线差 < 1s；不产生新注册卡；hub 未运行时 `pi -p` 不拉起 hub（`ls $H/hub.json` 仍不存在）                                                                                                                                                                                                                                                                                                                                     |
| 11  | hub 卡死：`kill -STOP <hubpid>` 期间在 TUI-A 发 prompt                                                                                                                                          | 响应正常；≤30s 状态行变 `web ✗`/`web ○`；`kill -CONT` 后 ≤30s 恢复 `web ●`                                                                                                                                                                                                                                                                                                                                                                         |
| 12  | 子会话 inert：TUI-A 跑 Agent 期间                                                                                                                                                               | 卡片数不增加（子 agent 只出现在 fleet 树里）                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | 单例竞争：关掉所有 hub 后并发 `for i in 1 2 3; do PI_WEBHUB_CONFIG=... node <jiti-cli> src/web-hub/hub/main.ts & done`                                                                          | 10s 后仅 1 个 hub 进程存活                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 14  | 空闲退出：关闭所有 TUI 与浏览器                                                                                                                                                                 | ≤90s（idleExitMinutes=1 + 30s 检查）hub 退出，`hub.sock` 与 `hub.json` 被删                                                                                                                                                                                                                                                                                                                                                                        |
| 15  | 回滚：设回 `enabled:false` + `/reload`                                                                                                                                                          | 状态行消失；该进程不再出现在网页；`/webhub` 命令不可用                                                                                                                                                                                                                                                                                                                                                                                             |

---

## 6. 风险与回滚

| 风险                          | 缓解                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认启用导致远程 shell 面暴露 | `webHub.enabled` 默认 `false`（K-10）；只绑 127.0.0.1，不提供绑定地址设置                                                                                                                                                                                                                                                               |
| 关闭态残留副作用              | ① `wireWebHub` 与 `/webhub` 注册都包在 `if (settings.webHub.enabled)` 内 ② `src/web-hub/**` 模块顶层无副作用（只声明）——`web-hub-disabled.test.ts` 断言逐事件类型 handler 差集为空、零 `net.connect`、零 fs 写入、`$HOME/.pi/agent/web-hub` 不存在 ③ settings 只新增一个默认关闭的组，`loadSettings` 对缺省组回落，不触发设置文件迁移写 |
| agent 侧阻塞 pi 主循环        | handler 只同步入队；网络全异步且 unref；`wiring.test.ts` 用永不回调的假 net 断言 handler < 5ms                                                                                                                                                                                                                                          |
| K1-git 失败                   | `webHub.nodeLoader` 逃生口；状态 `web ✗loader`；pi 功能不受影响                                                                                                                                                                                                                                                                         |
| hub 残留进程                  | 空闲自退 + inode fence + hub.json pid；手工：`kill $(jq .pid ~/.pi/agent/web-hub/hub.json)`；彻底清理 `rm -rf ~/.pi/agent/web-hub`                                                                                                                                                                                                      |
| pi 0.88 改事件面              | peer 已锁 `<0.88`；P2 在 `src/adapters/pi-compat.ts` 增探测                                                                                                                                                                                                                                                                             |

代码级回滚：只 revert 包 I 的提交即可——A–E 文件无任何引用方、零运行时影响；不需要数据迁移（hub 不持久化历史）。

---

## 7. 规模与档位

| 包             | src LOC              | test LOC | thinking | 备注                         |
| -------------- | -------------------- | -------- | -------- | ---------------------------- |
| A protocol     | ~550                 | ~450     | high     | 冻结面，评审后才放行 W2      |
| B hub 核心     | ~1000                | ~700     | high     | 单例/租约/回放合并           |
| C hub HTTP     | ~800                 | ~550     | high     | 安全面                       |
| D agent-client | ~1000                | ~750     | high     | 生命周期、/reload、零 hang   |
| E 前端         | ~1000（JS/CSS/HTML） | ~250     | medium   | 纯函数 state/markdown 可单测 |
| I 装配         | ~350                 | ~500     | medium   | 热点文件单包串行             |
| 合计           | ~4700                | ~3200    |          |                              |

---

## 8. 与 arch.md 的偏离 / 新发现

1. **custom 消息 messageKey 失配**（K7 新发现）：jsonl `custom_message` 条目无 `message.timestamp`，只有落盘时刻 ISO `timestamp` ⇒ arch §7 的 `role:timestamp` 对 custom 必然失配；A 改为内容键 `custom:<customType>:<fnv1a(content)>` + `reconcileRecent` 多重集对账（评审修订：集合去重会吞掉连续同内容 custom），待 K7 实测定稿。
2. **~~`turn_end.messageEntryId` 可作栅栏~~（spike K7② 更正）**：工具轮中它指向 assistant(toolCall) 条目而 leaf 已是 toolResult，只能证明该条目已落盘，**不能**当「追平 leaf」栅栏；B 的对齐点改为快照同 tick 的 leafId，`session_compact`（id==leaf）作硬对齐点。
3. **K4（spike 实测，推翻评审修订时的读码预判）**：`/new` `/resume` `/fork` 不重求值模块（pi 进程级 `extensionCache` 按路径命中），只有 `/reload`（`clearExtensionCache`）与读码推断的跨 cwd 替换（`useExtensionCacheCwd`）重求值；globalThis 全程存活。`implVersion = buildId#MODULE_INSTANCE` + `bye{handover}` + hub 认领窗口的设计保留（服务 /reload），同实例替换直接复用连接只换 `session` 帧。arch §3.2 / §8 / §12 已同步更正。
4. **K8 预判**：`custom()` 被 `wrapUIPromptContext` 包装，ask_user 在 TUI 下会发 `ui_prompt_start{kind:"custom"}`（queueMicrotask 异步）；P1 横幅显示 `custom`，P2 需与 `dialog_open` 去重。
5. **SSE 补发改为全局 ring（≤8192 条且 ≤16 MiB）**：arch 的「每 agent 2000 条」配全局 `Last-Event-ID` 无法判断某 agent 是否丢帧；字节上限防止大帧撑爆（评审修订）。
6. **reap 加速 + 认领窗口**：socket 断开无 `bye`（或 `bye{handover}`）→ 10s 静默认领窗口，超时才 stale；`process.kill(pid,0)` 探测死进程下一 tick（5s）即 reap；arch 仅 30s/60s 租约。
7. **新增 `hub/ports.ts`（归 A）、`hub/hub.ts` 组合根（归 B）、`hub/main.ts` 移给 I**：让 B 与 C 编译期解耦、可并行。
8. **`hello_ack` 增 `http:{port}`**；`projectSessionEntry`/`messageKey` 放进 protocol，由 hub 读文件与 agent 回落共用，保证两侧投影一致。
9. **settings 本期只加 5 键**（arch §13.3 列了 9 键），另外还需要改 `src/config/setting-specs.ts`（arch 漏了）；`/webhub` 命令只在启用时注册。
10. **工具位置/格式**：conflict-check 在仓库 `skills/dev-flow/scripts/`，spec 键名是 `id`，不支持花括号 glob。
11. **行号基准**：pi 实际运行 `dist/bundle/chunks/*.js`；arch 的 `core/*.js` 行号出自同包的非打包副本（语义一致，行号不能拿来对应运行时栈）。
12. **分发形态风险**：pi 包带 `dist/bun`（单文件二进制形态）——该形态下找不到 jiti，只能走 `nodeLoader` 逃生口；K1-git 另依赖 pi 为 git 源安装 `dependencies`（packages.md 写明会装，待实测）。
13. `tests/` 不在 tsconfig `include` 内 ⇒ 测试可直接 import `web/*.js`；借此加 SSE 事件名契约漂移测试（E）。
14. **背压内存有界**（评审修订）：arch §4.1 原文只规定丢 droppable，未规定断开清队与总量硬上限；已按 §9 第 1 条修订 arch §4.1。

---

## 9. 评审修订记录（reviewer zai/glm-5.3，结论「有条件通过」）

| #   | 级别 | 问题                                                                                                    | 处置                                                                                                                                                                                                                                                                                                                                                                                       | 落点                                                                      |
| --- | ---- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1   | 严重 | D 背压：只丢 droppable，未规定 close/error 清队、无非 droppable 总量硬上限；hub `kill -STOP` 时内存无界 | 只 live 态写 socket；非 live 态只写覆盖式状态槽（session/status/fleet/prompts），`ev` 丢弃记 `gapFrom`；close/error 即清空，`seq` 单调不回退，重连后 `gap` 重同步兜底；软上限 1 MiB 丢 droppable；硬上限 4 MiB（`LIMITS.hardQueueBytes`）⇒ destroy + 清空 + gap + backoff。新增测试：假 net accept 后 `pause()` 永不读 → 缓冲有界、handler 同步；accept 但不回 hello_ack → 2s 断开且不入队 | plan 包 A `LIMITS`、包 D 签名/实现要点/`connection.test.ts`；arch §4.1    |
| 2   | 严重 | D 复用判据：`implVersion=buildId` 无法区分同源码的模块重求值，dirty 改码后复用跑旧代码的连接            | `MODULE_INSTANCE` 模块作用域 const；`implVersion = buildId#MODULE_INSTANCE`；`agentId{pid,nonce}` 纯数据单独存 `Symbol.for("pi-subagent:web-hub:agent-id")`；新实例接手时旧实例发 `bye{handover}`；hello 增 `epoch`；hub 10s 认领窗口内同 agentId 重连静默改绑、不推 `agent_down/up`，epoch 变化推 `gap` 重新快照                                                                          | plan 包 A `hello/bye`、包 B registry、包 D connection；arch §3.2、§10 K-2 |
| 3   | 一般 | A keys：custom 内容键对连续两条同 type 同内容会误去重                                                   | 保留内容键但声明非唯一；新增 `reconcileRecent`（分支尾部多重集计数 + 按 seq 出现序逐条对账），`mergeSnapshot` 改用它；浏览器 custom 以 seq 去重。`keys.test`/`history.test` 补「连续两条同内容 custom 不丢」（0/1/2 条已落盘三种情况）                                                                                                                                                     | plan 包 A keys、包 B history                                              |
| 4   | 一般 | C sse：全局 ring 8192 条无字节上限                                                                      | 增 `ringMaxBytes` 16 MiB（按已序列化帧计），超限丢最旧；落入淘汰区间的 `Last-Event-ID` ⇒ `resync`；`history` 定向帧不入 ring。`sse.test` 补字节上限用例                                                                                                                                                                                                                                    | plan 包 C                                                                 |
| 5   | 一般 | D `url()` 未连上 hub 时端口来源未定义                                                                   | 返回 `{url}` \| `{hint}`：live 用 `hello_ack.http.port`，否则读 `hub.json`（校验 pid 存活），都没有 ⇒ hint；token 文件缺失 ⇒ 无 fragment URL + hint；`/webhub open` 原样展示 hint                                                                                                                                                                                                          | plan 包 D `WebHubControl`、包 I 命令                                      |
| 6   | 建议 | K4 预判措辞                                                                                             | 改为「已读码确认必然重求值」（`resource-loader.js:263-267`、`extensions/loader.js:405-411`），spike 只确认时序与 globalThis 存活；注明 AGENTS.md 所说 Node 模块缓存与 jiti `moduleCache:false` 是两层缓存                                                                                                                                                                                  | plan §1 K4 行、§8 第 3 条；arch §3.2、§12 K4                              |
| 7   | 建议 | I disabled 测试 handler 计数基线脆弱                                                                    | 改为与「`wireWebHub` 被 mock 成 no-op」的基线对照，逐事件类型取 handler 源码多重集，断言双向差集均为空；再跑 enabled=true 证明对照有效                                                                                                                                                                                                                                                     | plan 包 I 测试表                                                          |
| 8   | 建议 | D attach 时 `getBranch` 汇总 cost 未标复杂度                                                            | 标注 O(branch entries) 单遍、只看 assistant `usage.cost.total`、不读废弃分支/不扫 `getEntries()`、`setImmediate` 延后执行不阻塞 `session_start`                                                                                                                                                                                                                                            | plan 包 D 实现要点                                                        |
| 9   | 建议 | §5.1 `grep -E "eval\("` 会误报                                                                          | 改 `\beval\(`                                                                                                                                                                                                                                                                                                                                                                              | plan §5.1                                                                 |

15. **事件盲区（spike K7④）**：idle `sendMessage(triggerTurn:false)` 先落盘、只发应用总线事件，扩展收不到 message_end ⇒ 新增 `status.leafId` + hub 尾部补齐 + SSE `append`；arch §7 已补。

---

## 10. spike 吸收记录（spike-results.md「对 plan 的修正建议」1–6 + 主会话要点）

| #   | spike 结论                                                                                                  | 处置                                                                                                                                                                                                                                                                                                                                   | 落点                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | K4：`/new` `/resume` `/fork` 不重求值模块（inst 不变、activate 重跑），仅 `/reload` 重求值；globalThis 存活 | 更正 K4 预判；保留 `MODULE_INSTANCE`+handover（/reload 与读码推断的跨 cwd 替换仍需要）；同实例替换直接复用连接、只换 `session` 帧，hub 推 `session`+`gap` 让浏览器按新 sessionFile 重新快照；activate 可无配对 session_start；D/I 测试覆盖两条路径。`-e` 与已安装包读码同走 `loadExtensionsCached`，但只实测了 `-e` ⇒ 设计对两种都成立 | plan §1 K4 行、§1.1、包 D「K4 两路径」/`connection.test`、包 I e2e、§5.2 #9、§8 #3；arch §3.2、§8、§12 |
| 2   | K7②：`turn_end.messageEntryId` 工具轮 ≠ leaf                                                                | 撤销「落盘栅栏」偏离；对齐点 = 快照同 tick leafId；`session_compact` 作硬对齐点                                                                                                                                                                                                                                                        | plan 包 B 实现要点/`history.test`、§8 #2；arch §7 步骤 4                                               |
| 3   | K7④：custom 无时间戳；idle 直发 custom 不产生扩展 message_end                                               | `customKey` 转正并覆盖 `custom_message`(content) / `custom`(data)；`entryKey`/`diffAppended` 入 A；`StatusInfo.leafId`、SSE `append`、`HistoryService.onLeafChanged` 入 A；B 尾部补齐；D 1Hz leaf 探测；E 处理 `append`；keys/history/e2e 测试补事件盲区与连续同内容场景                                                               | plan 包 A/B/C/D/E/I、§5.2 #9b、§8 #15；arch §7                                                         |
| 4   | K8：`kind:"custom"` 非 ask_user 专属                                                                        | P1 横幅不变；P2 包 G 前置加「叠加 `tool_execution_start{ask_user}` 归因」                                                                                                                                                                                                                                                              | plan §1.1、§4 P2；arch §12 K8                                                                          |
| 5   | K1-git 全通过                                                                                               | 无设计变更；`nodeLoader` 仅留作 bun 单文件形态逃生口                                                                                                                                                                                                                                                                                   | plan §1.1；arch §12 K1                                                                                 |
| 6   | 本机 `reload.defer` 会 park 裸 `/reload`                                                                    | e2e 沙盒设置 `reload.defer:false`；真机验收用 `/agent reload now`                                                                                                                                                                                                                                                                      | plan 包 I e2e、§5.2 #9                                                                                 |
| 7   | 工作树有他人未提交改动                                                                                      | 列入全局冻结面（含 `src/stack.ts` 等），禁 `git add -A`/全仓 format；确认 P1 各包（含 I）**不需要改 `src/stack.ts`**                                                                                                                                                                                                                   | plan §2 全局冻结面                                                                                     |

**包 A 冻结状态**：以上改动已全部写入包 A 签名（`customKey`/`entryKey`/`diffAppended`、`StatusInfo.leafId`、`WireEntry.type` 含 `custom`、SSE `append`、`HubEvent.append`、`HistoryService.onLeafChanged`），spike 已无未决项影响 A ⇒ **可以冻结开工**（W1）。
