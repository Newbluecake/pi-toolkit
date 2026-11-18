/**
 * Darwin sysload host — injected-dependency tests (sysload darwin-plan §4.1, S0).
 *
 * Tier 1: the host is fully injected — the fake `run`, fake `execFile`, fake `spawnSync` and
 * fake `stat` answer from scripts, so NO real subprocess is started here. This file
 * deliberately never names the real child-process module so the lexical tier scan stays
 * clean; real-command discipline (SIGKILL/reaping/unref against live processes) is S0's
 * tests/integration/sysload-bounded-exec.test.ts, and live macOS sysctl/mount/ps smoke is
 * E-MAC (tests/integration/sysload-darwin.test.ts, S4).
 */
import { describe, expect, it } from "vitest";
import {
  createDarwinHost,
  probeDarwinHost,
  resolveSysloadHost,
  runBounded,
  type DarwinHost,
  type ProbeDeps,
  type RunDeps,
} from "../../../src/web-hub/protocol/sysload-darwin.js";

const RUN_ENV = { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

interface RunCall {
  file: string;
  args: readonly string[];
  o: { timeoutMs: number; maxBytes: number };
}

/** Fake `runBounded`: records every call, answers from the script (string | Error), never spawns. */
function fakeRun(script: (call: RunCall) => string | Error) {
  const calls: RunCall[] = [];
  const run = (file: string, args: readonly string[], o: { timeoutMs: number; maxBytes: number }): Promise<string> => {
    const call: RunCall = { file, args: [...args], o };
    calls.push(call);
    try {
      const answer = script(call);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    } catch (err) {
      return Promise.reject(err as Error);
    }
  };
  return { run, calls };
}

interface ExecRecord {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

interface FakeChild {
  unrefCalls: number;
  stdoutUnrefCalls: number;
  stderrUnrefCalls: number;
  kills: string[];
}

/** Fake `execFile`: records options, hands back an inert untrackable child, settles via microtask. */
function fakeExec(answer: (rec: ExecRecord, settle: (err: Error | null, stdout: string) => void) => void) {
  const records: ExecRecord[] = [];
  const children: FakeChild[] = [];
  const childTracker = (): FakeChild & {
    stdout: { unref(): void };
    stderr: { unref(): void };
    kill(sig: string): boolean;
    unref(): void;
  } => {
    const tracker: FakeChild = { unrefCalls: 0, stdoutUnrefCalls: 0, stderrUnrefCalls: 0, kills: [] };
    children.push(tracker);
    return {
      ...tracker,
      unref: () => {
        tracker.unrefCalls++;
      },
      stdout: {
        unref: () => {
          tracker.stdoutUnrefCalls++;
        },
      },
      stderr: {
        unref: () => {
          tracker.stderrUnrefCalls++;
        },
      },
      kill: (sig: string) => {
        tracker.kills.push(sig);
        return true;
      },
    };
  };
  const exec = ((
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
    callback: (err: Error | null, stdout: string) => void,
  ) => {
    const rec: ExecRecord = { file, args: [...args], options };
    records.push(rec);
    const child = childTracker();
    queueMicrotask(() => answer(rec, (err, stdout) => callback(err, stdout)));
    return child;
  }) as unknown as NonNullable<RunDeps["execFile"]>;
  return { exec, records, children };
}

describe("runBounded (fake exec: options, unref discipline, settle classification)", () => {
  it("passes the exact bounded options: fixed env (NOT inherited), SIGKILL, maxBuffer, windowsHide, utf8 — and never a raw timeout (see the I5 deviation note)", async () => {
    const { exec, records } = fakeExec((_rec, settle) => settle(null, "out\n"));
    await expect(
      runBounded("/usr/sbin/sysctl", ["-n", "hw.ncpu"], { timeoutMs: 800, maxBytes: 1024 }, { execFile: exec }),
    ).resolves.toBe("out\n");
    expect(records).toHaveLength(1);
    expect(records[0]!.options).toEqual({
      env: RUN_ENV,
      killSignal: "SIGKILL",
      maxBuffer: 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    // the timeout:0 trap is closed at the entry gate — no timeout value ever reaches the child
    expect("timeout" in records[0]!.options).toBe(false);
  });

  it("unrefs the child and BOTH stdio streams (I5: nothing the child owns keeps the loop alive)", async () => {
    const { exec, children } = fakeExec((_rec, settle) => settle(null, "x"));
    await runBounded("/bin/ps", [], { timeoutMs: 100, maxBytes: 64 }, { execFile: exec });
    expect(children[0]!.unrefCalls).toBe(1);
    expect(children[0]!.stdoutUnrefCalls).toBe(1);
    expect(children[0]!.stderrUnrefCalls).toBe(1);
  });

  it("rejects invalid timeoutMs with RangeError BEFORE any spawn (the timeout:0 trap)", async () => {
    const { exec, records } = fakeExec(() => {
      throw new Error("must not be called");
    });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5000, -0.5]) {
      const promise = runBounded("/bin/ps", [], { timeoutMs: bad, maxBytes: 64 }, { execFile: exec });
      await expect(promise, `timeoutMs=${bad}`).rejects.toThrow(RangeError);
    }
    expect(records).toHaveLength(0);
  });

  it("timeout expiry SIGKILLs the child and settles the promise as ETIMEDOUT on close", async () => {
    let captured: ((err: Error | null, stdout: string) => void) | undefined;
    const { exec, children } = fakeExec((_rec, settle) => {
      captured = settle;
    });
    const promise = runBounded("/bin/sleep", ["31"], { timeoutMs: 60, maxBytes: 64 }, { execFile: exec });
    await new Promise((r) => setTimeout(r, 140));
    expect(children[0]!.kills).toEqual(["SIGKILL"]);
    const killed = new Error("Command failed: /bin/sleep 31") as Error & { killed: boolean; signal: string | null };
    killed.killed = true;
    killed.signal = "SIGKILL";
    captured!(killed, "");
    await expect(promise).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });

  it("a Node-side ETIMEDOUT error (before our own timer flag) is still classified as the timeout", async () => {
    const { exec } = fakeExec((_rec, settle) => {
      const err = new Error("spawn ETIMEDOUT") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      settle(err, "");
    });
    await expect(runBounded("/bin/x", [], { timeoutMs: 800, maxBytes: 64 }, { execFile: exec })).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
  });

  it("non-zero exit / ENOENT / maxBuffer errors reject with the original error (no timeout rewrite)", async () => {
    for (const code of ["ENOENT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
      const { exec } = fakeExec((_rec, settle) => {
        const err = new Error(code) as NodeJS.ErrnoException;
        err.code = code;
        settle(err, "");
      });
      await expect(
        runBounded("/bin/x", [], { timeoutMs: 800, maxBytes: 64 }, { execFile: exec }),
        code,
      ).rejects.toMatchObject({ code });
    }
    const { exec: execExit } = fakeExec((_rec, settle) => {
      const err = new Error("Command failed: /bin/x") as Error & { status: number };
      err.status = 1;
      settle(err, "");
    });
    await expect(
      runBounded("/bin/x", [], { timeoutMs: 800, maxBytes: 64 }, { execFile: execExit }),
    ).rejects.toMatchObject({
      status: 1,
    });
  });
});

describe("createDarwinHost (fake run/stat: argv, budgets, failure swallowing)", () => {
  const SYSCTL_OUT = "{ 1.65 2.14 2.28 }\n48\n12\n";

  it("readHost: exact absolute sysctl argv + bounded budget, parsed into the reading", async () => {
    const { run, calls } = fakeRun(() => SYSCTL_OUT);
    const host = createDarwinHost({ run });
    await expect(host.readHost({ timeoutMs: 800 })).resolves.toEqual({
      loadavg: [1.65, 2.14, 2.28],
      memAvailPct: 48,
      cores: 12,
    });
    expect(calls).toEqual([
      {
        file: "/usr/sbin/sysctl",
        args: ["-n", "vm.loadavg", "kern.memorystatus_level", "hw.ncpu"],
        o: { timeoutMs: 800, maxBytes: 4096 },
      },
    ]);
  });

  it("readMounts: bare absolute mount(8) with the 1 MiB cap; listProcesses: ps -A with pid=,pcpu=,rss=,comm=", async () => {
    const { run, calls } = fakeRun((call) =>
      call.file === "/sbin/mount" ? "/dev/disk1s1 on / (apfs, local)\n" : "    1   0.0  20224 /sbin/launchd\n",
    );
    const host = createDarwinHost({ run });
    await expect(host.readMounts({ timeoutMs: 800 })).resolves.toBe("/dev/disk1s1 on / (apfs, local)\n");
    await expect(host.listProcesses({ timeoutMs: 900, maxPids: 2048 })).resolves.toEqual({
      procs: [{ pid: 1, comm: "launchd", cpuPct: 0, rssBytes: 20224 * 1024 }],
      truncated: false,
    });
    expect(calls).toEqual([
      { file: "/sbin/mount", args: [], o: { timeoutMs: 800, maxBytes: 1024 * 1024 } },
      {
        file: "/bin/ps",
        args: ["-A", "-o", "pid=,pcpu=,rss=,comm="],
        o: { timeoutMs: 900, maxBytes: 256 * 1024 },
      },
    ]);
  });

  it("invalid timeoutMs resolves undefined with the run NEVER called (C0 second gate; every method)", async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5000]) {
      const { run, calls } = fakeRun(() => {
        throw new Error("must not run");
      });
      const host: DarwinHost = createDarwinHost({ run });
      await expect(host.readHost({ timeoutMs: bad }), `readHost ${bad}`).resolves.toBeUndefined();
      await expect(host.readMounts({ timeoutMs: bad }), `readMounts ${bad}`).resolves.toBeUndefined();
      await expect(
        host.listProcesses({ timeoutMs: bad, maxPids: 16 }),
        `listProcesses ${bad}`,
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(0);
    }
    // listProcesses also refuses an invalid maxPids without starting anything
    const { run, calls } = fakeRun(() => {
      throw new Error("must not run");
    });
    const host = createDarwinHost({ run });
    for (const badPids of [0, -3, 2.5, Number.NaN]) {
      await expect(host.listProcesses({ timeoutMs: 800, maxPids: badPids })).resolves.toBeUndefined();
    }
    expect(calls).toHaveLength(0);
  });

  it("run failures (non-zero exit / timeout / ENOENT / oversized buffer) resolve undefined — never throw", async () => {
    for (const make of [
      () => Object.assign(new Error("nonzero"), { status: 1 }),
      () => Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      () => Object.assign(new Error("no binary"), { code: "ENOENT" }),
      () => Object.assign(new Error("too big"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
    ]) {
      const { run } = fakeRun(() => make());
      const host = createDarwinHost({ run });
      await expect(host.readHost({ timeoutMs: 800 })).resolves.toBeUndefined();
      await expect(host.readMounts({ timeoutMs: 800 })).resolves.toBeUndefined();
      await expect(host.listProcesses({ timeoutMs: 800, maxPids: 16 })).resolves.toBeUndefined();
    }
  });

  it("readHost with three unparsable lines resolves {} (fields independently missing), not undefined", async () => {
    const { run } = fakeRun(() => "x\ny\nz\n");
    const host = createDarwinHost({ run });
    await expect(host.readHost({ timeoutMs: 800 })).resolves.toEqual({});
  });

  it("parseMounts is the synchronous pure passthrough of the mount parser", () => {
    const host = createDarwinHost({ run: () => Promise.resolve("") });
    const mounts = host.parseMounts("/dev/disk3s1s1 on / (apfs, sealed, local)\n");
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ mountPoint: "/", fstype: "apfs", mountId: 0, majorMinor: "0:0" });
  });

  it("deviceOf: fs.stat().dev passthrough (number and bigint), failures and rejections resolve undefined", async () => {
    const ok = createDarwinHost({ stat: async () => ({ dev: 16777233 }) });
    await expect(ok.deviceOf("/")).resolves.toBe(16777233);
    const big = createDarwinHost({ stat: async () => ({ dev: 16777233n }) });
    await expect(big.deviceOf("/")).resolves.toBe(16777233);
    const rejected = createDarwinHost({
      stat: () => Promise.reject(new Error("EPERM")),
    });
    await expect(rejected.deviceOf("/remote")).resolves.toBeUndefined();
    const thrown = createDarwinHost({
      stat: () => {
        throw new Error("sync throw");
      },
    });
    await expect(thrown.deviceOf("/remote")).resolves.toBeUndefined();
    const absurd = createDarwinHost({ stat: async () => ({ dev: Number.NaN }) });
    await expect(absurd.deviceOf("/")).resolves.toBeUndefined();
  });

  it("localFilesystems is the darwin whitelist (apfs present, nfs/smbfs/autofs absent)", () => {
    const host = createDarwinHost({ run: () => Promise.resolve("") });
    expect(host.kind).toBe("darwin");
    expect(host.localFilesystems.has("apfs")).toBe(true);
    expect(host.localFilesystems.has("hfs")).toBe(true);
    for (const remote of ["nfs", "smbfs", "autofs", "afpfs", "devfs"]) {
      expect(host.localFilesystems.has(remote)).toBe(false);
    }
  });
});

describe("probeDarwinHost (fake spawnSync: one-shot hub startup probe)", () => {
  function fakeProbe(result: () => { error?: Error; status: number | null; stdout: string | number }) {
    const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    const spawnSyncFake = ((
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ): { error?: Error; status: number | null; stdout: string | number } => {
      calls.push({ file, args: [...args], options });
      return result();
    }) as unknown as NonNullable<ProbeDeps["spawnSync"]>;
    return { spawnSync: spawnSyncFake, calls };
  }

  it("accepts a real 0..100 memorystatus level with the constant 1000ms positive timeout", () => {
    const { spawnSync, calls } = fakeProbe(() => ({ status: 0, stdout: "46\n" }));
    expect(probeDarwinHost({ spawnSync })).toBe(true);
    expect(calls).toEqual([
      {
        file: "/usr/sbin/sysctl",
        args: ["-n", "kern.memorystatus_level"],
        options: { env: RUN_ENV, timeout: 1000, maxBuffer: 4096, encoding: "utf8" },
      },
    ]);
    expect(calls[0]!.options.timeout).toBe(1000);
  });

  it("rejects out-of-range, empty, timeout, ENOENT and throwing probes with false", () => {
    expect(probeDarwinHost({ spawnSync: fakeProbe(() => ({ status: 0, stdout: "101\n" })).spawnSync })).toBe(false);
    expect(probeDarwinHost({ spawnSync: fakeProbe(() => ({ status: 0, stdout: "" })).spawnSync })).toBe(false);
    expect(probeDarwinHost({ spawnSync: fakeProbe(() => ({ status: 0, stdout: "46abc" })).spawnSync })).toBe(false);
    expect(
      probeDarwinHost({
        spawnSync: fakeProbe(() => ({
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          status: null,
          stdout: "",
        })).spawnSync,
      }),
    ).toBe(false);
    expect(
      probeDarwinHost({
        spawnSync: fakeProbe(() => ({
          error: Object.assign(new Error("not found"), { code: "ENOENT" }),
          status: null,
          stdout: "",
        })).spawnSync,
      }),
    ).toBe(false);
    expect(probeDarwinHost({ spawnSync: fakeProbe(() => ({ status: 1, stdout: "46\n" })).spawnSync })).toBe(false);
    const throwing = ((): NonNullable<ProbeDeps["spawnSync"]> =>
      (() => {
        throw new Error("sandbox");
      }) as unknown as NonNullable<ProbeDeps["spawnSync"]>)();
    expect(probeDarwinHost({ spawnSync: throwing })).toBe(false);
  });
});

describe("resolveSysloadHost", () => {
  it("darwin resolves a host; every other platform resolves undefined (Linux default path untouched)", () => {
    expect(resolveSysloadHost("darwin")?.kind).toBe("darwin");
    for (const platform of ["linux", "win32", "freebsd", "sunos", "aix"] as const) {
      expect(resolveSysloadHost(platform), platform).toBeUndefined();
    }
    expect(resolveSysloadHost()?.kind ?? undefined).toBe(process.platform === "darwin" ? "darwin" : undefined);
  });
});
