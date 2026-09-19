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
});

describe("DeferredReloadController", () => {
  it("does not fire while runs remain active", () => {
    const fire = vi.fn();
    const ctl = new DeferredReloadController({ fire });
    ctl.arm(2);
    expect(ctl.pending).toBe(true);
    ctl.handleRunSettled(1);
    expect(fire).not.toHaveBeenCalled();
    expect(ctl.pending).toBe(true);
  });

  it("fires and disarms when the fleet drains", () => {
    const fire = vi.fn();
    const ctl = new DeferredReloadController({ fire });
    ctl.arm(2);
    ctl.handleRunSettled(1);
    ctl.handleRunSettled(0);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(ctl.pending).toBe(false);
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

  it("can be re-armed after firing", () => {
    const fire = vi.fn();
    const ctl = new DeferredReloadController({ fire });
    ctl.arm(1);
    ctl.handleRunSettled(0);
    ctl.arm(2);
    expect(ctl.pending).toBe(true);
    ctl.handleRunSettled(2);
    expect(fire).toHaveBeenCalledTimes(1);
    ctl.handleRunSettled(0);
    expect(fire).toHaveBeenCalledTimes(2);
  });
});
