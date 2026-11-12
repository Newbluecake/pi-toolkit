/** Exercise the ACTUAL adapters with injected fs/spawn, never host proc or tools. */
import { describe, expect, it } from "vitest";
import {
  countUnreadableSameUidProcesses,
  detectSecureCapability,
  probeFuseDevice,
  runPreflight,
  type CapabilityProbeDeps,
  type CensusDeps,
  type PreflightDeps,
} from "./preflight.js";
import { awaitNoForeignGocryptfs } from "./private-real-harness.js";

function fault(code: string): Error & { code: string } {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}
const ok = { status: 0, signal: null, stderr: "" };
function capability(over: Partial<CapabilityProbeDeps> = {}): CapabilityProbeDeps {
  return {
    platform: "linux",
    gocryptfs: { binding: { selectedPath: "/synthetic/tool", realPath: "/synthetic/tool" } },
    fuseUsable: () => true,
    spawn: () => ok,
    ...over,
  };
}
function census(over: Partial<CensusDeps> = {}): CensusDeps {
  return {
    uid: 1000,
    names: () => ["self", "1", "2"],
    owner: (p) => (p.endsWith("/1") ? 1000 : 2000),
    readlink: () => "mnt:[fake]",
    ...over,
  };
}
const external = "40 25 0:40 / /external rw - fuse.gocryptfs cipher rw\n";
const base: PreflightDeps = {
  capability: () => ({ fuse: true, private: true }),
  probeRunLock: async () => ({ outcome: { status: "acquired" }, release: undefined }),
  readMountinfo: () => external,
  tmpPair: () => ({ tmpdir: "/tmp", realTmpdir: "/tmp" }),
  countUnreadable: () => 0,
};

describe("real census adapter fault classification", () => {
  it("only same uid namespace links are read", () => {
    const paths: string[] = [];
    expect(
      countUnreadableSameUidProcesses(
        census({
          readlink: (p) => {
            paths.push(p);
            return "mnt";
          },
        }),
      ),
    ).toBe(0);
    expect(paths).toEqual(["/proc/1/ns/mnt"]);
  });
  it.each(["ENOENT", "ESRCH"])("%s raced process exit is ignored", (code) => {
    expect(
      countUnreadableSameUidProcesses(
        census({
          readlink: () => {
            throw fault(code);
          },
        }),
      ),
    ).toBe(0);
  });
  it.each(["EACCES", "EPERM"])("%s permission census is a visible note", async (code) => {
    const count = () =>
      countUnreadableSameUidProcesses(
        census({
          readlink: () => {
            throw fault(code);
          },
        }),
      );
    expect(count()).toBe(1);
    const { verdict } = await runPreflight({}, { ...base, countUnreadable: count });
    expect(verdict.state).toBe("external-mounts");
    expect(verdict.notes[0]).toContain("processes: 1");
  });
  it.each(["names", "owner", "readlink"] as const)(
    "%s unexpected I/O cannot be hidden by external-only skip",
    async (key) => {
      const d = census({
        [key]: () => {
          throw fault("EIO");
        },
      });
      expect(() => countUnreadableSameUidProcesses(d)).toThrow("synthetic EIO");
      const { verdict } = await runPreflight(
        {},
        { ...base, countUnreadable: () => countUnreadableSameUidProcesses(d) },
      );
      expect(verdict.state).toBe("dirty");
      expect(verdict.reasons[0]).toContain("EIO");
    },
  );
  it("even permission failure enumerating /proc fails, not empty success", () => {
    expect(() =>
      countUnreadableSameUidProcesses(
        census({
          names: () => {
            throw fault("EACCES");
          },
        }),
      ),
    ).toThrow("EACCES");
  });
});

describe("real capability adapter fault classification", () => {
  it("FUSE filesystem adapter checks type and access, tolerating only known unavailable conditions", async () => {
    let accesses = 0;
    const fs = {
      isCharacterDevice: () => true,
      access: () => {
        accesses++;
      },
    };
    expect(probeFuseDevice(fs)).toBe(true);
    expect(accesses).toBe(1);
    expect(probeFuseDevice({ ...fs, isCharacterDevice: () => false })).toBe(false);
    expect(accesses).toBe(1);
    for (const code of ["ENOENT", "ENODEV", "EACCES", "EPERM"]) {
      expect(
        probeFuseDevice({
          ...fs,
          access: () => {
            throw fault(code);
          },
        }),
      ).toBe(false);
    }
    for (const key of ["isCharacterDevice", "access"]) {
      const broken = {
        ...fs,
        [key]: () => {
          throw fault("EIO");
        },
      };
      expect(() => probeFuseDevice(broken)).toThrow("EIO");
      const { verdict } = await runPreflight(
        {},
        {
          ...base,
          capability: () => detectSecureCapability(capability({ fuseUsable: () => probeFuseDevice(broken) })),
        },
      );
      expect(verdict.state).toBe("dirty");
      expect(verdict.reasons[0]).toContain("EIO");
    }
  });
  it("known absent binary and non-linux are incapable", () => {
    expect(detectSecureCapability(capability({ platform: "other" }))).toEqual({ fuse: false, private: false });
    expect(detectSecureCapability(capability({ gocryptfs: { reason: "missing gocryptfs" } }))).toEqual({
      fuse: false,
      private: false,
    });
    expect(detectSecureCapability(capability({ spawn: () => ({ ...ok, status: 1 }) }))).toEqual({
      fuse: false,
      private: false,
    });
  });
  it("known unusable fuse / unsupported namespaces preserve private self-gating", () => {
    for (const which of ["fuse", "namespace"]) {
      const d = capability({
        fuseUsable: () => which !== "fuse",
        spawn: (cmd) => {
          if (which === "namespace" && cmd === "unshare")
            return { ...ok, status: 1, stderr: "unshare: Operation not permitted" };
          return ok;
        },
      });
      expect(detectSecureCapability(d)).toEqual({ fuse: true, private: false });
    }
    expect(detectSecureCapability(capability())).toEqual({ fuse: true, private: true });
  });
  it.each(["lookup", "namespace"])("%s startup failure never becomes unavailable", async (stage) => {
    const d = capability({
      spawn: (cmd, args) => {
        if ((stage === "lookup" && args[1]?.startsWith("command")) || (stage === "namespace" && cmd === "unshare"))
          return { status: null, signal: null, error: fault("EIO") };
        return ok;
      },
    });
    expect(() => detectSecureCapability(d)).toThrow("EIO");
    const { verdict } = await runPreflight({}, { ...base, capability: () => detectSecureCapability(d) });
    expect(verdict.state).toBe("dirty");
    expect(verdict.reasons[0]).toContain("EIO");
  });
  it.each([
    { status: null, signal: "SIGTERM" },
    { status: null, signal: null, error: fault("ENOENT") },
    { status: 2, signal: null, stderr: "unexpected I/O" },
    { status: 1, signal: null, stderr: "Input/output error" },
    { status: 1, signal: null, stderr: "unshare: Operation not permitted\nInput/output error" },
    { status: null, signal: null, error: fault("ETIMEDOUT") },
  ])("unexpected namespace result %j fails", (result) => {
    expect(() => detectSecureCapability(capability({ spawn: (cmd) => (cmd === "unshare" ? result : ok) }))).toThrow(
      "capability",
    );
  });
  it("bad selected binary metadata is not missing capability", () => {
    expect(() => detectSecureCapability(capability({ gocryptfs: { reason: "gocryptfs: unexpected EIO" } }))).toThrow(
      "binding",
    );
  });
});

describe("runtime mountguard still FAILS; no widening of startup-only skip", () => {
  const line = (p: string) => `40 25 0:40 / ${p} rw - fuse.gocryptfs cipher rw\n`;
  it("owned mounts excluded with a slash boundary; similar prefix foreign remains failed and memoized", async () => {
    const memo: { timedOut?: string } = {};
    let now = 0;
    let reads = 0;
    const d = {
      readMountinfo: () => {
        reads++;
        return line("/owned/mnt") + line("/owned-other/mnt");
      },
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      memo,
      windowMs: 1000,
    };
    await expect(awaitNoForeignGocryptfs(null, "/owned", d)).rejects.toThrow("/owned-other/mnt");
    expect(memo.timedOut).not.toContain(" /owned/mnt ");
    expect(now).toBe(1000);
    const before = reads;
    await expect(awaitNoForeignGocryptfs(null, "/owned", d)).rejects.toThrow("/owned-other/mnt");
    expect(reads).toBe(before);
    let ownedReads = 0;
    let sleeps = 0;
    await awaitNoForeignGocryptfs(null, "/owned", {
      ...d,
      memo: {},
      readMountinfo: () => {
        ownedReads++;
        return line("/owned/mnt");
      },
      sleep: async () => {
        sleeps++;
      },
    });
    expect(ownedReads).toBe(1);
    expect(sleeps).toBe(0);
  });
  it("clean startup followed by foreign mount is a runtime failure, never a skip", async () => {
    const { verdict } = await runPreflight({}, { ...base, readMountinfo: () => "" });
    expect(verdict.state).toBe("clean");
    await expect(
      awaitNoForeignGocryptfs(null, "/owned", { readMountinfo: () => external, now: () => 0, windowMs: 0, memo: {} }),
    ).rejects.toThrow("foreign fuse.gocryptfs");
  });
});
