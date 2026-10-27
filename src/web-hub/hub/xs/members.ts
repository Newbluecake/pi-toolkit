/**
 * fabric phase-2 X1 (phase2-plan §8.1/§5.1): the hub-side cross-session MEMBER table.
 *
 * Authoritative membership rides the `xs_member` SLOT frame only (never `StatusInfo.xs`, #4).
 * This table sits NEXT to the registry's records: `registry.ts` merely forwards the events
 * (`xs_member` / `session` / `session_detached` / activity / disconnect-reclaim-down) through
 * {@link XsRegistryObserver}; every validity decision is made here, by joining the stored member
 * record with the registry's current {@link XsRecordView} at READ time:
 *
 *   effective member ⇔ record exists
 *                    ∧ socket currently connected ∧ phase === "live"
 *                    ∧ !detached
 *                    ∧ record.sessionId === session.sessionId   (session/status are separate frames,
 *                                                                so an old joined can never spill
 *                                                                onto a new session — r1 #4)
 *                    ∧ hello caps ∋ `xs.v1`
 *
 * Invalidation is also eager (a `session` frame with another id, `session_detached`, close,
 * reclaim, down all DROP the record) so a stale record can never be resurrected by a later frame
 * order accident: only a fresh `xs_member` re-establishes membership.
 *
 * pi-free (boundary: node:* + relative hub/protocol imports only). No timers, no I/O.
 */
import type { AgentId, AgentKind, XsMemberFrame } from "../../protocol/messages.js";
import {
  XS_ALIAS_AGENT_CAP,
  XS_ALIAS_V2_AGENT_CAP,
  XS_CHANNEL_AGENT_CAP,
  XS_CHANNEL_NAME_RE,
  XS_HUB_CAP,
  XS_MAX_CHANNELS,
  XS_REPLY_AGENT_CAP,
  XsMemberLimitsSchema,
  type XsMemberLimitsWire,
  type XsReceiveWire,
} from "../../protocol/xs.js";

/** What the registry exposes about one record (no AgentView widening — see `Registry.xsView`). */
export interface XsRecordView {
  phase: "live" | "claiming" | "stale";
  /** A socket is attached right now (`phase === "live"` alone is not enough for a claiming card). */
  connected: boolean;
  detached: boolean;
  sessionId: string | undefined;
  sessionName: string | undefined;
  /** Session cwd when a session is known, else the hello cwd. */
  cwd: string;
  kind: AgentKind;
  caps: readonly string[];
  busy: boolean;
  agentId: AgentId;
}

/** Events the registry forwards. All handlers are non-throwing by contract (the registry also
 *  isolates them with try/catch). */
export interface XsRegistryObserver {
  onMember(agentKey: string, frame: XsMemberFrame): void;
  /** After a `session` frame was applied to the record. */
  onSession(agentKey: string, sessionId: string): void;
  /** `session_detached`, socket close, reclaim, down. */
  onInvalidate(agentKey: string, reason: "detached" | "closed" | "reclaimed" | "down"): void;
  /** status / ev frames — only feeds `lastActiveAgoS`. */
  onActivity(agentKey: string): void;
  /** An `xs_ack` arrived with no matching pending (hub already settled/timed out). */
  onLateAck(agentKey: string): void;
}

export interface XsMemberRecord {
  sessionId: string;
  epoch: number;
  /** Channel-plan §2.5: `joined ⇔ channels ≠ ∅` (derived from the frame, fail closed). */
  joined: boolean;
  /** Channel-plan §2.5: canonical `channelSet` order; absent on the frame ⇒ `joined ? [default] : []`. */
  channels: readonly string[];
  receive: XsReceiveWire;
  limits: XsMemberLimitsWire;
  activityAt: number;
}

/** A member that passed every validity condition at the moment of the read. */
export interface XsEffectiveMember extends XsMemberRecord {
  agentKey: string;
  /** Peer capability, further gated by the hub reply setting in the router. */
  replyCapable: boolean;
  /** Channel-plan §2.5: `caps ∋ xs.channel.v1` — only such a peer is ever sent a channel field. */
  channelCapable: boolean;
  /** Alias-plan §3.6 (AL2): `caps ∋ xs.alias.v1` (agent side). The router further requires the hub to
   *  have advertised the cap (`aliasUsable`); this flag alone never enables any alias semantics. */
  aliasCapable: boolean;
  /** Alias-force-default (#72, AF2): `caps ∋ xs.alias.v2` (agent side). Only such a peer is ever sent `intent`-era reply
   *  keys or `xs_alias_evt`, and a holder counts as force-`notifiable` only when EVERY member has it. */
  aliasV2Capable: boolean;
  name: string | undefined;
  cwd: string;
  kind: AgentKind;
  busy: boolean;
  agentId: AgentId;
}

export interface XsMembers {
  /** Registry-facing observer (installed with `registry.setXsObserver`). */
  readonly observer: XsRegistryObserver;
  /** The effective member behind one socket's agentKey, or undefined. */
  effective(agentKey: string): XsEffectiveMember | undefined;
  /** Every effective member (any `joined`/`receive` state — callers filter). */
  effectiveAll(): XsEffectiveMember[];
  /** Test/diagnostic: number of stored (not necessarily effective) records. */
  size(): number;
  /** Alias-plan §3.1 (AL2): the STORED record's sessionId behind an agentKey (effective or not) —
   *  lets the presence feed learn which sid an invalidation/session switch just took offline. */
  sessionOf(agentKey: string): string | undefined;
  /**
   * Alias-force-default AF7 (I10): the succession edge this hub itself observed on ONE socket — "this agentKey was on
   * session `from` and is now on the session of its current member record" (`/new`, `/resume`, `/fork` all look the same
   * to the hub; the agent only asks for a handoff after `/new`). Never derived from anything a frame claims: `from` is
   * the sid the hub had already recorded for that same agentKey. `undefined` ⇒ no edge, expired (120 s), or the edge does
   * not lead to the member's current sid. In-memory only: a hub restart forgets it (R22).
   */
  predecessorOf(agentKey: string): { from: string; at: number } | undefined;
  /** AF7: forget the edge (a handoff consumed it). */
  clearPredecessor(agentKey: string): void;
}

/** AF7: how long a succession edge stays usable. */
export const XS_SUCCESSION_TTL_MS = 120_000;

// ----------------------------------------------------------------- shared stamping helpers (router + broadcast)

/** Session ref length (`xs_res` rows/candidates, `xs_deliver.from.ref`). */
export const XS_REF_LEN = 12;
/** Name / cwd-label cap on every stamped field. */
export const XS_NAME_MAX = 120;
/** Strict token shape for anything echoed from a peer (a free-form string could carry text). */
const TOKEN_RE = /^[A-Za-z0-9_:.{}-]{1,64}$/;

export function xsToken(v: unknown): string | undefined {
  return typeof v === "string" && TOKEN_RE.test(v) ? v : undefined;
}

/** The `~` cwd label. */
export function abbreviateHome(path: string, home: string): string {
  if (home.length === 0) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// ----------------------------------------------------------------- channel helpers (channel-plan §2.1/§2.5)
//
// A byte-for-byte mirror of the pure rules in `src/fabric/xs/channel.ts` (the web-hub boundary,
// tests/web-hub/boundary.test.ts, forbids hub code from importing outside {protocol,hub});
// `tests/web-hub/hub/xs-channel-hub.test.ts` pins the two implementations equal on a corpus.

/** Channel-plan Q1: the default channel's canonical name. */
export const XS_HUB_DEFAULT_CHANNEL = "default";

/** `normalizeChannel` mirror: strip ONE leading `#`, reject non-ASCII before lower-casing, then
 *  require `XS_CHANNEL_NAME_RE`. Syntax only (reserved names are an agent-side join rule). */
export function hubNormalizeChannel(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const bare = input.startsWith("#") ? input.slice(1) : input;
  if (!/^[\x21-\x7e]*$/.test(bare)) return null;
  const lower = bare.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return XS_CHANNEL_NAME_RE.test(lower) ? lower : null;
}

/** `channelSet` mirror: de-duplicated, sorted, `default` first. */
export function hubChannelSet(names: Iterable<string>): string[] {
  const uniq = [...new Set(names)];
  uniq.sort((a, b) => {
    if (a === b) return 0;
    if (a === XS_HUB_DEFAULT_CHANNEL) return -1;
    if (b === XS_HUB_DEFAULT_CHANNEL) return 1;
    return a < b ? -1 : 1;
  });
  return uniq;
}

/** `intersect` mirror (canonical order). */
export function hubIntersect(a: readonly string[], b: readonly string[]): string[] {
  const bs = new Set(b);
  return hubChannelSet(a.filter((x) => bs.has(x)));
}

/** §3.2 `sharedFieldToWrite` mirror: `undefined` ⇒ do NOT write the key (shared set exactly
 *  `[default]`, empty, or the peer is not channel-capable). */
export function hubSharedField(shared: readonly string[], peerChannelCapable: boolean): string[] | undefined {
  if (!peerChannelCapable) return undefined;
  if (shared.length === 0 || (shared.length === 1 && shared[0] === XS_HUB_DEFAULT_CHANNEL)) return undefined;
  return [...shared];
}

/**
 * §2.5: a member record's channel set from its `xs_member` frame. `joined:false` ⇒ `[]` whatever
 * the frame says (fail closed); `channels` absent ⇒ `[default]` (an old agent / default-only);
 * present ⇒ each entry normalized, invalid ones dropped, `channelSet`, truncated to the cap. A
 * present-but-all-invalid list yields `[]` ⇒ not joined (never widened to `default`).
 */
export function memberChannelsOf(frame: Pick<XsMemberFrame, "joined" | "channels">): string[] {
  if (frame.joined !== true) return [];
  if (frame.channels === undefined) return [XS_HUB_DEFAULT_CHANNEL];
  const out: string[] = [];
  for (const raw of Array.isArray(frame.channels) ? frame.channels : []) {
    const c = hubNormalizeChannel(raw);
    if (c !== null) out.push(c);
  }
  return hubChannelSet(out).slice(0, XS_MAX_CHANNELS);
}

// ----------------------------------------------------------------- limits clamping (§4.6)

type LimitKey = keyof XsMemberLimitsWire;
const LIMIT_KEYS = Object.keys(XsMemberLimitsSchema.properties) as LimitKey[];
/** Channel-plan §3.3: the three optional broadcast keys. Clamped when present; ABSENT stays absent
 *  in the record and every reader applies the schema's LOWER bound (`broadcastLimitsOf`) — so a
 *  member that never declared them cannot broadcast (0/h) and the legacy record shape is kept. */
const OPTIONAL_LIMIT_KEYS: ReadonlySet<LimitKey> = new Set<LimitKey>([
  "broadcastsOutPerHour",
  "broadcastMinIntervalMs",
  "broadcastWakesOutPerHour",
]);

function boundsOf(key: LimitKey): { min: number; max: number } {
  const prop = XsMemberLimitsSchema.properties[key] as unknown as { minimum: number; maximum: number };
  return { min: prop.minimum, max: prop.maximum };
}

/**
 * §4.6: the hub applies the schema's own min/max as clamping bounds to a member's declared
 * sender limits (same-uid processes are trusted; clamping only contains config accidents).
 * Non-finite/non-numeric ⇒ the LOWER bound (the more restrictive end for every rate cap; for the
 * three 0-allowed keys 0 means "no wake / no pair wake").
 */
export function clampMemberLimits(raw: Readonly<Record<string, unknown>>): XsMemberLimitsWire {
  const out: Record<string, number> = {};
  for (const key of LIMIT_KEYS) {
    const { min, max } = boundsOf(key);
    const v = raw[key];
    if (OPTIONAL_LIMIT_KEYS.has(key) && v === undefined) continue;
    out[key] = typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : min;
  }
  return out as unknown as XsMemberLimitsWire;
}

/** §3.3: the effective broadcast limits of a (clamped) member record — a missing key reads as the
 *  schema's LOWER bound (0 broadcasts/h, 10 s interval, 0 wakes/h). */
export function broadcastLimitsOf(limits: XsMemberLimitsWire): {
  broadcastsOutPerHour: number;
  broadcastMinIntervalMs: number;
  broadcastWakesOutPerHour: number;
} {
  return {
    broadcastsOutPerHour: limits.broadcastsOutPerHour ?? boundsOf("broadcastsOutPerHour").min,
    broadcastMinIntervalMs: limits.broadcastMinIntervalMs ?? boundsOf("broadcastMinIntervalMs").min,
    broadcastWakesOutPerHour: limits.broadcastWakesOutPerHour ?? boundsOf("broadcastWakesOutPerHour").min,
  };
}

// ----------------------------------------------------------------- the table

export function createXsMembers(deps: {
  now: () => number;
  /** `registry.xsView` — evaluated at read time. */
  view: (agentKey: string) => XsRecordView | undefined;
  /** Late-ack accounting belongs to the router; the observer just forwards. */
  onLateAck?: (agentKey: string) => void;
}): XsMembers {
  const table = new Map<string, XsMemberRecord>();
  /** AF7 succession edges: one slot per agentKey (= one socket). `to` is unknown while only the detach was seen. */
  const succession = new Map<string, { from: string; to?: string; at: number }>();

  /** Drop edges that expired or whose socket record is gone (bounded by the number of sockets). */
  function sweepSuccession(): void {
    const t = deps.now();
    for (const [key, e] of succession) {
      if (t - e.at > XS_SUCCESSION_TTL_MS || deps.view(key) === undefined) succession.delete(key);
    }
  }

  /**
   * Called BEFORE the table is overwritten/deleted for `sessionId` arriving on `agentKey`. Three cases: the table
   * still held another sid (direct switch); the table was emptied by a `detached` invalidation and a detach-only edge
   * waits for its successor; the very same sid came back (not a succession ⇒ forget).
   */
  function noteSession(agentKey: string, sessionId: string): void {
    const prev = table.get(agentKey)?.sessionId;
    const e = succession.get(agentKey);
    if (prev !== undefined && prev !== sessionId) {
      sweepSuccession();
      succession.set(agentKey, { from: prev, to: sessionId, at: deps.now() });
    } else if (e !== undefined && e.to === undefined && e.from !== sessionId) {
      succession.set(agentKey, { from: e.from, to: sessionId, at: deps.now() });
    } else if (e !== undefined && e.from === sessionId) {
      succession.delete(agentKey);
    }
  }

  const observer: XsRegistryObserver = {
    onMember(agentKey, frame) {
      noteSession(agentKey, frame.sessionId);
      const channels = memberChannelsOf(frame);
      table.set(agentKey, {
        sessionId: frame.sessionId,
        epoch: frame.epoch,
        joined: channels.length > 0,
        channels,
        receive: frame.receive,
        limits: clampMemberLimits(frame.limits as unknown as Record<string, unknown>),
        activityAt: deps.now(),
      });
    },
    onSession(agentKey, sessionId) {
      noteSession(agentKey, sessionId);
      const m = table.get(agentKey);
      if (m === undefined) return;
      if (m.sessionId !== sessionId)
        table.delete(agentKey); // r1 #4: another session ⇒ void
      else m.activityAt = deps.now();
    },
    onInvalidate(agentKey, reason) {
      // `detached` is how a `/new` (same socket, new session) reaches the hub: the old record goes away BEFORE the
      // successor's `session` frame, so the departing sid is remembered here (a detach-only edge, `to` filled later).
      // Any other reason means the socket/agent is gone ⇒ no succession can follow.
      const m = table.get(agentKey);
      if (reason === "detached" && m !== undefined) {
        sweepSuccession();
        succession.set(agentKey, { from: m.sessionId, at: deps.now() });
      } else if (reason !== "detached") {
        succession.delete(agentKey);
      }
      table.delete(agentKey);
    },
    onActivity(agentKey) {
      const m = table.get(agentKey);
      if (m !== undefined) m.activityAt = deps.now();
    },
    onLateAck(agentKey) {
      deps.onLateAck?.(agentKey);
    },
  };

  function effective(agentKey: string): XsEffectiveMember | undefined {
    const m = table.get(agentKey);
    if (m === undefined) return undefined;
    const v = deps.view(agentKey);
    if (v === undefined) {
      table.delete(agentKey); // the record is gone ⇒ nothing can ever revive this entry
      return undefined;
    }
    if (!v.connected || v.phase !== "live" || v.detached) return undefined;
    if (v.sessionId === undefined || v.sessionId !== m.sessionId) return undefined;
    if (!v.caps.includes(XS_HUB_CAP)) return undefined;
    return {
      ...m,
      agentKey,
      replyCapable: v.caps.includes(XS_REPLY_AGENT_CAP),
      channelCapable: v.caps.includes(XS_CHANNEL_AGENT_CAP),
      aliasCapable: v.caps.includes(XS_ALIAS_AGENT_CAP),
      aliasV2Capable: v.caps.includes(XS_ALIAS_V2_AGENT_CAP),
      name: v.sessionName,
      cwd: v.cwd,
      kind: v.kind,
      busy: v.busy,
      agentId: v.agentId,
    };
  }

  return {
    observer,
    effective,
    effectiveAll() {
      const out: XsEffectiveMember[] = [];
      for (const key of [...table.keys()]) {
        const e = effective(key);
        if (e !== undefined) out.push(e);
      }
      return out;
    },
    size: () => table.size,
    sessionOf: (agentKey) => table.get(agentKey)?.sessionId,
    predecessorOf(agentKey) {
      const e = succession.get(agentKey);
      if (e === undefined) return undefined;
      if (deps.now() - e.at > XS_SUCCESSION_TTL_MS) {
        succession.delete(agentKey);
        return undefined;
      }
      const cur = table.get(agentKey)?.sessionId;
      if (e.to === undefined || cur === undefined || cur !== e.to || e.from === cur) return undefined;
      return { from: e.from, at: e.at };
    },
    clearPredecessor: (agentKey) => {
      succession.delete(agentKey);
    },
  };
}
