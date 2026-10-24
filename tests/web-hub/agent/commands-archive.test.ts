/**
 * web-hub archive plan — the `archive` cmd op through the real createCommandHandler: ok /
 * not_terminal / unsupported paths, ledger dedupe (same id replays the SAME result with
 * dup:true), and that a real mutation fires onChanged (the immediate status republish).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import { ArchiveControl } from "../../../src/archive/control.js";
import type { RunSnapshot } from "../../../src/core/types.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi } from "./helpers.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
beforeEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);
afterEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };

function frame(id: string, cmd: CmdFrame["cmd"]): CmdFrame {
  return { t: "cmd", rid: `r-${id}`, id, deadlineMs: 8000, origin: ORIGIN, cmd };
}

function runSnap(status: string, updatedAt = 1000): RunSnapshot {
  return {
    runId: "r-1",
    generation: 1,
    status,
    phase: "settled",
    deadlines: {},
    diag: { createdAt: 0, phase: "settled", phaseEnteredAt: 0, escalation: [] },
    updatedAt,
  } as unknown as RunSnapshot;
}

function makeHarness(runs: readonly RunSnapshot[] = [], withControl = true) {
  const { pi } = fakePi();
  const { ctx } = fakeCtx({ mode: "tui" });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const onChanged = vi.fn();
  const control = new ArchiveControl(
    { runs: () => runs, bashJobs: () => [] },
    { appendEntry: () => undefined, now: () => 1_000_000 },
  );
  const deps: CommandHandlerDeps = {
    pi,
    getCtx: () => ctx,
    getSessionId: () => "s1",
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror(),
    compactionState: {
      get manualCompacting() {
        return false;
      },
      dispose() {},
    } as unknown as CommandHandlerDeps["compactionState"],
    originEntry: { appendOrigin: () => {}, notify: () => {}, dispose: () => {} },
    builtinBridge: {
      execute: () => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" }),
      isQuiet: () => false,
    } as unknown as CommandHandlerDeps["builtinBridge"],
    controlEnabled: () => true,
    now: () => 1_000_000,
    send: (f) => sent.push(f),
    onChanged,
    setTimer: () => ({ cancel: () => {} }),
    ...(withControl ? { archive: () => control } : {}),
  };
  return { handler: createCommandHandler(deps), sent, onChanged, control: control as ArchiveControl };
}

describe("cmd op `archive`", () => {
  it("archives a terminal run: ok + changed + immediate onChanged", () => {
    const h = makeHarness([runSnap("completed")]);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "archive" }));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      ok: true,
      data: { op: "archive", set: "archive", changed: true },
    });
    // settleAndReply's own onChanged = the immediate status republish.
    expect(h.onChanged).toHaveBeenCalledTimes(1);
  });

  it("refuses a running run with E_BAD_REQUEST and no onChanged", () => {
    const h = makeHarness([runSnap("running")]);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "archive" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_BAD_REQUEST", retryable: false });
    expect(h.onChanged).toHaveBeenCalledTimes(1); // the settle's republish only — no mutation
  });

  it("unarchive of a not-archived item is ok with changed:false (idempotent)", () => {
    const h = makeHarness([runSnap("completed")]);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "unarchive" }));
    expect(h.sent[0]).toMatchObject({ ok: true, data: { op: "archive", set: "unarchive" } });
    expect((h.sent[0] as { data: { changed?: boolean } }).data.changed).toBeUndefined();
  });

  it("settles E_UNSUPPORTED when no archive control is wired", () => {
    const h = makeHarness([runSnap("completed")], false);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "archive" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_UNSUPPORTED", retryable: false });
  });

  it("same cmdId replays the same result with dup:true (ledger dedupe)", () => {
    const h = makeHarness([runSnap("completed")]);
    const f = frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "archive" });
    h.handler.handle(f);
    h.handler.handle(f);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ ok: true, dup: true, data: { op: "archive", set: "archive", changed: true } });
  });
});
