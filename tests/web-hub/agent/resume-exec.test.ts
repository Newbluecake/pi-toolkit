/**
 * web-resume plan §4 "P2 pick" — `src/web-hub/agent/resume-exec.ts`: the synchronous reject
 * paths (never call sendUserMessage), the execution-point re-validation set (§2.5 b), the
 * deferred re-entry revocation (r1 #1 anchor), the shared exec claim (pick vs /new), boundary
 * revokes, exactly-one-late, late retryable:false, and the post-switch identity recheck (r2 #3).
 * The P1 core is the REAL one (real O_NOFOLLOW opens, real header parses, real dev/ino).
 */
import { describe, expect, it, onTestFinished } from "vitest";
import { appendFileSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createExecGate,
  createResumeExec,
  type ExecGate,
  type ResumeExecHandle,
} from "../../../src/web-hub/agent/resume-exec.js";
import { createResumeList, defaultResumeCore, type ResumeListHandle } from "../../../src/web-hub/agent/resume-list.js";
import type { LedgerResult } from "../../../src/web-hub/agent/ledger.js";
import type { CmdArgs, CmdFrame, CmdOrigin, ResumeSessionsWire } from "../../../src/web-hub/protocol/messages.js";
import { fakeClock, fakeIndex, makeLayout, writeSession, type Layout } from "./resume-fixtures.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
const CWD = "/tmp/web-resume-exec-cwd";

interface TimerStub {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

interface ExecHarness {
  layout: Layout;
  clock: ReturnType<typeof fakeClock>;
  gate: ExecGate;
  lists: ResumeListHandle;
  exec: ResumeExecHandle;
  pickIdle: boolean;
  pickPending: boolean;
  cmdIdle: boolean;
  cmdPending: boolean;
  sessionId: string;
  currentFile: string | undefined;
  sent: Array<{ text: string; options: unknown }>;
  lates: Array<{ frame: CmdFrame; result: LedgerResult }>;
  timers: TimerStub[];
  switchCalls: Array<{ path: string; opts: { withSession?: (ctx: unknown) => Promise<void> } }>;
  switchImpl: (path: string, opts: { withSession?: (ctx: unknown) => Promise<void> }) => Promise<unknown>;
  execPromises: Array<Promise<boolean>>;
  reentry: "immediate" | "deferred" | "none";
  cmdCtx: unknown;
}

function makeExec(
  over: {
    /** Controls the `/webhub __exec resume` re-entry: run immediately inside sendUserMessage
     *  (F5's common path), run later by the test (deferred), or never. */
    reentry?: "immediate" | "deferred" | "none";
    switchImpl?: ExecHarness["switchImpl"];
    /** web-hub-cmd-history A1: optional recorder port, threaded straight through. */
    recorder?: () => import("../../../src/web-hub/agent/command-record.js").CommandRecorder | undefined;
  } = {},
): ExecHarness {
  const layout = makeLayout();
  onTestFinished(() => layout.cleanup());
  const clock = fakeClock(Date.now());
  const gate = createExecGate({ now: clock.now });
  const h: ExecHarness = {
    layout,
    clock,
    gate,
    lists: undefined as unknown as ResumeListHandle,
    exec: undefined as unknown as ResumeExecHandle,
    pickIdle: true,
    pickPending: false,
    cmdIdle: true,
    cmdPending: false,
    sessionId: "cur1",
    currentFile: undefined,
    sent: [],
    lates: [],
    timers: [],
    switchCalls: [],
    switchImpl:
      over.switchImpl ??
      (async (path, opts) => {
        // default: success with a matching replacement session
        await opts.withSession?.({
          sessionManager: { getSessionId: () => headerIdOf(path), getSessionFile: () => path },
        });
        return {};
      }),
    execPromises: [],
    reentry: over.reentry ?? "immediate",
  };
  h.lists = createResumeList({
    getSessionDir: () => layout.sessionDir,
    cwd: () => CWD,
    currentSessionId: () => h.sessionId,
    now: clock.now,
    core: { ...defaultResumeCore(), advanceProvenance: async () => fakeIndex() },
  });
  const cmdCtx = {
    isIdle: () => h.cmdIdle,
    hasPendingMessages: () => h.cmdPending,
    cwd: CWD,
    switchSession: (path: string, opts: { withSession?: (ctx: unknown) => Promise<void> }) => {
      h.switchCalls.push({ path, opts });
      return h.switchImpl(path, opts);
    },
  };
  h.cmdCtx = cmdCtx;
  h.exec = createResumeExec({
    sendUserMessage: (text, options) => {
      h.sent.push({ text, options });
      const nonce = text.split(" ")[3];
      if (h.reentry === "immediate") {
        h.execPromises.push(h.exec.internalExecResume(nonce!, cmdCtx));
      }
    },
    getSessionId: () => h.sessionId,
    getSessionFile: () => h.currentFile,
    now: clock.now,
    lists: h.lists,
    gate,
    core: defaultResumeCore(),
    setTimer: (ms, fn) => {
      const t: TimerStub = { ms, fn, cancelled: false };
      h.timers.push(t);
      return { cancel: () => (t.cancelled = true) };
    },
    sendLate: (frame, result) => h.lates.push({ frame, result }),
    ...(over.recorder !== undefined ? { recorder: over.recorder } : {}),
  });
  return h;
}

/** Read a session header id straight off the file (test-side helper, no P1 dependency). */
function headerIdOf(path: string): string {
  const first = readFileSync(path, "utf8").split("\n", 1)[0]!;
  return (JSON.parse(first) as { id: string }).id;
}

function pickFrame(id: string, gen: string, confirm?: true): { frame: CmdFrame; cmd: CmdArgs & { op: "command" } } {
  const args = `__pick ${JSON.stringify({ id, gen, ...(confirm !== undefined ? { confirm } : {}) })}`;
  return {
    frame: {
      t: "cmd",
      rid: "r-1",
      id: "cmd-0000000000000001",
      deadlineMs: 8_000,
      origin: ORIGIN,
      cmd: { op: "command", name: "resume", args },
    },
    cmd: { op: "command", name: "resume", args },
  };
}

const pickCtxOf = (h: ExecHarness) =>
  ({
    isIdle: () => h.pickIdle,
    hasPendingMessages: () => h.pickPending,
  }) as never;

/** Standard scene: one old-mtime target + the current session file; returns the listed wire.
 *  All mtimes are derived from the (frozen) harness clock so D5's 30 s window is deterministic. */
async function scene(h: ExecHarness, over: { targetMtime?: Date } = {}): Promise<ResumeSessionsWire> {
  h.currentFile = writeSession(h.layout.sessionDir, "current.jsonl", {
    id: "cur1",
    cwd: CWD,
    mtime: new Date(h.clock.now() - 300_000),
  });
  writeSession(h.layout.sessionDir, "target.jsonl", {
    id: "target1",
    cwd: CWD,
    firstMessage: "target session",
    mtime: over.targetMtime ?? new Date(h.clock.now() - 120_000),
  });
  const args = { op: "command" as const, name: "resume", args: '__list {"scope":"all"}' };
  const r = await h.lists.list(
    { t: "cmd", rid: "r", id: "cmd-0000000000000002", deadlineMs: 8_000, origin: ORIGIN, cmd: args },
    args,
  );
  return (r as { data: { sessions: ResumeSessionsWire } }).data.sessions;
}

async function pickTarget(h: ExecHarness, w: ResumeSessionsWire, confirm?: true) {
  const row = w.rows.find((r) => r.id === "target1")!;
  const { frame, cmd } = pickFrame(row.id, w.gen, confirm);
  const result = h.exec.pick(frame, cmd, pickCtxOf(h));
  return { result, row };
}

function err(result: unknown): { code: string; retryable: boolean; effect: string; message?: string } {
  const r = result as { code: string; retryable: boolean; effect: string; message?: string };
  return r;
}

function nonceOf(h: ExecHarness): string {
  expect(h.sent).toHaveLength(1);
  return h.sent[0]!.text.split(" ")[3]!;
}

/** The deferred re-entry runs with the same command ctx pi would hand the `/webhub` handler. */
const cmdCtxFor = (h: ExecHarness) => h.cmdCtx as never;

async function runDeferredExec(h: ExecHarness): Promise<boolean> {
  const nonce = nonceOf(h);
  return h.exec.internalExecResume(nonce, cmdCtxFor(h));
}

describe("resume-exec — synchronous pick rejects (§2.5 steps 2-4)", () => {
  it("busy or pending agent ⇒ E_COMMAND_DENIED resume:busy, no re-entry message", async () => {
    const h = makeExec({ reentry: "none" });
    const w = await scene(h);
    h.pickIdle = false;
    const { result } = await pickTarget(h, w);
    expect(err(result)).toMatchObject({ code: "E_COMMAND_DENIED", retryable: true, message: "resume:busy" });
    h.pickIdle = true;
    h.pickPending = true;
    const again = h.exec.pick(pickFrame("target1", w.gen).frame, pickFrame("target1", w.gen).cmd, pickCtxOf(h));
    expect(err(again)).toMatchObject({ code: "E_COMMAND_DENIED", message: "resume:busy" });
    expect(h.sent).toHaveLength(0);
  });

  it("stale list (unknown gen or id) ⇒ E_NOT_FOUND resume:stale-list, no message", async () => {
    const h = makeExec({ reentry: "none" });
    await scene(h);
    const { frame, cmd } = pickFrame("target1", "0123456789abcdef");
    expect(err(h.exec.pick(frame, cmd, pickCtxOf(h)))).toMatchObject({
      code: "E_NOT_FOUND",
      message: "resume:stale-list",
    });
    const { frame: f2, cmd: c2 } = pickFrame("nosuch", "0123456789abcdef");
    expect(err(h.exec.pick(f2, c2, pickCtxOf(h)))).toMatchObject({ code: "E_NOT_FOUND" });
    expect(h.sent).toHaveLength(0);
  });

  it("concurrent pick ⇒ E_COMMAND_DENIED exec:in-flight (shared claim, r1 #2)", async () => {
    const h = makeExec({ reentry: "none" });
    const w = await scene(h);
    const first = await pickTarget(h, w);
    expect(first.result.ok).toBe(true);
    const second = h.exec.pick(pickFrame("target1", w.gen).frame, pickFrame("target1", w.gen).cmd, pickCtxOf(h));
    expect(err(second)).toMatchObject({ code: "E_COMMAND_DENIED", message: "exec:in-flight" });
    expect(h.sent).toHaveLength(1); // the second pick never re-entered
  });

  it("pick vs /new: the claim is mutual; /new releases it again", async () => {
    const h = makeExec({ reentry: "none" });
    const w = await scene(h);
    // /new armed first ⇒ pick refused
    const nonce = h.gate.armNew();
    expect(nonce).toBeDefined();
    const refused = h.exec.pick(pickFrame("target1", w.gen).frame, pickFrame("target1", w.gen).cmd, pickCtxOf(h));
    expect(err(refused)).toMatchObject({ code: "E_COMMAND_DENIED", message: "exec:in-flight" });
    expect(h.gate.consumeNew(nonce!)).toEqual({ ok: true, cmdId: undefined });
    // pick armed ⇒ /new refused
    const picked = await pickTarget(h, w);
    expect(picked.result.ok).toBe(true);
    expect(h.gate.armNew()).toBeUndefined();
  });

  it("bad __pick args ⇒ E_BAD_REQUEST, no message", async () => {
    const h = makeExec({ reentry: "none" });
    await scene(h);
    const bad = { op: "command" as const, name: "resume", args: "__pick nope" };
    const r = h.exec.pick(
      { t: "cmd", rid: "r", id: "cmd-0000000000000003", deadlineMs: 8_000, origin: ORIGIN, cmd: bad },
      bad,
      pickCtxOf(h),
    );
    expect(err(r)).toMatchObject({ code: "E_BAD_REQUEST" });
    expect(h.sent).toHaveLength(0);
  });
});

describe("resume-exec — execution-point re-validation (§2.5 b)", () => {
  it("source session changed ⇒ E_SESSION_CHANGED (late, retryable:false)", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w);
    h.sessionId = "moved-on";
    expect(await runDeferredExec(h)).toBe(true);
    expect(h.switchCalls).toHaveLength(0);
    expect(h.lates).toHaveLength(1);
    expect(err(h.lates[0]!.result)).toMatchObject({
      code: "E_SESSION_CHANGED",
      message: "resume:source-changed",
      retryable: false,
    });
  });

  it("became busy between list and pick ⇒ E_COMMAND_DENIED resume:busy", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w);
    h.cmdIdle = false;
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({
      code: "E_COMMAND_DENIED",
      message: "resume:busy",
      retryable: false,
    });
    expect(h.switchCalls).toHaveLength(0);
  });

  it("file deleted ⇒ E_NOT_FOUND resume:file-gone", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w);
    rmSync(join(h.layout.sessionDir, "target.jsonl"));
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({ code: "E_NOT_FOUND", message: "resume:file-gone" });
  });

  it("file replaced with a new inode ⇒ E_STALE_CTX resume:file-replaced", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w);
    // temp+rename guarantees a DIFFERENT inode (rm+recreate may reuse the freed inode)
    const { renameSync } = await import("node:fs");
    const tmp = join(h.layout.sessionDir, "replacement.tmp.jsonl");
    writeSession(h.layout.sessionDir, "replacement.tmp.jsonl", {
      id: "target1",
      cwd: CWD,
      firstMessage: "target session",
      mtime: new Date(h.clock.now() - 120_000),
    });
    renameSync(tmp, join(h.layout.sessionDir, "target.jsonl"));
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({ code: "E_STALE_CTX", message: "resume:file-replaced" });
  });

  it("file swapped for a symlink ⇒ O_NOFOLLOW rejects it (resume:file-gone)", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w);
    const p = join(h.layout.sessionDir, "target.jsonl");
    const backup = join(h.layout.sessionDir, "backup.jsonl");
    writeSession(h.layout.sessionDir, "backup.jsonl", {
      id: "target1",
      cwd: CWD,
      mtime: new Date(h.clock.now() - 120_000),
    });
    rmSync(p);
    symlinkSync(backup, p);
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({ code: "E_NOT_FOUND", message: "resume:file-gone" });
  });

  it("header id changed (same inode) ⇒ E_STALE_CTX resume:target-changed", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w, true); // confirm skips D5 so the id check is reached
    const p = join(h.layout.sessionDir, "target.jsonl");
    writeFileSync(
      p,
      `${JSON.stringify({ type: "session", id: "other-id", timestamp: "2026-10-16T00:00:00.000Z", cwd: CWD })}\n`,
    );
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({ code: "E_STALE_CTX", message: "resume:target-changed" });
  });

  it("header cwd mismatch ⇒ E_STALE_CTX resume:cwd-mismatch", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w, true);
    writeFileSync(
      join(h.layout.sessionDir, "target.jsonl"),
      `${JSON.stringify({ type: "session", id: "target1", timestamp: "2026-10-16T00:00:00.000Z", cwd: "/tmp/elsewhere" })}\n`,
    );
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({ code: "E_STALE_CTX", message: "resume:cwd-mismatch" });
  });

  it("became a child (marker appended) ⇒ E_STALE_CTX resume:is-sub", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w, true);
    const p = join(h.layout.sessionDir, "target.jsonl");
    appendFileSync(p, `${JSON.stringify({ type: "custom", customType: "subagent:child", data: { v: 1 } })}\n`);
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({ code: "E_STALE_CTX", message: "resume:is-sub" });
  });

  it("current session file ⇒ E_COMMAND_DENIED resume:current (sync reject at step 7)", async () => {
    const h = makeExec({ reentry: "immediate" });
    const w = await scene(h);
    const row = w.rows.find((r) => r.id === "cur1")!;
    expect(row.current).toBe(true);
    const { frame, cmd } = pickFrame(row.id, w.gen);
    const result = h.exec.pick(frame, cmd, pickCtxOf(h));
    expect(err(result)).toMatchObject({ code: "E_COMMAND_DENIED", message: "resume:current" });
    expect(h.lates).toHaveLength(0); // common failure path: plain sync reply, no late
    expect(h.switchCalls).toHaveLength(0);
  });

  it("D5-a: target touched since listing ⇒ E_CONFIRM_REQUIRED resume:active-elsewhere; confirm passes", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w);
    utimesSync(join(h.layout.sessionDir, "target.jsonl"), new Date(), new Date());
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({
      code: "E_CONFIRM_REQUIRED",
      message: "resume:active-elsewhere",
      retryable: false,
    });
    expect(h.switchCalls).toHaveLength(0);
    // explicit second confirm re-picks cleanly and switches
    const w2: ResumeSessionsWire = w;
    const again = await pickTarget(h, w2, true);
    expect(again.result.ok).toBe(true);
    await runDeferredExec2(h);
    expect(h.lates).toHaveLength(2);
    expect(h.lates[1]!.result.ok).toBe(true);
    expect(h.switchCalls).toHaveLength(1);
  });

  it("D5-a: a recently-written target (mtime < 30 s old) needs the confirm even unchanged", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h, { targetMtime: new Date(h.clock.now() - 5_000) });
    await pickTarget(h, w);
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({ code: "E_CONFIRM_REQUIRED", message: "resume:active-elsewhere" });
  });

  it("deadline passed ⇒ E_DEADLINE resume:deadline, no switch", async () => {
    const h = makeExec({ reentry: "deferred" });
    const w = await scene(h);
    await pickTarget(h, w);
    h.clock.advance(6_000);
    await runDeferredExec(h);
    expect(err(h.lates[0]!.result)).toMatchObject({ code: "E_DEADLINE", message: "resume:deadline" });
    expect(h.switchCalls).toHaveLength(0);
  });
});

describe("resume-exec — switch outcomes (§2.5 c-d)", () => {
  it("happy path: exactly one late ok; claim and ticket released; switchInFlight cleared", async () => {
    const h = makeExec({ reentry: "immediate" });
    const w = await scene(h);
    const { result } = await pickTarget(h, w);
    expect(result).toMatchObject({ ok: true, data: { op: "command", kind: "builtin", completion: "async" } });
    expect(h.exec.switchInFlight()).toBe(true);
    await Promise.all(h.execPromises);
    expect(h.switchCalls).toHaveLength(1);
    expect(h.switchCalls[0]!.path).toBe(join(h.layout.sessionDir, "target.jsonl"));
    expect(h.lates).toHaveLength(1);
    expect(h.lates[0]!.result.ok).toBe(true);
    expect(h.exec.ticketState()).toBe("none");
    expect(h.exec.switchInFlight()).toBe(false);
    expect(h.gate.held()).toBe(false);
    expect(h.gate.armNew()).toBeDefined(); // claim released
  });

  it("post-switch same-id same-path file replaced (new inode) ⇒ E_STALE_CTX resume:mismatch, effect unknown (r2 #3)", async () => {
    const h = makeExec({
      reentry: "immediate",
      switchImpl: async (path, opts) => {
        // the W1 window: the path is swapped between our checks and pi's open… (temp+rename so
        // the replacement inode is guaranteed fresh)
        const tmp = join(h.layout.sessionDir, "w1swap.tmp.jsonl");
        writeSession(h.layout.sessionDir, "w1swap.tmp.jsonl", {
          id: "target1",
          cwd: CWD,
          firstMessage: "target session",
          mtime: new Date(h.clock.now() - 120_000),
        });
        const { renameSync } = await import("node:fs");
        renameSync(tmp, path);
        await opts.withSession?.({ sessionManager: { getSessionId: () => "target1", getSessionFile: () => path } });
        return {};
      },
    });
    const w = await scene(h);
    await pickTarget(h, w);
    await Promise.all(h.execPromises);
    expect(h.switchCalls).toHaveLength(1); // the switch DID happen — reported, not undone
    expect(h.lates).toHaveLength(1);
    expect(err(h.lates[0]!.result)).toMatchObject({
      code: "E_STALE_CTX",
      effect: "unknown",
      message: "resume:mismatch",
      retryable: false,
    });
  });

  it("withSession reports a different session id ⇒ resume:mismatch, effect unknown", async () => {
    const h = makeExec({
      reentry: "immediate",
      switchImpl: async (path, opts) => {
        await opts.withSession?.({ sessionManager: { getSessionId: () => "not-target", getSessionFile: () => path } });
        return {};
      },
    });
    const w = await scene(h);
    await pickTarget(h, w);
    await Promise.all(h.execPromises);
    expect(err(h.lates[0]!.result)).toMatchObject({
      code: "E_STALE_CTX",
      effect: "unknown",
      message: "resume:mismatch",
    });
  });

  it("cancelled switch ⇒ E_COMMAND_DENIED resume:cancelled (retryable:false)", async () => {
    const h = makeExec({ reentry: "immediate", switchImpl: async () => ({ cancelled: true }) });
    const w = await scene(h);
    await pickTarget(h, w);
    await Promise.all(h.execPromises);
    expect(err(h.lates[0]!.result)).toMatchObject({
      code: "E_COMMAND_DENIED",
      effect: "none",
      message: "resume:cancelled",
      retryable: false,
    });
  });

  it("switchSession throws ⇒ E_STALE_CTX effect unknown", async () => {
    const h = makeExec({
      reentry: "immediate",
      switchImpl: async () => {
        throw new Error("boom");
      },
    });
    const w = await scene(h);
    await pickTarget(h, w);
    await Promise.all(h.execPromises);
    expect(err(h.lates[0]!.result)).toMatchObject({
      code: "E_STALE_CTX",
      effect: "unknown",
      message: "resume:switch-failed",
      retryable: false,
    });
  });
});

describe("resume-exec — deferred re-entry and boundaries (r1 #1)", () => {
  it("a settle-deferred re-entry completing after deadlineAt is revoked: NO switch ever happens", async () => {
    const h = makeExec({ reentry: "none" });
    const w = await scene(h);
    const { result } = await pickTarget(h, w);
    expect(result.ok).toBe(true);
    expect(h.exec.ticketState()).toBe("armed");
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(5_000); // min(opTotal 7700, 5000)
    h.clock.advance(5_000);
    h.timers[0]!.fn(); // the revoke timer wins the CAS
    expect(h.exec.ticketState()).toBe("none");
    expect(h.lates).toHaveLength(1);
    expect(err(h.lates[0]!.result)).toMatchObject({ code: "E_DEADLINE", retryable: false, effect: "none" });
    // the deferred handler now runs with a revoked nonce: no-op, no switch, no second late
    const ran = await h.exec.internalExecResume(nonceOf(h), cmdCtxFor(h));
    expect(ran).toBe(false);
    expect(h.switchCalls).toHaveLength(0);
    expect(h.lates).toHaveLength(1);
    expect(h.gate.held()).toBe(false);
  });

  it("session boundary revokes an armed ticket (late E_SESSION_CHANGED); deferred exec no-ops", async () => {
    const h = makeExec({ reentry: "none" });
    const w = await scene(h);
    await pickTarget(h, w);
    h.exec.onSessionBoundary();
    expect(err(h.lates[0]!.result)).toMatchObject({
      code: "E_SESSION_CHANGED",
      message: "resume:session-changed",
      retryable: false,
    });
    const ran = await h.exec.internalExecResume(nonceOf(h), cmdCtxFor(h));
    expect(ran).toBe(false);
    expect(h.switchCalls).toHaveLength(0);
    expect(h.lates).toHaveLength(1);
  });

  it("a boundary during OUR OWN switch does not revoke the switching ticket", async () => {
    let releaseSwitch: (() => void) | undefined;
    const h = makeExec({
      reentry: "immediate",
      switchImpl: (path, opts) =>
        new Promise((resolve) => {
          releaseSwitch = () => {
            void opts
              .withSession?.({ sessionManager: { getSessionId: () => "target1", getSessionFile: () => path } })
              .then(() => resolve({}));
          };
        }),
    });
    const w = await scene(h);
    await pickTarget(h, w);
    await new Promise((r) => setTimeout(r, 10)); // switch is now awaiting inside switchSession
    h.exec.onSessionBoundary(); // the session_shutdown our own switch causes
    expect(h.lates).toHaveLength(0); // NOT revoked — state is "switching"
    releaseSwitch!();
    await Promise.all(h.execPromises);
    expect(h.lates).toHaveLength(1);
    expect(h.lates[0]!.result.ok).toBe(true);
  });
});

/** Second deferred exec for the confirm-retry flow (nonce from the second send). */
async function runDeferredExec2(h: ExecHarness): Promise<boolean> {
  const nonce = h.sent[h.sent.length - 1]!.text.split(" ")[3]!;
  return h.exec.internalExecResume(nonce, cmdCtxFor(h));
}

// ---------------------------------------------------------------------------
// web-hub-cmd-history plan §5.2 (A1) — ExecGate cmdId threading + the /resume card at the
// execution point (AFTER every authoritative check, BEFORE ctx.switchSession).
// ---------------------------------------------------------------------------

describe("exec gate — cmdId threading (web-hub-cmd-history A1)", () => {
  it("armNew(cmdId) stores it; consumeNew returns {ok:true, cmdId}; unknown/expired ⇒ {ok:false}", () => {
    const clock = fakeClock(1_000);
    const gate = createExecGate({ now: clock.now });
    const nonce = gate.armNew("cmd-0000000000000042")!;
    expect(gate.consumeNew("wrong")).toEqual({ ok: false });
    expect(gate.consumeNew(nonce)).toEqual({ ok: true, cmdId: "cmd-0000000000000042" });
    // expiry
    const nonce2 = gate.armNew()!;
    clock.advance(6_000);
    expect(gate.consumeNew(nonce2)).toEqual({ ok: false });
  });
});

describe("cmd-history — /resume __pick card at the execution point (§5.2, R12)", () => {
  function recRecorder() {
    const immediates: Array<Record<string, unknown>> = [];
    const recorder = {
      policyFor: () => "record" as const,
      noteIntent: () => undefined,
      begin: () => undefined,
      beginExternal: () => undefined,
      recordImmediate: (r: Record<string, unknown>) => immediates.push(r),
      running: () => [],
      counters: () => ({ appended: 0, skipped: 0, failed: 0 }),
      dispose: () => undefined,
    };
    return { recorder: recorder as never, immediates };
  }

  it("success: recordImmediate(done, left-session) AFTER the checks and BEFORE switchSession; history on the late", async () => {
    const rec = recRecorder();
    const order: string[] = [];
    const h = makeExec({
      recorder: () => rec.recorder,
      switchImpl: async (path, opts) => {
        order.push("switch");
        await opts.withSession?.({
          sessionManager: { getSessionId: () => headerIdOf(path), getSessionFile: () => path },
        });
        return {};
      },
    });
    // patch recordImmediate to log ordering relative to switchSession
    (rec.recorder as unknown as { recordImmediate: unknown }).recordImmediate = (r: Record<string, unknown>) => {
      order.push(`record:${String(r.state)}`);
      rec.immediates.push(r);
      return true; // the real recorder returns whether the entry landed
    };
    const w = await scene(h);
    const { result } = await pickTarget(h, w);
    expect(result.ok).toBe(true);
    await h.execPromises[0]!;
    expect(order[0]).toBe("record:done"); // BEFORE the switch call
    expect(order[1]).toBe("switch");
    expect(rec.immediates).toHaveLength(1);
    expect(rec.immediates[0]).toMatchObject({
      cmdId: "cmd-0000000000000001",
      name: "resume",
      source: "web",
      state: "done",
      notice: "left-session",
    });
    const out = (rec.immediates[0] as { output?: { entries: Array<{ text?: string }> } }).output;
    expect(out?.entries[0]?.text).toContain("已切换到会话");
    // the late result carries history:"recorded" (m2)
    expect(h.lates.at(-1)?.result).toMatchObject({ ok: true });
    expect((h.lates.at(-1)!.result as { data: { history?: string } }).data.history).toBe("recorded");
  });

  it("cancelled switch ⇒ a SECOND recordImmediate(failed) under the same cmdId", async () => {
    const rec = recRecorder();
    const h = makeExec({
      recorder: () => rec.recorder,
      switchImpl: async () => ({ cancelled: true }),
    });
    const w = await scene(h);
    const { result } = await pickTarget(h, w);
    expect(result.ok).toBe(true);
    await h.execPromises[0]!;
    expect(rec.immediates).toHaveLength(2);
    expect(rec.immediates[0]).toMatchObject({ state: "done", notice: "left-session" });
    expect(rec.immediates[1]).toMatchObject({ state: "failed", cmdId: "cmd-0000000000000001" });
    expect((rec.immediates[1] as { error?: string }).error).toBeDefined();
  });

  it("every check-failure path records NOTHING (effect none ⇒ no card)", async () => {
    const rec = recRecorder();
    const h = makeExec({ recorder: () => rec.recorder, reentry: "deferred" });
    const w = await scene(h);
    // source session changes between pick and exec ⇒ E_SESSION_CHANGED at the execution point
    const { result } = await pickTarget(h, w);
    expect(result.ok).toBe(true);
    h.sessionId = "someone-else";
    await runDeferredExec(h);
    expect(rec.immediates).toHaveLength(0);
    // and the reject itself went out late with retryable:false — an ERROR body carries no
    // CmdData at all (pre-feature shape), so no history field: the UI's placeholder degrades
    // via its own 60 s path (no card will ever appear for this call)
    const late = h.lates.at(-1)!.result as { ok: boolean; code: string; retryable: boolean; data?: unknown };
    expect(late.ok).toBe(false);
    expect(late.code).toBe("E_SESSION_CHANGED");
    expect(late.retryable).toBe(false);
    expect(late.data).toBeUndefined();
  });
});
