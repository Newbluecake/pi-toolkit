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
import { XS_HUB_CAP, XsMemberLimitsSchema, type XsMemberLimitsWire, type XsReceiveWire } from "../../protocol/xs.js";

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
  joined: boolean;
  receive: XsReceiveWire;
  limits: XsMemberLimitsWire;
  activityAt: number;
}

/** A member that passed every validity condition at the moment of the read. */
export interface XsEffectiveMember extends XsMemberRecord {
  agentKey: string;
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
}

// ----------------------------------------------------------------- limits clamping (§4.6)

type LimitKey = keyof XsMemberLimitsWire;
const LIMIT_KEYS = Object.keys(XsMemberLimitsSchema.properties) as LimitKey[];

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
    out[key] = typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : min;
  }
  return out as unknown as XsMemberLimitsWire;
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
      table.set(agentKey, {
        sessionId: frame.sessionId,
        epoch: frame.epoch,
        joined: frame.joined,
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
  };
}
