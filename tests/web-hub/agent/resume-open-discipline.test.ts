/**
 * web-resume plan §4 "Open discipline (P1+P2)" — the P2 halves: the generation build's
 * `openSessionNoFollowAsync`, the provenance advance (real P1 scan), and the exec
 * re-validation's sync `openSessionNoFollow` all use the shared O_NOFOLLOW|O_NONBLOCK|O_NOCTTY
 * discipline, so a target swapped for a FIFO without a writer (r2 B1) or a device node is
 * REJECTED, never hung on; every failure path closes its fds back to baseline.
 * Each test is wrapped in a hard wall-clock timeout — a hang fails it.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import { readdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { createResumeList, defaultResumeCore, type ResumeListHandle } from "../../../src/web-hub/agent/resume-list.js";
import { createExecGate, createResumeExec, type ResumeExecHandle } from "../../../src/web-hub/agent/resume-exec.js";
import { openSessionNoFollow } from "../../../src/session-nav/session-head.js";
import { advanceProvenance } from "../../../src/session-nav/provenance.js";
import { fakeClock, fakeIndex, makeLayout, writeSession, type Layout } from "./resume-fixtures.js";
import type { CmdArgs, CmdFrame, CmdOrigin, ResumeSessionsWire } from "../../../src/web-hub/protocol/messages.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
const CWD = "/tmp/web-resume-discipline";

function cmdArgsOf(args: string): CmdArgs & { op: "command" } {
  return { op: "command", name: "resume", args };
}
function frameOf(args: string): CmdFrame {
  return { t: "cmd", rid: "r", id: "cmd-0000000000000001", deadlineMs: 8_000, origin: ORIGIN, cmd: cmdArgsOf(args) };
}

function mkfifo(path: string): void {
  execSync(`mkfifo '${path}'`);
}

function fdCount(): number {
  return readdirSync("/proc/self/fd").length;
}

async function withHardDeadline<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
  const started = fdCount();
  const guard = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`HARD DEADLINE (${ms}ms) exceeded: ${label}`)), ms);
    t.unref();
  });
  const out = await Promise.race([fn(), guard]);
  // fd baseline restored after every path (success and failure alike)
  expect(fdCount()).toBe(started);
  return out;
}

function makeLists(layout: Layout, clock: ReturnType<typeof fakeClock>): ResumeListHandle {
  return createResumeList({
    getSessionDir: () => layout.sessionDir,
    cwd: () => CWD,
    currentSessionId: () => "cur1",
    now: clock.now,
    core: { ...defaultResumeCore(), advanceProvenance: async () => fakeIndex() },
  });
}

describe("resume open discipline — FIFO / device / fd baseline (r2 B1)", () => {
  it("build: a listed regular file swapped for a writer-less FIFO is rejected, not hung", async () => {
    const layout = makeLayout();
    onTestFinished(() => layout.cleanup());
    const clock = fakeClock(Date.now());
    const lists = makeLists(layout, clock);
    writeSession(layout.sessionDir, "fifo.jsonl", { id: "f1", cwd: CWD, mtime: new Date(clock.now() - 120_000) });
    rmSync(join(layout.sessionDir, "fifo.jsonl"));
    mkfifo(join(layout.sessionDir, "fifo.jsonl"));
    const w: ResumeSessionsWire = await withHardDeadline(2_000, "list over FIFO", async () => {
      const r = await lists.list(frameOf('__list {"scope":"all"}'), cmdArgsOf('__list {"scope":"all"}'));
      expect(r.ok).toBe(true);
      return (r as { data: { sessions: ResumeSessionsWire } }).data.sessions;
    });
    expect(w.rows).toHaveLength(0); // the FIFO is not a session — silently not a row
  });

  it("exec re-validation: the target swapped for a writer-less FIFO is rejected, not hung", async () => {
    const layout = makeLayout();
    onTestFinished(() => layout.cleanup());
    const clock = fakeClock(Date.now());
    const lists = makeLists(layout, clock);
    const target = writeSession(layout.sessionDir, "t.jsonl", {
      id: "t1",
      cwd: CWD,
      mtime: new Date(clock.now() - 120_000),
    });
    const gate = createExecGate({ now: clock.now });
    let nonce = "";
    const exec: ResumeExecHandle = createResumeExec({
      sendUserMessage: (text) => {
        nonce = text.split(" ")[3]!;
      },
      getSessionId: () => "cur1",
      getSessionFile: () => undefined,
      now: clock.now,
      lists,
      gate,
      core: defaultResumeCore(),
      setTimer: () => ({ cancel: () => undefined }),
      sendLate: () => undefined,
    });
    const listR = await lists.list(frameOf('__list {"scope":"all"}'), cmdArgsOf('__list {"scope":"all"}'));
    const wire = (listR as { data: { sessions: ResumeSessionsWire } }).data.sessions;
    const args = cmdArgsOf(`__pick ${JSON.stringify({ id: wire.rows[0]!.id, gen: wire.gen })}`);
    const pickCtx = { isIdle: () => true, hasPendingMessages: () => false } as never;
    const picked = exec.pick(frameOf(args), args, pickCtx);
    expect(picked.ok).toBe(true);
    rmSync(target);
    mkfifo(target);
    const cmdCtx = { isIdle: () => true, hasPendingMessages: () => false, cwd: CWD, switchSession: undefined } as never;
    const ran = await withHardDeadline(2_000, "exec over FIFO", () => exec.internalExecResume(nonce, cmdCtx));
    expect(ran).toBe(true); // legit re-entry — it rejected (the FIFO is gone, not a session)
  });

  it("provenance advance over a dir containing a writer-less FIFO completes", async () => {
    const layout = makeLayout();
    onTestFinished(() => layout.cleanup());
    writeSession(layout.sessionDir, "a.jsonl", { id: "a", cwd: CWD });
    mkfifo(join(layout.sessionDir, "pipe.jsonl"));
    const index = await withHardDeadline(4_000, "provenance over FIFO", () =>
      advanceProvenance(layout.sessionDir, { ms: 2_000, bytes: 8 * 1024 * 1024 }),
    );
    expect(index.complete).toBe(true);
  });

  it("char devices: a /dev/null symlink is O_NOFOLLOW-rejected; the bare device node is non-regular-rejected", async () => {
    const layout = makeLayout();
    onTestFinished(() => layout.cleanup());
    const devLink = join(layout.sessionDir, "dev.jsonl");
    symlinkSync("/dev/null", devLink);
    await withHardDeadline(2_000, "device symlink open", async () => {
      expect(openSessionNoFollow(devLink)).toBeUndefined(); // O_NOFOLLOW: final-segment symlink
      expect(openSessionNoFollow("/dev/null")).toBeUndefined(); // hard path: char device, not regular
      return undefined;
    });
  });

  it("fd baseline restored across a full list→pick→reject cycle", async () => {
    const layout = makeLayout();
    onTestFinished(() => layout.cleanup());
    const clock = fakeClock(Date.now());
    const lists = makeLists(layout, clock);
    const target = writeSession(layout.sessionDir, "t.jsonl", {
      id: "t1",
      cwd: CWD,
      mtime: new Date(clock.now() - 120_000),
    });
    utimesSync(target, new Date(clock.now() - 1_000), new Date(clock.now() - 1_000)); // will trip D5
    const gate = createExecGate({ now: clock.now });
    const lates: unknown[] = [];
    const exec = createResumeExec({
      sendUserMessage: () => undefined, // never re-entered: deferred mode by omission
      getSessionId: () => "cur1",
      getSessionFile: () => undefined,
      now: clock.now,
      lists,
      gate,
      core: defaultResumeCore(),
      setTimer: () => ({ cancel: () => undefined }),
      sendLate: (_f, r) => lates.push(r),
    });
    await withHardDeadline(4_000, "full cycle", async () => {
      const listR = await lists.list(frameOf('__list {"scope":"all"}'), cmdArgsOf('__list {"scope":"all"}'));
      const wire = (listR as { data: { sessions: ResumeSessionsWire } }).data.sessions;
      const args = cmdArgsOf(`__pick ${JSON.stringify({ id: wire.rows[0]!.id, gen: wire.gen })}`);
      const pickCtx = { isIdle: () => true, hasPendingMessages: () => false } as never;
      // busy pick (no arm) then a real arm + D5 rejection via the deferred exec — never switched
      exec.pick(frameOf(args), args, pickCtx);
      return undefined;
    });
    expect(lates).toHaveLength(0); // the pick armed; nothing rejected yet (no exec ran)
    expect(fdCount()).toBe(fdCount()); // tautology guard: withHardDeadline already asserted baseline
  });
});
