/**
 * Per-agent attachment-tray driver (web-hub-upload plan §4.3/§4.2, package U4b —
 * `docs/dev/web-hub-upload/plan.md`). Owns everything `@logic/upload.js` (U4a, frozen)
 * deliberately does not, per U4a's own header ("tray admission … is `useUploads`'s job"):
 *
 * - **admission** — `UPLOAD_ATTACH_MAX_PER_MSG` count cap, `UPLOAD_FILE_MAX_BYTES` size cap,
 *   `fileFingerprint` dedup (§2.5's tray-side rule: the same `File` twice keeps one entry);
 * - **scheduling** — at most `MAX_CONCURRENT_UPLOADS` files per agent (§4.3: 每agent同时2个
 *   文件; two visible agents stay inside the hub's per-principal in-flight cap of 4, §2.4),
 *   chunks strictly sequential within a file;
 * - **the transport loop** — `begin` → `chunk`… → `commit` through `transport.upload`, with
 *   §4.3's resume rules: `begin`'s idempotent `received` (re-)plans via `planChunks`; a chunk
 *   timeout/network failure re-`begin`s for the authoritative `received` (same offset at most
 *   `MAX_CHUNK_ATTEMPTS` times); 404/`E_NOT_FOUND` (voided upload or hub restart — U3 hard
 *   gate 5) fails the item, and `retry()` starts over under a FRESH id (exactly the reducer's
 *   `retry` transition); a 409 `E_UPLOAD_OFFSET` reply's `received` resyncs without burning an
 *   attempt (§2.5: the hub's offset is authoritative, so progress is guaranteed each resync).
 *
 * Every state change flows through U4a's `attachmentReduce` — the reducer stays the single
 * behavioral source of truth; this module only dispatches events at it and never touches tray
 * items directly. Tray state is Composer-local UI state (§4.3: survives agent switches, lost
 * on refresh — no localStorage, `source-scan.test.ts` rule unchanged).
 *
 * No timers live here by design: §4.3 prescribes no intra-file backoff (the hub-side token
 * bucket rate-limits), and E_BUSY backoff lives inside the transports (password-client's
 * existing BUSY_RETRY machinery, mirrored in token-client) — so the whole driver is
 * synchronous-scheduling + `await`-driven, and `dispose()` is the only teardown path.
 */
import { shallowRef, type ShallowRef } from "vue";
import { newCmdId } from "@logic/control.js";
import { attachmentReduce, fileFingerprint, planChunks } from "@logic/upload.js";
import { UPLOAD_ATTACH_MAX_PER_MSG, UPLOAD_FILE_MAX_BYTES } from "@protocol/upload.js";
import type { AddRejectReason, Attachment, UploadsHandle } from "../types.js";
import type { UploadOutcomeErr, UploadTransport } from "../transport/types.js";

/** §4.3: 每agent同时2个文件 (chunks stay sequential inside each file). */
export const MAX_CONCURRENT_UPLOADS = 2;
/** §4.3: 同块最多 3 次 — attempts of one offset before the item fails with the transient error. */
export const MAX_CHUNK_ATTEMPTS = 3;

/** Duck-typed tray source: a browser `File`/`Blob`, or anything with the same surface. */
export interface UploadSource {
  readonly name: string;
  readonly size: number;
  readonly type?: string;
  readonly lastModified?: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

type Abortish = { signal: AbortSignal; abort(): void };

export interface UploadsOptions {
  upload: UploadTransport;
  /** Id generator — defaults to `newCmdId` (K18: `getRandomValues`, never `randomUUID`). */
  newId?(): string;
  /** Injectable for tests; defaults to the global `AbortController`. */
  AbortController?: new () => Abortish;
}

interface AgentTray {
  tray: ShallowRef<Attachment[]>;
  /** attachment id → source file (kept for `retry` — a failed item re-uploads from scratch). */
  files: Map<string, UploadSource>;
  running: Set<string>;
  /** Ids whose `begin` was ever sent — only those can have server-side state to `abort`. */
  serverKnown: Set<string>;
  controllers: Map<string, Abortish>;
}

function isUploadSource(f: unknown): f is UploadSource {
  if (f === null || typeof f !== "object") return false;
  const o = f as { name?: unknown; size?: unknown; slice?: unknown };
  return (
    typeof o.name === "string" &&
    typeof o.size === "number" &&
    Number.isInteger(o.size) &&
    o.size >= 0 &&
    typeof o.slice === "function"
  );
}

/** `received`-like values → a planner-safe offset inside `0..size` (junk ⇒ 0). */
function clampReceived(v: unknown, size: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), size) : 0;
}

async function readSlice(file: UploadSource, offset: number, length: number): Promise<Uint8Array> {
  const buf = await file.slice(offset, offset + length).arrayBuffer();
  return new Uint8Array(buf);
}

export function createUploads(opts: UploadsOptions): UploadsHandle {
  const upload = opts.upload;
  const newId = opts.newId ?? newCmdId;
  const AC = opts.AbortController ?? (typeof AbortController === "function" ? AbortController : undefined);
  const agents = new Map<string, AgentTray>();

  function trayOf(agentKey: string): AgentTray {
    let a = agents.get(agentKey);
    if (a === undefined) {
      a = {
        tray: shallowRef<Attachment[]>([]),
        files: new Map(),
        running: new Set(),
        serverKnown: new Set(),
        controllers: new Map(),
      };
      agents.set(agentKey, a);
    }
    return a;
  }

  /** Run one event through U4a's reducer at the item, publishing the new array. Returns the
   * item's next state (`undefined` when the id is unknown, `null` when it was removed). */
  function applyEvent(
    agentKey: string,
    id: string,
    event: Parameters<typeof attachmentReduce>[1],
  ): Attachment | null | undefined {
    const a = agents.get(agentKey);
    if (a === undefined) return undefined;
    const idx = a.tray.value.findIndex((x) => x.id === id);
    if (idx === -1) return undefined;
    const item = a.tray.value[idx]!;
    const next = attachmentReduce(item, event);
    if (next === item) return item;
    const arr = a.tray.value.slice();
    if (next === null) arr.splice(idx, 1);
    else arr[idx] = next as Attachment;
    a.tray.value = arr;
    return next as Attachment | null;
  }

  /** Start as many queued items as the per-agent concurrency cap allows (§4.3). */
  function pump(agentKey: string): void {
    const a = agents.get(agentKey);
    if (a === undefined) return;
    for (const item of a.tray.value) {
      if (a.running.size >= MAX_CONCURRENT_UPLOADS) break;
      if (item.state !== "queued" || a.running.has(item.id)) continue;
      a.running.add(item.id);
      void drive(agentKey, item.id).finally(() => {
        a.running.delete(item.id);
        pump(agentKey);
      });
    }
  }

  async function drive(agentKey: string, id: string): Promise<void> {
    const a = trayOf(agentKey);
    const file = a.files.get(id);
    const item = a.tray.value.find((x) => x.id === id);
    if (file === undefined || item === undefined || item.state !== "queued") return;
    if (AC === undefined) {
      applyEvent(agentKey, id, {
        type: "error",
        error: "E_INTERNAL",
        message: "AbortController unavailable",
        retryable: false,
      });
      return;
    }
    const ac = new AC();
    a.controllers.set(id, ac);
    const beginParams = {
      agentKey,
      id,
      name: item.name,
      size: item.size,
      ...(item.mime !== null ? { mime: item.mime } : {}),
    };
    /** Abort OR user removal (removing/absent) ⇒ stop silently — the reducer swallows late
     * transport events on `removing` items anyway; stopping just avoids wasted work. */
    const stopped = (): boolean => {
      if (ac.signal.aborted) return true;
      const cur = a.tray.value.find((x) => x.id === id);
      return cur === undefined || cur.state === "removing";
    };
    try {
      const started = applyEvent(agentKey, id, { type: "start" });
      if (started === undefined || started === null || started.state !== "uploading") return;

      const fail = (out: UploadOutcomeErr, retryOverride?: boolean): void => {
        applyEvent(agentKey, id, {
          type: "error",
          error: out.error,
          retryable: retryOverride ?? out.retryable,
          ...(typeof out.message === "string" ? { message: out.message } : {}),
        });
      };
      // §4.3: 404 (voided upload / hub restart) ⇒ failed, but retry with a FRESH id genuinely
      // helps — the client's default 404 mapping (`retryable:false`) would grey the button.
      const failRestarted = (out: UploadOutcomeErr): void => fail(out, true);

      const r = await upload.begin(beginParams, ac.signal);
      if (stopped()) return;
      if (!r.ok) {
        fail(r);
        return;
      }
      a.serverKnown.add(id);
      if (typeof r.data.maxBytes === "number" && r.data.maxBytes < item.size) {
        fail({ ok: false, error: "E_UPLOAD_TOO_LARGE", message: "file exceeds the hub limit", retryable: false });
        return;
      }
      let received = clampReceived(r.data.received, item.size);
      let chunkBytes = typeof r.data.chunkBytes === "number" && r.data.chunkBytes > 0 ? r.data.chunkBytes : 0;
      // Idempotent begin reply with progress (resume/withRelogin replay) — feed the bar once.
      if (received > 0) applyEvent(agentKey, id, { type: "progress", received });

      let attempts = 0;
      let lastOffset: number | null = null;
      let transient = "E_NETWORK";
      for (;;) {
        if (stopped()) return;
        const plan = planChunks(item.size, chunkBytes, received);
        if (!plan.ok) {
          fail({
            ok: false,
            error: "E_INTERNAL",
            message: `chunk plan rejected (${plan.reason})`,
            retryable: false,
          });
          return;
        }
        if (plan.chunks.length === 0) break; // all bytes acked — commit
        const c = plan.chunks[0]!;
        // §4.3: the attempt budget is per OFFSET — a resync that moves `received` (the failed
        // chunk actually landed, a 409's authoritative offset) restarts it for the new offset.
        if (c.offset !== lastOffset) {
          attempts = 0;
          lastOffset = c.offset;
        }
        attempts += 1;
        if (attempts > MAX_CHUNK_ATTEMPTS) {
          fail({
            ok: false,
            error: transient,
            message: `chunk at offset ${c.offset} failed ${MAX_CHUNK_ATTEMPTS} times`,
            retryable: true,
          });
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = await readSlice(file, c.offset, c.bytes);
        } catch {
          transient = "E_INTERNAL";
          continue;
        }
        const out = await upload.chunk({ id, offset: c.offset, bytes }, ac.signal);
        if (stopped()) return;
        if (out.ok) {
          received = clampReceived(out.data.received, item.size);
          applyEvent(agentKey, id, { type: "progress", received });
          continue;
        }
        if (typeof out.received === "number" && Number.isFinite(out.received)) {
          received = clampReceived(out.received, item.size);
        }
        if (out.error === "E_UPLOAD_OFFSET") continue; // authoritative resync — replan
        if (out.error === "E_ABORT") return; // external abort — silent (remove/retry/dispose)
        if (out.error === "E_DEADLINE" || out.error === "E_NETWORK") {
          // §4.3: timeout/network ⇒ idempotent begin takes the authoritative `received`; a
          // chunk that actually landed is never re-sent (the plan restarts past it).
          transient = out.error;
          const b2 = await upload.begin(beginParams, ac.signal);
          if (stopped()) return;
          if (!b2.ok) {
            if (b2.error === "E_NOT_FOUND") failRestarted(b2);
            else fail(b2);
            return;
          }
          if (typeof b2.data.chunkBytes === "number" && b2.data.chunkBytes > 0) {
            chunkBytes = b2.data.chunkBytes;
          }
          received = clampReceived(b2.data.received, item.size);
          continue;
        }
        if (out.error === "E_NOT_FOUND") {
          failRestarted(out);
          return;
        }
        if (out.error === "E_AUTH") {
          fail(out, true); // re-login happened (transport surfaced it) — retry re-begins
          return;
        }
        // E_RATE / E_UPLOAD_* / exhausted E_BUSY / HTTP n — surface the mapped code as-is.
        fail(out);
        return;
      }

      const cm = await upload.commit({ id }, ac.signal);
      if (stopped()) return;
      if (!cm.ok) {
        if (cm.error === "E_NOT_FOUND") failRestarted(cm);
        else fail(cm);
        return;
      }
      applyEvent(agentKey, id, {
        type: "committed",
        path: cm.data.path,
        size: cm.data.size,
        mime: typeof cm.data.mime === "string" ? cm.data.mime : null,
      });
    } catch {
      // A rejecting transport is a bug (both real clients map every failure into outcomes) —
      // still, never let it escape as an unhandled rejection wedging the agent's pump slot.
      applyEvent(agentKey, id, { type: "error", error: "E_INTERNAL", retryable: false });
    } finally {
      a.controllers.delete(id);
    }
  }

  return {
    tray: (agentKey) => trayOf(agentKey).tray,

    add(agentKey, files) {
      const a = trayOf(agentKey);
      const rejected: Array<{ file: unknown; reason: AddRejectReason }> = [];
      const fingerprints = new Set<string>();
      for (const it of a.tray.value) {
        const fp = fileFingerprint(a.files.get(it.id));
        if (fp !== "") fingerprints.add(fp);
      }
      let room = UPLOAD_ATTACH_MAX_PER_MSG - a.tray.value.length;
      const queued: Attachment[] = [];
      for (const f of files) {
        if (!isUploadSource(f)) {
          rejected.push({ file: f, reason: "invalid" });
          continue;
        }
        if (f.size > UPLOAD_FILE_MAX_BYTES) {
          rejected.push({ file: f, reason: "too-large" });
          continue;
        }
        const fp = fileFingerprint(f);
        if (fp !== "" && fingerprints.has(fp)) {
          rejected.push({ file: f, reason: "duplicate" });
          continue;
        }
        if (room <= 0) {
          rejected.push({ file: f, reason: "too-many" });
          continue;
        }
        const id = newId();
        a.files.set(id, f);
        if (fp !== "") fingerprints.add(fp);
        queued.push({
          id,
          name: f.name,
          size: f.size,
          mime: typeof f.type === "string" && f.type !== "" ? f.type : null,
          state: "queued",
        });
        room -= 1;
      }
      if (queued.length > 0) {
        a.tray.value = [...a.tray.value, ...queued];
        pump(agentKey);
      }
      return {
        added: Object.freeze(queued.map((q) => q.id)),
        rejected: Object.freeze(rejected),
      };
    },

    remove(agentKey, id) {
      const a = agents.get(agentKey);
      if (a === undefined) return;
      const item = a.tray.value.find((x) => x.id === id);
      if (item === undefined || item.state === "removing") return;
      applyEvent(agentKey, id, { type: "removing" });
      a.controllers.get(id)?.abort();
      a.controllers.delete(id);
      a.files.delete(id);
      const known = a.serverKnown.has(id);
      a.serverKnown.delete(id);
      const drop = (): void => {
        applyEvent(agentKey, id, { type: "removed" });
      };
      // §4.2/§2.6: a begun upload has server-side state — delete it now via the abort endpoint
      // (best-effort; a failed call leaves the 10-min idle TTL to reclaim it). A never-begun
      // item has none, so no request is wasted on it.
      if (known) void upload.abort({ id }).then(drop, drop);
      else drop();
    },

    retry(agentKey, id) {
      const a = agents.get(agentKey);
      if (a === undefined) return;
      const item = a.tray.value.find((x) => x.id === id);
      if (item === undefined || item.state !== "failed") return;
      const file = a.files.get(id);
      if (file === undefined) return;
      const fresh = newId();
      a.files.delete(id);
      a.files.set(fresh, file);
      if (a.serverKnown.has(id)) {
        // Void the abandoned attempt's server-side partial (best-effort, §2.6 idle TTL covers
        // a failure; a 404 — already evicted/gone — is harmless).
        a.serverKnown.delete(id);
        void upload.abort({ id }).catch(() => {});
      }
      const next = applyEvent(agentKey, id, { type: "retry", id: fresh });
      if (next !== undefined && next !== null) pump(agentKey);
    },

    failGone(agentKey, ids) {
      // §2.6 v3 #8: /api/cmd replied E_UPLOAD_GONE — the committed file was evicted before the
      // prompt landed. U4a's reducer already carries the `ready → failed` transition; the i18n
      // copy (upload.err.gone) is U5's — only the code rides here.
      for (const id of ids) {
        if (typeof id !== "string") continue;
        applyEvent(agentKey, id, { type: "error", error: "E_UPLOAD_GONE", retryable: true });
      }
    },

    discard(agentKey, ids) {
      // §3.2's post-send tray clear (U5 patch — plan-author ruled this handle member was an
      // U4b omission; remove()-ing a sent attachment would abort-delete the committed hub file
      // the just-sent prompt now references). NEVER calls the abort endpoint: a local
      // controller abort stops any in-flight fetch (sendGate normally guarantees only
      // ready/removing items remain — this is the defensive path), and a never-committed
      // server-side partial is left to the hub's 10-min idle voiding (§2.6).
      const a = agents.get(agentKey);
      if (a === undefined) return;
      const targets = ids === undefined ? a.tray.value.map((x) => x.id) : ids;
      for (const id of targets) {
        if (typeof id !== "string") continue;
        a.controllers.get(id)?.abort();
        a.controllers.delete(id);
        a.files.delete(id);
        a.serverKnown.delete(id);
        applyEvent(agentKey, id, { type: "removed" });
      }
    },

    dispose() {
      for (const a of agents.values()) {
        for (const ac of a.controllers.values()) ac.abort();
        a.controllers.clear();
        a.files.clear();
        a.running.clear();
        a.serverKnown.clear();
        a.tray.value = [];
      }
      agents.clear();
    },
  } satisfies UploadsHandle;
}
