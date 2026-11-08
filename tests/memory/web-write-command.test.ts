import { describe, expect, it } from "vitest";
import { executeConfirmedMemoryWrite } from "../../src/memory/command.js";
import { createCommandConfirmKernel, type CommandClock, type MemoryWebCall } from "../../src/memory/command-confirm.js";
import type { AskUserRemotePort, RemoteOutcome } from "../../src/ask-user/remote.js";
import type { FrozenPlan, SessionWebOutcome } from "../../src/memory/scopes/session-store.js";
import type { MemoryWriteRequest } from "../../src/memory/command-policy.js";

class ManualClock implements CommandClock {
  time = 0;
  timers = new Map<object, { at: number; fn: () => void }>();
  now() {
    return this.time;
  }
  setTimer(ms: number, fn: () => void) {
    const key = {};
    this.timers.set(key, { at: this.time + ms, fn });
    return key;
  }
  clearTimer(key: unknown) {
    this.timers.delete(key as object);
  }
  advance(ms: number) {
    this.time += ms;
    for (const [key, timer] of [...this.timers])
      if (timer.at <= this.time) {
        this.timers.delete(key);
        timer.fn();
      }
  }
}

/** A real kernel with a bound call + a minted receipt, plus a fake store. */
function harness() {
  const clock = new ManualClock();
  let callback: ((outcome: RemoteOutcome) => boolean) | undefined;
  let affirmative = "";
  const remote: AskUserRemotePort = {
    open(req) {
      affirmative = req.questions[0]!.options[1]!.label;
      return {
        setOnRemote(fn) {
          callback = fn;
        },
        close() {},
      };
    },
  };
  const manager = {};
  const owner = { incarnation: {}, sid: "session-1", sessionEpoch: 1, branchGen: 2 };
  const signal = new AbortController();
  const kernel = createCommandConfirmKernel({ channel: { kind: "web", remote }, clock, isOwnerCurrent: () => true });
  const binding = {
    cmdId: "cmd-1",
    commandOwner: "activation",
    operationGeneration: 1,
    owner,
    manager,
    deadline: 1_000_000,
    signal: signal.signal,
    current: () => true,
  };
  const call = kernel.start("session add hello", binding)!;
  const commandPlan = { rawArgs: "session add hello", step: 0, manifest: "m", presentation: "p" };
  const request: MemoryWriteRequest = { kind: "session.add", rawArgs: "session add hello", text: "hello" };
  const plan = {
    kind: "session.add",
    commandPlan,
  } as unknown as FrozenPlan;
  const store = {
    ownsWebPlan: (_c: MemoryWebCall, _p: FrozenPlan) => true,
    enqueueConfirmedCommand: (_c: MemoryWebCall, _p: FrozenPlan, _r: unknown) =>
      Promise.resolve({
        ok: true,
        effect: "completed",
        id: "n1",
        persistence: "memory-only",
        message: "ok",
      } as SessionWebOutcome),
  };
  const deliver = (value: string) =>
    callback!({ kind: "answer", answers: { MEMCMD: value }, origin: "test", originKind: "lan" });
  return { kernel, call, request, plan, store, deliver, affirm: () => affirmative };
}

describe("executeConfirmedMemoryWrite gate (§5.2)", () => {
  it("refuses a call with no live binding or a stale owner", async () => {
    const h = harness();
    const foreignCall = {} as MemoryWebCall;
    const out = await executeConfirmedMemoryWrite(foreignCall, h.request, h.plan, {} as never, {
      kernel: h.kernel,
      currentOwnerMatches: () => true,
      store: h.store,
    });
    expect(out).toMatchObject({ ok: false, effect: "none", code: "E_MEM_NEEDS_HUMAN_COMMAND" });

    const stale = await executeConfirmedMemoryWrite(h.call, h.request, h.plan, {} as never, {
      kernel: h.kernel,
      currentOwnerMatches: () => false,
      store: h.store,
    });
    expect(stale).toMatchObject({ ok: false, effect: "none", code: "E_MEM_NEEDS_HUMAN_COMMAND" });
  });

  it("refuses a mismatched request or a plan the store does not own", async () => {
    const h = harness();
    const pending = h.kernel.confirm(h.call, (h.plan as FrozenPlan).commandPlan);
    h.deliver(h.affirm());
    const result = await pending;
    if (!result.approved) throw Error("expected approval");
    const receipt = result.receipt;

    const mismatch = await executeConfirmedMemoryWrite(
      h.call,
      { kind: "session.add", rawArgs: "session add other", text: "other" },
      h.plan,
      receipt,
      { kernel: h.kernel, currentOwnerMatches: () => true, store: h.store },
    );
    expect(mismatch).toMatchObject({ ok: false, effect: "none", code: "E_MEM_PLAN_CHANGED" });

    const next = harness();
    const nextPending = next.kernel.confirm(next.call, next.plan.commandPlan);
    next.deliver(next.affirm());
    const nextResult = await nextPending;
    if (!nextResult.approved) throw Error("expected approval");
    const notOwned = await executeConfirmedMemoryWrite(next.call, next.request, next.plan, nextResult.receipt, {
      kernel: next.kernel,
      currentOwnerMatches: () => true,
      store: { ...next.store, ownsWebPlan: () => false },
    });
    expect(notOwned).toMatchObject({ ok: false, effect: "none", code: "E_MEM_PLAN_CHANGED" });
  });

  it("refuses a stale receipt and delegates only a valid one to the store", async () => {
    const h = harness();
    const pending = h.kernel.confirm(h.call, (h.plan as FrozenPlan).commandPlan);
    h.deliver(h.affirm());
    const result = await pending;
    if (!result.approved) throw Error("expected approval");
    const receipt = result.receipt;

    // Before reserve, `check` must pass (minted receipt is valid), and the store is delegated to.
    let delegated: unknown[] | undefined;
    const store = {
      ownsWebPlan: () => true,
      enqueueConfirmedCommand: (...args: unknown[]) => {
        delegated = args;
        return Promise.resolve({
          ok: true,
          effect: "completed",
          id: "n1",
          persistence: "memory-only",
          message: "ok",
        } as SessionWebOutcome);
      },
    };
    const ok = await executeConfirmedMemoryWrite(h.call, h.request, h.plan, receipt, {
      kernel: h.kernel,
      currentOwnerMatches: () => true,
      store: store as never,
    });
    expect(ok).toMatchObject({ ok: true, effect: "completed" });
    expect(delegated).toHaveLength(3);
    expect(delegated![0]).toBe(h.call);
    expect(delegated![1]).toBe(h.plan);
    expect(delegated![2]).toBe(receipt);

    // A stale (already-consumed/foreign) receipt fails closed before the store.
    const consumed = await executeConfirmedMemoryWrite(h.call, h.request, h.plan, {} as never, {
      kernel: h.kernel,
      currentOwnerMatches: () => true,
      store: { ownsWebPlan: () => true, enqueueConfirmedCommand: () => Promise.reject(new Error("no")) },
    });
    expect(consumed).toMatchObject({ ok: false, effect: "none", code: "E_MEM_CONFIRM_STALE" });
  });

  it("maps an unexpected store rejection to unknown, never none", async () => {
    const h = harness();
    const pending = h.kernel.confirm(h.call, (h.plan as FrozenPlan).commandPlan);
    h.deliver(h.affirm());
    const result = await pending;
    if (!result.approved) throw Error("expected approval");
    const out = await executeConfirmedMemoryWrite(h.call, h.request, h.plan, result.receipt, {
      kernel: h.kernel,
      currentOwnerMatches: () => true,
      store: {
        ownsWebPlan: () => true,
        enqueueConfirmedCommand: () => Promise.reject(new Error("boom")),
      },
    });
    expect(out).toMatchObject({ ok: false, effect: "unknown", code: "E_PERSIST_UNKNOWN" });
  });
});
