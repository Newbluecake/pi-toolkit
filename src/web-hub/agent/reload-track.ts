/**
 * #30 reload-result plan §1 D3/D4/D5 — the reload-result tracker (agent side).
 *
 * ATTRIBUTION (D1). The unit is the reload lifecycle `life` emitted by the command port. A
 * fact carrying `by` (the capture proxy's `webCmdId`) establishes or merges into the record;
 * a fact without `by` (TUI) is only recorded into an already-tracked, still-open lifecycle
 * (Q1: a TUI `now`/`cancel` acting on a tracked Web request is attributed to it). Execution-
 * scoped facts (`settle`/`started`/`returned`/`threw`) are additionally checked against the
 * record's current `execId` — a superseded attempt's late callback can never overwrite a newer
 * execution's facts (A1/A2/A13).
 *
 * STATE (D2/D3). `state` is the LATEST fact; `open` says whether the request is still in
 * flight. `failed E_RELOAD_IDLE_WAIT` keeps `open:true` and later facts (started/completed/
 * cancelled) still land. Only `started` writes the handover marker; `returned`/`threw` become
 * REFUSED/THREW only when THIS activation never observed a reload-shutdown (the TUI host
 * swallows failures — a post-shutdown throw is uncollectable, the UI infers E_RELOAD_LOST).
 *
 * STORE (D5). `Symbol.for("pi-subagent:web-hub:reload-track")` — pure data `{v:1, rec?,
 * handover?}`, capacity ONE record + ONE marker. An unknown `v` or a corrupt structure reads
 * as empty and is overwritten whole on the next write. Time rules on read: a record whose
 * `at` lies in the future (clock rollback) is invalid — treated as empty AND cleared at once,
 * never projected, never takeover-validated. TTL constrains reads only: a closed record
 * projects for 10 minutes, an open one expires after 40 minutes without a new fact, the
 * marker after 120s. Expiry retraction is observed by the EXISTING 1Hz tick through
 * `tick()` — no new timer (I5).
 *
 * DISCIPLINE (D6). Every mutation goes through `applyPatch`, which bumps `rev` only when the
 * wire projection actually changed; the wiring layer publishes only then — no record / no
 * change ⇒ zero output side effects.
 */
import { clipReloadMessage, type ReloadPhaseEvent } from "../../reload/phase.js";
import type { ReloadResultCode, ReloadResultState, ReloadStatusWire } from "../protocol/messages.js";

export const RELOAD_TRACK_KEY = Symbol.for("pi-subagent:web-hub:reload-track");
/** D5: a closed record's projection window. */
export const RELOAD_REC_TTL_CLOSED_MS = 10 * 60_000;
/** D5: an open record without new facts expires after 40min (> #23's 30min total budget). */
export const RELOAD_REC_TTL_OPEN_MS = 40 * 60_000;
/** D4: the handover marker's validity window. */
export const RELOAD_HANDOVER_TTL_MS = 120_000;
/** D1: `cmdIds` capacity, FIFO beyond 4 (the oldest web request falls back to inference). */
export const RELOAD_CMD_IDS_MAX = 4;

export interface ReloadTrackRecord {
  v: 1;
  life: string;
  cmdIds: string[];
  rev: number;
  execId: string;
  state: ReloadResultState;
  open: boolean;
  at: number;
  waitingFor?: "runs" | "idle";
  activeRuns?: number;
  code?: ReloadResultCode;
  message?: string;
  version?: string;
  epoch?: string;
}

/** D4: written only by an accepted `started`; validated and consumed by the next activation. */
export interface ReloadHandoverMarker {
  v: 1;
  life: string;
  cmdIds: string[];
  sessionId: string;
  sessionFile: string | undefined;
  originEpoch: string;
  startedAt: number;
  shutdownAt?: number;
}

export interface ReloadTrackStore {
  v: 1;
  rec?: ReloadTrackRecord;
  handover?: ReloadHandoverMarker;
}

/** Session identity, read from the live ctx at fact/boundary time. */
export interface ReloadSessionIdentity {
  sessionId: string;
  sessionFile: string | undefined;
}

export interface ReloadTrackEnv {
  now(): number;
  /** This activation's MODULE_INSTANCE (marker originEpoch / completed epoch). */
  moduleInstance: string;
  /** `packageVersionSync()` — empty or "0.0.0" means version unknown (D4). */
  version(): string;
  /** The CURRENT session identity; `undefined` when unavailable (no marker is written then). */
  session(): ReloadSessionIdentity | undefined;
}

type StoreSlot = Record<symbol, unknown>;

function slot(): StoreSlot {
  return globalThis as unknown as StoreSlot;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const STATES: ReadonlySet<string> = new Set(["deferred", "started", "cancelled", "failed", "completed"]);
const CODES: ReadonlySet<string> = new Set([
  "E_RELOAD_IDLE_WAIT",
  "E_RELOAD_UNAVAILABLE",
  "E_RELOAD_SETTLE",
  "E_RELOAD_REFUSED",
  "E_RELOAD_THREW",
  "user",
  "superseded",
  "session",
  "quit",
]);

function validRecShape(v: unknown): v is ReloadTrackRecord {
  if (!isPlainObject(v) || v.v !== 1) return false;
  if (typeof v.life !== "string" || v.life === "") return false;
  if (!Array.isArray(v.cmdIds) || v.cmdIds.some((id) => typeof id !== "string")) return false;
  if (typeof v.rev !== "number" || typeof v.execId !== "string" || v.execId === "") return false;
  if (typeof v.state !== "string" || !STATES.has(v.state)) return false;
  if (typeof v.open !== "boolean" || typeof v.at !== "number") return false;
  if (v.waitingFor !== undefined && v.waitingFor !== "runs" && v.waitingFor !== "idle") return false;
  if (v.activeRuns !== undefined && typeof v.activeRuns !== "number") return false;
  if (v.code !== undefined && (typeof v.code !== "string" || !CODES.has(v.code))) return false;
  if (v.message !== undefined && typeof v.message !== "string") return false;
  if (v.version !== undefined && typeof v.version !== "string") return false;
  if (v.epoch !== undefined && typeof v.epoch !== "string") return false;
  return true;
}

function validMarkerShape(v: unknown): v is ReloadHandoverMarker {
  if (!isPlainObject(v) || v.v !== 1) return false;
  if (typeof v.life !== "string" || v.life === "") return false;
  if (!Array.isArray(v.cmdIds) || v.cmdIds.some((id) => typeof id !== "string")) return false;
  if (typeof v.sessionId !== "string" || v.sessionId === "") return false;
  if (v.sessionFile !== undefined && typeof v.sessionFile !== "string") return false;
  if (typeof v.originEpoch !== "string" || v.originEpoch === "") return false;
  if (typeof v.startedAt !== "number") return false;
  if (v.shutdownAt !== undefined && typeof v.shutdownAt !== "number") return false;
  return true;
}

/** D5: an unknown `v` or a corrupt structure reads as empty; the next write overwrites whole. */
export function readStore(): ReloadTrackStore {
  const raw = slot()[RELOAD_TRACK_KEY];
  if (!isPlainObject(raw) || raw.v !== 1) return { v: 1 };
  const store: ReloadTrackStore = { v: 1 };
  if (raw.rec !== undefined && validRecShape(raw.rec)) store.rec = raw.rec;
  if (raw.handover !== undefined && validMarkerShape(raw.handover)) store.handover = raw.handover;
  return store;
}

export function writeStore(store: ReloadTrackStore): void {
  slot()[RELOAD_TRACK_KEY] = store;
}

/** Test/inspection helper: wipe the process-global slot. */
export function resetReloadTrackStore(): void {
  delete slot()[RELOAD_TRACK_KEY];
}

/**
 * D5 read rules for the record: shape-valid, not in the future (a future `at` — clock rollback
 * — is INVALID, see `sanitizeStore`), and not TTL-expired (a closed record projects for 10min;
 * an open one lives 40min without a new fact). TTL expiry only reads as absent — the next write
 * replaces.
 */
export function readValidRec(store: ReloadTrackStore, now: number): ReloadTrackRecord | undefined {
  const rec = store.rec;
  if (rec === undefined || !validRecShape(rec) || rec.at > now) return undefined;
  const age = now - rec.at;
  if (rec.open ? age > RELOAD_REC_TTL_OPEN_MS : age > RELOAD_REC_TTL_CLOSED_MS) return undefined;
  return rec;
}

/** D5/U11: the marker reads valid only when shape-sound and not started in the future. */
export function readValidMarker(store: ReloadTrackStore, now: number): ReloadHandoverMarker | undefined {
  const marker = store.handover;
  if (marker === undefined || !validMarkerShape(marker) || marker.startedAt > now) return undefined;
  return marker;
}

/**
 * D5's time rule, enforced BEFORE any mutation: a record whose `at` lies in the future and a
 * marker whose `startedAt` does are cleared at once (treated as empty from here on — never
 * projected, never takeover-validated) and the cleaned store is PERSISTED so a caller's later
 * write-back cannot resurrect the invalid piece.
 */
export function sanitizeStore(store: ReloadTrackStore, now: number): ReloadTrackStore {
  if (store.rec !== undefined && store.rec.at > now) delete store.rec;
  if (store.handover !== undefined && store.handover.startedAt > now) delete store.handover;
  writeStore(store);
  return store;
}

/** D2's wire projection — fixed field order is the frame's byte order. */
export function projectRec(rec: ReloadTrackRecord): ReloadStatusWire {
  const out: ReloadStatusWire = {
    v: 1,
    life: rec.life,
    cmdIds: [...rec.cmdIds],
    rev: rec.rev,
    execId: rec.execId,
    state: rec.state,
    open: rec.open,
    at: rec.at,
  };
  if (rec.waitingFor !== undefined) out.waitingFor = rec.waitingFor;
  if (rec.activeRuns !== undefined) out.activeRuns = rec.activeRuns;
  if (rec.code !== undefined) out.code = rec.code;
  if (rec.message !== undefined) out.message = rec.message;
  if (rec.version !== undefined) out.version = rec.version;
  if (rec.epoch !== undefined) out.epoch = rec.epoch;
  return out;
}

const fingerprint = (rec: ReloadTrackRecord | undefined): string =>
  rec === undefined ? "" : JSON.stringify(projectRec(rec));

function mergeCmdId(cmdIds: string[], by: string | undefined): string[] {
  if (by === undefined || cmdIds.includes(by)) return cmdIds;
  const next = [...cmdIds, by];
  while (next.length > RELOAD_CMD_IDS_MAX) next.shift();
  return next;
}

interface RecPatch {
  state?: ReloadResultState;
  open?: boolean;
  waitingFor?: "runs" | "idle";
  activeRuns?: number;
  code?: ReloadResultCode;
  message?: string;
  version?: string;
  epoch?: string;
  execId?: string;
}

/**
 * Build the NEXT record (a fresh object — deleted fields must not survive an in-place assign),
 * drop fields the resulting state must not carry, and return it ONLY when the wire projection
 * changed — with `rev` bumped (D2: +1 per new fact, D6: an unchanged projection is not a fact).
 */
function nextRecord(rec: ReloadTrackRecord, patch: RecPatch, now: number): ReloadTrackRecord | undefined {
  const next: ReloadTrackRecord = { ...rec, ...patch, at: now, cmdIds: [...rec.cmdIds] };
  if (next.state !== "deferred") {
    delete next.waitingFor;
    delete next.activeRuns;
  }
  if (next.state !== "failed" && next.state !== "cancelled") delete next.code;
  if (next.state !== "failed") delete next.message;
  if (next.state !== "completed") {
    delete next.version;
    delete next.epoch;
  }
  if (fingerprint(next) === fingerprint(rec)) return undefined;
  next.rev = rec.rev + 1;
  return next;
}

/** D1: facts that may establish a record when a web-sourced fact finds no matching one. */
const ESTABLISH_FACTS: ReadonlySet<ReloadPhaseEvent["kind"]> = new Set([
  "deferred",
  "unavailable",
  "started",
  "settle",
]);

/** Facts scoped to one execution — checked against the record's current execId (A1/A2/A13). */
const EXEC_SCOPED_FACTS: ReadonlySet<ReloadPhaseEvent["kind"]> = new Set(["settle", "started", "returned", "threw"]);

export interface ReloadTracker {
  /** The command port's phase sink (D3 collection points → record mutation). */
  onPhase(event: ReloadPhaseEvent): void;
  /** session_shutdown: reload ⇒ marker shutdownAt / superseded; other reasons ⇒ session|quit. */
  onSessionShutdown(reason: string): void;
  /** session_start: consume the marker and complete the record iff D4's conditions all hold. */
  onSessionStart(reason: string): void;
  /** The current wire projection — `undefined` when no valid, non-expired record exists. */
  projection(): ReloadStatusWire | undefined;
  /** The 1Hz tick's change probe (D5): true iff the projection changed since the last probe. */
  tick(): boolean;
}

/**
 * Stateful wrapper over the process-global store. `hooks.publish()` fires ONLY when the wire
 * projection changed (D6: no record / no change ⇒ zero output side effects) — the wiring layer
 * decides whether a publish is possible (attached + live link).
 */
export function createReloadTracker(env: ReloadTrackEnv, hooks: { publish(): void }): ReloadTracker {
  let sawReloadShutdown = false;
  let lastFp: string | undefined;
  const currentRec = (now: number): ReloadTrackRecord | undefined => readValidRec(readStore(), now);
  const observe = (before: string): void => {
    const after = fingerprint(currentRec(env.now()));
    lastFp = after;
    if (after !== before) hooks.publish();
  };
  const tracker: ReloadTracker = {
    onPhase(event) {
      const now = env.now();
      const store = sanitizeStore(readStore(), now);
      const before = fingerprint(readValidRec(store, now));
      const rec = readValidRec(store, now);
      const webSourced = event.by !== undefined;
      const matchesLife = rec !== undefined && rec.life === event.life;
      if (!matchesLife) {
        // D1: only an ESTABLISHING, WEB-SOURCED fact may open/REPLACE the record (a previous
        // life's closed record included). A TUI fact with no tracked lifecycle is ignored
        // (Q1), and so is any continuation of a foreign life — the port hands out a fresh life
        // once the previous one closed.
        if (!webSourced || !ESTABLISH_FACTS.has(event.kind)) return;
      } else if (!rec.open) {
        // A closed record accepts no continuation facts — the lifecycle ended (D1).
        return;
      }
      const cmdIds = mergeCmdId(matchesLife ? rec.cmdIds : [], webSourced ? event.by : undefined);
      let target: ReloadTrackRecord = matchesLife
        ? { ...rec, cmdIds }
        : {
            v: 1,
            life: event.life,
            cmdIds,
            rev: 0,
            execId: event.execId,
            state: "deferred",
            open: true,
            at: now,
          };
      const commit = (patch: RecPatch): void => {
        target = nextRecord(target, patch, now) ?? target;
      };
      // D1: execution-scoped facts must come from the CURRENT execution.
      if (EXEC_SCOPED_FACTS.has(event.kind) && event.execId !== target.execId) return;
      switch (event.kind) {
        case "deferred":
          commit({
            state: "deferred",
            open: true,
            waitingFor: event.waitingFor,
            ...(event.waitingFor === "runs" && event.activeRuns !== undefined ? { activeRuns: event.activeRuns } : {}),
          });
          break;
        case "idleWait":
          commit({ state: "failed", code: "E_RELOAD_IDLE_WAIT", open: true });
          break;
        case "cancel":
          commit({ state: "cancelled", code: "user", open: false });
          break;
        case "unavailable":
          commit({ state: "failed", code: "E_RELOAD_UNAVAILABLE", open: false });
          break;
        case "exec":
          // A newer attempt becomes the current execution — merged web requests subscribe to
          // its result; the superseded attempt's late facts die on the execId check (A1/A13).
          commit({ execId: event.execId });
          break;
        case "settle":
          commit({ state: "failed", code: "E_RELOAD_SETTLE", open: event.open });
          break;
        case "started": {
          commit({ state: "started", open: true });
          // D4: ONLY an accepted `started` writes the handover marker — requested/deferred can
          // never complete directly.
          const session = env.session();
          if (session !== undefined) {
            store.handover = {
              v: 1,
              life: target.life,
              cmdIds: [...target.cmdIds],
              sessionId: session.sessionId,
              sessionFile: session.sessionFile,
              originEpoch: env.moduleInstance,
              startedAt: now,
            };
          }
          break;
        }
        case "returned":
          // The TUI host returns normally when it refuses (streaming/compacting): a reload that
          // returned WITHOUT this activation having seen shutdown{reload} is E_RELOAD_REFUSED.
          if (!sawReloadShutdown && target.state === "started") {
            commit({ state: "failed", code: "E_RELOAD_REFUSED", open: false });
          }
          break;
        case "threw":
          if (!sawReloadShutdown && target.state === "started") {
            commit({
              state: "failed",
              code: "E_RELOAD_THREW",
              open: false,
              ...(event.message !== undefined ? { message: clipReloadMessage(event.message) } : {}),
            });
          }
          break;
      }
      store.rec = target;
      writeStore(store);
      observe(before);
    },
    onSessionShutdown(reason) {
      const now = env.now();
      const store = sanitizeStore(readStore(), now);
      const before = fingerprint(readValidRec(store, now));
      if (reason === "reload") sawReloadShutdown = true;
      // D4: the OLD activation only completes the marker — no projection change, no frame.
      const marker = readValidMarker(store, now);
      if (reason === "reload" && marker !== undefined && marker.shutdownAt === undefined) {
        store.handover = { ...marker, shutdownAt: now };
        writeStore(store);
        return;
      }
      const rec = readValidRec(store, now);
      if (rec !== undefined && rec.open) {
        if (reason === "reload") {
          if (rec.state !== "started") {
            // A6: another reload superseded a still-parked request — never a completed.
            store.rec = nextRecord(rec, { state: "cancelled", code: "superseded", open: false }, now) ?? rec;
          }
          // state === "started": awaiting the next activation's takeover validation (D4).
        } else {
          const code: ReloadResultCode =
            reason === "new" || reason === "resume" || reason === "fork" ? "session" : "quit";
          store.rec = nextRecord(rec, { state: "cancelled", code, open: false }, now) ?? rec;
        }
      }
      writeStore(store);
      observe(before);
    },
    onSessionStart(reason) {
      const now = env.now();
      const store = sanitizeStore(readStore(), now);
      const before = fingerprint(readValidRec(store, now));
      // D4: read-then-delete on EVERY session start; a failed validation leaves the record
      // as-is (started) — the UI falls back to the effect timer / version inference.
      const marker = readValidMarker(store, now);
      if (marker !== undefined) delete store.handover;
      const rec = readValidRec(store, now);
      const session = env.session();
      const ok =
        reason === "reload" &&
        marker !== undefined &&
        rec !== undefined &&
        rec.life === marker.life &&
        rec.state === "started" &&
        session !== undefined &&
        session.sessionId === marker.sessionId &&
        session.sessionFile === marker.sessionFile &&
        marker.originEpoch !== env.moduleInstance &&
        marker.shutdownAt !== undefined &&
        now - marker.startedAt >= 0 &&
        now - marker.startedAt <= RELOAD_HANDOVER_TTL_MS;
      if (ok && rec !== undefined) {
        const version = env.version();
        store.rec =
          nextRecord(
            rec,
            {
              state: "completed",
              open: false,
              epoch: env.moduleInstance,
              ...(version !== "" && version !== "0.0.0" ? { version } : {}),
            },
            now,
          ) ?? rec;
      }
      writeStore(store);
      observe(before);
    },
    projection() {
      const rec = currentRec(env.now());
      return rec === undefined ? undefined : projectRec(rec);
    },
    tick() {
      const fp = fingerprint(currentRec(env.now()));
      if (fp === lastFp) return false;
      lastFp = fp;
      return true;
    },
  };
  return tracker;
}
