/**
 * Alias-force-default AF7 (§5.5): the `/new` alias handoff slot — pi-free, the twin of membership's
 * `stashXsMembershipHandoff` (#70). At `session_shutdown{reason:"new"}` the outgoing stack's held alias (and its
 * "a human already decided" flag) is parked in ONE process-global slot; the very next `session_start` consumes it
 * (any reason clears it, only `reason:"new"` adopts it). Capacity 1, consume-once, TTL {@link XS_ALIAS_HANDOFF_SLOT_TTL_MS}
 * (I4: nothing but this `Symbol.for` global survives an activation).
 *
 * The slot carries NO authority: the hub moves an alias only on its own evidence (a succession edge it recorded on the
 * same socket, `hub/xs/members.ts`), never because an agent says so.
 */

export const XS_ALIAS_HANDOFF_KEY = Symbol.for("pi-subagent:xs-alias-handoff");
/** Shutdown → next session_start. A `/new` takes milliseconds; anything older is a leftover. */
export const XS_ALIAS_HANDOFF_SLOT_TTL_MS = 60_000;
/** How long the adopted handoff stays pending on the NEW session (≈ the hub's succession edge TTL, 120 s). After that the
 *  agent stops trying and the ordinary auto path decides. */
export const XS_ALIAS_HANDOFF_PENDING_MS = 120_000;

export interface XsAliasHandoffShot {
  /** The outgoing session id. */
  fromSessionId: string;
  /** The held alias at shutdown (display-cache view); absent ⇒ nothing to move. */
  alias?: string;
  /** The outgoing session carried the I8 "human decided" mark: the successor inherits it. */
  decided: boolean;
  /** `Date.now()` at stash time. */
  at: number;
}

/** Park a snapshot. Nothing to carry (no alias, not decided) ⇒ do not write — same as #70's pristine rule. */
export function stashXsAliasHandoff(shot: XsAliasHandoffShot): void {
  if (shot.alias === undefined && !shot.decided) return;
  (globalThis as Record<symbol, unknown>)[XS_ALIAS_HANDOFF_KEY] = { ...shot };
}

/** Consume-once read (the slot is always cleared); older than the TTL (or a future-dated stamp) ⇒ `undefined`. */
export function takeXsAliasHandoff(now: number): XsAliasHandoffShot | undefined {
  const globals = globalThis as Record<symbol, XsAliasHandoffShot | undefined>;
  const shot = globals[XS_ALIAS_HANDOFF_KEY];
  delete globals[XS_ALIAS_HANDOFF_KEY];
  if (shot === undefined || typeof shot.fromSessionId !== "string" || typeof shot.at !== "number") return undefined;
  const age = now - shot.at;
  if (!(age >= 0 && age <= XS_ALIAS_HANDOFF_SLOT_TTL_MS)) return undefined;
  return shot;
}
