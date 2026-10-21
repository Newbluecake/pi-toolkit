import { systemClock, type Clock } from "../../core/clock.js";
import { isValidXsSessionId } from "../../config/settings.js";
import type { XsReceiveWire } from "../../web-hub/protocol/xs.js";

/**
 * fabric phase-2 X4 (phase2-plan §5.3 join control / §8.1 membership & epoch / §2.4 D2):
 * the SESSION-LEVEL cross-session membership — joined flag, per-session receive override,
 * blocklist — plus the `subagent:xs-membership` persistence entry and the process-level epoch
 * counter. Two human-controlled layers (P1): the settings switch (XS0) and this session join;
 * an agent can neither join nor leave.
 *
 * Persistence (D2): one entry type, `{v:1, sessionId, joined, receive, blocked}`, appended on
 * every change through the injected `persist` port (the XW assembly wires `pi.appendEntry`;
 * failures are swallowed there). Read-back is `getBranch()`-based (never `getEntries()` — a
 * fork must not resurrect a sibling's join, P10): `readXsMembershipEntry` takes the branch and
 * `restore()` ignores any entry whose `sessionId` differs from the live one ⇒ a fork starts
 * un-joined. The blocklist survives `leave` (it is operator-curated, not membership state).
 *
 * Epoch (§8.1): process-level monotonic counter bumped at stack attach, `join` and `leave` —
 * NOT at receive changes (in-flight requests keep their epoch). It rides `xs_member` and is
 * what the receiver compares against `xs_deliver.to.epoch` (§8.4 stage 4). Pi-free.
 */

export const XS_MEMBERSHIP_CUSTOM_TYPE = "subagent:xs-membership";
/** `/fabric block` list cap (§5.3). */
export const XS_BLOCK_CAP = 64;
/** `/fabric unblock` prefix matching threshold (§5.3/#14 — same as resolve's 8). */
export const XS_UNBLOCK_PREFIX_MIN = 8;

export interface XsBlockEntry {
  sessionId: string;
  /** Name snapshot taken at block time — display + offline unblock selector only (§5.3). */
  nameSnapshot?: string;
  at: number;
}

export interface XsMembershipEntryData {
  v: 1;
  sessionId: string;
  joined: boolean;
  receive: XsReceiveWire;
  blocked: XsBlockEntry[];
  joinedAt?: number;
}

/** §8.1: `epoch` bump points — stack attach, join, leave (receive changes deliberately absent). */
export class XsEpochCounter {
  private n: number;
  constructor(start = 0) {
    this.n = Number.isInteger(start) && start >= 0 ? start : 0;
  }
  get value(): number {
    return this.n;
  }
  bump(): number {
    return ++this.n;
  }
}

const XS_EPOCH_KEY = Symbol.for("pi-subagent:xs-epoch");

/** Process-global epoch counter (survives `/reload`; a new stack attaches and bumps). */
export function getXsEpochCounter(): XsEpochCounter {
  const globals = globalThis as Record<symbol, XsEpochCounter | undefined>;
  return (globals[XS_EPOCH_KEY] ??= new XsEpochCounter());
}

/**
 * Read the LAST `subagent:xs-membership` entry off a session branch. Tolerant of malformed
 * entries (never throws): only a `v:1` entry with plausible fields counts. `getBranch()` shape
 * `{type, customType?, data?}` — same projection `readRootLevel` uses.
 */
export function readXsMembershipEntry(
  branch: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): XsMembershipEntryData | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "custom" || entry.customType !== XS_MEMBERSHIP_CUSTOM_TYPE) continue;
    const data = entry.data as Partial<XsMembershipEntryData> | undefined;
    if (
      data?.v === 1 &&
      typeof data.sessionId === "string" &&
      typeof data.joined === "boolean" &&
      (data.receive === "off" || data.receive === "deliver" || data.receive === "wake") &&
      Array.isArray(data.blocked)
    ) {
      const blocked: XsBlockEntry[] = [];
      for (const raw of data.blocked) {
        const candidate = raw as Partial<XsBlockEntry> | null | undefined;
        if (typeof candidate?.sessionId === "string" && typeof candidate.at === "number") {
          blocked.push({
            sessionId: candidate.sessionId,
            ...(candidate.nameSnapshot !== undefined ? { nameSnapshot: candidate.nameSnapshot } : {}),
            at: candidate.at,
          });
        }
      }
      return {
        v: 1,
        sessionId: data.sessionId,
        joined: data.joined,
        receive: data.receive,
        blocked,
        ...(typeof data.joinedAt === "number" ? { joinedAt: data.joinedAt } : {}),
      };
    }
    return undefined; // newest entry exists but is malformed ⇒ no restorable state
  }
  return undefined;
}

export type XsJoinResult = { ok: true; epoch: number } | { ok: false; reason: "already_joined" };
export type XsLeaveResult = { ok: true; epoch: number } | { ok: false; reason: "not_joined" };
export type XsBlockResult =
  { ok: true; entry: XsBlockEntry; size: number } | { ok: false; reason: "cap" | "duplicate" | "invalid_id" };
export type XsUnblockResult =
  | { ok: true; released: XsBlockEntry[] }
  | { ok: false; reason: "not_found" | "ambiguous"; candidates?: XsBlockEntry[] };

export interface XsMembershipDeps {
  sessionId: string;
  /** `fabric.crossSession.receive` default (P2: wake); a restored entry overrides it. */
  defaultReceive?: XsReceiveWire;
  /** `fabric.crossSession.allowFrom` (already validated by the settings parser, XS0 #14). */
  allowFrom?: readonly string[];
  /** `fabric.crossSession.allowFromDenyAll` — non-empty-but-all-invalid ⇒ reject every sender. */
  allowFromDenyAll?: boolean;
  blockCap?: number;
  epoch?: XsEpochCounter;
  clock?: Clock;
  /** appendEntry wiring; MUST NOT throw (best-effort persistence, §10.2). */
  persist(data: XsMembershipEntryData): void;
}

export class XsMembership {
  private readonly clock: Clock;
  private readonly epochCounter: XsEpochCounter;
  private readonly blockCap: number;
  private readonly allowFrom: readonly string[];
  private joinedState = false;
  private receiveState: XsReceiveWire;
  private blocked: XsBlockEntry[] = [];
  private joinedAt: number | undefined;
  private restored = false;

  constructor(private readonly deps: XsMembershipDeps) {
    this.clock = deps.clock ?? systemClock;
    this.epochCounter = deps.epoch ?? getXsEpochCounter();
    this.blockCap = deps.blockCap ?? XS_BLOCK_CAP;
    this.allowFrom = deps.allowFrom ?? [];
    this.receiveState = deps.defaultReceive ?? "wake";
  }

  /** Stack attach (§8.1): bump the epoch once per stack build. */
  attach(): number {
    return this.epochCounter.bump();
  }

  get epoch(): number {
    return this.epochCounter.value;
  }

  get sessionId(): string {
    return this.deps.sessionId;
  }

  get joined(): boolean {
    return this.joinedState;
  }

  /** Current session-level receive value (what rides `xs_member`; meaningful once joined). */
  get receive(): XsReceiveWire {
    return this.receiveState;
  }

  /**
   * Restore from the session branch (D2/P10): an entry recorded for a DIFFERENT sessionId (a
   * fork's copy of the file) is ignored ⇒ the fork starts un-joined. Idempotent; call before
   * the first join/leave. `joinedAt` survives so `/fabric status` can show it across reload.
   */
  restore(entry: XsMembershipEntryData | undefined): void {
    if (this.restored || entry === undefined) {
      this.restored = true;
      return;
    }
    this.restored = true;
    if (entry.sessionId !== this.deps.sessionId) return; // fork / copied file (P10)
    this.joinedState = entry.joined;
    this.receiveState = entry.receive;
    this.blocked = entry.blocked.filter((b) => isValidXsSessionId(b.sessionId)).slice(0, this.blockCap);
    if (typeof entry.joinedAt === "number") this.joinedAt = entry.joinedAt;
  }

  join(): XsJoinResult {
    if (this.joinedState) return { ok: false, reason: "already_joined" };
    this.joinedState = true;
    this.joinedAt = this.clock.now();
    const epoch = this.epochCounter.bump();
    this.flush();
    return { ok: true, epoch };
  }

  leave(): XsLeaveResult {
    if (!this.joinedState) return { ok: false, reason: "not_joined" };
    this.joinedState = false;
    const epoch = this.epochCounter.bump();
    this.flush(); // blocklist + receive deliberately persist through leave (§5.3)
    return { ok: true, epoch };
  }

  setReceive(mode: XsReceiveWire): { changed: boolean } {
    if (this.receiveState === mode) return { changed: false };
    this.receiveState = mode; // NO epoch bump (§8.1) — in-flight requests keep their epoch
    this.flush();
    return { changed: true };
  }

  /**
   * Add a blocklist entry (§5.3): the CALLER (the `/fabric block` command) has already resolved
   * the argument to a full unique sessionId. Duplicates and the cap refuse; the blocklist is
   * stored in insertion order.
   */
  block(sessionId: string, nameSnapshot?: string): XsBlockResult {
    if (!isValidXsSessionId(sessionId)) return { ok: false, reason: "invalid_id" };
    if (this.blocked.some((b) => b.sessionId === sessionId)) return { ok: false, reason: "duplicate" };
    if (this.blocked.length >= this.blockCap) return { ok: false, reason: "cap" };
    const entry: XsBlockEntry = {
      sessionId,
      ...(nameSnapshot !== undefined && nameSnapshot !== "" ? { nameSnapshot } : {}),
      at: this.clock.now(),
    };
    this.blocked.push(entry);
    this.flush();
    return { ok: true, entry, size: this.blocked.length };
  }

  /**
   * Offline unblock (§5.3): resolve `<n | full sessionId | prefix≥8 | name snapshot>` against
   * the LOCAL list only — never the hub. Ambiguity lists candidates (blocked entries carry
   * their own `ref`-style short form in the UI, computed by the command).
   */
  unblock(selector: string): XsUnblockResult {
    const trimmed = selector.trim();
    if (/^\d+$/.test(trimmed)) {
      const index = Number.parseInt(trimmed, 10);
      const entry = this.blocked[index - 1];
      if (entry === undefined) return { ok: false, reason: "not_found" };
      return this.releaseWhere((b) => b === entry);
    }
    if (isValidXsSessionId(trimmed)) {
      const exact = this.blocked.filter((b) => b.sessionId === trimmed);
      if (exact.length === 1) return this.releaseWhere((b) => b === exact[0]);
      if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact }; // defensive: duplicates are refused on insert
    }
    if (trimmed.length >= XS_UNBLOCK_PREFIX_MIN) {
      const byPrefix = this.blocked.filter((b) => b.sessionId.startsWith(trimmed));
      if (byPrefix.length === 1) return this.releaseWhere((b) => b === byPrefix[0]);
      if (byPrefix.length > 1) return { ok: false, reason: "ambiguous", candidates: byPrefix };
    }
    const byName = this.blocked.filter((b) => b.nameSnapshot === trimmed);
    if (byName.length === 1) return this.releaseWhere((b) => b === byName[0]);
    if (byName.length > 1) return { ok: false, reason: "ambiguous", candidates: byName };
    return { ok: false, reason: "not_found" };
  }

  blockedSnapshot(): readonly XsBlockEntry[] {
    return this.blocked.map((b) => ({ ...b }));
  }

  /**
   * Stage-3 sender gate (§8.4): joined-ness and receive are checked by the receiver around
   * this; here exactly the sender-identity policy — blocklist, then allowFrom (empty ⇒ any
   * joined session; `allowFromDenyAll` ⇒ reject everything, fail closed #14).
   */
  senderAllowed(fromSessionId: string): boolean {
    if (this.blocked.some((b) => b.sessionId === fromSessionId)) return false;
    if (this.deps.allowFromDenyAll === true) return false;
    if (this.allowFrom.length === 0) return true;
    return this.allowFrom.includes(fromSessionId);
  }

  allowFromView(): { list: readonly string[]; denyAll: boolean } {
    return { list: [...this.allowFrom], denyAll: this.deps.allowFromDenyAll === true };
  }

  joinedAtAgo(now: number = this.clock.now()): number | undefined {
    return this.joinedAt === undefined ? undefined : Math.max(0, now - this.joinedAt);
  }

  /** Current persisted state (also what `restore` round-trips through the entry). */
  toEntryData(): XsMembershipEntryData {
    return {
      v: 1,
      sessionId: this.deps.sessionId,
      joined: this.joinedState,
      receive: this.receiveState,
      blocked: this.blocked.map((b) => ({ ...b })),
      ...(this.joinedAt !== undefined ? { joinedAt: this.joinedAt } : {}),
    };
  }

  private releaseWhere(predicate: (b: XsBlockEntry) => boolean): XsUnblockResult {
    const released = this.blocked.filter(predicate);
    if (released.length === 0) return { ok: false, reason: "not_found" };
    this.blocked = this.blocked.filter((b) => !predicate(b));
    this.flush();
    return { ok: true, released };
  }

  private flush(): void {
    this.deps.persist(this.toEntryData());
  }
}
