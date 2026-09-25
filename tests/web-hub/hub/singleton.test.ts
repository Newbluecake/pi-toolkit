import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { resolveHubPaths, type HubPaths } from "../../../src/web-hub/protocol/paths.js";
import {
  acquireSingleton,
  instanceGuardName,
  pidAlive,
  startFence,
  type SingletonResult,
} from "../../../src/web-hub/hub/singleton.js";
import { tmpDirs, waitFor } from "./helpers.js";

const tmp = tmpDirs();
const owners: Array<Extract<SingletonResult, { kind: "owner" }>> = [];

afterEach(async () => {
  for (const o of owners.splice(0)) await o.release();
  tmp.cleanup();
});

function paths(): HubPaths {
  return resolveHubPaths({ home: tmp.make("wh-s-"), uid: process.getuid?.() ?? 0 });
}

function track(r: SingletonResult): SingletonResult {
  if (r.kind === "owner") owners.push(r);
  return r;
}

function deadPid(): number {
  for (let pid = 999_999; pid > 900_000; pid--) if (!pidAlive(pid)) return pid;
  throw new Error("no dead pid found");
}

describe("acquireSingleton", () => {
  it("3 concurrent acquisitions ⇒ exactly 1 owner, 2 exists", async () => {
    const p = paths();
    const results = await Promise.all([1, 2, 3].map(() => acquireSingleton(p, { probeMs: 200 }).then(track)));
    expect(results.filter((r) => r.kind === "owner")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "exists")).toHaveLength(2);
    expect(existsSync(p.startLock)).toBe(false); // lock released once the socket is bound
    expect(statSync(p.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(p.stateDir).mode & 0o777).toBe(0o700);
  });

  it("guard off (non-Linux fallback): 3 concurrent acquisitions ⇒ exactly 1 owner, 2 exists", async () => {
    const p = paths();
    const results = await Promise.all(
      [1, 2, 3].map(() => acquireSingleton(p, { probeMs: 200, guardName: null }).then(track)),
    );
    expect(results.filter((r) => r.kind === "owner")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "exists")).toHaveLength(2);
  });

  it("a second acquisition while an owner listens returns exists (hubPid from hub.json)", async () => {
    const p = paths();
    const first = track(await acquireSingleton(p, { probeMs: 200 }));
    expect(first.kind).toBe("owner");
    writeFileSync(p.hubJson, JSON.stringify({ pid: process.pid }));
    const second = await acquireSingleton(p, { probeMs: 200, guardName: null });
    expect(second).toEqual({ kind: "exists", hubPid: process.pid });
  });

  it("a leftover socket file from a SIGKILLed hub is unlinked and re-bound", async () => {
    const p = paths();
    // First acquisition only prepares the private dir; then a child binds and is killed -9.
    const warm = track(await acquireSingleton(p, { probeMs: 200 }));
    if (warm.kind === "owner") {
      await warm.release();
      owners.length = 0;
    }
    const child = spawn(
      process.execPath,
      ["-e", `require("net").createServer().listen(${JSON.stringify(p.socketPath)}, () => console.log("up"))`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(existsSync(p.socketPath)).toBe(true); // stale socket left behind
    const r = track(await acquireSingleton(p, { probeMs: 200 }));
    expect(r.kind).toBe("owner");
  });

  it("a stale lock (dead pid) is cleared", async () => {
    const p = paths();
    track(await acquireSingleton(p, { probeMs: 50 })).kind === "owner" && (await owners.pop()!.release());
    writeFileSync(p.startLock, `${deadPid()} ${Date.now()}\n`);
    const r = track(await acquireSingleton(p, { probeMs: 50 }));
    expect(r.kind).toBe("owner");
  });

  it("a stale lock (old mtime, live pid) is cleared", async () => {
    const p = paths();
    track(await acquireSingleton(p, { probeMs: 50 })).kind === "owner" && (await owners.pop()!.release());
    writeFileSync(p.startLock, `${process.pid} 0\n`);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(p.startLock, old, old);
    const r = track(await acquireSingleton(p, { probeMs: 50, lockStaleMs: 10_000 }));
    expect(r.kind).toBe("owner");
  });

  it("a live lock with no hub behind it ⇒ backs off once, then failed", async () => {
    const p = paths();
    track(await acquireSingleton(p, { probeMs: 50 })).kind === "owner" && (await owners.pop()!.release());
    writeFileSync(p.startLock, `${process.pid} ${Date.now()}\n`);
    const started = Date.now();
    const r = await acquireSingleton(p, { probeMs: 100 });
    expect(r.kind).toBe("failed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(existsSync(p.startLock)).toBe(true); // someone else's lock is never removed
    unlinkSync(p.startLock);
  });

  it("a live lock with a live hub behind it ⇒ backs off once, then exists", async () => {
    const p = paths();
    const owner = track(await acquireSingleton(p, { probeMs: 50 }));
    expect(owner.kind).toBe("owner");
    writeFileSync(p.startLock, `${process.pid} ${Date.now()}\n`);
    const r = await acquireSingleton(p, { probeMs: 100, guardName: null });
    expect(r.kind).toBe("exists");
    unlinkSync(p.startLock);
  });

  it("the EADDRINUSE probe only connects (no hello is sent to the live hub)", async () => {
    const p = paths();
    const owner = track(await acquireSingleton(p, { probeMs: 200 }));
    if (owner.kind !== "owner") throw new Error("expected owner");
    const received: Buffer[] = [];
    owner.server.on("connection", (s: net.Socket) => s.on("data", (c: Buffer) => received.push(c)));
    expect((await acquireSingleton(p, { probeMs: 200, guardName: null })).kind).toBe("exists");
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(received).length).toBe(0);
  });

  it("release() closes the server and unlinks the socket only while the inode is still ours", async () => {
    const p = paths();
    const a = track(await acquireSingleton(p, { probeMs: 50 }));
    if (a.kind !== "owner") throw new Error("expected owner");
    await a.release();
    owners.length = 0;
    expect(existsSync(p.socketPath)).toBe(false);

    const b = track(await acquireSingleton(p, { probeMs: 50 }));
    if (b.kind !== "owner") throw new Error("expected owner");
    unlinkSync(p.socketPath);
    writeFileSync(p.socketPath, "someone else"); // path taken over
    await b.release();
    owners.length = 0;
    expect(existsSync(p.socketPath)).toBe(true);
    expect(readFileSync(p.socketPath, "utf8")).toBe("someone else"); // park/restore was lossless

    const c = track(await acquireSingleton(p, { probeMs: 50 }));
    if (c.kind !== "owner") throw new Error("expected owner");
    unlinkSync(p.socketPath);
    const target = join(tmp.make("wh-s-target-"), "real-file");
    writeFileSync(target, "real target");
    symlinkSync(target, p.socketPath); // path replaced by a symlink
    await c.release();
    owners.length = 0;
    expect(lstatSync(p.socketPath).isSymbolicLink()).toBe(true); // the symlink itself is left alone
    expect(readFileSync(target, "utf8")).toBe("real target"); // and its target is never touched/unlinked
  });
});

describe("startFence", () => {
  it("replacing the socket file's inode triggers onLost once", async () => {
    const p = paths();
    const o = track(await acquireSingleton(p, { probeMs: 50 }));
    if (o.kind !== "owner") throw new Error("expected owner");
    let lost = 0;
    let why: string | undefined;
    const stop = startFence(
      p.socketPath,
      o.identity,
      (w) => {
        lost++;
        why = w;
      },
      20,
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(lost).toBe(0);
    unlinkSync(p.socketPath);
    writeFileSync(p.socketPath, "x");
    await waitFor(() => lost > 0, 2000);
    await new Promise((r) => setTimeout(r, 80));
    expect(lost).toBe(1);
    expect(why).toBe("socket-not-socket"); // regular file, not a socket at all
    stop();
  });

  it("stop() ends checking", async () => {
    const p = paths();
    const o = track(await acquireSingleton(p, { probeMs: 50 }));
    if (o.kind !== "owner") throw new Error("expected owner");
    let lost = 0;
    const stop = startFence(p.socketPath, o.identity, () => lost++, 20);
    stop();
    unlinkSync(p.socketPath);
    await new Promise((r) => setTimeout(r, 80));
    expect(lost).toBe(0);
  });
});

// Acceptance #13 regression: the double hub came from `rm -f hub.json hub.sock start.lock`
// while a (TUI-respawned) hub was live — every on-disk mutex was gone, so a new starter bound a
// fresh hub.sock. The abstract-namespace instance guard survives that.
describe.runIf(process.platform === "linux")("instance guard (Linux abstract socket)", () => {
  it("state files removed under a live owner ⇒ later starters still get exists (no second owner)", async () => {
    const p = paths();
    const first = track(await acquireSingleton(p, { probeMs: 200 }));
    if (first.kind !== "owner") throw new Error("expected owner");
    writeFileSync(p.hubJson, JSON.stringify({ pid: process.pid }));
    for (const f of [p.hubJson, p.socketPath, p.startLock]) if (existsSync(f)) unlinkSync(f);
    const later = await Promise.all([1, 2, 3].map(() => acquireSingleton(p, { probeMs: 200 }).then(track)));
    expect(later.map((r) => r.kind)).toEqual(["exists", "exists", "exists"]);
    expect(later[0]).toEqual({ kind: "exists", hubPid: process.pid }); // pid answered by the guard
    expect(existsSync(p.socketPath)).toBe(false); // losers never bind/unlink the path
    expect(existsSync(p.hubJson)).toBe(false);
  });

  it("release() frees the guard for the next starter", async () => {
    const p = paths();
    const a = track(await acquireSingleton(p, { probeMs: 100 }));
    if (a.kind !== "owner") throw new Error("expected owner");
    await a.release();
    owners.length = 0;
    expect(track(await acquireSingleton(p, { probeMs: 100 })).kind).toBe("owner");
  });

  it("a non-owner result releases the guard it took (legacy hub owns the path)", async () => {
    const p = paths();
    const legacy = track(await acquireSingleton(p, { probeMs: 100, guardName: null })); // e.g. an older hub
    expect(legacy.kind).toBe("owner");
    expect((await acquireSingleton(p, { probeMs: 100 })).kind).toBe("exists"); // guard free → path probe
    // …and the guard was closed again: a guard-only starter can take it.
    const name = instanceGuardName(p)!;
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(name, () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it("a squatter answering a foreign pid is ignored (falls back to lock+socket)", async () => {
    const p = paths();
    track(await acquireSingleton(p, { probeMs: 50 })).kind === "owner" && (await owners.pop()!.release());
    const squat = net.createServer((s) => s.end("1\n")); // pid 1: alive, but not our uid (unless root)
    await new Promise<void>((resolve) => squat.listen(instanceGuardName(p)!, () => resolve()));
    try {
      const r = track(await acquireSingleton(p, { probeMs: 200 }));
      expect(r.kind).toBe(process.getuid?.() === 0 ? "exists" : "owner");
    } finally {
      await new Promise<void>((resolve) => squat.close(() => resolve()));
    }
  });

  it("a silent guard holder (stopped hub) is never stolen from", async () => {
    const p = paths();
    const silent = net.createServer(() => undefined); // accepts, never answers
    await new Promise<void>((resolve) => silent.listen(instanceGuardName(p)!, () => resolve()));
    try {
      const started = Date.now();
      expect((await acquireSingleton(p, { probeMs: 100 })).kind).toBe("exists");
      expect(Date.now() - started).toBeLessThan(2_000); // bounded by probeMs
      expect(existsSync(p.socketPath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("instanceGuardName: abstract on linux, none elsewhere", () => {
    const p = paths();
    expect(instanceGuardName(p, { platform: "linux", uid: 7 })).toMatch(/^\0pi-webhub-7-[0-9a-f]{24}$/);
    expect(instanceGuardName(p, { platform: "darwin" })).toBeUndefined();
    expect(instanceGuardName(paths())).not.toBe(instanceGuardName(p)); // per state dir
  });
});

describe.runIf(process.platform === "linux")("EADDRINUSE probe vs. a wedged live hub", () => {
  it("backlog full (EAGAIN) counts as alive: the live socket is never unlinked", async () => {
    const p = paths();
    track(await acquireSingleton(p, { probeMs: 50 })).kind === "owner" && (await owners.pop()!.release());
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("net").createServer(() => {}).listen({ path: ${JSON.stringify(p.socketPath)}, backlog: 1 }, () => console.log("up"))`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const fillers: net.Socket[] = [];
    try {
      await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
      process.kill(child.pid!, "SIGSTOP"); // wedged hub: accepts nothing
      const ino = statSync(p.socketPath).ino;
      // fill the backlog (backlog 1 ⇒ 2 queued connections, the 3rd gets EAGAIN)
      for (let i = 0; i < 3; i++) {
        const s = net.connect(p.socketPath);
        s.on("error", () => undefined);
        fillers.push(s);
        await new Promise((r) => setTimeout(r, 30));
      }
      const r = track(await acquireSingleton(p, { probeMs: 300, guardName: null }));
      expect(r.kind).toBe("exists");
      expect(statSync(p.socketPath).ino).toBe(ino); // not stolen
    } finally {
      for (const s of fillers) s.destroy();
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", () => resolve())));
    }
  });
});

describe("startFence first check", () => {
  it("a socket path removed right after start is noticed at firstMs, not at the interval", async () => {
    const p = paths();
    const o = track(await acquireSingleton(p, { probeMs: 50 }));
    if (o.kind !== "owner") throw new Error("expected owner");
    let lost = 0;
    let why: string | undefined;
    unlinkSync(p.socketPath);
    const stop = startFence(
      p.socketPath,
      o.identity,
      (w) => {
        lost++;
        why = w;
      },
      60_000,
      30,
    );
    await waitFor(() => lost > 0, 1_000);
    expect(lost).toBe(1);
    expect(why).toBe("socket-missing");
    stop();
  });
});

// Contract test ⑩ (§11): io-strike accumulation — a genuinely transient/slow check does not
// immediately declare the socket lost; only `ioStrikes` (default 3) *consecutive* timeouts do.
describe("startFence io strikes", () => {
  it("3 consecutive check timeouts trigger onLost('io')", async () => {
    const p = paths();
    const o = track(await acquireSingleton(p, { probeMs: 50 }));
    if (o.kind !== "owner") throw new Error("expected owner");
    let lost = 0;
    let why: string | undefined;
    const hangingLstat = () => new Promise<never>(() => {});
    const stop = startFence(
      p.socketPath,
      o.identity,
      (w) => {
        lost++;
        why = w;
      },
      30,
      10,
      { lstat: hangingLstat as unknown as typeof lstat, checkDeadlineMs: 20, ioStrikes: 3 },
    );
    await waitFor(() => lost > 0, 3_000);
    expect(lost).toBe(1);
    expect(why).toBe("io");
    stop();
  });

  it("2 check timeouts followed by a success do not trigger onLost (the strike counter resets)", async () => {
    const p = paths();
    const o = track(await acquireSingleton(p, { probeMs: 50 }));
    if (o.kind !== "owner") throw new Error("expected owner");
    let lost = 0;
    let calls = 0;
    const flakyLstat: typeof lstat = ((path: Parameters<typeof lstat>[0]) => {
      calls++;
      return calls <= 2 ? new Promise<never>(() => {}) : lstat(path);
    }) as typeof lstat;
    const stop = startFence(
      p.socketPath,
      o.identity,
      () => {
        lost++;
      },
      30,
      10,
      { lstat: flakyLstat, checkDeadlineMs: 20, ioStrikes: 3 },
    );
    await waitFor(() => calls >= 4, 3_000); // 2 hung socket-checks + 1 successful socket-check + its dir-check
    await new Promise((r) => setTimeout(r, 150));
    expect(lost).toBe(0);
    stop();
  });
});
