import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { acquireOnFd } from "../helpers/sched-platform.js";
import { expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createSessionClock, SCHED_POLL_MS } from "../../src/schedule/agent/clock.js";
import { everyTask, seedEvery } from "../schedule/core/every-fixtures.js";
import { env, holder, readOk, self } from "../schedule/core/fixtures.js";

it("real kernel lock contention leaves rev unchanged; releasing only the lock lets the next unchanged poll aggregate once", async () => {
  const A = Date.parse("2026-11-09T10:07:23Z"),
    D = 5_400_000;
  const fake = new FakeClock(A + D + 1),
    base = fake.now();
  const mono = () => performance.now() + fake.now() - base;
  const e = env(fake.now()),
    store = e.store(undefined, { now: () => fake.now(), monotonic: mono, lockTimeoutMs: 30 });
  const task = everyTask(A);
  seedEvery(store, [task], A);
  let fd: number | undefined = openSync(join(store.root.real, store.dirName, ".lock"), "w", 0o600);
  // P4-B: flock(1) on fd 3 on Linux, perl flock(2) on darwin — the helper routes by platform.
  expect(acquireOnFd(fd)).toBe("held");
  const fired: string[] = [];
  const c = createSessionClock({
    store: { get: () => store },
    holder: holder(),
    self: self(),
    armedSince: fake.now(),
    clock: fake,
    monotonic: mono,
    gate: () => undefined,
    onFired: (r) => fired.push(r.runKey),
    warn: () => undefined,
  });
  try {
    await c.start();
    expect(readOk(store).rev).toBe(0);
    expect(fired).toEqual([]);
    fake.advance(2000);
    await c.idle();
    expect(readOk(store).rev).toBe(0);
    closeSync(fd);
    fd = undefined;
    fake.advance(SCHED_POLL_MS - 2000);
    await c.idle();
    expect(fired).toEqual([`${task.id}@${A + D}`]);
    expect(readOk(store).rev).toBe(1);
    expect(readOk(store).runs[0]!.catchUp).toMatchObject({ cause: "reopen", dueCount: 1 });
    expect(c.status().nextAt).toBe(A + 2 * D);
  } finally {
    c.dispose();
    if (fd !== undefined) closeSync(fd);
    e.cleanup();
  }
});
