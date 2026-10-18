import { describe, expect, it, vi } from "vitest";
import { bounded, createFeishuWork } from "../../../../src/web-hub/hub/feishu/runtime.js";
import { systemFeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";

describe("F8 bounded ownership", () => {
  it("production timers are unref'd and bounded() clears the winning timer", async () => {
    const timers: NodeJS.Timeout[] = [];
    const clock = {
      ...systemFeishuClock,
      setTimeout(fn: () => void, ms: number) {
        const timer = systemFeishuClock.setTimeout(fn, ms) as NodeJS.Timeout;
        timers.push(timer);
        return timer;
      },
    };
    expect(await bounded(Promise.resolve(42), 1_000, clock)).toBe(42);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.hasRef()).toBe(false);
  });
  it("deadline settles without waiting for a hung dependency and clears its timer", async () => {
    const clock = createFakeClock(),
      never = new Promise<never>(() => {});
    const waiting = bounded(never, 10, clock);
    const assertion = expect(waiting).rejects.toThrow("feishu-deadline");
    clock.advance(10);
    await assertion;
    expect(clock.pending()).toBe(0);
  });
  it("work slots follow actual lifetime; drain expiry never releases zombie capacity", async () => {
    const clock = createFakeClock(),
      errors = vi.fn(),
      group = createFeishuWork(clock, errors, 1);
    let done!: () => void;
    expect(
      group.run(
        () =>
          new Promise<void>((resolve) => {
            done = resolve;
          }),
      ),
    ).toBe(true);
    await Promise.resolve();
    expect(group.size).toBe(1);
    const drain = group.drain(10);
    clock.advance(10);
    await drain;
    expect(group.size).toBe(1);
    expect(group.run(async () => {})).toBe(false);
    done();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(group.size).toBe(0);
    expect(
      group.run(async () => {
        throw new Error("path secret");
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveBeenCalledTimes(1);
    group.close();
    expect(group.run(async () => {})).toBe(false);
  });
});
