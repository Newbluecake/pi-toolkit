/**
 * #27 P2 — unit tests for the secure preflight (tests/secure/preflight.ts, plan r3 D8–D11).
 *
 * Everything here is PURE INJECTION: no real lock, no mount, no child process, no real waits —
 * deliberately free of the D4 tier markers so it lives in tier1 (only the integration suite
 * tests/integration/secure-preflight-setup.test.ts spawns anything). Covers: the four-state
 * contract × fuse/private combinations (including fuse without unshare), every dirty reason,
 * the /tmp and lock-file validation matrices, fail-closed error conversion, the tests-only
 * FAKE injection, and the worker-side wiring error (inject → undefined throws).
 */
import { describe, expect, it } from "vitest";
import {
  gocryptfsMountPoints,
  parseFakeVerdict,
  preflightErrorVerdict,
  type PreflightDeps,
  type PreflightInput,
  renderCleanLine,
  renderPreflightFailure,
  runLockFileUnsafe,
  runLockPath,
  runPreflight,
  secureEnvVerdict,
  tmpRootUnsafe,
} from "./preflight.js";

const NO_MOUNTS = "22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw\n";
const OTHER_FUSE = "40 25 0:41 / /mnt/ssh fuse.sshfs sshfs#host rw - fuse.sshfs sshfs rw\n";

function mountLine(mnt: string): string {
  return `40 25 0:40 / ${mnt.replace(/ /g, "\\040")} rw,nosuid,nodev shared:40 - fuse.gocryptfs /data/cipher rw\n`;
}

const cleanInput = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  disabled: false,
  capability: { fuse: true, private: true },
  mountinfo: NO_MOUNTS,
  tmp: { tmpdir: "/tmp", realTmpdir: "/tmp" },
  runLock: { status: "acquired" },
  unreadableCount: 0,
  ...over,
});

describe("secureEnvVerdict — the D9 four-state contract", () => {
  it("incapable when fuse is absent — every other input is ignored, no reasons, silent", () => {
    for (const runLock of [
      { status: "skipped" },
      { status: "busy", holder: "holder pid 1" },
      { status: "unsafe", why: "/tmp lacks the sticky bit" },
    ] as const) {
      const v = secureEnvVerdict(
        cleanInput({
          capability: { fuse: false, private: false },
          mountinfo: NO_MOUNTS + mountLine("/home/me/secure/acme"),
          tmp: { tmpdir: "/tmp/link", realTmpdir: "/tmp/real" },
          runLock,
          unreadableCount: 9,
        }),
      );
      expect(v).toEqual({ state: "incapable", fuse: false, private: false, reasons: [], notes: [] });
    }
  });

  it("disabled wins over everything (the switch only disables the startup preflight)", () => {
    const v = secureEnvVerdict(
      cleanInput({
        disabled: true,
        runLock: { status: "busy", holder: "holder unknown" },
        mountinfo: NO_MOUNTS + mountLine("/vault"),
      }),
    );
    expect(v.state).toBe("disabled");
    expect(v.reasons).toEqual([]);
    expect(v.fuse).toBe(true); // capability is still probed and reported
    expect(v.notes.length).toBe(1);
    expect(v.notes[0]).toContain("PI_TOOLKIT_SECURE_PREFLIGHT=0");
  });

  it("clean when fuse is present and every check passes", () => {
    const v = secureEnvVerdict(cleanInput());
    expect(v).toEqual({ state: "clean", fuse: true, private: true, reasons: [], notes: [] });
  });

  it("clean with noise that never judges dirty: unreadable census and non-gocryptfs fuse mounts", () => {
    const v = secureEnvVerdict(cleanInput({ mountinfo: NO_MOUNTS + OTHER_FUSE, unreadableCount: 3 }));
    expect(v.state).toBe("clean");
    expect(v.notes.length).toBe(1);
    expect(v.notes[0]).toContain("unreadable same-uid processes: 3");
  });
});

describe("secureEnvVerdict — dirty reasons (D10)", () => {
  it("concurrent-run when the run lock is busy, with the holder description", () => {
    const v = secureEnvVerdict(cleanInput({ runLock: { status: "busy", holder: "holder pid 4242" } }));
    expect(v.state).toBe("dirty");
    expect(v.reasons.length).toBe(1);
    expect(v.reasons[0]).toContain("concurrent-run");
    expect(v.reasons[0]).toContain(runLockPath());
    expect(v.reasons[0]).toContain("holder pid 4242");
  });

  it("busy with holder unknown still names the lock path", () => {
    const v = secureEnvVerdict(cleanInput({ runLock: { status: "busy", holder: "holder unknown" } }));
    expect(v.reasons[0]).toContain("holder unknown");
  });

  it("run-lock-unsafe carries the validation detail", () => {
    const v = secureEnvVerdict(cleanInput({ runLock: { status: "unsafe", why: "/tmp lacks the sticky bit" } }));
    expect(v.state).toBe("dirty");
    expect(v.reasons[0]).toContain("run-lock-unsafe: /tmp lacks the sticky bit");
  });

  it("gocryptfs-mounted is a REASON only with private capability; the mounts are listed", () => {
    const dirty = secureEnvVerdict(
      cleanInput({ mountinfo: NO_MOUNTS + mountLine("/home/me/secure/acme") + mountLine("/tmp/other") }),
    );
    expect(dirty.state).toBe("dirty");
    expect(dirty.reasons.length).toBe(1);
    expect(dirty.reasons[0]).toContain("gocryptfs-mounted");
    expect(dirty.reasons[0]).toContain("/home/me/secure/acme");
    expect(dirty.reasons[0]).toContain("/tmp/other");
  });

  it("fuse WITHOUT unshare (private=false): the same mounts are only a note, state stays clean", () => {
    const v = secureEnvVerdict(
      cleanInput({
        capability: { fuse: true, private: false },
        mountinfo: NO_MOUNTS + mountLine("/home/me/secure/acme"),
      }),
    );
    expect(v.state).toBe("clean");
    expect(v.reasons).toEqual([]);
    expect(v.notes.length).toBe(1);
    expect(v.notes[0]).toContain("/home/me/secure/acme");
    expect(v.notes[0]).toContain("note only");
  });

  it("symlinked-tmpdir names both paths", () => {
    const v = secureEnvVerdict(cleanInput({ tmp: { tmpdir: "/tmp/link", realTmpdir: "/tmp/real" } }));
    expect(v.state).toBe("dirty");
    expect(v.reasons[0]).toContain("symlinked-tmpdir");
    expect(v.reasons[0]).toContain("/tmp/link");
    expect(v.reasons[0]).toContain("/tmp/real");
  });

  it("reasons accumulate in a deterministic order (lock, mounts, tmpdir)", () => {
    const v = secureEnvVerdict(
      cleanInput({
        runLock: { status: "busy", holder: "holder unknown" },
        mountinfo: NO_MOUNTS + mountLine("/vault"),
        tmp: { tmpdir: "/tmp/link", realTmpdir: "/tmp/real" },
      }),
    );
    expect(v.reasons.map((r) => r.split(":")[0])).toEqual(["concurrent-run", "gocryptfs-mounted", "symlinked-tmpdir"]);
  });
});

describe("mountinfo parsing", () => {
  it("extracts gocryptfs mount points, unescapes \\040, ignores other filesystems", () => {
    const info =
      NO_MOUNTS +
      OTHER_FUSE +
      mountLine("/home/me/secure/my\\040vault") +
      "41 26 0:42 / /media/plain rw - ext4 /dev/sdb1 rw\n";
    expect(gocryptfsMountPoints(info)).toEqual(["/home/me/secure/my vault"]);
    expect(gocryptfsMountPoints(NO_MOUNTS)).toEqual([]);
    expect(gocryptfsMountPoints("")).toEqual([]);
  });
});

describe("run-lock placement and validation (D11)", () => {
  it("the run lock lives at the literal /tmp, per uid — never derived from TMPDIR", () => {
    expect(runLockPath(1000)).toBe("/tmp/pi-toolkit-secure-tests-1000.lock");
    expect(runLockPath(0)).toBe("/tmp/pi-toolkit-secure-tests-0.lock");
    expect(runLockPath()).toMatch(/^\/tmp\/pi-toolkit-secure-tests-\d+\.lock$/);
  });

  it("tmpRootUnsafe: root-owned sticky directory is safe; everything else says why", () => {
    expect(tmpRootUnsafe({ isSymlink: false, isDirectory: true, uid: 0, sticky: true })).toBeNull();
    expect(tmpRootUnsafe({ isSymlink: true, isDirectory: false, uid: 0, sticky: false })).toContain("symlink");
    expect(tmpRootUnsafe({ isSymlink: false, isDirectory: false, uid: 0, sticky: true })).toContain("not a directory");
    expect(tmpRootUnsafe({ isSymlink: false, isDirectory: true, uid: 1000, sticky: true })).toContain("uid 1000");
    expect(tmpRootUnsafe({ isSymlink: false, isDirectory: true, uid: 0, sticky: false })).toContain("sticky");
  });

  it("runLockFileUnsafe: type, owner and group/other write bits; 0600 regular own file is safe", () => {
    const ok = { isSymlink: false, isRegular: true, uid: 1000, mode: 0o600 };
    expect(runLockFileUnsafe(ok, 1000)).toBeNull();
    expect(runLockFileUnsafe({ ...ok, mode: 0o400 }, 1000)).toBeNull(); // stricter is fine (write bits only)
    expect(runLockFileUnsafe({ ...ok, isSymlink: true }, 1000)).toContain("symlink");
    expect(runLockFileUnsafe({ ...ok, isRegular: false }, 1000)).toContain("not a regular file");
    expect(runLockFileUnsafe({ ...ok, uid: 0 }, 1000)).toContain("uid 0");
    expect(runLockFileUnsafe({ ...ok, mode: 0o620 }, 1000)).toContain("group/other-writable");
    expect(runLockFileUnsafe({ ...ok, mode: 0o602 }, 1000)).toContain("group/other-writable");
    expect(runLockFileUnsafe({ ...ok, mode: 0o666 }, 1000)).toContain("group/other-writable");
  });
});

describe("rendering (identical text for the global print and the worker error)", () => {
  it("dirty render: [secure-preflight] header, every reason, and the D10 fix commands", () => {
    const text = renderPreflightFailure(
      secureEnvVerdict(cleanInput({ mountinfo: NO_MOUNTS + mountLine("/home/me/secure/acme") })),
    );
    expect(text).toContain("[secure-preflight]");
    expect(text).toContain("gocryptfs-mounted");
    expect(text).toContain("/home/me/secure/acme");
    expect(text).toContain("pi-secure lock");
    expect(text).toContain("pi-secure status");
    expect(text).toContain("fusermount3 -u");
    expect(text).toContain("environment failure");
  });

  it("each reason gets its fix: wait, #28, lock-file repair, unknown code gets the generic line", () => {
    const v = secureEnvVerdict(
      cleanInput({
        runLock: { status: "busy", holder: "holder unknown" },
        tmp: { tmpdir: "/tmp/l", realTmpdir: "/tmp/r" },
      }),
    );
    // unsafe is covered by the fixture above only in part — build the unsafe case separately
    const unsafe = secureEnvVerdict(cleanInput({ runLock: { status: "unsafe", why: "/tmp lacks the sticky bit" } }));
    const text = renderPreflightFailure(v) + "\n" + renderPreflightFailure(unsafe);
    expect(text).toContain("wait for that round");
    expect(text).toContain("#28");
    expect(text).toContain("repair the offending /tmp or lock-file");
    expect(renderPreflightFailure({ ...v, reasons: ["weird-reason: x"] })).toContain(
      "resolve the condition described above",
    );
  });

  it("preflight-error gets its own fail-closed fix line", () => {
    expect(renderPreflightFailure(preflightErrorVerdict("boom"))).toContain("preflight-error: boom");
    expect(renderPreflightFailure(preflightErrorVerdict("boom"))).toContain("not a flake");
  });

  it("clean render is exactly one line", () => {
    expect(renderCleanLine(secureEnvVerdict(cleanInput()), "/tmp/pi-toolkit-secure-tests-1000.lock")).toBe(
      "[secure-preflight] clean (fuse=true, private=true); run lock held: /tmp/pi-toolkit-secure-tests-1000.lock",
    );
    const withNotes = secureEnvVerdict(cleanInput({ unreadableCount: 2 }));
    const line = renderCleanLine(withNotes, "/lock");
    expect(line).not.toContain("\n");
    expect(line).toContain("unreadable same-uid processes: 2");
  });

  it("verdicts stay JSON-round-trippable (they cross the provide/inject RPC boundary)", () => {
    const v = secureEnvVerdict(
      cleanInput({
        mountinfo: NO_MOUNTS + mountLine("/v"),
        unreadableCount: 1,
        runLock: { status: "busy", holder: "h" },
      }),
    );
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });
});

describe("parseFakeVerdict (tests-only injection; malformed input fails closed)", () => {
  it("parses a full verdict", () => {
    expect(parseFakeVerdict('{"state":"dirty","fuse":true,"private":false,"reasons":["r1"],"notes":["n1"]}')).toEqual({
      state: "dirty",
      fuse: true,
      private: false,
      reasons: ["r1"],
      notes: ["n1"],
    });
  });

  it("rejects non-objects, bad states, non-booleans, non-string-array fields", () => {
    for (const bad of [
      "[]",
      '"dirty"',
      '{"state":"nope","fuse":true,"private":true,"reasons":[],"notes":[]}',
      '{"state":"clean","fuse":1,"private":true,"reasons":[],"notes":[]}',
      '{"state":"clean","fuse":true,"private":true,"reasons":"x","notes":[]}',
      '{"state":"clean","fuse":true,"private":true,"reasons":[],"notes":[1]}',
    ]) {
      expect(() => parseFakeVerdict(bad), bad).toThrow(/PI_TOOLKIT_SECURE_PREFLIGHT_FAKE/);
    }
    expect(() => parseFakeVerdict("{not json")).toThrow(); // raw JSON error — runPreflight wraps it
  });
});

describe("runPreflight — pipeline order and fail-closed behaviour (all deps injected)", () => {
  const baseDeps = (over: Partial<PreflightDeps> = {}): PreflightDeps & { calls: string[] } => {
    const calls: string[] = [];
    const inner: PreflightDeps = {
      capability: () => ({ fuse: true, private: true }),
      probeRunLock: async () => ({ outcome: { status: "acquired" }, release: () => calls.push("release") }),
      readMountinfo: () => NO_MOUNTS,
      tmpPair: () => ({ tmpdir: "/tmp", realTmpdir: "/tmp" }),
      countUnreadable: () => 0,
      ...over,
    };
    return {
      calls,
      capability: () => {
        calls.push("capability");
        return inner.capability();
      },
      probeRunLock: async () => {
        calls.push("lock");
        return inner.probeRunLock();
      },
      readMountinfo: () => {
        calls.push("mounts");
        return inner.readMountinfo();
      },
      tmpPair: () => {
        calls.push("tmp");
        return inner.tmpPair();
      },
      countUnreadable: () => {
        calls.push("unreadable");
        return inner.countUnreadable();
      },
    };
  };

  it("fake wins before anything else: no capability, no lock, no checks", async () => {
    const deps = baseDeps();
    const { verdict, release } = await runPreflight(
      {
        PI_TOOLKIT_SECURE_PREFLIGHT_FAKE: '{"state":"incapable","fuse":false,"private":false,"reasons":[],"notes":[]}',
      },
      deps,
    );
    expect(verdict.state).toBe("incapable");
    expect(deps.calls).toEqual([]);
    expect(release).toBeUndefined();
  });

  it("a malformed fake becomes a preflight-error dirty verdict (fail closed), never a throw", async () => {
    const { verdict } = await runPreflight({ PI_TOOLKIT_SECURE_PREFLIGHT_FAKE: "{oops" }, baseDeps());
    expect(verdict.state).toBe("dirty");
    expect(verdict.reasons[0]).toContain("preflight-error");
  });

  it("disabled: capability probed, but no lock and no checks (D9)", async () => {
    const deps = baseDeps();
    const { verdict } = await runPreflight({ PI_TOOLKIT_SECURE_PREFLIGHT: "0" }, deps);
    expect(verdict.state).toBe("disabled");
    expect(deps.calls).toEqual(["capability"]);
  });

  it("incapable: no lock, no checks", async () => {
    const deps = baseDeps({
      capability: () => ({ fuse: false, private: false }),
    });
    const { verdict } = await runPreflight({}, deps);
    expect(verdict.state).toBe("incapable");
    expect(deps.calls).toEqual(["capability"]);
  });

  it("fuse: lock first, then mounts/tmp/unreadable; the release fn is passed through", async () => {
    const deps = baseDeps();
    const { verdict, release } = await runPreflight({}, deps);
    expect(verdict.state).toBe("clean");
    expect(deps.calls).toEqual(["capability", "lock", "mounts", "tmp", "unreadable"]);
    release?.();
    expect(deps.calls).toContain("release");
  });

  it("a throwing dep converts to preflight-error dirty and still returns an acquired release", async () => {
    const deps = baseDeps({
      readMountinfo: () => {
        throw new Error("mountinfo exploded");
      },
    });
    const { verdict, release } = await runPreflight({}, deps);
    expect(verdict.state).toBe("dirty");
    expect(verdict.reasons[0]).toContain("preflight-error: mountinfo exploded");
    expect(release).toBeDefined(); // acquired lock stays held until teardown (D9 dirty row)
    release?.();
  });

  it("a throwing capability probe also fails closed", async () => {
    const deps = baseDeps({
      capability: () => {
        throw new Error("probe exploded");
      },
    });
    const { verdict } = await runPreflight({}, deps);
    expect(verdict.state).toBe("dirty");
    expect(verdict.reasons[0]).toContain("preflight-error: probe exploded");
  });
});

describe("worker wiring (tests/setup/secure-preflight.setup.ts)", () => {
  it("inject('secureEnv') === undefined (this tier1 worker was never provided one) ⇒ the setup module throws fail-closed", async () => {
    await expect(import("../setup/secure-preflight.setup.js")).rejects.toThrow(
      /\[secure-preflight\] wiring error: `secureEnv` was not provided/,
    );
  });
});
