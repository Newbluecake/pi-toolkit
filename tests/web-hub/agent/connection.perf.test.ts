/** Original per-send CPU sentinels, separate from the hard bounded-backpressure behavior test. */
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireConnection } from "../../../src/web-hub/agent/connection.js";
import { LIMITS } from "../../../src/web-hub/protocol/messages.js";
import { pathsIn, resetGlobals, SETTINGS, startFakeHub, tmpDir, waitUntil, type FakeHub } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
let hub: FakeHub | undefined;
beforeEach(() => {
  tmp = tmpDir();
  resetGlobals();
});
afterEach(async () => {
  resetGlobals();
  await hub?.close();
  tmp.cleanup();
});

it("paused real hub: send p99 <5ms and max admission <50ms (original bounds)", async () => {
  hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { pauseAfterAck: true });
  const conn = acquireConnection({
    buildId: "1.0.0@perf",
    pluginVersion: "1.0.0",
    kind: "tui",
    cwd: tmp.dir,
    paths: pathsIn(tmp.dir),
    settings: SETTINGS,
    launcher: { error: "no loader in tests" },
    now: Date.now,
    random: () => 0.5,
  });
  conn.attach(
    { onSnapshotReq() {}, onBranchReq() {}, onStateChange() {} },
    {
      sessionId: "perf",
      sessionFile: `${tmp.dir}/s.jsonl`,
      cwd: tmp.dir,
      reason: "startup",
      leafId: "e1",
      mode: "tui",
    },
  );
  await waitUntil(() => conn.status().state === "live", 3_000, "perf live");
  const payload = "x".repeat(2_000);
  const samples: number[] = [];
  let maxBuffered = 0;
  let sawBackoff = false;
  for (let i = 0; i < 10_000; i++) {
    const start = performance.now();
    conn.send({ t: "ev", seq: conn.nextSeq(), e: { type: "message_end", message: { role: "assistant", payload } } });
    if (i % 100 === 0) conn.setSlot("status", { t: "status", leafId: `e${i}`, busy: true, pending: false });
    samples.push(performance.now() - start);
    maxBuffered = Math.max(maxBuffered, conn.bufferedBytes);
    if (conn.status().state === "backoff") sawBackoff = true;
  }
  samples.sort((a, b) => a - b);
  expect(maxBuffered).toBeLessThanOrEqual(LIMITS.hardQueueBytes + 4_096);
  expect(sawBackoff).toBe(true);
  expect(conn.bufferedBytes).toBe(0);
  expect(samples[Math.floor(samples.length * 0.99)]!).toBeLessThan(5);
  expect(samples.at(-1)!).toBeLessThan(50);
});
