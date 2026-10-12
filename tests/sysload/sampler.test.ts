import { describe, expect, it } from "vitest";
import { IoLedger } from "../../src/sysload/io-ledger.js";
import { sampleOnce } from "../../src/sysload/sampler.js";

const mountinfo = "1 0 8:1 / / rw - ext4 /dev/root rw\n";
const files: Record<string, string> = {
  "/proc/stat": "cpu 10 0 10 80 0 0 0 0 0 0\ncpu0 10 0 10 80 0 0 0 0 0 0\n",
  "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 500 kB\n",
  "/proc/loadavg": "1 2 3 1/10 42\n",
  "/proc/pressure/cpu": "some avg10=2.5 avg60=1 avg300=0 total=1\n",
};

describe("sysload sampler", () => {
  it("marks an unresolved symlink as unknown instead of lexically matching a mount", async () => {
    const result = await sampleOnce(
      {
        readFileSync: (path: string) => files[path] ?? "",
        realpath: async () => {
          throw new Error("unresolved");
        },
      },
      { home: "/home/user", cwd: "/", mono: () => 0, at: () => 1, mountinfoText: mountinfo },
      new IoLedger({ active: new Map(), capacity: 2 }),
    );
    expect(result.sample.disks.find((disk) => disk.label === "~")?.reading.kind).toBe("unresolved");
  });

  it("skips remote filesystems and reports ledger-full statfs as invalid", async () => {
    const remote = "1 0 0:42 / / rw - nfs server:/export rw\n";
    const remoteResult = await sampleOnce(
      {
        readFileSync: (path: string) => files[path] ?? "",
        statfs: async () => ({ blocks: 1, bfree: 0, bavail: 1, bsize: 1 }),
      },
      { home: "/", cwd: "/", mono: () => 0, at: () => 1, mountinfoText: remote },
      new IoLedger({ active: new Map(), capacity: 2 }),
    );
    expect(remoteResult.sample.disks.every((disk) => disk.reading.kind === "skipped")).toBe(true);

    const full = new IoLedger({
      active: new Map([
        ["held-a", 1],
        ["held-b", 1],
      ]),
      capacity: 2,
    });
    const fullResult = await sampleOnce(
      {
        readFileSync: (path: string) => files[path] ?? "",
        statfs: async () => ({ blocks: 1, bfree: 0, bavail: 1, bsize: 1 }),
      },
      { home: "/", cwd: "/", mono: () => 0, at: () => 1, mountinfoText: mountinfo },
      full,
    );
    expect(fullResult.sample.disks.every((disk) => disk.reading.kind === "invalid")).toBe(true);
  });

  it("uses bounded synchronous proc reads and validates statfs", async () => {
    const ledger = new IoLedger({ active: new Map(), capacity: 2 });
    const io = {
      readFileSync: (path: string) => files[path] ?? "",
      statfs: async () => ({ blocks: 100n, bfree: 20n, bavail: 10n, bsize: 4096n }),
    };
    const first = await sampleOnce(
      io,
      { home: "/", cwd: "/", mono: () => 0, at: () => 10, mountinfoText: mountinfo },
      ledger,
    );
    expect(first.sample.cpu.kind).toBe("invalid");
    expect(first.sample.mem).toMatchObject({ kind: "ok", value: { availPct: 50 } });
    expect(first.sample.disks.every((disk) => disk.reading.kind === "ok")).toBe(true);
    const nextFiles = { ...files, "/proc/stat": "cpu 20 0 20 160 0 0 0 0 0 0\ncpu0 20 0 20 160 0 0 0 0 0 0\n" };
    const second = await sampleOnce(
      { ...io, readFileSync: (path: string) => nextFiles[path] ?? "" },
      {
        home: "/",
        cwd: "/",
        previousCpu: first.nextCpu,
        previousMono: 0,
        mono: () => 5_000,
        at: () => 20,
        mountinfoText: mountinfo,
      },
      ledger,
    );
    expect(second.sample.cpu).toMatchObject({ kind: "ok", value: { busyPct: 20, psiPct: 2.5 } });
  });

  it("shows a mount only once when both display paths resolve to it", async () => {
    const io = {
      readFileSync: (path: string) => files[path] ?? "",
      realpath: async (p: string) => p,
      statfs: async () => ({ blocks: 100n, bfree: 20n, bavail: 10n, bsize: 4096n }),
    };
    const plan = { home: "/home/user", cwd: "/", mono: () => 0, at: () => 10 };

    // HOME lives on the root mount ⇒ only `~` is sampled, `/` is dropped.
    const same = await sampleOnce(
      io,
      { ...plan, mountinfoText: mountinfo },
      new IoLedger({ active: new Map(), capacity: 2 }),
    );
    expect(same.sample.disks.map((disk) => disk.label)).toEqual(["~"]);
    expect(same.sample.disks[0]?.reading.kind).toBe("ok");

    // HOME on its own mount ⇒ both paths are kept.
    const two = "1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:2 / /home/user rw - ext4 /dev/sda2 rw\n";
    const split = await sampleOnce(
      io,
      { ...plan, mountinfoText: two },
      new IoLedger({ active: new Map(), capacity: 2 }),
    );
    expect(split.sample.disks.map((disk) => disk.label)).toEqual(["~", "/"]);
  });
});
