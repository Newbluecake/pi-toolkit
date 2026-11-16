import { afterEach, describe, expect, it, vi } from "vitest";
import { bounded, until } from "./helpers/fabric-xs-harness.js";

afterEach(() => vi.useRealTimers());

const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

describe("XS harness liveness barriers", () => {
  it("waits for an observed live state, not just a fixed sleep", async () => {
    fakeTime();
    const states = [{ conn: { state: "backoff" } }, { conn: { state: "live" } }];
    const read = vi.fn(async () => states.shift()!);
    const ready = until(read, (s) => s.conn.state === "live", "socket live");
    await vi.advanceTimersByTimeAsync(30);
    expect(await ready).toEqual({ conn: { state: "live" } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a timed-out barrier includes elapsed time, last state and peer diagnostics", async () => {
    fakeTime();
    const ready = until(
      async () => ({ conn: { state: "backoff" } }),
      () => false,
      "socket live",
      {
        timeoutMs: 60,
        diagnostic: () => "agent:alpha pid=42 exit=null stderr=waiting for hello_ack",
      },
    );
    const failure = expect(ready).rejects.toThrow(
      /socket live; waited=60ms budget=60ms last=.*backoff.*pid=42.*hello_ack/,
    );
    await vi.advanceTimersByTimeAsync(60);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung read cannot outlive the enclosing barrier", async () => {
    fakeTime();
    const ready = until(
      () => new Promise<never>(() => {}),
      () => false,
      "hung inspect",
      { timeoutMs: 90 },
    );
    const failure = expect(ready).rejects.toThrow(/hung inspect; waited=90ms/);
    await vi.advanceTimersByTimeAsync(90);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout on success and propagates a failed peer without polling", async () => {
    fakeTime();
    expect(await bounded(Promise.resolve(42), "rpc")).toBe(42);
    const read = vi.fn(async () => {
      throw new Error("agent exit 1: diagnostic");
    });
    await expect(until(read, () => false, "live")).rejects.toThrow("agent exit 1: diagnostic");
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
