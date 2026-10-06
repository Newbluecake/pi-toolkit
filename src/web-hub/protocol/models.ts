const encoder = new TextEncoder();

export const MODELS_WIRE_MAX_ITEMS = 160;
export const MODEL_REF_MAX_BYTES = 128;
export const MODEL_NAME_MAX_BYTES = 96;
export const MODELS_WIRE_BUDGET_BYTES = 16_384;

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let out = "";
  let used = 0;
  for (const point of value) {
    const size = utf8Bytes(point);
    if (used + size > maxBytes) break;
    out += point;
    used += size;
  }
  return out;
}

function hasWhitespaceOrControls(value: string): boolean {
  return /[\p{Cc}\p{Cf}\s]/u.test(value);
}

export function isValidProvider(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= MODEL_REF_MAX_BYTES &&
    !value.includes("/") &&
    !hasWhitespaceOrControls(value)
  );
}

export function isValidModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= MODEL_REF_MAX_BYTES &&
    !hasWhitespaceOrControls(value)
  );
}

export function sanitizeModelName(name: unknown, id: string): string | undefined {
  if (typeof name !== "string") return undefined;
  const clean = name
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (clean === "" || clean === id) return undefined;
  const suffix = "…";
  const truncated =
    utf8Bytes(clean) <= MODEL_NAME_MAX_BYTES
      ? clean
      : `${truncateUtf8(clean, MODEL_NAME_MAX_BYTES - utf8Bytes(suffix))}${suffix}`;
  return truncated === id ? undefined : truncated;
}

export function modelCommandArg(provider: string, id: string): string | undefined {
  return isValidProvider(provider) && isValidModelId(id) ? `${provider}/${id}` : undefined;
}
