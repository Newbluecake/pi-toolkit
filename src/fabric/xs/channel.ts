import { XS_CHANNEL_NAME_RE, XS_MAX_CHANNELS as WIRE_MAX_CHANNELS } from "../../web-hub/protocol/xs.js";

/**
 * Channel-plan §2.1/§2.3 (CH0): the pure channel-name rules and set algebra shared by the
 * membership store, the sender, the receiver (stage 3), the directory and the hub. pi-free,
 * no state, never throws.
 */

/** Q1: the default channel's canonical name (constant, deliberately not a setting). */
export const XS_DEFAULT_CHANNEL = "default";
/** Q8: at most this many channels per session (the wire constant is the single source). */
export const XS_MAX_CHANNELS = WIRE_MAX_CHANNELS;
/** §2.1: names that can never be joined (the default channel is NOT reserved — it is joined by bare `/fabric join`). */
export const XS_RESERVED_CHANNELS: readonly string[] = Object.freeze([
  "all",
  "everyone",
  "here",
  "none",
  "root",
  "system",
  "main",
  "hub",
  "session",
  "xs",
]);
/** §2.1: any name starting with this prefix is reserved. */
export const XS_RESERVED_CHANNEL_PREFIX = "pi-";

/**
 * §2.1 canonical form: strip ONE leading `#`, ASCII-lowercase, then require `XS_CHANNEL_NAME_RE`.
 * Non-ASCII anything (incl. full-width letters / homoglyphs) is rejected, never folded. Syntax only —
 * reserved names are judged by `checkChannelName`. Returns `null` when invalid.
 */
export function normalizeChannel(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const bare = input.startsWith("#") ? input.slice(1) : input;
  // Reject non-ASCII BEFORE lower-casing: toLowerCase would fold e.g. "K" (U+212A KELVIN SIGN) into ASCII "k".
  if (!/^[\x21-\x7e]*$/.test(bare)) return null;
  const lower = bare.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return XS_CHANNEL_NAME_RE.test(lower) ? lower : null;
}

export function isReservedChannel(name: string): boolean {
  return XS_RESERVED_CHANNELS.includes(name) || name.startsWith(XS_RESERVED_CHANNEL_PREFIX);
}

export type XsChannelNameCheck = { ok: true; name: string } | { ok: false; reason: "invalid" | "reserved" };

/** `normalizeChannel` + the reserved-name rule — what `/fabric join`, `channels.autoJoin` and the
 *  `message_channel` tool use for a name a human/model typed. */
export function checkChannelName(input: unknown): XsChannelNameCheck {
  const name = normalizeChannel(input);
  if (name === null) return { ok: false, reason: "invalid" };
  if (isReservedChannel(name)) return { ok: false, reason: "reserved" };
  return { ok: true, name };
}

/** `#name` display form. */
export function displayChannel(name: string): string {
  return `#${name}`;
}

/** §2.1 `channelSet`: de-duplicated, sorted, `default` first. Input is trusted to be canonical
 *  names (use `normalizeChannel` first); it does NOT truncate to the cap (see `capChannels`). */
export function channelSet(names: Iterable<string>): string[] {
  const uniq = [...new Set(names)];
  uniq.sort((a, b) => {
    if (a === b) return 0;
    if (a === XS_DEFAULT_CHANNEL) return -1;
    if (b === XS_DEFAULT_CHANNEL) return 1;
    return a < b ? -1 : 1;
  });
  return uniq;
}

/** Read-back helper (§2.4): normalize each entry (invalid/reserved-agnostic: syntax only, because
 *  a persisted entry was already admitted), drop invalid ones, then `channelSet`, then truncate to
 *  `XS_MAX_CHANNELS`. */
export function capChannels(names: Iterable<unknown>): string[] {
  const out: string[] = [];
  for (const n of names) {
    const c = normalizeChannel(n);
    if (c !== null) out.push(c);
  }
  return channelSet(out).slice(0, XS_MAX_CHANNELS);
}

/** §2.1 `intersect`: the shared channels of two sets, in `channelSet` order. */
export function intersect(a: readonly string[], b: readonly string[]): string[] {
  const bs = new Set(b);
  return channelSet(a.filter((x) => bs.has(x)));
}

/** True iff the two sets share at least one channel (the visibility rule, §4.1). */
export function shares(a: readonly string[], b: readonly string[]): boolean {
  const bs = new Set(b);
  return a.some((x) => bs.has(x));
}

/** True iff `set` is exactly `[default]`. */
export function isDefaultOnly(set: readonly string[]): boolean {
  return set.length === 1 && set[0] === XS_DEFAULT_CHANNEL;
}

/** §2.3 `effectiveChannels(pref, enabled)`: channels disabled ⇒ named channels are SUSPENDED
 *  (dropped from the effective set, never folded into `default`). */
export function effectiveChannels(pref: readonly string[], enabled: boolean): string[] {
  const set = channelSet(pref);
  return enabled ? set : set.filter((c) => c === XS_DEFAULT_CHANNEL);
}

/** §2.3 `linkChannels(pref, enabled, hubCap)`: on a hub without `xs.channel.v1` only `default` can be on the link. */
export function linkChannels(pref: readonly string[], enabled: boolean, hubCap: boolean): string[] {
  const eff = effectiveChannels(pref, enabled);
  return hubCap ? eff : eff.filter((c) => c === XS_DEFAULT_CHANNEL);
}

/** §2.3: `linkJoined ⇔ linkChannels ≠ ∅`. */
export function linkJoined(pref: readonly string[], enabled: boolean, hubCap: boolean): boolean {
  return linkChannels(pref, enabled, hubCap).length > 0;
}

// ----------------------------------------------------------------- §3.2 frozen write rules (pure; every writer uses these)

/** §3.2 `xs_member.channels` / `StatusInfo.xs.channels`: `undefined` ⇒ do NOT write the key
 *  (default-only, empty, or no hub cap); otherwise the effective set to write. */
export function channelsFieldToWrite(effective: readonly string[], hubCap: boolean): string[] | undefined {
  if (!hubCap) return undefined;
  if (effective.length === 0 || isDefaultOnly(effective)) return undefined;
  return [...effective];
}

/** §3.2 `xs_deliver.via` / `xs_res.rows[].channels` / `candidates[].channels`: `undefined` ⇒ do NOT
 *  write the key (shared set is exactly `[default]`, empty, or the peer is not channel-capable). */
export function sharedFieldToWrite(shared: readonly string[], peerChannelCapable: boolean): string[] | undefined {
  if (!peerChannelCapable) return undefined;
  if (shared.length === 0 || isDefaultOnly(shared)) return undefined;
  return [...shared];
}

/** §3.4: a receiver reading an `xs_deliver` with no `via` treats the link as `[default]`. */
export function viaOrDefault(via: readonly string[] | undefined): readonly string[] {
  return via === undefined ? [XS_DEFAULT_CHANNEL] : via;
}
