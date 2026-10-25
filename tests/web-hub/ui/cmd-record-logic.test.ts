import { describe, expect, it } from "vitest";
import {
  CMD_FOLD_LINES,
  CMD_PLACEHOLDER_TIMEOUT_MS,
  CMD_SEEN_GRACE_MS,
  cmdBodyBlocks,
  cmdHistoryModeOn,
  cmdInteractiveSteps,
  cmdLineCount,
  cmdPlainText,
  cmdRunningOf,
  foldCmdRecords,
  isCmdRecordWire,
  resolveCmdState,
  type CmdCardView,
} from "../../../src/web-hub/ui/src/logic/cmdRecord.js";
import type { Item } from "../../../src/web-hub/ui/src/types.js";
import { cmdEndRecord, cmdItem, cmdRecord, notify } from "./fixtures/cmd-records.ts";

/** U1 · logic/cmdRecord.ts — the pure layer of plan v2 §4.7 (fold / state / copy / lines /
 *  guards / gates). Fixtures: `fixtures/cmd-records.js` (projected-wire factories). */

const START_ID = "c0123456789abcdef012"; // matches ^[A-Za-z0-9_-]{16,64}$

function startRec(cmdId = START_ID, over: Record<string, unknown> = {}): Record<string, unknown> {
  return cmdRecord({ cmdId, ...over });
}

function endRec(cmdId = START_ID, over: Record<string, unknown> = {}): Record<string, unknown> {
  return cmdEndRecord({ cmdId, ...over });
}

function asItem(id: string, cmd: Record<string, unknown>): Item {
  return cmdItem(id, cmd) as unknown as Item;
}

describe("isCmdRecordWire — light admission guard", () => {
  it("accepts a minimal start record", () => {
    expect(isCmdRecordWire(startRec())).toBe(true);
  });
  it("accepts a full end record", () => {
    expect(
      isCmdRecordWire(
        endRec(START_ID, { output: { entries: [notify("ok")] }, notice: "no-output", error: "x", state: "failed" }),
      ),
    ).toBe(true);
  });
  it("rejects non-objects / wrong v / bad cmdId / bad phase / bad enums / bad numbers", () => {
    expect(isCmdRecordWire(null)).toBe(false);
    expect(isCmdRecordWire("x")).toBe(false);
    expect(isCmdRecordWire([])).toBe(false);
    expect(isCmdRecordWire(startRec(START_ID, { v: 2 }))).toBe(false);
    expect(isCmdRecordWire(startRec("short"))).toBe(false);
    expect(isCmdRecordWire(startRec(START_ID, { phase: "mid" }))).toBe(false);
    expect(isCmdRecordWire(startRec(START_ID, { source: "carrier-pigeon" }))).toBe(false);
    expect(isCmdRecordWire(startRec(START_ID, { startedAt: Number.NaN }))).toBe(false);
    expect(isCmdRecordWire(endRec(START_ID, { state: "exploded" }))).toBe(false);
    expect(isCmdRecordWire(endRec(START_ID, { notice: "redacted" }))).toBe(false);
    expect(isCmdRecordWire(endRec(START_ID, { error: 42 }))).toBe(false);
    expect(isCmdRecordWire(endRec(START_ID, { output: "nope" }))).toBe(false);
  });
});

describe("foldCmdRecords — §4.2/D1", () => {
  it("start+end same cmdId: card at the START's position, rendered from the end, end hidden", () => {
    const items = [asItem("e1", startRec()), asItem("e2", endRec())];
    const { byIndex, hidden } = foldCmdRecords(items);
    expect(hidden.has(1)).toBe(true);
    const card = byIndex.get(0);
    expect(card?.hasEnd).toBe(true);
    expect(card?.view.state).toBe("done");
    expect(card?.view.endedAt).toBe(1_700_000_001_000);
    expect(card?.view.anchorEntryId).toBe("e1");
    expect(card?.lastEndEntryId).toBe("e2");
  });

  it("end-only (no start in window): renders standalone at the end's position (rule 3)", () => {
    const items = [asItem("e9", endRec())];
    const { byIndex, hidden } = foldCmdRecords(items);
    expect(hidden.size).toBe(0);
    const card = byIndex.get(0);
    expect(card?.hasEnd).toBe(true);
    expect(card?.view.anchorEntryId).toBe("e9");
  });

  it("start-only: provisional running, no hidden rows, no end fields", () => {
    const items = [asItem("e1", startRec())];
    const card = foldCmdRecords(items).byIndex.get(0);
    expect(card?.hasEnd).toBe(false);
    expect(card?.view.state).toBe("running");
    expect(card?.view.endedAt).toBeUndefined();
    expect(card?.view.output).toBeUndefined();
    expect(card?.lastEndEntryId).toBe("");
  });

  it("LAST end wins (cancelled session-leave appends a second failed end — §4.4)", () => {
    const items = [
      asItem("e1", startRec()),
      asItem("e2", endRec(START_ID, { state: "done", notice: "left-session" })),
      asItem("e3", endRec(START_ID, { state: "failed", error: "cancelled" })),
    ];
    const { byIndex, hidden } = foldCmdRecords(items);
    expect([...hidden].sort()).toEqual([1, 2]);
    const card = byIndex.get(0);
    expect(card?.view.state).toBe("failed");
    expect(card?.view.error).toBe("cancelled");
    expect(card?.view.notice).toBeUndefined(); // last end replaces, never merges
    expect(card?.lastEndEntryId).toBe("e3");
  });

  it("paging loads the start LATER: the card moves up to the start position (rule 4)", () => {
    // window before paging: only the end
    const before = foldCmdRecords([asItem("e5", endRec())]);
    expect(before.byIndex.has(0)).toBe(true);
    // after paging the start arrived at index 0
    const after = foldCmdRecords([asItem("e1", startRec()), asItem("e5", endRec())]);
    expect(after.byIndex.has(0)).toBe(true);
    expect(after.hidden.has(1)).toBe(true);
    expect(after.byIndex.get(0)?.view.anchorEntryId).toBe("e1");
  });

  it("two interleaved commands fold independently; non-cmd items are ignored", () => {
    const items = [
      asItem("a1", startRec("aaaaaaaaaaaaaaaa")),
      asItem("b1", startRec("bbbbbbbbbbbbbbbb")),
      asItem("a2", endRec("aaaaaaaaaaaaaaaa", { state: "failed", error: "boom" })),
      { id: "m1", kind: "message", entryId: "m1", message: { role: "user", content: "hi", timestamp: 1 } } as Item,
      asItem("b2", endRec("bbbbbbbbbbbbbbbb")),
    ];
    const { byIndex, hidden } = foldCmdRecords(items);
    expect(byIndex.get(0)?.view.state).toBe("failed");
    expect(byIndex.get(1)?.view.state).toBe("done");
    expect([...hidden].sort()).toEqual([2, 4]);
  });

  it("an item whose entry.cmd is invalid is left alone (not folded, not hidden)", () => {
    const bad = { id: "e1:0", kind: "cmd", entryId: "e1", entry: { cmd: { v: 2 } } } as unknown as Item;
    const { byIndex, hidden } = foldCmdRecords([bad]);
    expect(byIndex.size).toBe(0);
    expect(hidden.size).toBe(0);
  });
});

describe("resolveCmdState — §4.7 matrix", () => {
  const rec = { hasEnd: false, cmdId: START_ID };
  it("hasEnd ⇒ the end's state (done/failed/timeout)", () => {
    expect(resolveCmdState({ hasEnd: true, endState: "failed", cmdId: START_ID }, { running: new Set(), now: 0 })).toBe(
      "failed",
    );
    expect(
      resolveCmdState({ hasEnd: true, endState: "timeout", cmdId: START_ID }, { running: new Set(), now: 0 }),
    ).toBe("timeout");
    expect(resolveCmdState({ hasEnd: true, cmdId: START_ID }, { running: new Set(), now: 0 })).toBe("done");
  });
  it("start-only + cmdRunning ∋ cmdId ⇒ running", () => {
    expect(resolveCmdState(rec, { running: new Set([START_ID]), now: 10_000 })).toBe("running");
  });
  it("start-only + seen running within the grace ⇒ running (append frame lags status)", () => {
    expect(
      resolveCmdState(rec, { running: new Set(), seenRunningAt: 10_000, now: 10_000 + CMD_SEEN_GRACE_MS - 1 }),
    ).toBe("running");
  });
  it("start-only + grace expired (or never seen) ⇒ unrecorded", () => {
    expect(resolveCmdState(rec, { running: new Set(), seenRunningAt: 10_000, now: 10_000 + CMD_SEEN_GRACE_MS })).toBe(
      "unrecorded",
    );
    expect(resolveCmdState(rec, { running: new Set(), now: 0 })).toBe("unrecorded");
  });
});

describe("cmdBodyBlocks / cmdInteractiveSteps", () => {
  it("notify keeps level; text/error are plain blocks; widget/status group by kind+key", () => {
    const blocks = cmdBodyBlocks({
      entries: [
        notify("first"),
        notify("careful", "warning"),
        { kind: "widget", key: "w", text: "line1" },
        { kind: "widget", key: "w", text: "line2" },
        { kind: "status", key: "s", text: "st" },
        { kind: "text", text: "plain" },
        { kind: "error", text: "bad" },
        { kind: "interactive", title: "确认", text: "confirm" },
      ],
    });
    expect(blocks[0]).toEqual({ kind: "notify", level: "info", text: "first", clipped: false });
    expect(blocks[1]).toEqual({ kind: "notify", level: "warning", text: "careful", clipped: false });
    expect(blocks[2]).toEqual({ kind: "group", groupKind: "widget", key: "w", text: "line1\n\nline2", clipped: false });
    expect(blocks[3]).toEqual({ kind: "group", groupKind: "status", key: "s", text: "st", clipped: false });
    expect(blocks[4]).toEqual({ kind: "text", text: "plain", clipped: false });
    expect(blocks[5]).toEqual({ kind: "error", text: "bad", clipped: false });
    expect(blocks).toHaveLength(6);
  });

  it("clipped flags propagate; group clip ORs", () => {
    const blocks = cmdBodyBlocks({
      entries: [
        { kind: "widget", key: "w", text: "a", clipped: true as const },
        { kind: "widget", key: "w", text: "b" },
      ],
    });
    expect(blocks[0]?.clipped).toBe(true);
  });

  it("interactive steps list titles (fallback: text), and are NOT blocks", () => {
    const out = {
      entries: [
        { kind: "interactive" as const, title: "选一个", text: "select" },
        { kind: "interactive" as const, text: "confirm" },
      ],
    };
    expect(cmdInteractiveSteps(out)).toEqual(["选一个", "confirm"]);
    expect(cmdBodyBlocks(out)).toEqual([]);
  });

  it("unknown entries are dropped; missing output ⇒ empty", () => {
    expect(cmdBodyBlocks(undefined)).toEqual([]);
    expect(cmdBodyBlocks({ entries: [{ kind: "interactive", text: "x" }] })).toEqual([]);
  });
});

describe("cmdPlainText / cmdLineCount", () => {
  const view: CmdCardView = {
    cmdId: START_ID,
    name: "record",
    args: "status",
    source: "web",
    startedAt: 1,
    state: "done",
    output: {
      entries: [notify("line1\nline2"), { kind: "widget", key: "w", text: "body" }],
    },
  };

  it("copy text = command line + verbatim blocks + error", () => {
    const withErr: CmdCardView = { ...view, state: "failed", error: "kaboom" };
    expect(cmdPlainText(view)).toBe("/record status\nline1\nline2\nw\nbody");
    expect(cmdPlainText(withErr)).toBe("/record status\nline1\nline2\nw\nbody\nkaboom");
  });

  it("no args ⇒ bare /name header", () => {
    expect(cmdPlainText({ ...view, args: "" }).split("\n")[0]).toBe("/record");
  });

  it("line count drives the ≈6-line fold", () => {
    expect(cmdLineCount(view)).toBe(4); // 2 notify lines + group key line + group body
    const many: CmdCardView = {
      ...view,
      output: { entries: [notify("1\n2\n3\n4\n5\n6\n7")] },
    };
    expect(cmdLineCount(many)).toBe(7);
    expect(cmdLineCount(many) > CMD_FOLD_LINES).toBe(true);
  });

  it("running/unrecorded count as one line; notice/footer/error add lines", () => {
    expect(cmdLineCount({ ...view, state: "running", output: undefined })).toBe(1);
    expect(cmdLineCount({ ...view, state: "unrecorded", output: undefined })).toBe(1);
    expect(
      cmdLineCount({
        ...view,
        output: { entries: [], truncated: { droppedEntries: 2, droppedBytes: 9000 } },
        notice: "no-output",
      }),
    ).toBe(2);
  });
});

describe("cmdRunningOf / cmdHistoryModeOn — open-field readers", () => {
  it("cmdRunningOf reads status.cmdRunning defensively", () => {
    expect(cmdRunningOf({ status: { cmdRunning: ["a", "b"] } })).toEqual(["a", "b"]);
    expect(cmdRunningOf({ status: { cmdRunning: ["a", 1, null] } })).toEqual(["a"]);
    expect(cmdRunningOf({ status: {} })).toEqual([]);
    expect(cmdRunningOf({})).toEqual([]); // drawer run source has no status
    expect(cmdRunningOf(null)).toEqual([]);
  });

  it("cmdHistoryModeOn needs BOTH the hub cap and the agent feature (D4)", () => {
    expect(cmdHistoryModeOn(["cmd.history.v1"], { features: ["cmd.history.v1"] })).toBe(true);
    expect(cmdHistoryModeOn([], { features: ["cmd.history.v1"] })).toBe(false);
    expect(cmdHistoryModeOn(["cmd.history.v1"], {})).toBe(false);
    expect(cmdHistoryModeOn(["cmd.history.v1"], { features: ["resume.v1"] })).toBe(false);
    expect(cmdHistoryModeOn(undefined, undefined)).toBe(false);
    expect(cmdHistoryModeOn("cmd.history.v1", { features: "cmd.history.v1" })).toBe(false);
  });
});
