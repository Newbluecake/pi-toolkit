/** CPU sentinel split from stderr-sink.test.ts; behavior/backpressure/conservation stay hard gates there. */
import { expect, it } from "vitest";
import { createStderrSink, type StderrFs } from "../../../../src/web-hub/hub/spawn/stderr-sink.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";

it("100k × 10-byte pushes stay under the original 200ms CPU budget with a parked disk", async () => {
  let release!: () => void;
  const parked = new Promise<void>((r) => {
    release = r;
  });
  const fs: Partial<StderrFs> = {
    mkdirSync: () => undefined,
    readdirSync: () => [],
    open: async () => ({ write: () => parked, close: async () => undefined }),
  };
  const s = createStderrSink({
    dir: "/unused",
    spawnId: "perf",
    fs,
    now: Date.now,
    log: { info() {}, warn() {}, error() {} },
  });
  const chunk = Buffer.from("0123456789");
  const start = performance.now();
  for (let i = 0; i < 100_000; i++) s.push(chunk);
  const elapsed = performance.now() - start;
  release();
  await s.close(createReqDeadline(Date.now, 2_000));
  expect(s.stats().written + s.stats().dropped).toBe(1_000_000);
  expect(elapsed).toBeLessThan(200);
});
