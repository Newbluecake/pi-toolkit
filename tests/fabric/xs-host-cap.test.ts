import { afterEach, describe, expect, it, vi } from "vitest";
import { getXsHostCapability, XsHostCapability } from "../../src/fabric/xs/host-cap.js";

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-host-cap")];
});

describe("xs host capability: unknown → observed → verified, sticky absent", () => {
  it("wake-unknown-optimistic: unknown means OPTIMISTIC dispatch (undefined downgrade), never a probe run", () => {
    const cap = new XsHostCapability();
    expect(cap.state).toBe("unknown");
    expect(cap.wakeDowngraded).toBeUndefined();
    expect(cap.optimistic).toBe(true);
    cap.observe({});
    cap.observe(null);
    expect(cap.state).toBe("unknown");
  });

  it.each(["user", "custom"])(
    "any %s union event proves observed (no longer optimistic); owned-token proof verifies",
    (messageType) => {
      const cap = new XsHostCapability();
      cap.observe({ messageType, prompt: "human" });
      expect(cap.state).toBe("observed");
      expect(cap.wakeDowngraded).toBeUndefined();
      expect(cap.optimistic).toBe(false);
      cap.verify();
      expect(cap.state).toBe("verified");
      cap.observe({ messageType: "user" });
      expect(cap.state).toBe("verified");
    },
  );

  it("old peer prompt without messageType makes absent permanently", () => {
    const cap = new XsHostCapability();
    cap.observe({ prompt: "legacy" });
    expect(cap.state).toBe("absent");
    expect(cap.wakeDowngraded).toBe("host_unsupported");
    cap.observe({ messageType: "custom" });
    cap.verify();
    expect(cap.state).toBe("absent");
  });

  it("custom shape loss makes even a verified host absent, warns just once per process", () => {
    const cap = new XsHostCapability(),
      warn = vi.fn();
    cap.observe({ messageType: "user", prompt: "hi" });
    cap.verify();
    cap.missingCustomShape(warn);
    cap.missingCustomShape(warn);
    cap.observe({ messageType: "user" });
    cap.verify();
    expect(cap.state).toBe("absent");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(cap.wakeDowngraded).toBe("host_unsupported");
  });

  it("wake-unknown-optimistic: triggerSkipped is unconditionally absent (even from verified), sticky, one warn shared with missingCustomShape", () => {
    const cap = new XsHostCapability(),
      warn = vi.fn();
    cap.observe({ messageType: "user", prompt: "hi" });
    cap.verify();
    cap.triggerSkipped(warn);
    cap.triggerSkipped(warn);
    cap.observe({ messageType: "custom" });
    cap.verify();
    expect(cap.state).toBe("absent");
    expect(cap.wakeDowngraded).toBe("host_unsupported");
    expect(cap.optimistic).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      "[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only",
    );
    // the shared `warned` flag: a later missingCustomShape on the same instance stays silent
    cap.missingCustomShape(warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const fresh = new XsHostCapability(),
      warn2 = vi.fn();
    fresh.triggerSkipped(warn2);
    fresh.missingCustomShape(warn2);
    expect(warn2).toHaveBeenCalledTimes(1); // still one per PROCESS-like instance
  });

  it("a fresh module (reload) preserves observed/verified/absent evidence", async () => {
    const cap = getXsHostCapability();
    cap.observe({ prompt: "old" });
    vi.resetModules();
    const reloaded = await import("../../src/fabric/xs/host-cap.js");
    expect(reloaded.getXsHostCapability()).toBe(cap);
    expect(reloaded.getXsHostCapability().state).toBe("absent");
  });
});
