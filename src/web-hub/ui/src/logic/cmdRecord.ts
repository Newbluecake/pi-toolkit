/**
 * web-hub 命令历史 U1 (docs/dev/web-hub-cmd-history/plan.md v2 §4.7) — the pure-function layer
 * of the command-history cards. Everything here is DOM-free and Vue-free so the whole card
 * pipeline is unit-testable without mounting anything:
 *
 * - `isCmdRecordWire` — light structural guard for the projected `WireEntry.cmd` field (the
 *   hub already ran `sanitizeCmdRecord`; this is the cheap admission check `entryItem` needs —
 *   deliberately NOT a re-budget, and a TYPE-ONLY import of `@protocol/cmd-record.js` so the
 *   browser bundle never pulls that module's `node:buffer`).
 * - `foldCmdRecords` — §4.2/D1: same-cmdId start+end entries fold into ONE card at the FIRST
 *   occurrence's position, rendered from the LAST end's data; surplus entries hide.
 * - `resolveCmdState` — §4.7's state matrix: end ⇒ its state; start-only ⇒ `running` while
 *   `StatusInfo.cmdRunning` carries the cmdId or this tab saw it running within
 *   `CMD_SEEN_GRACE_MS` (the end's append frame can lag the status frame), else `unrecorded`
 *   (crash / never written — D2: no end is ever synthesized agent-side).
 * - `cmdPlainText` / `cmdLineCount` — the copy body and the ≈6-line fold threshold.
 * - `cmdBodyBlocks` — output entries → render blocks (widget/status grouped by key, §4.7).
 * - `cmdRunningOf` / `cmdHistoryModeOn` — defensive readers for the two open status/caps
 *   fields (D4: `historyMode = hubCaps ∋ cmd.history.v1 ∧ status.features ∋ cmd.history.v1`;
 *   a MISSING `history` field on a reply means `none` — n1).
 */
import type { CmdRecordSource, CmdRecordState, CmdRecordWire } from "@protocol/cmd-record.js";
import type { CommandOutputEntry, CommandOutputWire } from "@protocol/messages.js";
import { CMD_HISTORY_HUB_CAP } from "@protocol/version.js";

/** messages.ts's `CMD_HISTORY_FEATURE_V1` — deliberately the SAME string as the hub cap (P0
 *  pins the equality in tests/web-hub/protocol/messages.test.ts). Read through the cap
 *  constant so the browser bundle never pulls messages.ts (typebox) at runtime. */
const CMD_HISTORY_FEATURE = CMD_HISTORY_HUB_CAP;
import type { Item } from "../types.js";

/** §4.7/D2: a start-only card stays "running" this long after the last time THIS tab saw the
 *  cmdId in `status.cmdRunning` (covers the append-vs-status frame race); then `unrecorded`. */
export const CMD_SEEN_GRACE_MS = 5_000;
/** §4.7 local placeholder: no record within this window ⇒ the placeholder degrades to the
 *  slim 「结果暂未记录」 note (a later real card still renders and removes the note). */
export const CMD_PLACEHOLDER_TIMEOUT_MS = 60_000;
/** §4.7: cards whose rendered body exceeds this many lines start collapsed (「展开全部」). */
export const CMD_FOLD_LINES = 6;

export type CmdCardState = "running" | "done" | "failed" | "timeout" | "unrecorded";

/** §4.7's frozen card view-model. */
export interface CmdCardView {
  readonly cmdId: string;
  readonly name: string;
  readonly args: string;
  readonly source: CmdRecordSource;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly state: CmdCardState;
  readonly output?: CommandOutputWire;
  readonly notice?: CmdRecordWire["notice"];
  readonly error?: string;
  /** Local placeholder (dispatched from THIS tab, record not yet arrived) — renders at the
   *  transcript tail, never folds, and is dropped the moment the real record shows up. */
  readonly local?: true;
  /** Hosting entry id (the fold's first occurrence) — scroll-anchor identity. */
  readonly anchorEntryId?: string;
}

/** Internal fold result row: the public view plus whether an END record backs it. */
export interface FoldedCmdCard {
  readonly view: CmdCardView;
  readonly hasEnd: boolean;
  /** Entry id of the LAST end record folded in ("" when start-only) — renderKey signature. */
  readonly lastEndEntryId: string;
}

const SOURCES: ReadonlySet<string> = new Set(["web", "feishu", "tui", "rpc", "other"]);
const STATES: ReadonlySet<string> = new Set(["done", "failed", "timeout"]);
const NOTICES: ReadonlySet<string> = new Set(["terminal-only", "sensitive", "no-output", "left-session"]);
const CMD_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Light admission guard for `WireEntry.cmd` (§4.7). NOT a re-budget — the hub's projection
 *  already enforced size; anything structurally fishy simply isn't a card (plain tombstone). */
export function isCmdRecordWire(x: unknown): x is CmdRecordWire {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  if (r.v !== 1) return false;
  if (typeof r.cmdId !== "string" || !CMD_ID_RE.test(r.cmdId)) return false;
  if (r.phase !== "start" && r.phase !== "end") return false;
  if (typeof r.name !== "string" || r.name === "") return false;
  if (typeof r.args !== "string") return false;
  if (typeof r.source !== "string" || !SOURCES.has(r.source)) return false;
  if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt)) return false;
  if (r.endedAt !== undefined && (typeof r.endedAt !== "number" || !Number.isFinite(r.endedAt))) return false;
  if (r.state !== undefined && (typeof r.state !== "string" || !STATES.has(r.state))) return false;
  if (r.notice !== undefined && (typeof r.notice !== "string" || !NOTICES.has(r.notice))) return false;
  if (r.error !== undefined && typeof r.error !== "string") return false;
  if (r.output !== undefined && (r.output === null || typeof r.output !== "object")) return false;
  return true;
}

/**
 * §4.2/D1 fold: group `kind:"cmd"` items by `cmdId`; the FIRST occurrence hosts the card,
 * every later entry of the group hides; the LAST end's data wins (a cancelled session-leave
 * appends a second `failed` end — §4.4). Start-less groups (start outside the loaded window,
 * lazy start never written) render standalone at their first end — rule 3 falls out of rule 1.
 */
export function foldCmdRecords(items: readonly Item[]): {
  byIndex: Map<number, FoldedCmdCard>;
  hidden: Set<number>;
} {
  interface Group {
    host: number;
    start: CmdRecordWire | undefined;
    end: CmdRecordWire | undefined;
    lastEndEntryId: string;
    hostEntryId: string | undefined;
  }
  const groups = new Map<string, Group>();
  const order: string[] = [];
  const entryIds: (string | undefined)[] = items.map((it) => it.entryId);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === undefined || it.kind !== "cmd") continue;
    const cmd = isCmdRecordWire(it.entry?.["cmd"]) ? (it.entry as { cmd: CmdRecordWire }).cmd : undefined;
    if (cmd === undefined) continue;
    let g = groups.get(cmd.cmdId);
    if (g === undefined) {
      g = { host: i, start: undefined, end: undefined, lastEndEntryId: "", hostEntryId: entryIds[i] };
      groups.set(cmd.cmdId, g);
      order.push(cmd.cmdId);
    }
    if (cmd.phase === "start") {
      if (g.start === undefined) g.start = cmd;
    } else {
      g.end = cmd; // LAST end wins (§4.2 rule 2)
      g.lastEndEntryId = entryIds[i] ?? "";
    }
  }
  const byIndex = new Map<number, FoldedCmdCard>();
  const hidden = new Set<number>();
  for (const cmdId of order) {
    const g = groups.get(cmdId);
    if (g === undefined) continue;
    const rec = g.end ?? g.start;
    if (rec === undefined) continue;
    const base: CmdCardView = {
      cmdId: rec.cmdId,
      name: rec.name,
      args: rec.args,
      source: rec.source,
      startedAt: rec.startedAt,
      // Provisional state for start-only cards — the caller re-resolves it against the live
      // context (`resolveCmdState`); ended cards are final already.
      state: "running",
      ...(g.hostEntryId !== undefined ? { anchorEntryId: g.hostEntryId } : {}),
    };
    const view: CmdCardView =
      g.end === undefined
        ? base
        : {
            ...base,
            state: g.end.state ?? "done",
            ...(g.end.endedAt !== undefined ? { endedAt: g.end.endedAt } : {}),
            ...(g.end.output !== undefined ? { output: g.end.output } : {}),
            ...(g.end.notice !== undefined ? { notice: g.end.notice } : {}),
            ...(g.end.error !== undefined ? { error: g.end.error } : {}),
          };
    byIndex.set(g.host, { view, hasEnd: g.end !== undefined, lastEndEntryId: g.lastEndEntryId });
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === undefined || it.kind !== "cmd") continue;
    const cmd = isCmdRecordWire(it.entry?.["cmd"]) ? (it.entry as { cmd: CmdRecordWire }).cmd : undefined;
    if (cmd === undefined) continue;
    if (groups.get(cmd.cmdId)?.host !== i) hidden.add(i);
  }
  return { byIndex, hidden };
}

/** §4.7 state matrix. `seenRunningAt` is THIS tab's last observation of the cmdId inside
 *  `status.cmdRunning` (epoch ms, browser clock). */
export function resolveCmdState(
  rec: { hasEnd: boolean; endState?: CmdRecordState | undefined; cmdId: string },
  live: { running: ReadonlySet<string>; seenRunningAt?: number | undefined; now: number },
): CmdCardState {
  if (rec.hasEnd) return rec.endState ?? "done";
  if (live.running.has(rec.cmdId)) return "running";
  if (
    live.seenRunningAt !== undefined &&
    Number.isFinite(live.seenRunningAt) &&
    live.now - live.seenRunningAt < CMD_SEEN_GRACE_MS
  )
    return "running";
  return "unrecorded";
}

// --- body blocks (render model) ----------------------------------------------

export type CmdBodyBlock =
  | {
      readonly kind: "notify";
      readonly level: "info" | "warning" | "error";
      readonly text: string;
      readonly clipped: boolean;
    }
  | {
      readonly kind: "group";
      readonly groupKind: "widget" | "status";
      readonly key: string;
      readonly text: string;
      readonly clipped: boolean;
    }
  | { readonly kind: "text"; readonly text: string; readonly clipped: boolean }
  | { readonly kind: "error"; readonly text: string; readonly clipped: boolean };

function levelOf(e: CommandOutputEntry): "info" | "warning" | "error" {
  return e.level === "warning" || e.level === "error" ? e.level : "info";
}

/** §4.7: notify rows keep their level; widget/status entries GROUP BY `key` (first-appearance
 *  order, texts joined with a blank line); text/error are plain blocks; `interactive` entries
 *  are NOT blocks (they collapse into the single interactive line — `cmdInteractiveSteps`). */
export function cmdBodyBlocks(output: CommandOutputWire | undefined): CmdBodyBlock[] {
  const out: CmdBodyBlock[] = [];
  if (output === undefined || !Array.isArray(output.entries)) return out;
  const groupIndex = new Map<string, number>(); // `${kind}\n${key}` → out index
  for (const e of output.entries) {
    if (e === null || typeof e !== "object") continue;
    const clipped = e.clipped === true;
    if (e.kind === "notify") {
      out.push({ kind: "notify", level: levelOf(e), text: e.text, clipped });
    } else if (e.kind === "widget" || e.kind === "status") {
      const key = typeof e.key === "string" ? e.key : "";
      const gk = `${e.kind}\n${key}`;
      const at = groupIndex.get(gk);
      if (at === undefined) {
        groupIndex.set(gk, out.length);
        out.push({ kind: "group", groupKind: e.kind, key, text: e.text, clipped });
      } else {
        const prev = out[at];
        if (prev !== undefined && prev.kind === "group") {
          out[at] = {
            ...prev,
            text: prev.text === "" ? e.text : `${prev.text}\n\n${e.text}`,
            clipped: prev.clipped || clipped,
          };
        }
      }
    } else if (e.kind === "error") {
      out.push({ kind: "error", text: e.text, clipped });
    } else if (e.kind === "text") {
      out.push({ kind: "text", text: e.text, clipped });
    }
  }
  return out;
}

/** The collapsed interactive steps (their titles / fallback text), in order. */
export function cmdInteractiveSteps(output: CommandOutputWire | undefined): string[] {
  if (output === undefined || !Array.isArray(output.entries)) return [];
  const out: string[] = [];
  for (const e of output.entries) {
    if (e?.kind !== "interactive") continue;
    out.push(typeof e.title === "string" && e.title !== "" ? e.title : e.text);
  }
  return out;
}

// --- copy text / line count -----------------------------------------------------

function blockText(b: CmdBodyBlock): string {
  return b.kind === "group" && b.key !== "" ? `${b.key}\n${b.text}` : b.text;
}

/** The copy body (「复制输出」): the command line itself, then the verbatim output blocks,
 *  then the failure reason. Interactive steps stay out (they carry no output — §4.4). */
export function cmdPlainText(v: CmdCardView): string {
  const lines: string[] = [`/${v.name}${v.args === "" ? "" : ` ${v.args}`}`];
  for (const b of cmdBodyBlocks(v.output)) lines.push(blockText(b));
  if (typeof v.error === "string" && v.error !== "") lines.push(v.error);
  return lines.join("\n");
}

function textLines(text: string): number {
  return text === "" ? 1 : text.split("\n").length;
}

/** Approximate rendered line count driving the ≈6-line fold (§4.7): body blocks by their
 *  newline count (a group header adds one), one line each for the interactive note, the
 *  notice banner, the truncation footer and the running/unrecorded placeholders. */
export function cmdLineCount(v: CmdCardView): number {
  if (v.state === "running" || v.state === "unrecorded") return 1;
  let n = 0;
  for (const b of cmdBodyBlocks(v.output)) n += textLines(blockText(b));
  if (cmdInteractiveSteps(v.output).length > 0) n += 1;
  if (typeof v.error === "string" && v.error !== "") n += textLines(v.error);
  if (v.notice !== undefined && v.notice !== "left-session") n += 1;
  if (v.output?.truncated !== undefined) n += 1;
  return Math.max(n, 1);
}

// --- status / caps readers (open fields, defensive) ------------------------------

/** `status.cmdRunning` off a transcript source's RAW status slot (`AgentState.status` is the
 *  unmodified `StatusInfo`; the drawer's run source simply has no `status` ⇒ `[]`). The
 *  parameter is typed loosely ON PURPOSE: `TranscriptSource` (contracts.ts, outside U1's file
 *  domain) does not name `status`, but every runtime source is the full `AgentState`. */
export function cmdRunningOf(source: unknown): readonly string[] {
  if (source === null || typeof source !== "object") return [];
  const status = (source as { status?: unknown }).status;
  if (status === null || typeof status !== "object") return [];
  const running = (status as { cmdRunning?: unknown }).cmdRunning;
  if (!Array.isArray(running)) return [];
  return running.filter((x): x is string => typeof x === "string");
}

/** §4.6/D4: historyMode gate — hub caps AND the agent's `status.features` must BOTH carry
 *  `cmd.history.v1`. False ⇒ the dock keeps the legacy CommandResult path byte-identical. */
export function cmdHistoryModeOn(hubCaps: unknown, status: unknown): boolean {
  if (!Array.isArray(hubCaps) || !hubCaps.includes(CMD_HISTORY_HUB_CAP)) return false;
  if (status === null || typeof status !== "object") return false;
  const features = (status as { features?: unknown }).features;
  return Array.isArray(features) && features.includes(CMD_HISTORY_FEATURE);
}
