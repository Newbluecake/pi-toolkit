/**
 * web-hub spawn SP4 (web-hub-spawn plan v2.1 §SP4 / arch v2 §4.4, #9): the rpc stdio
 * protocol end for one managed `pi --mode rpc` child.
 *
 * The hub owns the child's stdin for the child's whole life (EOF is the orderly-shutdown
 * lever, arch §4.2) and must keep draining stdout from the fork instant on — pi's
 * `waitForRawStdoutBackpressure` stalls the child otherwise (`modes/rpc/rpc-mode.js`). This
 * module turns that stdout stream into the only two things the hub ever does with it:
 *
 * - LF-only line framing, byte-exact like pi's `modes/rpc/jsonl.js` (`attachJsonlLineReader`
 *   splits on `\n` only — readline would additionally split on U+2028/U+2029, which are legal
 *   inside JSON strings, so it is never used).
 * - Answering `extension_ui_request` dialogs over stdin so a third-party extension can never
 *   hang the headless child: fire-and-forget methods (`notify`/`setStatus`/`setWidget`/
 *   `setTitle`/`set_editor_text`) are dropped, every dialog method (`select`/`confirm`/
 *   `input`/`editor`) and every UNKNOWN method is answered `{type:"extension_ui_response",
 *   id, cancelled:true}` (S1 decision D9: web-side answering of foreign dialogs is S3), and
 *   the ask_user marker select (`title === RPC_ASK_USER_TITLE`) is HELD for the web dialog
 *   (S1 P2) when `holdAllowed()` says the bound agent is linked and `dialog.v1`-capable.
 *
 * Memory bounds (#9): at most `UI_REQ_HEAD_BYTES` buffered while a line's head is still
 * undecided, at most `STDOUT_LINE_MAX + 1` once the head is known to be a `extension_ui_request`
 * line, and nothing at all otherwise — every byte past a decision or past the cap is dropped,
 * never queued. A `extension_ui_request` line that crosses `STDOUT_LINE_MAX` is answered from
 * its ≤512-byte head via the bounded regex BEFORE `push()` returns (the answer rides the same
 * synchronous stretch in which the line crossed the cap, not the line's trailing newline).
 *
 * Marker-hold fallbacks (arch §4.4, each `MARKER_HOLD_GRACE_MS`): (a) no open item in the
 * bound agent's dialogs slot within 5s of the hold, (b) `linked=false` for 5s, (c) the slot's
 * open items cleared for 5s while held — one unref'd timer per held item tracks the earliest
 * armed deadline. Duplicate answers are harmless on pi's side (unknown ids are ignored,
 * `rpc-mode.js`'s pending map), but this end still answers any id at most once.
 *
 * A head that carries the prefix but no extractable id cannot be correlated at all — protocol
 * error (`failed{protocol_error}` is the supervisor's reaction); reported at most once
 * (latched), since the supervisor stops the child on the first report.
 *
 * `write(line)` receives a complete NDJSON frame INCLUDING its trailing LF. Its `false`
 * return (stream backpressure) needs no handling here: the bytes stay queued in the stream,
 * and a lost answer could only ever delay a dialog until the child exits together with the
 * hub.
 */
import { MARKER_HOLD_GRACE_MS, RPC_ASK_USER_TITLE, STDOUT_LINE_MAX, UI_REQ_HEAD_BYTES } from "../../protocol/spawn.js";

/** arch §4.4 row 1's prefix — `{"type":"extension_ui_request"` (28 ASCII bytes; pi pins `type`
 * first and `id` second, `output({type, id, ...request})` in `rpc-mode.js` — assumption V1). */
const UI_REQ_PREFIX = Buffer.from('{"type":"extension_ui_request"', "utf8");

/**
 * plan SP4's bounded head extractor, verbatim: group 1 `id`, group 2 `method`, group 3 `title`
 * (still the RAW JSON string body — escapes included, decode before comparing to
 * `RPC_ASK_USER_TITLE`). The charsets encode that ids are escape-free, methods are
 * `[a-z_A-Z]{1,32}`, and a title unit is one plain char or one `\\x` escape pair, so the match
 * can never end mid-escape.
 */
const UI_REQ_HEAD_RE =
  /^\{"type":"extension_ui_request","id":"([^"\\]{1,128})"(?:,"method":"([a-z_A-Z]{1,32})")?(?:,"title":"((?:[^"\\]|\\.){0,256})")?/;

/** arch §4.4 method table: never answered (pi emits them fire-and-forget). */
const FIRE_AND_FORGET_METHODS: ReadonlySet<string> = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

/** `uiCancelled[].title` cap (arch §6.4/§8.1: owner-only field, ≤120 chars). */
const UI_CANCEL_TITLE_MAX = 120;

/** Answer-dedupe ring: "same id answered at most once" only needs recent history (ids are
 * UUIDs; a duplicate line from a well-behaved pi is adjacent, from a buggy one bounded). */
const ANSWERED_MAX = 128;

/** Opaque timer handle: the global pair's return type; injected fakes satisfy it structurally. */
export type RpcTimerHandle = ReturnType<typeof setTimeout>;
export type RpcSetTimeout = (fn: () => void, ms: number) => RpcTimerHandle;
export type RpcClearTimeout = (handle: RpcTimerHandle) => void;

export interface RpcStdioDeps {
  /** Writes one complete NDJSON frame INCLUDING the trailing `"\n"` to the child's stdin. */
  write(line: string): boolean;
  /** Every third-party dialog auto-cancel (never the ask_user marker — arch §4.4's table). */
  onUiCancelled(e: { method: string; title?: string; at: number }): void;
  /** Reported at most once (latched); supervisor stops the child (`failed{protocol_error}`). */
  onProtocolError(detail: string): void;
  /** ask_user marker hold gate — supervisor's `linked && getCaps(key).includes("dialog.v1")`. */
  holdAllowed(): boolean;
  now(): number;
  setTimeout?: RpcSetTimeout;
  clearTimeout?: RpcClearTimeout;
}

/** Read-only diagnostics: bounded-buffer assertions and supervisor telemetry. */
export interface RpcStdioStats {
  /** Bytes held for the line currently being assembled (always ≤ `STDOUT_LINE_MAX + 1`). */
  bufferedBytes: number;
  /** Marker selects currently held for the web dialog. */
  held: number;
  /** Distinct ids answered so far (ring of `ANSWERED_MAX`). */
  answered: number;
  /** Protocol errors reported (0 or 1 — latched). */
  protocolErrors: number;
}

export interface RpcStdio {
  /** Feed one stdout `data` chunk; may synchronously answer over-limit dialogs. Never throws. */
  push(chunk: Buffer): void;
  /** Forwarding of the bound agent's `dialogs` bus event; drives the hold fallbacks. */
  onSlot(openCount: number, linked: boolean): void;
  /** Idempotent: clears every hold timer, drops the partial line, freezes all further writes. */
  dispose(): void;
  stats(): RpcStdioStats;
}

interface HeldItem {
  readonly id: string;
  /** §4.4 (a)+(c): the dialogs slot has continuously had no open item since this instant
   * (`undefined` while an open item is present). Armed at hold time when no dialog is open. */
  slotEmptySince: number | undefined;
  /** §4.4 (b): the agent has continuously been unlinked since this instant (`undefined` while linked). */
  unlinkedSince: number | undefined;
  timer: RpcTimerHandle | undefined;
}

export function createRpcStdio(deps: RpcStdioDeps): RpcStdio {
  const setTimer: RpcSetTimeout = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: RpcClearTimeout = deps.clearTimeout ?? ((h) => clearTimeout(h));

  let disposed = false;
  // line assembly (Buffer[] + length count — plan SP4; one line at a time)
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let decided = false; // prefix decision made for the current line
  let isUiLine = false; // current line starts with UI_REQ_PREFIX
  let dropping = false; // rest of the current line is dropped (non-ui, or over-limit handled)
  // dialogs-slot mirror: latest `onSlot` seen; "never seen" is treated like an empty slot, so
  // §4.4 (a) arms at hold time unless a dialog is already open (the dialogs event may race the
  // marker line).
  let lastOpenCount = 0;
  const held = new Map<string, HeldItem>();
  const answered = new Map<string, true>();
  let protocolErrors = 0;

  // ---------------------------------------------------------------- line assembly

  function startLine(): void {
    pending = [];
    pendingLen = 0;
    decided = false;
    isUiLine = false;
    dropping = false;
  }

  function headMatchesPrefix(): boolean {
    return Buffer.concat(pending, UI_REQ_PREFIX.length).equals(UI_REQ_PREFIX);
  }

  /** Accumulates one newline-free segment of the current line, deciding the prefix at
   * `UI_REQ_HEAD_BYTES` and processing over-limit ui lines at the crossing (before return). */
  function accumulate(seg: Buffer): void {
    let pos = 0;
    while (pos < seg.length) {
      if (!decided) {
        const room = UI_REQ_HEAD_BYTES - pendingLen;
        if (room > 0) {
          const take = Math.min(room, seg.length - pos);
          pending.push(seg.subarray(pos, pos + take));
          pendingLen += take;
          pos += take;
        }
        if (pendingLen < UI_REQ_HEAD_BYTES) return; // head still incomplete — wait for bytes
        decided = true;
        isUiLine = headMatchesPrefix();
        if (!isUiLine) {
          // §4.4 row 1: not a ui_request line — events travel the agent socket channel; drop.
          pending = [];
          pendingLen = 0;
          dropping = true;
          return;
        }
        continue; // known ui line: the same segment now accumulates toward the line cap
      }
      if (!isUiLine) return; // decided non-ui: nothing to keep
      const room = STDOUT_LINE_MAX + 1 - pendingLen;
      if (room > 0) {
        const take = Math.min(room, seg.length - pos);
        pending.push(seg.subarray(pos, pos + take));
        pendingLen += take;
        pos += take;
      }
      if (pendingLen <= STDOUT_LINE_MAX) return; // line continues (or sits exactly at cap)
      handleOverLimitLine(); // sets dropping, clears pending
      return; // everything past the cap is dropped
    }
  }

  function push(chunk: Buffer): void {
    if (disposed) return;
    let pos = 0;
    while (pos < chunk.length) {
      if (dropping) {
        const nl = chunk.indexOf(10, pos);
        if (nl === -1) return;
        startLine();
        pos = nl + 1;
        continue;
      }
      const nl = chunk.indexOf(10, pos);
      const end = nl === -1 ? chunk.length : nl;
      if (end > pos) accumulate(chunk.subarray(pos, end));
      if (nl === -1) return;
      if (!dropping) finishLine(); // dropping already handled this line (non-ui / over-limit)
      startLine();
      pos = nl + 1;
    }
  }

  // ---------------------------------------------------------------- ui line handling

  /** Complete ui line in `pending` (`pendingLen` ≤ `STDOUT_LINE_MAX`). */
  function finishLine(): void {
    if (!decided) {
      decided = true;
      isUiLine = headMatchesPrefix();
    }
    if (!isUiLine) return;
    const text = Buffer.concat(pending).toString("utf8");
    let id: string | undefined;
    let method: string | undefined;
    let title: string | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      id = propString(parsed, "id");
      method = propString(parsed, "method");
      title = propString(parsed, "title");
    } catch {
      // malformed beyond the head (e.g. a stray trailing comma) — rescue via the bounded regex
    }
    if (id === undefined || id === "") {
      const m = UI_REQ_HEAD_RE.exec(Buffer.concat(pending).subarray(0, UI_REQ_HEAD_BYTES).toString("utf8"));
      if (m !== null) {
        id = m[1];
        if (method === undefined) method = m[2];
        if (title === undefined) title = decodeJsonStringBody(m[3]);
      }
    }
    if (id === undefined || id === "") {
      reportProtocolError("ui-request-head");
      return;
    }
    handleUiRequest(id, method, title);
  }

  /** §4.4 row 3 (#9 hard gate): ui line crossed `STDOUT_LINE_MAX` — answer from the head NOW. */
  function handleOverLimitLine(): void {
    const headText = Buffer.concat(pending).subarray(0, UI_REQ_HEAD_BYTES).toString("utf8");
    pending = [];
    pendingLen = 0;
    dropping = true;
    const m = UI_REQ_HEAD_RE.exec(headText);
    const id = m === null ? undefined : m[1];
    if (m === null || id === undefined) {
      reportProtocolError("ui-request-head");
      return;
    }
    handleUiRequest(id, m[2], decodeJsonStringBody(m[3]));
  }

  function handleUiRequest(id: string, method: string | undefined, title: string | undefined): void {
    if (answered.has(id) || held.has(id)) return; // one answer per id — duplicates need no work
    if (method !== undefined && FIRE_AND_FORGET_METHODS.has(method)) return;
    if (method === "select" && title === RPC_ASK_USER_TITLE) {
      holdMarker(id);
      return;
    }
    answerCancelled(id); // dialog methods, unknown methods — D9: always cancelled in S1
    recordUiCancelled(method ?? "unknown", title);
  }

  function holdMarker(id: string): void {
    if (!deps.holdAllowed()) {
      answerCancelled(id); // no dialog.v1 / unlinked — the web dialog can never take it
      return;
    }
    const item: HeldItem = {
      id,
      slotEmptySince: lastOpenCount > 0 ? undefined : deps.now(), // §4.4 (a)
      unlinkedSince: undefined,
      timer: undefined,
    };
    held.set(id, item);
    armTimer(item);
  }

  function answerCancelled(id: string): void {
    if (answered.has(id)) return;
    answered.set(id, true);
    if (answered.size > ANSWERED_MAX) {
      const oldest = answered.keys().next();
      if (!oldest.done) answered.delete(oldest.value);
    }
    deps.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`);
  }

  function recordUiCancelled(method: string, title: string | undefined): void {
    const e: { method: string; title?: string; at: number } = { method, at: deps.now() };
    if (title !== undefined) {
      e.title = title.length > UI_CANCEL_TITLE_MAX ? title.slice(0, UI_CANCEL_TITLE_MAX) : title;
    }
    deps.onUiCancelled(e);
  }

  function reportProtocolError(detail: string): void {
    if (protocolErrors > 0) return; // latched — supervisor stops the child on the first report
    protocolErrors = 1;
    deps.onProtocolError(detail);
  }

  // ---------------------------------------------------------------- slot events & hold timers

  function onSlot(openCount: number, linked: boolean): void {
    if (disposed) return;
    lastOpenCount = openCount;
    if (held.size === 0) return;
    const t = deps.now();
    for (const item of held.values()) {
      let changed = false;
      if (openCount > 0) {
        if (item.slotEmptySince !== undefined) {
          item.slotEmptySince = undefined; // open item present: (a)/(c) satisfied
          changed = true;
        }
      } else if (item.slotEmptySince === undefined) {
        item.slotEmptySince = t; // §4.4 (c): cleared while held
        changed = true;
      }
      if (linked) {
        if (item.unlinkedSince !== undefined) {
          item.unlinkedSince = undefined;
          changed = true;
        }
      } else if (item.unlinkedSince === undefined) {
        item.unlinkedSince = t; // §4.4 (b)
        changed = true;
      }
      if (changed) armTimer(item);
    }
  }

  /** (Re)arms the item's single timer to the earliest armed fallback deadline. */
  function armTimer(item: HeldItem): void {
    if (item.timer !== undefined) {
      clearTimer(item.timer);
      item.timer = undefined;
    }
    if (disposed) return;
    let deadline: number | undefined;
    if (item.slotEmptySince !== undefined) deadline = item.slotEmptySince + MARKER_HOLD_GRACE_MS;
    if (item.unlinkedSince !== undefined) {
      const d = item.unlinkedSince + MARKER_HOLD_GRACE_MS;
      if (deadline === undefined || d < deadline) deadline = d;
    }
    if (deadline === undefined) return;
    const handle = setTimer(() => onItemTimer(item), Math.max(0, deadline - deps.now()));
    handle.unref?.();
    item.timer = handle;
  }

  function onItemTimer(item: HeldItem): void {
    item.timer = undefined;
    if (disposed || !held.has(item.id)) return;
    const t = deps.now();
    const slotDue = item.slotEmptySince !== undefined && t >= item.slotEmptySince + MARKER_HOLD_GRACE_MS;
    const unlinkDue = item.unlinkedSince !== undefined && t >= item.unlinkedSince + MARKER_HOLD_GRACE_MS;
    if (!slotDue && !unlinkDue) {
      armTimer(item); // state moved between scheduling and firing — re-arm defensively
      return;
    }
    held.delete(item.id);
    answerCancelled(item.id); // marker fallback: no uiCancelled record (arch §4.4 table)
  }

  // ---------------------------------------------------------------- teardown

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const item of held.values()) {
      if (item.timer !== undefined) clearTimer(item.timer);
      item.timer = undefined;
    }
    held.clear();
    startLine();
  }

  function stats(): RpcStdioStats {
    return { bufferedBytes: pendingLen, held: held.size, answered: answered.size, protocolErrors };
  }

  return { push, onSlot, dispose, stats };
}

// ---------------------------------------------------------------- small pure helpers

/** `Reflect.get`-based field read: narrows `unknown` without any cast (`hub/spawn/**` is zero-`as`). */
function propString(v: unknown, key: string): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const value: unknown = Reflect.get(v, key);
  return typeof value === "string" ? value : undefined;
}

/** Decodes a regex-captured JSON string body (escapes included, e.g. the marker's
 * `\u0000XYZ_ASK_USER`) back to its real characters; advisory only, so a body that is not
 * strict JSON (raw control chars) just yields `undefined`. */
function decodeJsonStringBody(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(`"${raw}"`);
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}
