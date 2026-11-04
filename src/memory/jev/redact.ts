// Outbound redaction pipeline for everything sent to Jev (Q23, jev-arch §7.1
// — match FIRST, truncate AFTER). This is a hygiene measure, not a security
// boundary; the real boundary is the §7.2 never-send list (enforced by the
// callers) and the secure-domain forced-off.
//
// Pi-free root; no module state (I4).

import { SECRET_PATTERNS, looksSecret } from "../secret-patterns.js";
import type { RedactField } from "./contracts.js";

const WINDOW_UNITS = 8_000; // 8KB matching window (§7.1 step 1)
const MASK = "[REDACTED]";

// §7.1 step 3 mask sources:
//  · SECRET_PATTERNS + loose key/value (same source as doctor D13, via
//    secret-patterns.ts — same-source by construction);
//  · sensitive key-name substrings (token, secret, password/pwd, api-key,
//    auth, credential, cookie, session, private-key) — values masked
//    unconditionally (mirror kept local; memory never imports web-hub);
//  · bearer tokens & api-key query params (mirror of src/core/redact.ts);
//  · URL userinfo;
//  · PEM blocks → [PEM];
//  · base64/hex runs ≥32;
//  · email addresses.
const PEM_BLOCK_RE = /-----BEGIN [A-Z ]*-----[\s\S]*?-----END [A-Z ]*-----/g;
const LOOSE_KV_RE =
  /(?<![A-Za-z0-9])(?:password|secret|token)["']?[ \t]*[:=][ \t]*("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|\S+)/gi;
const SENSITIVE_KEY_RE =
  /(?<![A-Za-z0-9])([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|auth|credential|cookie|session|private[_-]?key)[A-Za-z0-9_-]*)["']?([ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|\S+)/gi;
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+)(:[^@/\s]*)?@/gi;
const BASE64_LONG_RE = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;
const HEX_LONG_RE = /\b[0-9a-fA-F]{32,}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const ANSI_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const FIRST_ERROR_LINE_RE = /(?:^|\W)(?:error|errno|failed|fatal|panic|exception|traceback)(?:\W|$)/i;

/** §7.1 truncation budgets (code points). */
const TRUNCATION: Record<RedactField, { limit: number; mode: "head" | "tail" }> = {
  user: { limit: 2_000, mode: "head" }, // user message / dispatch prompt
  previousUser: { limit: 600, mode: "head" },
  command: { limit: 500, mode: "head" },
  error: { limit: 1_500, mode: "tail" },
  entry: { limit: 400, mode: "head" },
};

/** Mask secret-shaped spans. Never throws; every pass is total. */
function maskSecrets(text: string): string {
  try {
    let out = text;
    out = out.replace(PEM_BLOCK_RE, "[PEM]"); // before the literal pass kills headers
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(new RegExp(pattern.source, pattern.flags), MASK);
    }
    // Loose password/secret/token values — same credential-likeness gate as
    // doctor D13 (looksSecret re-runs the same matcher on the fragment).
    out = out.replace(LOOSE_KV_RE, (whole) =>
      looksSecret(whole) ? whole.replace(/([:=])[ \t]*[\s\S]*$/, `$1 ${MASK}`) : whole,
    );
    // Bearer / api-key query params (mirror of src/core/redact.ts) — BEFORE
    // the sensitive-key pass so full `Bearer <token>` headers redact whole.
    out = out
      .replace(/([?&](?:api_key|apikey|key)=)[^&\s]+/gi, `$1${MASK}`)
      .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, `$1${MASK}`);
    // Sensitive key-name substrings — value masked UNCONDITIONALLY. This pass
    // is deliberately MORE aggressive than doctor D13's loose rule (which
    // gates on credential-likeness): Q23 puts privacy first — over-masking
    // only loses judgment signal outbound, under-masking leaks. Not
    // same-source with D13 by design.
    out = out.replace(SENSITIVE_KEY_RE, (_whole, key: string, sep: string) => `${key}${sep}${MASK}`);
    // URL userinfo.
    out = out.replace(URL_USERINFO_RE, (_whole, scheme: string) => `${scheme}${MASK}@`);
    // Long base64 / hex runs, emails.
    out = out.replace(BASE64_LONG_RE, MASK).replace(HEX_LONG_RE, MASK).replace(EMAIL_RE, "[EMAIL]");
    return out;
  } catch {
    return text;
  }
}

/** Redact + truncate one outbound field. Pipeline (§7.1): first 8KB matching
 *  window → strip ANSI escapes and C0 controls (except `\n`/`\t`) → mask →
 *  `$HOME` → `~` → truncate per field table. The `error` field truncates
 *  from the TAIL, keeping the first error-looking line in view when it falls
 *  outside the window. Never throws. */
export function redactForJev(text: string, field: RedactField): string {
  try {
    let out = Array.from(text).slice(0, WINDOW_UNITS).join("");
    out = out.replace(ANSI_RE, "");
    out = Array.from(out)
      .map((c) => {
        const code = c.codePointAt(0)!;
        return (code < 0x20 && c !== "\n" && c !== "\t") || code === 0x7f ? "" : c;
      })
      .join("");
    out = maskSecrets(out);
    const home = process.env["HOME"] ?? "";
    if (home !== "") out = out.split(home).join("~");
    const rule = TRUNCATION[field];
    const chars = Array.from(out);
    if (chars.length <= rule.limit) return out;
    if (rule.mode === "head") return chars.slice(0, rule.limit).join("");
    // tail mode with the first error line kept in view (§7.1 “尾部，首个错误行优先”).
    const tail = chars.slice(chars.length - rule.limit).join("");
    const firstError = out.split("\n").find((line) => FIRST_ERROR_LINE_RE.test(line));
    if (firstError !== undefined && firstError !== "" && !tail.includes(firstError)) {
      const budget = rule.limit - Array.from(firstError).length - 3; // "\n…\n"
      if (budget <= 0) return Array.from(firstError).slice(0, rule.limit).join("");
      const tailChars = Array.from(tail);
      return `${firstError}\n…\n${tailChars.slice(tailChars.length - budget).join("")}`;
    }
    return tail;
  } catch {
    return "";
  }
}
