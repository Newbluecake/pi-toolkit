import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { XsListOutcome, XsSender } from "../fabric/xs/sender.js";
import type { XsSessionRowWire } from "../web-hub/protocol/xs.js";

/**
 * fabric phase-2 X3 (phase2-plan §4.3/§5.1, P4/P6): `list_sessions` — the discovery half of the
 * main-session cross-session tool pair. Registered ONLY in the main session and only while `xsOn`
 * (assembly belongs to XW; this module just defines the tool). The schema is a frozen module
 * constant — the provider-visible tool table is part of the cached request prefix, so it must
 * never vary per call (same convention as `message_agent`'s activate-frozen schema).
 *
 * Discovery is opt-in both ways: only sessions that explicitly joined (`/fabric join` /
 * `autoJoin`) are listed, and the listing never includes this session itself (hub-side rule,
 * §5.1). `scope:"cwd"` only NARROWS the listing — sends are never scope-limited (P6).
 */

/** Frozen LEGACY instance (channels off / xs off). Byte-identical to the pre-channel schema — the
 *  golden `tests/fixtures/fabric-xs-*-off-golden.json` pins it; never edit. */
export const ListSessionsParamsLegacy = Type.Object({
  query: Type.Optional(
    Type.String({
      maxLength: 128,
      description: "Optional filter over session refs and names (prefix or exact-name match).",
    }),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal("hub"), Type.Literal("cwd")], {
      description:
        '"hub" (default): every joined session on this hub. "cwd": only sessions in the same directory tree — ' +
        "filters this listing only, never limits sends.",
    }),
  ),
});
/** Back-compat name for the legacy instance (src/index.ts + tests import it). */
export const ListSessionsParams = ListSessionsParamsLegacy;

/** Channel-plan §6.2: the second frozen instance (channels on) — legacy properties verbatim plus `channel?`. */
export const ListSessionsParamsChannel = Type.Object({
  ...ListSessionsParamsLegacy.properties,
  channel: Type.Optional(
    Type.String({
      maxLength: 33,
      description:
        "Optional: only sessions that share this channel with you (e.g. #team). Omit to list every session you share " +
        "at least one channel with.",
    }),
  ),
});
export type ListSessionsParams = Static<typeof ListSessionsParamsChannel>;

/** The ONE instance-selection rule: `channels.enabled` (frozen at activate) ⇒ channel instance, else legacy. */
export function listSessionsParamsFor(
  channelsEnabled: boolean,
): typeof ListSessionsParamsLegacy | typeof ListSessionsParamsChannel {
  return channelsEnabled ? ListSessionsParamsChannel : ListSessionsParamsLegacy;
}

/** Row rendering: compact English tokens only (AGENTS.md UI-language split). */
export function formatXsSessionRows(rows: readonly XsSessionRowWire[]): string[] {
  return rows.map((r) => {
    const parts = [
      r.ref,
      // alias-plan §5.3: hub-verified, only written for aliasUsable requesters ⇒ legacy rows unchanged
      ...(r.alias !== undefined ? [`alias=${JSON.stringify(r.alias)}`] : []),
      ...(r.name !== undefined ? [`name=${JSON.stringify(r.name)}`] : []),
      `cwd=${r.cwdLabel}`,
      `kind=${r.kind}`,
      `receive=${r.receive}`,
      r.busy ? "busy" : "idle",
      `lastActive=${r.lastActiveAgoS}s ago`,
      // Channel-plan §3.2/§6.2: the hub only writes `channels` when the shared set is not exactly [default].
      ...(r.channels !== undefined && r.channels.length > 0
        ? [`channels=${r.channels.map((c) => `#${c}`).join(",")}`]
        : []),
    ];
    return `- ${parts.join(" · ")}`;
  });
}

export interface ListSessionsToolDeps {
  sender: XsSender;
  /** `fabric.crossSession.channels.enabled` frozen at activate: selects the schema instance. Omitted/false ⇒ legacy, byte-identical. */
  channels?: boolean;
  /** `fabric.crossSession.alias.enabled` ∧ hub cap, frozen at activate (alias-plan §6): selects the alias
   *  description. The parameter schema is identical to the non-alias instance of the same channel mode
   *  (aliases are matched through the existing `query`), so only the description differs. Omitted/false ⇒ byte-identical. */
  alias?: boolean;
}

const LEGACY_DESCRIPTION =
  "List other explicitly-joined main sessions on this machine's web hub (fabric cross-session). Each row carries a " +
  "short ref, optional name, cwd, receive policy and busy state. Address them with message_session using the ref.";

const CHANNEL_DESCRIPTION =
  LEGACY_DESCRIPTION +
  " You only see sessions that share at least one channel with you; rows outside #default show channels=#a,#b.";

const ALIAS_SUFFIX = " alias is a human-assigned, hub-unique short name.";

export function createListSessionsTool(deps: ListSessionsToolDeps): ToolDefinition<typeof ListSessionsParamsLegacy> {
  const channelsOn = deps.channels === true;
  return {
    name: "list_sessions",
    label: "list_sessions",
    description: (channelsOn ? CHANNEL_DESCRIPTION : LEGACY_DESCRIPTION) + (deps.alias === true ? ALIAS_SUFFIX : ""),
    parameters: (channelsOn ? ListSessionsParamsChannel : ListSessionsParamsLegacy) as typeof ListSessionsParamsLegacy,
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as ListSessionsParams;
      // legacy instance: `channel` can never legitimately arrive and is never forwarded
      const channel = channelsOn ? params.channel : undefined;
      const outcome: XsListOutcome = await deps.sender.list({
        ...(signal !== undefined ? { signal } : {}),
        ...(params.query !== undefined ? { query: params.query } : {}),
        ...(params.scope !== undefined ? { scope: params.scope } : {}),
        ...(channel !== undefined ? { channel } : {}),
      });
      const text =
        outcome.status !== "ok"
          ? `list_sessions unavailable: ${outcome.status}${outcome.code !== undefined ? ` (${outcome.code})` : ""}`
          : (outcome.rows ?? []).length === 0
            ? "No other joined sessions on this hub."
            : ["Joined sessions on this hub:", ...formatXsSessionRows(outcome.rows ?? [])].join("\n");
      return { content: [{ type: "text", text }], details: outcome };
    },
  };
}
