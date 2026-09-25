import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createIdleMonitor } from "../../../src/web-hub/hub/idle.js";
import { createHubLog } from "../../../src/web-hub/hub/log.js";
import { tmpDirs } from "./helpers.js";

describe("createIdleMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires exactly once after idleMs of all-zero counts", () => {
    const onIdle = vi.fn();
    const m = createIdleMonitor({
      counts: () => ({ agents: 0, sse: 0, headless: 0 }),
      idleMs: 60_000,
      checkMs: 30_000,
      now: () => Date.now(),
      onIdle,
    });
    vi.advanceTimersByTime(30_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    m.stop();
  });

  it.each([
    ["agents", { agents: 1, sse: 0, headless: 0 }],
    ["sse", { agents: 0, sse: 2, headless: 0 }],
    ["headless", { agents: 0, sse: 0, headless: 1 }],
  ])("a non-zero %s count resets the idle clock", (_name, busy) => {
    const onIdle = vi.fn();
    let c = { agents: 0, sse: 0, headless: 0 };
    const m = createIdleMonitor({ counts: () => c, idleMs: 60_000, checkMs: 30_000, now: () => Date.now(), onIdle });
    vi.advanceTimersByTime(30_000);
    c = busy;
    vi.advanceTimersByTime(30_000); // busy observed at t=60s ⇒ idleSince reset
    c = { agents: 0, sse: 0, headless: 0 };
    vi.advanceTimersByTime(30_000); // t=90s: only 30s idle
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000); // t=120s: 60s idle
    expect(onIdle).toHaveBeenCalledTimes(1);
    m.stop();
  });

  it("stop() prevents firing; a throwing counts() counts as busy", () => {
    const onIdle = vi.fn();
    const m = createIdleMonitor({
      counts: () => {
        throw new Error("boom");
      },
      idleMs: 1,
      checkMs: 10,
      now: () => Date.now(),
      onIdle,
    });
    vi.advanceTimersByTime(100);
    expect(onIdle).not.toHaveBeenCalled();
    m.stop();
    const m2 = createIdleMonitor({
      counts: () => ({ agents: 0, sse: 0, headless: 0 }),
      idleMs: 1,
      checkMs: 10,
      now: () => Date.now(),
      onIdle,
    });
    m2.stop();
    vi.advanceTimersByTime(100);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("createHubLog", () => {
  const tmp = tmpDirs();
  afterEach(() => tmp.cleanup());

  it("writes 0600 JSON lines and rotates to .1 past maxBytes", () => {
    const dir = tmp.make();
    const file = join(dir, "hub.log");
    const log = createHubLog(file, { maxBytes: 400 });
    log.info("hello", { a: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const first = JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, unknown>;
    expect(first).toMatchObject({ level: "info", msg: "hello", a: 1 });
    for (let i = 0; i < 20; i++) log.warn(`line ${i}`, { pad: "x".repeat(40) });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(400);
    log.close();
    const before = readFileSync(file, "utf8");
    log.error("after close");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("never throws when the directory is missing", () => {
    const log = createHubLog(join(tmp.make(), "missing", "hub.log"));
    expect(() => log.info("x")).not.toThrow();
  });
});
