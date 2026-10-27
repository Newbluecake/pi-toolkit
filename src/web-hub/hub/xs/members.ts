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
}

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

  const observer: XsRegistryObserver = {
    onMember(agentKey, frame) {
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
      const m = table.get(agentKey);
      if (m === undefined) return;
      if (m.sessionId !== sessionId)
        table.delete(agentKey); // r1 #4: another session ⇒ void
      else m.activityAt = deps.now();
    },
    onInvalidate(agentKey) {
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
  };
}
