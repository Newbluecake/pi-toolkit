import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentFrame,
  HubFrame,
  SnapshotReplyBody,
  WireEntry,
  WireEvent,
  WireMessage,
} from "../../../src/web-hub/protocol/messages.js";
import type { HubEvent } from "../../../src/web-hub/hub/ports.js";
import { createHistoryService, mergeSnapshot, readBranchFromFile } from "../../../src/web-hub/hub/history.js";
import { createRegistry, type AgentConn, type Registry } from "../../../src/web-hub/hub/registry.js";
import { hello, memLog, recordBus, sleepReal, tmpDirs, waitFor } from "./helpers.js";

const tmp = tmpDirs();
afterEach(() => {
  vi.useRealTimers();
  tmp.cleanup();
});

// ---------------------------------------------------------------------------
// fixture: a session with an abandoned branch, an idle custom_message, a tool
// turn (turn_end.messageEntryId = a2 ≠ leaf t2) and an entry after the leaf.
// ---------------------------------------------------------------------------

const msg = (role: string, timestamp: number, extra: Record<string, unknown> = {}): WireMessage => ({
  role,
  timestamp,
  content: `${role}@${timestamp}`,
  ...extra,
});

const line = (o: object): string => `${JSON.stringify(o)}\n`;
const iso = (n: number): string => new Date(1_790_000_000_000 + n).toISOString();

const U1 = msg("user", 1000);
const A1 = msg("assistant", 1001);
const U2 = msg("user", 2000);
const A2 = msg("assistant", 2001, { content: [{ type: "toolCall", id: "call_1" }] });
const T2 = msg("toolResult", 2002, { toolCallId: "call_1", toolName: "read" });

function fixtureLines(): string {
  return [
    line({ type: "session", version: 3, id: "sess", timestamp: iso(0), cwd: "/tmp/w" }),
    line({ type: "model_change", id: "mc", parentId: null, timestamp: iso(1), provider: "p", modelId: "m" }),
    line({ type: "message", id: "u1", parentId: "mc", timestamp: iso(2), message: U1 }),
    line({ type: "message", id: "a1", parentId: "u1", timestamp: iso(3), message: A1 }),
    line({ type: "message", id: "x1", parentId: "a1", timestamp: iso(4), message: msg("user", 1500) }), // abandoned
    line({ type: "message", id: "x2", parentId: "x1", timestamp: iso(5), message: msg("assistant", 1501) }),
    line({ type: "label", id: "lb", parentId: "a1", timestamp: iso(6), label: "x" }), // not projected
    line({ type: "message", id: "u2", parentId: "lb", timestamp: iso(7), message: U2 }),
    line({
      type: "custom_message",
      id: "c1",
      parentId: "u2",
      timestamp: iso(8),
      customType: "probe:custom",
      content: "hello",
      display: true,
    }),
    line({ type: "custom", id: "d1", parentId: "c1", timestamp: iso(9), customType: "state", data: { v: 1 } }),
    line({ type: "message", id: "a2", parentId: "d1", timestamp: iso(10), message: A2 }),
    line({ type: "message", id: "t2", parentId: "a2", timestamp: iso(11), message: T2 }),
    line({ type: "message", id: "late", parentId: "t2", timestamp: iso(12), message: msg("assistant", 3000) }),
  ].join("");
}

function writeFixture(content = fixtureLines()): string {
  const file = join(tmp.make("wh-h-"), "session.jsonl");
  writeFileSync(file, content);
  return file;
}

const ids = (entries: readonly WireEntry[]): string[] => entries.map((e) => e.id);

describe("readBranchFromFile", () => {
  it("walks leaf → root along parentId; skips abandoned branches, header and labels", async () => {
    const r = await readBranchFromFile(writeFixture(), "t2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ids(r.entries)).toEqual(["mc", "u1", "a1", "u2", "c1", "d1", "a2", "t2"]);
    expect(r.entries.find((e) => e.id === "d1")).toMatchObject({ type: "custom", display: false });
    expect(r.entries.find((e) => e.id === "d1")).not.toHaveProperty("data");
  });

  it("entries after the leaf are never included", async () => {
    const r = await readBranchFromFile(writeFixture(), "a2");
    expect(r.ok && ids(r.entries).at(-1)).toBe("a2");
  });

  it.each([
    ["missing leaf", async () => readBranchFromFile(writeFixture(), "nope"), "LEAF_NOT_FOUND"],
    ["missing file", async () => readBranchFromFile(join(tmp.make(), "none.jsonl"), "t2"), "ENOENT"],
    [
      "non-.jsonl path",
      async () => {
        const f = join(tmp.make(), "s.json");
        writeFileSync(f, fixtureLines());
        return readBranchFromFile(f, "t2");
      },
      "ENOENT",
    ],
    [
      "symlink resolving to a non-.jsonl file",
      async () => {
        const d = tmp.make();
        writeFileSync(join(d, "secret.txt"), fixtureLines());
        symlinkSync(join(d, "secret.txt"), join(d, "s.jsonl"));
        return readBranchFromFile(join(d, "s.jsonl"), "t2");
      },
      "ENOENT",
    ],
    [
      "directory named *.jsonl",
      async () => {
        const d = join(tmp.make(), "dir.jsonl");
        mkdirSync(d);
        return readBranchFromFile(d, "t2");
      },
      "ENOENT",
    ],
    [
      "file over maxFileBytes",
      async () => readBranchFromFile(writeFixture(), "t2", { maxFileBytes: 100 }),
      "TOO_LARGE",
    ],
    [
      "corrupt middle line",
      async () => readBranchFromFile(writeFixture(`${fixtureLines()}{broken\n${line({ id: "z" })}`), "t2"),
      "PARSE",
    ],
  ])("%s ⇒ %s", async (_name, run, reason) => {
    expect(await run()).toEqual({ ok: false, reason });
  });

  it("a trailing partial line (writer mid-append) is tolerated", async () => {
    const r = await readBranchFromFile(writeFixture(`${fixtureLines()}{"type":"message","id":"half`), "t2");
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeSnapshot (pure)
// ---------------------------------------------------------------------------

function reply(over: Partial<SnapshotReplyBody> = {}): SnapshotReplyBody {
  return {
    seq: 10,
    leafId: "t2",
    recent: [],
    prompts: [],
    status: { leafId: "t2", busy: false, pending: false },
    fleet: [],
    ...over,
  };
}

async function branchAt(leaf: string, content?: string): Promise<WireEntry[]> {
  const r = await readBranchFromFile(writeFixture(content), leaf);
  if (!r.ok) throw new Error(r.reason);
  return r.entries;
}

const customMsg = (content: unknown): WireMessage => ({ role: "custom", customType: "probe:custom", content });

describe("mergeSnapshot", () => {
  it("K7: message_end forwarded but not yet persisted ⇒ tail-filled once; persisted ones not duplicated", async () => {
    const branch = await branchAt("t2");
    const unpersisted = msg("assistant", 2500);
    const m = mergeSnapshot(
      branch,
      reply({
        recent: [
          { seq: 5, message: A2 },
          { seq: 6, message: T2 },
          { seq: 7, message: unpersisted },
        ],
      }),
      [],
    );
    expect(ids(m.entries)).toEqual(ids(branch));
    expect(m.tailMessages).toEqual([unpersisted]);
    expect(m.fromSeq).toBe(11);
  });

  it("a persisted custom message in recent is deduplicated against its custom_message entry", async () => {
    const branch = await branchAt("t2");
    const m = mergeSnapshot(
      branch,
      reply({
        recent: [
          { seq: 3, message: customMsg("hello") },
          { seq: 4, message: A2 },
          { seq: 5, message: T2 },
        ],
      }),
      [],
    );
    expect(m.tailMessages).toEqual([]);
  });

  it("entries persisted without message_end (idle custom) do not push recent counterparts out of the window", async () => {
    let content = fixtureLines().split("\n").slice(0, 12).join("\n") + "\n"; // up to t2
    content += line({
      type: "custom_message",
      id: "i1",
      parentId: "t2",
      timestamp: iso(40),
      customType: "t",
      content: 1,
    });
    content += line({
      type: "custom_message",
      id: "i2",
      parentId: "i1",
      timestamp: iso(41),
      customType: "t",
      content: 2,
    });
    const branch = await branchAt("i2", content);
    const m = mergeSnapshot(
      branch,
      reply({
        leafId: "i2",
        recent: [
          { seq: 4, message: A2 },
          { seq: 5, message: T2 },
        ],
      }),
      [],
    );
    expect(m.tailMessages).toEqual([]);
  });

  it.each([
    [0, 2],
    [1, 1],
    [2, 0],
  ])("two identical custom messages with %i persisted ⇒ %i tail-filled", async (persisted, expected) => {
    let content = fixtureLines().split("\n").slice(0, 8).join("\n") + "\n"; // up to and incl. u2
    let parent = "u2";
    for (let i = 0; i < persisted; i++) {
      content += line({
        type: "custom_message",
        id: `k${i}`,
        parentId: parent,
        timestamp: iso(100 + i),
        customType: "probe:custom",
        content: "same",
      });
      parent = `k${i}`;
    }
    const branch = await branchAt(parent, content);
    const m = mergeSnapshot(
      branch,
      reply({
        leafId: parent,
        recent: [
          { seq: 1, message: customMsg("same") },
          { seq: 2, message: customMsg("same") },
        ],
      }),
      [],
    );
    expect(m.tailMessages).toHaveLength(expected);
  });

  it("buffered events: only seq > reply.seq survive, in order; inflight is attached", async () => {
    const branch = await branchAt("t2");
    const ev = (type: WireEvent["type"]): WireEvent => ({ type });
    const inflight = { tools: [{ toolCallId: "c9", toolName: "bash", args: {} }] };
    const m = mergeSnapshot(branch, reply({ seq: 10, inflight }), [
      { seq: 12, e: ev("turn_end") },
      { seq: 9, e: ev("message_end") },
      { seq: 10, e: ev("turn_start") },
      { seq: 11, e: ev("message_start") },
    ]);
    expect(m.buffered.map((b) => b.seq)).toEqual([11, 12]);
    expect(m.inflight).toEqual(inflight);
  });

  it("alignment: tool turn (turn_end.messageEntryId=a2 ≠ leaf t2) ⇒ result is aligned to the snapshot leafId only", async () => {
    const branch = await branchAt("t2"); // file also holds "late" after the leaf
    const m = mergeSnapshot(branch, reply({ leafId: "t2", seq: 10 }), [
      { seq: 9, e: { type: "turn_end", messageEntryId: "a2" } },
    ]);
    expect(ids(m.entries).at(-1)).toBe("t2");
    expect(ids(m.entries)).not.toContain("late");
    expect(m.tailMessages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// history service over a real registry with a scripted agent connection
// ---------------------------------------------------------------------------

interface Agent {
  reg: Registry;
  events: HubEvent[];
  agentKey: string;
  sent: HubFrame[];
  replyWith: (r: Partial<SnapshotReplyBody> | "silent") => void;
  branchWith: (entries: WireEntry[]) => void;
}

function agent(sessionFile: string | undefined, leafId: string | null = "t2"): Agent {
  const reg = createRegistry({ now: () => Date.now(), log: memLog(), pidAlive: () => true });
  const events = recordBus(reg);
  const sent: HubFrame[] = [];
  let snap: Partial<SnapshotReplyBody> | "silent" = {};
  let branch: WireEntry[] = [];
  let key = "";
  const conn: AgentConn = {
    send(f) {
      sent.push(f);
      if (f.t === "snapshot_req" && snap !== "silent") {
        const body: AgentFrame = {
          t: "snapshot_reply",
          rid: f.rid,
          ...reply({ leafId, ...(sessionFile === undefined ? {} : { sessionFile }), ...snap }),
        };
        queueMicrotask(() => reg.onFrame(key, body));
      }
      if (f.t === "branch_req") {
        queueMicrotask(() => reg.onFrame(key, { t: "branch_reply", rid: f.rid, entries: branch, truncated: false }));
      }
    },
    close() {},
  };
  key = reg.register(hello(), conn).agentKey;
  reg.onFrame(key, {
    t: "session",
    sessionId: "s",
    ...(sessionFile === undefined ? {} : { sessionFile }),
    cwd: "/tmp/w",
    reason: "startup",
    leafId,
    mode: "tui",
  });
  events.length = 0;
  return {
    reg,
    events,
    agentKey: key,
    sent,
    replyWith: (r) => {
      snap = r;
    },
    branchWith: (e) => {
      branch = e;
    },
  };
}

const appends = (events: HubEvent[]): WireEntry[][] => events.flatMap((e) => (e.type === "append" ? [e.entries] : []));

describe("history.snapshot", () => {
  it("reads the agent-reported file at the snapshot leaf (source=file)", async () => {
    const a = agent(writeFixture());
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    a.replyWith({ recent: [{ seq: 4, message: msg("assistant", 2600) }], seq: 4 });
    const p = await h.snapshot(a.agentKey);
    expect(p).toMatchObject({ agentKey: a.agentKey, source: "file", fromSeq: 5, hasMore: false, oldestEntryId: "mc" });
    expect(ids(p.entries)).toEqual(["mc", "u1", "a1", "u2", "c1", "d1", "a2", "t2"]);
    expect(p.tailMessages).toEqual([msg("assistant", 2600)]);
    h.dispose();
  });

  it("keeps only the last tailEntries entries (hasMore + oldestEntryId)", async () => {
    const a = agent(writeFixture());
    const h = createHistoryService({ registry: a.reg, log: memLog(), tailEntries: 3 });
    const p = await h.snapshot(a.agentKey);
    expect(ids(p.entries)).toEqual(["d1", "a2", "t2"]);
    expect(p.hasMore).toBe(true);
    expect(p.oldestEntryId).toBe("d1");
    h.dispose();
  });

  it("file unreadable / leaf not flushed ⇒ branch_req fallback (source=agent), cut at the snapshot leaf", async () => {
    const a = agent(join(tmp.make(), "gone.jsonl"));
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    const e = (id: string, parentId: string | null): WireEntry => ({
      id,
      parentId,
      type: "message",
      timestamp: iso(1),
      message: msg("user", Number(id.slice(1)) || 1),
    });
    a.branchWith([e("m1", null), e("m2", "m1"), e("t2", "m2"), e("m9", "t2")]);
    const p = await h.snapshot(a.agentKey);
    expect(p.source).toBe("agent");
    expect(ids(p.entries)).toEqual(["m1", "m2", "t2"]);
    expect(a.sent.some((f) => f.t === "branch_req")).toBe(true);
    h.dispose();
  });

  it("empty session (leafId null) ⇒ empty history without touching the file", async () => {
    const a = agent(undefined, null);
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    const p = await h.snapshot(a.agentKey);
    expect(p.entries).toEqual([]);
    expect(a.sent.some((f) => f.t === "branch_req")).toBe(false);
    h.dispose();
  });

  it("unknown agent ⇒ E_NOT_FOUND; unanswered snapshot_req ⇒ E_DEADLINE within TIMING.snapshotMs", async () => {
    const a = agent(writeFixture());
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    await expect(h.snapshot("nope")).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    a.replyWith("silent");
    const p = h.snapshot(a.agentKey);
    const settled = expect(p).rejects.toMatchObject({ code: "E_DEADLINE" });
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    h.dispose();
  });

  it("session_compact ev ⇒ gap for subscribers (hard alignment point)", () => {
    const a = agent(writeFixture());
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    a.reg.onFrame(a.agentKey, { t: "ev", seq: 21, e: { type: "session_compact", compactionEntry: { id: "cx" } } });
    expect(a.events.map((e) => e.type)).toEqual(["ev", "gap"]);
    expect(a.events[1]).toEqual({ type: "gap", agentKey: a.agentKey, fromSeq: 21 });
    h.dispose();
  });
});

describe("history tail fill (onLeafChanged)", () => {
  const status = (a: Agent, leafId: string): void =>
    a.reg.onFrame(a.agentKey, { t: "status", leafId, busy: false, pending: false });

  it("idle custom_message with no ev ⇒ append once; repeated leaf changes do not re-push", async () => {
    const file = writeFixture(fixtureLines().split("\n").slice(0, 12).join("\n") + "\n"); // up to t2
    const a = agent(file);
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    await h.snapshot(a.agentKey);
    appendFileSync(
      file,
      line({
        type: "custom_message",
        id: "idle1",
        parentId: "t2",
        timestamp: iso(50),
        customType: "task",
        content: "hi",
      }),
    );
    status(a, "idle1");
    await waitFor(() => appends(a.events).length === 1, 3000);
    expect(ids(appends(a.events)[0]!)).toEqual(["idle1"]);

    // leaf moves again (a custom(data) entry) ⇒ only the new entry, idle1 never re-pushed
    appendFileSync(
      file,
      line({ type: "custom", id: "dd", parentId: "idle1", timestamp: iso(51), customType: "st", data: 1 }),
    );
    status(a, "dd");
    await waitFor(() => appends(a.events).length === 2, 3000);
    expect(ids(appends(a.events)[1]!)).toEqual(["dd"]);
    status(a, "idle1");
    status(a, "dd");
    await sleepReal(700);
    expect(appends(a.events)).toHaveLength(2);
    h.dispose();
  });

  it("a message already forwarded via ev message_end is not re-pushed once it lands in the file", async () => {
    const file = writeFixture(fixtureLines().split("\n").slice(0, 12).join("\n") + "\n");
    const a = agent(file);
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    await h.snapshot(a.agentKey);
    const m = msg("assistant", 4000);
    a.reg.onFrame(a.agentKey, { t: "ev", seq: 30, e: { type: "message_end", message: m } });
    appendFileSync(file, line({ type: "message", id: "n1", parentId: "t2", timestamp: iso(60), message: m }));
    status(a, "n1");
    await sleepReal(700);
    expect(appends(a.events)).toHaveLength(0);
    h.dispose();
  });

  it("a buffered message_end that arrives during the snapshot also counts as delivered", async () => {
    const file = writeFixture(fixtureLines().split("\n").slice(0, 12).join("\n") + "\n");
    const a = agent(file);
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    const m = msg("assistant", 4100);
    const p = h.snapshot(a.agentKey);
    a.reg.onFrame(a.agentKey, { t: "ev", seq: 50, e: { type: "message_end", message: m } }); // seq > reply.seq(10)
    await p;
    appendFileSync(file, line({ type: "message", id: "n2", parentId: "t2", timestamp: iso(61), message: m }));
    status(a, "n2");
    await sleepReal(700);
    expect(appends(a.events)).toHaveLength(0);
    h.dispose();
  });

  it("no subscriber (no snapshot baseline) ⇒ no tail work", async () => {
    const file = writeFixture(fixtureLines().split("\n").slice(0, 12).join("\n") + "\n");
    const a = agent(file);
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    appendFileSync(
      file,
      line({
        type: "custom_message",
        id: "idle2",
        parentId: "t2",
        timestamp: iso(70),
        customType: "task",
        content: "x",
      }),
    );
    status(a, "idle2");
    h.onLeafChanged(a.agentKey, "idle2");
    await sleepReal(700);
    expect(appends(a.events)).toHaveLength(0);
    h.dispose();
  });

  it("a new session drops the baseline (no bogus append of the new session's tail)", async () => {
    const file = writeFixture(fixtureLines().split("\n").slice(0, 12).join("\n") + "\n");
    const a = agent(file);
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    await h.snapshot(a.agentKey);
    const other = writeFixture();
    a.reg.onFrame(a.agentKey, {
      t: "session",
      sessionId: "s2",
      sessionFile: other,
      cwd: "/tmp/w",
      reason: "new",
      leafId: "t2",
      mode: "tui",
    });
    status(a, "late");
    await sleepReal(700);
    expect(appends(a.events)).toHaveLength(0);
    expect(a.events.map((e) => e.type)).toContain("gap"); // registry asks subscribers to re-snapshot
    h.dispose();
  });
});

describe("history.page", () => {
  it("returns up to limit entries before beforeEntryId", async () => {
    const a = agent(writeFixture());
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    const p = await h.page(a.agentKey, "u2", 2);
    expect(ids(p.entries)).toEqual(["u1", "a1"]);
    expect(p).toMatchObject({ hasMore: true, oldestEntryId: "u1", source: "file", tailMessages: [] });
    const first = await h.page(a.agentKey, "u1", 400);
    expect(ids(first.entries)).toEqual(["mc"]);
    expect(first.hasMore).toBe(false);
    await expect(h.page(a.agentKey, "nope", 5)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    await expect(h.page("missing", "u1", 5)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    h.dispose();
  });
});
