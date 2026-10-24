import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CMD_NOTE_AUTO_DISMISS_MS,
  __resetCmdHistoryStores,
  useCmdHistory,
} from "../../../src/web-hub/ui/src/composables/useCmdHistory.js";
import { CMD_PLACEHOLDER_TIMEOUT_MS } from "../../../src/web-hub/ui/src/logic/cmdRecord.js";

/** U1 · composables/useCmdHistory.ts — the §4.7 placeholder/notes state machine (per-agentKey
 *  module store, 60 s degrade, record-arrival resolution, note auto/manual dismiss). */

const ID = "c0123456789abcdef012";

beforeEach(() => {
  vi.useFakeTimers();
  __resetCmdHistoryStores();
});
afterEach(() => {
  __resetCmdHistoryStores();
  vi.useRealTimers();
});

function begin(store = useCmdHistory("agent-a"), cmdId = ID, name = "record") {
  store.begin({ cmdId, name, args: "status", startedAt: 1_700_000_000_000 });
  return store;
}

describe("useCmdHistory — placeholders", () => {
  it("begin ⇒ running placeholder; resolveRecords drops it (real card arrived)", () => {
    const store = begin();
    expect(store.placeholders).toHaveLength(1);
    expect(store.placeholders[0]?.cmdId).toBe(ID);
    store.resolveRecords([ID]);
    expect(store.placeholders).toHaveLength(0);
  });

  it("one store per agentKey; isolation between agents", () => {
    const a = begin(useCmdHistory("agent-a"));
    const b = useCmdHistory("agent-b");
    expect(useCmdHistory("agent-a")).toBe(a);
    expect(b.placeholders).toHaveLength(0);
    a.resolveRecords([ID]);
    expect(b.placeholders).toHaveLength(0);
  });

  it("60 s without a record ⇒ placeholder swaps to the deferred note (manual dismiss)", () => {
    const store = begin();
    vi.advanceTimersByTime(CMD_PLACEHOLDER_TIMEOUT_MS - 1);
    expect(store.placeholders).toHaveLength(1);
    expect(store.notes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(store.placeholders).toHaveLength(0);
    expect(store.notes).toHaveLength(1);
    expect(store.notes[0]?.kind).toBe("deferred");
    expect(store.notes[0]?.cmdId).toBe(ID);
    // stays until dismissed…
    vi.advanceTimersByTime(60_000);
    expect(store.notes).toHaveLength(1);
    store.dismissNote(store.notes[0]!.id);
    expect(store.notes).toHaveLength(0);
  });

  it("a LATE real card after the degrade removes the deferred note (§4.7)", () => {
    const store = begin();
    vi.advanceTimersByTime(CMD_PLACEHOLDER_TIMEOUT_MS);
    expect(store.notes[0]?.kind).toBe("deferred");
    store.resolveRecords([ID]);
    expect(store.notes).toHaveLength(0);
  });

  it("finishWithoutCard (history none/missing): placeholder → 4 s auto-dismissing executed note", () => {
    const store = begin();
    store.finishWithoutCard(ID, "record");
    expect(store.placeholders).toHaveLength(0);
    expect(store.notes[0]?.kind).toBe("executed");
    vi.advanceTimersByTime(CMD_NOTE_AUTO_DISMISS_MS - 1);
    expect(store.notes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.notes).toHaveLength(0);
  });

  it("fail: placeholder → manual-dismiss error note; drop: silent (confirm flow)", () => {
    const store = begin();
    store.fail(ID, "record", "E_POLICY", "denied by policy");
    expect(store.placeholders).toHaveLength(0);
    expect(store.notes[0]?.kind).toBe("error");
    expect(store.notes[0]?.message).toBe("denied by policy");
    vi.advanceTimersByTime(CMD_NOTE_AUTO_DISMISS_MS * 10);
    expect(store.notes).toHaveLength(1); // errors never auto-dismiss
    const store2 = begin(useCmdHistory("agent-b"));
    store2.drop(ID);
    expect(store2.placeholders).toHaveLength(0);
    expect(store2.notes).toHaveLength(0);
  });

  it("resolving one cmdId never touches another command's placeholder", () => {
    const store = begin();
    store.begin({ cmdId: "c2222222222222222222", name: "mem", args: "doctor", startedAt: 1 });
    store.resolveRecords([ID]);
    expect(store.placeholders).toHaveLength(1);
    expect(store.placeholders[0]?.name).toBe("mem");
  });
});

describe("useCmdHistory — seenRunning", () => {
  it("stamps ids with now; re-stamp refreshes", () => {
    const store = useCmdHistory("agent-a");
    store.noteRunning([ID], 1000);
    expect(store.seenRunning.get(ID)).toBe(1000);
    store.noteRunning([ID], 2000);
    expect(store.seenRunning.get(ID)).toBe(2000);
  });

  it("bounded FIFO at 64 entries", () => {
    const store = useCmdHistory("agent-a");
    for (let i = 0; i < 70; i++) store.noteRunning([`c${String(i).padStart(19, "0")}`], i);
    expect(store.seenRunning.size).toBe(64);
    expect(store.seenRunning.has(`c${String(0).padStart(19, "0")}`)).toBe(false);
    expect(store.seenRunning.has(`c${String(69).padStart(19, "0")}`)).toBe(true);
  });
});
