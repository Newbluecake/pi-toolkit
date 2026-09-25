import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pidAlive, procStatState } from "../../../src/web-hub/protocol/pid.js";

const ok = (): void => undefined;
const esrch = (): void => {
  throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
};
const eperm = (): void => {
  throw Object.assign(new Error("EPERM"), { code: "EPERM" });
};

describe("procStatState", () => {
  it("takes the field after the LAST ')' (comm may contain spaces and parens)", () => {
    expect(procStatState("123 (node) S 1 123 123 0")).toBe("S");
    expect(procStatState("123 (a b) Z (c)) Z 1 2")).toBe("Z");
    expect(procStatState("123 (x) R) S 1")).toBe("S");
    expect(procStatState("123 (x)  X 1")).toBe("X");
    expect(procStatState("garbage")).toBeUndefined();
    expect(procStatState("1 (x)")).toBeUndefined();
  });
});

describe("pidAlive (injected)", () => {
  it("kill ESRCH ⇒ dead, without touching /proc", () => {
    let read = 0;
    expect(pidAlive(42, { kill: esrch, readProcStat: () => (read++, "42 (x) S") })).toBe(false);
    expect(read).toBe(0);
  });
  it("zombie / dead state ⇒ dead even though kill(pid,0) succeeds", () => {
    expect(pidAlive(42, { kill: ok, readProcStat: () => "42 (pi) Z 1 42" })).toBe(false);
    expect(pidAlive(42, { kill: ok, readProcStat: () => "42 (pi) X 1 42" })).toBe(false);
    expect(pidAlive(42, { kill: eperm, readProcStat: () => "42 (other user) Z 1" })).toBe(false);
  });
  it("running / sleeping / stopped ⇒ alive", () => {
    for (const st of ["R", "S", "D", "T", "t", "I"]) {
      expect(pidAlive(42, { kill: ok, readProcStat: () => `42 (a) b) ${st} 1` })).toBe(true);
    }
    expect(pidAlive(42, { kill: eperm, readProcStat: () => "42 (x) S 1" })).toBe(true);
  });
  it("/proc unreadable (non-Linux) ⇒ falls back to kill(pid,0)", () => {
    const noProc = (): string => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(pidAlive(42, { kill: ok, readProcStat: noProc })).toBe(true);
    expect(pidAlive(42, { kill: eperm, readProcStat: noProc })).toBe(true);
    expect(pidAlive(42, { kill: esrch, readProcStat: noProc })).toBe(false);
  });
  it("invalid pids are never alive", () => {
    for (const pid of [0, -1, 1.5, Number.NaN])
      expect(pidAlive(pid, { kill: ok, readProcStat: () => "1 (x) S" })).toBe(false);
  });
});

describe.runIf(process.platform === "linux")("pidAlive (real zombie)", () => {
  it("a <defunct> child: kill(pid,0) succeeds but pidAlive is false", async () => {
    // sh forks `true`, prints its pid, then execs sleep — which never reaps it ⇒ zombie.
    const parent = spawn("sh", ["-c", "true & echo $!; exec sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const zpid = await new Promise<number>((resolve) =>
        parent.stdout.once("data", (c: Buffer) => resolve(Number.parseInt(c.toString().trim(), 10))),
      );
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && procStatState(readFileSync(`/proc/${zpid}/stat`, "utf8")) !== "Z") {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(procStatState(readFileSync(`/proc/${zpid}/stat`, "utf8"))).toBe("Z");
      expect(() => process.kill(zpid, 0)).not.toThrow(); // the old probe's blind spot
      expect(pidAlive(zpid)).toBe(false);
      expect(pidAlive(process.pid)).toBe(true);
    } finally {
      parent.kill("SIGKILL");
    }
  });
});
