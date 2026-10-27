import { systemClock, type Clock } from "../../core/clock.js";
import { effectiveReceive, isValidXsSessionId } from "../../config/settings.js";
import type { XsReceiveWire } from "../../web-hub/protocol/xs.js";
import {
  XS_DEFAULT_CHANNEL,
  XS_MAX_CHANNELS,
  capChannels,
  channelSet,
  checkChannelName,
  effectiveChannels,
  isDefaultOnly,
  linkChannels,
  normalizeChannel,
} from "./channel.js";
import type { XsChannelView } from "./types-channel.js";

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
 *
 * Channel-plan §2.2–§2.4 (CH3): the joined boolean became the channel PREFERENCE set `pref`
 * (persisted, may hold suspended named channels). `joined ⇔ effectiveChannels(pref, enabled) ≠ ∅`;
 * every gate reads the `XsChannelView` methods (`link(hubCap)` / `linkJoined(hubCap)`). Any change
 * of `pref` bumps the epoch (same counter as join/leave). Entry write rule (§2.4): `∅` ⇒
 * `joined:false`; `[default]` ⇒ `joined:true` WITHOUT a `channels` key (byte-identical to the
 * pre-channel entry); anything else ⇒ `joined: pref∋default` + `channels:[…pref]` (an old plugin
 * only reads `joined` ⇒ at most `#default`, fail closed).
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
  /** Channel-plan §2.4: the preference set; ABSENT for `∅` and for exactly `[default]`. */
  channels?: string[];
  receive: XsReceiveWire;
  receivePref?: XsReceiveWire;
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
 * /new membership handoff (new-session-channels-fix): `/new` (and its web 「清空」 twin) replaces
 * the session with a FRESH sessionId inside the same process, so the new branch carries no
 * `subagent:xs-membership` entry and the channels would be lost. The outgoing stack's explicit
 * membership state rides this single-slot process global (I4: capacity 1, consume-once TTL =
 * the next `session_start`) from `session_shutdown{reason:"new"}` into the next stack build.
 * Forks never write it (P10 stays: fork/copied entries are still ignored by `restore`), and a
 * shutdown for any other reason leaves the slot untouched — the next `session_start` always
 * consumes (and drops) whatever is here unless its own reason is "new".
 */
const XS_HANDOFF_KEY = Symbol.for("pi-subagent:xs-membership-handoff");

export function stashXsMembershipHandoff(entry: XsMembershipEntryData): void {
  (globalThis as Record<symbol, unknown>)[XS_HANDOFF_KEY] = entry;
}

/** Consume-once read: returns the stashed entry (if any) and clears the slot. */
export function takeXsMembershipHandoff(): XsMembershipEntryData | undefined {
  const globals = globalThis as Record<symbol, XsMembershipEntryData | undefined>;
  const entry = globals[XS_HANDOFF_KEY];
  delete globals[XS_HANDOFF_KEY];
  return entry;
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
      // §2.4 read-back: a legal `channels` array (≥1 syntactically valid name) wins; otherwise
      // `joined ⇒ [default]` (decided by `restore`, which reads `channels` absent as the legacy form).
      const channels = Array.isArray(data.channels) ? capChannels(data.channels) : [];
      return {
        v: 1,
        sessionId: data.sessionId,
        joined: data.joined,
        ...(channels.length > 0 ? { channels } : {}),
        receive: data.receive,
        ...(data.receivePref === "replies" ? { receivePref: data.receivePref } : {}),
        blocked,
        ...(typeof data.joinedAt === "number" ? { joinedAt: data.joinedAt } : {}),
      };
    }
    return undefined; // newest entry exists but is malformed ⇒ no restorable state
  }
  return undefined;
}

/**
 * `join`/`leave` results. The success shape stays `{ok, epoch}` (reply-off golden pins it); the
 * resulting set is read back through `pref()`. Channel refusals (§2.2) reject the WHOLE call:
 * `channels_disabled` (a named channel with `channels.enabled=false`), `invalid` / `reserved`
 * (with the offending raw inputs), `too_many` (merged set above `XS_MAX_CHANNELS`).
 */
export type XsChannelRefusal =
  | { ok: false; reason: "channels_disabled" }
  | { ok: false; reason: "invalid" | "reserved"; names: string[] }
  | { ok: false; reason: "too_many"; max: number };
export type XsJoinResult = { ok: true; epoch: number } | { ok: false; reason: "already_joined" } | XsChannelRefusal;
export type XsLeaveResult =
  { ok: true; epoch: number } | { ok: false; reason: "not_joined" } | Exclude<XsChannelRefusal, { reason: "too_many" }>;
export type XsBlockResult =
  { ok: true; entry: XsBlockEntry; size: number } | { ok: false; reason: "cap" | "duplicate" | "invalid_id" };
export type XsUnblockResult =
  | { ok: true; released: XsBlockEntry[] }
  | { ok: false; reason: "not_found" | "ambiguous"; candidates?: XsBlockEntry[] };

export interface XsMembershipDeps {
  sessionId: string;
  /** `fabric.crossSession.receive` default (P2: wake); a restored entry overrides it. */
  defaultReceive?: XsReceiveWire;
  replyEnabled?: boolean;
  /** `fabric.crossSession.allowFrom` (already validated by the settings parser, XS0 #14). */
  allowFrom?: readonly string[];
  /** `fabric.crossSession.allowFromDenyAll` — non-empty-but-all-invalid ⇒ reject every sender. */
  allowFromDenyAll?: boolean;
  /** `fabric.crossSession.channels.enabled` (channel-plan Q6, default true). false ⇒ named
   *  channels in `pref` are SUSPENDED (§2.3) and join/leave with a named channel is refused. */
  channelsEnabled?: boolean;
  blockCap?: number;
  epoch?: XsEpochCounter;
  clock?: Clock;
  /** appendEntry wiring; MUST NOT throw (best-effort persistence, §10.2). */
  persist(data: XsMembershipEntryData): void;
}

export class XsMembership implements XsChannelView {
  private readonly clock: Clock;
  private readonly epochCounter: XsEpochCounter;
  private readonly blockCap: number;
  private readonly allowFrom: readonly string[];
  /** Channel-plan §2.2: the persisted preference set (canonical, `channelSet` order). */
  private channelPref: string[] = [];
  private receiveState: XsReceiveWire;
  private blocked: XsBlockEntry[] = [];
  private joinedAt: number | undefined;
  private restored = false;
  /** /new handoff: explicit human state exists (a matching entry was restored or any mutation flushed). */
  private explicit = false;

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

  /** §2.3: `joined ⇔ effectiveChannels(pref, enabled) ≠ ∅` (local; gates use `linkJoined`). */
  get joined(): boolean {
    return this.effective().length > 0;
  }

  get channelsEnabled(): boolean {
    return this.deps.channelsEnabled ?? true;
  }

  // ---- XsChannelView (types-channel.ts, CH0-frozen) ----

  pref(): readonly string[] {
    return [...this.channelPref];
  }

  effective(): readonly string[] {
    return effectiveChannels(this.channelPref, this.channelsEnabled);
  }

  link(hubCap: boolean): readonly string[] {
    return linkChannels(this.channelPref, this.channelsEnabled, hubCap);
  }

  linkJoined(hubCap: boolean): boolean {
    return this.link(hubCap).length > 0;
  }

  /** §2.3: named channels kept in `pref` but not effective (`channels.enabled=false`). */
  suspended(): readonly string[] {
    const eff = new Set(this.effective());
    return this.channelPref.filter((c) => !eff.has(c));
  }

  /** Current session-level receive value (what rides `xs_member`; meaningful once joined). */
  get receive(): XsReceiveWire {
    return effectiveReceive(this.receiveState, this.replyEnabled);
  }

  get receivePref(): XsReceiveWire {
    return this.receiveState;
  }

  get replyEnabled(): boolean {
    return this.deps.replyEnabled ?? true;
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
    this.applyEntry(entry);
    this.explicit = true;
  }

  /** §2.4 entry application shared by `restore` and `adopt`. */
  private applyEntry(entry: XsMembershipEntryData): void {
    // §2.4: a legal `channels` array wins (already normalized + capped by the reader; re-run
    // defensively for hand-built entries); otherwise the legacy `joined ⇒ [default]`.
    const channels = entry.channels === undefined ? [] : capChannels(entry.channels);
    this.channelPref = channels.length > 0 ? channels : entry.joined ? [XS_DEFAULT_CHANNEL] : [];
    this.receiveState = entry.receivePref ?? entry.receive;
    this.blocked = entry.blocked.filter((b) => isValidXsSessionId(b.sessionId)).slice(0, this.blockCap);
    if (typeof entry.joinedAt === "number") this.joinedAt = entry.joinedAt;
  }

  /**
   * /new handoff (new-session-channels-fix): the state a SAME-PROCESS `/new` successor should
   * inherit, or undefined when this membership carries no explicit human state (never joined/
   * left/blocked and no matching entry restored) — in that case the successor behaves exactly
   * like a fresh session today (autoJoin still applies). An explicit LEAVE is explicit state
   * too, so the successor stays un-joined (mirroring "explicit persisted leave wins over
   * autoJoin").
   */
  handoffSnapshot(): XsMembershipEntryData | undefined {
    return this.explicit ? this.toEntryData() : undefined;
  }

  /**
   * /new handoff: apply the outgoing session's snapshot IGNORING its sessionId (the whole point
   * of the handoff — unlike `restore`, which rejects mismatches for fork safety) and persist it
   * under THIS session's id so a later `/reload` restores it. Call at most once per stack build,
   * after `restore` found no entry of its own. No epoch bump: attach() already bumped for this
   * stack and no in-flight origin can exist yet.
   */
  adopt(entry: XsMembershipEntryData): void {
    this.applyEntry(entry);
    this.explicit = true;
    this.flush();
  }

  /**
   * Channel-plan §2.2 (Q3): INCREMENTAL join. No argument (or an empty list) ⇒ `pref ∪= {default}`
   * (the pre-channel join). `channels` ⇒ `pref ∪= channels` without touching `default`. Invalid /
   * reserved names, a merged set above 4, or a named channel while `channels.enabled=false`
   * reject the whole call (nothing changes). No change ⇒ `already_joined`; a change bumps the epoch.
   */
  join(channels?: readonly string[]): XsJoinResult {
    const parsed = this.parseArgs(channels ?? [], "join");
    if (!parsed.ok) return parsed.refusal;
    const add = parsed.names.length === 0 ? [XS_DEFAULT_CHANNEL] : parsed.names;
    const next = channelSet([...this.channelPref, ...add]);
    if (next.length > XS_MAX_CHANNELS) return { ok: false, reason: "too_many", max: XS_MAX_CHANNELS };
    if (next.length === this.channelPref.length) return { ok: false, reason: "already_joined" };
    const wasJoined = this.joined;
    this.channelPref = next;
    if (!wasJoined || this.joinedAt === undefined) this.joinedAt = this.clock.now();
    const epoch = this.epochCounter.bump();
    this.flush();
    return { ok: true, epoch };
  }

  /**
   * Channel-plan §2.2: no argument ⇒ `pref = ∅` (suspended channels included); `channels` ⇒
   * `pref −= channels` (`leave #default` is the only way to isolate from the default channel).
   * Invalid names / named channels while disabled reject the whole call. No change ⇒ `not_joined`.
   */
  leave(channels?: readonly string[]): XsLeaveResult {
    const parsed = this.parseArgs(channels ?? [], "leave");
    if (!parsed.ok) return parsed.refusal as Exclude<XsChannelRefusal, { reason: "too_many" }>;
    const drop = new Set(parsed.names);
    const next = parsed.names.length === 0 ? [] : this.channelPref.filter((c) => !drop.has(c));
    if (next.length === this.channelPref.length) return { ok: false, reason: "not_joined" };
    this.channelPref = next;
    const epoch = this.epochCounter.bump();
    this.flush(); // blocklist + receive deliberately persist through leave (§5.3)
    return { ok: true, epoch };
  }

  /** §2.1/§2.2 argument rules shared by join/leave (whole-call rejection, never partial). */
  private parseArgs(
    raw: readonly string[],
    op: "join" | "leave",
  ): { ok: true; names: string[] } | { ok: false; refusal: XsChannelRefusal } {
    const names: string[] = [];
    const invalid: string[] = [];
    const reserved: string[] = [];
    for (const input of raw) {
      if (op === "join") {
        const checked = checkChannelName(input);
        if (checked.ok) names.push(checked.name);
        else (checked.reason === "reserved" ? reserved : invalid).push(input);
      } else {
        // leave only needs the syntax: a reserved name can never be in `pref`.
        const name = normalizeChannel(input);
        if (name === null) invalid.push(input);
        else names.push(name);
      }
    }
    if (invalid.length > 0) return { ok: false, refusal: { ok: false, reason: "invalid", names: invalid } };
    if (reserved.length > 0) return { ok: false, refusal: { ok: false, reason: "reserved", names: reserved } };
    // §2.2: anything touching a NAMED channel is refused while channels are disabled.
    if (!this.channelsEnabled && names.some((n) => n !== XS_DEFAULT_CHANNEL))
      return { ok: false, refusal: { ok: false, reason: "channels_disabled" } };
    return { ok: true, names: channelSet(names) };
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

  /** Current persisted state (also what `restore` round-trips through the entry). §2.4 write rule. */
  toEntryData(): XsMembershipEntryData {
    const pref = this.channelPref;
    const legacy = pref.length === 0 || isDefaultOnly(pref);
    return {
      v: 1,
      sessionId: this.deps.sessionId,
      joined: legacy ? pref.length > 0 : pref.includes(XS_DEFAULT_CHANNEL),
      ...(legacy ? {} : { channels: [...pref] }),
      receive: this.receiveState === "replies" ? "off" : this.receiveState,
      ...(this.receiveState === "replies" ? { receivePref: "replies" as const } : {}),
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
    this.explicit = true; // join/leave/receive/block/unblock/adopt are all explicit human state
    this.deps.persist(this.toEntryData());
  }
}
