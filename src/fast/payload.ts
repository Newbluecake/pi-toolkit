/** Strict, provider-independent final-body gate. Fail closed for rewriting, not for SDK transport. */
import type { FastSnapshot } from "./ports.js";

export type FastPayloadReason =
  | "unsafe-object"
  | "mixed-protocol"
  | "unknown-root-field"
  | "invalid-root"
  | "invalid-input"
  | "invalid-tools"
  | "invalid-tool-choice";
export interface ResponsesShape {
  readonly family: "responses";
  readonly payloadModel: string;
  /** Structural hint only, never identifies a provider or transport. */
  readonly dialect: "common" | "codex-compatible";
}
export type ShapeResult =
  | { readonly kind: "responses"; readonly value: ResponsesShape }
  | { readonly kind: "other" }
  | { readonly kind: "unsupported"; readonly reason: FastPayloadReason };
export type FastPayloadResult =
  | {
      readonly kind: "applied";
      readonly replacement: Readonly<Record<string, unknown>>;
      readonly requestedTier: "priority" | "default";
      readonly shape: ResponsesShape;
    }
  | Exclude<ShapeResult, { readonly kind: "responses" }>;

type Data = Record<string, unknown>;
function fail(reason: FastPayloadReason): never {
  throw reason;
}
function ordinary(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}
/** Materialize descriptors, never user getters. Opaque schemas/metadata are not recursively walked. */
function data(value: unknown): Data {
  if (!ordinary(value)) fail("unsafe-object");
  const out: Data = Object.create(null) as Data;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("unsafe-object");
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || !d.enumerable) fail("unsafe-object");
    out[key] = d.value;
  }
  return out;
}
function list(value: unknown, check: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !("value" in d) || !check(d.value)) return false;
  }
  return true;
}
function str(v: unknown): v is string {
  return typeof v === "string";
}
function optional(d: Data, k: string, check: (v: unknown) => boolean): boolean {
  return d[k] === undefined || check(d[k]);
}
function keys(d: Data, allowed: string): boolean {
  const names = allowed.split(" ");
  return Object.keys(d).every((k) => names.includes(k));
}
function strings(d: Data, names: string): boolean {
  return names.split(" ").every((k) => optional(d, k, str));
}
function opaque(v: unknown): boolean {
  data(v);
  return true;
}
function content(value: unknown, output = false): boolean {
  return list(value, (item) => {
    const p = data(item);
    if (p.type === "input_text") return keys(p, "type text") && str(p.text);
    if (output && p.type === "output_text")
      return keys(p, "type text annotations") && str(p.text) && optional(p, "annotations", (v) => list(v, () => true));
    return (
      p.type === "input_image" && keys(p, "type image_url detail") && str(p.image_url) && optional(p, "detail", str)
    );
  });
}
function tools(value: unknown): boolean {
  return list(value, (item) => {
    const t = data(item);
    if (!str(t.name) || !strings(t, "description") || !optional(t, "defer_loading", (v) => typeof v === "boolean"))
      return false;
    if (t.type === "function")
      return (
        keys(t, "type name description parameters strict defer_loading") &&
        ordinary(t.parameters) &&
        optional(t, "strict", (v) => v === null || typeof v === "boolean")
      );
    if (t.type !== "custom" || !keys(t, "type name description format defer_loading")) return false;
    const f = data(t.format);
    return keys(f, "type syntax definition") && f.type === "grammar" && str(f.syntax) && str(f.definition);
  });
}
function item(value: unknown): boolean {
  const p = data(value);
  if (
    !strings(p, "id phase namespace") ||
    !optional(p, "status", (v) => str(v) || (p.type === "reasoning" && v === null))
  )
    return false;
  switch (p.type) {
    case undefined:
    case "message":
      return (
        keys(p, "type role content id status phase") &&
        ["system", "developer", "user", "assistant"].includes(p.role as string) &&
        (str(p.content) || content(p.content, true))
      );
    case "function_call":
    case "custom_tool_call":
      return (
        keys(p, "type id status call_id name namespace arguments input") &&
        str(p.call_id) &&
        str(p.name) &&
        (p.type === "function_call"
          ? str(p.arguments) && p.input === undefined
          : str(p.input) && p.arguments === undefined)
      );
    case "function_call_output":
    case "custom_tool_call_output":
      return keys(p, "type id status call_id output") && str(p.call_id) && (str(p.output) || content(p.output));
    case "reasoning":
      return (
        keys(p, "type id status summary content encrypted_content signature") &&
        list(p.summary, (s) => {
          const d = data(s);
          return keys(d, "type text") && d.type === "summary_text" && str(d.text);
        }) &&
        // SDK replays this opaque array from thinkingSignature; never inspect reasoning text.
        optional(p, "content", (v) => list(v, () => true)) &&
        optional(p, "encrypted_content", (v) => v === null || str(v)) &&
        optional(p, "signature", str)
      );
    case "additional_tools":
      return keys(p, "type role tools") && p.role === "developer" && tools(p.tools);
    case "configuration_update": {
      if (!keys(p, "type reasoning")) return false;
      const r = data(p.reasoning);
      return str(r.effort);
    }
    case "tool_search_call":
    case "tool_search_output":
      return (
        keys(p, "type id status call_id execution arguments tools") &&
        str(p.call_id) &&
        p.execution === "client" &&
        (p.type === "tool_search_call"
          ? opaque(p.arguments) && p.tools === undefined
          : tools(p.tools) && p.arguments === undefined)
      );
    default:
      return false;
  }
}
function classify(payload: unknown): ShapeResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { kind: "other" };
  const p = data(payload);
  // Familiar non-Responses protocols are suspended. A partial/mixed Responses candidate is unsupported.
  if (!("input" in p) && !("store" in p)) return { kind: "other" };
  if (
    "messages contents prompt system generationConfig generation_config inferenceConfig anthropic_version"
      .split(" ")
      .some((k) => k in p)
  )
    fail("mixed-protocol");
  if (
    !keys(
      p,
      "model input stream store instructions tools tool_choice parallel_tool_calls reasoning include text max_output_tokens temperature top_p service_tier prompt_cache_key prompt_cache_retention prompt_cache_options metadata user safety_identifier truncation max_tool_calls previous_response_id conversation background stream_options",
    )
  )
    fail("unknown-root-field");
  if (!str(p.model) || p.model.trim().length === 0 || p.stream !== true || typeof p.store !== "boolean")
    fail("invalid-root");
  if (
    !strings(
      p,
      "instructions prompt_cache_key prompt_cache_retention user safety_identifier truncation previous_response_id",
    )
  )
    fail("invalid-root");
  if (!["temperature", "top_p"].every((k) => optional(p, k, (v) => typeof v === "number" && Number.isFinite(v))))
    fail("invalid-root");
  if (
    !["max_output_tokens", "max_tool_calls"].every((k) =>
      optional(p, k, (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0),
    )
  )
    fail("invalid-root");
  if (
    !optional(p, "background", (v) => v === false) ||
    !optional(p, "parallel_tool_calls", (v) => typeof v === "boolean") ||
    !optional(p, "service_tier", (v) => v === null || str(v))
  )
    fail("invalid-root");
  if (
    !["reasoning", "text", "prompt_cache_options", "metadata", "stream_options"].every((k) => optional(p, k, opaque)) ||
    !optional(p, "include", (v) => list(v, str))
  )
    fail("invalid-root");
  if (!optional(p, "conversation", (v) => str(v) || (opaque(v) && str(data(v).id)))) fail("invalid-root");
  if (!list(p.input, item)) fail("invalid-input");
  if (!optional(p, "tools", tools)) fail("invalid-tools");
  if (
    !optional(p, "tool_choice", (v) => {
      if (str(v)) return true;
      const c = data(v);
      return keys(c, "type name") && (c.type === "function" || c.type === "custom") && str(c.name);
    })
  )
    fail("invalid-tool-choice");
  return {
    kind: "responses",
    value: {
      family: "responses",
      payloadModel: p.model,
      dialect: p.instructions !== undefined && p.parallel_tool_calls === true ? "codex-compatible" : "common",
    },
  };
}
export function classifyResponsesPayload(payload: unknown): ShapeResult {
  try {
    return classify(payload);
  } catch (reason) {
    // Only static enums escape; never expose payloads, values, thrown messages or property names.
    const known: readonly unknown[] = [
      "unsafe-object",
      "mixed-protocol",
      "unknown-root-field",
      "invalid-root",
      "invalid-input",
      "invalid-tools",
      "invalid-tool-choice",
    ];
    return { kind: "unsupported", reason: known.includes(reason) ? (reason as FastPayloadReason) : "unsafe-object" };
  }
}
/** Undefined is the inherit zero-op; no payload inspection whatsoever. Always classify at this boundary. */
export function rewriteFastPayload(payload: unknown, snapshot: FastSnapshot): FastPayloadResult | undefined {
  if (snapshot.mode === "inherit") return undefined;
  const result = classifyResponsesPayload(payload);
  if (result.kind !== "responses") return result;
  const requestedTier = snapshot.mode === "on" ? "priority" : "default";
  return {
    kind: "applied",
    replacement: { ...(payload as Data), service_tier: requestedTier },
    requestedTier,
    shape: result.value,
  };
}
