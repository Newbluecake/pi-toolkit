/** Hashed one-time codes and origin+instance-bound proxy sessions. Lazy expiry, ZERO timers (§3.2). */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthIdentity, AuthRevokeEvent } from "../ports.js";
import {
  PROXY_CODE_TTL_MS,
  PROXY_CODES_GLOBAL,
  PROXY_CODES_PER_INSTANCE,
  PROXY_SECRET_BYTES,
  PROXY_SECRET_RE,
  PROXY_SESSION_HARD_MS,
  PROXY_SESSION_IDLE_MS,
  PROXY_SESSIONS_GLOBAL,
  PROXY_SESSIONS_PER_INSTANCE,
  PROXY_TOMBSTONE_RING,
  PROXY_TOUCH_THROTTLE_MS,
} from "../../protocol/proxy.js";
import { safeOriginForm } from "./target.js";

/** Never copy AuthIdentity.sid/lan (raw hub credentials) into proxy records. */
type ProxyIdentity = Pick<AuthIdentity, "listener" | "principal" | "sidTag" | "userId">;
export interface ProxyCode extends ProxyIdentity {
  readonly codeHash: string;
  readonly instanceId: string;
  readonly origin: string;
  readonly nextPath: string;
  readonly seq0: number;
  readonly expAt: number;
  readonly hardAt: number;
}
export interface ProxySocket {
  destroy(): unknown;
}
export interface ProxySession extends ProxyIdentity {
  readonly sidHash: string;
  readonly instanceId: string;
  readonly origin: string;
  readonly createdAt: number;
  lastUsedAt: number;
  readonly hardAt: number;
  readonly sockets: Set<ProxySocket>;
}
export type ProxyRevokeSelector = AuthRevokeEvent["sel"] | { readonly instanceId: string };
export interface ProxyRevokeEvent {
  readonly sel: ProxyRevokeSelector;
  readonly reason: AuthRevokeEvent["reason"];
}
export type ProxyCredentialFailure =
  | { readonly ok: false; readonly kind: "invalid" }
  | { readonly ok: false; readonly status: 429; readonly error: "E_RATE"; readonly reason: "codes" | "sessions" }
  | {
      readonly ok: false;
      readonly status: 503;
      readonly error: "E_PROXY_UNAVAILABLE";
      readonly reason: "revocation-gap";
      readonly retryable: true;
    };
export type ProxyMintCodeResult = { ok: true; code: string; rec: ProxyCode } | ProxyCredentialFailure;
export type ProxyExchangeResult =
  { ok: true; sid: string; rec: ProxySession; nextPath: string } | ProxyCredentialFailure;
export interface ProxySessionStoreDeps {
  now(): number;
  randomBytes?: (n: number) => Uint8Array;
  /** Called after removal/socket teardown; callback errors never interrupt cleanup. */
  onEnd?: (rec: ProxySession, end: "idle" | "hard" | "revoked") => void;
}
export interface ProxySessionStore {
  currentSeq(): number;
  revokedSince(seq0: number, identity: ProxyIdentity, instanceId?: string): boolean | "gap";
  mintCode(
    seq0: number,
    identity: AuthIdentity,
    input: { instanceId: string; origin: string; nextPath: string },
  ): ProxyMintCodeResult;
  /** A known code is deleted BEFORE all remaining checks, even a failing exchange. */
  exchange(code: string, instanceId: string, origin: string): ProxyExchangeResult;
  lookup(sid: string, instanceId: string, origin: string, opts?: { touch?: boolean }): ProxySession | undefined;
  isLive(rec: ProxySession): boolean;
  /** HTTP start: every request. WS data: at most once/60s. Response bytes: NEVER call this. */
  touch(rec: ProxySession, source: "http" | "ws"): boolean;
  attach(rec: ProxySession, socket: ProxySocket): boolean;
  detach(rec: ProxySession, socket: ProxySocket): void;
  revoke(ev: ProxyRevokeEvent): void;
  sweep(): void;
  counts(): { codes: number; sessions: number };
}
function identityFields(id: ProxyIdentity): ProxyIdentity {
  return {
    listener: id.listener,
    principal: id.principal,
    sidTag: id.sidTag,
    ...(id.userId === undefined ? {} : { userId: id.userId }),
  };
}
function matches(sel: ProxyRevokeSelector, id: ProxyIdentity, instanceId?: string): boolean {
  if (sel === "all") return true;
  if ("sidTag" in sel) return sel.sidTag === id.sidTag;
  if ("userId" in sel) return sel.userId === id.userId;
  if ("listener" in sel) return sel.listener === id.listener;
  return sel.instanceId === instanceId;
}
function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}
/** Compare fixed-length SHA-256 values, never a secret or an attacker-controlled length. */
function sameHash(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, "base64url"), Buffer.from(b, "base64url"));
}

export function createProxySessionStore(deps: ProxySessionStoreDeps): ProxySessionStore {
  const codes = new Map<string, ProxyCode>();
  const sessions = new Map<string, ProxySession>();
  let seq = 0;
  const tombstones: Array<{ seq: number; sel: ProxyRevokeSelector }> = [];
  const secret = (): string => {
    const bytes = (deps.randomBytes ?? randomBytes)(PROXY_SECRET_BYTES);
    if (bytes.length !== PROXY_SECRET_BYTES) throw new Error("proxy secret generator failed");
    return Buffer.from(bytes).toString("base64url");
  };
  const end = (rec: ProxySession, why: "idle" | "hard" | "revoked"): void => {
    if (!sessions.delete(rec.sidHash)) return;
    for (const socket of [...rec.sockets]) {
      try {
        socket.destroy();
      } catch {
        /* continue teardown */
      }
    }
    rec.sockets.clear();
    try {
      deps.onEnd?.(rec, why);
    } catch {
      /* observers cannot prevent revocation */
    }
  };
  const expired = (rec: ProxySession, now: number): "idle" | "hard" | undefined =>
    now >= rec.hardAt ? "hard" : now - rec.lastUsedAt >= PROXY_SESSION_IDLE_MS ? "idle" : undefined;
  const sweep = (): void => {
    const now = deps.now();
    for (const [hash, c] of codes) if (now >= Math.min(c.expAt, c.hardAt)) codes.delete(hash);
    for (const s of [...sessions.values()]) {
      const why = expired(s, now);
      if (why !== undefined) end(s, why);
    }
  };
  const revokedSince = (seq0: number, id: ProxyIdentity, instanceId?: string): boolean | "gap" => {
    if (
      !Number.isSafeInteger(seq0) ||
      seq0 < 0 ||
      seq0 > seq ||
      (tombstones.length > 0 && seq0 < tombstones[0]!.seq - 1)
    )
      return "gap";
    return tombstones.some((t) => t.seq > seq0 && matches(t.sel, id, instanceId));
  };
  const gap = (): ProxyCredentialFailure => ({
    ok: false,
    status: 503,
    error: "E_PROXY_UNAVAILABLE",
    reason: "revocation-gap",
    retryable: true,
  });
  const invalid = (): ProxyCredentialFailure => ({ ok: false, kind: "invalid" });
  const isLive = (rec: ProxySession): boolean => {
    if (sessions.get(rec.sidHash) !== rec) return false;
    const why = expired(rec, deps.now());
    if (why !== undefined) {
      end(rec, why);
      return false;
    }
    return true;
  };
  const touch = (rec: ProxySession, source: "http" | "ws"): boolean => {
    if (!isLive(rec)) return false;
    const now = deps.now();
    if (source === "http" || now - rec.lastUsedAt >= PROXY_TOUCH_THROTTLE_MS) rec.lastUsedAt = now;
    return true;
  };
  return {
    currentSeq: () => seq,
    revokedSince,
    sweep,
    isLive,
    touch,
    mintCode(seq0, id, input) {
      sweep();
      const revoked = revokedSince(seq0, id, input.instanceId);
      if (revoked === "gap") return gap();
      const now = deps.now();
      const hardAt = Math.min(now + PROXY_SESSION_HARD_MS, id.parentExpiresAt);
      if (revoked || !Number.isFinite(hardAt) || now >= hardAt) return invalid();
      if (
        codes.size >= PROXY_CODES_GLOBAL ||
        [...codes.values()].filter((c) => c.instanceId === input.instanceId).length >= PROXY_CODES_PER_INSTANCE
      )
        return { ok: false, status: 429, error: "E_RATE", reason: "codes" };
      const code = secret();
      const codeHash = digest(code);
      if (codes.has(codeHash)) throw new Error("proxy secret collision");
      const rec: ProxyCode = Object.freeze({
        ...identityFields(id),
        codeHash,
        instanceId: input.instanceId,
        origin: input.origin,
        nextPath: safeOriginForm(input.nextPath),
        seq0,
        expAt: now + PROXY_CODE_TTL_MS,
        hardAt,
      });
      codes.set(codeHash, rec);
      return { ok: true, code, rec };
    },
    exchange(code, instanceId, origin) {
      if (!PROXY_SECRET_RE.test(code)) return invalid();
      const hash = digest(code);
      const c = [...codes.values()].find((rec) => sameHash(hash, rec.codeHash));
      if (c === undefined) return invalid();
      codes.delete(c.codeHash); // first presentation consumes, including foreign origin/instance/cap failures
      sweep();
      const revoked = revokedSince(c.seq0, c, c.instanceId);
      if (revoked === "gap") return gap();
      const now = deps.now();
      if (revoked || now >= Math.min(c.expAt, c.hardAt) || c.instanceId !== instanceId || c.origin !== origin)
        return invalid();
      if (
        sessions.size >= PROXY_SESSIONS_GLOBAL ||
        [...sessions.values()].filter((s) => s.instanceId === instanceId).length >= PROXY_SESSIONS_PER_INSTANCE
      )
        return { ok: false, status: 429, error: "E_RATE", reason: "sessions" };
      const sid = secret();
      const sidHash = digest(sid);
      if (sessions.has(sidHash)) throw new Error("proxy secret collision");
      const rec: ProxySession = {
        ...identityFields(c),
        sidHash,
        instanceId,
        origin,
        createdAt: now,
        lastUsedAt: now,
        hardAt: c.hardAt,
        sockets: new Set(),
      };
      sessions.set(sidHash, rec);
      return { ok: true, sid, rec, nextPath: c.nextPath };
    },
    lookup(sid, instanceId, origin, opts) {
      if (!PROXY_SECRET_RE.test(sid)) return undefined;
      const hash = digest(sid);
      const rec = [...sessions.values()].find((s) => sameHash(hash, s.sidHash));
      if (rec === undefined || !isLive(rec) || rec.instanceId !== instanceId || rec.origin !== origin) return undefined;
      if (opts?.touch !== false) touch(rec, "http");
      return rec;
    },
    attach(rec, socket) {
      if (!isLive(rec)) return false;
      rec.sockets.add(socket);
      return true;
    },
    detach(rec, socket) {
      rec.sockets.delete(socket);
    },
    revoke(ev) {
      seq += 1;
      // Snapshot the selector: an emitter mutating its object later cannot rewrite history.
      const sel = ev.sel === "all" ? "all" : { ...ev.sel };
      tombstones.push({ seq, sel });
      if (tombstones.length > PROXY_TOMBSTONE_RING) tombstones.shift();
      for (const [hash, c] of codes) if (matches(sel, c, c.instanceId)) codes.delete(hash);
      for (const s of [...sessions.values()]) if (matches(sel, s, s.instanceId)) end(s, "revoked");
      sweep();
    },
    counts() {
      sweep();
      return { codes: codes.size, sessions: sessions.size };
    },
  };
}
