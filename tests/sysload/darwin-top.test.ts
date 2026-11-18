/**
 * darwin-plan §4.2-P: `createHostTopScanner` behind a fake host (tier1 — no real `ps`; the
 * host is injected). Linux `scanTop`/`aggregateTop` behavior is covered by top.test.ts and
 * linux-parity.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { IoLedger } from "../../src/sysload/io-ledger.js";
import { createHostTopScanner } from "../../src/sysload/top.js";
import type { HostProcess, SamplerHost } from "../../src/sysload/sampler.js";
import { projectTop } from "../../src/sysload/wire.js";

const freshLedger = (): IoLedger => new IoLedger({ active: new Map(), capacity: 2 });

const PROCS: readonly HostProcess[] = [
  { pid: 1, comm: "launchd", cpuPct: 0.1, rssBytes: 20_224 * 1024 },
  { pid: 80, comm: "node", cpuPct: 120.5, rssBytes: 500 * 1024 * 1024 },
  { pid: 81, comm: "node", cpuPct: 3.2, rssBytes: 200 * 1024 * 1024 },
  { pid: 82, comm: "Google Chrome Helper (Renderer)", cpuPct: 15.7, rssBytes: 900 * 1024 * 1024 },
  { pid: 83, comm: "kernel_task", cpuPct: 9.9, rssBytes: 100 * 1024 * 1024 },
];

describe("sysload darwin top scanner (§4.2-P)", () => {
  it("aggregates by comm with the scanTop output shape: top-5 rows, ≤8 pids, units available, no avg flag", async () => {
    const seen: Array<{ timeoutMs: number; maxPids: number }> = [];
    const host: Pick<SamplerHost, "listProcesses"> = {
      listProcesses: async (opts) => {
        seen.push({ timeoutMs: opts.timeoutMs, maxPids: opts.maxPids });
        return { procs: PROCS, truncated: false };
      },
    };
    const scanner = createHostTopScanner(host);
    const snapshot = await scanner(freshLedger(), { deadlineMs: 300, now: () => 0 });
    expect(snapshot.unitsAvailable).toBe(true);
    expect(snapshot.partial).toBeUndefined();
    expect(snapshot.byCpu.length).toBeLessThanOrEqual(5);
    expect(snapshot.byRss.length).toBeLessThanOrEqual(5);
    expect(snapshot.byCpu[0]).toMatchObject({ comm: "node", count: 2, cpuPct: 123.7 });
    expect(snapshot.byCpu[0]!.pids.length).toBeLessThanOrEqual(8);
    // single-core percentage above 100 is legitimate for `ps pcpu`; never marked `avg` (Q4)
    expect(snapshot.byCpu[0]).not.toHaveProperty("avg");
    expect(snapshot.byRss[0]).toMatchObject({ comm: "Google Chrome Helper (Renderer)" });
    expect(seen).toEqual([{ timeoutMs: 300, maxPids: 2048 }]);
    // wire projection stays NaN-free and null-free
    const projected = projectTop(snapshot);
    expect(JSON.stringify(projected)).not.toContain(":null");
    expect(JSON.stringify(projected)).not.toContain("NaN");
  });

  it("marks truncated and failed listings partial; passes maxPids through capped at 2048", async () => {
    const truncated = await createHostTopScanner({
      listProcesses: async () => ({ procs: PROCS, truncated: true }),
    })(freshLedger(), { deadlineMs: 300 });
    expect(truncated.partial).toBe(true);
    expect(truncated.byCpu.length).toBeGreaterThan(0);

    const failed = await createHostTopScanner({
      listProcesses: async () => undefined,
    })(freshLedger(), { deadlineMs: 300 });
    expect(failed.partial).toBe(true);
    expect(failed.byCpu).toEqual([]);
    expect(failed.unitsAvailable).toBe(true);

    const seen: number[] = [];
    await createHostTopScanner({
      listProcesses: async (opts) => {
        seen.push(opts.maxPids);
        return { procs: [], truncated: false };
      },
    })(freshLedger(), { deadlineMs: 300, maxPids: 5000 });
    await createHostTopScanner({
      listProcesses: async (opts) => {
        seen.push(opts.maxPids);
        return { procs: [], truncated: false };
      },
    })(freshLedger(), { deadlineMs: 300, maxPids: 100 });
    expect(seen).toEqual([2048, 100]);
  });

  it("returns a partial empty snapshot without starting ps when under the 50ms budget or the lease is held", async () => {
    let calls = 0;
    const host: Pick<SamplerHost, "listProcesses"> = {
      listProcesses: async () => {
        calls += 1;
        return { procs: [], truncated: false };
      },
    };
    const scanner = createHostTopScanner(host);
    const rushed = await scanner(freshLedger(), { deadlineMs: 49, now: () => 0 });
    expect(rushed).toMatchObject({ partial: true, unitsAvailable: true, byCpu: [], byRss: [] });
    expect(calls).toBe(0);
    // the budget bail released its lease: a later scan still works
    const ok = await scanner(freshLedger(), { deadlineMs: 300, now: () => 0 });
    expect(ok.partial).toBeUndefined();
    expect(calls).toBe(1);

    const held = freshLedger();
    const lease = held.tryAcquire("top");
    expect(lease).toBeDefined();
    const busy = await scanner(held, { deadlineMs: 300, now: () => 0 });
    expect(busy.partial).toBe(true);
    expect(busy.byCpu).toEqual([]);
    expect(calls).toBe(1);
    lease!.release();

    const stale = await scanner(freshLedger(), { deadlineMs: 300, now: () => 0, isCurrent: () => false });
    expect(stale.partial).toBe(true);
    expect(calls).toBe(1);
  });

  it("hands the host a finite positive timeoutMs ≤1000 at the 50ms budget edge and above", async () => {
    const seen: number[] = [];
    const host: Pick<SamplerHost, "listProcesses"> = {
      listProcesses: async (opts) => {
        seen.push(opts.timeoutMs);
        return { procs: [], truncated: false };
      },
    };
    const scanner = createHostTopScanner(host);
    await scanner(freshLedger(), { deadlineMs: 50, now: () => 0 });
    await scanner(freshLedger(), { deadlineMs: 3_000, now: () => 0 });
    expect(seen).toEqual([50, 1000]);
    for (const timeoutMs of seen) {
      expect(Number.isFinite(timeoutMs)).toBe(true);
      expect(timeoutMs).toBeGreaterThan(0);
    }
  });

  it("takes the budget as ONE snapshot — a clock crossing the 50ms boundary mid-check never starts ps (Major 1)", async () => {
    const queueNow = (values: readonly number[]) => {
      let index = 0;
      return () => values[Math.min(index++, values.length - 1)]!;
    };

    // Snapshot exactly 49 ⇒ no lease held, ps never started (and the lease is free afterwards).
    const seen: number[] = [];
    const host: Pick<SamplerHost, "listProcesses"> = {
      listProcesses: async (opts) => {
        seen.push(opts.timeoutMs);
        return { procs: [], truncated: false };
      },
    };
    const scanner = createHostTopScanner(host);
    const ledger = freshLedger();
    const rushed = await scanner(ledger, { deadlineMs: 300, now: queueNow([0, 251]) });
    expect(seen).toEqual([]);
    expect(rushed.partial).toBe(true);
    expect(ledger.tryAcquire("top")).toBeDefined();

    // Snapshot exactly 50, the NEXT clock read already 49: ps runs with timeoutMs 50 from the
    // snapshot — never 49 (the pre-fix double-read computed 49 and still started the call).
    const crossing = await scanner(freshLedger(), {
      deadlineMs: 300,
      now: queueNow([0, 250, 251]),
    });
    expect(seen).toEqual([50]);
    expect(crossing.partial).toBeUndefined();

    // Snapshot 51 ⇒ proceeds with 51.
    await scanner(freshLedger(), { deadlineMs: 300, now: queueNow([0, 249, 249]) });
    expect(seen).toEqual([50, 51]);

    // A non-finite snapshot ⇒ no call at all.
    const nanLedger = freshLedger();
    const nan = await scanner(nanLedger, { deadlineMs: 300, now: queueNow([0, Number.NaN]) });
    expect(seen).toEqual([50, 51]);
    expect(nan.partial).toBe(true);
    expect(nanLedger.tryAcquire("top")).toBeDefined();
  });

  it("keeps the `top` lease until a hung listing really settles, and never calls onPrevious", async () => {
    let releaseListing!: (value: { procs: readonly HostProcess[]; truncated: boolean } | undefined) => void;
    const listing = new Promise<{ procs: readonly HostProcess[]; truncated: boolean } | undefined>((resolve) => {
      releaseListing = resolve;
    });
    const onPrevious = vi.fn();
    const ledger = freshLedger();
    const scan = createHostTopScanner({ listProcesses: () => listing })(ledger, {
      deadlineMs: 100,
      now: () => 0,
      onPrevious,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const snapshot = await scan;
    expect(snapshot.partial).toBe(true);
    expect(snapshot.byCpu).toEqual([]);
    expect(ledger.has("top")).toBe(true);
    expect(ledger.tryAcquire("top")).toBeUndefined();
    expect(onPrevious).not.toHaveBeenCalled();
    releaseListing({ procs: PROCS, truncated: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ledger.has("top")).toBe(false);
  });
});
