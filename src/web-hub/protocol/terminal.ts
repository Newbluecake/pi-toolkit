/** Machine policy plus fail-closed legacy namespace/command/result classifiers.
 * No v1 frame/HTTP/resource/offer/grant/receipt schema or executable decoder remains.
 * Reserved historical labels below recognize ONLY refusals, never negotiation/authority.
 */
import { Type, type Static, type TProperties } from "@sinclair/typebox";

export const TERMINAL_LIMITS = Object.freeze({
  maxPerSession: 2,
  maxPerPrincipal: 2,
  maxTotal: 8,
  inputIdleMs: 3_600_000,
  maxLifetimeMs: 28_800_000,
});
const closed = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
export const TerminalConfigSchema = closed({
  maxPerSession: Type.Integer({ minimum: 1, maximum: 4 }),
  maxPerPrincipal: Type.Integer({ minimum: 1, maximum: 8 }),
  maxTotal: Type.Integer({ minimum: 1, maximum: 32 }),
  inputIdleMs: Type.Integer({ minimum: 300_000, maximum: 86_400_000 }),
  maxLifetimeMs: Type.Integer({ minimum: 900_000, maximum: 86_400_000 }),
});
export type TerminalHubConfig = Static<typeof TerminalConfigSchema>;

export function isTerminalNamespace(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    typeof (raw as Record<string, unknown>).t === "string" &&
    (((raw as Record<string, unknown>).t as string).startsWith("term_") ||
      ((raw as Record<string, unknown>).t as string).startsWith("terminal_context_"))
  );
}
/** Only reserved structures; never scan user output/text for the word terminal. */
export function hasReservedTerminalResult(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r.t !== "cmd_result" && r.t !== "cmd_late") return false;
  let d: unknown = r.data;
  for (let depth = 0; depth < 8; depth++) {
    if (!d || typeof d !== "object") return false;
    const o = d as Record<string, unknown>;
    if (
      Object.hasOwn(o, "terminal") ||
      o.outcome === "handshake-required" ||
      Object.hasOwn(o, "terminalOutcome") ||
      o.op === "__terminal" ||
      o.op === "resolved_ack" ||
      o.op === "authority" ||
      (o.v === 1 &&
        ["prepare_protocol", "protocol_challenge", "protocol_ready", "bind", "inventory"].includes(String(o.op))) ||
      (o.v === 1 && ["negotiate", "resource_inventory"].includes(String(o.action))) ||
      isTerminalNamespace(o)
    )
      return true;
    if (o.op !== "query") return false;
    const result = o.result;
    d = result && typeof result === "object" ? (result as Record<string, unknown>).data : undefined;
  }
  return true; // excessive nested query envelopes are not a legacy result
}
export function isReservedTerminalCommand(cmd: unknown): boolean {
  if (!cmd || typeof cmd !== "object") return false;
  const c = cmd as Record<string, unknown>;
  const reservedText = (text: unknown): boolean => /^\/+webhub\s+__terminal/i.test(String(text ?? "").trim());
  if (c.op === "prompt") return reservedText(c.text);
  if (c.op !== "command") return false;
  // Normalize slash/ASCII casing/whitespace. A template cannot smuggle a reserved
  // slash prefix in args; ordinary text containing the word terminal is unchanged.
  const name = String(c.name ?? "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
  return (
    (name === "webhub" && /^__terminal/i.test(String(c.args ?? "").trim())) ||
    name === "__terminal" ||
    reservedText(c.args) ||
    reservedText(`/${name}`)
  );
}
