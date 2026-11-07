import { describe, expect, it, vi } from "vitest";
import { createIdleRecoveryStore } from "../../src/todo/idle-recovery-store.js";
import {
  createIdleRecoveryHost,
  RECOVERY_BUSY_SOURCES,
  recoveryGoalBusy,
  recoveryScheduleBusy,
  type RecoveryBusy,
  type RecoveryIdentity,
  type RecoverySdkSnapshot,
} from "../../src/todo/idle-recovery-host.js";
import type { TodoState } from "../../src/todo/state.js";

function fixture() {
  const entries: unknown[] = [];
  let fail = false;
  const store = createIdleRecoveryStore({
    sessionId: "s",
    owner: "root",
    getEntries: () => entries,
    appendCustomEntry: (customType, data) => {
      if (fail) throw Error("disk");
      entries.push({ type: "custom", customType, data });
    },
  });
  let identity: RecoveryIdentity | undefined = { sid: "s", owner: "root" };
  let sdk: RecoverySdkSnapshot | undefined = { mode: "tui", idle: true, pending: false };
  let todo: TodoState | undefined = {
    nextId: 2,
    tasks: [
      {
        id: 1,
        subject: "existing",
        description: "authorized",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  const busy = Object.fromEntries(RECOVERY_BUSY_SOURCES.map((key) => [key, () => "clear" as RecoveryBusy]));
  const accepted = new Set<string>(); // fixture stands for the existing Web command ledger
  const handover = vi.fn();
  let inputId = 0;
  const host = createIdleRecoveryHost({
    enabled: true,
    sid: "s",
    owner: "root",
    store,
    currentIdentity: () => identity,
    readSdk: () => sdk,
    readTodo: () => todo,
    busy,
    handover,
    takeAcceptedWebCommand: (id) => {
      if (accepted.has(id)) return "replay";
      accepted.add(id);
      return "fresh";
    },
    createInputId: () => `input${++inputId}`,
  });
  const arrival = () =>
    host.onTuiInput({ type: "input", source: "interactive" }, { sid: "s", owner: "root", mode: "tui" });
  return {
    host,
    store,
    entries,
    busy,
    handover,
    arrival,
    setIdentity: (v: typeof identity) => {
      identity = v;
    },
    setSdk: (v: typeof sdk) => {
      sdk = v;
    },
    setTodo: (v: typeof todo) => {
      todo = v;
    },
    fail: () => {
      fail = true;
    },
  };
}

describe("idle recovery host synchronous gates", () => {
  it("requires initialized full state and every explicit source", () => {
    const f = fixture();
    expect(f.host.readHostSnapshot().busy).toBe("clear");
    f.setTodo(undefined);
    expect(f.host.readHostSnapshot().busy).toBe("unknown");
  });
  it.each(
    RECOVERY_BUSY_SOURCES.flatMap((source) =>
      ["busy", "unknown", "missing", "throw"].map((state) => [source, state] as const),
    ),
  )("%s %s fails closed independently", (source, state) => {
    const f = fixture();
    if (state === "missing") delete f.busy[source];
    else
      f.busy[source] = () => {
        if (state === "throw") throw Error("probe");
        return state as RecoveryBusy;
      };
    const snapshot = f.host.readHostSnapshot();
    expect(snapshot.sources[source]).toBe(state === "busy" ? "busy" : "unknown");
    expect(snapshot.busy).not.toBe("clear");
  });
  it.each([undefined, { mode: "tui", idle: false, pending: false }, { mode: "tui", idle: true, pending: true }])(
    "SDK %j is not clear",
    (value) => {
      const f = fixture();
      f.setSdk(value);
      expect(f.host.readHostSnapshot().busy).not.toBe("clear");
    },
  );
  it("SDK unknown mode is fail-closed", () => {
    const f = fixture();
    f.setSdk({ mode: "unknown", idle: true, pending: false });
    expect(f.host.readHostSnapshot().sources.sdk).toBe("unknown");
  });
  it.each([undefined, { sid: "other", owner: "root" }, { sid: "s", owner: "old" }])(
    "identity %j cannot run/reset",
    (value) => {
      const f = fixture();
      f.setIdentity(value);
      expect(f.host.readHostSnapshot().busy).toBe("unknown");
      expect(f.arrival()).toBe(false);
      expect(f.entries).toHaveLength(0);
    },
  );
  it.each(["active", "paused"])("goal %s retains root", (state) => {
    expect(recoveryGoalBusy({ initialized: true, evaluating: false, state })).toBe("busy");
  });
  it("goal missing/unknown/evaluating vs confirmed absence", () => {
    expect(recoveryGoalBusy(undefined)).toBe("unknown");
    expect(recoveryGoalBusy({ initialized: false, evaluating: false, state: null })).toBe("unknown");
    expect(recoveryGoalBusy({ initialized: true, evaluating: false, state: "future-kind" })).toBe("unknown");
    expect(recoveryGoalBusy({ initialized: true, evaluating: true, state: null })).toBe("busy");
    expect(recoveryGoalBusy({ initialized: true, evaluating: false, state: null })).toBe("clear");
  });
  it("future schedule alone clear; due, pending, degraded or absent not clear", () => {
    const value = { initialized: true, degraded: false, pending: false, nextAt: 101 };
    expect(recoveryScheduleBusy(value, 100)).toBe("clear");
    expect(recoveryScheduleBusy(value, 101)).toBe("busy");
    expect(recoveryScheduleBusy({ ...value, pending: true }, 100)).toBe("busy");
    expect(recoveryScheduleBusy({ ...value, degraded: true }, 100)).toBe("unknown");
    expect(recoveryScheduleBusy(undefined, 100)).toBe("unknown");
    expect(recoveryScheduleBusy({ ...value, nextAt: null }, 100)).toBe("clear");
  });
});

describe("trusted arrival is host-only, not consumption or a task authorization", () => {
  it("two distinct unconsumed arrivals open two windows, same event is weakly deduplicated", () => {
    const f = fixture();
    const event = { type: "input", source: "interactive" };
    const ctx = { sid: "s", owner: "root", mode: "tui" };
    expect(f.host.onTuiInput(event, ctx)).toBe(true);
    const first = f.store.view().window;
    f.store.noteStop("aborted");
    expect(f.host.onTuiInput(event, ctx)).toBe(false);
    expect(f.store.view().stopped).toBe(true);
    expect(f.arrival()).toBe(true);
    expect(f.store.view().window?.epoch).toBe((first?.epoch ?? 0) + 1);
    expect(f.store.view().stopped).toBe(false);
    expect(f.handover).toHaveBeenCalledTimes(2);
  });
  it.each(["extension", "rpc", "custom", "notification", "machine", "TaskCreate", "TaskUpdate", undefined])(
    "%s is not interactive arrival",
    (source) => {
      const f = fixture();
      expect(f.host.onTuiInput({ type: "input", source, role: "user" }, { sid: "s", owner: "root", mode: "tui" })).toBe(
        false,
      );
      expect(f.entries).toEqual([]);
    },
  );
  it.each(["rpc", "json", "print", "unknown"])("public mode %s is not TUI", (mode) => {
    const f = fixture();
    expect(f.host.onTuiInput({ type: "input", source: "interactive" }, { sid: "s", owner: "root", mode })).toBe(false);
  });
  it("role/custom text alone cannot reset, nor can old owner/session", () => {
    const f = fixture();
    for (const event of [{ role: "user" }, { type: "custom", source: "interactive" }])
      expect(f.host.onTuiInput(event, { sid: "s", owner: "root", mode: "tui" })).toBe(false);
    expect(f.host.onTuiInput({ type: "input", source: "interactive" }, { sid: "s", owner: "old", mode: "tui" })).toBe(
      false,
    );
    expect(f.host.onWebArrival({ sid: "other", owner: "root", cmdId: "a" })).toBe(false);
  });
  it("Web accepted command ledger dedups fresh objects/release; no lifetime input cap", () => {
    const f = fixture();
    expect(f.host.onWebArrival({ sid: "s", owner: "root", cmdId: "a" })).toBe(true);
    f.store.noteStop("abort-admission");
    expect(f.host.onWebArrival({ sid: "s", owner: "root", cmdId: "a" })).toBe(false);
    expect(f.store.view().stopped).toBe(true);
    for (let i = 0; i < 300; i++) expect(f.arrival()).toBe(true);
    expect(f.store.view().window?.epoch).toBe(301);
  });
  it("persistent high-water, not a process-local reset, chooses next epoch", () => {
    const f = fixture();
    f.store.noteHumanProof({ sid: "s", owner: "root", epoch: 45, inputId: "old", provenance: "user-arrival" });
    expect(f.arrival()).toBe(true);
    expect(f.store.view().window?.epoch).toBe(46);
  });
  it("handover precedes append even when append fails, never regains old abort rights", () => {
    const f = fixture();
    f.fail();
    expect(f.arrival()).toBe(false);
    expect(f.handover).toHaveBeenCalledOnce();
    expect(f.store.view().latch).toBe("persist-uncertain");
    expect(f.arrival()).toBe(false);
  });
  it("dispose makes arrivals inert", () => {
    const f = fixture();
    f.host.dispose();
    expect(f.arrival()).toBe(false);
    expect(f.host.readHostSnapshot().busy).toBe("unknown");
    expect(f.entries).toHaveLength(0);
  });
});
