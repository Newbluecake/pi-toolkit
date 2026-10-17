/**
 * web-hub HTML preview — the capability store (plan v2 §2.2/§2.4, §R2, P1a). Pi-free, per
 * `createPreviewRoutes` closure, ZERO timers (expiry is lazy: `sweep()` runs on every
 * mint/lookup/revoke/dispose; n ≤ `PV_CAPS_GLOBAL`).
 *
 * A capability binds (principal, listener, minting origin, sidTag, userId, held directory fd +
 * dev/ino, entry) and is the ONLY credential of `/pv`/`/pvw` (I1). Lifecycle:
 *
 * - `mintChecked(seq0, input)` — the SYNCHRONOUS commit: tombstone re-check since `seq0`
 *   (captured by the caller BEFORE `authorize`, §R2) + insert in the same tick; FIFO eviction
 *   per principal (8) / global (64).
 * - `lookup` — live record bound to that listener + origin only; slides the idle clock.
 * - `lease(rec)` — per-request registration (AbortController in `active`, refcount): the dir fd
 *   cannot be closed while a lease is out.
 * - `revoke(sel, reason)` — bumps `revokeSeq`, tombstones, marks matching caps dead, aborts
 *   every `active` controller, cancels queued waiters, closes dirFh once refs drain.
 * - one summary callback per ended cap (`onEnd`, audit `pv-end`).
 */

import { createHmac, randomBytes } from "node:crypto";
import type { PvRevokeReason, PvRevokeSelector } from "../ports.js";
import {
  PV_CAPS_GLOBAL,
  PV_CAPS_PER_PRINCIPAL,
  PV_DENY_AUDIT_THROTTLE_MS,
  PV_HARD_TTL_MS,
  PV_IDLE_TTL_MS,
  PV_TOMBSTONE_RING,
} from "../../protocol/preview-html.js";
import type { PreviewHandle } from "./admit.js";

export type PvEndReason = "idle" | "hard" | "revoked" | "evicted" | "close";

/** A queued request that holds only its socket; the store calls `cancel` when the cap ends. */
export interface PvWaiter {
  cancel(reason: PvEndReason): void;
}

export interface HtmlCap {
  readonly cap: string;
  readonly capTag: string;
  readonly principal: string;
  readonly listener: "loopback" | "lan";
  /** `io.expectedOrigin` at mint. */
  readonly origin: string;
  readonly sidTag?: string | undefined;
  readonly userId?: number | undefined;
  readonly dirFh: PreviewHandle;
  readonly dirPath: string;
  readonly dirDev: number;
  readonly dirIno: number;
  readonly entry: string;
  readonly mintedAt: number;
  readonly hardAt: number;
  lastUsedAt: number;
  reqs: number;
  bytes: number;
  denied: number;
  codes: Record<string, number>;
  readonly active: Set<AbortController>;
  readonly queue: PvWaiter[];
}

export interface HtmlCapMintInput {
  principal: string;
  listener: "loopback" | "lan";
  origin: string;
  sidTag?: string | undefined;
  userId?: number | undefined;
  dirFh: PreviewHandle;
  dirPath: string;
  dirDev: number;
  dirIno: number;
  entry: string;
}

export interface PvEndSummary {
  readonly capTag: string;
  readonly reqs: number;
  readonly bytes: number;
  readonly denied: number;
  readonly codes: Readonly<Record<string, number>>;
  readonly end: PvEndReason;
}

export type PvMintResult =
  | { readonly ok: true; readonly rec: HtmlCap }
  /** a revoke matching the mint's binding landed since `seq0` ⇒ 401 `E_AUTH`; the caller closes dirFh. */
  | { readonly ok: false; readonly reason: "revoked" }
  /** `seq0` is older than the retained tombstones ⇒ fail closed 503 retryable; caller closes dirFh. */
  | { readonly ok: false; readonly reason: "tombstone-gap" };

export type PvRevokedSince = "clear" | "revoked" | "unknown";

export interface PvLease {
  readonly rec: HtmlCap;
  /** aborted when the cap ends (revoked/expired/evicted/closed) mid-request. */
  readonly signal: AbortSignal;
  /** idempotent; the last release of a dead cap closes its dir fd. */
  release(): void;
}

export interface HtmlCapStoreDeps {
  now(): number;
  /** bounded, never-rejecting dir-fd close (the PV IO gate's `close`). */
  closeDir(fh: PreviewHandle): Promise<void>;
  onEnd?: ((s: PvEndSummary) => void) | undefined;
  /** test seam; default `crypto.randomBytes`. */
  randomBytes?: ((n: number) => Buffer) | undefined;
  /** HMAC-12 tag of a cap for audit; default per-store random-key HMAC. */
  capTag?: ((cap: string) => string) | undefined;
  /** test overrides of the frozen protocol limits. */
  limits?:
    Partial<{ perPrincipal: number; global: number; idleMs: number; hardMs: number; tombstones: number }> | undefined;
}

/** A per-cap tombstone (`endCap`) names one already-minted cap, so it can never match a mint
 * BINDING (the capability being minted does not exist yet) — it only advances the sequence. */
interface Tombstone {
  readonly seq: number;
  readonly sel: PvRevokeSelector | { readonly cap: string };
}

export interface HtmlCapStore {
  /** the current revoke sequence (capture BEFORE `authorize`, §R2). */
  revokeSeq(): number;
  revokedSince(
    seq0: number,
    binding: { listener: "loopback" | "lan"; sidTag?: string | undefined; userId?: number | undefined },
  ): PvRevokedSince;
  mintChecked(seq0: number, input: HtmlCapMintInput): PvMintResult;
  /** a LIVE cap bound to this listener + origin (slides the idle clock unless `touch:false`). */
  lookup(cap: string, listener: "loopback" | "lan", origin: string, o?: { touch?: boolean }): HtmlCap | undefined;
  /** sync liveness (idle/hard/dead) — used right before `writeHead`. */
  isLive(rec: HtmlCap): boolean;
  /** register one in-flight request; `undefined` when the cap is no longer live. */
  lease(rec: HtmlCap): PvLease | undefined;
  /** queue bookkeeping for P1b's bounded FIFO; `false` when the cap is no longer live. */
  addWaiter(rec: HtmlCap, w: PvWaiter): boolean;
  removeWaiter(rec: HtmlCap, w: PvWaiter): void;
  /** per-request accounting. */
  noteRequest(rec: HtmlCap): void;
  noteBytes(rec: HtmlCap, n: number): void;
  /** counts a denial; `true` ⇒ this one may emit its throttled audit line. */
  noteDenied(rec: HtmlCap, code: string): boolean;
  revoke(sel: PvRevokeSelector, reason: PvRevokeReason): void;
  /**
   * End EXACTLY this one cap (same semantics as a selector revoke that matches only it): bumps
   * `revokeSeq` + tombstones, aborts its in-flight leases, cancels its queued waiters, emits
   * the one `pv-end` summary (`end:"revoked"`, or `"close"` when asked) and closes the dir fd
   * once refs drain. Siblings — even of the same principal/session — are untouched.
   * Idempotent: a cap that already ended is a no-op (no second seq bump, no second summary).
   * P1b contract: call it with the `rec` the request holds when `admitPvFile` answers
   * `revokeCap: true` (bound dir deleted), before replying the 404.
   */
  endCap(rec: HtmlCap, reason?: "revoked" | "close"): void;
  sweep(): void;
  /** every cap ends `close`; the store stays usable but empty. Idempotent. */
  dispose(): void;
  readonly size: number;
  /** totals across live caps (for the global active/queue bounds). */
  totals(): { active: number; queued: number };
}

const MAX_CODES = 16;

export function createHtmlCapStore(deps: HtmlCapStoreDeps): HtmlCapStore {
  const now = deps.now;
  const rnd = deps.randomBytes ?? randomBytes;
  const hmacKey = randomBytes(16);
  const tagOf =
    deps.capTag ?? ((cap: string): string => createHmac("sha256", hmacKey).update(cap).digest("hex").slice(0, 12));
  const L = {
    perPrincipal: deps.limits?.perPrincipal ?? PV_CAPS_PER_PRINCIPAL,
    global: deps.limits?.global ?? PV_CAPS_GLOBAL,
    idleMs: deps.limits?.idleMs ?? PV_IDLE_TTL_MS,
    hardMs: deps.limits?.hardMs ?? PV_HARD_TTL_MS,
    tombstones: deps.limits?.tombstones ?? PV_TOMBSTONE_RING,
  };
  /** insertion order = mint order (Map preserves it) ⇒ FIFO eviction. */
  const caps = new Map<string, HtmlCap>();
  const dead = new WeakSet<HtmlCap>();
  const refs = new WeakMap<HtmlCap, number>();
  const dirClosed = new WeakSet<HtmlCap>();
  const lastDenyAuditAt = new WeakMap<HtmlCap, number>();
  let seq = 0;
  const tombstones: Tombstone[] = [];
  let disposed = false;

  const closeDirIfDrained = (rec: HtmlCap): void => {
    if (!dead.has(rec) || (refs.get(rec) ?? 0) > 0 || dirClosed.has(rec)) return;
    dirClosed.add(rec);
    void deps.closeDir(rec.dirFh).catch(() => undefined);
  };

  const end = (rec: HtmlCap, reason: PvEndReason): void => {
    if (dead.has(rec)) return;
    dead.add(rec);
    caps.delete(rec.cap);
    for (const ctl of [...rec.active]) ctl.abort(`pv-${reason}`);
    for (const w of rec.queue.splice(0)) {
      try {
        w.cancel(reason);
      } catch {
        /* a waiter's cancel must never break the store */
      }
    }
    try {
      deps.onEnd?.({
        capTag: rec.capTag,
        reqs: rec.reqs,
        bytes: rec.bytes,
        denied: rec.denied,
        codes: { ...rec.codes },
        end: reason,
      });
    } catch {
      /* audit sink failures are not the store's problem */
    }
    closeDirIfDrained(rec);
  };

  const expiryOf = (rec: HtmlCap, t: number): "hard" | "idle" | undefined => {
    if (t >= rec.hardAt) return "hard";
    if (t - rec.lastUsedAt >= L.idleMs) return "idle";
    return undefined;
  };

  const sweep = (): void => {
    const t = now();
    for (const rec of [...caps.values()]) {
      const e = expiryOf(rec, t);
      if (e !== undefined) end(rec, e);
    }
  };

  const matches = (
    sel: PvRevokeSelector | { readonly cap: string },
    b: { listener: string; sidTag?: string | undefined; userId?: number | undefined },
  ): boolean => {
    if (sel === "all") return true;
    if ("cap" in sel) return false;
    if ("sidTag" in sel) return b.sidTag !== undefined && b.sidTag === sel.sidTag;
    if ("userId" in sel) return b.userId !== undefined && b.userId === sel.userId;
    return b.listener === sel.listener;
  };

  const evictFor = (principal: string): void => {
    let n = 0;
    for (const r of caps.values()) if (r.principal === principal) n += 1;
    while (n >= L.perPrincipal) {
      const victim = [...caps.values()].find((r) => r.principal === principal);
      if (victim === undefined) break;
      end(victim, "evicted");
      n -= 1;
    }
    while (caps.size >= L.global) {
      const victim = caps.values().next().value as HtmlCap | undefined;
      if (victim === undefined) break;
      end(victim, "evicted");
    }
  };

  const revokedSince: HtmlCapStore["revokedSince"] = (seq0, binding) => {
    if (seq0 >= seq) return "clear";
    const oldest = tombstones[0];
    if (oldest === undefined || oldest.seq > seq0 + 1) return "unknown";
    for (const t of tombstones) {
      if (t.seq > seq0 && matches(t.sel, binding)) return "revoked";
    }
    return "clear";
  };

  const store: HtmlCapStore = {
    revokeSeq: () => seq,
    revokedSince,
    mintChecked(seq0, input) {
      sweep();
      const verdict = revokedSince(seq0, input);
      if (verdict === "revoked") return { ok: false, reason: "revoked" };
      if (verdict === "unknown") return { ok: false, reason: "tombstone-gap" };
      if (disposed) return { ok: false, reason: "revoked" };
      evictFor(input.principal);
      let cap = rnd(32).toString("base64url");
      while (caps.has(cap)) cap = rnd(32).toString("base64url"); // astronomically unlikely
      const t = now();
      const rec: HtmlCap = {
        cap,
        capTag: tagOf(cap),
        principal: input.principal,
        listener: input.listener,
        origin: input.origin,
        sidTag: input.sidTag,
        userId: input.userId,
        dirFh: input.dirFh,
        dirPath: input.dirPath,
        dirDev: input.dirDev,
        dirIno: input.dirIno,
        entry: input.entry,
        mintedAt: t,
        hardAt: t + L.hardMs,
        lastUsedAt: t,
        reqs: 0,
        bytes: 0,
        denied: 0,
        codes: {},
        active: new Set(),
        queue: [],
      };
      caps.set(cap, rec);
      return { ok: true, rec };
    },
    lookup(cap, listener, origin, o) {
      sweep();
      const rec = caps.get(cap);
      if (rec === undefined || dead.has(rec)) return undefined;
      if (rec.listener !== listener || rec.origin !== origin) return undefined;
      if (o?.touch !== false) rec.lastUsedAt = now();
      return rec;
    },
    isLive(rec) {
      return !dead.has(rec) && caps.get(rec.cap) === rec && expiryOf(rec, now()) === undefined;
    },
    lease(rec) {
      if (!store.isLive(rec)) return undefined;
      const ctl = new AbortController();
      rec.active.add(ctl);
      refs.set(rec, (refs.get(rec) ?? 0) + 1);
      let released = false;
      return {
        rec,
        signal: ctl.signal,
        release() {
          if (released) return;
          released = true;
          rec.active.delete(ctl);
          refs.set(rec, Math.max(0, (refs.get(rec) ?? 1) - 1));
          if (!dead.has(rec)) rec.lastUsedAt = now();
          closeDirIfDrained(rec);
        },
      };
    },
    addWaiter(rec, w) {
      if (!store.isLive(rec)) return false;
      rec.queue.push(w);
      return true;
    },
    removeWaiter(rec, w) {
      const i = rec.queue.indexOf(w);
      if (i !== -1) rec.queue.splice(i, 1);
    },
    noteRequest(rec) {
      rec.reqs += 1;
    },
    noteBytes(rec, n) {
      rec.bytes += Math.max(0, n);
    },
    noteDenied(rec, code) {
      rec.denied += 1;
      if (Object.hasOwn(rec.codes, code) || Object.keys(rec.codes).length < MAX_CODES) {
        rec.codes[code] = (rec.codes[code] ?? 0) + 1;
      }
      const t = now();
      const last = lastDenyAuditAt.get(rec);
      if (last !== undefined && t - last < PV_DENY_AUDIT_THROTTLE_MS) return false;
      lastDenyAuditAt.set(rec, t);
      return true;
    },
    revoke(sel, reason) {
      seq += 1;
      tombstones.push({ seq, sel });
      while (tombstones.length > L.tombstones) tombstones.shift();
      const endReason: PvEndReason = reason === "close" ? "close" : "revoked";
      for (const rec of [...caps.values()]) if (matches(sel, rec)) end(rec, endReason);
      sweep();
    },
    endCap(rec, reason = "revoked") {
      if (dead.has(rec) || caps.get(rec.cap) !== rec) return;
      seq += 1;
      tombstones.push({ seq, sel: { cap: rec.cap } });
      while (tombstones.length > L.tombstones) tombstones.shift();
      end(rec, reason);
    },
    sweep,
    dispose() {
      store.revoke("all", "close");
      disposed = true;
    },
    get size() {
      return caps.size;
    },
    totals() {
      let active = 0;
      let queued = 0;
      for (const r of caps.values()) {
        active += r.active.size;
        queued += r.queue.length;
      }
      return { active, queued };
    },
  };
  return store;
}
