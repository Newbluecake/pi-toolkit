import { types as utilTypes } from "node:util";
import { THINKING_LEVELS, type ThinkingLevel } from "../core/types.js";

/**
 * workflow-experts (docs/dev/workflow-experts/plan.md §4.1): strict
 * structural validation for `agent(prompt, opts?)`'s second argument.
 *
 * Two-phase design (D1): the worker (worker-source.ts, JS mirror of the
 * logic below) takes a *structural snapshot* of the script's raw opts
 * object — using `Reflect.ownKeys`/`Reflect.getOwnPropertyDescriptor` so no
 * getter is ever invoked (D3) — and sends only that snapshot's `values`
 * (already-safe primitives) plus a `{ unknownKeys, defect }` report over the
 * wire. It never `postMessage`s the original object. The host
 * (`snapshotAgentOpts` below) takes an *independent* snapshot of whatever
 * actually arrived (defense-in-depth against a forged/malformed envelope —
 * host.test.ts posts raw envelopes directly, bypassing the worker
 * entirely), and `validateAgentOpts` merges both reports (union of
 * unknownKeys, either side's defect wins) into one pass/fail verdict with a
 * host-generated error message (D1: "报错文案只在 host 生成一份").
 *
 * N1 (review, must hold): a `defect` on any known key's value (function,
 * symbol, or Proxy) means that value is NEVER placed into `values` — the whole snapshot short-circuits
 * with just the defect, exactly what stops the worker from ever attempting
 * to `postMessage` something `structuredClone` cannot carry. Wrong-*type*-
 * but-still-clonable values (`agentType: 123`, `label: {}`)
 * are NOT defects: they are captured verbatim in `values` (loosely typed —
 * `validateAgentOpts` does the real per-field `typeof` check, mirroring how
 * host.ts already re-checked `opts.model`/`opts.thinking` itself before
 * this module existed) and rejected with an ordinary `invalid_args` message
 * once `validateAgentOpts` runs.
 */

export const AGENT_OPTS_KEYS = ["label", "agentType", "phase", "fullResult", "model", "thinking", "isolation"] as const;
export type AgentOptsKey = (typeof AGENT_OPTS_KEYS)[number];

const AGENT_OPTS_KEY_SET: ReadonlySet<string> = new Set<string>(AGENT_OPTS_KEYS);

/** `bad_array` remains readable for legacy worker reports; no current snapshot produces it. */
export type OptsDefectCode = "not_plain_object" | "proxy" | "accessor" | "threw" | "bad_array";

export interface OptsDefect {
  readonly code: OptsDefectCode;
  /** The known key implicated, when applicable (absent for a top-level opts-shape defect). */
  readonly key?: string;
  /**
   * Extra human-readable context folded into the host-generated message
   * (e.g. `describeKind()`'s `typeof`-ish label for `not_plain_object`).
   * Not part of the cross-package frozen surface (§7 only freezes
   * `AGENT_OPTS_KEYS`) — purely cosmetic, safe to reshape later.
   */
  readonly detail?: string;
}

export interface OptsSnapshot {
  readonly values: Readonly<Partial<Record<AgentOptsKey, string | boolean | readonly string[]>>>;
  /** Symbol keys are rendered as `Symbol(desc)`. */
  readonly unknownKeys: readonly string[];
  readonly defect?: OptsDefect;
}

export interface ValidatedAgentOpts {
  readonly label?: string;
  readonly agentType?: string;
  readonly phase?: string;
  readonly fullResult?: boolean;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly isolation?: "worktree";
}

function isProxyValue(v: unknown): boolean {
  return typeof v === "object" && v !== null && utilTypes.isProxy(v as object);
}

/**
 * D2: a value that cannot safely be forwarded at all — a function/symbol
 * (never structured-cloneable) or a Proxy (reading it further would invoke
 * user-defined traps, exactly what D3 forbids). Returns which flavor, or
 * `undefined` when the value is safe to embed (any other JS type, including
 * plain objects/arrays/numbers/etc. — those are merely *wrong-typed*, not
 * unsafe, and are left for `validateAgentOpts`'s per-field check).
 */
function unsafeValueKind(v: unknown): "proxy" | "unclonable" | undefined {
  if (isProxyValue(v)) return "proxy";
  const t = typeof v;
  if (t === "function" || t === "symbol") return "unclonable";
  return undefined;
}

function describeKind(raw: unknown): string {
  if (raw === null) return "null";
  if (Array.isArray(raw)) return "array";
  if (typeof raw === "function") return "function";
  return typeof raw;
}

/**
 * D1-D6/D2 realm handling: `realmProtos` is every acceptable prototype for
 * the opts object itself (host default: `[Object.prototype, null]`; the
 * worker-side JS mirror passes both the scaffold's and the sandbox
 * (`vm.createContext`) realm's `Object.prototype`, plus `null` for
 * `Object.create(null)`).
 */
export function snapshotAgentOpts(
  raw: unknown,
  realmProtos: readonly (object | null)[] = [Object.prototype, null],
): OptsSnapshot {
  if (raw === undefined || raw === null) return { values: {}, unknownKeys: [] };
  if (isProxyValue(raw)) return { values: {}, unknownKeys: [], defect: { code: "proxy" } };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { values: {}, unknownKeys: [], defect: { code: "not_plain_object", detail: describeKind(raw) } };
  }
  let proto: object | null;
  try {
    proto = Reflect.getPrototypeOf(raw);
  } catch {
    return { values: {}, unknownKeys: [], defect: { code: "threw" } };
  }
  if (!realmProtos.includes(proto)) {
    return { values: {}, unknownKeys: [], defect: { code: "not_plain_object", detail: "unexpected prototype" } };
  }
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(raw);
  } catch {
    return { values: {}, unknownKeys: [], defect: { code: "threw" } };
  }
  const values: Record<string, unknown> = {};
  const unknownKeys: string[] = [];
  for (const key of keys) {
    const displayKey = typeof key === "symbol" ? `Symbol(${key.description ?? ""})` : key;
    const known = typeof key === "string" && AGENT_OPTS_KEY_SET.has(key);
    let desc: PropertyDescriptor | undefined;
    try {
      desc = Reflect.getOwnPropertyDescriptor(raw, key);
    } catch {
      return { values: {}, unknownKeys: [], defect: { code: "threw", key: displayKey } };
    }
    if (!desc) continue;
    if (desc.get || desc.set) {
      if (known) return { values: {}, unknownKeys: [], defect: { code: "accessor", key: displayKey } };
      unknownKeys.push(displayKey);
      continue;
    }
    if (!known) {
      unknownKeys.push(displayKey);
      continue;
    }
    const value = desc.value;
    if (value === undefined) continue; // D4/D5: an allowed key explicitly set to undefined counts as not passed.
    const keyName = key as AgentOptsKey;
    const unsafe = unsafeValueKind(value);
    if (unsafe) {
      return {
        values: {},
        unknownKeys: [],
        defect: { code: unsafe === "proxy" ? "proxy" : "not_plain_object", key: keyName },
      };
    }
    values[keyName] = value as string | boolean;
  }
  return { values: values as OptsSnapshot["values"], unknownKeys };
}

/** D7: mistaken-key → guidance, keyed by lowercase spelling (case-insensitive lookup in `validateAgentOpts`). */
export const AGENT_OPTS_HINTS: Readonly<Record<string, string>> = {
  subagent_type: "use agentType",
  agent_type: "use agentType",
  type: "use agentType",
  agent: "use agentType",
  description: "use label",
  name: "use label",
  effort: "use thinking ('off'|'low'|'medium'|'high')",
  reasoning: "use thinking ('off'|'low'|'medium'|'high')",
  reasoning_effort: "use thinking ('off'|'low'|'medium'|'high')",
  timeout_ms:
    "there is no per-call timeout — child runs are pinned to the workflow deadline; set SubagentWorkflow's timeout_s instead",
  timeout_s:
    "there is no per-call timeout — child runs are pinned to the workflow deadline; set SubagentWorkflow's timeout_s instead",
  timeout:
    "there is no per-call timeout — child runs are pinned to the workflow deadline; set SubagentWorkflow's timeout_s instead",
  timeoutms:
    "there is no per-call timeout — child runs are pinned to the workflow deadline; set SubagentWorkflow's timeout_s instead",
  schema: "structured output is not supported here — ask for JSON in the prompt and JSON.parse the result",
  resume: "resume is not supported here — use the Agent tool's resume instead",
  run_in_background: "agent() is already async — use parallel() for concurrency",
  background: "agent() is already async — use parallel() for concurrency",
  expert: "expert consultation has been removed; use message_agent to ask the parent agent",
  full_result: "use fullResult",
};

function hintFor(key: string): string | undefined {
  const lower = key.toLowerCase();
  const direct = AGENT_OPTS_HINTS[lower];
  if (direct) return direct;
  const realKey = AGENT_OPTS_KEYS.find((k) => k.toLowerCase() === lower);
  return realKey ? `did you mean ${realKey}` : undefined;
}

function unknownKeysMessage(keys: readonly string[]): string {
  const quoted = keys.map((k) => `"${k}"`).join(", ");
  const allowed = AGENT_OPTS_KEYS.join(", ");
  const hints = keys
    .map((k) => {
      const h = hintFor(k);
      return h ? `"${k}" → ${h}` : undefined;
    })
    .filter((s): s is string => s !== undefined);
  const hintTail = hints.length > 0 ? ` ${hints.join("; ")}.` : "";
  const removed = keys.includes("experts")
    ? "opts.experts is no longer supported; expert consultation has been removed. Use message_agent to ask the parent agent. "
    : "";
  return `${removed}agent(prompt, opts?): unknown option(s) ${quoted} — allowed: ${allowed}.${hintTail}`;
}

function defectMessage(defect: OptsDefect): string {
  switch (defect.code) {
    case "not_plain_object":
      return `agent(prompt, opts?): opts must be a plain object (got ${defect.detail ?? "an invalid value"})`;
    case "proxy":
      return defect.key
        ? `agent(prompt, opts?): opts.${defect.key} must not be a Proxy`
        : "agent(prompt, opts?): opts must not be a Proxy";
    case "accessor":
      return `agent(prompt, opts?): opts.${defect.key ?? "?"} must be a data property (accessors are not allowed)`;
    case "threw":
      return defect.key
        ? `agent(prompt, opts?): could not read opts.${defect.key} (reading it threw)`
        : "agent(prompt, opts?): opts could not be inspected (reading it threw)";
    case "bad_array":
      return "agent(prompt, opts?): opts.experts is no longer supported; expert consultation has been removed. Use message_agent to ask the parent agent.";
    default: {
      const _exhaustive: never = defect.code;
      return _exhaustive;
    }
  }
}

/**
 * D1: merges the host's own re-snapshot with the worker's structural report
 * (absent for a raw envelope posted with no report at all — host.test.ts's
 * direct-envelope harness, and any forged/legacy call) into one verdict.
 * Either side's `defect` wins outright (fail-closed); `unknownKeys` is the
 * union. Only once both are clear does per-field `typeof` validation run —
 * `model`/`thinking` keep their pre-existing exact wording (D6).
 */
export function validateAgentOpts(
  hostSnapshot: OptsSnapshot,
  workerReport?: { unknownKeys?: readonly string[]; defect?: OptsDefect },
): { ok: true; opts: ValidatedAgentOpts } | { ok: false; message: string } {
  const defect = hostSnapshot.defect ?? workerReport?.defect;
  if (defect) return { ok: false, message: defectMessage(defect) };

  const unknown = new Set<string>([...hostSnapshot.unknownKeys, ...(workerReport?.unknownKeys ?? [])]);
  if (unknown.size > 0) return { ok: false, message: unknownKeysMessage([...unknown]) };

  const v = hostSnapshot.values;
  if (v.label !== undefined && typeof v.label !== "string") {
    return { ok: false, message: "agent(prompt, opts?): opts.label must be a string" };
  }
  if (v.agentType !== undefined && typeof v.agentType !== "string") {
    return { ok: false, message: "agent(prompt, opts?): opts.agentType must be a string" };
  }
  if (v.phase !== undefined && typeof v.phase !== "string") {
    return { ok: false, message: "agent(prompt, opts?): opts.phase must be a string" };
  }
  if (v.fullResult !== undefined && typeof v.fullResult !== "boolean") {
    return { ok: false, message: "agent(prompt, opts?): opts.fullResult must be a boolean" };
  }
  if (v.model !== undefined && typeof v.model !== "string") {
    return { ok: false, message: "agent(prompt, opts?): opts.model must be a string" };
  }
  let thinking: ThinkingLevel | undefined;
  if (v.thinking !== undefined) {
    if (typeof v.thinking !== "string" || !THINKING_LEVELS.includes(v.thinking as ThinkingLevel)) {
      return {
        ok: false,
        message: "agent(prompt, opts?): opts.thinking must be one of 'off' | 'low' | 'medium' | 'high'",
      };
    }
    thinking = v.thinking as ThinkingLevel;
  }
  let isolation: "worktree" | undefined;
  if (v.isolation !== undefined) {
    if (v.isolation !== "worktree") {
      return { ok: false, message: 'agent(prompt, opts?): opts.isolation must be "worktree"' };
    }
    isolation = "worktree";
  }

  return {
    ok: true,
    opts: {
      ...(typeof v.label === "string" ? { label: v.label } : {}),
      ...(typeof v.agentType === "string" ? { agentType: v.agentType } : {}),
      ...(typeof v.phase === "string" ? { phase: v.phase } : {}),
      ...(typeof v.fullResult === "boolean" ? { fullResult: v.fullResult } : {}),
      ...(typeof v.model === "string" ? { model: v.model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
    },
  };
}
