/**
 * Channel management model (channel-plan §2.1/§7, CHU) — pure, DOM-free.
 *
 * The directory is derived client-side from the per-session `status.xs.channels` the hub already
 * pushes (absent ∧ joined ⇒ `[default]`); no protocol/endpoint is added. Name rules mirror
 * `protocol/xs.ts` (`XS_CHANNEL_NAME_RE`, `XS_MAX_CHANNELS`) and §2.1's reserved list — the
 * pi-side `/fabric join` command stays the authority, this only pre-validates.
 */
import type { AgentState } from "../../types.js";
import { XS_DEFAULT_CHANNEL, xsChannelsOf } from "./agentCardModel.js";

export const XS_CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const XS_MAX_CHANNELS = 4;
const RESERVED = new Set(["all", "everyone", "here", "none", "root", "system", "main", "hub", "session", "xs"]);

export interface ChannelRow {
  readonly name: string;
  readonly members: number;
}

/** default first, then by name. */
function order(a: string, b: string): number {
  if (a === b) return 0;
  if (a === XS_DEFAULT_CHANNEL) return -1;
  if (b === XS_DEFAULT_CHANNEL) return 1;
  return a < b ? -1 : 1;
}

/** Channels currently present on the hub with member counts (offline/down agents excluded). */
export function channelDirectory(agents: ReadonlyMap<string, AgentState>, hubCaps: unknown): readonly ChannelRow[] {
  const counts = new Map<string, number>();
  for (const agent of agents.values()) {
    if (agent.down) continue;
    for (const c of xsChannelsOf(agent, hubCaps) ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, members]) => ({ name, members })).sort((a, b) => order(a.name, b.name));
}

export type ChannelNameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: "empty" | "invalid" | "reserved" | "full" | "joined" };

/** §2.1 normalization (strip `#`, ASCII-lowercase, no non-ASCII) + reserved/limit checks. */
export function checkNewChannel(raw: string, current: readonly string[]): ChannelNameCheck {
  let s = raw.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s === "") return { ok: false, reason: "empty" };
  if (/[^\x00-\x7f]/.test(s)) return { ok: false, reason: "invalid" };
  const name = s.toLowerCase();
  if (!XS_CHANNEL_NAME_RE.test(name)) return { ok: false, reason: "invalid" };
  if (RESERVED.has(name) || name.startsWith("pi-")) return { ok: false, reason: "reserved" };
  if (current.includes(name)) return { ok: false, reason: "joined" };
  if (current.length >= XS_MAX_CHANNELS) return { ok: false, reason: "full" };
  return { ok: true, name };
}

/** Command argument for one toggle: `join #x` / `leave #x`. */
export function channelCommandArgs(verb: "join" | "leave", name: string): string {
  return `${verb} #${name}`;
}
