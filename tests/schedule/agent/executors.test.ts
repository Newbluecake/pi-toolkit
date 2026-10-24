/**
 * `installScheduleExecutors` handoff adapter (I1 review r1 #5): a handoff's terminal callback may fire more than once
 * from the dispatcher's point of view; the adapter turns `dropped`/`unknown` into exactly ONE quiet recap per handoff
 * (same noteId), and hands the source run's claim time to A2 for the revocation-generation check (#3).
 */
import { describe, expect, it, vi } from "vitest";

const captured: { notes?: any } = {};
vi.mock("../../../src/schedule/agent/bg.js", () => ({
  installBackgroundExecutor: (_schedule: unknown, deps: { notes: unknown }) => {
    captured.notes = deps.notes;
    return { dispose: () => undefined, notes: {} };
  },
}));

const { installScheduleExecutors, recapOf } = await import("../../../src/schedule/agent/executors.js");

function setup() {
  const sent: Array<{ message: any; options: any }> = [];
  const inputs: any[] = [];
  const pi = { sendMessage: (message: any, options: any) => void sent.push({ message, options }) };
  const ctx = { sessionManager: { getSessionId: () => "sid-1", getSessionFile: () => "/x" }, isIdle: () => true };
  const schedule = {
    mode: { arm: true },
    holder: { pid: 1 },
    sessionId: "sid-1",
    isDisposed: () => false,
  };
  const message = {
    attach: () => undefined,
    enqueueHandoff: (input: unknown) => {
      inputs.push(input);
      return true;
    },
  };
  installScheduleExecutors(pi as never, ctx as never, schedule as never, {
    message: message as never,
    spawn: {} as never,
  });
  const result = {
    content: "report\n请接手处理。",
    details: { kind: "handoff", noteId: "note-1", runKey: "t@1" },
  };
  captured.notes.handoff({
    run: { runKey: "t@1", defHash: "h", startedAt: 1234 },
    task: { id: "t" },
    message: result,
  });
  return { sent, input: inputs[0] };
}

describe("installScheduleExecutors handoff adapter", () => {
  it("passes the source run's claim time and defHash to the dispatcher", () => {
    const { input } = setup();
    expect(input).toMatchObject({ defHash: "h", startedAt: 1234, noteId: "note-1", taskId: "t" });
  });

  it("dropped → ONE quiet recap with the same noteId, however many terminal callbacks arrive", () => {
    const { sent, input } = setup();
    input.onEnd({ kind: "dropped", reason: "coalesced" });
    input.onEnd({ kind: "dropped", reason: "task-changed" });
    input.onEnd({ kind: "unknown", reason: "owner-closed" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toEqual({ triggerTurn: false });
    expect(sent[0]!.message.details).toMatchObject({ kind: "handoff-recap", noteId: "note-1" });
    expect(sent[0]!.message.content).not.toContain("请接手处理");
  });

  it("continued / settled never write a recap", () => {
    const { sent, input } = setup();
    input.onEnd({ kind: "continued" });
    input.onEnd({ kind: "settled", text: "x", merged: false, runMax: false });
    expect(sent).toHaveLength(0);
  });

  it("recapOf keeps the noteId and drops only the take-over tail", () => {
    const r = recapOf({ content: "a\n请接手处理。", details: { kind: "handoff", noteId: "n" } } as never);
    expect(r.content).toBe("a");
    expect(r.details).toMatchObject({ kind: "handoff-recap", noteId: "n" });
  });
});
