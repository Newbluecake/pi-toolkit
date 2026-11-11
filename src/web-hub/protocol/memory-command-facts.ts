/** R1 display-only facts. Import-free so agent, hub and browser share identical bytes.
 * These observations NEVER authorize execution, retries, restoration or confirmation.
 * Canonical JSON sorts object keys recursively (arrays preserve order), with JSON.stringify
 * scalar spelling (U+2028/U+2029 escaped to keep the JSON on one display line). A malformed
 * appendix is rejected WHOLE; never salvage individual rows.
 */
export const MEMORY_RESULT_OPEN = "[pi-memory-result:v1]";
export const MEMORY_RESULT_CLOSE = "[/pi-memory-result]";
export const MEMORY_FACTS_LIMITS = Object.freeze({
  summaryBytes: 4096,
  jsonBytes: 16384,
  messageBytes: 24576,
  rowBytes: 768,
  rows: 16,
  cmdIdBytes: 256,
  targetIdBytes: 128,
  codeBytes: 48,
});

/** Closed mirrors, NOT imports: command-confirm.ts CommandErrorCode,
 * command-confirmed-step.ts E_MEM_EFFECT_UNKNOWN, scopes/session-store.ts E_MEM_PLAN_BUDGET,
 * jev/contracts.ts CommitActionResult. Audit/provider reason strings are deliberately NOT
 * accepted by this mapping. */
const DOMAIN_CODES = Object.freeze({
  E_MEM_CONFIRM_DECLINED: "E_COMMAND_DENIED",
  E_MEM_CONFIRM_TIMEOUT: "E_DEADLINE",
  E_MEM_CONFIRM_UNAVAILABLE: "E_COMMAND_DENIED",
  E_MEM_CONFIRM_STALE: "E_STALE_CTX",
  E_MEM_NEEDS_HUMAN_COMMAND: "E_COMMAND_DENIED",
  E_MEM_PLAN_CHANGED: "E_COMMAND_DENIED",
  E_MEM_BUSY: "E_RATE",
  E_MEM_EFFECT_UNKNOWN: "E_COMMAND_DENIED",
  E_MEM_PLAN_BUDGET: "E_DEADLINE",
  stale: "E_STALE_CTX",
  permission: "E_COMMAND_DENIED",
  gate: "E_COMMAND_DENIED",
  digest: "E_COMMAND_DENIED",
  unavailable: "E_COMMAND_DENIED",
  "post-apply-failure": "E_COMMAND_DENIED",
  "observation-mismatch": "E_COMMAND_DENIED",
  "finalization-failure": "E_COMMAND_DENIED",
} as const);
export type MemoryCommandDomainCode = keyof typeof DOMAIN_CODES;
export type MemoryCommandFailureCode = (typeof DOMAIN_CODES)[MemoryCommandDomainCode];
export type MemoryCommandEffect = "none" | "completed" | "partial" | "unknown";
export interface MemoryCommandFactRow {
  readonly step: number;
  readonly actionId?: string;
  readonly targetId?: string;
  readonly operation: "rewrite-single" | "merge-survivor" | "retire" | "expires" | "delete" | "keep";
  readonly outcome: "completed" | "rejected" | "skipped" | "unknown";
  readonly receipt: "not-consumed" | "consumed";
  readonly stage:
    "admission" | "plan" | "authorization" | "prepared" | "expected-after" | "data" | "finalize" | "review";
  readonly data: "not-called" | "not-applied" | "applied" | "unknown";
  readonly audit: "not-entered" | "io-possible" | "barrier-observed";
  readonly review: "unchanged" | "changed" | "unknown";
  readonly code?: MemoryCommandDomainCode;
}
export interface MemoryCommandFacts {
  readonly v: 1;
  readonly kind: "memory-flow";
  readonly cmdId: string;
  readonly effect: MemoryCommandEffect;
  readonly rows: readonly MemoryCommandFactRow[];
  readonly omitted: number | null;
}
export type ParsedMemoryCommandFacts =
  | { readonly kind: "legacy"; readonly summary: string }
  | { readonly kind: "invalid"; readonly effect: "unknown" }
  | { readonly kind: "facts"; readonly summary: string; readonly facts: MemoryCommandFacts };

/** Unrecognized codes get no domain label; they never become provider text in facts. */
export function memoryCommandFailureCode(code: unknown): MemoryCommandFailureCode | undefined {
  return typeof code === "string" && Object.hasOwn(DOMAIN_CODES, code)
    ? DOMAIN_CODES[code as MemoryCommandDomainCode]
    : undefined;
}

/** Exact UTF-8 length; ill-formed UTF-16 is NOT silently replaced with U+FFFD. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return Infinity;
      bytes += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) return Infinity;
    else bytes += 3;
  }
  return bytes;
}
function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && utf8Bytes(value) <= max;
}
function id(value: unknown, max: number): value is string {
  return boundedString(value, max) && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
/** Closed own data records only. Does not execute getters or toJSON. */
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) return;
  for (const key of keys) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) return;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, "value") || !d.enumerable) return;
    out[key] = d.value;
  }
  return required.every((key) => Object.hasOwn(out, key)) ? out : undefined;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
function row(value: unknown): MemoryCommandFactRow | undefined {
  const r = record(
    value,
    ["step", "operation", "outcome", "receipt", "stage", "data", "audit", "review"],
    ["actionId", "targetId", "code"],
  );
  if (!r || !Number.isSafeInteger(r.step) || (r.step as number) < 1 || (r.step as number) > 16) return;
  if (
    !oneOf(r.operation, ["rewrite-single", "merge-survivor", "retire", "expires", "delete", "keep"]) ||
    !oneOf(r.outcome, ["completed", "rejected", "skipped", "unknown"]) ||
    !oneOf(r.receipt, ["not-consumed", "consumed"]) ||
    !oneOf(r.stage, [
      "admission",
      "plan",
      "authorization",
      "prepared",
      "expected-after",
      "data",
      "finalize",
      "review",
    ]) ||
    !oneOf(r.data, ["not-called", "not-applied", "applied", "unknown"]) ||
    !oneOf(r.audit, ["not-entered", "io-possible", "barrier-observed"]) ||
    !oneOf(r.review, ["unchanged", "changed", "unknown"])
  )
    return;
  if (Object.hasOwn(r, "actionId") && (typeof r.actionId !== "string" || !/^[0-9a-f]{64}$/.test(r.actionId))) return;
  if (Object.hasOwn(r, "targetId") && !id(r.targetId, MEMORY_FACTS_LIMITS.targetIdBytes)) return;
  if (
    Object.hasOwn(r, "code") &&
    (!boundedString(r.code, MEMORY_FACTS_LIMITS.codeBytes) || memoryCommandFailureCode(r.code) === undefined)
  )
    return;
  const result: MemoryCommandFactRow = {
    step: r.step as number,
    operation: r.operation,
    outcome: r.outcome,
    receipt: r.receipt,
    stage: r.stage,
    data: r.data,
    audit: r.audit,
    review: r.review,
    ...(r.actionId === undefined ? {} : { actionId: r.actionId as string }),
    ...(r.targetId === undefined ? {} : { targetId: r.targetId as string }),
    ...(r.code === undefined ? {} : { code: r.code as MemoryCommandDomainCode }),
  };
  return consistentRow(result) && utf8Bytes(canonical(result)) <= MEMORY_FACTS_LIMITS.rowBytes ? result : undefined;
}

function uncertainCode(code: MemoryCommandDomainCode | undefined): boolean {
  return (
    code === "E_MEM_EFFECT_UNKNOWN" ||
    code === "post-apply-failure" ||
    code === "observation-mismatch" ||
    code === "finalization-failure"
  );
}

/** Closed terminal-row matrix, separate from aggregation. Unknown is an honest observation,
 * NOT a repair for a contradictory completed/refused row. E changes data, never review;
 * keep changes review, never enters E's audit/data path. Stages are last observations,
 * not proof that the named effect ran (a synchronous observer may revoke before it).
 *
 * E: pre-consume admission/plan/authorization => no effects; consumed authorization
 * still has no effects. Prepared can stop before entry, or become uncertain at/after
 * its barrier. Expected-after requires the prepared barrier. Data requires both
 * barriers; finalize requires an actual applier observation. Only applied + successful
 * finalize completes. A definite not-applied finalizer skip may retain io-possible:
 * its audit outcome is uncertain even though the data refusal itself is definite.
 * Keep: pre-consume review checks may refuse; consumed review is changed on completion,
 * unchanged on definite refusal, or any review observation on unknown.
 */
function consistentRow(r: MemoryCommandFactRow): boolean {
  if (r.outcome === "completed" && r.code !== undefined) return false;
  if (uncertainCode(r.code) && r.outcome !== "unknown") return false;
  const unfinished = r.outcome !== "completed";
  const noEffects = r.data === "not-called" && r.audit === "not-entered" && r.review === "unchanged";
  if (r.receipt === "not-consumed") {
    return (
      unfinished &&
      noEffects &&
      (r.stage === "admission" ||
        r.stage === "plan" ||
        r.stage === "authorization" ||
        (r.operation === "keep" && r.stage === "review"))
    );
  }
  if (r.stage === "authorization") return unfinished && noEffects;
  if (r.operation === "keep") {
    if (r.stage !== "review" || r.data !== "not-called" || r.audit !== "not-entered") return false;
    switch (r.outcome) {
      case "completed":
        return r.review === "changed";
      case "rejected":
      case "skipped":
        return r.review === "unchanged";
      case "unknown":
        return true;
    }
  }
  if (r.review !== "unchanged") return false;
  switch (r.stage) {
    case "prepared":
      return r.data === "not-called" && (r.audit === "not-entered" ? unfinished : r.outcome === "unknown");
    case "expected-after":
      return r.outcome === "unknown" && r.data === "not-called" && r.audit !== "not-entered";
    case "data":
      return r.outcome === "unknown" && r.audit === "barrier-observed";
    case "finalize":
      if (r.data === "not-called" || r.audit === "not-entered") return false;
      if (r.outcome === "completed") return r.data === "applied" && r.audit === "barrier-observed";
      // E only observes a successful finalize barrier for a committed, applied result.
      if (r.audit === "barrier-observed") return r.outcome === "unknown" && r.data === "applied";
      return r.outcome === "unknown" || r.data === "not-applied";
    default:
      return false;
  }
}

/** Pure aggregation of validated observations, not a grant or proof of durability.
 * Missing rows (including an unknown omitted count) and ANY uncertainty dominate.
 * Invalid rows return unknown to direct callers, but the codec rejects them WHOLE.
 */
export function aggregateMemoryCommandEffect(
  rows: readonly MemoryCommandFactRow[],
  omitted: number | null,
): MemoryCommandEffect {
  if (omitted !== 0) return "unknown";
  let completed = 0;
  let refused = 0;
  for (const r of rows) {
    if (
      !consistentRow(r) ||
      r.outcome === "unknown" ||
      r.data === "unknown" ||
      r.review === "unknown" ||
      r.audit === "io-possible" ||
      uncertainCode(r.code)
    )
      return "unknown";
    if (r.outcome === "completed") completed++;
    else refused++;
  }
  return completed ? (refused ? "partial" : "completed") : "none";
}
function facts(value: unknown): MemoryCommandFacts | undefined {
  const r = record(value, ["v", "kind", "cmdId", "effect", "rows", "omitted"]);
  if (
    !r ||
    r.v !== 1 ||
    r.kind !== "memory-flow" ||
    !id(r.cmdId, MEMORY_FACTS_LIMITS.cmdIdBytes) ||
    !oneOf(r.effect, ["none", "completed", "partial", "unknown"]) ||
    (r.omitted !== null && (!Number.isSafeInteger(r.omitted) || (r.omitted as number) < 0)) ||
    !Array.isArray(r.rows) ||
    r.rows.length > MEMORY_FACTS_LIMITS.rows
  )
    return;
  // Dense own-data arrays only, no getters, custom properties, symbols or sparse holes.
  const descriptors = Object.getOwnPropertyDescriptors(r.rows);
  if (Reflect.ownKeys(descriptors).length !== r.rows.length + 1) return;
  const rows: MemoryCommandFactRow[] = [];
  let previous = 0;
  for (let i = 0; i < r.rows.length; i++) {
    const d = descriptors[String(i)];
    if (!d || !Object.hasOwn(d, "value")) return;
    const parsed = row(d.value);
    if (!parsed || parsed.step <= previous) return;
    previous = parsed.step;
    rows.push(parsed);
  }
  const omitted = r.omitted as number | null;
  if (aggregateMemoryCommandEffect(rows, omitted) !== r.effect) return;
  return { v: 1, kind: "memory-flow", cmdId: r.cmdId, effect: r.effect, rows, omitted };
}
function hasMarker(text: string): boolean {
  // Also catches other versions and truncated/conflicting marker prefixes.
  return text.includes("[pi-memory-result") || text.includes("[/pi-memory-result");
}

/** Host-generated summary only. Reject rather than truncate, drop rows, or repair facts.
 * Caller supplies the aggregate too: a disagreement is a producer bug, not selective salvage.
 */
export function encodeMemoryCommandFacts(summary: string, value: unknown): string | undefined {
  try {
    if (
      typeof summary !== "string" ||
      summary.length > MEMORY_FACTS_LIMITS.summaryBytes ||
      utf8Bytes(summary) > MEMORY_FACTS_LIMITS.summaryBytes ||
      hasMarker(summary)
    )
      return;
    const parsed = facts(value);
    if (!parsed) return;
    const json = canonical(parsed);
    if (hasMarker(json) || utf8Bytes(json) > MEMORY_FACTS_LIMITS.jsonBytes) return;
    const message = `${summary}\n\n${MEMORY_RESULT_OPEN}\n${json}\n${MEMORY_RESULT_CLOSE}`;
    return utf8Bytes(message) <= MEMORY_FACTS_LIMITS.messageBytes ? message : undefined;
  } catch {
    return;
  }
}

/** No-marker legacy messages stay verbatim. Invalid facts expose no summary/rows for salvage.
 * Bind to the ACTUAL current ledger key, not a target/action ID or an ID parsed from text.
 */
export function parseMemoryCommandFacts(message: string, currentCmdId: string): ParsedMemoryCommandFacts {
  const invalid = { kind: "invalid", effect: "unknown" } as const;
  try {
    if (typeof message !== "string") return invalid;
    if (!hasMarker(message)) return { kind: "legacy", summary: message };
    if (
      message.length > MEMORY_FACTS_LIMITS.messageBytes ||
      utf8Bytes(message) > MEMORY_FACTS_LIMITS.messageBytes ||
      !id(currentCmdId, MEMORY_FACTS_LIMITS.cmdIdBytes)
    )
      return invalid;
    const separator = `\n\n${MEMORY_RESULT_OPEN}\n`;
    const start = message.indexOf(separator);
    if (start < 0 || !message.endsWith(`\n${MEMORY_RESULT_CLOSE}`)) return invalid;
    const summary = message.slice(0, start);
    const json = message.slice(start + separator.length, -(MEMORY_RESULT_CLOSE.length + 1));
    if (
      hasMarker(summary) ||
      hasMarker(json) ||
      utf8Bytes(summary) > MEMORY_FACTS_LIMITS.summaryBytes ||
      utf8Bytes(json) > MEMORY_FACTS_LIMITS.jsonBytes ||
      /[\r\n\u2028\u2029]/.test(json)
    )
      return invalid;
    const parsed = facts(JSON.parse(json));
    if (!parsed || parsed.cmdId !== currentCmdId || canonical(parsed) !== json) return invalid;
    return { kind: "facts", summary, facts: parsed };
  } catch {
    return invalid;
  }
}

/** Narrow legacy-compatible FAILURE body; never attach data to a failed wire result.
 * Completed is a success-path concern (undefined here). Missing/bad facts remain unknown;
 * only a genuinely legacy no-marker message may retain the wire's explicit none.
 */
export function memoryCommandFactsFailure(
  message: string,
  currentCmdId: string,
  domainCode: unknown,
  legacyEffect: "none" | "unknown" = "unknown",
):
  | {
      readonly ok: false;
      readonly code: MemoryCommandFailureCode;
      readonly message: string;
      readonly retryable: false;
      readonly effect: "none" | "unknown";
    }
  | undefined {
  const parsed = parseMemoryCommandFacts(message, currentCmdId);
  if (parsed.kind === "facts" && parsed.facts.effect === "completed") return;
  const effect =
    parsed.kind === "legacy"
      ? legacyEffect
      : parsed.kind === "facts" && parsed.facts.effect === "none"
        ? "none"
        : "unknown";
  return {
    ok: false,
    code: memoryCommandFailureCode(domainCode) ?? "E_COMMAND_DENIED",
    message,
    retryable: false,
    effect,
  };
}
