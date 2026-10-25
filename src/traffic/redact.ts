const SECRET_KEYS =
  /^(x-api-key|authorization|proxy-authorization|api-key|x-goog-api-key|openai-api-key|x-goog-iam-authorization-token|cookie|set-cookie|x-amz-security-token)$/i;
export const SECRET_KEY_LIKE =
  /(?:api_key|apikey|api-key|token|secret|password|authorization|access_key|client_secret)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{3,}/g,
  /\bBearer\s+\S{4,}/gi,
  /\beyJ[A-Za-z0-9._-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];
const REDACTED = "«REDACTED»";
const SECRET_CONTEXT_KEY =
  "(?:x-api-key|authorization|proxy-authorization|api-key|x-goog-api-key|openai-api-key|x-goog-iam-authorization-token|cookie|set-cookie|x-amz-security-token|api_key|apikey|api-key|token|secret|password|access_key|client_secret)";
const SECRET_CONTEXT_PATTERN = new RegExp(
  `((?:["']?${SECRET_CONTEXT_KEY}["']?)\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;}]+)`,
  "gi",
);

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes < 1) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

function addSecret(secrets: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length >= 4) secrets.add(value);
}

function collectBodySecrets(value: unknown, secrets: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBodySecrets(item, secrets);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_LIKE.test(key)) addSecret(secrets, child);
    collectBodySecrets(child, secrets);
  }
}

/** Collect the request's own secret values before processing untrusted diagnostics. */
export function collectSecrets(headers: Record<string, string>, bodyText?: string | null): string[] {
  const secrets = new Set<string>();
  for (const [key, rawValue] of Object.entries(headers)) {
    if (!SECRET_KEYS.test(key)) continue;
    const value = String(rawValue);
    addSecret(secrets, value);
    const bearer = /^Bearer\s+(\S+)/i.exec(value.trim());
    if (bearer?.[1]) addSecret(secrets, bearer[1]);
  }
  if (bodyText) {
    try {
      collectBodySecrets(JSON.parse(bodyText), secrets);
    } catch {
      // Body collection is best effort; pattern redaction still applies below.
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

export interface RedactOptions {
  maxLen?: number;
  secrets?: string[];
}

/** Redact known values first, then apply key-context and pattern fallbacks. */
export function redactText(text: string, opts?: RedactOptions | number): string {
  const options = typeof opts === "number" ? { maxLen: opts } : opts;
  const maxLen = options?.maxLen ?? 2048;
  const maxBytes = Number.isFinite(maxLen) ? Math.floor(maxLen) : 2048;
  const secrets = [...new Set((options?.secrets ?? []).filter((secret) => secret.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  out = out.replace(SECRET_CONTEXT_PATTERN, `$1${REDACTED}`);
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return truncateUtf8(out, maxBytes);
}

export function redactHeaderMap(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(h)) {
    out[key] = SECRET_KEYS.test(key) ? REDACTED : redactText(String(value));
  }
  return out;
}

export { SECRET_KEYS };
