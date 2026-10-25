import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentFrame,
  HubFrame,
  SnapshotReplyBody,
  WireEntry,
  WireMessage,
} from "../../../src/web-hub/protocol/messages.js";
import { TIMING } from "../../../src/web-hub/protocol/messages.js";
import type { HubEvent } from "../../../src/web-hub/hub/ports.js";
import {
  APPEND_TAIL_ENTRIES,
  createHistoryService,
  DEFAULT_MAX_FILE_BYTES,
  RUNTAIL_BRANCH_FALLBACK_BYTES,
} from "../../../src/web-hub/hub/history.js";
import { createRegistry, type AgentConn, type Registry } from "../../../src/web-hub/hub/registry.js";
import { hello, memLog, recordBus, sleepReal, tmpDirs, waitFor } from "./helpers.js";

/**
 * cmd-history H1 (plan §4.10, M4): the hub-side `runTail` ENOENT branch fallback.
 *
 * pi does not create the session file until the first user/assistant message lands, so a
 * persisted-session report (a path, but no file yet) used to silently drop the real-time
 * `append` for every idle custom entry written in that window — exactly where the first
 * `subagent:cmd` records of a fresh session land. The fallback asks the agent's in-memory
 * branch (`branch_req`, the same frame `loadBranch` already uses) ONLY for ENOENT reads of a
 * DEFINED session file; `--no-session` (file===undefined) keeps today's early return (M4).
 *
 * Boundary pinned here too (M4/R9, honest): the fallback is unconditional — it fires for old
 * agents and `cmdHistory:false` sessions alike (the hub cannot know that setting) — and
 * hub.log never carries entry/output content (§5.3 log hygiene).
 */

const tmp = tmpDirs();
afterEach(() => {
  vi.useRealTimers();
  tmp.cleanup();
});

// ---------------------------------------------------------------------------
// fixture: scripted agent connection over a real registry (same shape as history.test.ts's,
// with the branch_reply source shared by snapshot-fallback and runTail-fallback)
// ---------------------------------------------------------------------------

const msg = (role: string, timestamp: number): WireMessage => ({
  role,
  timestamp,
  content: `${role}@${timestamp}`,
});
const iso = (): string => new Date(1_790_000_000_000).toISOString();
const line = (o: object): string => `${JSON.stringify(o)}\n`;

/** Deterministic per-id message timestamp ⇒ distinct `role:timestamp` diff keys per entry. */
const tsOf = (id: string): number => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 100_000;
  return 1_000 + h;
};

const entry = (id: string, parentId: string | null): WireEntry => ({
  id,
  parentId,
  type: "message",
  timestamp: iso(),
  message: msg("user", tsOf(id)),
});

/** A projected `subagent:cmd` record as the AGENT would return it in a branch_reply. */
const cmdEntry = (id: string, parentId: string, args: string): WireEntry => ({
  id,
  parentId,
  type: "custom",
  timestamp: iso(),
  customType: "subagent:cmd",
  display: false,
  dataKey: `dk-${id}`,
  cmd: {
    v: 1,
    cmdId: "c".repeat(20),
    phase: "end",
    name: "record",
    args,
    source: "web",
    startedAt: 1_000,
    endedAt: 2_000,
    state: "done",
  },
});

/** The baseline branch every test snapshots against (m1 → m2). */
const baseline = (): WireEntry[] => [entry("m1", null), entry("m2", "m1")];

interface TestAgent {
  reg: Registry;
  events: HubEvent[];
  agentKey: string;
  sent: HubFrame[];
  replyWith: (r: Partial<SnapshotReplyBody> | "silent") => void;
  branchWith: (e: WireEntry[] | "silent") => void;
}

function agent(sessionFile: string | undefined, leafId: string | null = "m2"): TestAgent {
  const reg = createRegistry({ now: () => Date.now(), log: memLog(), pidAlive: () => true });
  const events = recordBus(reg);
  const sent: HubFrame[] = [];
  let snap: Partial<SnapshotReplyBody> | "silent" = {};
  let branch: WireEntry[] | "silent" = [];
  let key = "";
  const conn: AgentConn = {
    send(f) {
      sent.push(f);
      if (f.t === "snapshot_req" && snap !== "silent") {
        const body: AgentFrame = {
          t: "snapshot_reply",
          rid: f.rid,
          seq: 10,
          leafId,
          recent: [],
          prompts: [],
          status: { leafId, busy: false, pending: false },
          fleet: [],
          ...(sessionFile === undefined ? {} : { sessionFile }),
          ...snap,
        };
        queueMicrotask(() => reg.onFrame(key, body));
      }
      if (f.t === "branch_req" && branch !== "silent") {
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
const branchReqs = (sent: readonly HubFrame[]): HubFrame[] => sent.filter((f) => f.t === "branch_req");
const status = (a: TestAgent, leafId: string): void =>
  a.reg.onFrame(a.agentKey, { t: "status", leafId, busy: false, pending: false });

/** Minimal on-disk chain m1 → m2 (for snapshots that must read the FILE, not the agent).
 * Messages mirror `entry()`'s derived timestamps so file- and agent-side entries share keys. */
function writeChainFile(): string {
  const file = join(tmp.make("wh-cmdhist-"), "session.jsonl");
  writeFileSync(
    file,
    [
      line({ type: "message", id: "m1", parentId: null, timestamp: iso(), message: msg("user", tsOf("m1")) }),
      line({ type: "message", id: "m2", parentId: "m1", timestamp: iso(), message: msg("user", tsOf("m2")) }),
    ].join(""),
  );
  return file;
}

describe("cmd-history H1 §4.10 — runTail ENOENT branch fallback", () => {
  it("persisted path, no file yet ⇒ branch_req fallback, cut at the pending leaf, append carries ONLY the new entry (256 KiB budget pin)", async () => {
    const a = agent(join(tmp.make(), "later.jsonl")); // exists as a path, never as a file
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    a.branchWith(baseline());
    await h.snapshot(a.agentKey); // baseline m1,m2 via loadBranch's existing branch_req
    a.sent.length = 0;
    a.events.length = 0;

    a.branchWith([...baseline(), entry("n1", "m2"), entry("future", "n1")]);
    status(a, "n1");
    await waitFor(() => appends(a.events).length === 1, 3000);

    expect(appends(a.events)).toHaveLength(1);
    expect(appends(a.events)[0]!.map((e) => e.id)).toEqual(["n1"]); // cut at the leaf: no "future", no baseline re-push
    // the fallback rides the SAME branch_req frame loadBranch uses, with the §4.10 256 KiB budget
    expect(branchReqs(a.sent)).toHaveLength(1);
    expect(branchReqs(a.sent)[0]).toMatchObject({ t: "branch_req", maxBytes: RUNTAIL_BRANCH_FALLBACK_BYTES });
    expect(RUNTAIL_BRANCH_FALLBACK_BYTES).toBe(256 << 10);
    h.dispose();
  });

  it("the fallback append carries a projected subagent:cmd entry unchanged (pass-through, no re-projection)", async () => {
    const a = agent(join(tmp.make(), "later2.jsonl"));
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    a.branchWith(baseline());
    await h.snapshot(a.agentKey);
    a.sent.length = 0;
    a.events.length = 0;

    const rec = cmdEntry("n1", "m2", "status --token=SECRETProbe123");
    a.branchWith([...baseline(), rec]);
    status(a, "n1");
    await waitFor(() => appends(a.events).length === 1, 3000);
    expect(appends(a.events)[0]).toEqual([rec]);
    h.dispose();
  });

  it("leaf not present in the branch reply ⇒ read-failure treatment: no append, delivered untouched; the NEXT leaf change recovers", async () => {
    const a = agent(join(tmp.make(), "later3.jsonl"));
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    a.branchWith(baseline());
    await h.snapshot(a.agentKey);
    a.sent.length = 0;
    a.events.length = 0;

    // pending leaf "ghost" never appears in the agent's branch
    a.branchWith([...baseline(), entry("x9", "m2")]);
    status(a, "ghost");
    await sleepReal(700);
    expect(appends(a.events)).toHaveLength(0); // no unaligned diff
    expect(branchReqs(a.sent)).toHaveLength(1); // the request DID go out

    // next leaf change aligns again and publishes just the new entry
    status(a, "x9");
    await waitFor(() => appends(a.events).length === 1, 3000);
    expect(appends(a.events)[0]!.map((e) => e.id)).toEqual(["x9"]);
    h.dispose();
  });

  it("file===undefined (--no-session) ⇒ today's early return: no branch_req, no append (M4: out of scope)", async () => {
    const a = agent(undefined); // --no-session: no path at all
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    a.branchWith(baseline());
    await h.snapshot(a.agentKey); // snapshot still falls back via branch_req (existing loadBranch path)
    a.sent.length = 0;
    a.events.length = 0;

    a.branchWith([...baseline(), entry("n1", "m2")]);
    status(a, "n1");
    await sleepReal(700);
    expect(appends(a.events)).toHaveLength(0);
    expect(branchReqs(a.sent)).toHaveLength(0); // runTail never asked
    h.dispose();
  });

  it("file existed at snapshot time and then disappeared (ENOENT mid-session) ⇒ fallback still publishes", async () => {
    const file = writeChainFile();
    const a = agent(file);
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    const p = await h.snapshot(a.agentKey);
    expect(p.source).toBe("file");
    a.sent.length = 0;
    a.events.length = 0;

    rmSync(file);
    a.branchWith([...baseline(), entry("n1", "m2")]);
    status(a, "n1");
    await waitFor(() => appends(a.events).length === 1, 3000);
    expect(appends(a.events)[0]!.map((e) => e.id)).toEqual(["n1"]);
    h.dispose();
  });

  it("TOO_LARGE / PARSE / LEAF_NOT_FOUND keep today's early return — the fallback is ENOENT-only (no branch_req at all)", async () => {
    const cases: Array<{ name: string; break: (file: string) => void }> = [
      {
        name: "TOO_LARGE",
        break: (file) => {
          truncateSync(file, DEFAULT_MAX_FILE_BYTES + 1); // sparse: size over budget without writing 256 MiB
        },
      },
      {
        name: "PARSE",
        break: (file) => {
          appendFileSync(
            file,
            `${line({ type: "message", id: "n1", parentId: "m2", timestamp: iso(), message: msg("user", 3) })}{broken\n${line({ id: "z" })}`,
          );
        },
      },
    ];
    for (const c of cases) {
      const file = writeChainFile();
      const a = agent(file);
      const h = createHistoryService({ registry: a.reg, log: memLog() });
      a.branchWith([...baseline(), entry("n1", "m2")]); // would answer if (wrongly) asked
      await h.snapshot(a.agentKey);
      a.sent.length = 0;
      a.events.length = 0;
      c.break(file);
      status(a, "n1"); // n1 is on disk for PARSE — irrelevant: the read must fail before the walk
      await sleepReal(700);
      expect(appends(a.events)).toHaveLength(0);
      expect(branchReqs(a.sent)).toHaveLength(0); // non-ENOENT never falls back
      h.dispose();
    }

    // LEAF_NOT_FOUND: the file parses but the pending leaf is not in it
    const file = writeChainFile();
    const a = agent(file);
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    await h.snapshot(a.agentKey);
    a.sent.length = 0;
    a.events.length = 0;
    status(a, "ghost");
    await sleepReal(700);
    expect(appends(a.events)).toHaveLength(0);
    expect(branchReqs(a.sent)).toHaveLength(0);
    h.dispose();
  });

  it("agent never answers branch_req ⇒ E_DEADLINE at TIMING.snapshotMs: logged info, no append, no throw — and the loop is NOT wedged (next leaf change works)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = agent(join(tmp.make(), "later4.jsonl"));
    const log = memLog();
    const h = createHistoryService({ registry: a.reg, log });
    a.branchWith(baseline());
    await h.snapshot(a.agentKey);
    a.sent.length = 0;
    a.events.length = 0;

    a.branchWith("silent");
    status(a, "n1");
    await vi.advanceTimersByTimeAsync(500); // leaf debounce
    // The ENOENT read is REAL fs I/O: fake timers cannot advance it, so a fixed fake-time slice is a
    // race on a loaded runner. Poll in real time (≤5 s) until the pending branch_req appears; each
    // step advances only 1 fake ms, far below TIMING.snapshotMs.
    for (let i = 0; i < 1_000 && branchReqs(a.sent).length === 0; i++) {
      await vi.advanceTimersByTimeAsync(1);
      await sleepReal(5);
    }
    expect(branchReqs(a.sent)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TIMING.snapshotMs); // registry deadline fires
    await vi.advanceTimersByTimeAsync(1_000); // settle the rejection → catch → log.info → return
    expect(appends(a.events)).toHaveLength(0);
    const info = log.lines.filter((l) => l.level === "info" && l.msg.includes("branch fallback"));
    expect(info).toHaveLength(1);
    expect(String(JSON.stringify(info[0]!.data))).toContain("E_DEADLINE");

    // not wedged: the same agent answers the next round
    a.branchWith([...baseline(), entry("n2", "m2")]);
    status(a, "n2");
    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 1_000 && appends(a.events).length === 0; i++) {
      await vi.advanceTimersByTimeAsync(1); // real fs I/O in the loop — poll, don't guess a fake-time slice
      await sleepReal(5);
    }
    expect(appends(a.events)).toHaveLength(1);
    expect(appends(a.events)[0]!.map((e) => e.id)).toEqual(["n2"]);
    h.dispose();
  });

  it("log hygiene (§5.3): neither the fallback success nor its failure ever writes entry/output content into hub.log", async () => {
    const secret = "SECRETProbe123";
    const a = agent(join(tmp.make(), "later5.jsonl"));
    const log = memLog();
    const h = createHistoryService({ registry: a.reg, log });
    a.branchWith(baseline());
    await h.snapshot(a.agentKey);
    a.sent.length = 0;
    a.events.length = 0;

    a.branchWith([...baseline(), cmdEntry("n1", "m2", `status --token=${secret}`)]);
    status(a, "n1");
    await waitFor(() => appends(a.events).length === 1, 3000);
    // a failing round too (leaf missing) so the error path's log line is exercised
    a.branchWith(baseline());
    status(a, "ghost");
    await sleepReal(700);
    for (const l of log.lines) {
      expect(JSON.stringify(l)).not.toContain(secret);
    }
    h.dispose();
  });

  it("the tail window still applies after the leaf cut: an agent branch longer than APPEND_TAIL_ENTRIES diffs only its new entries", async () => {
    const a = agent(join(tmp.make(), "later6.jsonl"));
    const h = createHistoryService({ registry: a.reg, log: memLog() });
    // baseline: a long chain
    const base: WireEntry[] = [];
    let parent: string | null = null;
    for (let i = 0; i < APPEND_TAIL_ENTRIES + 10; i++) {
      const e2 = entry(`b${i}`, parent);
      base.push(e2);
      parent = `b${i}`;
    }
    const leaf = `b${APPEND_TAIL_ENTRIES + 9}`;
    a.replyWith({ leafId: leaf });
    a.branchWith(base);
    await h.snapshot(a.agentKey);
    a.sent.length = 0;
    a.events.length = 0;

    const grown = [...base, entry("fresh", leaf)];
    a.branchWith(grown);
    status(a, "fresh");
    await waitFor(() => appends(a.events).length === 1, 3000);
    expect(appends(a.events)[0]!.map((e) => e.id)).toEqual(["fresh"]); // delivered baseline (≥ tail window) prevents any re-push
    h.dispose();
  });
});
