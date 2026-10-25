import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeDigest, createScheduleDigest, deriveCoversAt } from "../../../src/schedule/agent/digest.js";
import { createTask } from "../../../src/schedule/agent/ops.js";
import { isEpochDisposed } from "../../../src/schedule/agent/wire.js";
import { sweep } from "../../../src/schedule/core/claim.js";
import { emptyStateFile, type ScheduleStateFile } from "../../../src/schedule/core/spec.js";
import { a3Env, type A3Env } from "./a3-helpers.js";
import { makeTask, readOk, self, SID } from "../core/fixtures.js";

let env: A3Env;
let tmp: string;
afterEach(() => {
  env?.cleanup();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const HOURLY = { kind: "cron", expr: "0 * * * *", tz: "UTC" };

interface Sent {
  customType: string;
  content: string;
  details: { kind: string; digestId: string; covers: unknown };
}

function setup(over: { idle?: boolean; file?: string } = {}) {
  env = a3Env();
  tmp = mkdtempSync(join(tmpdir(), "sched-digest-"));
  const file = over.file ?? join(tmp, "session.jsonl");
  writeFileSync(file, '{"type":"session"}\n');
  const sentMsgs: Sent[] = [];
  const notes: string[] = [];
  const idle = { value: over.idle ?? true };
  let n = 0;
  const mk = (agent = env.agent) =>
    createScheduleDigest({
      agent,
      sessionFile: () => file,
      sendMessage: (m) => void sentMsgs.push(m as Sent),
      notify: (t) => void notes.push(t),
      isIdle: () => idle.value,
      clock: env.fake,
      isEpochDisposed,
      newId: () => `dg_test${++n}`,
      proofSettleMs: 0,
    });
  const persist = (id: string) =>
    appendFileSync(
      file,
      JSON.stringify({
        type: "custom_message",
        customType: "subagent:schedule",
        details: { digestId: id },
        id: `e-${id}`,
      }) + "\n",
    );
  return { file, sentMsgs, notes, idle, mk, persist };
}

/** An approved hourly task, then the session "was closed" for 3.5 hours: sweep records the misses. */
async function missedScenario() {
  const t = await createTask(env.ports, { name: "hourly", when: HOURLY, prompt: "p" }, { by: "user", via: "tui" });
  if (!t.ok) throw new Error(t.detail);
  env.fake.advance(3.5 * 3_600_000);
  const s = env.agent.store()!;
  await sweep(s);
  return t.value;
}

describe("computeDigest (pure)", () => {
  it("nothing new ⇒ undefined", () => {
    expect(computeDigest(emptyStateFile(SID), 1000)).toBeUndefined();
  });
  it("reports missed deltas, unknown/dropped/refused runs and index-overflow, with covers", () => {
    const st: ScheduleStateFile = emptyStateFile(SID);
    const t = makeTask({ name: "nightly" });
    st.tasks.push(t);
    st.occ[t.id] = {
      defHash: "x",
      decidedThrough: 0,
      firedTotal: 0,
      missedTotal: 5,
      skippedTotal: 0,
      missedLog: [{ seq: 1, defHash: "x", from: 0, to: 3_600_000, count: 5, totalAfter: 5, at: 10, cause: "offline" }],
    };
    st.digest.shownMissedTotal[t.id] = 2;
    const base = {
      taskId: t.id,
      kind: "auto",
      form: "background",
      scheduledAt: 100,
      defHash: "x",
      startedAt: 100,
      note: "none",
    } as const;
    const holder = { pid: 1, start: 1, host: "h", boot: "b", epoch: "e" };
    st.runs.push(
      { ...base, runKey: `${t.id}@100`, state: "unknown", reason: "owner-closed", endedAt: 200, holder },
      { ...base, runKey: `${t.id}@200`, state: "refused", reason: "admission:quota", endedAt: 300, holder },
      { ...base, runKey: `${t.id}@300`, state: "completed", endedAt: 400, holder },
    );
    st.reportStats = { droppedIndexCap: 2, lastDroppedAt: 500 };
    const d = computeDigest(st, 1000)!;
    expect(d.text).toContain("错过了 3 次运行");
    expect(d.text).toContain("累计错过 5 次");
    expect(d.text).toContain("结果未知（owner-closed）");
    expect(d.text).toContain("被拒绝（admission:quota）");
    expect(d.text).not.toContain("completed");
    expect(d.text).toContain("2 份报告因积压");
    expect(d.covers).toEqual({ missed: { [t.id]: 5 }, runsThrough: 1000 });
    // watermarks already past everything ⇒ silent
    st.digest.shownMissedTotal[t.id] = 5;
    st.digest.shownRunsThrough = 1000;
    expect(computeDigest(st, 2000)).toBeUndefined();
  });
  it("deriveCoversAt uses the last missed entry written no later than the claim instant", () => {
    const st = emptyStateFile(SID);
    const t = makeTask();
    st.tasks.push(t);
    st.occ[t.id] = {
      defHash: "x",
      decidedThrough: 0,
      firedTotal: 0,
      missedTotal: 9,
      skippedTotal: 0,
      missedLog: [
        { seq: 1, defHash: "x", from: 0, to: 1, count: 4, totalAfter: 4, at: 100, cause: "offline" },
        { seq: 2, defHash: "x", from: 1, to: 2, count: 5, totalAfter: 9, at: 300, cause: "late" },
      ],
    };
    expect(deriveCoversAt(st, 200)).toEqual({ missed: { [t.id]: 4 }, runsThrough: 200 });
    expect(deriveCoversAt(st, 50)).toEqual({ missed: {}, runsThrough: 50 });
  });
});

describe("digest controller", () => {
  it("no news ⇒ nothing sent and the ledger is not touched", async () => {
    const h = setup();
    const d = h.mk();
    await d.run();
    expect(h.sentMsgs).toHaveLength(0);
    expect(env.agent.readState().kind).toBe("absent");
  });

  it("sends ONE quiet digest; the watermark advances only after the message is PROVEN in the session file", async () => {
    const h = setup();
    const t = await missedScenario();
    const d = h.mk();
    await d.run();
    expect(h.sentMsgs).toHaveLength(1);
    const msg = h.sentMsgs[0]!;
    expect(msg.customType).toBe("subagent:schedule");
    expect(msg.details.kind).toBe("digest");
    expect(msg.content).toContain(t.id);
    expect(h.notes).toHaveLength(1);
    let st = readOk(env.agent.store()!);
    expect(st.digest.inflight?.id).toBe(msg.details.digestId);
    expect(st.digest.shownMissedTotal[t.id] ?? 0).toBe(0); // NOT advanced on send

    // pi still holds the quiet message in memory (not in the file): same process never resends
    h.idle.value = true;
    await d.tick();
    await d.run();
    expect(h.sentMsgs).toHaveLength(1);
    expect(readOk(env.agent.store()!).digest.inflight).toBeDefined();

    // not idle ⇒ no verification even when the entry is there
    h.persist(msg.details.digestId);
    h.idle.value = false;
    await d.tick();
    expect(readOk(env.agent.store()!).digest.inflight).toBeDefined();
    h.idle.value = true;
    await d.tick();
    st = readOk(env.agent.store()!);
    expect(st.digest.inflight).toBeUndefined();
    expect(st.digest.shownMissedTotal[t.id]).toBe(st.occ[t.id]!.missedTotal);
    expect(st.occ[t.id]!.missedTotal).toBeGreaterThan(0); // missedTotal is never reset
    // and the same news is never announced again
    await d.run();
    expect(h.sentMsgs).toHaveLength(1);
  });

  it("the verify timer proves a message that landed immediately (idle session)", async () => {
    const h = setup();
    await missedScenario();
    const d = h.mk();
    await d.run();
    h.persist(h.sentMsgs[0]!.details.digestId);
    env.fake.advance(2_500);
    await d.tick(); // serialized behind the timer-driven verify
    expect(readOk(env.agent.store()!).digest.inflight).toBeUndefined();
  });

  it("two views: a live claim by another epoch is respected (no second digest)", async () => {
    const h = setup();
    await missedScenario();
    const first = h.mk();
    await first.run();
    expect(h.sentMsgs).toHaveLength(1);
    const second = h.mk(); // same ledger, fresh controller (no `sent`) — the claim belongs to a LIVE holder
    await second.run();
    expect(h.sentMsgs).toHaveLength(1);
  });

  async function plantDeadClaim(id: string, at: number) {
    const s = env.agent.ensureStore();
    const me = self();
    await s.transact((d) => {
      d.digest.inflight = { pid: 2_000_000_000, start: 1, host: me.host, boot: me.boot, epoch: "ghost", id, at };
      return { value: undefined, write: true };
    });
  }

  it("dead holder + message FOUND in the file ⇒ only the watermark advances, nothing is resent", async () => {
    const h = setup();
    const t = await missedScenario();
    await plantDeadClaim("dg_ghost", env.fake.now());
    h.persist("dg_ghost");
    const d = h.mk();
    await d.run();
    expect(h.sentMsgs).toHaveLength(0);
    const st = readOk(env.agent.store()!);
    expect(st.digest.inflight).toBeUndefined();
    expect(st.digest.shownMissedTotal[t.id]).toBe(st.occ[t.id]!.missedTotal);
  });

  it("dead holder + message confirmed ABSENT ⇒ reclaimed and sent once with a new id", async () => {
    const h = setup();
    await missedScenario();
    await plantDeadClaim("dg_ghost", env.fake.now());
    const d = h.mk();
    await d.run();
    expect(h.sentMsgs).toHaveLength(1);
    expect(h.sentMsgs[0]!.details.digestId).toBe("dg_test1");
    expect(readOk(env.agent.store()!).digest.inflight?.id).toBe("dg_test1");
  });

  it("tick never creates news (only run() does); non-interactive modes do nothing", async () => {
    const h = setup();
    await missedScenario();
    const d = h.mk();
    await d.tick();
    expect(h.sentMsgs).toHaveLength(0);
    env.cleanup();
    env = a3Env({}, "print");
    const p = createScheduleDigest({
      agent: env.agent,
      sessionFile: () => h.file,
      sendMessage: () => {
        throw new Error("must not send");
      },
      notify: () => undefined,
      isIdle: () => true,
      clock: env.fake,
      isEpochDisposed,
    });
    await p.run();
  });

  it("a disposed controller / agent sends nothing", async () => {
    const h = setup();
    await missedScenario();
    const d = h.mk();
    d.dispose();
    await d.run();
    expect(h.sentMsgs).toHaveLength(0);
  });
});
