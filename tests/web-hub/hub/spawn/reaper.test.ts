/**
 * web-hub-spawn plan §SP6 acceptance (arch v2 §7.3/§7.4, invariants L2/L3/L5):
 *
 *  - parity: the reaper script's embedded `verifyIdentity` (extracted from the built source
 *    and loaded via `new Function`) agrees with `protocol/proc-identity.ts`'s
 *    `verifySpawnedIdentity` on one shared `/proc` fixture matrix;
 *  - real subprocesses: ready handshake; a tracked, detached child gets SIGTERM ~`REAPER_GRACE_MS`
 *    after the hub-side stdin closes, a TERM-ignoring child gets SIGKILL +3s, and the reaper
 *    itself exits ≤ its hard cap; a doctored starttime ⇒ NO signal (L5);
 *  - lifecycle: SIGKILLed reaper ⇒ backoff respawn + `onRestart` re-track; the 4th failure in
 *    the window ⇒ `available === false` + `onUnavailable` (§6.5);
 *  - hub-side unit edges (fake child): exact wire frames, ready-timeout ⇒ `start()` false +
 *    child SIGKILLed, close idempotence.
 *
 * Real-escalation tests run on arch §7.3's true 5s/3s/1s timings (per-test `timeout` raised);
 * everything else compresses timings via `buildReaperSource({timings})` / `ReaperDeps`.
 */
import { EventEmitter } from "node:events";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parseStartTicks, verifySpawnedIdentity } from "../../../../src/web-hub/protocol/proc-identity.js";
import { REAPER_GRACE_MS } from "../../../../src/web-hub/protocol/spawn.js";
import {
  buildReaperSource,
  extractVerifySource,
  REAPER_EXIT_AFTER_MS,
  REAPER_HARD_CAP_MS,
  REAPER_KILL_AFTER_MS,
} from "../../../../src/web-hub/hub/spawn/reaper-source.js";
import { createReaper, type Reaper } from "../../../../src/web-hub/hub/spawn/reaper.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { memLog, sleepReal, waitFor } from "../helpers.js";

const isLinux = process.platform === "linux";
const linuxDescribe = isLinux ? describe : describe.skip;

// ---------------------------------------------------------------------------
// parity fixtures
// ---------------------------------------------------------------------------

/** `/proc/<pid>/stat` text: rest[2] = pgrp, rest[19] = starttime (fields 5 and 22 overall). */
function statLine(pid: number, pgrp: number, startTicks: number, comm = "pi"): string {
  const rest = ["S", String(pid - 1), String(pgrp)];
  while (rest.length < 19) rest.push("0");
  rest.push(String(startTicks));
  return `${pid} (${comm}) ${rest.join(" ")}`;
}

function statusLine(real: number, effective: number): string {
  return `Name:\tpi\nUid:\t${real}\t${effective}\t${real}\t${effective}\nGid:\t100\t100\t100\t100\n`;
}

interface EmbeddedExpected {
  pid: number;
  startTicks: number;
  bootId: string;
  uid: number;
}

type Verdict = { ok: true } | { ok: false; reason: string };
type EmbeddedVerify = (
  expected: EmbeddedExpected,
  group: boolean,
  deps: { readFileSync: (path: string) => string; platform: string },
) => Verdict;

function loadEmbeddedVerify(): EmbeddedVerify {
  const body = extractVerifySource(buildReaperSource());
  return new Function(`${body}\nreturn verifyIdentity;`)() as unknown as EmbeddedVerify;
}

describe("reaper-source embedded verifyIdentity ⇔ verifySpawnedIdentity parity (arch §7.4)", () => {
  const embedded = loadEmbeddedVerify();
  const BOOT = "11111111-2222-3333-4444-555555555555";

  interface Case {
    name: string;
    files: Record<string, string>;
    expected: { bootId?: string; startTicks?: number; uid?: number };
    group: boolean;
    platform?: string;
  }

  const PID = 4321;
  const TICKS = 987_654;
  const UID = 1000;
  const goodFiles: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": `${BOOT}\n`,
    [`/proc/${PID}/stat`]: statLine(PID, PID, TICKS),
    [`/proc/${PID}/status`]: statusLine(UID, UID),
  };

  const cases: Case[] = [
    { name: "all good (group)", files: goodFiles, expected: {}, group: true },
    { name: "all good (single)", files: goodFiles, expected: {}, group: false },
    { name: "non-linux", files: goodFiles, expected: {}, group: true, platform: "darwin" },
    { name: "boot id differs", files: goodFiles, expected: { bootId: "other" }, group: true },
    {
      name: "boot file unreadable",
      files: {
        [`/proc/${PID}/stat`]: goodFiles[`/proc/${PID}/stat`]!,
        [`/proc/${PID}/status`]: goodFiles[`/proc/${PID}/status`]!,
      },
      expected: {},
      group: true,
    },
    {
      name: "boot file whitespace-only",
      files: { ...goodFiles, "/proc/sys/kernel/random/boot_id": " \n" },
      expected: {},
      group: true,
    },
    {
      name: "stat missing",
      files: { "/proc/sys/kernel/random/boot_id": `${BOOT}\n`, [`/proc/${PID}/status`]: statusLine(UID, UID) },
      expected: {},
      group: true,
    },
    {
      name: "status missing",
      files: { "/proc/sys/kernel/random/boot_id": `${BOOT}\n`, [`/proc/${PID}/stat`]: statLine(PID, PID, TICKS) },
      expected: {},
      group: true,
    },
    { name: "starttime differs", files: goodFiles, expected: { startTicks: TICKS + 1 }, group: true },
    {
      name: "stat garbage (no comm paren)",
      files: { ...goodFiles, [`/proc/${PID}/stat`]: "garbage without parens" },
      expected: {},
      group: true,
    },
    {
      name: "uid real differs",
      files: { ...goodFiles, [`/proc/${PID}/status`]: statusLine(UID + 1, UID) },
      expected: {},
      group: true,
    },
    {
      name: "uid effective differs",
      files: { ...goodFiles, [`/proc/${PID}/status`]: statusLine(UID, UID + 1) },
      expected: {},
      group: true,
    },
    {
      name: "Uid line missing",
      files: { ...goodFiles, [`/proc/${PID}/status`]: "Name:\tpi\nGid:\t1\t1\t1\t1\n" },
      expected: {},
      group: true,
    },
    { name: "uid differs in expected", files: goodFiles, expected: { uid: UID + 1 }, group: true },
    {
      name: "pgrp != pid (group kill)",
      files: { ...goodFiles, [`/proc/${PID}/stat`]: statLine(PID, PID - 1, TICKS) },
      expected: {},
      group: true,
    },
    {
      name: "pgrp != pid (single kill: not checked)",
      files: { ...goodFiles, [`/proc/${PID}/stat`]: statLine(PID, PID - 1, TICKS) },
      expected: {},
      group: false,
    },
    {
      name: "comm containing ')' still parses",
      files: { ...goodFiles, [`/proc/${PID}/stat`]: statLine(PID, PID, TICKS, "weird)name") },
      expected: {},
      group: true,
    },
  ];

  for (const c of cases) {
    it(`agrees: ${c.name}`, async () => {
      const platform = c.platform ?? "linux";
      const expected = {
        pid: PID,
        startTicks: c.expected.startTicks ?? TICKS,
        procStartTicks: c.expected.startTicks ?? TICKS,
        bootId: c.expected.bootId ?? BOOT,
        uid: c.expected.uid ?? UID,
      };
      const protocolVerdict = await verifySpawnedIdentity(
        { pid: expected.pid, procStartTicks: expected.procStartTicks, bootId: expected.bootId, uid: expected.uid },
        { group: c.group },
        {
          platform,
          readFile: (p) => {
            const v = c.files[p];
            return v === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(v);
          },
        },
      );
      const embeddedVerdict = embedded(
        { pid: expected.pid, startTicks: expected.startTicks, bootId: expected.bootId, uid: expected.uid },
        c.group,
        {
          platform,
          readFileSync: (p) => {
            const v = c.files[p];
            if (v === undefined) throw new Error(`ENOENT: ${p}`);
            return v;
          },
        },
      );
      expect(embeddedVerdict).toEqual(protocolVerdict);
    });
  }

  it("extractVerifySource throws when markers are missing", () => {
    expect(() => extractVerifySource("no markers here")).toThrow(/markers/);
  });

  it("buildReaperSource embeds arch §7.3's real timings by default", () => {
    const src = buildReaperSource();
    expect(src).toContain(`const GRACE_MS = ${REAPER_GRACE_MS};`);
    expect(REAPER_GRACE_MS).toBe(5_000);
    expect(src).toContain(`const KILL_MS = ${REAPER_KILL_AFTER_MS};`);
    expect(src).toContain(`const EXIT_MS = ${REAPER_EXIT_AFTER_MS};`);
    expect(src).toContain(`const HARD_CAP_MS = ${REAPER_HARD_CAP_MS};`);
    // 5s + 3s + 1s = 9s, 3s of headroom under ORPHAN_BOUND_MS (12s); hard cap beyond the sum.
    expect(REAPER_GRACE_MS + REAPER_KILL_AFTER_MS + REAPER_EXIT_AFTER_MS).toBeLessThan(REAPER_HARD_CAP_MS);
  });
});

// ---------------------------------------------------------------------------
// hub-side unit edges (fake child — no real process)
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = null;
  readonly killed: Array<string | undefined> = [];
  pid = 9999;
  unref(): void {}
  kill(signal?: string): boolean {
    this.killed.push(signal);
    return true;
  }
}

function fakeSpawn(): { spawnFn: typeof realSpawn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn = (() => {
    const c = new FakeChild();
    children.push(c);
    return c;
  }) as unknown as typeof realSpawn;
  return { spawnFn, children };
}

function writtenLines(c: FakeChild): string[] {
  const lines: string[] = [];
  c.stdin.on("data", (chunk: Buffer) => {
    for (const l of chunk.toString("utf8").split("\n")) if (l.length > 0) lines.push(l);
  });
  return lines;
}

describe("createReaper (fake child: wire frames + handshake edges)", () => {
  let reapers: Reaper[] = [];
  afterEach(() => {
    for (const r of reapers) r.close();
    reapers = [];
  });
  function make(over: Partial<Parameters<typeof createReaper>[0]> = {}): { r: Reaper; children: FakeChild[] } {
    const { spawnFn, children } = fakeSpawn();
    const r = createReaper({ log: memLog(), spawnFn, ...over });
    reapers.push(r);
    return { r, children };
  }

  it("ready handshake ⇒ start true; track/untrack write exact wire frames", async () => {
    const { r, children } = make();
    const startedP = r.start(createReqDeadline(Date.now, 5_000));
    const c = children[0]!;
    const lines = writtenLines(c);
    c.stdout.write('{"ok":"ready"}\n');
    expect(await startedP).toBe(true);
    expect(r.available).toBe(true);
    r.track({ spawnId: "s1", pid: 123, startTicks: 456, bootId: "b", uid: 1000 });
    r.untrack(123);
    await waitFor(() => lines.length >= 2, 1_000, 5);
    expect(lines[0]).toBe('{"op":"track","spawnId":"s1","pid":123,"startTicks":456,"bootId":"b","uid":1000}');
    expect(lines[1]).toBe('{"op":"untrack","pid":123}');
  });

  it("no ready within readyTimeoutMs ⇒ start false, child SIGKILLed, available false", async () => {
    const { r, children } = make({ readyTimeoutMs: 150 });
    expect(await r.start(createReqDeadline(Date.now, 5_000))).toBe(false);
    expect(r.available).toBe(false);
    expect(children[0]!.killed).toContain("SIGKILL");
  });

  it("first frame is not {ok:'ready'} ⇒ start false", async () => {
    const { r, children } = make();
    const startedP = r.start(createReqDeadline(Date.now, 5_000));
    children[0]!.stdout.write('{"ok":"bogus"}\n');
    expect(await startedP).toBe(false);
    expect(children[0]!.killed).toContain("SIGKILL");
  });

  it("remaining deadline budget < readyTimeoutMs ⇒ ready wait ends at the remaining budget", async () => {
    const { r, children } = make({ readyTimeoutMs: 2_000 });
    const t0 = Date.now();
    expect(await r.start(createReqDeadline(Date.now, 300))).toBe(false);
    const elapsed = Date.now() - t0;
    // Settled by the 300ms deadline budget, NOT the 2s ready timeout.
    expect(elapsed).toBeLessThan(1_000);
    expect(r.available).toBe(false);
    expect(children[0]!.killed).toContain("SIGKILL");
  });

  it("start with an exhausted deadline ⇒ false without spawning", async () => {
    const { r, children } = make();
    expect(await r.start(createReqDeadline(Date.now, 0))).toBe(false);
    expect(children.length).toBe(0);
  });

  it("close ends child stdin, is idempotent, and silences later track/untrack", async () => {
    const { r, children } = make();
    const startedP = r.start(createReqDeadline(Date.now, 5_000));
    const c = children[0]!;
    const lines = writtenLines(c);
    c.stdout.write('{"ok":"ready"}\n');
    expect(await startedP).toBe(true);
    r.close();
    r.close();
    expect(c.stdin.writableEnded).toBe(true);
    r.track({ spawnId: "s", pid: 1, startTicks: 2, bootId: "b", uid: 3 });
    r.untrack(1);
    await sleepReal(50);
    expect(lines.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// real-subprocess acceptance (linux only)
// ---------------------------------------------------------------------------

linuxDescribe("createReaper (real subprocess, arch §7.3)", () => {
  const dirs: string[] = [];
  const reapers: Reaper[] = [];
  const observed: ChildProcess[] = [];
  afterEach(() => {
    for (const r of reapers.splice(0)) r.close();
    for (const c of observed.splice(0)) {
      try {
        process.kill(-(c.pid ?? 0), "SIGKILL");
      } catch {
        // already gone
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmpdir1(): string {
    const d = mkdtempSync(join(tmpdir(), "wh-reaper-"));
    dirs.push(d);
    return d;
  }

  /** A detached child (pgid === pid, exactly what the hub spawns for spawn.v1). */
  function spawnObserved(script: string, env: Record<string, string> = {}): ChildProcess {
    const c = realSpawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    observed.push(c);
    return c;
  }

  function aliveFlag(c: ChildProcess): () => boolean {
    let alive = true;
    c.on("exit", () => {
      alive = false;
    });
    return () => alive;
  }

  function captureIdentity(pid: number): { pid: number; startTicks: number; bootId: string; uid: number } {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTicks = parseStartTicks(stat);
    if (startTicks === undefined) throw new Error(`no starttime for pid ${pid}`);
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const uid = process.getuid?.() ?? 0;
    return { pid, startTicks, bootId, uid };
  }

  function capturingSpawn(): { spawnFn: typeof realSpawn; children: ChildProcess[] } {
    const children: ChildProcess[] = [];
    const spawnFn = ((cmd: string, args: readonly string[], opts: Parameters<typeof realSpawn>[2]) => {
      const c = realSpawn(cmd, args, opts);
      children.push(c);
      return c;
    }) as unknown as typeof realSpawn;
    return { spawnFn, children };
  }

  const OBSERVER_SCRIPT = `
    process.on('SIGTERM', function () {
      try { require('node:fs').writeFileSync(process.env.MARKER, 'term'); } catch (e) {}
      process.exit(0);
    });
    setInterval(function () {}, 1000);
  `;
  const IGNORER_SCRIPT = `
    process.on('SIGTERM', function () {});
    setInterval(function () {}, 1000);
  `;

  it("ready handshake; SIGTERM after REAPER_GRACE_MS; TERM-ignorer SIGKILLed +3s; reaper exits ≤ hard cap", async () => {
    const dir = tmpdir1();
    const marker = join(dir, "term.txt");
    const observer = spawnObserved(OBSERVER_SCRIPT, { MARKER: marker });
    const ignorer = spawnObserved(IGNORER_SCRIPT);
    const observerAlive = aliveFlag(observer);
    const ignorerAlive = aliveFlag(ignorer);

    const { spawnFn, children } = capturingSpawn();
    const reaper = createReaper({ log: memLog(), spawnFn });
    reapers.push(reaper);
    expect(await reaper.start(createReqDeadline(Date.now, 5_000))).toBe(true);
    expect(reaper.available).toBe(true);
    const reaperChild = children[0]!;
    const reaperAlive = aliveFlag(reaperChild);

    reaper.track({ spawnId: "observer", ...captureIdentity(observer.pid!) });
    reaper.track({ spawnId: "ignorer", ...captureIdentity(ignorer.pid!) });

    const t0 = Date.now();
    reaper.close(); // stdin EOF — what any hub death (incl. SIGKILL) looks like to the reaper

    // The grace window is real: no TERM may land before ~REAPER_GRACE_MS.
    await sleepReal(REAPER_GRACE_MS / 2);
    expect(existsSync(marker)).toBe(false);

    // TERM at ~t0+5s: marker appears, observer exits.
    await waitFor(() => existsSync(marker), 6_000, 50);
    const termAt = Date.now() - t0;
    expect(termAt).toBeGreaterThanOrEqual(REAPER_GRACE_MS - 1_000);
    await waitFor(() => !observerAlive(), 2_000, 25);

    // The TERM-ignorer survives phase 1 and is SIGKILLed at ~t0+8s.
    await waitFor(() => !ignorerAlive(), 6_000, 50);
    const killAt = Date.now() - t0;
    expect(killAt).toBeGreaterThanOrEqual(REAPER_GRACE_MS + REAPER_KILL_AFTER_MS - 1_500);

    // The reaper itself exits at ~t0+9s, always ≤ hard cap (10s) + slack.
    await waitFor(() => !reaperAlive(), 6_000, 50);
    expect(Date.now() - t0).toBeLessThan(REAPER_HARD_CAP_MS + 2_000);
  }, 30_000);

  it("doctored starttime ⇒ no signal, target survives; reaper still exits (compressed timings)", async () => {
    const target = spawnObserved(IGNORER_SCRIPT);
    const targetAlive = aliveFlag(target);
    const script = buildReaperSource({ timings: { graceMs: 400, killMs: 300, exitMs: 150, hardCapMs: 2_500 } });
    const { spawnFn, children } = capturingSpawn();
    const reaper = createReaper({ log: memLog(), spawnFn, script });
    reapers.push(reaper);
    expect(await reaper.start(createReqDeadline(Date.now, 5_000))).toBe(true);
    const reaperAlive = aliveFlag(children[0]!);

    const id = captureIdentity(target.pid!);
    reaper.track({ spawnId: "doctored", pid: id.pid, startTicks: id.startTicks + 1, bootId: id.bootId, uid: id.uid });
    reaper.close();

    await sleepReal(1_500); // grace + TERM + KILL phases all elapsed
    expect(targetAlive()).toBe(true);
    await waitFor(() => !reaperAlive(), 3_000, 25);
  }, 15_000);

  it("untrack removes a pid from the escalation set (compressed timings)", async () => {
    const target = spawnObserved(IGNORER_SCRIPT);
    const targetAlive = aliveFlag(target);
    const script = buildReaperSource({ timings: { graceMs: 400, killMs: 300, exitMs: 150, hardCapMs: 2_500 } });
    const { spawnFn } = capturingSpawn();
    const reaper = createReaper({ log: memLog(), spawnFn, script });
    reapers.push(reaper);
    expect(await reaper.start(createReqDeadline(Date.now, 5_000))).toBe(true);

    reaper.track({ spawnId: "untracked", ...captureIdentity(target.pid!) });
    reaper.untrack(target.pid!);
    reaper.close();

    await sleepReal(1_500);
    expect(targetAlive()).toBe(true);
  }, 15_000);

  it("SIGKILLed reaper ⇒ backoff respawn + onRestart re-track kills the re-tracked target", async () => {
    const script = buildReaperSource({ timings: { graceMs: 400, killMs: 300, exitMs: 150, hardCapMs: 2_500 } });
    const { spawnFn, children } = capturingSpawn();
    const reaper = createReaper({ log: memLog(), spawnFn, script, backoffMs: [50, 50, 50], restartWindowMs: 60_000 });
    reapers.push(reaper);

    const target = spawnObserved(OBSERVER_SCRIPT, { MARKER: join(tmpdir1(), "retracked.txt") });
    const targetAlive = aliveFlag(target);
    const id = captureIdentity(target.pid!);
    let restarts = 0;
    reaper.onRestart(() => {
      restarts++;
      // The supervisor's contract: re-track every non-terminal record on the new reaper.
      reaper.track({ spawnId: "retracked", ...id });
    });

    expect(await reaper.start(createReqDeadline(Date.now, 5_000))).toBe(true);
    expect(children.length).toBe(1);
    children[0]!.kill("SIGKILL");

    await waitFor(() => restarts === 1, 5_000, 20);
    expect(children.length).toBe(2);
    expect(reaper.available).toBe(true);

    // The re-tracked target must be escalated by the NEW reaper after close.
    reaper.close();
    await waitFor(() => !targetAlive(), 5_000, 25);
  }, 20_000);

  it("the 4th failure inside the window ⇒ available false + onUnavailable", async () => {
    const { spawnFn, children } = capturingSpawn();
    const reaper = createReaper({ log: memLog(), spawnFn, backoffMs: [50, 50, 50], restartWindowMs: 60_000 });
    reapers.push(reaper);
    let restarts = 0;
    reaper.onRestart(() => {
      restarts++;
    });
    const unavailableP = new Promise<void>((res) => reaper.onUnavailable(res));

    expect(await reaper.start(createReqDeadline(Date.now, 5_000))).toBe(true);
    for (let i = 0; i < 3; i++) {
      const before = children.length;
      children[before - 1]!.kill("SIGKILL");
      await waitFor(() => restarts === i + 1, 5_000, 20);
      expect(children.length).toBe(before + 1);
    }
    children[children.length - 1]!.kill("SIGKILL");
    await unavailableP;
    expect(reaper.available).toBe(false);
    // Post-give-up track/untrack/close are harmless no-ops.
    reaper.track({ spawnId: "late", pid: 1, startTicks: 2, bootId: "b", uid: 3 });
    reaper.untrack(1);
  }, 20_000);
});
