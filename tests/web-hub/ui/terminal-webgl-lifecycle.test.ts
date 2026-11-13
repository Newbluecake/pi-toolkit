import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebglLifecycle,
  MAX_WEBGL_REBUILDS,
  WEBGL_READY_TIMEOUT_MS,
  type WebglUiState,
} from "../../../src/web-hub/ui/src/components/terminal/webgl-lifecycle.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const session = () => ({ dispose: vi.fn() });

describe("WebGL-only renderer lifecycle", () => {
  it("unavailable rejects without retries or a DOM fallback", async () => {
    const create = vi.fn(async () => {
      throw new Error("WebGL 不可用，终端未启动。");
    });
    const life = createWebglLifecycle({ create });
    await expect(life.start()).rejects.toThrow("终端未启动");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(create).toHaveBeenCalledTimes(1);
    expect(life.current).toBeUndefined();
    expect(life.state.phase).toBe("unavailable");
    expect(life.state.rebuilds).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rebuilds once after loss; duplicate old signals and a second loss cannot retry", async () => {
    const signals: Array<() => void> = [];
    const sessions = [session(), session()];
    const states: WebglUiState[] = [];
    const create = vi.fn(async (_signal: AbortSignal, onLoss: () => void) => {
      signals.push(onLoss);
      return sessions[signals.length - 1]!;
    });
    const life = createWebglLifecycle({ create, onStateChange: (state) => states.push(state) });
    await life.start();
    signals[0]!();
    signals[0]!();
    expect(life.state.phase).toBe("recovering");
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(life.state).toMatchObject({ phase: "ready", rebuilds: 1 });
    expect(life.current).toBe(sessions[1]);
    signals[0]!();
    expect(create).toHaveBeenCalledTimes(2);
    signals[1]!();
    signals[1]!();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(life.state).toMatchObject({ phase: "reopen-required", rebuilds: 1 });
    expect(life.state.reason).toContain("请重开终端");
    expect(life.current).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1 + MAX_WEBGL_REBUILDS);
    expect(sessions[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(states.map((state) => state.phase)).toEqual(["starting", "ready", "recovering", "ready", "reopen-required"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a failed old renderer cleanup stops recovery instead of throwing or falling back", async () => {
    let lose = () => {};
    const create = vi.fn(async (_s: AbortSignal, onLoss: () => void) => {
      lose = onLoss;
      return {
        dispose() {
          throw new Error("cleanup failed");
        },
      };
    });
    const life = createWebglLifecycle({ create });
    await life.start();
    expect(() => lose()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(life.state.phase).toBe("reopen-required");
    expect(life.state.reason).toContain("请重开终端");
    expect(life.current).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    life.dispose();
  });

  it("failed recovery emits the reopen instruction, never a fallback", async () => {
    let lose = () => {};
    const original = session();
    const create = vi
      .fn()
      .mockImplementationOnce(async (_s: AbortSignal, onLoss: () => void) => {
        lose = onLoss;
        return original;
      })
      .mockRejectedValue(new Error("getContext failed"));
    const life = createWebglLifecycle({ create });
    await life.start();
    lose();
    await vi.advanceTimersByTimeAsync(0);
    expect(life.state.phase).toBe("reopen-required");
    expect(life.state.reason).toContain("请重开终端");
    expect(life.current).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(2);
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("initial readiness has a hard timeout; a late renderer is disposed", async () => {
    let resolve!: (value: ReturnType<typeof session>) => void;
    let signal!: AbortSignal;
    const life = createWebglLifecycle({
      create: async (s) => {
        signal = s;
        return new Promise<ReturnType<typeof session>>((done) => {
          resolve = done;
        });
      },
    });
    const start = life.start();
    const outcome = start.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(WEBGL_READY_TIMEOUT_MS);
    expect(await outcome).toContain("超时");
    expect(signal.aborted).toBe(true);
    expect(life.state.phase).toBe("unavailable");
    const late = session();
    resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(life.current).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("recovery timeout has no new budget and cleans a late completion", async () => {
    let lose = () => {};
    let resolve!: (value: ReturnType<typeof session>) => void;
    const create = vi
      .fn()
      .mockImplementationOnce(async (_s: AbortSignal, onLoss: () => void) => {
        lose = onLoss;
        return session();
      })
      .mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    const life = createWebglLifecycle({ create });
    await life.start();
    lose();
    await vi.advanceTimersByTimeAsync(WEBGL_READY_TIMEOUT_MS);
    expect(life.state.phase).toBe("reopen-required");
    expect(life.state.reason).toContain("请重开终端");
    const late = session();
    resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("dispose cancels a pending rebuild and rejects late readiness", async () => {
    let lose = () => {};
    let resolve!: (value: ReturnType<typeof session>) => void;
    let signal!: AbortSignal;
    const create = vi
      .fn()
      .mockImplementationOnce(async (_s: AbortSignal, onLoss: () => void) => {
        lose = onLoss;
        return session();
      })
      .mockImplementation((s: AbortSignal) => {
        signal = s;
        return new Promise((done) => {
          resolve = done;
        });
      });
    const life = createWebglLifecycle({ create });
    await life.start();
    lose();
    await vi.advanceTimersByTimeAsync(0);
    life.dispose();
    expect(signal.aborted).toBe(true);
    const late = session();
    resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(life.state.phase).toBe("disposed");
    expect(life.current).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose cancels pending startup and makes later loss notifications inert", async () => {
    let lose = () => {};
    const rendered = session();
    const create = vi.fn(async (_s, onLoss: () => void) => {
      lose = onLoss;
      return rendered;
    });
    const life = createWebglLifecycle({ create });
    await life.start();
    life.dispose();
    life.dispose();
    lose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rendered.dispose).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(life.state.phase).toBe("disposed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
