import { describe, expect, it } from "vitest";
import {
  looksLikeHubArgv,
  parseCmdline,
  parseStartTicks,
  parseUidLine,
  readStartTicksNow,
  verifyProcIdentity,
  type ExpectedIdentity,
} from "../../../src/web-hub/agent/proc-identity.js";

const GOOD_ARGV = ["/usr/bin/node", "/x/jiti/lib/jiti-cli.mjs", "/repo/src/web-hub/hub/main.ts"];

function statLine(comm: string, starttime: number): string {
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt
  // utime stime cutime cstime priority nice num_threads itrealvalue starttime ...
  const fields = ["S", "1", "1", "1", "1", "1", "1", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0"];
  return `123 (${comm}) ${fields.join(" ")} ${starttime} 0 0`;
}

describe("looksLikeHubArgv", () => {
  it("accepts the exact 3-item jiti-cli/main.ts shape", () => {
    expect(looksLikeHubArgv(GOOD_ARGV)).toBe(true);
  });
  it("rejects wrong length / wrong suffixes", () => {
    expect(looksLikeHubArgv([...GOOD_ARGV, "extra"])).toBe(false);
    expect(looksLikeHubArgv(["a", "b", "c"])).toBe(false);
    expect(looksLikeHubArgv(["/node", "/jiti/lib/jiti-cli.mjs", "/repo/src/web-hub/hub/other.ts"])).toBe(false);
  });
});

describe("parseStartTicks", () => {
  it("reads field 22 (starttime) even when comm has spaces/parens", () => {
    expect(parseStartTicks(statLine("node", 987654))).toBe(987654);
    expect(parseStartTicks(statLine("weird (comm) name", 42))).toBe(42);
  });
  it("undefined on malformed input", () => {
    expect(parseStartTicks("garbage")).toBeUndefined();
  });
});

describe("parseCmdline", () => {
  it("splits on NUL and drops the trailing empty tail", () => {
    expect(parseCmdline("/bin/node\0/x/jiti-cli.mjs\0/x/main.ts\0")).toEqual([
      "/bin/node",
      "/x/jiti-cli.mjs",
      "/x/main.ts",
    ]);
  });
  it("no trailing NUL: kept as-is", () => {
    expect(parseCmdline("/bin/node\0/x")).toEqual(["/bin/node", "/x"]);
  });
});

describe("parseUidLine", () => {
  it("parses real/effective from the Uid: line", () => {
    expect(parseUidLine("Name:\tfoo\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n")).toEqual({
      real: 1000,
      effective: 1000,
    });
  });
  it("undefined when the line is missing/malformed", () => {
    expect(parseUidLine("Name:\tfoo\n")).toBeUndefined();
    expect(parseUidLine("Uid:\tnotanumber\n")).toBeUndefined();
  });
});

function expected(over: Partial<ExpectedIdentity> = {}): ExpectedIdentity {
  return { pid: 4242, procStartTicks: 111, argv: GOOD_ARGV, ...over };
}

function deps(over: {
  stat?: string;
  cmdline?: string;
  status?: string;
  platform?: string;
  getuid?: number;
  throwOn?: "stat" | "cmdline" | "status";
}) {
  const platform = over.platform ?? "linux";
  const getuid = () => over.getuid ?? 1000;
  const readFile = async (p: string): Promise<string> => {
    if (p.endsWith("/stat")) {
      if (over.throwOn === "stat") throw new Error("ENOENT");
      return over.stat ?? statLine("node", 111);
    }
    if (p.endsWith("/cmdline")) {
      if (over.throwOn === "cmdline") throw new Error("ENOENT");
      return over.cmdline ?? GOOD_ARGV.join("\0") + "\0";
    }
    if (over.throwOn === "status") throw new Error("ENOENT");
    return over.status ?? "Uid:\t1000\t1000\t1000\t1000\n";
  };
  return { readFile, getuid, platform };
}

describe("verifyProcIdentity (plan §8.2 fallback path; safety, not a security boundary)", () => {
  it("non-linux ⇒ rejected, /proc never read", async () => {
    let read = false;
    const d = deps({ platform: "darwin" });
    const wrapped = { ...d, readFile: async (p: string) => ((read = true), d.readFile(p)) };
    const v = await verifyProcIdentity(expected(), wrapped);
    expect(v).toEqual({ ok: false, reason: "non-linux" });
    expect(read).toBe(false);
  });

  it("stored argv doesn't look like a hub process ⇒ argv-shape, /proc never read", async () => {
    let read = false;
    const d = deps({});
    const wrapped = { ...d, readFile: async (p: string) => ((read = true), d.readFile(p)) };
    const v = await verifyProcIdentity(expected({ argv: ["a", "b", "c"] }), wrapped);
    expect(v).toEqual({ ok: false, reason: "argv-shape" });
    expect(read).toBe(false);
  });

  it("process gone (no /proc entry) ⇒ no-proc", async () => {
    const v = await verifyProcIdentity(expected(), deps({ throwOn: "stat" }));
    expect(v).toEqual({ ok: false, reason: "no-proc" });
  });

  it("starttime mismatch (PID reuse) ⇒ starttime-mismatch", async () => {
    const v = await verifyProcIdentity(expected({ procStartTicks: 999 }), deps({ stat: statLine("node", 111) }));
    expect(v).toEqual({ ok: false, reason: "starttime-mismatch" });
  });

  it("cmdline mismatch (similar path but different process) ⇒ cmdline-mismatch", async () => {
    const otherArgv = ["/usr/bin/node", "/x/jiti/lib/jiti-cli.mjs", "/repo/src/web-hub/hub/main2.ts"];
    const v = await verifyProcIdentity(expected(), deps({ cmdline: otherArgv.join("\0") + "\0" }));
    expect(v).toEqual({ ok: false, reason: "cmdline-mismatch" });
  });

  it("uid mismatch ⇒ uid-mismatch", async () => {
    const v = await verifyProcIdentity(expected(), deps({ status: "Uid:\t0\t0\t0\t0\n", getuid: 1000 }));
    expect(v).toEqual({ ok: false, reason: "uid-mismatch" });
  });

  it("real != effective uid (partial setuid) ⇒ uid-mismatch", async () => {
    const v = await verifyProcIdentity(expected(), deps({ status: "Uid:\t1000\t0\t1000\t1000\n" }));
    expect(v).toEqual({ ok: false, reason: "uid-mismatch" });
  });

  it("everything matches ⇒ ok", async () => {
    const v = await verifyProcIdentity(expected(), deps({}));
    expect(v).toEqual({ ok: true });
  });
});

describe("readStartTicksNow (race-window re-check before signalling)", () => {
  it("reads just the starttime, non-linux ⇒ undefined without reading", async () => {
    let read = false;
    const readFile = async (p: string): Promise<string> => ((read = true), statLine("node", 5));
    expect(await readStartTicksNow(1, { readFile, platform: "darwin" })).toBeUndefined();
    expect(read).toBe(false);
  });
  it("linux: parses field 22", async () => {
    const readFile = async () => statLine("node", 777);
    expect(await readStartTicksNow(1, { readFile, platform: "linux" })).toBe(777);
  });
  it("read failure ⇒ undefined (process gone)", async () => {
    const readFile = async (): Promise<string> => {
      throw new Error("ENOENT");
    };
    expect(await readStartTicksNow(1, { readFile, platform: "linux" })).toBeUndefined();
  });
});
