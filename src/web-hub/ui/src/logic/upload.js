/**
 * Composer upload pure helpers (web-hub-upload plan §包 U4a — `docs/dev/web-hub-upload/plan.md`
 * §3/§3.2, §4.1–§4.3, §5.1). No DOM, no I/O: every function here runs unchanged under vitest
 * (node) and in the browser, same discipline as `./control.js`. The DOM-adjacent half (paste
 * handlers, tray rendering, the actual fetch transport) lives in U4b's `composables/useUploads.ts`
 * and U5's `Composer.vue`/`AttachmentTray.vue`; those only ever call into this module.
 *
 * - `classifyPaste(dt)` / `collectDrop(dt)` — classify a `DataTransfer`-shaped value (§4.1's
 *   paste/drop entries) into plain data. They READ the duck-typed `items`/`files`/`types`
 *   accessors only — never touch the DOM, never call `preventDefault` themselves.
 * - `fileFingerprint(file)` — §2.5's tray-side dedup key (`name+size+lastModified+type`).
 * - `pastedName(mime, at, seq)` — §2.3's `pasted-YYYYMMDD-HHMMSS[-n].<ext>` rename for
 *   screenshots / nameless blobs.
 * - `attachmentReduce(item, event)` — the §4.2 tray state machine
 *   `queued → uploading(%) → ready | failed(原因, 可重试)` plus `removing`, in the same
 *   `next | same (no-op) | null (remove)` style as `control.js`'s `pendingTransition`.
 * - `planChunks(size, chunkBytes, received)` / `chunkBytesFor(kind)` — §1.3's chunk planner.
 *   The two tier sizes are imported from the protocol module (never copied); the effective
 *   size is whatever `begin` replies, `chunkBytesFor` is only for tests/fallback display.
 * - `composePrompt(text, attachments)` — §3.1's `<正文>\n\n<attachment block>` composition
 *   (delegates to the protocol's `formatAttachmentBlock`/`formatAttachmentSize`).
 * - `canSendWithAttachments(params)` — §3.2's `sendGate()` pure judgment.
 * - `uploadAvailability({ hubCaps, card, authMode })` — §5.1's capability gate.
 * - `utf8Len(s)` — shared UTF-8 byte length (the 48 KiB gate is byte-based, not char-based).
 *
 * Cross-layer imports use the literal `.ts` extension (`@protocol/upload.ts`) — the same
 * `.js`-importer constraint `./contract.js` documents: Vite/esbuild only remap `./foo.js` →
 * `./foo.ts` for a `.ts`/`.vue` importer, so a plain `.js` module must spell `.ts` out.
 */
import { parseSlash } from "./control.js";
import {
  UPLOAD_CHUNK_BYTES_LAN,
  UPLOAD_CHUNK_BYTES_LOOPBACK,
  formatAttachmentBlock,
  formatAttachmentSize,
} from "@protocol/upload.ts";
import { UPLOAD_HUB_CAPS } from "@protocol/version.ts";

/**
 * UI-side mirror of the hub's `/api/cmd` text cap (`PROMPT_TEXT_MAX_BYTES`, hub/http.ts — 48 KiB).
 * The real constant lives in a hub-only module this browser bundle must not import, so it is
 * restated here once and pinned by test; §3.2's gate ("拼接后 UTF-8 ≤ 48 KiB") checks against it.
 */
export const PROMPT_MAX_UTF8_BYTES = 48 * 1024;

const encoder = new TextEncoder();

/** UTF-8 byte length of `s` (0 for non-strings). Lone surrogates encode as U+FFFD per WHATWG. */
export function utf8Len(s) {
  return typeof s === "string" ? encoder.encode(s).length : 0;
}

// ---------------------------------------------------------------------------
// §4.1 entry classification (paste / drop)
// ---------------------------------------------------------------------------

/** Array-ish `DataTransferItemList`/`FileList` → plain array (both are index+length, not iterable). */
function arrayish(list) {
  if (!list || typeof list.length !== "number") return null;
  const out = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

function filesFromItems(dt) {
  const items = arrayish(dt?.items);
  const files = [];
  for (const it of items ?? []) {
    if (it && it.kind === "file" && typeof it.getAsFile === "function") {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length > 0) return files;
  // Fallback (§4.1): items missing or yielded nothing (some engines only fill `dt.files`).
  const listed = arrayish(dt?.files) ?? [];
  return listed.filter((f) => f);
}

function hasPlainText(dt) {
  const types = arrayish(dt?.types) ?? [];
  if (types.includes("text/plain")) return true;
  const items = arrayish(dt?.items) ?? [];
  return items.some((it) => it && it.kind === "string" && it.type === "text/plain");
}

/**
 * §4.1 paste classification. Pure: reads the `DataTransfer`, returns a decision record — the
 * Vue handler owns `event.preventDefault()`. Three situations:
 *  - no files ⇒ do not intervene at all (`preventDefault:false`, empty `files`);
 *  - files, no `text/plain` ⇒ `preventDefault:true` — every file becomes an attachment;
 *  - files AND text (Office/table copies, Finder file names) ⇒ `preventDefault:false` — the
 *    text pastes normally AND the files become attachments (pinned by test).
 * Raw files only: tray admission (size/count caps, dedup) is `useUploads`'s job, not ours.
 * @param {any} dt
 * @returns {{ files: unknown[], hasText: boolean, preventDefault: boolean }}
 */
export function classifyPaste(dt) {
  const files = filesFromItems(dt);
  const hasText = hasPlainText(dt);
  if (files.length === 0) return { files: [], hasText, preventDefault: false };
  return { files, hasText, preventDefault: !hasText };
}

/**
 * §4.1 drop classification. Any `webkitGetAsEntry()?.isDirectory` entry rejects the WHOLE drop
 * (`{ ok:false, reason:"directory", names }` — the composer shows the 拒收 hint; partial
 * acceptance would silently drop the directory itself). Without `items` (engine filled
 * `dt.files` only) no directory detection is possible and the files pass through as-is.
 * @param {any} dt
 * @returns {{ ok: true, files: unknown[] } | { ok: false, reason: "directory", names: string[] }}
 */
export function collectDrop(dt) {
  const items = arrayish(dt?.items);
  const directories = [];
  const files = [];
  for (const it of items ?? []) {
    if (!it) continue;
    let entry = null;
    if (typeof it.webkitGetAsEntry === "function") {
      try {
        entry = it.webkitGetAsEntry();
      } catch {
        entry = null;
      }
    }
    if (entry && entry.isDirectory) {
      if (typeof entry.name === "string" && entry.name !== "") directories.push(entry.name);
      continue;
    }
    if (it.kind === "file" && typeof it.getAsFile === "function") {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (directories.length > 0) return { ok: false, reason: "directory", names: directories };
  if (files.length > 0) return { ok: true, files };
  const listed = arrayish(dt?.files) ?? [];
  return { ok: true, files: listed.filter((f) => f) };
}

// ---------------------------------------------------------------------------
// §2.5 fingerprint / §2.3 pasted-file naming
// ---------------------------------------------------------------------------

/**
 * §2.5 tray dedup key: the same `File` (`name+size+lastModified+type`) added to the same agent's
 * tray twice keeps only one entry. JSON tuple so no field can bleed into the next; `""` for
 * non-file-ish junk (no string `name` / finite numeric `size`) — the caller skips falsy
 * fingerprints instead of deduping every malformed value against each other.
 * @param {any} file
 * @returns {string}
 */
export function fileFingerprint(file) {
  if (!file || typeof file !== "object" || typeof file.name !== "string" || !Number.isFinite(file.size)) {
    return "";
  }
  return JSON.stringify([file.name, file.size, file.lastModified, file.type]);
}

/** Own-property check (es2020 build target — `Object.hasOwn` is ES2022, same call as useI18n.ts). */
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** §2.3: ext for an already-validated mime; anything unmapped (incl. no mime) ⇒ `bin`. */
const PASTED_EXT_BY_MIME = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
  "text/plain": "txt",
});

/**
 * §2.3: `pasted-YYYYMMDD-HHMMSS[-n].<ext>` for screenshots/nameless blobs (local time — the name
 * is for humans; the hub re-sanitizes anyway). `-n` only from `seq` 2 up (disambiguates several
 * pastes within one second); an invalid/absent `at` degrades to the epoch, never throws.
 * @param {string | null | undefined} mime @param {number | Date} [at] @param {number} [seq]
 * @returns {string}
 */
export function pastedName(mime, at = Date.now(), seq = 1) {
  const raw = at instanceof Date ? at.getTime() : at;
  const d = new Date(Number.isFinite(raw) ? raw : 0);
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${String(d.getFullYear()).padStart(4, "0")}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(
    d.getHours(),
  )}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const n = Number.isInteger(seq) && seq >= 2 ? `-${seq}` : "";
  const ext = typeof mime === "string" && hasOwn(PASTED_EXT_BY_MIME, mime) ? PASTED_EXT_BY_MIME[mime] : "bin";
  return `pasted-${stamp}${n}.${ext}`;
}

// ---------------------------------------------------------------------------
// §1.3 chunk planning
// ---------------------------------------------------------------------------

/** §1.3 tier sizes, imported from the protocol (never restated). Guarded lookup (no prototype bleed). */
const CHUNK_TIER_BYTES = Object.freeze({
  loopback: UPLOAD_CHUNK_BYTES_LOOPBACK,
  lan: UPLOAD_CHUNK_BYTES_LAN,
});

/**
 * §1.3's two chunk tiers for tests/fallback display: `"loopback"` ⇒ 4 MiB, `"lan"` ⇒ 1 MiB,
 * anything else ⇒ `undefined`. The effective size is always the `begin` reply's `chunkBytes`.
 * @param {unknown} kind
 * @returns {number | undefined}
 */
export function chunkBytesFor(kind) {
  return hasOwn(CHUNK_TIER_BYTES, kind) ? CHUNK_TIER_BYTES[kind] : undefined;
}

/**
 * §1.3 chunk planner: `[{offset, bytes}]` covering `received..size`, every chunk ≤ `chunkBytes`
 * (the last one may be short). `received` is the `begin`/`chunk` reply's authoritative offset —
 * resume planning starts there, never at 0. Malformed numbers refuse (`{ok:false,reason}`) rather
 * than silently mis-slicing a `Blob`.
 * @param {unknown} size @param {unknown} chunkBytes @param {number} [received]
 * @returns {{ ok: true, chunks: Array<{ offset: number, bytes: number }>, remaining: number }
 *   | { ok: false, reason: "size" | "chunk-bytes" | "received" }}
 */
export function planChunks(size, chunkBytes, received = 0) {
  if (!Number.isInteger(size) || size < 0) return { ok: false, reason: "size" };
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) return { ok: false, reason: "chunk-bytes" };
  if (!Number.isInteger(received) || received < 0 || received > size) return { ok: false, reason: "received" };
  const chunks = [];
  let offset = received;
  while (offset < size) {
    const bytes = Math.min(chunkBytes, size - offset);
    chunks.push({ offset, bytes });
    offset += bytes;
  }
  return { ok: true, chunks, remaining: size - received };
}

// ---------------------------------------------------------------------------
// §4.2/§4.3 attachment tray state machine
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, name: string, size: number, mime: string | null,
 *   state: "queued" | "uploading" | "ready" | "failed" | "removing",
 *   uploadedBytes?: number, path?: string, error?: string, retryable?: boolean,
 *   message?: string }} Attachment
 *
 * @typedef {{ type: "start" }
 *   | { type: "progress", received: number }
 *   | { type: "committed", path: string, size?: number, mime?: string | null }
 *   | { type: "error", error: string, retryable?: boolean, message?: string }
 *   | { type: "retry", id: string }
 *   | { type: "removing" }
 *   | { type: "removed" }} AttachmentEvent
 */

/** @param {Attachment} item @param {Record<string, unknown>} patch @returns {Attachment} */
function patchAttachment(item, patch) {
  return { ...item, ...patch };
}

/**
 * §4.2/§4.3 tray state machine (the reducer `useUploads` drives; UI state only, never in the
 * SSE reducer). Returns the next item, the SAME item when the event is a no-op for its state
 * (unknown events, junk items, and everything hitting a `removing` item — an abort is in flight,
 * late transport events must not resurrect it), or `null` for `removed`.
 *
 * `queued →(start)→ uploading →(committed)→ ready`; `queued|uploading|ready →(error)→ failed`
 * (`ready → error` is the `E_UPLOAD_GONE` path — the committed file was evicted before the prompt
 * landed, the tray shows 「附件已被清理，请重新上传」); `failed →(retry, NEW id)→ queued`
 * (§4.3: 404 作废 ⇒ retry starts over with a fresh id — the reducer swaps `id` in, staying pure);
 * any live state `→(removing)→ removing`; `removed` from ANY state ⇒ `null`.
 *
 * `progress.received` doubles as the resume offset: the `begin` idempotent reply's `received`
 * goes through here too (no separate resume event). It is clamped to `0..size` and never moves
 * backwards (dup/409-offset replies must not flicker the bar).
 *
 * @param {Attachment} item @param {AttachmentEvent} event
 * @returns {Attachment | null}
 */
export function attachmentReduce(item, event) {
  if (!item || !event || typeof event.type !== "string") return item;
  switch (event.type) {
    case "start":
      return item.state === "queued"
        ? patchAttachment(item, { state: "uploading", uploadedBytes: 0, error: undefined, message: undefined })
        : item;
    case "progress": {
      if (item.state !== "uploading" || !Number.isFinite(event.received)) return item;
      const size = Number.isFinite(item.size) ? item.size : Number.POSITIVE_INFINITY;
      const received = Math.min(Math.max(event.received, 0), Math.max(size, 0));
      const uploadedBytes = Math.max(item.uploadedBytes ?? 0, received);
      return uploadedBytes === (item.uploadedBytes ?? 0) ? item : patchAttachment(item, { uploadedBytes });
    }
    case "committed": {
      if (item.state !== "uploading" || typeof event.path !== "string") return item;
      const size = Number.isFinite(event.size) ? event.size : item.size;
      return patchAttachment(item, {
        state: "ready",
        path: event.path,
        size,
        mime: typeof event.mime === "string" ? event.mime : null,
        uploadedBytes: size,
        error: undefined,
        message: undefined,
      });
    }
    case "error": {
      // Only queued/uploading/ready can fail — a `removing` item (abort in flight, header) and
      // an already-`failed` item (keep the first error) swallow late transport errors.
      if (item.state !== "queued" && item.state !== "uploading" && item.state !== "ready") return item;
      // `ready → error` is the E_UPLOAD_GONE path: the committed file was evicted before the
      // prompt landed (§2.6) — the tray shows 「附件已被清理，请重新上传」 and retry re-uploads
      // the still-held File from scratch. `queued`/`uploading` errors are the transport's
      // 404/作废/网络 mappings (§4.3).
      return patchAttachment(item, {
        state: "failed",
        error: typeof event.error === "string" ? event.error : "E_INTERNAL",
        retryable: event.retryable !== false,
        ...(typeof event.message === "string" ? { message: event.message } : { message: undefined }),
      });
    }
    case "retry": {
      if (item.state !== "failed" || typeof event.id !== "string" || event.id === "") return item;
      return patchAttachment(item, {
        id: event.id,
        state: "queued",
        uploadedBytes: 0,
        path: undefined,
        error: undefined,
        retryable: undefined,
        message: undefined,
      });
    }
    case "removing":
      return item.state === "removing"
        ? item
        : patchAttachment(item, { state: "removing", error: undefined, message: undefined });
    case "removed":
      return null;
    default:
      return item;
  }
}

// ---------------------------------------------------------------------------
// §3.1 prompt composition
// ---------------------------------------------------------------------------

/**
 * @typedef {{ path: string, mime?: string | null, size?: number }} ReadyAttachment
 * @typedef {{ ok: true, text: string, bytes: number }
 *   | { ok: false, reason: "attachment-block" | "too-large", bytes?: number }} ComposeResult
 */

/**
 * §3.1: `<用户正文>` + blank line + the fixed-English attachment block; empty/whitespace-only
 * body ⇒ the block alone (still a non-empty prompt for `/api/cmd`). Size labels come from the
 * protocol's `formatAttachmentSize`; `formatAttachmentBlock` re-validates mime itself.
 *
 * `formatAttachmentBlock` can refuse (`undefined`) — a `path` containing a newline, or a size
 * label with control chars/parens. Refusal maps to `{ ok:false, reason:"attachment-block" }`:
 * the attachment block is NEVER silently dropped (sending the bare text would tell the model
 * about files it cannot read — a lie worse than a blocked send). In practice this only triggers
 * on a hub-returned `path` containing `\n`/`\r` (§3.1: the hub disables uploads for such roots,
 * so this is defense in depth), since the size label is always our own `formatAttachmentSize`
 * output. `canSendWithAttachments` turns this reason into a blocked send.
 *
 * The 48 KiB cap (§3.2's 「拼接后 UTF-8 ≤ 48 KiB」) is enforced HERE, on the composed text —
 * including the no-attachment case (a text-only prompt over the cap is equally rejected by the
 * hub's `PROMPT_TEXT_MAX_BYTES`). A malformed entry in `attachments` (non-object, missing
 * string `path`) also refuses with `attachment-block` — same never-silently-drop rule: junk
 * surfaces as a blocked send instead of a prompt that quietly ignores an attachment.
 *
 * @param {unknown} text @param {ReadonlyArray<ReadyAttachment>} [attachments]
 * @returns {ComposeResult}
 */
export function composePrompt(text, attachments = []) {
  const body = typeof text === "string" ? text : "";
  const ready = Array.isArray(attachments) ? attachments : [];
  for (const a of ready) {
    if (!a || typeof a.path !== "string") return { ok: false, reason: "attachment-block" };
  }
  if (ready.length === 0) {
    const bytes = utf8Len(body);
    return bytes > PROMPT_MAX_UTF8_BYTES ? { ok: false, reason: "too-large", bytes } : { ok: true, text: body, bytes };
  }
  const block = formatAttachmentBlock(
    ready.map((a) => ({
      path: a.path,
      mime: typeof a.mime === "string" ? a.mime : null,
      sizeLabel: formatAttachmentSize(Number.isFinite(a.size) ? a.size : 0),
    })),
  );
  if (block === undefined) return { ok: false, reason: "attachment-block" };
  const composed = body.trim() === "" ? block : `${body}\n\n${block}`;
  const bytes = utf8Len(composed);
  return bytes > PROMPT_MAX_UTF8_BYTES
    ? { ok: false, reason: "too-large", bytes }
    : { ok: true, text: composed, bytes };
}

// ---------------------------------------------------------------------------
// §3.2 sendGate / §5.1 availability
// ---------------------------------------------------------------------------

/**
 * @typedef {{ enabled?: boolean, sending?: boolean, text?: string, attachments?: Attachment[],
 *   commandRouted?: boolean, policy?: "allow" | "confirm" | "deny" | null }} SendGateParams
 * @typedef {{ ok: true, text: string, bytes: number }
 *   | { ok: false, reason: "disabled" | "sending" | "empty" | "queued" | "uploading" | "failed"
 *     | "command-attachments" | "command-policy" | "attachment-block" | "too-large",
 *     bytes?: number }} SendGateResult
 */

/**
 * §3.2's `sendGate()` as a pure judgment (Composer.vue delegates here; button `:disabled`,
 * `doSend`'s first line, and the keyboard path must all see the same answer). Conjunction, in
 * formula order — the first violated clause becomes `reason`:
 *
 *  `enabled` ∧ ¬`sending` ∧（正文非空 ∨ 有 ready 附件）∧ 托盘无 `queued`/`uploading`/`failed`
 *  ∧（命令模式 ⇒ 无附件 且 policy ∈ allow/confirm）∧ 拼接后 UTF-8 ≤ 48 KiB.
 *
 * - The tray clause (v3 review + author ruling): every item that the post-send tray clear would
 *   discard against the user's intent blocks — `queued` (waiting for a slot), `uploading`,
 *   `failed` (needs retry/remove). Only `removing` is exempt (already being discarded, and it
 *   is not composed into the block). Reason = the first blocking item's state, in tray order.
 * - `commandRouted` is DetailDock's actual routing (`parseSlash(text) !== undefined &&
 *   commandsEnabled`, `sendAsText` deliberately NOT part of it — `Composer.vue`'s narrower
 *   `commandMode` would let a `//`-escaped "/foo" + attachment through, but DetailDock.onSend
 *   re-runs parseSlash and would execute it as a command with the block glued into its args).
 *   When omitted the gate falls back to `parseSlash(text) !== undefined` (conservative: blocks).
 *   Command mode blocks attachments outright (「附件只能随普通消息发送」) and folds the old
 *   `policy === "deny"` keyboard early-exit into `command-policy`.
 * - On success the composed text/bytes ride along so `doSend` emits exactly what was gated
 *   (compose once, never twice — the two could drift between calls).
 *
 * @param {SendGateParams} params
 * @returns {SendGateResult}
 */
export function canSendWithAttachments(params = {}) {
  const { enabled, sending, text, attachments, commandRouted, policy } = params;
  if (enabled !== true) return { ok: false, reason: "disabled" };
  if (sending === true) return { ok: false, reason: "sending" };
  const body = typeof text === "string" ? text : "";
  const tray = Array.isArray(attachments) ? attachments.filter((a) => a && typeof a.state === "string") : [];
  const ready = tray.filter((a) => a.state === "ready");
  if (body.trim() === "" && ready.length === 0) return { ok: false, reason: "empty" };
  const blocking = tray.find((a) => a.state === "queued" || a.state === "uploading" || a.state === "failed");
  if (blocking) return { ok: false, reason: blocking.state };
  const routed = commandRouted === undefined ? parseSlash(body) !== undefined : commandRouted === true;
  if (routed) {
    if (tray.length > 0) return { ok: false, reason: "command-attachments" };
    if (policy !== "allow" && policy !== "confirm") return { ok: false, reason: "command-policy" };
  }
  const composed = composePrompt(body, ready);
  if (!composed.ok) return { ok: false, reason: composed.reason, bytes: composed.bytes };
  return { ok: true, text: composed.text, bytes: composed.bytes };
}

/**
 * §5.1 capability gate for the three composer entries (§4.1: false ⇒ all three disabled).
 * The hub must advertise every cap in `UPLOAD_HUB_CAPS`; the agent card must advertise
 * `upload` (`upload.v1`), and on LAN (`authMode:"password"`) additionally `uploadLan`
 * (`upload.lan.v1` — an agent with `webHub.uploads:"loopback"` advertises only `upload.v1`,
 * so LAN gets no entry). Unknown/absent auth modes are unavailable, never a lucky default.
 * @param {{ hubCaps?: unknown, card?: any, authMode?: unknown }} [p]
 * @returns {boolean}
 */
export function uploadAvailability(p = {}) {
  const { hubCaps, card, authMode } = p;
  if (!Array.isArray(hubCaps)) return false;
  if (!UPLOAD_HUB_CAPS.every((c) => hubCaps.includes(c))) return false;
  if (authMode === "token") return card?.upload === true;
  if (authMode === "password") return card?.upload === true && card?.uploadLan === true;
  return false;
}
