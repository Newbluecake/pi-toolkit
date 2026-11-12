/** Synthetic secure gate tests: no real probes, locks, proc reads, mounts or timers. */
import { describe, expect, it } from "vitest";
import type { Suite, Task } from "@vitest/runner";
import { skipSecureTree } from "../setup/secure-preflight.runner.js";
import { setupSecurePreflight } from "../setup/secure-preflight.global.js";
import type { GlobalSetupContext } from "vitest/node";
import {
  gocryptfsMountPoints,
  preflightErrorVerdict,
  renderCleanLine,
  renderExternalSkip,
  renderPreflightFailure,
  runLockFileUnsafe,
  runLockPath,
  runPreflight,
  secureEnvVerdict,
  tmpRootUnsafe,
  validateSecureEnv,
  type PreflightDeps,
  type PreflightInput,
} from "./preflight.js";

const MOUNT = "40 25 0:40 / /external\\040vault\\011tab\\012line\\134slash rw - fuse.gocryptfs cipher rw\n";
const cleanInput = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  capability: { fuse: true, private: true },
  mountinfo: "",
  tmp: { tmpdir: "/tmp", realTmpdir: "/tmp" },
  runLock: { status: "acquired" },
  unreadableCount: 0,
  ...over,
});
function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    capability: () => ({ fuse: true, private: true }),
    probeRunLock: async () => ({ outcome: { status: "acquired" }, release: undefined }),
    readMountinfo: () => "",
    tmpPair: () => ({ tmpdir: "/tmp", realTmpdir: "/tmp" }),
    countUnreadable: () => 0,
    ...over,
  };
}

describe("secure verdict: only external mounts skip, other errors dominate", () => {
  it("clean and incapable keep their original meanings", () => {
    expect(secureEnvVerdict(cleanInput()).state).toBe("clean");
    expect(secureEnvVerdict(cleanInput({ capability: { fuse: false, private: false } })).state).toBe("incapable");
    expect(secureEnvVerdict(cleanInput({ mountinfo: "40 25 0:40 / /ssh rw - fuse.sshfs ssh rw" })).state).toBe("clean");
  });
  it.each([true, false])("external-only skips at fuse level, private=%s", (priv) => {
    const v = secureEnvVerdict(cleanInput({ capability: { fuse: true, private: priv }, mountinfo: MOUNT }));
    expect(v.state).toBe("external-mounts");
    expect(v.reasons).toEqual([]);
    expect(v.externalMountPoints).toEqual(["/external vault\ttab\nline\\slash"]);
    expect(renderExternalSkip(v)).toContain(JSON.stringify(v.externalMountPoints));
    expect(renderExternalSkip(v)).toContain("coverage NOT RUN");
    expect(renderExternalSkip(v).split("\n")).toHaveLength(1);
    expect(validateSecureEnv(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
  it.each([
    { runLock: { status: "busy", holder: "holder pid 42" } },
    { runLock: { status: "unsafe", why: "unsafe lock" } },
    { tmp: { tmpdir: "/tmp/link", realTmpdir: "/tmp/physical" } },
  ] satisfies Partial<PreflightInput>[])("external + %j stays dirty", (over) => {
    const v = secureEnvVerdict(cleanInput({ mountinfo: MOUNT, ...over }));
    expect(v.state).toBe("dirty");
    expect(v.reasons).toHaveLength(1);
    expect(renderPreflightFailure(v)).toContain("not the only error");
    expect(renderPreflightFailure(v)).toContain("environment failure");
  });
  it("census permissions are notes, not errors; mount escapes all decode", () => {
    expect(secureEnvVerdict(cleanInput({ unreadableCount: 3 })).notes[0]).toContain("processes: 3");
    expect(gocryptfsMountPoints(MOUNT)).toEqual(["/external vault\ttab\nline\\slash"]);
    expect(gocryptfsMountPoints("garbage")).toEqual([]);
    expect(renderCleanLine(secureEnvVerdict(cleanInput()), "/lock")).toBe(
      "[secure-preflight] clean (fuse=true, private=true); run lock held: /lock",
    );
  });
});

describe("run-lock safety unchanged", () => {
  it("literal /tmp per uid, root sticky directory and restrictive owned regular file only", () => {
    expect(runLockPath(1000)).toBe("/tmp/pi-toolkit-secure-tests-1000.lock");
    const t = { isSymlink: false, isDirectory: true, uid: 0, sticky: true };
    expect(tmpRootUnsafe(t)).toBeNull();
    for (const bad of [{ isSymlink: true }, { isDirectory: false }, { uid: 1000 }, { sticky: false }])
      expect(tmpRootUnsafe({ ...t, ...bad })).not.toBeNull();
    const l = { isSymlink: false, isRegular: true, uid: 1000, mode: 0o600 };
    expect(runLockFileUnsafe(l, 1000)).toBeNull();
    expect(runLockFileUnsafe({ ...l, mode: 0o400 }, 1000)).toBeNull();
    for (const bad of [{ isSymlink: true }, { isRegular: false }, { uid: 0 }, { mode: 0o620 }, { mode: 0o602 }])
      expect(runLockFileUnsafe({ ...l, ...bad }, 1000)).not.toBeNull();
  });
});

describe("explicit dependency pipeline and lock lifecycle", () => {
  it("external mounts never short-circuit remaining checks, and sampled facts stay frozen", async () => {
    const calls: string[] = [];
    let sampledMounts = MOUNT;
    const { verdict } = await runPreflight(
      {},
      deps({
        probeRunLock: async () => {
          calls.push("lock");
          return { outcome: { status: "acquired" }, release: undefined };
        },
        readMountinfo: () => {
          calls.push("mounts");
          return sampledMounts;
        },
        tmpPair: () => {
          calls.push("tmp");
          return { tmpdir: "/tmp", realTmpdir: "/tmp" };
        },
        countUnreadable: () => {
          calls.push("census");
          return 0;
        },
      }),
    );
    sampledMounts = "";
    expect(calls).toEqual(["lock", "mounts", "tmp", "census"]);
    expect(verdict.state).toBe("external-mounts");
    expect(verdict.externalMountPoints).toEqual(["/external vault\ttab\nline\\slash"]);
  });
  it.each([{}, { PI_TOOLKIT_SECURE_PREFLIGHT: "0" }, { PI_TOOLKIT_SECURE_PREFLIGHT_FAKE: '{"state":"clean"}' }])(
    "legacy env cannot override dirty facts: %j",
    async (env) => {
      const { verdict } = await runPreflight(
        env,
        deps({ readMountinfo: () => MOUNT, tmpPair: () => ({ tmpdir: "/link", realTmpdir: "/physical" }) }),
      );
      expect(verdict.state).toBe("dirty");
      expect(verdict.reasons[0]).toContain("symlinked-tmpdir");
    },
  );
  it.each(["capability", "probeRunLock", "readMountinfo", "tmpPair", "countUnreadable"] as const)(
    "%s exception fails closed, never external skip",
    async (key) => {
      const d = deps({ readMountinfo: () => MOUNT });
      const broken = {
        ...d,
        [key]: () => {
          throw new Error(`${key} I/O fault`);
        },
      };
      const { verdict } = await runPreflight({}, broken);
      expect(verdict.state).toBe("dirty");
      expect(verdict.reasons[0]).toContain(`${key} I/O fault`);
    },
  );
  it.each(["clean", "external-mounts", "dirty"])(
    "%s global exit releases acquired lock exactly once",
    async (state) => {
      let releases = 0;
      let provides = 0;
      const ctx = {
        provide: () => {
          provides++;
        },
      } as unknown as GlobalSetupContext;
      const d = deps({
        probeRunLock: async () => ({
          outcome: { status: "acquired" },
          release: () => {
            releases++;
          },
        }),
        readMountinfo: () => (state === "clean" ? "" : MOUNT),
        tmpPair: () => ({ tmpdir: "/tmp", realTmpdir: state === "dirty" ? "/physical" : "/tmp" }),
      });
      if (state === "dirty") await expect(setupSecurePreflight(ctx, d)).rejects.toThrow("symlinked-tmpdir");
      else {
        const teardown = await setupSecurePreflight(ctx, d);
        expect(releases).toBe(0);
        teardown();
      }
      expect(provides).toBe(1);
      expect(releases).toBe(1);
    },
  );
  it.each(["readMountinfo", "tmpPair", "countUnreadable"] as const)(
    "%s fault after acquire releases before global failure",
    async (key) => {
      let releases = 0;
      const d = deps({
        probeRunLock: async () => ({
          outcome: { status: "acquired" },
          release: () => {
            releases++;
          },
        }),
        readMountinfo: () => MOUNT,
        [key]: () => {
          throw new Error(`${key} fault after acquire`);
        },
      });
      await expect(setupSecurePreflight({ provide: () => {} } as unknown as GlobalSetupContext, d)).rejects.toThrow(
        `${key} fault after acquire`,
      );
      expect(releases).toBe(1);
    },
  );
  it("provide failure releases; incapable never acquires", async () => {
    let releases = 0;
    await expect(
      setupSecurePreflight(
        {
          provide: () => {
            throw new Error("broken provide");
          },
        } as unknown as GlobalSetupContext,
        deps({
          probeRunLock: async () => ({
            outcome: { status: "acquired" },
            release: () => {
              releases++;
            },
          }),
        }),
      ),
    ).rejects.toThrow("broken provide");
    expect(releases).toBe(1);
    const { verdict, release } = await runPreflight(
      {},
      deps({
        capability: () => ({ fuse: false, private: false }),
        probeRunLock: () => {
          throw new Error("must not lock");
        },
      }),
    );
    expect(verdict.state).toBe("incapable");
    expect(release).toBeUndefined();
  });
});

describe("wire schema is fail-closed", () => {
  it("accepts all produced states", () => {
    for (const v of [
      secureEnvVerdict(cleanInput()),
      secureEnvVerdict(cleanInput({ mountinfo: MOUNT })),
      preflightErrorVerdict("boom"),
      secureEnvVerdict(cleanInput({ capability: { fuse: false, private: false } })),
    ])
      expect(validateSecureEnv(v)).toBe(v);
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { state: "disabled" },
    ...[
      { state: "unknown" },
      { fuse: 1 },
      { notes: [1] },
      { externalMountPoints: "mount" },
      { state: "external-mounts" },
      { state: "dirty" },
      { reasons: ["unknown reason"] },
      { state: "external-mounts", externalMountPoints: ["/mount"], reasons: ["other error"] },
    ].map((over) => ({ ...secureEnvVerdict(cleanInput()), ...over })),
  ])("rejects %j", (value) => {
    expect(() => validateSecureEnv(value)).toThrow("[secure-preflight] wiring error");
  });
});

describe("skip tree preserves failures", () => {
  function tree(): Suite {
    return {
      type: "suite",
      mode: "run",
      meta: {},
      tasks: [{ type: "suite", mode: "run", meta: {}, tasks: [{ type: "test", mode: "run", meta: {} }] }],
    } as Suite;
  }
  it("marks every descendant and publishes reporter metadata/results", () => {
    const t = tree();
    const published: Task[] = [];
    expect(skipSecureTree(t, "external reason", (task) => published.push(task))).toBe(true);
    expect(published).toHaveLength(3);
    for (const task of published) {
      expect(task.mode).toBe("skip");
      expect(task.result?.state).toBe("skip");
      expect(task.meta.securePreflightSkip).toBe("external reason");
    }
  });
  it.each([false, true])("never erases a %s child/file collection failure", (child) => {
    const t = tree();
    const target = child ? t.tasks[0]! : t;
    target.result = { state: "fail", errors: [{ message: "collection exploded" }] };
    expect(
      skipSecureTree(t, "external reason", () => {
        throw new Error("must not publish");
      }),
    ).toBe(false);
    expect(target.result.state).toBe("fail");
    expect(t.mode).toBe("run");
  });
});
