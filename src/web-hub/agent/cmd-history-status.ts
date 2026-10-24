/**
 * `/webhub status`'s command-history line (web-hub-cmd-history plan §4.9, A1).
 * Pure formatting only — no I/O, no pi imports — mirrors `cmd-args-status.ts`'s shape.
 *
 * One line, English compact tokens only (AGENTS.md UI-text rule): the agent-side switch
 * (`webHub.cmdHistory`, default on), whether the LIVE hub link advertised `cmd.history.v1`,
 * and the recorder's write counters (`appended`/`skipped`/`failed`):
 *
 *  - `cmd-history: off` — the agent-side switch is off (no recorder built, no feature token,
 *    nothing written; the line still shows so an operator flipping the setting gets a
 *    confirmation — same posture as `cmd-args: off`).
 *  - `cmd-history: on · hub-cap n/a · appended 0 · skipped 0 · failed 0` — recorder wired but
 *    no live hub link yet (`formatStatus`'s main line already reports the connection state).
 *  - `cmd-history: on · hub-cap on · …` — live link with the cap: full pipeline.
 *  - `cmd-history: on · hub-cap off (old hub, or /webhub restart pending) · …` — live link
 *    WITHOUT the cap (H1 wires the hub side; the setting is non-live, so a flip needs
 *    `/reload` + `/webhub restart` to reach the hub).
 *
 * The counters are the recorder's lifetime totals for THIS activation — `skipped` growing while
 * a secure session is LOCKED is the expected signal (§5.4), `failed` means appendEntry threw.
 */
import { CMD_HISTORY_HUB_CAP } from "../protocol/version.js";

export interface FormatCmdHistoryStatusOptions {
  /** The resolved `webHub.cmdHistory` value. */
  readonly enabled: boolean;
  /** The live link's `hello_ack.caps` — `undefined` when there is no live link. */
  readonly hubCaps: readonly string[] | undefined;
  /** The recorder's lifetime write counters. */
  readonly counters: { appended: number; skipped: number; failed: number };
}

export function formatCmdHistoryStatusLines(o: FormatCmdHistoryStatusOptions): string[] {
  if (!o.enabled) return ["cmd-history: off"];
  const cap =
    o.hubCaps === undefined
      ? "hub-cap n/a"
      : o.hubCaps.includes(CMD_HISTORY_HUB_CAP)
        ? "hub-cap on"
        : "hub-cap off (old hub, or /webhub restart pending)";
  const { appended, skipped, failed } = o.counters;
  return [`cmd-history: on · ${cap} · appended ${appended} · skipped ${skipped} · failed ${failed}`];
}

/** `commands/webhub.ts`'s notify level for the line: only a LIVE link lacking the cap warns
 *  (off is the operator's choice; n/a mirrors the connection state the main line reports). */
export function cmdHistoryStatusLevel(line: string | undefined): "info" | "warning" {
  if (line === undefined) return "info";
  return line.includes("hub-cap off (") ? "warning" : "info";
}
