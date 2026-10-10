import { createHash } from "node:crypto";
import { PROVIDER_PREFIX_FIELDS, type PayloadPrefixComparison, type ProviderPrefixField } from "./preserve-identity.js";
export type { PayloadPrefixComparison, ProviderPrefixField } from "./preserve-identity.js";

/** A request observation retained by the process-local consult probe. */
export interface PrefixRequestRecord {
  seq: number;
  startedAt: number;
  endedAt?: number;
  fieldHashes: Partial<Record<ProviderPrefixField, string>>;
  messageHashes?: string[];
  breakpoints?: Array<{ msg: number; block: number; ttl?: string }>;
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number; costUsd: number };
  toolsDrift?: true;
  /** Full breakpoint values, hashed so cache_control fields other than ttl remain comparable. */
  breakpointHashes?: string[];
}

export interface RunPrefixRecord {
  runId: string;
  api?: string;
  provider?: string;
  model?: string;
  first?: PrefixRequestRecord;
  latest?: PrefixRequestRecord;
  /** Present only for C2 consult runs; ordinary child runs retain first/latest only. */
  requests?: PrefixRequestRecord[];
  /** Hashing is diagnostic-only; probe failures never affect the provider request. */
  probeErrors?: number;
}

export interface PrefixProbeRegistry {
  get(runId: string): RunPrefixRecord | undefined;
}

const REGISTRY_KEY = Symbol.for("pi-subagent:consult-prefix-probe");
const MAX_RUNS = 64;

type RegistryState = PrefixProbeRegistry & {
  records: Map<string, RunPrefixRecord>;
  order: string[];
};

type PrefixProbeSession = {
  agent?: { onPayload?: unknown };
  subscribe?: (listener: (event: unknown) => void) => () => void;
};

type PrefixProbeModel = { api?: unknown; provider?: unknown; id?: unknown };

type BodyRef = { record: PrefixRequestRecord; payload: unknown };

function registryState(): RegistryState {
  const root = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RegistryState };
  const existing = root[REGISTRY_KEY];
  if (
    existing &&
    existing.records instanceof Map &&
    Array.isArray(existing.order) &&
    typeof existing.get === "function"
  )
    return existing;
  const created: RegistryState = {
    records: new Map(),
    order: [],
    get(runId: string) {
      return registryState().records.get(runId);
    },
  };
  root[REGISTRY_KEY] = created;
  return created;
}

/** The process-local, bounded registry consumed by the consult instrumentation. */
export function getPrefixProbeRegistry(): PrefixProbeRegistry {
  return registryState();
}

function stableJson(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "cache_control") continue;
    copy[key] = withoutCacheControl(child);
  }
  return copy;
}

function cacheControlAt(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as { cache_control?: unknown }).cache_control;
}

function breakpointTtl(cacheControl: unknown): string | undefined {
  if (cacheControl !== null && typeof cacheControl === "object") {
    const ttl = (cacheControl as { ttl?: unknown }).ttl;
    if (typeof ttl === "string") return ttl;
  }
  return undefined;
}

function messageDetails(messages: unknown): {
  hashes?: string[];
  breakpoints?: Array<{ msg: number; block: number; ttl?: string }>;
  breakpointHashes?: string[];
} {
  if (!Array.isArray(messages)) return {};
  const hashes: string[] = [];
  const breakpoints: Array<{ msg: number; block: number; ttl?: string }> = [];
  const breakpointHashes: string[] = [];
  for (let msg = 0; msg < messages.length; msg++) {
    const message = messages[msg];
    hashes.push(hashJson(withoutCacheControl(message)));
    const content =
      message !== null && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) continue;
    for (let block = 0; block < content.length; block++) {
      const cacheControl = cacheControlAt(content[block]);
      if (cacheControl === undefined) continue;
      const point: { msg: number; block: number; ttl?: string } = { msg, block };
      const ttl = breakpointTtl(cacheControl);
      if (ttl !== undefined) point.ttl = ttl;
      breakpoints.push(point);
      breakpointHashes.push(hashJson(cacheControl));
    }
  }
  return { hashes, breakpoints, breakpointHashes };
}

function recordFieldHashes(
  payload: unknown,
  record: PrefixRequestRecord,
  state: ProbeState,
  includeMessages: boolean,
): void {
  if (payload === null || typeof payload !== "object") return;
  const object = payload as Record<string, unknown>;
  for (const field of PROVIDER_PREFIX_FIELDS) {
    if (field === "messages" && !includeMessages) continue;
    const value = object[field];
    if (value === undefined) continue;
    try {
      record.fieldHashes[field] = hashJson(field === "messages" ? withoutCacheControl(value) : value);
    } catch {
      state.error();
    }
  }
  if (includeMessages) {
    try {
      const details = messageDetails(object.messages);
      if (details.hashes !== undefined) record.messageHashes = details.hashes;
      if (details.breakpoints !== undefined) record.breakpoints = details.breakpoints;
      if (details.breakpointHashes !== undefined) record.breakpointHashes = details.breakpointHashes;
    } catch {
      state.error();
    }
  }
}

function finalizeBody(ref: BodyRef | undefined, state: ProbeState): void {
  if (ref === undefined) return;
  try {
    recordFieldHashes(ref.payload, ref.record, state, true);
  } catch {
    state.error();
  }
  state.latestBody = undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelInfo(model: unknown, payload: unknown): { api?: string; provider?: string; model?: string } {
  const m = model !== null && typeof model === "object" ? (model as PrefixProbeModel) : {};
  const body = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const api = text(m.api);
  const provider = text(m.provider);
  const id = text(m.id) ?? text(body.model);
  return {
    ...(api === undefined ? {} : { api }),
    ...(provider === undefined ? {} : { provider }),
    ...(id === undefined ? {} : { model: id }),
  };
}

class ProbeState {
  readonly record: RunPrefixRecord;
  readonly consult: boolean;
  seq = 0;
  pending: PrefixRequestRecord[] = [];
  latestBody: BodyRef | undefined;
  unsub: (() => void) | undefined;
  closed = false;

  constructor(record: RunPrefixRecord, consult: boolean) {
    this.record = record;
    this.consult = consult;
  }

  error(): void {
    this.record.probeErrors = (this.record.probeErrors ?? 0) + 1;
  }

  capture(payload: unknown, model: unknown, startedAt: number): void {
    if (this.closed) return;
    // For ordinary runs, the old latest body is no longer needed once a new
    // request starts. Consult requests are fully hashed at capture time.
    if (!this.consult) finalizeBody(this.latestBody, this);
    const request: PrefixRequestRecord = {
      seq: this.seq++,
      startedAt,
      fieldHashes: {},
    };
    recordFieldHashes(payload, request, this, this.consult);
    const previous = this.consult ? this.record.requests?.[0] : this.record.first;
    if (previous && !equalHash(previous.fieldHashes.tools, request.fieldHashes.tools)) request.toolsDrift = true;
    const info = modelInfo(model, payload);
    if (this.record.api === undefined && info.api !== undefined) this.record.api = info.api;
    if (this.record.provider === undefined && info.provider !== undefined) this.record.provider = info.provider;
    if (this.record.model === undefined && info.model !== undefined) this.record.model = info.model;
    if (this.record.first === undefined) this.record.first = request;
    if (this.consult) this.record.requests?.push(request);
    this.record.latest = request;
    this.pending.push(request);
    if (!this.consult) this.latestBody = { record: request, payload };
  }

  onEvent(event: unknown): void {
    if (event === null || typeof event !== "object") return;
    const e = event as { type?: unknown; message?: unknown };
    if (e.type === "agent_settled") {
      finalizeBody(this.latestBody, this);
      return;
    }
    if (e.type !== "message_end" || e.message === null || typeof e.message !== "object") return;
    const message = e.message as { role?: unknown; usage?: unknown };
    if (message.role !== "assistant") return;
    const request = this.pending.shift();
    if (request === undefined) return;
    request.endedAt = Date.now();
    const usage = message.usage;
    if (usage === null || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    const cost = u.cost;
    request.usage = {
      input: finite(u.input),
      cacheRead: finite(u.cacheRead),
      cacheWrite: finite(u.cacheWrite),
      output: finite(u.output),
      costUsd: finite(cost !== null && typeof cost === "object" ? (cost as { total?: unknown }).total : undefined),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.unsub?.();
    } catch {
      this.error();
    }
    this.unsub = undefined;
    finalizeBody(this.latestBody, this);
  }
}

function recordFor(runId: string, consult: boolean): RunPrefixRecord {
  const state = registryState();
  const prior = state.records.get(runId);
  if (prior !== undefined) {
    state.records.delete(runId);
    state.order = state.order.filter((id) => id !== runId);
  }
  const record: RunPrefixRecord = { runId, ...(consult ? { requests: [] } : {}) };
  state.records.set(runId, record);
  state.order.push(runId);
  while (state.order.length > MAX_RUNS) {
    const oldest = state.order.shift();
    if (oldest !== undefined) state.records.delete(oldest);
  }
  return record;
}

/**
 * Install the host-side probe on a freshly-created AgentSession. This is
 * intentionally structural so this pi-free module does not import pi types.
 * The returned cleanup is idempotent and releases the only retained latest
 * payload reference.
 */
export function installPrefixProbe(sessionValue: unknown, specValue?: unknown): () => void {
  const session = sessionValue as PrefixProbeSession | null | undefined;
  const agent = session?.agent;
  if (!agent || typeof agent !== "object") return () => undefined;
  const spec = specValue as { runId?: unknown; consultGuard?: unknown } | undefined;
  const runId = typeof spec?.runId === "string" && spec.runId.length > 0 ? spec.runId : "main";
  const consult = spec?.consultGuard !== undefined;
  const record = recordFor(runId, consult);
  const state = new ProbeState(record, consult);
  const original = agent.onPayload;
  agent.onPayload = async function (payload: unknown, model: unknown): Promise<unknown> {
    const startedAt = Date.now();
    const result =
      typeof original === "function"
        ? await (original as (payload: unknown, model: unknown) => unknown).call(this, payload, model)
        : undefined;
    const effective = result === undefined ? payload : result;
    try {
      state.capture(effective, model, startedAt);
    } catch {
      state.error();
    }
    // Returning the original result (including undefined) is essential: the
    // provider adapter treats undefined as "use the original payload".
    return result;
  };
  if (typeof session.subscribe === "function") {
    try {
      state.unsub = session.subscribe((event) => {
        try {
          state.onEvent(event);
        } catch {
          state.error();
        }
      });
    } catch {
      state.error();
    }
  }
  return () => state.close();
}

/** Alias kept for callers that describe this operation as wiring the probe. */
export const wirePrefixProbe = installPrefixProbe;

function equalHash(left: string | undefined, right: string | undefined): boolean {
  return left === undefined && right === undefined ? true : left !== undefined && right !== undefined && left === right;
}

function equalArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === undefined && right === undefined;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function breakpointComparison(expert: PrefixRequestRecord, consult: PrefixRequestRecord): boolean {
  const left = expert.breakpoints ?? [];
  const right = consult.breakpoints ?? [];
  if (stableJson(left) !== stableJson(right)) return false;
  if (expert.breakpointHashes !== undefined && consult.breakpointHashes !== undefined)
    return equalArray(expert.breakpointHashes, consult.breakpointHashes);
  return true;
}

/** Compare two stored records using exactly the frozen raw-payload field rules. */
export function compareRecordedPrefix(
  expertLast: PrefixRequestRecord,
  consultFirst: PrefixRequestRecord,
): PayloadPrefixComparison {
  const field = (name: ProviderPrefixField): boolean =>
    equalHash(expertLast.fieldHashes[name], consultFirst.fieldHashes[name]);
  const expertMessages = expertLast.messageHashes;
  const consultMessages = consultFirst.messageHashes;
  const messages =
    expertMessages !== undefined &&
    consultMessages !== undefined &&
    consultMessages.length >= expertMessages.length &&
    expertMessages.every((hash, index) => hash === consultMessages[index]) &&
    breakpointComparison(expertLast, consultFirst);
  return {
    model: field("model"),
    messages,
    tools: field("tools"),
    system: field("system"),
    thinking: field("thinking"),
    output_config: field("output_config"),
    tool_choice: field("tool_choice"),
    betas: field("betas"),
    temperature: field("temperature"),
    metadata: field("metadata"),
    fallbacks: field("fallbacks"),
    max_tokens: field("max_tokens"),
    stream: field("stream"),
  };
}
