import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ContextUsageInfo,
  DriverEvent,
  KillableHandle,
  RunOutcome,
  SessionSpec,
  UsageDelta,
} from "../core/types.js";

export type { KillableHandle, SessionSpec } from "../core/types.js";

/**
 * child-context-switch plan P0 (§2.1 step 2 `details.source` / §2.3.1): the
 * marker a boundary-draft compaction entry carries in `details.source` so
 * this driver (and `PiSessionHandle.getSwitchTail()` below) can recognize
 * "this compaction is OUR committed switch_context, not pi's own summary or
 * another extension's". Owned here (not by the — separately owned —
 * boundary-draft builder) because both the entry_appended mapping in
 * `mapEvent` and `getSwitchTail()` need the exact same literal; other
 * packages import it rather than re-declaring the string.
 */
export const CHILD_SWITCH_CONTEXT_SOURCE = "pi-toolkit:switch_context";
/** child-context-switch plan P0 (§2.3.1 point 1): customType of the entry the child-session extension appends at `agent_end` when a committed switch was never followed by a subsequent model request. */
export const CHILD_SWITCH_SELFCHECK_CUSTOM_TYPE = "subagent:switch-selfcheck";
/** child-context-switch plan §3.1 (point 4): customType of the entry the capability state machine (owned by a later package) appends on a disablement/other non-fatal capability notice. */
export const CHILD_SWITCH_CAPABILITY_CUSTOM_TYPE = "subagent:switch-capability";
/** child-context-switch plan P3 acceptance follow-up (§2.3.1 V1-V6 visibility gap): customType of the entry the child-session extension appends (owned by a later package) whenever a switch_context call is structurally rejected (V1-V6, "unpersisted") or fails a non-disabling post-verified self-check recheck ("uncommitted") — additive diagnostic, never affects this run's outcome. */
export const CHILD_SWITCH_REJECTED_CUSTOM_TYPE = "subagent:switch-rejected";
/** child-context-switch plan §2.4 ("成本计入子 run"): customType of the child keepalive service's audit entries (owned by a later package). Only entries with a positive `costUsd` fold into this run's usage accumulator. */
export const CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE = "subagent:cache-keepalive";
export interface DisposeReport {
  returned: boolean;
  error?: RunOutcome["error"];
  killed: number;
  unkillable: ReadonlyArray<{ kind: string; id: string }>;
}
export interface SessionHandle {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  requestAbort(): Promise<void>;
  dispose(): DisposeReport;
  readonly killableHandles: ReadonlySet<KillableHandle>;
  setActiveTools(names: string[]): void;
  getActiveTools(): string[];
  getLastAssistantText(): string | undefined;
  getTurnError?(): string | undefined;
  /** M-B2: the session's *actual* model (ground truth — covers runs with no spawn-time override/type default). */
  getModelRef?(): { provider: string; id: string } | undefined;
  /** set_model: switch this live session's model. `model` is an opaque pi Model
   *  (resolved by the driver — core/service layers never see pi types, I1).
   *  Rejects when pi refuses the switch (e.g. no auth for the provider). */
  setModel?(model: unknown): Promise<void>;
  /** Current thinking level ("off" | "low" | …), when the driver exposes one. */
  getThinkingLevel?(): string | undefined;
  /** Apply a thinking level; pi clamps it to the model's capabilities. */
  setThinkingLevel?(level: string): void;
  getUsage(): RunOutcome["usage"];
  /**
   * child-context-switch plan P0 (§2.3.1 v3.1, runner settlement fallback):
   * synchronous, read-only check of the current branch for the LAST
   * committed boundary-draft switch_context compaction (identified by
   * `details.source === CHILD_SWITCH_CONTEXT_SOURCE`), and whether any
   * assistant message entry follows it. Used as a fallback self-check that
   * does not depend on `agent_end` firing, `appendEntry` succeeding, or the
   * event being forwarded through `bind()` — only on pi's own persisted
   * branch. Returns `undefined` when no such compaction exists on the
   * branch at all (no switch was ever committed in this run; the self-check
   * does not apply and must not affect settlement).
   */
  getSwitchTail?(): { seq: number; entryId: string; assistantAfter: boolean } | undefined;
}
export interface SessionDriver {
  create(spec: SessionSpec): Promise<SessionHandle>;
  /** Optional X2 path; runners fall back to create only for fresh sessions. */
  resume?(sessionFile: string, spec: SessionSpec): Promise<SessionHandle>;
  bind(h: SessionHandle, onEvent: (e: DriverEvent) => void): Promise<void>;
  onLateArrival(p: Promise<SessionHandle>, cb: (h: SessionHandle) => void): void;
  /** set_model: {provider,id} → opaque pi Model for a mid-run switch (create() resolves the same way). */
  resolveModelRef?(provider: string, id: string): unknown | undefined;
}

/**
 * Map pi's Usage (pi-ai) to our UsageDelta at this anti-corruption boundary.
 * pi carries cost as a nested `cost.total`; UsageDelta wants a flat `costUsd`.
 * Passing the raw object through leaves `costUsd` undefined, and
 * `base.costUsd + undefined` poisons the lifetime accumulator with NaN
 * (observed in the wild: the fleet widget rendered "$NaN"). Every field is
 * clamped to a finite number so a missing/NaN provider field can never
 * corrupt the sum.
 */
function mapUsage(u: unknown): UsageDelta | undefined {
  if (!u || typeof u !== "object") return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const r = u as Record<string, unknown>;
  const cost = r["cost"] as { total?: unknown } | undefined;
  return {
    input: num(r["input"]),
    output: num(r["output"]),
    cacheRead: num(r["cacheRead"]),
    cacheWrite: num(r["cacheWrite"]),
    costUsd: num(cost?.total),
  };
}

export function mapContextUsage(u: unknown): ContextUsageInfo | undefined {
  if (!u || typeof u !== "object") return undefined;
  const r = u as Record<string, unknown>;
  const contextWindow = r["contextWindow"];
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const nullableNumber = (value: unknown, predicate: (n: number) => boolean): number | null =>
    value === null || (typeof value === "number" && Number.isFinite(value) && predicate(value))
      ? (value as number | null)
      : null;
  const tokens = nullableNumber(r["tokens"], (n) => n >= 0);
  const rawPercent = nullableNumber(r["percent"], () => true);
  return {
    contextWindow,
    tokens,
    percent: rawPercent === null ? null : Math.min(100, Math.max(0, rawPercent)),
  };
}

function errorInfo(error: unknown): NonNullable<RunOutcome["error"]> {
  const e = error instanceof Error ? error : new Error(String(error));
  return { kind: "internal", message: e.message, ...(e.stack ? { stack: e.stack } : {}), retryable: false };
}
/**
 * M-A: single-line, truncated preview of a tool call's arguments for the
 * live trail UI. Picks the most informative scalar (bash command, file path,
 * pattern…) and falls back to compact JSON. Display-only — never fed back to
 * a model — and hard-capped so a huge prompt/file body cannot bloat diag.
 */
export function previewToolArgs(args: unknown, max = 80): string | undefined {
  if (args === null || args === undefined) return undefined;
  let text: string;
  if (typeof args === "string") text = args;
  else if (typeof args === "object") {
    const r = args as Record<string, unknown>;
    const preferred = ["command", "path", "file_path", "pattern", "query", "description", "prompt", "url"];
    const key = preferred.find((k) => typeof r[k] === "string" && (r[k] as string).length > 0);
    if (key) text = r[key] as string;
    else {
      try {
        text = JSON.stringify(r) ?? "";
      } catch {
        return undefined;
      }
    }
  } else text = String(args);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * X12: collect the tracked-run ids a toolResult message's `details` carries:
 * `runId` (nested Agent blocking result / get_subagent_result), `runIds`
 * (SubagentWorkflow batch results) and `consultRunId` (consult tool result).
 * Purely structural — no pi types, defensive against host shapes. Returns
 * undefined when nothing recognizable is present (the common case: assistant
 * message_ends and usage-less toolResults).
 */
export function toolResultRunIds(message: unknown): readonly string[] | undefined {
  const m = message as { role?: unknown; details?: unknown } | undefined;
  if (!m || m.role !== "toolResult") return undefined;
  const det = m.details as { runId?: unknown; runIds?: unknown; consultRunId?: unknown } | undefined;
  if (!det || typeof det !== "object") return undefined;
  const ids: string[] = [];
  if (typeof det.runId === "string" && det.runId !== "") ids.push(det.runId);
  if (typeof det.consultRunId === "string" && det.consultRunId !== "") ids.push(det.consultRunId);
  if (Array.isArray(det.runIds)) for (const r of det.runIds) if (typeof r === "string" && r !== "") ids.push(r);
  return ids.length > 0 ? ids : undefined;
}

/**
 * child-context-switch plan P0 (§2.1 step 2 / §2.3.1 point 4 / §2.4): map a
 * raw pi `entry_appended` SessionEntry onto the (at most one) DriverEvent it
 * carries for this plan. All three shapes recognized here are written by
 * OTHER packages' child-session extensions (the boundary-draft turn_end
 * handler, the capability state machine, the child keepalive service) — this
 * function is pure structural recognition, defensive against any other
 * entry shape (unrelated custom entries, plain compactions, …), which it
 * passes through as `undefined` (no event).
 */
function mapEntryAppended(entry: unknown): DriverEvent | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const r = entry as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  if (r["type"] === "compaction" && r["fromHook"] === true) {
    const details = r["details"] as Record<string, unknown> | undefined;
    if (details?.["source"] !== CHILD_SWITCH_CONTEXT_SOURCE) return undefined;
    const dropped = details["dropped"] as Record<string, unknown> | undefined;
    return {
      t: "context_switch",
      seq: num(details["seq"]),
      keepRecent: Boolean(details["keepRecent"]),
      dropped: {
        fromEntryId: str(dropped?.["fromEntryId"]),
        toEntryId: str(dropped?.["toEntryId"]),
        entries: num(dropped?.["entries"]),
        tokensBefore: num(dropped?.["tokensBefore"]),
        tokensAfterEstimate: num(dropped?.["tokensAfterEstimate"]),
      },
    };
  }
  if (r["type"] !== "custom") return undefined;
  const data = r["data"] as Record<string, unknown> | undefined;
  if (r["customType"] === CHILD_SWITCH_SELFCHECK_CUSTOM_TYPE) {
    if (data?.["ok"] !== false) return undefined;
    return { t: "switch_selfcheck_failed", reason: str(data["reason"]) || "unknown" };
  }
  if (r["customType"] === CHILD_SWITCH_CAPABILITY_CUSTOM_TYPE) {
    return { t: "switch_capability", reason: str(data?.["reason"]) || "unknown" };
  }
  if (r["customType"] === CHILD_SWITCH_REJECTED_CUSTOM_TYPE) {
    return { t: "context_switch_rejected", reason: str(data?.["reason"]) || "unknown" };
  }
  if (r["customType"] === CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE) {
    const costUsd = data?.["costUsd"];
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd <= 0) return undefined;
    return {
      t: "message_end",
      usage: {
        input: 0,
        output: 0,
        cacheRead: num(data?.["cacheReadTokens"]),
        cacheWrite: num(data?.["cacheWriteTokens"]),
        costUsd,
      },
    };
  }
  return undefined;
}

function mapEvent(e: any): DriverEvent | undefined {
  if (!e || typeof e.type !== "string") return undefined;
  const t = e.type;
  if (t === "turn_start") return { t: "turn_start" };
  if (t === "turn_end") return { t: "turn_end", toolResults: Array.isArray(e.toolResults) ? e.toolResults.length : 0 };
  if (t === "message_end") {
    // exactOptionalPropertyTypes: omit `usage` entirely when absent.
    const usage = mapUsage(e.message?.usage);
    // X12: pi emits message_end for toolResult messages too (agent-core
    // tool-placement.js); a *usage-bearing* one carries some nested run's
    // spend INTO this run's X9 accumulator, and its `details` name the run(s)
    // (nested Agent / get_subagent_result: runId; workflow batch: runIds;
    // consult: consultRunId). Extract those ids so cost consumers can skip
    // the nested runs instead of double-counting them. Gated on usage: a
    // background-spawn ack (or a "still running" poll) references a run whose
    // spend is NOT yet inside the parent — absorbing it would under-count.
    const absorbedRunIds = usage ? toolResultRunIds(e.message) : undefined;
    return {
      t: "message_end",
      ...(usage ? { usage } : {}),
      ...(absorbedRunIds === undefined ? {} : { absorbedRunIds }),
    };
  }
  if (t === "tool_execution_start") {
    const argsPreview = previewToolArgs(e.args);
    return {
      t: "tool_start",
      toolCallId: String(e.toolCallId),
      toolName: String(e.toolName),
      ...(argsPreview === undefined ? {} : { argsPreview }),
    };
  }
  if (t === "tool_execution_end")
    return {
      t: "tool_end",
      toolCallId: String(e.toolCallId),
      toolName: String(e.toolName),
      isError: Boolean(e.isError),
    };
  if (t === "tool_execution_update") return { t: "tool_update", toolCallId: String(e.toolCallId) };
  if (t === "auto_retry_start")
    return {
      t: "retry_start",
      attempt: Number(e.attempt),
      maxAttempts: Number(e.maxAttempts),
      delayMs: Number(e.delayMs),
    };
  if (t === "auto_retry_end") return { t: "retry_end", success: Boolean(e.success) };
  if (t === "compaction_start") return { t: "compaction_start", reason: String(e.reason) };
  if (t === "compaction_end") {
    const aborted = Boolean(e.aborted);
    // child-context-switch plan P0 (§2.3.1): pi's own compaction failed
    // (threshold summarization error, overflow compact-and-retry exhausted,
    // …) iff it carries a non-empty errorMessage and was not aborted — an
    // aborted compaction is a cancellation, not a failure, even if pi also
    // happened to set errorMessage on it. `bind()` below emits the companion
    // `compaction_failed` diagnostic event only in this exact case.
    const hasError = typeof e.errorMessage === "string" && e.errorMessage.length > 0;
    return { t: "compaction_end", aborted, ...(hasError && !aborted ? { failed: true as const } : {}) };
  }
  if (t === "agent_settled") return { t: "settled" };
  if (t === "entry_appended") return mapEntryAppended(e.entry);
  if (t === "message_update") {
    // pi streams token-by-token via assistantMessageEvent (pi-ai
    // AssistantMessageEvent): text_delta carries answer text, thinking_delta
    // carries the reasoning stream — the agent tree's `»` preview line feeds
    // on both. The assistant message's own `content` is a block array
    // (TextContent | ThinkingContent | ToolCall), never a string, so reading
    // deltas off `message` directly sees nothing.
    const ae = e.assistantMessageEvent;
    if (ae?.type === "thinking_delta" && typeof ae.delta === "string") return { t: "thinking_delta", delta: ae.delta };
    if (ae?.type === "text_delta" && typeof ae.delta === "string") return { t: "text_delta", delta: ae.delta };
    // Legacy fallback: non-assistant messages (e.g. user) can carry a plain
    // string content.
    if (typeof e.message?.content === "string") return { t: "text_delta", delta: e.message.content };
    return undefined;
  }
  return undefined;
}

class PiSessionHandle implements SessionHandle {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly killableHandles = new Set<KillableHandle>();
  constructor(public readonly session: AgentSession) {
    this.sessionId = session.sessionId;
    this.sessionFile = session.sessionFile;
  }
  prompt(text: string) {
    return this.session.prompt(text).catch((e: unknown) => {
      throw explainPromptRejection(this.session, e);
    });
  }
  steer(text: string) {
    return this.session.steer(text);
  }
  requestAbort() {
    this.session.abort();
    return Promise.resolve();
  }
  dispose(): DisposeReport {
    try {
      this.session.dispose();
      return { returned: true, killed: 0, unkillable: [] };
    } catch (e) {
      return { returned: false, error: errorInfo(e), killed: 0, unkillable: [] };
    }
  }
  setActiveTools(names: string[]) {
    this.session.setActiveToolsByName(names);
  }
  getActiveTools() {
    return this.session.getActiveToolNames();
  }
  getLastAssistantText() {
    return this.session.getLastAssistantText();
  }
  /** M-B2: read the actual model off the live session (post-create, so pi's
   *  own default-model selection is reflected even when the spawn request
   *  carried no override and the agent type declared no model). */
  getModelRef(): { provider: string; id: string } | undefined {
    const m = this.session.model as { provider?: unknown; id?: unknown } | undefined;
    return typeof m?.provider === "string" && typeof m?.id === "string"
      ? { provider: m.provider, id: m.id }
      : undefined;
  }
  /** pi resolves prompt() even when the final turn died (stopReason
   *  "error", e.g. provider crash) — without this check a dead turn looks
   *  like an empty success. Surface it so the run becomes failed(model).
   *
   *  child-context-switch plan P3 acceptance follow-up (T-F1/T-F2/T-F3): pi's own
   *  `_omitRecoveryAttempt` (agent-session.js, `_checkCompaction`'s overflow branch) splices the
   *  erroring assistant message OUT of the LIVE `session.messages` — via a `context_edit`
   *  targeting it with `replacement: null` — on the run's FIRST-ever context-overflow occurrence,
   *  unconditionally, regardless of whether the recovery compaction it triggers then succeeds or
   *  fails. When that recovery does NOT end in a retried request (prepareCompaction empty, the
   *  summarization call itself throws, or the model is unset), NOTHING ever replaces the omitted
   *  message, so the live-messages scan below finds no error at all and the run would otherwise
   *  look like an empty success (a leftover in-progress `toolUse` message earlier in the live
   *  array would be found first and treated as a NON-error — the omitted error itself is simply
   *  gone). The persisted BRANCH (unlike the live projection) still carries both the original
   *  message and the very `context_edit` that omitted it — read-only, never mutated here — so
   *  this fallback (checked FIRST, see its own doc comment for why that ordering is safe) recovers
   *  exactly that one failure mode without touching any other behavior. */
  getTurnError(): string | undefined {
    const omitted = this.getOmittedOverflowTurnError();
    if (omitted !== undefined) return omitted;
    for (let i = this.session.messages.length - 1; i >= 0; i--) {
      const m = this.session.messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
      if (m?.role === "assistant")
        return m.stopReason === "error" ? (m.errorMessage ?? "unknown model error") : undefined;
    }
    return undefined;
  }
  /** See `getTurnError()`'s doc comment: the fallback for a first-and-only, never-retried
   *  overflow whose erroring message `_omitRecoveryAttempt` spliced out of `session.messages`.
   *  Checked FIRST (not as a last resort) because the persisted branch's LAST entry being exactly
   *  this `context_edit` is unambiguous proof that nothing else happened afterwards — a
   *  successful compact-and-retry (T-F1's working case) always appends a compaction entry and a
   *  fresh message AFTER it, so the branch tail would no longer match this narrow shape and this
   *  helper correctly returns `undefined`, deferring to the live-messages scan below. Synchronous,
   *  read-only branch scan — same style as `getSwitchTail()` above. */
  private getOmittedOverflowTurnError(): string | undefined {
    let branch: readonly Record<string, unknown>[];
    try {
      branch = this.session.sessionManager.getBranch() as unknown as readonly Record<string, unknown>[];
    } catch {
      return undefined;
    }
    if (!Array.isArray(branch) || branch.length === 0) return undefined;
    const last = branch[branch.length - 1];
    if (last?.["type"] !== "context_edit" || last["replacement"] !== null) return undefined;
    const targetId = last["targetId"];
    if (typeof targetId !== "string") return undefined;
    const target = branch.find((entry) => entry["id"] === targetId);
    const message = target?.["message"] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
    if (target?.["type"] !== "message" || message?.role !== "assistant" || message.stopReason !== "error")
      return undefined;
    return typeof message.errorMessage === "string" && message.errorMessage.length > 0
      ? message.errorMessage
      : "unknown model error";
  }
  getUsage() {
    return undefined;
  }
  /**
   * child-context-switch plan P0 (§2.3.1 v3.1): see the SessionHandle
   * interface doc above. `getBranch()` returns entries in persisted (root
   * to leaf) order, so the LAST matching compaction on the branch is the
   * most recent one; scanning forward from just after it for an assistant
   * `message` entry decides `assistantAfter`.
   */
  getSwitchTail(): { seq: number; entryId: string; assistantAfter: boolean } | undefined {
    const branch = this.session.sessionManager.getBranch() as unknown as ReadonlyArray<Record<string, unknown>>;
    if (!Array.isArray(branch)) return undefined;
    let foundIndex = -1;
    let foundEntry: Record<string, unknown> | undefined;
    for (let i = 0; i < branch.length; i++) {
      const entry = branch[i];
      const details = entry?.["details"] as Record<string, unknown> | undefined;
      if (
        entry?.["type"] === "compaction" &&
        entry["fromHook"] === true &&
        details?.["source"] === CHILD_SWITCH_CONTEXT_SOURCE
      ) {
        foundIndex = i;
        foundEntry = entry;
      }
    }
    if (foundIndex < 0 || !foundEntry) return undefined;
    const details = foundEntry["details"] as Record<string, unknown> | undefined;
    const seq = typeof details?.["seq"] === "number" ? (details["seq"] as number) : 0;
    const entryId = typeof foundEntry["id"] === "string" ? (foundEntry["id"] as string) : "";
    let assistantAfter = false;
    for (let i = foundIndex + 1; i < branch.length; i++) {
      const e2 = branch[i];
      const message = e2?.["message"] as { role?: unknown } | undefined;
      if (e2?.["type"] === "message" && message?.role === "assistant") {
        assistantAfter = true;
        break;
      }
    }
    return { seq, entryId, assistantAfter };
  }
  /** set_model: thin wrappers, same style as steer/getModelRef above. */
  setModel(model: unknown) {
    return this.session.setModel(model as never);
  }
  getThinkingLevel(): string | undefined {
    return this.session.thinkingLevel as string | undefined;
  }
  setThinkingLevel(level: string) {
    this.session.setThinkingLevel(level as never);
  }
}

/**
 * prompt() rejected (pi throws before the turn, e.g. `No API key found for
 * <provider>.`). The spawn path resolves the requested model against the HOST
 * process's registry, but createAgentSession builds a fresh model runtime from
 * models.json for every child session (sdk: `options.modelRuntime ??
 * ModelRuntime.create(...)`). When models.json changed after pi started (a
 * provider rename), the host still resolves the old name while the child does
 * not know it — name that divergence instead of leaving only pi's auth hint.
 * Rejection-path only: never alters a successful prompt.
 */
export function explainPromptRejection(session: unknown, e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  try {
    const s = session as {
      model?: { provider?: unknown; id?: unknown };
      modelRuntime?: { getModel?: (provider: string, id: string) => unknown };
    };
    const provider = s.model?.provider;
    const id = s.model?.id;
    const getModel = s.modelRuntime?.getModel;
    if (typeof provider !== "string" || typeof id !== "string" || typeof getModel !== "function") return err;
    if (getModel.call(s.modelRuntime, provider, id) !== undefined) return err;
    return new Error(
      `model "${provider}/${id}" is not in the child session's model registry (pi rebuilds it from models.json ` +
        `for each new session; this pi process's registry is stale — models.json changed since pi started? ` +
        `Use a provider/id from the current models.json; restart pi to refresh the host registry): ${err.message}`,
    );
  } catch {
    return err;
  }
}

export type ModelResolver = (provider: string, id: string) => unknown | undefined;

/**
 * Turn a SessionSpec into createAgentSession options. `systemPrompt`
 * (prompt_mode: replace types) is not a createAgentSession option: pi only
 * accepts a system prompt override through the resource loader. Build the
 * same loader createAgentSession would build by default (cwd, agentDir,
 * shared settingsManager) plus `systemPromptOverride`, so nothing else about
 * the child session changes (extensions, skills, AGENTS.md, APPEND_SYSTEM).
 */
export async function toCreateOptions(spec: SessionSpec, cwd: string): Promise<Record<string, unknown>> {
  const { systemPrompt, ...rest } = spec;
  if (!systemPrompt) return rest;
  const agentDir = rest.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPromptOverride: () => systemPrompt,
  });
  await resourceLoader.reload();
  return { ...rest, settingsManager, resourceLoader };
}

export class PiSessionDriver implements SessionDriver {
  constructor(
    private readonly rememberAgents = true,
    private readonly resolveModel?: ModelResolver,
  ) {}

  /** SessionSpec.model arrives as a {provider, id} pair; createAgentSession
   *  needs a real Model object from the registry. Passing the pair through
   *  crashes pi's provider call site (reading properties of undefined) and —
   *  worse — the session then settles with stopReason "error" and zero
   *  turns, looking like an empty success. Resolve eagerly and fail fast. */
  private withResolvedModel(spec: SessionSpec): SessionSpec {
    const m = spec.model as { provider?: unknown; id?: unknown } | undefined;
    if (m === undefined) return spec;
    if (typeof m.provider !== "string" || typeof m.id !== "string")
      throw new Error("model must be a {provider, id} pair");
    if (!this.resolveModel)
      throw new Error(`model override ${m.provider}/${m.id} requested but no model registry is wired`);
    const resolved = this.resolveModel(m.provider, m.id);
    if (!resolved)
      throw new Error(`unknown model: ${m.provider}/${m.id} (not in pi's model registry — check provider/auth)`);
    return { ...spec, model: resolved };
  }

  /** set_model: expose the constructor-wired registry resolver for mid-run
   *  switches (method name avoids clashing with the private field). */
  resolveModelRef(provider: string, id: string): unknown | undefined {
    return this.resolveModel?.(provider, id);
  }

  create(spec: SessionSpec) {
    const resolved = this.withResolvedModel(spec);
    const cwd = resolved.cwd ?? process.cwd();
    const persist = resolved.persist ?? this.rememberAgents;
    const sessionManager = persist ? SessionManager.create(cwd) : SessionManager.inMemory(cwd);
    return toCreateOptions(resolved, cwd)
      .then((options) =>
        createAgentSession({
          ...options,
          sessionManager,
          ...(persist ? {} : { persist: false }),
        } as Parameters<typeof createAgentSession>[0]),
      )
      .then(({ session }) => new PiSessionHandle(session));
  }
  resume(sessionFile: string, spec: SessionSpec) {
    const resolved = this.withResolvedModel(spec);
    const sessionManager = SessionManager.open(sessionFile, undefined, resolved.cwd);
    return toCreateOptions(resolved, resolved.cwd ?? sessionManager.getCwd())
      .then((options) => createAgentSession({ ...options, sessionManager } as Parameters<typeof createAgentSession>[0]))
      .then(({ session }) => new PiSessionHandle(session));
  }
  bind(h: SessionHandle, onEvent: (e: DriverEvent) => void) {
    const session = (h as PiSessionHandle)["session"];
    if (!session) return Promise.reject(new Error("invalid pi session handle"));
    let contextSamplingDisabled = false;
    session.subscribe((event: unknown) => {
      const mapped = mapEvent(event);
      if (!mapped) return;
      onEvent(mapped);
      // child-context-switch plan P0 (§2.3.1): pi's own compaction failing is
      // ALSO surfaced as a dedicated best-effort diagnostic event (in addition
      // to the `compaction_end{failed:true}` flag above), carrying the raw
      // reason/message pi gave us — never emitted for an aborted compaction.
      if (mapped.t === "compaction_end" && mapped.failed === true) {
        const raw = event as { errorMessage?: unknown; reason?: unknown };
        onEvent({
          t: "compaction_failed",
          reason: typeof raw.reason === "string" ? raw.reason : "unknown",
          message: typeof raw.errorMessage === "string" ? raw.errorMessage : "compaction failed",
        });
      }
      // §2.4: a committed switch_context rewrites the child session's context
      // just like a compaction does, so it gets the same post-event context
      // usage resample as message_end/compaction_end.
      if (
        (mapped.t !== "message_end" && mapped.t !== "compaction_end" && mapped.t !== "context_switch") ||
        contextSamplingDisabled
      )
        return;
      const getContextUsage = (session as { getContextUsage?: unknown }).getContextUsage;
      if (typeof getContextUsage !== "function") {
        contextSamplingDisabled = true;
        return;
      }
      try {
        const usage = mapContextUsage(getContextUsage.call(session));
        if (usage) onEvent({ t: "context_usage", usage });
      } catch {
        contextSamplingDisabled = true;
      }
    });
    return Promise.resolve();
  }
  onLateArrival(p: Promise<SessionHandle>, cb: (h: SessionHandle) => void) {
    p.then(cb, () => undefined).catch(() => undefined);
  }
}
export { mapEvent, PiSessionHandle };
