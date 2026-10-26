import { describe, expect, it, vi } from "vitest";
import { DeferredReloadController, countActiveRuns, shouldRewriteReload } from "../../src/reload/defer.js";

describe("shouldRewriteReload", () => {
  it("matches an exact /reload only", () => {
    expect(shouldRewriteReload("/reload")).toBe(true);
    expect(shouldRewriteReload("  /reload  ")).toBe(true);
    expect(shouldRewriteReload("/reload ")).toBe(true);
    expect(shouldRewriteReload("\n/reload\n")).toBe(true);
  });

  it("rejects anything beyond the bare command", () => {
    expect(shouldRewriteReload("/reload x")).toBe(false);
    expect(shouldRewriteReload("/reload now")).toBe(false);
    expect(shouldRewriteReload("reload")).toBe(false);
    expect(shouldRewriteReload("//reload")).toBe(false);
    expect(shouldRewriteReload("/reloads")).toBe(false);
    expect(shouldRewriteReload("")).toBe(false);
  });
});

describe("countActiveRuns", () => {
  it("counts only non-terminal statuses", () => {
    const runs = [
      { status: "running" },
      { status: "queued" },
      { status: "starting" },
      { status: "stopping" },
      { status: "completed" },
      { status: "failed" },
      { status: "timed_out" },
      { status: "aborted" },
    ];
    expect(countActiveRuns(runs)).toBe(4);
    expect(countActiveRuns([])).toBe(0);
    expect(countActiveRuns([{ status: "completed" }])).toBe(0);
  });

  // admitted-run-visibility fix (2026-10-08 incident): a run that SpawnService has
  // already admitted (its admission-time `running` set) but whose first runner
  // snapshot has not landed in the registry yet must still be counted — otherwise
  // the deferred-reload fire-path re-count sees zero busy runs and reloads out from
  // under it (the exact incident).
  it("unions registry-visible runs with admission-time ids by runId", () => {
    const runs = [{ status: "running", runId: "r_A" }];
    // Admitted run not yet in the registry at all ⇒ adds one.
    expect(countActiveRuns(runs, ["r_B"])).toBe(2);
    // Admitted run that IS already visible in the registry ⇒ no double count.
    expect(countActiveRuns(runs, ["r_A"])).toBe(1);
    // A run visible only via admission (registry empty) still counts — this is
    // precisely the admitted-but-unobserved window (resume's session-open can
    // take a while before any snapshot lands).
    expect(countActiveRuns([], ["r_B"])).toBe(1);
    // No admitted ids (or an empty list) degrades to the registry-only count,
    // byte-for-byte identical to omitting the argument entirely.
    expect(countActiveRuns(runs, [])).toBe(1);
    expect(countActiveRuns(runs, undefined)).toBe(1);
  });
});

describe("DeferredReloadController", () => {
  it("natural wait uses an unref timer and disarm disposes it", () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      timer = nativeSetTimeout(...args);
      return timer;
    }) as typeof setTimeout);
    const ctl = new DeferredReloadController({ fire: vi.fn() });
    try {
      ctl.arm(1);
      ctl.waitForIdle(
        () => new Promise(() => undefined),
        () => false,
        vi.fn(),
      );
      expect(timer?.hasRef()).toBe(false);
    } finally {
      ctl.disarm();
      spy.mockRestore();
    }
  });
  it("does not fire while runs remain active", () => {
    const fire = vi.fn();
    const ctl = new DeferredReloadController({ fire });
    ctl.arm(2);
    expect(ctl.pending).toBe(true);
    ctl.handleRunSettled(1);
    expect(fire).not.toHaveBeenCalled();
    expect(ctl.pending).toBe(true);
  });

  it("queues fire once and remains pending when the fleet drains", () => {
    const fire = vi.fn();
    const ctl = new DeferredReloadController({ fire });
    ctl.arm(2);
    ctl.handleRunSettled(1);
    ctl.handleRunSettled(0);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(ctl.pending).toBe(true);
    ctl.handleRunSettled(0);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("ignores settle events when not armed", () => {
    const fire = vi.fn();
    const ctl = new DeferredReloadController({ fire });
    ctl.handleRunSettled(0);
    expect(fire).not.toHaveBeenCalled();
  });

  it("stays silent after disarm (cancel)", () => {
    const fire = vi.fn();
    const ctl = new DeferredReloadController({ fire });
    ctl.arm(3);
    ctl.disarm();
    expect(ctl.pending).toBe(false);
    ctl.handleRunSettled(0);
    expect(fire).not.toHaveBeenCalled();
  });

  it("re-arming is idempotent and refreshes the count", () => {
    const fire = vi.fn();
    const ctl = new DeferredReloadController({ fire });
    ctl.arm(1);
    ctl.arm(5);
    expect(ctl.pending).toBe(true);
    expect(ctl.rememberedActiveCount).toBe(5);
    ctl.handleRunSettled(0);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("can be re-armed after fire has completed", () => {
    const fire = vi.fn();
    const ctl = new DeferredReloadController({ fire });
    ctl.arm(1);
    ctl.handleRunSettled(0);
    ctl.disarm(); // the command performs the reload
    ctl.arm(2);
    expect(ctl.pending).toBe(true);
    ctl.handleRunSettled(2);
    expect(fire).toHaveBeenCalledTimes(1);
    ctl.handleRunSettled(0);
    expect(fire).toHaveBeenCalledTimes(2);
  });
});
