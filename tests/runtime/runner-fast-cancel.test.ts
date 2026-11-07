import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import type { FastMode } from "../../src/core/types.js";
import type { FastBindRequest, FastChildStatePort, FastOwner } from "../../src/fast/ports.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";

// Real runner + production driver, with ONLY SDK construction held pending.
const sdkFixture = vi.hoisted(() => ({
  pending: [] as Array<{ resolve: () => void; reject: (error: Error) => void }>,
  buses: [] as Array<{
    emit: (name: string, value: unknown) => void;
    on: (name: string, listener: () => void) => unknown;
  }>,
  probe: vi.fn(),
  bind: vi.fn(),
  dispose: vi.fn(),
  prompt: vi.fn(async () => {}),
  receiverDispose: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../src/secure/domain.js", () => ({
  secureChildSessionDir: () => undefined,
  assertSessionFileInDomain: () => undefined,
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  const manager = () => ({ appendCustomEntry() {}, getBranch: () => [], getCwd: () => "/isolated" });
  return {
    ...sdk,
    SettingsManager: { create: () => ({}) },
    getAgentDir: () => "/isolated/agent",
    SessionManager: { create: manager, inMemory: manager, open: manager },
    DefaultResourceLoader: class {
      constructor(readonly options: { eventBus?: ReturnType<typeof sdk.createEventBus> }) {}
      async reload() {
        const bus = this.options.eventBus;
        if (!bus) return;
        sdkFixture.buses.push(bus);
        bus.on("probe", sdkFixture.probe);
        bus.on("subagent:fast-bind", (value) => {
          sdkFixture.bind(value);
          (value as FastBindRequest).reply({
            v: 1,
            wired: true,
            readMode: () => "off",
            dispose: sdkFixture.receiverDispose,
          });
        });
      }
    },
    createAgentSession: vi.fn((options: Record<string, unknown>) => {
      sdkFixture.options.push(options);
      const bus = sdkFixture.buses.at(-1);
      return new Promise((resolve, reject) => {
        sdkFixture.pending.push({
          reject,
          resolve: () => {
            // SDK extensions may install listeners even after cancellation. Driver's
            // repeated cleanup must clear those too, without emitting FastBind.
            bus?.on("late-probe", sdkFixture.probe);
            resolve({
              session: {
                sessionId: "sdk-session",
                sessionFile: undefined,
                dispose: sdkFixture.dispose,
                prompt: sdkFixture.prompt,
                abort: async () => {},
                subscribe: () => () => {},
              },
            });
          },
        });
      });
    }),
  };
});
import {
  PiSessionDriver,
  toCreateOptions,
  type SessionDriver,
  type SessionHandle,
} from "../../src/runtime/session-driver.js";

const budget = { ...DEFAULT_BUDGET, startupMs: 100, totalMs: 1000, totalGraceMs: 0, abortGraceMs: 5, reapMs: 5 };
const drain = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

function owners() {
  const current = new Map<string, { owner: FastOwner; read: () => FastMode }>();
  const unbind = vi.fn();
  const port: FastChildStatePort = {
    bind(owner, read) {
      current.set(owner.parentRunId, { owner, read });
      return () => {
        unbind(owner);
        if (current.get(owner.parentRunId)?.owner === owner) current.delete(owner.parentRunId);
      };
    },
  };
  return { current, port, unbind };
}
function harness(driver: SessionDriver, beforeReap?: RunnerDeps["beforeReap"]) {
  const clock = new FakeClock();
  const pool = new SingleSlotPool(clock, 1);
  const reaper = new EscalatingReaper(clock);
  const late = vi.spyOn(reaper, "disposeLate");
  let runner!: RuntimeRunner;
  const watchdog = new EventWatchdog({
    clock,
    budget,
    tickMs: 10,
    getState: (id, gen) => runner.getRunState(id, gen),
    dispatch: (id, gen, input) => {
      if (input.kind === "deadline_fired") runner.fireDeadline(id, gen, input);
    },
  });
  runner = new RuntimeRunner({
    clock,
    driver,
    pool,
    reaper,
    watchdog,
    ...(beforeReap ? { beforeReap } : {}),
    store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
  });
  const deadline = vi.spyOn(runner, "fireDeadline");
  return { runner, clock, pool, late, watchdog, deadline };
}
function driverWithOwners(o: ReturnType<typeof owners>) {
  const driver = new PiSessionDriver(true, undefined, undefined, o.port);
  const create = vi.spyOn(driver, "create");
  const resume = vi.spyOn(driver, "resume");
  const late = vi.spyOn(driver, "onLateArrival");
  return { driver, create, resume, late };
}
beforeEach(() => {
  vi.clearAllMocks();
  sdkFixture.pending = [];
  sdkFixture.buses = [];
  sdkFixture.options = [];
});

describe("Fast internal runner cancellation during pending SDK create", () => {
  for (const resume of [false, true]) {
    for (const mode of ["on", "off", "inherit"] as const) {
      it.each(["abort", "watchdog"] as const)(
        `${resume ? "resume" : "create"}/${mode}/%s revokes synchronously before SDK settles`,
        async (cancelBy) => {
          const o = owners();
          const d = driverWithOwners(o);
          const h = harness(d.driver);
          const external = new AbortController();
          const req: ResolvedSpawnRequest = {
            runId: "child",
            prompt: "never prompt",
            signal: external.signal,
            fastSeed: { v: 1, mode },
            ...(resume ? { resumeFrom: "owned-file" } : {}),
          };
          const run = h.runner.run(req, budget);
          await drain();
          expect(sdkFixture.pending).toHaveLength(1);
          expect(Object.hasOwn(sdkFixture.options[0]!, "signal")).toBe(false);
          expect(h.runner.getRunState("child")?.phase).toBe("session_create");
          expect(o.current.get("child")?.read()).toBe(mode);
          expect(h.pool.stats.inUse).toBe(1);
          const forwarded = resume ? d.resume.mock.calls[0]![1] : d.create.mock.calls[0]![0];
          expect(forwarded).not.toBe(req);
          expect(forwarded).toEqual({ ...req, signal: expect.any(AbortSignal) });
          const signal = (forwarded as ResolvedSpawnRequest).signal!;
          expect(signal).not.toBe(external.signal);
          const bus = sdkFixture.buses[0]!;
          bus.emit("probe", "before");
          expect(sdkFixture.probe).toHaveBeenCalledTimes(1);
          const cancelResult = cancelBy === "abort" ? h.runner.abortRun("child") : undefined;
          if (cancelBy === "watchdog") {
            // Production arms after bind; explicitly start the real watchdog
            // here to exercise its session_create deadline producer.
            h.watchdog.arm("child", 1);
            h.clock.advance(100);
            expect(h.deadline).toHaveBeenCalledWith(
              "child",
              1,
              expect.objectContaining({ kind: "deadline_fired", reason: "session_create", at: 100 }),
            );
          }
          // NO await/drain here: owner and exact loader bus are gone now, while SDK is still pending.
          expect(o.current.has("child")).toBe(false);
          expect(o.unbind).toHaveBeenCalledTimes(1);
          expect(signal.aborted).toBe(true);
          expect(external.signal.aborted).toBe(false);
          bus.emit("probe", "after cancellation");
          expect(sdkFixture.probe).toHaveBeenCalledTimes(1);
          expect(sdkFixture.dispose).not.toHaveBeenCalled();
          expect(sdkFixture.bind).not.toHaveBeenCalled();
          if (cancelResult) expect(await cancelResult).toEqual({ ok: true, escalatedTo: "L2" });
          const outcome = await run;
          if (cancelBy === "watchdog") {
            expect(outcome.status).toBe("timed_out");
            expect(outcome.timeoutReason).toBe("session_create");
          } else {
            // Existing direct-runner contract: pending-create abort enters
            // abort_grace, whose startup_failed is absorbed (no outcome yet).
            expect(outcome).toBeUndefined();
            expect(h.runner.getRunState("child")?.phase).toBe("abort_grace");
            expect(h.runner.getRunState("child")?.diag.stopCause).toBe("user_stop");
          }
          expect(h.pool.stats.inUse).toBe(0);
          expect(h.runner.hasActiveSession("child")).toBe(false);
          expect(d.late).toHaveBeenCalledTimes(1);
          sdkFixture.pending[0]!.resolve();
          await drain();
          expect(sdkFixture.dispose).toHaveBeenCalledTimes(1);
          expect(sdkFixture.prompt).not.toHaveBeenCalled();
          expect(sdkFixture.bind).not.toHaveBeenCalled();
          expect(o.unbind).toHaveBeenCalledTimes(1);
          // Driver rejects/disposes cancelled SDK creation; no promptable handle reaches reaper.
          await expect(d.late.mock.calls[0]![0]).rejects.toThrow("Fast child creation aborted");
          expect(h.late).not.toHaveBeenCalled();
          bus.emit("late-probe", "after SDK settlement");
          expect(sdkFixture.probe).toHaveBeenCalledTimes(1);
          expect(h.clock.pendingTimers).toBe(0);
        },
      );
    }
  }

  for (const resume of [false, true]) {
    it.each(["on", "off", "inherit"] as const)(
      `normal startup guard (${resume ? "resume" : "create"}/%s) revokes pending owner through existing finally/reaper`,
      async (mode) => {
        const o = owners();
        const d = driverWithOwners(o);
        const h = harness(d.driver);
        const external = new AbortController();
        const req: ResolvedSpawnRequest = {
          runId: "guard",
          prompt: "q",
          signal: external.signal,
          fastSeed: { v: 1, mode },
          ...(resume ? { resumeFrom: "owned-file" } : {}),
        };
        const run = h.runner.run(req, budget);
        await drain();
        expect(o.current.get("guard")?.read()).toBe(mode);
        expect(sdkFixture.pending).toHaveLength(1);
        expect(Object.hasOwn(sdkFixture.options[0]!, "signal")).toBe(false);
        const forwarded = resume ? d.resume.mock.calls[0]![1] : d.create.mock.calls[0]![0];
        const signal = (forwarded as ResolvedSpawnRequest).signal!;
        h.clock.advance(100); // normal RuntimeRunner.run startup guard, no watchdog.arm
        expect(h.deadline).not.toHaveBeenCalled();
        // guard resolves a verdict, not a synchronous cancel. The following
        // await resumes runner's normal failure/finally/reaper control path.
        const outcome = await run;
        expect(outcome.status).toBe("timed_out");
        expect(outcome.timeoutReason).toBe("session_create");
        expect(outcome.durationMs).toBe(100);
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe("reap");
        expect(external.signal.aborted).toBe(false);
        expect(o.current.size).toBe(0);
        expect(o.unbind).toHaveBeenCalledTimes(1);
        expect(h.pool.stats.inUse).toBe(0);
        expect(sdkFixture.dispose).not.toHaveBeenCalled(); // SDK still pending
        expect(d.late).toHaveBeenCalledTimes(1);
        const bus = sdkFixture.buses[0]!;
        bus.emit("probe", "after guard/finally");
        expect(sdkFixture.probe).not.toHaveBeenCalled();
        sdkFixture.pending[0]!.resolve();
        await drain();
        expect(sdkFixture.dispose).toHaveBeenCalledTimes(1);
        expect(sdkFixture.prompt).not.toHaveBeenCalled();
        expect(sdkFixture.bind).not.toHaveBeenCalled();
        expect(sdkFixture.receiverDispose).not.toHaveBeenCalled();
        await expect(d.late.mock.calls[0]![0]).rejects.toThrow("Fast child creation aborted");
        expect(h.late).not.toHaveBeenCalled();
        expect(h.clock.pendingTimers).toBe(0);
      },
    );
  }

  it("normal startup guard preserves bounded pending beforeReap, then revokes without SDK settlement", async () => {
    const o = owners();
    const d = driverWithOwners(o);
    let releaseHook!: () => void;
    const hookPending = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const beforeReap = vi.fn(() => hookPending);
    const h = harness(d.driver, beforeReap);
    const run = h.runner.run({ runId: "hook", prompt: "q", fastSeed: { v: 1, mode: "inherit" } }, budget);
    await drain();
    const signal = (d.create.mock.calls[0]![0] as ResolvedSpawnRequest).signal!;
    h.clock.advance(100);
    const outcome = await run;
    expect(outcome.status).toBe("timed_out");
    expect(beforeReap).toHaveBeenCalledTimes(1);
    expect(h.deadline).not.toHaveBeenCalled();
    // Existing finally deliberately starts runReap fire-and-forget: run can
    // return while the pre-reap hook is pending. Do not pretend otherwise.
    expect(o.current.get("hook")?.read()).toBe("inherit");
    expect(signal.aborted).toBe(false);
    h.clock.advance(budget.reapMs - 1);
    await drain();
    expect(o.current.has("hook")).toBe(true);
    h.clock.advance(1);
    await drain();
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("reap");
    expect(o.current.size).toBe(0);
    expect(o.unbind).toHaveBeenCalledTimes(1);
    expect(sdkFixture.dispose).not.toHaveBeenCalled(); // still waiting on SDK, not on cleanup
    expect(h.pool.stats.inUse).toBe(0);
    sdkFixture.buses[0]!.emit("probe", "after bounded hook");
    expect(sdkFixture.probe).not.toHaveBeenCalled();
    releaseHook();
    sdkFixture.pending[0]!.resolve();
    await drain();
    expect(sdkFixture.dispose).toHaveBeenCalledTimes(1);
    expect(sdkFixture.prompt).not.toHaveBeenCalled();
    expect(sdkFixture.bind).not.toHaveBeenCalled();
    expect(o.unbind).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("old pending create settling after same-parent replacement cannot revoke new incarnation", async () => {
    const o = owners();
    const d = driverWithOwners(o);
    const h = harness(d.driver);
    const req: ResolvedSpawnRequest = { runId: "same", prompt: "q", fastSeed: { v: 1, mode: "on" } };
    const oldRun = h.runner.run(req, budget);
    await drain();
    const oldOwner = o.current.get("same")!.owner;
    await h.runner.abortRun("same");
    await oldRun;
    const newRun = h.runner.run({ ...req, fastSeed: { v: 1, mode: "inherit" } }, budget);
    await drain();
    const replacement = o.current.get("same")!;
    expect(replacement.owner.incarnation).not.toBe(oldOwner.incarnation);
    sdkFixture.pending[0]!.resolve();
    await drain();
    expect(o.current.get("same")).toBe(replacement);
    expect(replacement.read()).toBe("inherit");
    expect(o.unbind).toHaveBeenCalledTimes(1);
    await h.runner.abortRun("same");
    await newRun;
    sdkFixture.pending[1]!.resolve();
    await drain();
    expect(o.current.size).toBe(0);
    expect(sdkFixture.dispose).toHaveBeenCalledTimes(2);
    expect(sdkFixture.prompt).not.toHaveBeenCalled();
    expect(o.unbind).toHaveBeenCalledTimes(2);
  });

  it("detached Fast external signal stays detached; internal abort still revokes pending owner", async () => {
    const o = owners();
    const d = driverWithOwners(o);
    const h = harness(d.driver);
    const external = new AbortController();
    const run = h.runner.run(
      {
        runId: "detached",
        prompt: "q",
        signal: external.signal,
        detachSignalOnStart: true,
        fastSeed: { v: 1, mode: "inherit" },
      },
      budget,
    );
    await drain();
    external.abort();
    expect(o.current.get("detached")?.read()).toBe("inherit");
    expect((d.create.mock.calls[0]![0] as ResolvedSpawnRequest).signal?.aborted).toBe(false);
    await h.runner.abortRun("detached");
    expect(o.current.size).toBe(0);
    expect(await run).toBeUndefined();
    expect(h.runner.getRunState("detached")?.phase).toBe("abort_grace");
    sdkFixture.pending[0]!.reject(new Error("SDK late failure"));
    await drain();
    expect(o.unbind).toHaveBeenCalledTimes(1);
    expect(sdkFixture.dispose).not.toHaveBeenCalled();
    expect(sdkFixture.prompt).not.toHaveBeenCalled();
  });
});

describe("no-seed runner seam is identity/late-reaper neutral", () => {
  it.each([undefined, "legacy custom prompt"])(
    "no-seed SDK options retain the original signal key (%s)",
    async (systemPrompt) => {
      const external = new AbortController();
      const req: ResolvedSpawnRequest = {
        runId: "legacy-options",
        prompt: "q",
        signal: external.signal,
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
      };
      const options = await toCreateOptions(req, "/isolated");
      expect(Object.hasOwn(options, "signal")).toBe(true);
      expect(options.signal).toBe(external.signal);
      expect(Object.hasOwn(options, "fastSeed")).toBe(false);
      expect(sdkFixture.buses).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "resume=%s passes original request and leaves late handle to existing reaper",
    async (resume) => {
      let resolve!: (h: SessionHandle) => void;
      const pending = new Promise<SessionHandle>((r) => {
        resolve = r;
      });
      const external = new AbortController();
      const create = vi.fn(() => pending);
      const reopen = vi.fn(() => pending);
      const driver: SessionDriver = {
        create,
        resume: reopen,
        bind: async () => {},
        onLateArrival(p, cb) {
          void p.then(cb, () => {});
        },
      };
      const h = harness(driver);
      const req: ResolvedSpawnRequest = {
        runId: "legacy",
        prompt: "q",
        signal: external.signal,
        detachSignalOnStart: true,
        ...(resume ? { resumeFrom: "old-file" } : {}),
      };
      const run = h.runner.run(req, budget);
      await drain();
      expect(resume ? reopen.mock.calls[0] : create.mock.calls[0]).toEqual(resume ? ["old-file", req] : [req]);
      // Identity, not just equality (vi.fn captures the actual argument).
      const calls = (resume ? reopen : create).mock.calls as unknown[][];
      expect(calls[0]![resume ? 1 : 0]).toBe(req);
      external.abort(); // detached parent cancellation never stops this run
      expect(h.runner.getRunState("legacy")?.phase).toBe("session_create");
      expect(h.pool.stats.inUse).toBe(1);
      await h.runner.abortRun("legacy");
      expect(await run).toBeUndefined();
      expect(h.runner.getRunState("legacy")?.phase).toBe("abort_grace");
      expect(h.pool.stats.inUse).toBe(0);
      const dispose = vi.fn(() => ({ returned: true, killed: 0, unkillable: [] }));
      const prompt = vi.fn(async () => {});
      const handle: SessionHandle = {
        sessionId: "late",
        sessionFile: undefined,
        prompt,
        dispose,
        requestAbort: async () => {},
        steer: async () => {},
        killableHandles: new Set(),
        setActiveTools() {},
        getActiveTools: () => [],
        getLastAssistantText: () => undefined,
        getUsage: () => undefined,
      };
      resolve(handle);
      await drain();
      expect(h.late).toHaveBeenCalledTimes(1);
      expect(h.late).toHaveBeenCalledWith("legacy", 1, handle);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(prompt).not.toHaveBeenCalled();
      expect(h.clock.pendingTimers).toBe(0);
    },
  );
});
