/**
 * #56 ⑦ 7b G8: session shutdown clears `holder.current`. The tidy port is the one holder-routed port a long-running
 * command (`/mem tidy`) keeps using across that boundary, so it must degrade instead of throwing.
 */
import { describe, expect, it, vi } from "vitest";
import { createTidyPort, requireStack, type StackHolder } from "../../src/holder.js";
import type { Stack } from "../../src/stack.js";

const request = {
  type: "general",
  prompt: "tidy",
  toolDomain: "readonly" as const,
  expectAck: true as const,
  suppressDelivery: true as const,
};

describe("holder after shutdown (G8)", () => {
  it("requireStack throws the stable 'no active session yet' error", () => {
    expect(() => requireStack({})).toThrow("pi-subagent: no active session yet");
  });

  it("tidy port: routes to the live stack while there is one", async () => {
    const spawn = {
      spawn: vi.fn(async () => ({ runId: "r1" })),
      waitOutcome: vi.fn(async () => ({ kind: "pending" as const })),
      abort: vi.fn(async () => true),
    };
    const get = vi.fn(() => undefined);
    const holder: StackHolder = { current: { spawn, query: { get } } as unknown as Stack };
    const port = createTidyPort(holder);
    expect(await port.spawn(request)).toEqual({ runId: "r1" });
    expect(await port.abort("r1", "timeout")).toBe(true);
    await port.waitOutcome("r1", 5);
    port.snapshot("r1");
    expect(spawn.spawn).toHaveBeenCalledTimes(1);
    expect(spawn.waitOutcome).toHaveBeenCalledWith("r1", 5);
    expect(spawn.abort).toHaveBeenCalledWith("r1", "timeout");
    expect(get).toHaveBeenCalledWith("r1");
  });

  it("tidy port: with the holder cleared, nothing throws — error outcome / pending / not aborted / no snapshot", async () => {
    const port = createTidyPort({});
    expect(await port.spawn(request)).toEqual({ error: { message: "no active session" } });
    expect(await port.waitOutcome("r1", 5)).toEqual({ kind: "pending" });
    expect(await port.abort("r1", "timeout")).toBe(false);
    expect(port.snapshot("r1")).toBeUndefined();
  });
});
