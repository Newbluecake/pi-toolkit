import { promises as fsPromises, statSync } from "node:fs";
import { availableParallelism, cpus, homedir, loadavg } from "node:os";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { LoadSettings } from "../../src/sysload/settings.js";
import { parseLoadSettings } from "../../src/sysload/settings.js";
import { createLoadActivation } from "../../src/sysload/activation.js";
import { IoLedger, type IoLedgerState } from "../../src/sysload/io-ledger.js";
import { DARWIN_MEM_ADVISORY, sampleOnce, type SamplerHost } from "../../src/sysload/sampler.js";
import { createLoadTracker } from "../../src/sysload/tracker.js";
import { createHostTopScanner } from "../../src/sysload/top.js";
import { GIB, type LoadDiskPathSample, type LoadSample } from "../../src/sysload/types.js";
import {
  createDarwinHost,
  probeDarwinHost,
  resolveSysloadHost,
  runBounded,
} from "../../src/web-hub/protocol/sysload-darwin.js";
import { createHubLoad, hubLoadProbe } from "../../src/web-hub/hub/load.js";
import type { HubLoadConfig } from "../../src/web-hub/hub/ports.js";
import type { LoadWire } from "../../src/web-hub/protocol/messages.js";

/**
 * macOS real-machine smoke (sysload darwin-plan §4.3, S4 deliverable; acceptance §7.2
 * M1/M3/M4/M5/M7/M8/M9). Tier 2 by directory (`tests/integration/**`) — `node:child_process`
 * via the bounded `runBounded` primitive is allowed here, and EVERY subprocess this file
 * starts is bounded (absolute binary, validated positive timeout, SIGKILL on expiry).
 *
 * Tolerance rule (plan §4.3 intro): every assertion is a property that MUST hold on a real
 * machine (existence / range / stability), never a concrete load number. Each test stays
 * under its 10 s budget; the whole suite runs well inside 60 s on real hardware.
 */
const CORES = cpus().length;
const HOME = homedir();

/** Per-test hard cap (plan: 每项超时 ≤10 s). */
const TEST_TIMEOUT_MS = 10_000;
/** Generous upper bounds that hold with huge margin on real hardware (measured: sysctl ~2 ms,
 * mount ~5 ms, ps -A ~30-60 ms). */
const PRIMITIVE_BUDGET_MS = 500;

/** A private-capacity ledger so this file's leases never contend with any global state. */
function freshLedger(): IoLedger {
  const state: IoLedgerState = { active: new Map(), capacity: 2 };
  return new IoLedger(state);
}

/** Polls `pred` until true within `budgetMs`; rejects with a descriptive error on expiry. */
async function until(pred: () => boolean, budgetMs: number, what: string): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref(); // I5: never wedge the process on a poll tick
    });
  }
}

/** One bounded, C-locale sysctl read (the same primitive the production host uses). */
async function sysctl(names: readonly string[]): Promise<string> {
  return runBounded("/usr/sbin/sysctl", ["-n", ...names], { timeoutMs: 1_000, maxBytes: 8 * 1024 });
}

/** `kern.memorystatus_level` truth for the mem consistency bracket (0..100, or undefined). */
async function memorystatusLevel(): Promise<number | undefined> {
  const text = await sysctl(["kern.memorystatus_level"]);
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}

const isSaneLoadavg = (values: readonly number[] | undefined): boolean =>
  values !== undefined &&
  values.length === 3 &&
  values.every((value) => Number.isFinite(value) && value >= 0 && value <= 64);

describe.skipIf(process.platform !== "darwin")(
  "sysload darwin real-machine smoke (E-MAC, darwin-plan §4.3/§7.2)",
  () => {
    it(
      "readHost: resolveSysloadHost returns a darwin host; loadavg/mem/cores match sysctl truth (M1)",
      async () => {
        const host = resolveSysloadHost();
        expect(host).toBeDefined();
        expect(host?.kind).toBe("darwin");

        const before = await memorystatusLevel();
        const reading = await host!.readHost({ timeoutMs: 800 });
        const after = await memorystatusLevel();

        // loadavg triplet: finite, in range, same order of magnitude as os.loadavg() (|Δ| < 5).
        expect(isSaneLoadavg(reading?.loadavg)).toBe(true);
        const osLoad = loadavg();
        for (let i = 0; i < 3; i++) expect(Math.abs(reading!.loadavg![i]! - osLoad[i]!)).toBeLessThan(5);

        // mem: an integer 0..100, self-consistent with the direct sysctl reading bracketing it.
        const mem = reading?.memAvailPct;
        expect(mem).toBeDefined();
        expect(Number.isInteger(mem)).toBe(true);
        expect(mem!).toBeGreaterThanOrEqual(0);
        expect(mem!).toBeLessThanOrEqual(100);
        if (before !== undefined && after !== undefined) {
          const low = Math.min(before, after);
          const high = Math.max(before, after);
          expect(mem!).toBeGreaterThanOrEqual(low);
          expect(mem!).toBeLessThanOrEqual(high);
        }

        // cores: hw.ncpu == os.cpus().length (the count the loadavg bar divides by).
        expect(reading?.cores).toBe(CORES);
        expect(reading?.cores).toBe(Number((await sysctl(["hw.ncpu"])).trim()));
        // Bonus sanity: matches Node's own parallelism view (same logical-core count).
        expect(reading?.cores).toBe(availableParallelism());
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "mounts: mount(8) parse, deviceOf == fs.stat().dev == `stat -f %d`, dev stable (M3)",
      async () => {
        const host = createDarwinHost();
        const started = performance.now();
        const text = await host.readMounts({ timeoutMs: 800 });
        expect(performance.now() - started).toBeLessThan(PRIMITIVE_BUDGET_MS);

        expect(text).toContain(" on / (");
        const mounts = host.parseMounts(text!);
        const root = mounts.find((entry) => entry.mountPoint === "/");
        expect(root).toBeDefined();
        expect(root?.fstype).toBe("apfs");
        expect(host.localFilesystems.has("apfs")).toBe(true);

        // Mount identity (Q2): fs.stat().dev, no subprocess in production — cross-checked once
        // here against `stat -f %d` (bounded, this integration test only).
        const dev = await host.deviceOf("/");
        expect(dev).toBe(statSync("/").dev);
        const statOut = await runBounded("/usr/bin/stat", ["-f", "%d", "/"], {
          timeoutMs: 1_000,
          maxBytes: 4 * 1024,
        });
        expect(dev).toBe(Number(statOut.trim()));

        // Stability: consecutive reads of the same path agree on the mount identity.
        expect(await host.deviceOf("/")).toBe(dev);
        const homeDev = await host.deviceOf(HOME);
        expect(await host.deviceOf(HOME)).toBe(homeDev);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "sampleOnce: cpu invalid, mem ok+advisory, disks statfs-consistent, stable dev (M4)",
      async () => {
        const host: SamplerHost = resolveSysloadHost()!;
        const before = await memorystatusLevel();
        const started = performance.now();
        const first = await sampleOnce({ host }, { home: HOME }, freshLedger(), 0);
        expect(performance.now() - started).toBeLessThan(1_000);
        const after = await memorystatusLevel();

        const sample = first.sample;
        // CPU has no darwin reading (already decided, not a bug): permanently invalid.
        expect(sample.cpu.kind).toBe("invalid");

        // MEM: display-only advisory reading (Q3).
        expect(sample.mem.kind).toBe("ok");
        expect(sample.memAdvisory).toBe(DARWIN_MEM_ADVISORY);
        if (sample.mem.kind === "ok") {
          const mem = sample.mem.value;
          expect(Number.isInteger(mem.availPct)).toBe(true);
          expect(mem.availPct).toBeGreaterThanOrEqual(0);
          expect(mem.availPct).toBeLessThanOrEqual(100);
          expect(mem.usedPct).toBeCloseTo(100 - mem.availPct, 2);
          if (before !== undefined && after !== undefined) {
            expect(mem.availPct).toBeGreaterThanOrEqual(Math.min(before, after));
            expect(mem.availPct).toBeLessThanOrEqual(Math.max(before, after));
          }
        }

        // loadavg/cores ride along (S3 disclosure input).
        expect(isSaneLoadavg(sample.loadavg)).toBe(true);
        expect(sample.cores).toBe(CORES);

        // Disks: HOME reading ok and within 0.5pp of a direct statfs recomputation.
        const homeEntry = sample.disks.find((entry) => entry.label === "~");
        expect(homeEntry).toBeDefined();
        expect(homeEntry?.reading.kind).toBe("ok");
        if (homeEntry?.reading.kind === "ok") {
          const value = homeEntry.reading.value;
          expect(value.mountPath.length).toBeGreaterThan(0);
          expect(value.freePct).toBeGreaterThanOrEqual(0);
          expect(value.freePct).toBeLessThanOrEqual(100);
          const stat = await fsPromises.statfs(value.mountPath);
          const blocks = Number(stat.blocks);
          const bfree = Number(stat.bfree);
          const bavail = Number(stat.bavail);
          const recomputed = (100 * bavail) / (blocks - bfree + bavail);
          expect(Math.abs(value.freePct - recomputed)).toBeLessThanOrEqual(0.5);
        }
        // The root entry (only present when / and ~ are DIFFERENT mounts) must also be ok.
        const rootEntry = sample.disks.find((entry) => entry.label === "/");
        if (rootEntry !== undefined) expect(rootEntry.reading.kind).toBe("ok");

        // Mount identity is stable across consecutive samples (dev unchanged ⇒ no 断序).
        const second = await sampleOnce({ host }, { home: HOME }, freshLedger(), 0);
        const homeAgain = second.sample.disks.find((entry) => entry.label === "~");
        expect(homeAgain).toBeDefined();
        expect(homeAgain?.reading.kind).toBe("ok");
        if (homeEntry?.reading.kind === "ok" && homeAgain?.reading.kind === "ok") {
          expect(homeAgain.reading.value.mountId).toBe(homeEntry.reading.value.mountId);
          expect(homeAgain.reading.value.dev).toBe(homeEntry.reading.value.dev);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "tracker: all-darwin samples ⇒ overall driven by disk only; advisory mem never gates (M5)",
      () => {
        const settings = (over: Partial<LoadSettings>): LoadSettings => ({
          ...parseLoadSettings({}),
          hint: { enabled: false, display: false, repeatMs: 0, minIntervalMs: 0 },
          hud: false,
          ...over,
        });
        const buildSample = (
          mono: number,
          over: { memAvailPct?: number; memInvalid?: boolean; diskFreePct?: number; diskInvalid?: boolean },
        ): LoadSample => {
          const mem: LoadSample["mem"] =
            over.memInvalid === true
              ? { kind: "invalid" }
              : {
                  kind: "ok",
                  value: { availPct: over.memAvailPct ?? 46, usedPct: 100 - (over.memAvailPct ?? 46) },
                };
          const disks: LoadDiskPathSample[] =
            over.diskInvalid === true
              ? [{ label: "~", reading: { kind: "invalid" } }]
              : [
                  {
                    label: "~",
                    reading: {
                      kind: "ok",
                      value: {
                        mountPath: "/",
                        freePct: over.diskFreePct ?? 50,
                        // Consistent with freePct: X% of a 500 GiB volume. At crit-freePct 2 that
                        // is 10 GiB > critFreeGiB 5, so the PERCENT trigger (not the byte floor)
                        // is what the disk-crit case below exercises.
                        freeBytes: ((over.diskFreePct ?? 50) / 100) * 500 * GIB,
                        totalBytes: 500 * GIB,
                        mountId: 16777233,
                        dev: "16777233",
                      },
                    },
                  },
                ];
          return {
            mono,
            at: mono,
            cpu: { kind: "invalid" },
            mem,
            // Real darwin samples always carry the advisory flag, even when the mem read failed.
            memAdvisory: true,
            disks,
            loadavg: [1.5, 1.5, 1.5],
            cores: CORES,
          };
        };

        // crit-level advisory mem does not gate; overall follows the disk only.
        let now = 1_000;
        const critMem = createLoadTracker(
          { ...settings({ gate: true, sustainMs: 0 }), sampleIntervalMs: 5_000 },
          () => now,
          () => now,
        );
        critMem.observe(buildSample(now, { memAvailPct: 3, diskFreePct: 50 }));
        let verdict = critMem.verdict(now);
        expect(verdict.metrics.cpu.level).toBe("unknown");
        expect(verdict.metrics.mem.level).toBe("unknown");
        expect(verdict.metrics.mem.availPct).toBe(3); // display value preserved
        expect(verdict.level).toBe("ok"); // disk ok is the only known metric
        expect(verdict.gating).toBe(false);
        expect(verdict.cores).toBe(CORES);

        now += 5_000;
        critMem.observe(buildSample(now, { memAvailPct: 3, diskFreePct: 2 })); // disk crit
        verdict = critMem.verdict(now);
        expect(verdict.level).toBe("crit");
        expect(verdict.gating).toBe(true); // driven by DISK, not mem
        expect(verdict.metrics.mem.level).toBe("unknown");
        expect(verdict.metrics.mem.availPct).toBe(3);

        // Even the aggressive warn gate level is never reached by advisory mem alone.
        now = 1_000;
        const warnGate = createLoadTracker(
          { ...settings({ gate: true, gateLevel: "warn", sustainMs: 0 }), sampleIntervalMs: 5_000 },
          () => now,
          () => now,
        );
        warnGate.observe(buildSample(now, { memAvailPct: 3, diskFreePct: 50 }));
        verdict = warnGate.verdict(now);
        expect(verdict.level).toBe("ok");
        expect(verdict.gating).toBe(false);

        // All-invalid darwin sample ⇒ overall unknown, fail-open (§8 I1).
        now = 1_000;
        const failOpen = createLoadTracker(
          { ...settings({ gate: true, sustainMs: 0 }), sampleIntervalMs: 5_000 },
          () => now,
          () => now,
        );
        failOpen.observe(buildSample(now, { memInvalid: true, diskInvalid: true }));
        verdict = failOpen.verdict(now);
        expect(verdict.level).toBe("unknown");
        expect(verdict.gating).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "top: createHostTopScanner (ps pcpu) yields non-empty rows with sane ranges (M7)",
      async () => {
        const host = resolveSysloadHost()!;
        const scanner = createHostTopScanner(host);
        const started = performance.now();
        const snapshot = await scanner(freshLedger(), {
          now: () => performance.now(),
          deadlineMs: 1_000,
          isCurrent: () => true,
        });
        expect(performance.now() - started).toBeLessThan(1_500);

        expect(snapshot.unitsAvailable).toBe(true);
        expect(snapshot.byRss.length).toBeGreaterThan(0);
        const rows = [...snapshot.byCpu, ...snapshot.byRss];
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.comm.length).toBeGreaterThan(0);
          expect(row.comm).toMatch(/^[\S][^\u0000-\u001f\u007f]*$/); // no control characters
          for (const pid of row.pids) {
            expect(Number.isInteger(pid.pid)).toBe(true);
            expect(pid.pid).toBeGreaterThan(0);
            expect(pid.cpuPct).toBeGreaterThanOrEqual(0);
            // pcpu is a single-core-decayed percentage: the generous bound is 100% × cores.
            expect(pid.cpuPct).toBeLessThanOrEqual(100 * CORES);
            expect(pid.rssBytes).toBeGreaterThan(0);
          }
        }

        // This very process must appear in the full bounded listing (ps -A sees us). vitest
        // rewrites the process title, so the comm is the title (e.g. `node (vitest 1)`), not
        // the bare exec basename — assert pid + a non-empty, control-free comm instead.
        const listing = await host.listProcesses({ timeoutMs: 1_000, maxPids: 4_096 });
        expect(listing).toBeDefined();
        const mine = listing!.procs.find((proc) => proc.pid === process.pid);
        expect(mine).toBeDefined();
        expect(mine!.comm.length).toBeGreaterThan(0);
        expect(mine!.comm).not.toMatch(/[\u0000-\u001f\u007f]/);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "activation: default host resolution ticks twice on darwin, darwin-shaped verdict (§4.3-4)",
      async () => {
        const clock = new FakeClock(0);
        const settings: LoadSettings = {
          ...parseLoadSettings({}),
          enabled: true,
          gate: false,
          sampleIntervalMs: 5_000,
          sustainMs: 0,
          hint: { enabled: false, display: false, repeatMs: 0, minIntervalMs: 0 },
          hud: false,
        };
        const activation = createLoadActivation({ settings, clock });
        activation.start({ mode: "tui", home: HOME });
        try {
          // Tick 1: the re-armed FakeClock timer proves the first sample cycle really finished.
          await until(() => clock.pendingTimers === 1, 8_000, "activation tick 1 re-arm");
          clock.advance(5_000); // fire tick 2
          await until(() => clock.pendingTimers === 1, 8_000, "activation tick 2 re-arm");

          const verdict = activation.port().verdict();
          expect(verdict.metrics.cpu.level).toBe("unknown"); // no darwin CPU reading (accepted)
          expect(verdict.metrics.mem.level).toBe("unknown"); // advisory mem (Q3)
          expect(verdict.metrics.mem.availPct).toBeGreaterThanOrEqual(0);
          expect(verdict.metrics.mem.availPct).toBeLessThanOrEqual(100);
          expect(verdict.cores).toBe(CORES);
          expect(isSaneLoadavg(verdict.loadavg)).toBe(true);
          expect(verdict.metrics.disk.length).toBeGreaterThanOrEqual(1);
          for (const disk of verdict.metrics.disk) expect(["ok", "warn", "crit"]).toContain(disk.state.level); // disk drives overall
        } finally {
          activation.dispose();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "subprocess: real sysctl/mount/ps are bounded and leave no residue (M8)",
      async () => {
        const host = createDarwinHost();

        const timed = async (op: () => Promise<unknown>): Promise<number> => {
          const started = performance.now();
          await op();
          return performance.now() - started;
        };
        expect(await timed(() => host.readHost({ timeoutMs: 800 }))).toBeLessThan(PRIMITIVE_BUDGET_MS);
        expect(await timed(() => host.readMounts({ timeoutMs: 800 }))).toBeLessThan(PRIMITIVE_BUDGET_MS);
        expect(await timed(() => host.listProcesses({ timeoutMs: 1_000, maxPids: 2_048 }))).toBeLessThan(
          PRIMITIVE_BUDGET_MS,
        );

        // The one-shot hub startup probe agrees the platform is serviceable.
        expect(probeDarwinHost()).toBe(true);

        // No residue: every sysctl/ps child this suite started is gone (pgrep exits 1 on no
        // match, which runBounded surfaces as a rejection — that IS the clean result).
        const pgrep = async (pattern: string): Promise<string> => {
          try {
            return await runBounded("/usr/bin/pgrep", ["-fl", pattern], { timeoutMs: 1_000, maxBytes: 8 * 1024 });
          } catch {
            return "";
          }
        };
        expect((await pgrep("sysctl -n vm.loadavg")).trim()).toBe("");
        expect((await pgrep("ps -A -o pid=,pcpu=")).trim()).toBe("");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "hub: createHubLoad probes ok, publishes a mem-only wire (no cpu), top works (M9)",
      async () => {
        // The production hub startup probe, with default platform resolution.
        expect(hubLoadProbe()).toBe(true);

        const config: HubLoadConfig = {
          sampleIntervalMs: 5_000,
          sustainMs: 60_000,
          recoverMs: 30_000,
          thresholds: {
            cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
            mem: { warnAvailPercent: 15, critAvailPercent: 8 },
            disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
          },
        };
        let wire: LoadWire | undefined;
        const service = createHubLoad(config, {
          home: HOME,
          onWire: (published) => {
            if (wire === undefined) wire = published;
          },
        });
        expect(service).toBeDefined();
        try {
          await until(() => wire !== undefined, 8_000, "first hub load wire");
          expect(wire!.v).toBe(1);
          expect(wire!.scope).toBe("host");
          expect(wire!.mem).toBeDefined(); // display value present …
          expect(wire!.mem!.level).toBe("unknown"); // … but never leveled (advisory, Q3)
          expect(wire!.mem!.availPct).toBeGreaterThanOrEqual(0);
          expect(wire!.mem!.availPct).toBeLessThanOrEqual(100);
          expect("cpu" in wire!).toBe(false); // no darwin CPU reading on the wire
          expect(wire!.cores).toBe(CORES); // S3 disclosure instead
          expect(isSaneLoadavg(wire!.loadavg)).toBe(true);

          const top = await service!.top();
          expect(top.byRss.length).toBeGreaterThan(0);
          expect(top.byCpu.length).toBeGreaterThan(0);
        } finally {
          await service!.dispose();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
