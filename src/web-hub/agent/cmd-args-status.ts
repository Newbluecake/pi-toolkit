/**
 * `/webhub status`'s `/`-command argument-completion line (web-hub-slash-args plan §5, P4).
 * Pure formatting only — no I/O, no pi imports — mirrors `ui-status.ts`/`privacy-status.ts`'s
 * shape so `commands/webhub.ts` interleaves it with the other status lines the same way.
 *
 * One line, English compact tokens only (AGENTS.md UI-text rule — this is a status marker,
 * not prose): the agent-side mode (`webHub.commandComplete`, default "all") plus whether the
 * LIVE hub link actually advertised `cmd.args.v1`:
 *
 *  - `cmd-args: off` — the agent-side setting is off (the line still shows: off is never the
 *    default, so an operator reading status deserves the confirmation; the hub builds no route
 *    and the agent advertises no cap).
 *  - `cmd-args: all · hub-cap n/a` — mode on but no live link yet (hub down / still connecting;
 *    `formatStatus`'s main line already reports the connection state itself).
 *  - `cmd-args: all · hub-cap on` — live link and the hub advertised the cap: hints + dynamic
 *    completion fully functional.
 *  - `cmd-args: all · hub-cap off (old hub, or /webhub restart pending)` — live link WITHOUT the
 *    cap: either the hub predates `cmd.args.v1`, or `HubConfig.cmdArgs` is off on the running
 *    hub (the setting is non-live — a settings flip needs `/reload` + `/webhub restart` to
 *    reach the hub config). The agent cannot distinguish the two from hello_ack alone.
 */
import { CMD_ARGS_HUB_CAP } from "../protocol/version.js";

/** The resolved `webHub.commandComplete` value (`"off"` wiring builds no service at all). */
export type CmdArgsMode = "all" | "toolkit" | "off";

export interface FormatCmdArgsStatusOptions {
  readonly mode: CmdArgsMode;
  /** The live link's `hello_ack.caps` — `undefined` when there is no live link (the connection
   *  resets its caps on teardown, so "live" is decided by the caller, not by the array). */
  readonly hubCaps: readonly string[] | undefined;
}

export function formatCmdArgsStatusLines(o: FormatCmdArgsStatusOptions): string[] {
  if (o.mode === "off") return ["cmd-args: off"];
  if (o.hubCaps === undefined) return [`cmd-args: ${o.mode} · hub-cap n/a`];
  return o.hubCaps.includes(CMD_ARGS_HUB_CAP)
    ? [`cmd-args: ${o.mode} · hub-cap on`]
    : [`cmd-args: ${o.mode} · hub-cap off (old hub, or /webhub restart pending)`];
}

/** `commands/webhub.ts`'s notify level for {@link formatCmdArgsStatusLines}'s first line: only a
 *  LIVE link that failed to advertise the cap is a degraded state worth a warning (mode "off" is
 *  the operator's own choice; "n/a" just mirrors the connection state the main line reports). */
export function cmdArgsStatusLevel(line: string | undefined): "info" | "warning" {
  if (line === undefined) return "info";
  return line.includes("hub-cap off (") ? "warning" : "info";
}
