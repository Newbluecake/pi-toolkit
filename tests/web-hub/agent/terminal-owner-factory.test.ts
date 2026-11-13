import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fs = vi.hoisted(() => ({ readFile: vi.fn(), stat: vi.fn(), readdir: vi.fn() }));
vi.mock("node:fs/promises", () => fs);
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
import { randomUUID } from "node:crypto";
import { systemClock } from "../../../src/core/clock.js";
import { createTerminalOwner, type TerminalOwnerOptions } from "../../../src/web-hub/agent/terminal/owner.js";
const options: TerminalOwnerOptions = {
  sessionId: "session",
  epoch: "epoch",
  cwd: "/fixture",
  limits: { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 },
  current: () => ({ localConnectionInstance: "connection", sessionId: "session", epoch: "epoch" }),
  allowed: () => true,
  send: () => true,
};
const fields = ["S", "1", "2", "3", ...Array<string>(15).fill("0"), "123"];
const statText = `${process.pid} (node) ${fields.join(" ")}`;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  fs.readFile.mockImplementation(async (path: string) => (path.endsWith("boot_id") ? "linux-boot\n" : statText));
  fs.stat.mockResolvedValue({ uid: 1000 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("F3 factory identity sub-budget, no owner born on late /proc success", () => {
  it.each(["readFile(stat)", "readFile(boot)", "stat(metadata)"])(
    "hangs %s but rejects in the 1s identity budget, not 6s",
    async (which) => {
      const held = deferred<string | { uid: number }>();
      if (which === "stat(metadata)") fs.stat.mockReturnValue(held.promise);
      else
        fs.readFile.mockImplementation((path: string) =>
          path.endsWith(which === "readFile(boot)" ? "boot_id" : "/stat")
            ? held.promise
            : Promise.resolve(path.endsWith("boot_id") ? "linux-boot\n" : statText),
        );
      const births = vi.mocked(randomUUID).mock.calls.length;
      const set = vi.spyOn(globalThis, "setTimeout");
      const outcome = createTerminalOwner(options).then(
        (owner) => ({ owner }),
        (error: Error) => ({ error }),
      );
      let observed: unknown;
      void outcome.then((result) => {
        observed = result;
      });
      await vi.advanceTimersByTimeAsync(1001);
      expect(observed).toBeDefined();
      expect(observed).toHaveProperty("error.code", "E_DEADLINE");
      expect(vi.getTimerCount()).toBe(0);
      expect(set.mock.results.some((r) => r.type === "return" && r.value?.hasRef?.() === false)).toBe(true);
      held.resolve(which === "stat(metadata)" ? { uid: 1000 } : which === "readFile(boot)" ? "linux-boot\n" : statText);
      await vi.advanceTimersByTimeAsync(6000);
      expect(vi.mocked(randomUUID).mock.calls.length).toBe(births); // not even a discarded late owner
      set.mockRestore();
    },
  );
  it("a late success is rejected synchronously even when the timeout callback has not been dispatched", async () => {
    const held = deferred<{ uid: number }>();
    fs.stat.mockReturnValue(held.promise);
    let now = 1000;
    const clock = { now: () => now, setTimer: systemClock.setTimer, clearTimer: systemClock.clearTimer };
    const births = vi.mocked(randomUUID).mock.calls.length;
    const outcome = createTerminalOwner({ ...options, clock }).then(
      (owner) => ({ owner }),
      (error: Error) => ({ error }),
    );
    now = 2001;
    held.resolve({ uid: 1000 }); // no timer advance
    expect(await outcome).toHaveProperty("error.code", "E_DEADLINE");
    expect(vi.mocked(randomUUID).mock.calls.length).toBe(births);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("timely real identity projection constructs one owner and clears the startup timer", async () => {
    const births = vi.mocked(randomUUID).mock.calls.length;
    const owner = await createTerminalOwner(options);
    expect(owner.processIdentity).toEqual({ bootId: "linux-boot", pid: process.pid, starttime: "123", uid: 1000 });
    expect(vi.mocked(randomUUID).mock.calls.length).toBe(births + 1);
    expect(vi.getTimerCount()).toBe(0);
    await owner.dispose();
  });
});
