/**
 * Agent↔hub wire types and frame decoding (plan §包 A — frozen interface).
 *
 * Validation posture (plan 实现要点): `hello` is validated strictly (every
 * field, incl. a 16–64 char base64url `agentId.nonce`); `ev.e` and `WireMessage`
 * payloads are same-user trusted and only checked for the `type`/`role`
 * literal plus total serialized size (≤ MAX_FRAME_BYTES). Unknown frame types —
 * including RESERVED_FRAME_TYPES — decode to `undefined` and are ignored.
 */
import { Type, type TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { MAX_FRAME_BYTES } from "./ndjson.js";

// ---------------------------------------------------------------------------
// data types
// ---------------------------------------------------------------------------

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

export const FORWARDED_EVENTS = [
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
] as const;

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

// ---------------------------------------------------------------------------
// schemas (runtime validation only; the exported interfaces above are the
// authoritative shapes — behavioral tests pin schema/interface agreement)
// ---------------------------------------------------------------------------

const WireMessageSchema = Type.Object({ role: Type.String() }, { additionalProperties: true });

const eventTypeLiterals = FORWARDED_EVENTS.map((e) => Type.Literal(e));
const WireEventSchema = Type.Object({ type: Type.Union(eventTypeLiterals) }, { additionalProperties: true });

const WireEntrySchema = Type.Object(
  {
    id: Type.String(),
    parentId: Type.Union([Type.String(), Type.Null()]),
    type: Type.Union([
      Type.Literal("message"),
      Type.Literal("custom_message"),
      Type.Literal("custom"),
      Type.Literal("compaction"),
      Type.Literal("branch_summary"),
      Type.Literal("model_change"),
      Type.Literal("thinking_level_change"),
    ]),
    timestamp: Type.String(),
  },
  { additionalProperties: true },
);

const SessionInfoSchema = Type.Object({
  sessionId: Type.String(),
  sessionFile: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  cwd: Type.String(),
  reason: Type.String(),
  leafId: Type.Union([Type.String(), Type.Null()]),
  model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
  thinkingLevel: Type.Optional(Type.String()),
  mode: Type.Union([Type.Literal("tui"), Type.Literal("rpc")]),
});

const StatusInfoSchema = Type.Object({
  leafId: Type.Union([Type.String(), Type.Null()]),
  busy: Type.Boolean(),
  pending: Type.Boolean(),
  contextUsage: Type.Optional(
    Type.Object({ tokens: Type.Number(), contextWindow: Type.Number(), percent: Type.Number() }),
  ),
  costUsd: Type.Optional(Type.Number()),
  subagentCostUsd: Type.Optional(Type.Number()),
});

const FleetRowSchema = Type.Object({
  runId: Type.String(),
  label: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  status: Type.String(),
  phaseLabel: Type.String(),
  parentRunId: Type.Optional(Type.String()),
  elapsedMs: Type.Number(),
  phaseMs: Type.Number(),
  costUsd: Type.Optional(Type.Number()),
  toolTrail: Type.Optional(Type.String()),
  streamLine: Type.Optional(Type.String()),
  highlight: Type.Union([Type.Literal("none"), Type.Literal("warn"), Type.Literal("crit")]),
  terminal: Type.Boolean(),
});

const PromptSchema = Type.Object({
  kind: Type.String(),
  title: Type.Optional(Type.String()),
  since: Type.Number(),
});

const InflightSchema = Type.Object({
  message: Type.Optional(WireMessageSchema),
  tools: Type.Array(
    Type.Object({
      toolCallId: Type.String(),
      toolName: Type.String(),
      args: Type.Unknown(),
      partial: Type.Optional(Type.String()),
    }),
  ),
});

const ProtoSchema = Type.Object({ major: Type.Integer(), minor: Type.Integer() });

// --- agent→hub frames ---

const HelloSchema = Type.Object({
  t: Type.Literal("hello"),
  proto: ProtoSchema,
  pluginVersion: Type.String(),
  buildId: Type.String(),
  agentId: Type.Object({
    pid: Type.Integer(),
    nonce: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }), // base64url, 16–64 chars
  }),
  epoch: Type.String(),
  kind: Type.Union([Type.Literal("tui"), Type.Literal("rpc")]),
  ticket: Type.Optional(Type.String()),
  launcher: Type.Tuple([Type.String(), Type.String()]),
  cwd: Type.String(),
  caps: Type.Array(Type.String()),
});

const ByeSchema = Type.Object({ t: Type.Literal("bye"), reason: Type.String() });

const SessionFrameSchema = Type.Object({ t: Type.Literal("session"), ...SessionInfoSchema.properties });

const SessionDetachedSchema = Type.Object({ t: Type.Literal("session_detached"), reason: Type.String() });

const EvSchema = Type.Object({
  t: Type.Literal("ev"),
  seq: Type.Integer(),
  e: WireEventSchema,
});

const StatusFrameSchema = Type.Object({ t: Type.Literal("status"), ...StatusInfoSchema.properties });

const FleetFrameSchema = Type.Object({
  t: Type.Literal("fleet"),
  runs: Type.Array(FleetRowSchema),
});

const SnapshotReplySchema = Type.Object({
  t: Type.Literal("snapshot_reply"),
  rid: Type.String(),
  seq: Type.Integer(),
  leafId: Type.Union([Type.String(), Type.Null()]),
  sessionFile: Type.Optional(Type.String()),
  recent: Type.Array(Type.Object({ seq: Type.Integer(), message: WireMessageSchema })),
  inflight: Type.Optional(InflightSchema),
  prompts: Type.Array(PromptSchema),
  status: StatusInfoSchema,
  fleet: Type.Array(FleetRowSchema),
});

const BranchReplySchema = Type.Object({
  t: Type.Literal("branch_reply"),
  rid: Type.String(),
  entries: Type.Array(WireEntrySchema),
  truncated: Type.Boolean(),
});

const GapSchema = Type.Object({ t: Type.Literal("gap"), fromSeq: Type.Integer() });
const PingSchema = Type.Object({ t: Type.Literal("ping"), ts: Type.Number() });
const PongSchema = Type.Object({ t: Type.Literal("pong"), ts: Type.Number() });

// --- hub→agent frames ---

const HelloAckSchema = Type.Object({
  t: Type.Literal("hello_ack"),
  hubVersion: Type.String(),
  buildId: Type.String(),
  proto: ProtoSchema,
  agentKey: Type.String(),
  pingMs: Type.Number(),
  leaseMs: Type.Number(),
  http: Type.Object({ port: Type.Integer() }),
});

const HelloRejectSchema = Type.Object({
  t: Type.Literal("hello_reject"),
  code: Type.Union([Type.Literal("E_PROTO"), Type.Literal("E_BAD_HELLO"), Type.Literal("E_TICKET")]),
  message: Type.String(),
  retryAfterMs: Type.Number(),
});

const SnapshotReqSchema = Type.Object({ t: Type.Literal("snapshot_req"), rid: Type.String() });

const BranchReqSchema = Type.Object({
  t: Type.Literal("branch_req"),
  rid: Type.String(),
  maxBytes: Type.Number(),
});

const agentFrameSchemas: Readonly<Record<string, TObject>> = {
  hello: HelloSchema,
  bye: ByeSchema,
  session: SessionFrameSchema,
  session_detached: SessionDetachedSchema,
  ev: EvSchema,
  status: StatusFrameSchema,
  fleet: FleetFrameSchema,
  snapshot_reply: SnapshotReplySchema,
  branch_reply: BranchReplySchema,
  gap: GapSchema,
  ping: PingSchema,
  pong: PongSchema,
};

const hubFrameSchemas: Readonly<Record<string, TObject>> = {
  hello_ack: HelloAckSchema,
  hello_reject: HelloRejectSchema,
  snapshot_req: SnapshotReqSchema,
  branch_req: BranchReqSchema,
  ping: PingSchema,
  pong: PongSchema,
};

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

/** Parse an agent→hub frame; unknown/invalid/oversized frames return undefined (ignored). */
export function decodeAgentFrame(raw: unknown): AgentFrame | undefined {
  return decodeWith(agentFrameSchemas, raw) as AgentFrame | undefined;
}

/** Parse a hub→agent frame; unknown/invalid/oversized frames return undefined (ignored). */
export function decodeHubFrame(raw: unknown): HubFrame | undefined {
  return decodeWith(hubFrameSchemas, raw) as HubFrame | undefined;
}

function decodeWith(schemas: Readonly<Record<string, TObject>>, raw: unknown): object | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (!withinFrameBudget(raw)) return undefined;
  const t = (raw as Record<string, unknown>)["t"];
  if (typeof t !== "string") return undefined;
  const schema = schemas[t];
  if (schema === undefined) return undefined; // unknown t + RESERVED_FRAME_TYPES
  return Value.Check(schema, raw) ? (raw as object) : undefined;
}

/** Total-size guard: serialized length must stay within the ndjson frame budget. */
function withinFrameBudget(raw: unknown): boolean {
  try {
    return JSON.stringify(raw).length <= MAX_FRAME_BYTES;
  } catch {
    return false; // circular / unserializable
  }
}
