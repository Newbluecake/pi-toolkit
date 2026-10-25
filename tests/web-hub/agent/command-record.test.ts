/**
 * web-hub-cmd-history plan §4.3/§4.4/§5.2 (A1) — the command recorder core.
 * All deps injected (pi-free): appendEntry/sessionId/now/setTimer/recheckForWrite/onChange.
 * Fake timers drive the lazy start (400 ms), RECORD_MAX_MS (30 min) and intent TTL (10 min).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CMD_RECORD_ENTRY_TYPE, type CmdRecordData } from "../../../src/web-hub/protocol/cmd-record.js";
import {
  createCommandRecorder,
  INTENT_MAX,
  INTENT_TTL_MS,
  RECORD_MAX_MS,
  RUNNING_MAX,
  START_DELAY_MS,
  type CommandRecorder,
  type CommandRecorderDeps,
} from "../../../src/web-hub/agent/command-record.js";

interface Timer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

/** Deterministic harness: setTimer receives RELATIVE ms like the real dep. */
function makeHarness(over: Partial<CommandRecorderDeps> = {}) {
  let now = 1_000_000;
  const appended: Array<{ customType: string; data: unknown }> = [];
  const timers: Timer[] = [];
  let nextId = 1;
  const deps: CommandRecorderDeps = {
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
    sessionId: () => "sess-1",
    now: () => now,
    setTimer: (ms, fn) => {
      const t: Timer = { id: nextId++, ms: now + ms, fn, cancelled: false };
      timers.push(t);
      return { cancel: () => (t.cancelled = true) };
    },
    onChange: () => {},
    ...over,
  };
  const fire = (ms: number): void => {
    const target = now + ms;
    // loop because a fired timer may schedule nothing new here, but keep semantics simple
    for (;;) {
      now = target;
      const due = timers.filter((t) => !t.cancelled && t.ms <= target);
      if (due.length === 0) break;
      for (const t of due) t.cancelled = true;
      for (const t of due) t.fn();
      break;
    }
  };
  return {
    deps,
    appended,
    timers,
    fire,
    get now() {
      return now;
    },
  };
}

const ctx = { mode: "tui" } as unknown as ExtensionCommandContext;

function begins(r: CommandRecorder, name = "record", args = "", c: ExtensionCommandContext = ctx) {
  return r.begin({ name, args, ctx: c });
}

function endDatas(appended: Array<{ customType: string; data: unknown }>): CmdRecordData[] {
  return appended.filter((a) => a.customType === CMD_RECORD_ENTRY_TYPE).map((a) => a.data as CmdRecordData);
}

describe("createCommandRecorder — lazy start & phases", () => {
  it("a handler settling within START_DELAY_MS writes exactly ONE end (no start)", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "record", "status");
    expect(rec).toBeDefined();
    rec!.settle({});
    const datas = endDatas(h.appended);
    expect(datas).toHaveLength(1);
    expect(datas[0]!.phase).toBe("end");
    expect(datas[0]!.name).toBe("record");
    expect(datas[0]!.state).toBe("done");
    expect(datas[0]!.startedAt).toBe(h.now);
  });

  it("a handler still running after START_DELAY_MS gets a start entry, then an end", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "mem", "doctor");
    h.fire(START_DELAY_MS);
    let datas = endDatas(h.appended);
    expect(datas).toHaveLength(1);
    expect(datas[0]!.phase).toBe("start");
    rec!.sink({ kind: "notify", level: "info", text: "working" });
    rec!.settle({});
    datas = endDatas(h.appended);
    expect(datas).toHaveLength(2);
    expect(datas[1]!.phase).toBe("end");
    expect(datas[1]!.output?.entries[0]).toMatchObject({ kind: "notify", text: "working" });
  });

  it("settle maps a thrown handler to state failed + error text", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "boom");
    rec!.sink({ kind: "error", text: "kaboom" });
    rec!.settle({ error: new Error("kaboom") });
    const datas = endDatas(h.appended);
    expect(datas).toHaveLength(1);
    expect(datas[0]!.state).toBe("failed");
    expect(datas[0]!.error).toBe("kaboom");
  });

  it("settle takes an explicit failed string too, and only applies once", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "x");
    rec!.settle({ failed: "refused" });
    rec!.settle({}); // no-op
    const datas = endDatas(h.appended);
    expect(datas).toHaveLength(1);
    expect(datas[0]!.state).toBe("failed");
    expect(datas[0]!.error).toBe("refused");
  });

  it("RECORD_MAX_MS writes end{timeout} with collected output; later sinks are dropped", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "hang");
    h.fire(START_DELAY_MS);
    rec!.sink({ kind: "notify", level: "info", text: "partial" });
    h.fire(RECORD_MAX_MS - START_DELAY_MS);
    const datas = endDatas(h.appended);
    expect(datas).toHaveLength(2);
    expect(datas[1]!.phase).toBe("end");
    expect(datas[1]!.state).toBe("timeout");
    expect(datas[1]!.output?.entries[0]!.text).toBe("partial");
    h.fire(1_000);
    rec!.sink({ kind: "notify", level: "info", text: "after-timeout" });
    rec!.settle({});
    expect(endDatas(h.appended)).toHaveLength(2);
  });

  it("a normal finish with zero output gets notice no-output; header-only gets sensitive with NO output", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    begins(r, "quiet")!.settle({});
    r.begin({ name: "webhub", args: "open", ctx })!.settle({});
    const datas = endDatas(h.appended);
    expect(datas[0]!.notice).toBe("no-output");
    expect(datas[1]!.notice).toBe("sensitive");
    expect(datas[1]!.output).toBeUndefined();
    expect(datas[1]!.state).toBe("done");
  });

  it("beginExternal(lazyStart:true) writes a start at 400ms; (lazyStart:false) never writes a start", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const model = r.beginExternal({
      cmdId: "w-0000000000000001",
      name: "model",
      args: "a/b",
      source: "web",
      lazyStart: true,
    });
    expect(model).toBeDefined();
    h.fire(START_DELAY_MS);
    expect(endDatas(h.appended).some((d) => d.phase === "start")).toBe(true);
    model!.settle({});
    const compact = r.beginExternal({
      cmdId: "w-0000000000000002",
      name: "compact",
      args: "",
      source: "web",
      lazyStart: false,
    });
    h.fire(START_DELAY_MS);
    compact!.settle({});
    const datas = endDatas(h.appended);
    // compact: exactly one entry — an end, never a start
    const compacts = datas.filter((d) => d.name === "compact");
    expect(compacts).toHaveLength(1);
    expect(compacts[0]!.phase).toBe("end");
  });

  it("recordImmediate writes a single self-contained end with the given fields", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    r.recordImmediate({
      cmdId: "w-0000000000000003",
      name: "session",
      args: "",
      source: "web",
      startedAt: h.now - 5,
      state: "done",
      output: { entries: [{ kind: "text", text: "session: x" }] },
    });
    const datas = endDatas(h.appended);
    expect(datas).toHaveLength(1);
    expect(datas[0]).toMatchObject({
      phase: "end",
      cmdId: "w-0000000000000003",
      name: "session",
      source: "web",
      startedAt: h.now - 5,
      endedAt: h.now,
      state: "done",
    });
  });
});

describe("createCommandRecorder — write guards & counters (§4.3)", () => {
  it("recheckForWrite returning a reason ⇒ appendEntry NOT called, skipped++", () => {
    const h = makeHarness({ recheckForWrite: () => "会话已锁定" });
    const r = createCommandRecorder(h.deps);
    begins(r, "record", "status")!.settle({});
    expect(h.appended).toHaveLength(0);
    expect(r.counters()).toEqual({ appended: 0, skipped: 1, failed: 0 });
  });

  it("a throwing recheckForWrite is treated as writable (fail-open, recorder must never throw)", () => {
    const h = makeHarness({
      recheckForWrite: () => {
        throw new Error("boom");
      },
    });
    const r = createCommandRecorder(h.deps);
    begins(r, "record")!.settle({});
    expect(endDatas(h.appended)).toHaveLength(1);
    expect(r.counters().appended).toBe(1);
  });

  it("session change between begin and settle ⇒ skip (counted), no appendEntry", () => {
    let sid = "sess-1";
    const h = makeHarness({ sessionId: () => sid });
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "clear");
    h.fire(START_DELAY_MS);
    sid = "sess-2";
    rec!.settle({});
    // the start (written while sess-1 was live) landed; the end is skipped
    const datas = endDatas(h.appended);
    expect(datas).toHaveLength(1);
    expect(datas[0]!.phase).toBe("start");
    expect(r.counters().skipped).toBe(1);
  });

  it("sessionId() undefined ⇒ skip", () => {
    let sid: string | undefined = "sess-1";
    const h = makeHarness({ sessionId: () => sid });
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "x");
    sid = undefined;
    rec!.settle({});
    expect(endDatas(h.appended)).toHaveLength(0);
  });

  it("appendEntry throwing ⇒ swallowed, failed++", () => {
    const h = makeHarness();
    const appendEntry = vi.fn(() => {
      throw new Error("EIO");
    });
    const r = createCommandRecorder({ ...h.deps, appendEntry });
    begins(r, "x")!.settle({});
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(r.counters()).toEqual({ appended: 0, skipped: 0, failed: 1 });
  });

  it("dispose cancels pending timers; nothing more is written", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "x");
    r.dispose();
    h.fire(RECORD_MAX_MS + 10_000);
    rec!.settle({});
    expect(endDatas(h.appended)).toHaveLength(0);
    expect(h.timers.every((t) => t.cancelled)).toBe(true);
  });
});

describe("createCommandRecorder — policyFor (§5.2 freeze F5)", () => {
  const r = createCommandRecorder(makeHarness().deps);
  it("skip: internal trampolines", () => {
    expect(r.policyFor("webhub", "__exec new abc", "extension", true)).toBe("skip");
    expect(r.policyFor("topic-switch", "__go xyz", "extension", true)).toBe("skip");
    expect(r.policyFor("agent", "reload fire", "extension", true)).toBe("skip");
    expect(r.policyFor("resume", "__list {…}", "builtin", true)).toBe("skip");
    expect(r.policyFor("anything", "  __proto-x", "extension", true)).toBe("skip");
  });
  it("header-only: /webhub sensitive + unknown subcommands (fail-closed)", () => {
    for (const sub of ["open", "token", "2fa", "passwd", "user", "unlock", "feishu", "lan", "nonsense-sub"])
      expect(r.policyFor("webhub", sub, "extension", true)).toBe("header-only");
  });
  it("record: whitelisted /webhub subcommands and everything else", () => {
    expect(r.policyFor("webhub", "", "extension", true)).toBe("record");
    expect(r.policyFor("webhub", "status", "extension", true)).toBe("record");
    expect(r.policyFor("webhub", "restart", "extension", true)).toBe("record");
    expect(r.policyFor("webhub", "stop", "extension", true)).toBe("record");
    expect(r.policyFor("webhub", "start", "extension", true)).toBe("record");
    expect(r.policyFor("record", "status", "extension", true)).toBe("record");
    expect(r.policyFor("agent", "status", "extension", true)).toBe("record");
  });
  it("skip: whole reload family (#42)", () => {
    for (const a of ["reload", "reload now", "reload cancel", "reload fire", "  reload  "])
      expect(r.policyFor("agent", a, "extension", true)).toBe("skip");
    expect(r.policyFor("reload", "", "builtin", true)).toBe("skip");
    expect(r.policyFor("reload", "", "extension", true)).toBe("skip");
  });
  it("reload family begin() yields no handle and writes nothing (#42)", () => {
    const h = makeHarness();
    const rr = createCommandRecorder(h.deps);
    for (const a of ["reload", "reload now", "reload cancel"])
      expect(rr.begin({ name: "agent", args: a, ctx })).toBeUndefined();
    expect(h.appended).toHaveLength(0);
  });
  it("commitBeforeLeave('reload') on a recorded command writes no leave line (#42)", () => {
    const h = makeHarness();
    const rr = createCommandRecorder(h.deps);
    const rec = rr.begin({ name: "other", args: "", ctx });
    rec!.commitBeforeLeave("reload");
    const ends = endDatas(h.appended).filter((d) => d.phase === "end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.notice).toBeUndefined();
    expect(JSON.stringify(ends[0])).not.toContain("重载");
  });
  it("template/skill never recorded", () => {
    expect(r.policyFor("anything", "", "template", true)).toBe("skip");
    expect(r.policyFor("anything", "", "skill", true)).toBe("skip");
  });
  it("begin on a skip-policy command returns undefined but still consumes the matching intent", () => {
    const h = makeHarness();
    const rec2 = createCommandRecorder(h.deps);
    rec2.noteIntent({
      cmdId: "w-000000000000000a",
      source: "web",
      sessionId: "sess-1",
      at: h.now,
      match: { name: "agent", args: "reload fire" },
    });
    expect(rec2.begin({ name: "agent", args: "reload fire", ctx })).toBeUndefined();
    // the consumed intent no longer matches a later same-shape command
    const local = rec2.begin({ name: "agent", args: "reload fire", ctx });
    expect(local).toBeUndefined(); // still skip-policy, but via LOCAL resolution now
    // prove consumption: a TUI invocation of a record-policy command must NOT claim the stale intent
    const other = createCommandRecorder(h.deps);
    other.noteIntent({
      cmdId: "w-000000000000000b",
      source: "web",
      sessionId: "sess-1",
      at: h.now,
      match: { name: "agent", args: "reload fire" },
    });
    expect(other.begin({ name: "agent", args: "reload fire", ctx })).toBeUndefined();
  });
});

describe("createCommandRecorder — intent ledger (D7 / G7)", () => {
  it("a deferred web invocation (no claim) recovers cmdId+source from the intent ledger", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    r.noteIntent({
      cmdId: "w-000000000000000c",
      source: "web",
      sessionId: "sess-1",
      at: h.now,
      match: { name: "record", args: "status" },
    });
    h.fire(7_000); // beyond the capture engine's 5 s fallback TTL — claim path long gone
    const rec = begins(r, "record", "status");
    expect(rec).toBeDefined();
    rec!.sink({ kind: "notify", level: "info", text: "?token=abc" });
    rec!.settle({});
    const datas = endDatas(h.appended);
    expect(datas[0]!.cmdId).toBe("w-000000000000000c");
    expect(datas[0]!.source).toBe("web");
    expect(datas[0]!.output?.entries[0]!.text).toBe("?token=abc"); // Q1 verbatim
  });

  it("oldest-first when several same-shape intents are pending", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    r.noteIntent({
      cmdId: "w-000000000000000d",
      source: "web",
      sessionId: "sess-1",
      at: h.now,
      match: { name: "record", args: "" },
    });
    h.fire(1);
    r.noteIntent({
      cmdId: "w-000000000000000e",
      source: "web",
      sessionId: "sess-1",
      at: h.now,
      match: { name: "record", args: "" },
    });
    const rec = begins(r, "record", "");
    expect(rec!.cmdId).toBe("w-000000000000000d");
    expect(begins(r, "record", "")!.cmdId).toBe("w-000000000000000e");
  });

  it("intents only match within the SAME session; a session change clears foreign intents", () => {
    let sid = "sess-1";
    const h = makeHarness({ sessionId: () => sid });
    const r = createCommandRecorder(h.deps);
    r.noteIntent({
      cmdId: "w-000000000000000f",
      source: "web",
      sessionId: "sess-1",
      at: h.now,
      match: { name: "record", args: "" },
    });
    sid = "sess-2";
    const rec = begins(r, "record", "");
    expect(rec!.cmdId).not.toBe("w-000000000000000f"); // local id — cross-session mismatch
    expect(rec!.cmdId.startsWith("c")).toBe(true);
    expect(rec!.cmdId.length).toBe(21);
    rec!.settle({});
    expect(r.running()).toEqual([]);
  });

  it("the claim path removes the same-cmdId intent (no double-claim later)", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    r.noteIntent({
      cmdId: "w-0000000000000010",
      source: "web",
      sessionId: "sess-1",
      at: h.now,
      match: { name: "record", args: "" },
    });
    const rec = r.begin({ name: "record", args: "", ctx, claimed: { cmdId: "w-0000000000000010", source: "web" } });
    expect(rec!.cmdId).toBe("w-0000000000000010");
    // a subsequent unclaimed invocation must NOT re-claim the consumed intent
    expect(begins(r, "record", "")!.cmdId.startsWith("c")).toBe(true);
  });

  it("display overrides the card name/args (display mechanism)", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    r.noteIntent({
      cmdId: "w-0000000000000011",
      source: "web",
      sessionId: "sess-1",
      at: h.now,
      match: { name: "record", args: "status" },
      display: { name: "reload", args: "" },
    });
    const rec = begins(r, "record", "status");
    rec!.settle({});
    const datas = endDatas(h.appended);
    expect(datas[0]!.name).toBe("reload");
    expect(datas[0]!.args).toBe("");
  });

  it("expired intents (INTENT_TTL_MS) fall back to a local id", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    r.noteIntent({
      cmdId: "w-0000000000000012",
      source: "web",
      sessionId: "sess-1",
      at: h.now,
      match: { name: "record", args: "" },
    });
    h.fire(INTENT_TTL_MS + 1);
    expect(begins(r, "record", "")!.cmdId.startsWith("c")).toBe(true);
  });

  it("intent ledger capacity is FIFO-capped at INTENT_MAX", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    for (let i = 0; i < INTENT_MAX + 4; i++) {
      r.noteIntent({
        cmdId: `w-${String(i).padStart(16, "0")}`,
        source: "web",
        sessionId: "sess-1",
        at: h.now + i,
        match: { name: "record", args: `a${i}` },
      });
    }
    // the oldest intents were evicted — a0 no longer matches
    expect(begins(r, "record", "a0")!.cmdId.startsWith("c")).toBe(true);
    expect(begins(r, "record", `a${INTENT_MAX + 3}`)!.cmdId).toBe(`w-${String(INTENT_MAX + 3).padStart(16, "0")}`);
  });
});

describe("createCommandRecorder — running list & budget", () => {
  it("running() lists open cmdIds newest-first, capped at RUNNING_MAX", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const ids: string[] = [];
    for (let i = 0; i < RUNNING_MAX + 3; i++) {
      const rec = r.beginExternal({
        cmdId: `w-${String(i).padStart(16, "0")}`,
        name: "model",
        args: "",
        source: "web",
        lazyStart: false,
      });
      ids.push(rec!.cmdId);
    }
    const running = r.running();
    expect(running).toHaveLength(RUNNING_MAX);
    expect(running[0]).toBe(ids[ids.length - 1]); // newest first
    // settling removes from the list
    const settled = r.begin({ name: "record2", args: "", ctx })!;
    expect(r.running().includes(settled.cmdId)).toBe(true);
    settled.settle({});
    expect(r.running().includes(settled.cmdId)).toBe(false);
    expect(r.running().includes(ids[ids.length - 1])).toBe(true);
  });

  it("sink applies the output budgets: entry clamp 8 KiB, ≤64 entries, 32 KiB total (truncated tally)", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "big");
    const chunk = "x".repeat(7 * 1024); // 7 KiB each
    for (let i = 0; i < 6; i++) rec!.sink({ kind: "notify", level: "info", text: chunk });
    rec!.settle({});
    const datas = endDatas(h.appended);
    const out = datas[0]!.output!;
    expect(out.entries.length).toBeLessThanOrEqual(64);
    expect(out.entries.length).toBe(4); // 4 × 7 KiB = 28 KiB; the 5th would pass 32 KiB
    expect(out.truncated).toMatchObject({ droppedEntries: 2 });
  });

  it("sink sanitizes ANSI/control characters (write side) and keeps args/error caps", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = r.begin({ name: "x", args: "a".repeat(600), ctx });
    rec!.sink({ kind: "notify", level: "info", text: "\x1b[31mred\x1b[0m\x07" });
    rec!.settle({ failed: "e".repeat(600) });
    const datas = endDatas(h.appended);
    expect(datas[0]!.args.length).toBeLessThanOrEqual(512);
    expect(datas[0]!.args.endsWith("…")).toBe(true);
    expect(datas[0]!.error!.length).toBeLessThanOrEqual(512);
    expect(datas[0]!.output!.entries[0]!.text).toBe("red"); // ANSI + BEL stripped
  });
});

describe("createCommandRecorder — commitBeforeLeave / afterLeaveCancelled (§4.4)", () => {
  it("commitBeforeLeave writes end{done,left-session} with the leave line and closes the record", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "resume-recent", "");
    h.fire(START_DELAY_MS);
    rec!.sink({ kind: "notify", level: "info", text: "picking" });
    rec!.commitBeforeLeave("switch");
    const datas = endDatas(h.appended);
    expect(datas).toHaveLength(2);
    expect(datas[1]!.phase).toBe("end");
    expect(datas[1]!.state).toBe("done");
    expect(datas[1]!.notice).toBe("left-session");
    const texts = datas[1]!.output!.entries.map((e) => e.text);
    expect(texts).toContain("picking");
    expect(texts.some((t) => t.includes("已离开本会话"))).toBe(true);
    // settle after a successful leave is a no-op
    rec!.settle({});
    expect(endDatas(h.appended)).toHaveLength(2);
  });

  it("afterLeaveCancelled appends a SECOND end{failed} under the same cmdId (last end wins)", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "clear");
    rec!.commitBeforeLeave("new");
    rec!.afterLeaveCancelled("新建会话被取消");
    const datas = endDatas(h.appended);
    expect(datas).toHaveLength(2);
    expect(datas[1]!.state).toBe("failed");
    expect(datas[1]!.error).toBe("新建会话被取消");
    expect(datas[1]!.cmdId).toBe(datas[0]!.cmdId);
  });

  it("header-only records never persist output — even on leave", () => {
    const h = makeHarness();
    const r = createCommandRecorder(h.deps);
    const rec = r.begin({ name: "webhub", args: "token rotate", ctx });
    rec!.sink({ kind: "notify", level: "info", text: "secret-token" });
    rec!.commitBeforeLeave("reload");
    const datas = endDatas(h.appended).filter((d) => d.phase === "end");
    expect(datas.every((d) => d.output === undefined)).toBe(true);
    expect(datas.some((d) => d.notice === "sensitive")).toBe(true);
  });
});

describe("createCommandRecorder — onChange signals", () => {
  it("onChange fires when a record opens and when it closes", () => {
    const onChange = vi.fn();
    const h = makeHarness({ onChange });
    const r = createCommandRecorder(h.deps);
    const rec = begins(r, "x");
    expect(onChange).toHaveBeenCalledTimes(1);
    rec!.settle({});
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
