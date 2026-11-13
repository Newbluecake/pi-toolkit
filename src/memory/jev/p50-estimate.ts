/** Local estimate ONLY: not a tokenizer/server-template bound or an invoice.
 * Pure bounded data serializer; never invokes getters or toJSON. */
import type { ClassifyContext, RevisionTransportContext } from "./contracts.js";
export const STOCK_ESTIMATE_PROFILE = Object.freeze({
  kind: "stock-estimate-v1" as const,
  mode: "suggest-only" as const,
  estimatorId: "p50-utf8-div3-margin2-v1" as const,
  templateVersion: "pi-1.5-systemone/openai-text-v1" as const,
  serverTemplateKnown: false as const,
  serverEnforced: false as const,
  identityEvidence: "unknown" as const,
  billingStatus: "UNKNOWN" as const,
  priceBasis: "catalog-list-estimate" as const,
  attemptPolicy: "single-attempt-no-split" as const,
});
export type StockEstimateProfile = typeof STOCK_ESTIMATE_PROFILE;
export function estimatePayload(payload: unknown): number | undefined {
  let nodes = 0;
  const active = new Set<object>();
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 16384 || depth > 32) throw Error("estimate bounds");
    if (v === undefined || v === null || typeof v === "boolean") return v;
    if (typeof v === "string" && Buffer.byteLength(v) <= 131072) return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object" || v === null || active.has(v)) throw Error("estimate data");
    const array = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)) throw Error("estimate prototype");
    active.add(v);
    const out: Record<string, unknown> | unknown[] = array ? [] : (Object.create(null) as Record<string, unknown>);
    for (const key of Reflect.ownKeys(v)) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || key === "__proto__") throw Error("estimate key");
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!("value" in d)) throw Error("estimate accessor");
      (out as Record<string, unknown>)[key] = copy(d.value, depth + 1);
    }
    active.delete(v);
    return out;
  }
  try {
    const json = JSON.stringify(copy(payload, 0));
    if (json === undefined || Buffer.byteLength(json) > 131072) return undefined;
    return 2 * Math.ceil(Buffer.byteLength(json) / 3) + 256;
  } catch {
    return undefined;
  }
}
export function stockClassifyPayload(model: string, ctx: ClassifyContext): Record<string, unknown> {
  return {
    model,
    state: ctx.state,
    questions: Object.fromEntries(
      Object.entries(ctx.questions).map(([id, q]) => [id, q.type === "bool" ? { ...q, type: "noul" } : q]),
    ),
  };
}
/** Mirror only the SDK's deterministic DeepSeek thinking-off framing. Never
 * invoke model accessors or enable reasoning; other formats still fail closed. */
export function stockRevisionThinkingDisabled(model: unknown): boolean {
  const field = (v: unknown, key: string): unknown => {
    if (!v || typeof v !== "object") return undefined;
    const d = Object.getOwnPropertyDescriptor(v, key);
    return d && "value" in d ? d.value : undefined;
  };
  const format = field(field(model, "compat"), "thinkingFormat");
  const url = field(model, "baseUrl");
  return (
    field(model, "reasoning") === true &&
    field(field(model, "thinkingLevelMap"), "off") !== null &&
    (format === "deepseek" ||
      (format === undefined &&
        (field(model, "provider") === "deepseek" ||
          (typeof url === "string" && url.toLowerCase().includes("deepseek.com")))))
  );
}
/** Quote includes both supported optional SDK framing fields conservatively.
 * Final payload allowlist/recount rejects all other serializer/sampling modes. */
export function stockRevisionPayload(
  model: string,
  ctx: RevisionTransportContext,
  output: number,
  thinkingDisabled = false,
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: ctx.systemPrompt },
      ...ctx.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    max_tokens: output,
    ...(thinkingDisabled ? { thinking: { type: "disabled" } } : {}),
  };
}
export function stockRevisionPayloadSupported(p: Readonly<Record<string, unknown>>): boolean {
  const keys = [
    "model",
    "messages",
    "stream",
    "stream_options",
    "store",
    "max_tokens",
    "thinking",
    "prompt_cache_key",
    "prompt_cache_retention",
  ];
  return (
    Object.keys(p).every((k) => keys.includes(k)) &&
    p.stream === true &&
    (p.store === undefined || p.store === false) &&
    p.prompt_cache_key === undefined &&
    p.prompt_cache_retention === undefined &&
    (p.thinking === undefined ||
      (p.thinking !== null &&
        typeof p.thinking === "object" &&
        Reflect.ownKeys(p.thinking).length === 1 &&
        Object.getOwnPropertyDescriptor(p.thinking, "type")?.value === "disabled")) &&
    (p.stream_options === undefined || JSON.stringify(p.stream_options) === '{"include_usage":true}')
  );
}
