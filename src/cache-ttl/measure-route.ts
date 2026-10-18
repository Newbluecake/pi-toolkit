/** Measurement route identity (§6): persist a digest and a redacted display label, never the URL. */
import { createHash } from "node:crypto";
import type { EffectiveTier, MeasureApi } from "./measure-types.js";
import type { PipelineMeasureRouteKey } from "./pipeline-ping-types.js";

/** Shared with measurement transport admission. No mutable per-process routing state. */
export function measureEndpointSuffix(api: MeasureApi): string {
  switch (api) {
    case "anthropic-messages":
      return "/v1/messages";
    case "openai-responses":
      return "/responses";
    case "openai-completions":
      return "/chat/completions";
  }
}

export interface MeasureRouteInput {
  api: MeasureApi;
  url: string;
  wireModel: string;
  effectiveTier: EffectiveTier;
}

export function measureRouteKey(input: MeasureRouteInput): PipelineMeasureRouteKey {
  const url = new URL(input.url);
  const suffix = measureEndpointSuffix(input.api);
  if (!url.pathname.endsWith(suffix) || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("unsupported measurement endpoint");
  }
  // URL.origin removes credentials/default ports and normalises the host. Values (including
  // duplicate query params) belong in the identity, but only their redacted forms in the label.
  const origin = url.origin.toLowerCase();
  const path = url.pathname.slice(0, -suffix.length).replace(/\/+$/, "");
  const query = [...url.searchParams].sort(([ak, av], [bk, bv]) => compare(ak, bk) || compare(av, bv));
  const key = `sha256:${createHash("sha256")
    .update(JSON.stringify([input.api, origin, path, query, input.wireModel, input.effectiveTier]))
    .digest("hex")}`;
  const segments = path.split("/").filter(Boolean).slice(0, 2).map(redactSegment);
  const queryLabel = query.length
    ? `?${[...new Set(query.map(([name]) => redactSegment(name)))].map((name) => `${name}=…`).join("&")}`
    : "";
  return {
    key,
    label: `${input.api} · ${url.host.toLowerCase()} · /${segments.join("/")}${queryLabel} · ${input.wireModel}`,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function redactSegment(raw: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return "…";
  }
  // Deliberately conservative: long/opaque IDs, credential-looking tokens, escaped separators,
  // control chars and unfamiliar punctuation are not useful display names.
  return value.length > 23 ||
    (value.length >= 12 && /[a-z]/i.test(value) && /\d/.test(value)) ||
    /[a-f\d]{12,}|(?:sk|key|token|secret|bearer)[-_]|[^a-z\d._~-]/i.test(value)
    ? "…"
    : value;
}
