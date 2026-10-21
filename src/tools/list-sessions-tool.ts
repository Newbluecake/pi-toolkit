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

export const ListSessionsParams = Type.Object({
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
export type ListSessionsParams = Static<typeof ListSessionsParams>;

/** Row rendering: compact English tokens only (AGENTS.md UI-language split). */
export function formatXsSessionRows(rows: readonly XsSessionRowWire[]): string[] {
  return rows.map((r) => {
    const parts = [
      r.ref,
      ...(r.name !== undefined ? [`name=${JSON.stringify(r.name)}`] : []),
      `cwd=${r.cwdLabel}`,
      `kind=${r.kind}`,
      `receive=${r.receive}`,
      r.busy ? "busy" : "idle",
      `lastActive=${r.lastActiveAgoS}s ago`,
    ];
    return `- ${parts.join(" · ")}`;
  });
}

export interface ListSessionsToolDeps {
  sender: XsSender;
}

export function createListSessionsTool(deps: ListSessionsToolDeps): ToolDefinition<typeof ListSessionsParams> {
  return {
    name: "list_sessions",
    label: "list_sessions",
    description:
      "List other explicitly-joined main sessions on this machine's web hub (fabric cross-session). Each row carries a " +
      "short ref, optional name, cwd, receive policy and busy state. Address them with message_session using the ref.",
    parameters: ListSessionsParams,
    async execute(_toolCallId, params, signal) {
      const outcome: XsListOutcome = await deps.sender.list({
        ...(signal !== undefined ? { signal } : {}),
        ...(params.query !== undefined ? { query: params.query } : {}),
        ...(params.scope !== undefined ? { scope: params.scope } : {}),
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
