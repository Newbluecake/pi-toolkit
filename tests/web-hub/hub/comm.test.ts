/**
 * `hub/comm.ts` (`setProcessComm`): best-effort kernel comm naming for the hub's own processes.
 * Contract under test: writes `/proc/self/comm` on Linux via an injectable writer, is a no-op
 * off Linux and for an empty name, and swallows every writer error (a display nicety must never
 * break hub startup). Plus one real-syscall round trip on Linux (write a scratch name, read it
 * back, restore the original) — the scratch name is neither `pi` nor `node*` so it can never
 * pollute session-history occupancy scans while it is briefly installed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HUB_COMM, setProcessComm } from "../../../src/web-hub/hub/comm.js";

const isLinux = process.platform === "linux";
const linuxDescribe = isLinux ? describe : describe.skip;

describe("setProcessComm (injected deps)", () => {
  it("writes the name to /proc/self/comm on linux", () => {
    const calls: Array<{ path: string; data: string }> = [];
    setProcessComm("pi-webhub", {
      platform: "linux",
      write: (path, data) => {
        calls.push({ path, data });
      },
    });
    expect(calls).toEqual([{ path: "/proc/self/comm", data: "pi-webhub" }]);
  });

  it("never throws when the writer fails", () => {
    expect(() =>
      setProcessComm("pi-webhub", {
        platform: "linux",
        write: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    ).not.toThrow();
  });

  it("is a no-op off linux (writer never called)", () => {
    const calls: string[] = [];
    for (const platform of ["darwin", "win32"] as const) {
      setProcessComm("pi-webhub", { platform, write: (path) => calls.push(path) });
    }
    expect(calls).toEqual([]);
  });

  it("is a no-op for an empty name even on linux", () => {
    const calls: string[] = [];
    setProcessComm("", { platform: "linux", write: (path) => calls.push(path) });
    expect(calls).toEqual([]);
  });

  it('HUB_COMM is ≤15 bytes and never a bare "pi" (occupancy scan safety)', () => {
    expect(Buffer.byteLength(HUB_COMM, "utf8")).toBeLessThanOrEqual(15);
    expect(HUB_COMM).not.toBe("pi");
    expect(HUB_COMM.startsWith("node")).toBe(false);
  });
});

linuxDescribe("setProcessComm (real /proc/self/comm round trip)", () => {
  it("installs a scratch comm, reads it back, and restores the original", () => {
    const before = readFileSync("/proc/self/comm", "utf8").trimEnd();
    try {
      setProcessComm("pi-webhub-tst");
      expect(readFileSync("/proc/self/comm", "utf8").trimEnd()).toBe("pi-webhub-tst");
    } finally {
      setProcessComm(before);
    }
    expect(readFileSync("/proc/self/comm", "utf8").trimEnd()).toBe(before);
  });
});
