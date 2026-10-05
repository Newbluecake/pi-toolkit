/**
 * web-hub upload protocol (plan `docs/dev/web-hub-upload/plan.md` §包 U1 — frozen interface).
 *
 * Pure, `node:fs`-free: endpoint path constants, §2.4 limits, the §1.3 chunk-size/deadline
 * constants, filename sanitization (§2.3), the on-disk extension rule (`uploadDiskExt` — the
 * generated `<uploadId>.<ext>` disk names keep only this much of the client's name), mime
 * format-validation (§1.2 #2), the fixed-English prompt attachment block (§3.1), the
 * bucket-naming rule (§2.1), and the `meta.json` v1 schema + strict parser (§2.2.3).
 * `hub/uploads.ts` (U2) and the browser UI both import this module so the rules never drift
 * between the two sides.
 *
 * Disk naming (2026-10 rework): the on-disk file name is server-generated — `<uploadId>.<ext>`,
 * `ext` from `uploadDiskExt(rawName)`, extension-less when absent/reserved. The client's
 * original name NEVER reaches the filesystem; `sanitizeUploadName(raw)` remains only as the
 * canonical form of the client-declared display name (begin-idempotency comparison, the §2.5
 * dedup key, and the `meta.json` record of what the user called the file).
 */

// ---------------------------------------------------------------------------
// §1.2 endpoints
// ---------------------------------------------------------------------------

export const UPLOAD_BEGIN_PATH = "/api/upload/begin";
export const UPLOAD_CHUNK_PATH = "/api/upload/chunk";
export const UPLOAD_COMMIT_PATH = "/api/upload/commit";
export const UPLOAD_ABORT_PATH = "/api/upload/abort";

// ---------------------------------------------------------------------------
// §2.4 limits & rate limiting
// ---------------------------------------------------------------------------

/** Single-file cap: `begin.size` / a chunk that would exceed it ⇒ 413 `E_UPLOAD_TOO_LARGE`. */
export const UPLOAD_FILE_MAX_BYTES = 100 * 1024 * 1024;
/** Per-bucket cap (committed + in-flight; also the per-principal-per-bucket cap). */
export const UPLOAD_BUCKET_MAX_BYTES = 512 * 1024 * 1024;
/** Hub-global cap across all buckets. */
export const UPLOAD_TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Max un-committed uploads per principal ⇒ 429 beyond this. */
export const UPLOAD_INFLIGHT_PER_PRINCIPAL = 4;
/** Max un-committed uploads hub-wide ⇒ 429 beyond this. */
export const UPLOAD_INFLIGHT_HUB = 16;
/** Front-end tray cap per outgoing message. */
export const UPLOAD_ATTACH_MAX_PER_MSG = 20;
/** Token-bucket capacity shared by all `/api/upload/*` endpoints, keyed `${principal}:upload`. */
export const UPLOAD_RATE_LIMIT_CAPACITY = 64;
/** Token-bucket refill: 1 token every this many ms. */
export const UPLOAD_RATE_LIMIT_REFILL_MS = 100;

// ---------------------------------------------------------------------------
// §1.3 chunk size & deadline constants
// ---------------------------------------------------------------------------

/** loopback chunk size (100 MiB file ⇒ 25 requests). */
export const UPLOAD_CHUNK_BYTES_LOOPBACK = 4 * 1024 * 1024;
/** LAN chunk size — smaller so a 12s body-read budget only needs ≈0.7 Mbps. */
export const UPLOAD_CHUNK_BYTES_LAN = 1 * 1024 * 1024;
/** Budget for reading one chunk's body (< `UPLOAD_TOTAL_MS`). */
export const UPLOAD_CHUNK_BODY_MS = 12_000;
/** Total per-`chunk`-request deadline (< the 15s listener `requestTimeout`). */
export const UPLOAD_TOTAL_MS = 14_000;

// ---------------------------------------------------------------------------
// §2.3 sanitizeUploadName
// ---------------------------------------------------------------------------

/** Unicode letters/numbers plus `._-`; everything else is replaced with `_`. */
const ALLOWED_CHAR_RE = /[\p{L}\p{N}._-]/u;
/** Extension kept on fallback/truncation: 1-16 ASCII alphanumerics after the last `.`. */
const EXT_RE = /^[A-Za-z0-9]{1,16}$/;
const MAX_NAME_BYTES = 120;

const textEncoder = new TextEncoder();

function byteLength(s: string): number {
  return textEncoder.encode(s).length;
}

function extractExt(name: string): string | undefined {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return undefined;
  const ext = name.slice(idx + 1);
  return EXT_RE.test(ext) ? ext : undefined;
}

/**
 * The on-disk extension rule for generated disk names: the substring after the last `.` of the
 * RAW client name, kept only when it is 1-16 ASCII alphanumerics (`<id>.<ext>`); anything else
 * — non-string name, no dot, leading dot, over-long, non-ASCII, or a path fragment in the
 * suffix — yields `undefined` and the file lands extension-less as the bare `<uploadId>`.
 * Takes the raw name, not the sanitized one: `sanitizeUploadName`'s leading-dot stripping can
 * hide or mangle an extension, and the disk name is derived independently of sanitization.
 */
export function uploadDiskExt(rawName: unknown): string | undefined {
  return typeof rawName === "string" ? extractExt(rawName) : undefined;
}

/** Truncate `s` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const chBytes = byteLength(ch);
    if (used + chBytes > maxBytes) break;
    out += ch;
    used += chBytes;
  }
  return out;
}

function truncatePreservingExt(name: string, maxBytes: number): string {
  if (byteLength(name) <= maxBytes) return name;
  const ext = extractExt(name);
  if (ext === undefined) return truncateUtf8(name, maxBytes);
  const suffix = `.${ext}`;
  const stem = name.slice(0, name.length - suffix.length);
  const stemBudget = maxBytes - byteLength(suffix);
  if (stemBudget <= 0) return truncateUtf8(name, maxBytes);
  return `${truncateUtf8(stem, stemBudget)}${suffix}`;
}

/**
 * Canonicalize an arbitrary (attacker-controlled) upload filename into the §2.3 safe form:
 * last path segment only, Unicode-letter/number/`._-` whitelist (everything else ⇒ `_`, runs
 * collapsed), no leading `.`/`-`, no trailing `.`, ≤120 UTF-8 bytes (extension preserved when
 * possible), never empty/`.`/`..`, never ends with `.part`, never equals `meta.json`.
 *
 * NOT the on-disk name (2026-10 rework) — disk files are `<uploadId>.<ext>` via `uploadDiskExt`.
 * This is the canonical form of the client-declared *display* name, used by `hub/uploads.ts`
 * for the begin-idempotency parameter comparison, the §2.5 content-dedup key, and the
 * `meta.json` `safeName` record. The raw original name keeps flowing through the wire unchanged
 * (UI display, e.g. the AttachmentTray, is client-side).
 */
export function sanitizeUploadName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "file";
  let normalized: string;
  try {
    normalized = raw.normalize("NFC");
  } catch {
    normalized = raw;
  }
  const segments = normalized.split(/[\\/]+/);
  const last = segments[segments.length - 1] ?? "";

  let whitelisted = "";
  for (const ch of last) whitelisted += ALLOWED_CHAR_RE.test(ch) ? ch : "_";
  whitelisted = whitelisted.replace(/_+/g, "_");
  whitelisted = whitelisted.replace(/^[.-]+/, "");
  whitelisted = whitelisted.replace(/\.+$/, "");

  let result: string;
  if (whitelisted.length === 0 || whitelisted === "." || whitelisted === "..") {
    const ext = extractExt(last);
    result = ext !== undefined ? `file.${ext}` : "file";
  } else {
    result = truncatePreservingExt(whitelisted, MAX_NAME_BYTES);
  }

  if (result.endsWith(".part")) result = `${result}_`;
  if (result === "meta.json") result = `${result}_`;
  return result;
}

// ---------------------------------------------------------------------------
// §1.2 #2 normalizeMime
// ---------------------------------------------------------------------------

/** RFC 7230 `token "/" token`, each side 1-64 chars, total ≤ 127 bytes (ASCII only). */
// eslint-disable-next-line no-useless-escape
const MIME_RE = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}\/[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;

/**
 * Format-validate a browser-supplied mime type (§1.2 #2): trim, lowercase, then match the strict
 * RFC 7230 token/token grammar with no parameters/whitespace/control chars. Anything that doesn't
 * match is **dropped** (returns `undefined`) rather than rejecting the request — this also closes
 * the prompt-injection vector (`"text/plain\n- /etc/passwd"` etc. never survive).
 */
export function normalizeMime(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || byteLength(trimmed) > 127) return undefined;
  return MIME_RE.test(trimmed) ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// §2.1 bucketFor
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `s-<sessionId>` when `sessionId` sanitizes cleanly, else `a-<agentKey>` (§2.1). */
export function bucketFor(p: { sessionId?: string | undefined; agentKey: string }): string {
  if (typeof p.sessionId === "string" && SESSION_ID_RE.test(p.sessionId)) return `s-${p.sessionId}`;
  return `a-${p.agentKey}`;
}

// ---------------------------------------------------------------------------
// §3.1 formatAttachmentBlock / parseAttachmentBlock
// ---------------------------------------------------------------------------

export interface AttachmentItem {
  /** Absolute on-disk path; must not contain `\n`/`\r`. */
  readonly path: string;
  /** Already-`normalizeMime`d value, or `null` for "unknown type". Re-validated here (§1.2 #2). */
  readonly mime: string | null;
  /** Pre-formatted human size label (see `formatAttachmentSize`), e.g. `"182 KB"`. */
  readonly sizeLabel: string;
}

const ATTACHMENT_FOOTER = "Paths can be passed to the read tool as-is; quote them when using a shell.";

function attachmentHeader(n: number): string {
  return `[web-hub attachments] The user attached ${n} file(s), saved on this machine and kept for at least 24 hours (7 days once sent):`;
}

/** 1024-based human size label (`"834 B"`, `"182 KB"`, `"1.4 MB"`, `"2.1 GB"`). */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const label = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${label} ${units[unitIndex]}`;
}

const HAS_NEWLINE_RE = /[\r\n]/;
/** Control characters or parens would break the fixed `- path (mime, size)` line shape. */
const UNSAFE_SIZE_LABEL_RE = /[\x00-\x1F\x7F()]/;

/**
 * Build the fixed-English attachment block appended to the user's prompt (§3.1). `mime` is
 * re-validated via `normalizeMime` (defense in depth against an already-tampered `AttachmentItem`)
 * — an invalid/injected mime degrades to `"unknown type"` rather than breaking the block's shape.
 * Returns `undefined` (refuses to generate) when `items` is empty, any `path` contains a
 * newline, or any `sizeLabel` contains a control character or `(`/`)` — any of these could
 * otherwise forge extra list/footer lines or break the line's fixed shape.
 */
export function formatAttachmentBlock(items: readonly AttachmentItem[]): string | undefined {
  if (items.length === 0) return undefined;
  const lines: string[] = [attachmentHeader(items.length)];
  for (const item of items) {
    if (HAS_NEWLINE_RE.test(item.path)) return undefined;
    if (UNSAFE_SIZE_LABEL_RE.test(item.sizeLabel)) return undefined;
    const mime = item.mime === null ? undefined : normalizeMime(item.mime);
    const mimeLabel = mime ?? "unknown type";
    lines.push(`- ${item.path} (${mimeLabel}, ${item.sizeLabel})`);
  }
  lines.push(ATTACHMENT_FOOTER);
  return lines.join("\n");
}

const HEADER_RE =
  /^\[web-hub attachments\] The user attached (\d+) file\(s\), saved on this machine and kept for at least 24 hours \(7 days once sent\):$/;
const ITEM_LINE_RE = /^- (.+) \(([^,()]*), ([^()]*)\)$/;

/**
 * Parse an attachment block back out of arbitrary text (§3.1), tolerating surrounding prose
 * (the composer prepends the user's own message). Returns `undefined` when no well-formed block
 * is found (header, exactly as many item lines as declared, then the exact footer line) — never
 * throws, never partially parses.
 */
export function parseAttachmentBlock(text: string): AttachmentItem[] | undefined {
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  if (headerIdx === -1) return undefined;
  const headerMatch = HEADER_RE.exec(lines[headerIdx]!)!;
  const count = Number(headerMatch[1]);
  if (!Number.isFinite(count) || count < 0) return undefined;
  const itemLines = lines.slice(headerIdx + 1, headerIdx + 1 + count);
  if (itemLines.length !== count) return undefined;
  const footerLine = lines[headerIdx + 1 + count];
  if (footerLine !== ATTACHMENT_FOOTER) return undefined;

  const items: AttachmentItem[] = [];
  for (const line of itemLines) {
    const m = ITEM_LINE_RE.exec(line);
    if (m === null) return undefined;
    const path = m[1]!;
    const mimeLabel = m[2]!;
    const sizeLabel = m[3]!;
    items.push({ path, mime: mimeLabel === "unknown type" ? null : mimeLabel, sizeLabel });
  }
  return items;
}

// ---------------------------------------------------------------------------
// §2.2.3 meta.json v1 schema
// ---------------------------------------------------------------------------

export interface UploadMetaV1 {
  v: 1;
  id: string;
  principal: string;
  agentKey: string;
  bucket: string;
  /** Canonical client-declared display name (§2.3 `sanitizeUploadName`) — dedup key part and
   *  the record of what the user called the file; never an fs path component. */
  safeName: string;
  /** Actual on-disk file name inside `<id>/` (`<uploadId>.<ext>`, or the bare id). Absent on
   *  metas written before generated disk names (legacy layout: the file sits under `safeName`). */
  diskName?: string;
  size: number;
  mime: string | null;
  sha256: string;
  committedAt: number;
  referencedAt: number | null;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNonNegativeFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Validate + parse an arbitrary JSON value into an `UploadMetaV1` (§2.2.3 crash-consistency
 * contract — only a value that round-trips through this parser counts as "committed"). Never
 * throws; rejects missing fields, wrong types, and any `v` other than exactly `1`.
 */
export function parseUploadMeta(json: unknown): { ok: true; meta: UploadMetaV1 } | { ok: false; error: string } {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, error: "not-an-object" };
  const obj = json as Record<string, unknown>;
  if (obj["v"] !== 1) return { ok: false, error: "bad-version" };
  if (!isNonEmptyString(obj["id"])) return { ok: false, error: "bad-id" };
  if (!isNonEmptyString(obj["principal"])) return { ok: false, error: "bad-principal" };
  if (!isNonEmptyString(obj["agentKey"])) return { ok: false, error: "bad-agentKey" };
  if (!isNonEmptyString(obj["bucket"])) return { ok: false, error: "bad-bucket" };
  if (!isNonEmptyString(obj["safeName"])) return { ok: false, error: "bad-safeName" };
  const diskName = obj["diskName"];
  if (diskName !== undefined && !isNonEmptyString(diskName)) return { ok: false, error: "bad-diskName" };
  if (!isNonNegativeFiniteNumber(obj["size"])) return { ok: false, error: "bad-size" };
  const mime = obj["mime"];
  if (mime !== null && typeof mime !== "string") return { ok: false, error: "bad-mime" };
  if (typeof mime === "string" && normalizeMime(mime) !== mime) return { ok: false, error: "bad-mime" };
  const sha256 = obj["sha256"];
  if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) return { ok: false, error: "bad-sha256" };
  if (!isNonNegativeFiniteNumber(obj["committedAt"])) return { ok: false, error: "bad-committedAt" };
  const referencedAt = obj["referencedAt"];
  if (referencedAt !== null && !isNonNegativeFiniteNumber(referencedAt)) {
    return { ok: false, error: "bad-referencedAt" };
  }
  return {
    ok: true,
    meta: {
      v: 1,
      id: obj["id"] as string,
      principal: obj["principal"] as string,
      agentKey: obj["agentKey"] as string,
      bucket: obj["bucket"] as string,
      safeName: obj["safeName"] as string,
      ...(diskName === undefined ? {} : { diskName }),
      size: obj["size"] as number,
      mime: mime as string | null,
      sha256,
      committedAt: obj["committedAt"] as number,
      referencedAt: referencedAt as number | null,
    },
  };
}
