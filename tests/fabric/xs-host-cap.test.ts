import { afterEach, describe, expect, it, vi } from "vitest";
import { getXsHostCapability, XsHostCapability } from "../../src/fabric/xs/host-cap.js";

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-host-cap")];
});

describe("xs host capability: unknown → observed → verified, sticky absent", () => {
  it("first startup/managed restore unknown means ONLY delivery, no probing run (N1)", () => {
    const cap = new XsHostCapability();
    expect(cap.state).toBe("unknown");
    expect(cap.wakeDowngraded).toBe("host_unverified");
    cap.observe({});
    cap.observe(null);
    expect(cap.state).toBe("unknown");
  });

  it.each(["user", "custom"])("any %s union event proves observed; owned-token proof verifies", (messageType) => {
    const cap = new XsHostCapability();
    cap.observe({ messageType, prompt: "human" });
    expect(cap.state).toBe("observed");
    expect(cap.wakeDowngraded).toBeUndefined();
    cap.verify();
    expect(cap.state).toBe("verified");
    cap.observe({ messageType: "user" });
    expect(cap.state).toBe("verified");
  });

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

  it("a fresh module (reload) preserves observed/verified/absent evidence", async () => {
    const cap = getXsHostCapability();
    cap.observe({ prompt: "old" });
    vi.resetModules();
    const reloaded = await import("../../src/fabric/xs/host-cap.js");
    expect(reloaded.getXsHostCapability()).toBe(cap);
    expect(reloaded.getXsHostCapability().state).toBe("absent");
  });
});
