import { describe, expect, it, vi } from "vitest";
import { createXsActivation } from "../../src/fabric/xs/activate.js";
import { DEFAULT_SETTINGS, mergeSettings } from "../../src/config/settings.js";
import type { StackHolder } from "../../src/holder.js";

// wake-unknown-optimistic §1.4 production wiring: the stack input handed to buildSessionStack must carry
// `abortOrphan`, routed through the activation-level RootWakeOrphanWatch (run-level dedup). Unit tests
// inject the port directly; this pins that the real activation does too (verifier major #1).
function activation() {
  const settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    fabric: {
      ...DEFAULT_SETTINGS.fabric,
      enabled: true,
      crossSession: { ...DEFAULT_SETTINGS.fabric.crossSession, enabled: true },
    },
    webHub: { ...DEFAULT_SETTINGS.webHub, enabled: true, control: true },
  });
  const holder = { current: undefined } as unknown as StackHolder;
  return createXsActivation({
    settings,
    holder,
    webHubRef: {},
    fencePorts: {},
    notifyCtx: {},
    scheduleMessage: () => undefined,
  });
}

describe("xs activation: abortOrphan wiring (wake-unknown-optimistic §1.4)", () => {
  it("stackInput carries abortOrphan; it aborts once per run through the watch and is inert before attach", () => {
    const xs = activation();
    expect(xs.enabled).toBe(true);
    const input = xs.stackInput();
    expect(typeof input?.abortOrphan).toBe("function");
    // No session ctx attached yet ⇒ nothing to abort.
    expect(input!.abortOrphan!("t1")).toBe(false);

    const abort = vi.fn();
    const ctx = {
      abort,
      isIdle: () => false,
      sessionManager: { getSessionId: () => "s1" },
      ui: { setStatus: () => {} },
    };
    const pi = { getAllTools: () => [] };
    xs.attach({ xs: undefined, rootWakeRecovery: undefined } as never, ctx as never, pi as never, "s1");

    expect(input!.abortOrphan!("t1")).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    // Same run: the watch latch dedups a second orphan sighting.
    expect(input!.abortOrphan!("t2")).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
