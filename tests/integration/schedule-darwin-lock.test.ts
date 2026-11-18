/**
 * Schedule Darwin lock backend (darwin plan P3) — REAL perl `flock(2)` coverage.
 *
 * Self-gated on perl availability (`which perl`), NOT on the platform, so Linux CI runs the
 * suite too and collects E-AUX evidence for the perl backend; only a macOS run counts as E-MAC
 * (darwin-plan §5.4). Assertions that go through the fd-anchored store paths additionally gate
 * on `fdAnchoringAvailable()`: Linux today, darwin once P2's snapshot path backend lands.
 * Pure acquire-level assertions run wherever perl exists.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultFlockProbe } from "../../src/schedule/agent/wire.js";
import {
  defaultLockAcquire,
  PERL_FLOCK_ARGS,
  perlFlockAcquire,
  withSessionLock,
  type LockAcquire,
} from "../../src/schedule/core/lock.js";
import { fdAnchoringAvailable, openDirPath, sessionDirName } from "../../src/schedule/core/paths.js";
import { ensureStoreRoot, openSessionStore } from "../../src/schedule/core/writer.js";

const PERL: string | undefined = (() => {
  try {
    const r = spawnSync("which", ["perl"], { timeout: 2_000, encoding: "utf8" });
    const p = r.status === 0 ? String(r.stdout).trim() : "";
    if (p !== "") return p;
    return existsSync("/usr/bin/perl") ? "/usr/bin/perl" : undefined;
  } catch {
    return undefined;
  }
})();

const FD_ANCHORING = (() => {
  try {
    return fdAnchoringAvailable();
  } catch {
    return false;
  }
})();

const holders: ChildProcess[] = [];
afterAll(() => {
  for (const h of holders) if (h.exitCode === null) h.kill("SIGKILL");
});

function tmpLock(): { dir: string; path: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sched-darwin-lock-")));
  const path = join(dir, "t.lock");
  writeFileSync(path, "");
  return { dir, path };
}

/** An executable stub standing in for the perl binary (exits / kills / sleeps on cue). */
function stubScript(body: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sched-darwin-stub-")));
  const p = join(dir, "stub.sh");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A real perl process holding a blocking exclusive flock on `path` until killed. */
function perlHolder(path: string, seconds = 60): ChildProcess {
  const h = spawn(
    PERL!,
    [
      "-MFcntl=:flock",
      "-e",
      'open(F, "+<", $ARGV[0]) or die "open"; $| = 1; flock(F, LOCK_EX) or die "flock"; print "held\\n"; sleep $ARGV[1]',
      path,
      String(seconds),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  holders.push(h);
  return h;
}

function holderReady(h: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("holder never acquired")), 10_000);
    h.stdout!.setEncoding("utf8");
    h.stdout!.on("data", (d: string) => {
      out += d;
      if (out.includes("held")) {
        clearTimeout(timer);
        resolve();
      }
    });
    h.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("holder exited before acquiring"));
    });
  });
}

function exited(h: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (h.exitCode !== null || h.signalCode !== null) resolve();
    else h.once("exit", () => resolve());
  });
}

function acquireOn(path: string, acquire: LockAcquire = perlFlockAcquire()): { result: unknown; fd: number } {
  const fd = openSync(path, fsConstants.O_RDWR);
  return { result: acquire(fd), fd };
}

describe.skipIf(PERL === undefined)("perl flock lock backend (darwin plan P3, real perl)", () => {
  it("real perl exports the Fcntl/Errno constants the script needs (T-P1, real side)", () => {
    const r = spawnSync(
      PERL!,
      [
        "-MFcntl=:flock",
        "-MErrno=EWOULDBLOCK,EAGAIN",
        "-e",
        "print LOCK_EX|LOCK_NB, qq{ }, EWOULDBLOCK, qq{ }, EAGAIN",
      ],
      { timeout: 5_000, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const nums = String(r.stdout).trim().split(" ").map(Number);
    expect(nums).toHaveLength(3);
    for (const n of nums) expect(n).toBeGreaterThan(0);
  });

  it("multi-process mutual exclusion: an external perl holder makes our acquire busy", async () => {
    const { dir, path } = tmpLock();
    try {
      const h = perlHolder(path);
      await holderReady(h);
      const { result, fd } = acquireOn(path);
      try {
        expect(result).toBe("busy");
      } finally {
        closeSync(fd);
      }
      h.kill("SIGKILL");
      await exited(h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SIGKILL of the holder releases the lock immediately (kernel closes its fds)", async () => {
    const { dir, path } = tmpLock();
    try {
      const h = perlHolder(path);
      await holderReady(h);
      h.kill("SIGKILL");
      await exited(h);
      // Immediately acquirable — no stale reclaim machinery involved or needed.
      const { result, fd } = acquireOn(path);
      try {
        expect(result).toBe("held");
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("our own closeSync releases the lock (it belongs to our open file description)", () => {
    const { dir, path } = tmpLock();
    try {
      const first = acquireOn(path);
      expect(first.result).toBe("held");
      closeSync(first.fd);
      const second = acquireOn(path);
      try {
        expect(second.result).toBe("held");
      } finally {
        closeSync(second.fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no stale reclaim: an aged lock file held live is never stolen", async () => {
    const { dir, path } = tmpLock();
    try {
      const h = perlHolder(path);
      await holderReady(h);
      // Age the lock file far into the past — mtime/content are diagnostics only, never lock truth.
      const old = new Date(Date.now() - 86_400_000);
      utimesSync(path, old, old);
      const { result, fd } = acquireOn(path);
      try {
        expect(result).toBe("busy");
      } finally {
        closeSync(fd);
      }
      h.kill("SIGKILL");
      await exited(h);
      const after = acquireOn(path);
      try {
        expect(after.result).toBe("held");
      } finally {
        closeSync(after.fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stub perl exiting 3 ⇒ fail with the exit code", () => {
    const { dir, path } = tmpLock();
    try {
      const stub = stubScript("exit 3");
      const { result, fd } = acquireOn(path, perlFlockAcquire(stub));
      try {
        expect(result).toEqual({ kind: "fail", detail: "perl flock exited 3" });
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stub perl killing itself ⇒ fail: killed by SIGKILL (never busy)", () => {
    const { dir, path } = tmpLock();
    try {
      const stub = stubScript("kill -9 $$");
      const { result, fd } = acquireOn(path, perlFlockAcquire(stub));
      try {
        expect(result).toEqual({ kind: "fail", detail: "perl flock killed by SIGKILL (fail closed)" });
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a hanging stub perl ⇒ fail after the deadline (never busy)", () => {
    const { dir, path } = tmpLock();
    try {
      const stub = stubScript("sleep 30");
      const { result, fd } = acquireOn(path, perlFlockAcquire(stub, { timeoutMs: 400 }));
      try {
        expect(result).toEqual({ kind: "fail", detail: "perl flock timed out after 400ms (fail closed)" });
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing perl binary ⇒ fail: perl binary not found (fail closed)", () => {
    const { dir, path } = tmpLock();
    try {
      const { result, fd } = acquireOn(path, perlFlockAcquire("/nonexistent/perl"));
      try {
        expect(result).toEqual({ kind: "fail", detail: "perl binary not found (fail closed)" });
      } finally {
        closeSync(fd);
      }
      // Same via the platform resolver.
      const viaResolver = acquireOn(path, defaultLockAcquire({ platform: "darwin", perlBin: "/nonexistent/perl" }));
      try {
        expect(viaResolver.result).toEqual({ kind: "fail", detail: "perl binary not found (fail closed)" });
      } finally {
        closeSync(viaResolver.fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the production script and args hold a real fd and conflict cross-process", async () => {
    const { dir, path } = tmpLock();
    try {
      const h = perlHolder(path);
      await holderReady(h);
      // Run the exact production PERL_FLOCK_ARGS on our fd of the same file.
      const fd = openSync(path, fsConstants.O_RDWR);
      try {
        const r = spawnSync(PERL!, [...PERL_FLOCK_ARGS], { stdio: ["ignore", "ignore", "ignore", fd], timeout: 5_000 });
        expect(r.status).toBe(75); // busy — same script, same constants, real conflict
      } finally {
        closeSync(fd);
      }
      h.kill("SIGKILL");
      await exited(h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(PERL === undefined || !FD_ANCHORING)("through the fd-anchored store paths", () => {
  it("a missing perl binary maps through withSessionLock to E_BUSY with the fixed detail", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sched-darwin-ebusy-")));
    const dirFd = openDirPath(dir).fd;
    try {
      const r = await withSessionLock(dirFd, () => 42, {
        acquire: perlFlockAcquire("/nonexistent/perl"),
        timeoutMs: 50,
      });
      expect(r).toMatchObject({ ok: false, code: "E_BUSY", detail: "perl binary not found (fail closed)" });
    } finally {
      closeSync(dirFd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repair() against a live perl holder ⇒ E_BUSY (no forced break); death releases it", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sched-darwin-store-")));
    const storeDir = join(dir, "schedules");
    const sid = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";
    try {
      const root = ensureStoreRoot(storeDir);
      mkdirSync(join(storeDir, sessionDirName(sid)), { mode: 0o700 });
      const store = openSessionStore({
        root,
        sessionId: sid,
        self: { pid: 1, start: 1, host: "h", boot: "b" },
        epoch: "ep-1",
        lockTimeoutMs: 200,
        acquire: perlFlockAcquire(),
      });
      const lockPath = join(storeDir, sessionDirName(sid), ".lock");
      writeFileSync(lockPath, ""); // the holder opens "+<" (no O_CREAT); tryLock would create it
      const h = perlHolder(lockPath);
      await holderReady(h);
      const r = await store.repair();
      expect(r).toMatchObject({ ok: false, code: "E_BUSY" });
      h.kill("SIGKILL");
      await exited(h);
      const r2 = await store.repair();
      expect(r2.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "darwin")("darwin-only production smoke", () => {
  it("defaultFlockProbe() is true and the default acquire holds via /usr/bin/perl", () => {
    expect(defaultFlockProbe()).toBe(true);
    const { dir, path } = tmpLock();
    try {
      const fd = openSync(path, fsConstants.O_RDWR);
      try {
        expect(defaultLockAcquire({ platform: "darwin" })(fd)).toBe("held");
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
