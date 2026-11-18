/**
 * Lock acquisition seam (darwin plan P3): `perlFlockAcquire` / `defaultLockAcquire` / the
 * platform-aware `defaultFlockProbe`, exercised ENTIRELY through injected spawns and fake
 * acquires — no real child process here (the real-perl coverage lives in
 * `tests/integration/schedule-darwin-lock.test.ts`, tier2).
 */
import { closeSync, constants as fsConstants, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultFlockProbe } from "../../../src/schedule/agent/wire.js";
import {
  defaultLockAcquire,
  linuxFlockAcquire,
  PERL_FLOCK_ARGS,
  PERL_FLOCK_SCRIPT,
  perlFlockAcquire,
  withSessionLock,
  type AcquireDeps,
  type AcquireResult,
  type LockAcquire,
} from "../../../src/schedule/core/lock.js";
import { fdAnchoringAvailable, openDirPath } from "../../../src/schedule/core/paths.js";

/** Minimal recording stand-in for the spawn seam: captures (file, args, options), returns `result`. */
function fakeSpawn(result: { error?: Error & { code?: string }; status?: number | null; signal?: string | null }): {
  calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }>;
  deps: AcquireDeps;
} {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawn = (file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    return {
      status: result.status ?? null,
      signal: result.signal ?? null,
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  };
  return { calls, deps: { spawn: spawn as unknown as AcquireDeps["spawn"] } };
}

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(`spawn failed: ${code}`), { code });
}

const FD_ANCHORING = (() => {
  try {
    return fdAnchoringAvailable();
  } catch {
    return false;
  }
})();

describe("lock acquisition seam (darwin plan P3)", () => {
  it("exports the perl flock script constants (T-P1)", () => {
    expect(PERL_FLOCK_ARGS).toContain("-MFcntl=:flock");
    expect(PERL_FLOCK_ARGS).toContain("-MErrno=EWOULDBLOCK,EAGAIN");
    // Explicit Errno import + numeric `$!` comparison — no `%!`/`$!{…}` hash-key lookups (rev #8).
    expect(PERL_FLOCK_SCRIPT).not.toContain("%!");
    expect(PERL_FLOCK_SCRIPT).not.toContain("$!{");
    expect(PERL_FLOCK_ARGS[PERL_FLOCK_ARGS.length - 1]).toBe(PERL_FLOCK_SCRIPT);
  });

  it("maps perl spawn results fail-closed with fixed details (T-P2…T-P6)", () => {
    const cases: Array<{ name: string; result: Parameters<typeof fakeSpawn>[0]; expected: AcquireResult }> = [
      {
        name: "missing binary ⇒ fail: perl binary not found",
        result: { error: errno("ENOENT"), status: null, signal: null },
        expected: { kind: "fail", detail: "perl binary not found (fail closed)" },
      },
      {
        name: "spawnSync timeout ⇒ fail (never busy)",
        result: { error: errno("ETIMEDOUT"), status: null, signal: "SIGTERM" },
        expected: { kind: "fail", detail: "perl flock timed out after 5000ms (fail closed)" },
      },
      {
        name: "other spawn error ⇒ fail with the error",
        result: { error: errno("EACCES"), status: null, signal: null },
        expected: { kind: "fail", detail: expect.stringMatching(/^perl: /) as unknown as string },
      },
      {
        name: "killed by signal ⇒ fail (never busy)",
        result: { status: null, signal: "SIGKILL" },
        expected: { kind: "fail", detail: "perl flock killed by SIGKILL (fail closed)" },
      },
      {
        name: "exit 2 (fd 3 unusable) ⇒ fail",
        result: { status: 2 },
        expected: { kind: "fail", detail: "perl flock exited 2" },
      },
      {
        name: "exit 3 (non-conflict errno) ⇒ fail",
        result: { status: 3 },
        expected: { kind: "fail", detail: "perl flock exited 3" },
      },
      {
        name: "exit 255 (perl load failure) ⇒ fail",
        result: { status: 255 },
        expected: { kind: "fail", detail: "perl flock exited 255" },
      },
      { name: "exit 75 ⇒ busy", result: { status: 75 }, expected: "busy" },
      { name: "exit 0 ⇒ held", result: { status: 0 }, expected: "held" },
    ];
    for (const c of cases) {
      const { deps } = fakeSpawn(c.result);
      expect(perlFlockAcquire("/usr/bin/perl", deps)(3), c.name).toEqual(c.expected);
    }
    // The timeout detail carries the resolved timeout, not a constant.
    const { deps } = fakeSpawn({ error: errno("ETIMEDOUT"), status: null, signal: "SIGTERM" });
    expect(perlFlockAcquire("/usr/bin/perl", { ...deps, timeoutMs: 250 })(3)).toEqual({
      kind: "fail",
      detail: "perl flock timed out after 250ms (fail closed)",
    });
  });

  it("pins the perl spawn invocation (fixed env, stdio slot 3, 5s timeout)", () => {
    const { calls, deps } = fakeSpawn({ status: 0 });
    expect(perlFlockAcquire("/usr/bin/perl", deps)(17)).toBe("held");
    expect(calls).toEqual([
      {
        file: "/usr/bin/perl",
        args: [...PERL_FLOCK_ARGS],
        options: { stdio: ["ignore", "ignore", "ignore", 17], timeout: 5_000, env: { PATH: "/usr/bin:/bin" } },
      },
    ]);
  });

  it("probe and production acquire issue the same perl spawn (T-P8)", () => {
    // Production path: the resolver `withDirLock` will use on darwin, called directly.
    const prod = fakeSpawn({ status: 0 });
    const dir = mkdtempSync(join(tmpdir(), "lock-acquire-pin-"));
    const fd = openSync(join(dir, "probe.lock"), fsConstants.O_RDWR | fsConstants.O_CREAT, 0o600);
    try {
      expect(defaultLockAcquire({ platform: "darwin" }, prod.deps)(fd)).toBe("held");
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
    // Probe path: the SAME production resolver injected as the probe's acquire.
    const probe = fakeSpawn({ status: 0 });
    expect(defaultFlockProbe("darwin", { acquire: defaultLockAcquire({ platform: "darwin" }, probe.deps) })).toBe(true);
    expect(probe.calls.length).toBe(1);
    expect(prod.calls.length).toBe(1);
    const a = prod.calls[0]!;
    const b = probe.calls[0]!;
    expect(b.file).toBe(a.file);
    expect(b.args).toEqual(a.args);
    const { stdio: aStdio, ...aRest } = a.options as { stdio: unknown[] } & Record<string, unknown>;
    const { stdio: bStdio, ...bRest } = b.options as { stdio: unknown[] } & Record<string, unknown>;
    expect(bRest).toEqual(aRest); // timeout + fixed PATH env — identical
    expect(bStdio.slice(0, 3)).toEqual(aStdio.slice(0, 3)); // ["ignore","ignore","ignore"]
    expect(typeof bStdio[3]).toBe("number"); // our fd in slot 3 — only the NUMBER may differ
    expect(typeof aStdio[3]).toBe("number");
  });

  it("defaultLockAcquire selects the backend by platform (T-P9)", () => {
    const perl = fakeSpawn({ status: 0 });
    defaultLockAcquire({ platform: "darwin" }, perl.deps)(3);
    expect(perl.calls[0]!.file).toBe("/usr/bin/perl");
    expect(perl.calls[0]!.args).toEqual([...PERL_FLOCK_ARGS]);

    const fl = fakeSpawn({ status: 0 });
    defaultLockAcquire({ platform: "linux" }, fl.deps)(3);
    expect(fl.calls[0]!.file).toBe("flock");
    expect(fl.calls[0]!.args).toEqual(["-x", "-n", "-E", "75", "3"]);
    // Linux flock stays byte-identical: no env key at all.
    expect(fl.calls[0]!.options).toEqual({ stdio: ["ignore", "ignore", "ignore", 3], timeout: 5_000 });

    const p2 = fakeSpawn({ status: 0 });
    defaultLockAcquire({ platform: "darwin", perlBin: "/opt/perl" }, p2.deps)(3);
    expect(p2.calls[0]!.file).toBe("/opt/perl");
    const f2 = fakeSpawn({ status: 0 });
    defaultLockAcquire({ platform: "linux", flockBin: "/nonexistent/flock" }, f2.deps)(3);
    expect(f2.calls[0]!.file).toBe("/nonexistent/flock");

    // Unchanged Linux default under the plain P0 seam (flockBin compatibility).
    const f3 = fakeSpawn({ error: errno("ENOENT"), status: null, signal: null });
    expect(linuxFlockAcquire("/nonexistent/flock", f3.deps)(3)).toEqual({
      kind: "fail",
      detail: "flock binary not found (fail closed)",
    });
  });

  it("defaultFlockProbe(darwin) maps the injected acquire verdict (T-P9)", () => {
    expect(defaultFlockProbe("darwin", { acquire: () => "held" })).toBe(true);
    expect(defaultFlockProbe("darwin", { acquire: () => "busy" })).toBe(false);
    expect(defaultFlockProbe("darwin", { acquire: () => ({ kind: "fail", detail: "x" }) })).toBe(false);
    expect(
      defaultFlockProbe("darwin", {
        acquire: () => {
          throw new Error("probe blew up");
        },
      }),
    ).toBe(false);
  });

  // The fd-anchored directory paths resolve only via the platform path backend: Linux today,
  // darwin once P2's snapshot backend lands (hence the capability gate, not a platform check).
  describe.skipIf(!FD_ANCHORING)("with a real fd-anchored directory", () => {
    it("a replaced lock file ⇒ retry, then held once replacement stops (T-P7)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "lock-acquire-"));
      const dirFd = openDirPath(dir).fd;
      try {
        const lockPath = join(dir, ".lock");
        let replace = true;
        const acquire: LockAcquire = () => {
          if (replace) {
            replace = false;
            const tmp = join(dir, ".lock.new");
            writeFileSync(tmp, "");
            renameSync(tmp, lockPath);
          }
          return "held";
        };
        const r = await withSessionLock(dirFd, () => 42, { acquire, sleep: () => Promise.resolve(), timeoutMs: 5_000 });
        expect(r).toEqual({ ok: true, value: 42 });
      } finally {
        closeSync(dirFd);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a constantly replaced lock file ⇒ E_BUSY, the body never runs (T-P7)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "lock-acquire-"));
      const dirFd = openDirPath(dir).fd;
      try {
        const lockPath = join(dir, ".lock");
        const acquire: LockAcquire = () => {
          const tmp = join(dir, ".lock.new");
          writeFileSync(tmp, "");
          renameSync(tmp, lockPath);
          return "held";
        };
        let ran = 0;
        const r = await withSessionLock(
          dirFd,
          () => {
            ran += 1;
            return 42;
          },
          { acquire, sleep: () => Promise.resolve(), timeoutMs: 0 },
        );
        expect(r).toMatchObject({ ok: false, code: "E_BUSY" });
        expect(ran).toBe(0); // never a false hold
      } finally {
        closeSync(dirFd);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
