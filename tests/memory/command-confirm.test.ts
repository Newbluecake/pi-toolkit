import { describe, expect, it } from "vitest";
import {
  COMMAND_BUSY_MESSAGE,
  COMMAND_REJECT_LABEL,
  createCommandConfirmKernel,
  type CommandClock,
  type MemoryCommandApproval,
  type MemoryWebCall,
} from "../../src/memory/command-confirm.js";
import type { AskUserRemotePort, RemoteOutcome } from "../../src/ask-user/remote.js";

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
    for (const [key, timer] of this.timers)
      if (timer.at <= this.time) {
        this.timers.delete(key);
        timer.fn();
      }
  }
}
function fixture() {
  const clock = new ManualClock();
  let callback: ((outcome: RemoteOutcome) => boolean) | undefined;
  let affirmative = "";
  let closed = 0;
  const remote: AskUserRemotePort = {
    open(req) {
      affirmative = req.questions[0]!.options[1]!.label;
      return {
        setOnRemote(fn) {
          callback = fn;
        },
        close() {
          closed++;
        },
      };
    },
  };
  let owner = true;
  const kernel = createCommandConfirmKernel({ channel: { kind: "web", remote }, clock, isOwnerCurrent: () => owner });
  const call = kernel.start("hub add hello")!;
  const plan = { rawArgs: "hub add hello", step: 0, manifest: "frozen data", presentation: "hello" };
  const deliver = (value: string, originKind: "lan" | "feishu" = "lan") =>
    callback!({ kind: "answer", answers: { MEMCMD: value }, origin: "test", originKind });
  return {
    clock,
    kernel,
    call,
    plan,
    deliver,
    affirm: () => affirmative,
    closeCount: () => closed,
    invalidate: () => {
      owner = false;
    },
  };
}

describe("memory command confirmation kernel", () => {
  it("binds immutable dispatch facts and invalidates synchronously on deadline, current or abort", () => {
    const f = fixture();
    f.kernel.close(f.call);
    const signal = new AbortController();
    const manager = {};
    const owner = { incarnation: {}, sid: "session-1", sessionEpoch: 1, branchGen: 2 };
    let current = true;
    const binding = {
      cmdId: "cmd-1",
      commandOwner: "activation",
      operationGeneration: 3,
      owner,
      manager,
      deadline: 100,
      signal: signal.signal,
      current: () => current,
    };
    const call = f.kernel.start("session add hello", binding)!;
    const captured = f.kernel.binding(call)!;
    expect(captured.manager).toBe(manager);
    expect(captured.owner.incarnation).toBe(owner.incarnation);
    owner.branchGen = 9;
    expect(captured.owner.branchGen).toBe(2);
    current = false;
    expect(f.kernel.binding(call)).toBeUndefined();
    expect(f.kernel.lease(call)).toBeUndefined();
    current = true;
    const second = f.kernel.start("session add hello", binding)!;
    signal.abort();
    expect(f.kernel.binding(second)).toBeUndefined();
    const third = f.kernel.start("session add hello", { ...binding, signal: new AbortController().signal })!;
    f.clock.time = 100; // no timer callback: every lookup checks the absolute deadline
    expect(f.kernel.binding(third)).toBeUndefined();
    expect(f.kernel.start("session add hello", binding)).toBeUndefined();
  });
  it("does not consume a minted receipt until it is reserved", async () => {
    const f = fixture();
    const pending = f.kernel.confirm(f.call, f.plan);
    f.deliver(f.affirm());
    const result = await pending;
    if (!result.approved) throw Error();
    expect(f.kernel.binding(f.call)).toBeUndefined(); // legacy call has no production binding
    expect(f.kernel.check(f.call, result.receipt, f.plan)).toBe(true);
    expect(f.kernel.consume(f.call, result.receipt, f.plan)).toBe(false);
    expect(f.kernel.reserve(f.call, result.receipt, f.plan)).toBe(true);
    expect(f.kernel.consume(f.call, result.receipt, f.plan)).toBe(true);
  });
  it("mints only after a valid remote answer, reserves and consumes once", async () => {
    const f = fixture();
    const pending = f.kernel.confirm(f.call, f.plan);
    expect(f.deliver(f.affirm(), "feishu")).toBe(false);
    expect(f.deliver(f.affirm())).toBe(true);
    const result = await pending;
    expect(result.approved).toBe(true);
    if (!result.approved) throw Error();
    expect(f.kernel.reserve(f.call, result.receipt, f.plan)).toBe(true);
    expect(f.kernel.check(f.call, result.receipt, f.plan)).toBe(true);
    expect(f.kernel.consume(f.call, result.receipt, f.plan)).toBe(true);
    expect(f.kernel.consume(f.call, result.receipt, f.plan)).toBe(false);
    expect(f.deliver(f.affirm())).toBe(false);
  });
  it("rejects fake calls, fake caps and altered plans", async () => {
    const f = fixture();
    expect((await f.kernel.confirm({} as MemoryWebCall, f.plan)).code).toBe("E_MEM_NEEDS_HUMAN_COMMAND");
    expect(f.kernel.reserve(f.call, {} as MemoryCommandApproval, f.plan)).toBe(false);
    const pending = f.kernel.confirm(f.call, f.plan);
    f.deliver(f.affirm());
    const result = await pending;
    if (!result.approved) throw Error();
    expect(f.kernel.reserve(f.call, result.receipt, { ...f.plan, manifest: "different" })).toBe(false);
    expect(f.kernel.reserve(f.call, result.receipt, f.plan)).toBe(false);
  });
  it("rejects a reused cap across calls even with identical input", async () => {
    const f = fixture();
    const p = f.kernel.confirm(f.call, f.plan);
    f.deliver(f.affirm());
    const result = await p;
    if (!result.approved) throw Error();
    f.kernel.close(f.call);
    const next = f.kernel.start(f.plan.rawArgs)!;
    expect(f.kernel.reserve(next, result.receipt, f.plan)).toBe(false);
  });
  it("times out with an injected clock and ignores late answers", async () => {
    const f = fixture();
    const pending = f.kernel.confirm(f.call, f.plan);
    f.clock.advance(120_000);
    expect(await pending).toMatchObject({ code: "E_MEM_CONFIRM_TIMEOUT", retryable: false });
    expect(f.closeCount()).toBe(1);
    expect(f.deliver(f.affirm())).toBe(false);
    expect(f.clock.timers.size).toBe(0);
  });
  it("cancel wins the race and rejects later approval", async () => {
    const f = fixture();
    const pending = f.kernel.confirm(f.call, f.plan);
    expect(f.deliver(COMMAND_REJECT_LABEL)).toBe(true);
    expect(f.deliver(f.affirm())).toBe(false);
    expect(await pending).toMatchObject({ code: "E_MEM_CONFIRM_DECLINED", retryable: false });
  });
  it("closes pending dialogs and revokes on lifecycle close", async () => {
    const f = fixture();
    const lease = f.kernel.lease(f.call)!;
    const pending = f.kernel.confirm(f.call, f.plan);
    f.kernel.close(f.call);
    expect(await pending).toMatchObject({ code: "E_MEM_CONFIRM_STALE" });
    expect(lease.signal.aborted).toBe(true);
    expect(lease.check()).toBe(false);
  });
  it("rejects missing and throwing channels without approval", async () => {
    for (const channel of [
      { kind: "unavailable" as const },
      {
        kind: "web" as const,
        remote: {
          open() {
            throw Error();
          },
        },
      },
    ]) {
      const k = createCommandConfirmKernel({ channel, isOwnerCurrent: () => true });
      const call = k.start("init")!;
      expect(await k.confirm(call, { rawArgs: "init", step: 0, manifest: "x", presentation: "x" })).toEqual({
        approved: false,
        code: "E_MEM_CONFIRM_UNAVAILABLE",
        message: "确认通道不可用，本步未执行。",
        retryable: false,
      });
    }
  });
  it("enforces one owner invocation and one concurrent dialog", async () => {
    const f = fixture();
    const p = f.kernel.confirm(f.call, f.plan);
    expect(f.kernel.start("other")).toBeUndefined();
    expect(await f.kernel.confirm(f.call, f.plan)).toMatchObject({ code: "E_MEM_BUSY", retryable: false });
    f.deliver(COMMAND_REJECT_LABEL);
    await p;
  });
  it("does not authorize an obsolete owner", async () => {
    const f = fixture();
    const p = f.kernel.confirm(f.call, f.plan);
    f.invalidate();
    expect(f.deliver(f.affirm())).toBe(false);
    f.clock.advance(120_000);
    expect((await p).approved).toBe(false);
  });
  it("revokes a receipt and lease at the total wall deadline", async () => {
    const f = fixture();
    const pending = f.kernel.confirm(f.call, f.plan);
    f.deliver(f.affirm());
    const result = await pending;
    if (!result.approved) throw Error();
    const lease = f.kernel.lease(f.call)!;
    f.clock.advance(29 * 60_000);
    expect(lease.signal.aborted).toBe(true);
    expect(f.kernel.reserve(f.call, result.receipt, f.plan)).toBe(false);
    expect(f.clock.timers.size).toBe(0);
  });
  it("invalidates approval if the plan changes while the dialog is open", async () => {
    const f = fixture();
    const pending = f.kernel.confirm(f.call, f.plan);
    f.plan.manifest = "changed";
    f.deliver(f.affirm());
    expect(await pending).toMatchObject({ code: "E_MEM_PLAN_CHANGED", retryable: false });
  });
  it("does not issue a second receipt for the same step", async () => {
    const f = fixture();
    const pending = f.kernel.confirm(f.call, f.plan);
    f.deliver(f.affirm());
    const result = await pending;
    if (!result.approved) throw Error();
    expect(f.kernel.reserve(f.call, result.receipt, f.plan)).toBe(true);
    expect(f.kernel.consume(f.call, result.receipt, f.plan)).toBe(true);
    expect(await f.kernel.confirm(f.call, f.plan)).toMatchObject({ code: "E_MEM_BUSY" });
  });
  it("allows an injected TUI selection without opening a web dialog", async () => {
    const k = createCommandConfirmKernel({
      channel: { kind: "tui", select: async (_title, options) => options[1] },
      isOwnerCurrent: () => true,
    });
    const call = k.start("init")!;
    const plan = { rawArgs: "init", step: 1, manifest: "m", presentation: "init" };
    const result = await k.confirm(call, plan);
    expect(result.approved).toBe(true);
    if (!result.approved) throw Error();
    expect(k.reserve(call, result.receipt, plan)).toBe(true);
    k.close(call);
  });
  it("returns unavailable when TUI selection rejects", async () => {
    const k = createCommandConfirmKernel({
      channel: {
        kind: "tui",
        select: async () => {
          throw Error("ui");
        },
      },
      isOwnerCurrent: () => true,
    });
    const call = k.start("init")!;
    expect(await k.confirm(call, { rawArgs: "init", step: 0, manifest: "m", presentation: "init" })).toMatchObject({
      code: "E_MEM_CONFIRM_UNAVAILABLE",
      retryable: false,
    });
  });
  it("publishes the exact post-approval busy message", () =>
    expect(COMMAND_BUSY_MESSAGE).toBe(
      "后台记忆任务尚未结束，本步未执行；本次授权已失效，不会自动重试，请稍后重新发起并确认。",
    ));
});

describe("deadline and terminal plan failures", () => {
  it.each([120_000, 120_001])("rejects unscheduled answer at %i ms (deadline exclusive)", async (time) => {
    const f = fixture();
    const p = f.kernel.confirm(f.call, f.plan);
    f.clock.time = time; // deliberately do not dispatch timers
    expect(f.deliver(f.affirm())).toBe(true);
    expect(await p).toMatchObject({ code: "E_MEM_CONFIRM_TIMEOUT" });
    expect(f.kernel.lease(f.call)).toBeUndefined();
  });
  it("accepts an answer just before deadline, then ignores a late timer", async () => {
    const f = fixture();
    const p = f.kernel.confirm(f.call, f.plan);
    f.clock.time = 119_999;
    f.deliver(f.affirm());
    const r = await p;
    if (!r.approved) throw Error();
    f.clock.advance(1);
    expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(true);
    expect(f.kernel.consume(f.call, r.receipt, f.plan)).toBe(true);
  });
  it("timer-first rejects the later answer", async () => {
    const f = fixture();
    const p = f.kernel.confirm(f.call, f.plan);
    f.clock.advance(120_000);
    expect(await p).toMatchObject({ code: "E_MEM_CONFIRM_TIMEOUT" });
    expect(f.deliver(f.affirm())).toBe(false);
  });
  it("enforces the total deadline before a later dialog deadline without dispatched timers", async () => {
    const f = fixture();
    f.clock.time = 29 * 60_000 - 10;
    const p = f.kernel.confirm(f.call, f.plan);
    f.clock.time += 10;
    expect(f.deliver(f.affirm())).toBe(true);
    expect(await p).toMatchObject({ code: "E_MEM_CONFIRM_TIMEOUT" });
    expect(f.kernel.lease(f.call)).toBeUndefined();
  });
  it.each(["minted", "reserved"] as const)(
    "terminal confirm plan failure revokes %s receipt and lease",
    async (state) => {
      const f = fixture();
      const lease = f.kernel.lease(f.call)!;
      const p = f.kernel.confirm(f.call, f.plan);
      f.deliver(f.affirm());
      const r = await p;
      if (!r.approved) throw Error();
      if (state === "reserved") expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(true);
      expect(await f.kernel.confirm(f.call, { ...f.plan, rawArgs: "other" })).toMatchObject({
        code: "E_MEM_PLAN_CHANGED",
      });
      expect(lease.signal.aborted).toBe(true);
      expect(lease.check()).toBe(false);
      expect(f.kernel.check(f.call, r.receipt, f.plan)).toBe(false);
      expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(false);
      expect(f.kernel.consume(f.call, r.receipt, f.plan)).toBe(false);
      expect(await f.kernel.confirm(f.call, f.plan)).toMatchObject({ code: "E_MEM_NEEDS_HUMAN_COMMAND" });
    },
  );
  it.each(["check", "reserve", "consume"] as const)("%s mismatch terminates call and lease", async (method) => {
    const f = fixture();
    const lease = f.kernel.lease(f.call)!;
    const p = f.kernel.confirm(f.call, f.plan);
    f.deliver(f.affirm());
    const r = await p;
    if (!r.approved) throw Error();
    expect(f.kernel[method](f.call, r.receipt, { ...f.plan, manifest: "changed" })).toBe(false);
    expect(lease.signal.aborted).toBe(true);
    expect(f.kernel.check(f.call, r.receipt, f.plan)).toBe(false);
    expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(false);
    expect(f.kernel.consume(f.call, r.receipt, f.plan)).toBe(false);
  });
  it("a concurrent invalid plan is busy and does not cancel the in-flight dialog", async () => {
    const f = fixture();
    const p = f.kernel.confirm(f.call, f.plan);
    expect(await f.kernel.confirm(f.call, { ...f.plan, manifest: "" })).toMatchObject({ code: "E_MEM_BUSY" });
    f.deliver(f.affirm());
    expect((await p).approved).toBe(true);
    f.kernel.close(f.call);
  });
  it.each(["minted", "reserved"] as const)("invalid manifest revokes %s authorization", async (state) => {
    const f = fixture();
    const lease = f.kernel.lease(f.call)!;
    const p = f.kernel.confirm(f.call, f.plan);
    f.deliver(f.affirm());
    const r = await p;
    if (!r.approved) throw Error();
    if (state === "reserved") expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(true);
    expect(await f.kernel.confirm(f.call, { ...f.plan, manifest: "" })).toMatchObject({ code: "E_MEM_PLAN_CHANGED" });
    expect(lease.signal.aborted).toBe(true);
    expect(f.kernel.check(f.call, r.receipt, f.plan)).toBe(false);
    expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(false);
    expect(f.kernel.consume(f.call, r.receipt, f.plan)).toBe(false);
    expect(await f.kernel.confirm(f.call, f.plan)).toMatchObject({ code: "E_MEM_NEEDS_HUMAN_COMMAND" });
  });
  it("reserved receipt mismatch revokes the complete call", async () => {
    const f = fixture();
    const lease = f.kernel.lease(f.call)!;
    const p = f.kernel.confirm(f.call, f.plan);
    f.deliver(f.affirm());
    const r = await p;
    if (!r.approved) throw Error();
    expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(true);
    expect(f.kernel.check(f.call, r.receipt, { ...f.plan, presentation: "changed" })).toBe(false);
    expect(lease.check()).toBe(false);
    expect(lease.signal.aborted).toBe(true);
    expect(f.kernel.check(f.call, r.receipt, f.plan)).toBe(false);
    expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(false);
    expect(f.kernel.consume(f.call, r.receipt, f.plan)).toBe(false);
  });
  it.each(["minted", "reserved"] as const)("changed same-step confirm revokes %s receipt", async (state) => {
    const f = fixture();
    const lease = f.kernel.lease(f.call)!;
    const p = f.kernel.confirm(f.call, f.plan);
    f.deliver(f.affirm());
    const r = await p;
    if (!r.approved) throw Error();
    if (state === "reserved") expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(true);
    expect(await f.kernel.confirm(f.call, { ...f.plan, manifest: "other" })).toMatchObject({
      code: "E_MEM_PLAN_CHANGED",
    });
    expect(lease.signal.aborted).toBe(true);
    expect(lease.check()).toBe(false);
    expect(f.kernel.check(f.call, r.receipt, f.plan)).toBe(false);
    expect(f.kernel.reserve(f.call, r.receipt, f.plan)).toBe(false);
    expect(f.kernel.consume(f.call, r.receipt, f.plan)).toBe(false);
    expect(await f.kernel.confirm(f.call, f.plan)).toMatchObject({ code: "E_MEM_NEEDS_HUMAN_COMMAND" });
  });
});
