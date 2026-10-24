import { appendFileSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScheduleNotes } from "../../../src/schedule/agent/note.js";
import { FakeClock } from "../../../src/core/clock.js";
import { manualClaim } from "../../../src/schedule/core/claim.js";
import { finishRun } from "../../../src/schedule/core/writer.js";
import { procLivenessProbe } from "../../../src/schedule/core/recovery.js";
import { SCHED_NOTE_PROOF_MAX_BYTES } from "../../../src/schedule/core/spec.js";
import { addTask, approve, env, holder, makeTask, readOk, self, SID, type Env } from "../core/fixtures.js";
const envs: Env[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});
async function fixture() {
  const e = env(Date.now());
  envs.push(e);
  const store = e.store();
  const task = approve(makeTask());
  await addTask(store, task, e.clock.t);
  const c = await manualClaim(store, { taskId: task.id, reqId: "note_request_12345", holder: holder() });
  if (c.kind !== "started" || !c.run) throw new Error("fixture");
  await store.transact((d) => ({
    value: finishRun(d, c.runKey, { state: "completed", note: "pending", noteId: "stable-note-id" }, e.clock.t),
    write: true,
  }));
  const file = join(e.dir, "session.jsonl");
  writeFileSync(file, '{"type":"session"}\n');
  const clock = new FakeClock(e.clock.t);
  let idle = false;
  let disposed = false;
  const sendMessage = vi.fn();
  const schedule = {
    mode: { kind: "interactive" as const, arm: true },
    sessionId: SID,
    epoch: holder().epoch,
    self: self(),
    holder: holder(),
    store: () => store,
    isDisposed: () => disposed,
    changed: vi.fn(),
  };
  const deps = { currentSessionId: () => SID, sessionFile: () => file, isIdle: () => idle, sendMessage, clock };
  return {
    e,
    store,
    task,
    run: c.run,
    file,
    schedule,
    deps,
    clock,
    sendMessage,
    idle: () => {
      idle = true;
    },
    dispose: () => {
      disposed = true;
    },
  };
}
const diskEntry = () =>
  JSON.stringify({
    type: "custom_message",
    id: "entry1",
    customType: "subagent:schedule",
    details: { noteId: "stable-note-id" },
  }) + "\n";

describe("schedule result notes — file proof only", () => {
  it("streaming can retain a note over 10 minutes without resend; disk proof marks written", async () => {
    const f = await fixture();
    const notes = createScheduleNotes(f.schedule, f.deps);
    await notes.deliver(f.run.runKey, "报告😀".repeat(3000), false);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(f.sendMessage.mock.calls[0]![0].content)).toBeLessThan(5000);
    f.clock.advance(11 * 60000);
    await notes.flush();
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(readOk(f.store).runs[0]?.note).toBe("pending");
    f.idle();
    await notes.flush();
    expect(readOk(f.store).runs[0]?.note).toBe("pending");
    appendFileSync(f.file, diskEntry());
    notes.settled();
    f.clock.advance(1000);
    await notes.idle();
    expect(readOk(f.store).runs[0]?.note).toBe("written");
    expect(readFileSync(f.file, "utf8").split("stable-note-id")).toHaveLength(2);
    notes.dispose();
    expect(f.clock.pendingTimers).toBe(0);
  });
  it("handoff uses the same note id, remains pending before disk append, and verifies after settled", async () => {
    const f = await fixture();
    const handoff = vi.fn();
    const notes = createScheduleNotes(f.schedule, { ...f.deps, handoff });
    await notes.deliver(f.run.runKey, "请接手", true);
    expect(handoff).toHaveBeenCalledOnce();
    expect(handoff.mock.calls[0]![0].message.details.noteId).toBe("stable-note-id");
    expect(f.sendMessage).not.toHaveBeenCalled();
    f.idle();
    await notes.flush();
    expect(readOk(f.store).runs[0]?.note).toBe("pending");
    appendFileSync(f.file, diskEntry());
    await notes.flush();
    expect(readOk(f.store).runs[0]?.note).toBe("written");
    notes.dispose();
  });
  it("refused handoff admission falls back to one quiet recap with the same id", async () => {
    const f = await fixture();
    const handoff = vi.fn(() => false);
    const notes = createScheduleNotes(f.schedule, { ...f.deps, handoff });
    await notes.deliver(f.run.runKey, "接手结果", true);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.sendMessage.mock.calls[0]![0].details).toMatchObject({ kind: "handoff-recap", noteId: "stable-note-id" });
    expect(f.sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
    notes.dispose();
  });
  it("two views atomically claim a dead sender's absent note once, preserving id and forcing handoff recap quiet", async () => {
    const f = await fixture();
    f.idle();
    f.task.bg!.handoff = true;
    await f.store.transact((d) => {
      d.tasks[0]!.bg!.handoff = true;
      d.runs[0]!.holder = { ...holder(), boot: "old-boot" };
      d.runs[0]!.noteHolder = d.runs[0]!.holder;
      return { value: undefined, write: true };
    });
    // Use a stable old file so the real session-proof can prove absence.
    await new Promise((r) => setTimeout(r, 60));
    const n1 = createScheduleNotes(f.schedule, f.deps);
    const n2 = createScheduleNotes(f.schedule, f.deps);
    await Promise.all([n1.flush(), n2.flush()]);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.sendMessage.mock.calls[0]![0].details).toMatchObject({ noteId: "stable-note-id", kind: "handoff-recap" });
    expect(readOk(f.store).runs[0]?.noteHolder).toEqual(f.schedule.holder);
    n1.dispose();
    n2.dispose();
    // A second process dies without appending the note either. A third process must not send.
    const next = createScheduleNotes(
      {
        ...f.schedule,
        epoch: "next",
        self: { ...self(), boot: "next-boot" },
        holder: { ...holder("next"), boot: "next-boot" },
      },
      f.deps,
    );
    await next.flush();
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(readOk(f.store).runs[0]?.note).toBe("unverified");
    next.dispose();
  });
  it("second cross-process absence is unverified without another resend (user ruling)", async () => {
    const f = await fixture();
    f.idle();
    await f.store.transact((d) => {
      d.runs[0]!.holder = { ...holder(), boot: "original-boot" };
      d.runs[0]!.noteHolder = { ...holder(), boot: "resender-boot" };
      return { value: undefined, write: true };
    });
    await new Promise((r) => setTimeout(r, 60));
    const notes = createScheduleNotes(f.schedule, f.deps);
    await notes.flush();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(readOk(f.store).runs[0]?.note).toBe("unverified");
    notes.dispose();
  });
  it("same process old epoch never resends, even if the epoch is disposed", async () => {
    const f = await fixture();
    f.idle();
    await f.store.transact((d) => {
      d.runs[0]!.noteHolder = { ...holder(), epoch: "old-epoch" };
      return { value: undefined, write: true };
    });
    const notes = createScheduleNotes(f.schedule, f.deps);
    await notes.flush();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(readOk(f.store).runs[0]?.note).toBe("pending");
    notes.dispose();
  });
  it("a living different process is not even scanned, despite an oversized session file", async () => {
    const f = await fixture();
    f.idle();
    const start = procLivenessProbe.startOf(process.ppid);
    if (typeof start !== "number") throw new Error("live parent identity unavailable");
    await f.store.transact((d) => {
      d.runs[0]!.noteHolder = { ...holder(), pid: process.ppid, start };
      return { value: undefined, write: true };
    });
    truncateSync(f.file, SCHED_NOTE_PROOF_MAX_BYTES + 1);
    const notes = createScheduleNotes(f.schedule, f.deps);
    await notes.flush();
    expect(readOk(f.store).runs[0]?.note).toBe("pending");
    expect(f.sendMessage).not.toHaveBeenCalled();
    notes.dispose();
  });
  it("an unprovable other sender does not trigger proof or resend", async () => {
    const f = await fixture();
    f.idle();
    await f.store.transact((d) => {
      d.runs[0]!.noteHolder = { ...holder(), host: "unknown-host" };
      return { value: undefined, write: true };
    });
    const notes = createScheduleNotes(f.schedule, f.deps);
    await notes.flush();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(readOk(f.store).runs[0]?.note).toBe("pending");
    notes.dispose();
  });
  it("inconclusive scan never resends; too-large marks unverified", async () => {
    const f = await fixture();
    f.idle();
    await f.store.transact((d) => {
      d.runs[0]!.noteHolder = { ...holder(), boot: "dead" };
      return { value: undefined, write: true };
    });
    writeFileSync(f.file, "fresh");
    const notes = createScheduleNotes(f.schedule, f.deps);
    await notes.flush();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(readOk(f.store).runs[0]?.note).toBe("pending");
    truncateSync(f.file, SCHED_NOTE_PROOF_MAX_BYTES + 1);
    await notes.flush();
    expect(readOk(f.store).runs[0]?.note).toBe("unverified");
    expect(f.sendMessage).not.toHaveBeenCalled();
    notes.dispose();
  });
  it("proof of a dead sender's already written note prevents redelivery", async () => {
    const f = await fixture();
    f.idle();
    appendFileSync(f.file, diskEntry());
    await f.store.transact((d) => {
      d.runs[0]!.noteHolder = { ...holder(), boot: "dead" };
      return { value: undefined, write: true };
    });
    const notes = createScheduleNotes(f.schedule, f.deps);
    await notes.flush();
    expect(readOk(f.store).runs[0]?.note).toBe("written");
    expect(f.sendMessage).not.toHaveBeenCalled();
    notes.dispose();
  });
  it("print mode does not read host ctx or emit pending results", async () => {
    const f = await fixture();
    const notes = createScheduleNotes(
      { ...f.schedule, mode: { kind: "print", arm: false } },
      {
        ...f.deps,
        currentSessionId: () => {
          throw new Error("print ctx read");
        },
      },
    );
    await notes.deliver(f.run.runKey, "print", false);
    await notes.flush();
    notes.settled();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.clock.pendingTimers).toBe(0);
    expect(readOk(f.store).runs[0]?.note).toBe("pending");
    notes.dispose();
  });
  it("dispose blocks all old-ctx accesses and messages", async () => {
    const f = await fixture();
    f.dispose();
    const notes = createScheduleNotes(f.schedule, {
      ...f.deps,
      currentSessionId: () => {
        throw new Error("old ctx accessed");
      },
    });
    await notes.deliver(f.run.runKey, "old", false);
    await notes.flush();
    notes.settled();
    expect(f.clock.pendingTimers).toBe(0);
    expect(f.sendMessage).not.toHaveBeenCalled();
    notes.dispose();
  });
});
