/**
 * Darwin schedule identity — pure parser/probe tests (darwin-plan §3.P1 测试).
 *
 * Tier 1: the host is fully injected (no real `ps`/`sysctl`/`kill` child is spawned here), and
 * this file deliberately never names the real child-process module so the lexical tier scan
 * stays clean. Real-command coverage lives in tests/integration/schedule-darwin-identity.test.ts
 * (E-MAC; this file is E-CI).
 */
import { describe, expect, it } from "vitest";
import {
  createDarwinIdentity,
  parseBootSessionUuid,
  parsePsLstart,
  type DarwinIdentityHost,
} from "../../../src/web-hub/protocol/sched-identity.js";

const START_2026 = Date.UTC(2026, 10, 17, 5, 40, 6);
const BOOT_UUID = "6C1B9E7F-2A34-4D5E-8F90-ABCDEF123456";

interface ExecCall {
  file: string;
  args: string[];
  opts: { env: Record<string, string>; timeout: number; maxBuffer: number };
}

interface HostScript {
  ps?: string | Error;
  sysctl?: string | Error;
  kill?: (pid: number) => void;
  pid?: number;
  hostname?: string;
}

function fail(error: Error): never {
  throw error;
}

/** Fake host: answers `/bin/ps` and `/usr/sbin/sysctl` from the script, records every call. */
function fakeHost(script: HostScript): { host: Partial<DarwinIdentityHost>; ps: ExecCall[]; sysctl: ExecCall[] } {
  const ps: ExecCall[] = [];
  const sysctl: ExecCall[] = [];
  const host: Partial<DarwinIdentityHost> = {
    pid: script.pid ?? 4_242,
    hostname: () => script.hostname ?? "mac.test",
    kill: script.kill ?? (() => undefined),
    execFileSync: (file, args, opts) => {
      const call: ExecCall = { file, args: [...args], opts };
      if (file === "/bin/ps") {
        ps.push(call);
        const r = script.ps ?? "Tue Nov 17 05:40:06 2026\n";
        return r instanceof Error ? fail(r) : r;
      }
      if (file === "/usr/sbin/sysctl") {
        sysctl.push(call);
        const r = script.sysctl ?? `${BOOT_UUID}\n`;
        return r instanceof Error ? fail(r) : r;
      }
      return fail(new Error(`unexpected command: ${file}`));
    },
  };
  return { host, ps, sysctl };
}

/** A thrown host error shaped like the real exec wrapper: exit status + captured stdout. */
function exitError(status: number, stdout: string, code?: string): Error {
  return Object.assign(new Error(`exited ${status}`), {
    status,
    stdout,
    ...(code === undefined ? {} : { code }),
  });
}

function killError(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code });
}

const T = (y: number, mo: number, d: number, h: number, mi: number, s: number): number =>
  Date.UTC(y, mo - 1, d, h, mi, s);

describe("parsePsLstart", () => {
  it("parses canonical C-locale UTC output (incl. single-digit day padding and trailing newline)", () => {
    expect(parsePsLstart("Tue Nov 17 05:40:06 2026")).toBe(T(2026, 11, 17, 5, 40, 6));
    expect(parsePsLstart("Tue Nov 17 05:40:06 2026\n")).toBe(T(2026, 11, 17, 5, 40, 6));
    expect(parsePsLstart("Wed Feb  3 01:02:03 2027")).toBe(T(2027, 2, 3, 1, 2, 3));
    expect(parsePsLstart("Tue Feb 29 12:00:00 2028")).toBe(T(2028, 2, 29, 12, 0, 0));
    expect(parsePsLstart("Thu Jan  1 00:00:00 1970")).toBe(0);
  });

  it("only ever yields whole-second, safe, non-negative epoch milliseconds", () => {
    for (const text of [
      "Tue Nov 17 05:40:06 2026",
      "Wed Feb  3 01:02:03 2027",
      "Tue Feb 29 12:00:00 2028",
      "Thu Jan  1 00:00:00 1970",
    ]) {
      const v = parsePsLstart(text);
      expect(v).toBeDefined();
      expect(Number.isSafeInteger(v!)).toBe(true);
      expect(v!).toBeGreaterThanOrEqual(0);
      expect(v! % 1_000).toBe(0);
    }
  });

  it("rejects overflowed fields via read-back verification (never a rolled-over date)", () => {
    expect(parsePsLstart("Mon Nov 31 00:00:00 2026")).toBeUndefined(); // Nov has 30 days
    expect(parsePsLstart("Mon Feb 30 00:00:00 2027")).toBeUndefined();
    expect(parsePsLstart("Tue Nov 17 24:00:00 2026")).toBeUndefined(); // hour rolls over
    expect(parsePsLstart("Tue Nov 17 23:60:00 2026")).toBeUndefined();
    expect(parsePsLstart("Tue Nov 17 23:59:60 2026")).toBeUndefined();
  });

  it("rejects a weekday that does not match the date", () => {
    expect(parsePsLstart("Mon Nov 17 05:40:06 2026")).toBeUndefined(); // 2026-11-17 is a Tuesday
    expect(parsePsLstart("Tue Feb  3 01:02:03 2027")).toBeUndefined(); // 2027-02-03 is a Wednesday
  });

  it("rejects localized output, junk, truncation and wrong padding", () => {
    expect(parsePsLstart("周二 11月 17 05:40:06 2026")).toBeUndefined();
    expect(parsePsLstart("Di. Nov 17 05:40:06 2026")).toBeUndefined();
    expect(parsePsLstart("Tue Nov 17 05:40:06 2026 junk")).toBeUndefined();
    expect(parsePsLstart(" Tue Nov 17 05:40:06 2026")).toBeUndefined();
    expect(parsePsLstart("Tue Nov   3 05:40:06 2026")).toBeUndefined(); // three-space day padding
    expect(parsePsLstart("Tue Nov 17 05:40:06")).toBeUndefined();
    expect(parsePsLstart("")).toBeUndefined();
  });
});

describe("parseBootSessionUuid", () => {
  it("accepts a UUID, preserving case, ignoring surrounding whitespace", () => {
    expect(parseBootSessionUuid(`${BOOT_UUID}\n`)).toBe(BOOT_UUID);
    expect(parseBootSessionUuid("  0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0  ")).toBe(
      "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    );
  });

  it("never guesses a boot id", () => {
    expect(parseBootSessionUuid("not-a-uuid")).toBeUndefined();
    expect(parseBootSessionUuid("12345678-1234-1234-1234-12345678901")).toBeUndefined(); // short group
    expect(parseBootSessionUuid("123456781234-1234-1234-123456789012")).toBeUndefined(); // missing hyphen
    expect(parseBootSessionUuid("1234567g-1234-1234-1234-123456789012")).toBeUndefined(); // non-hex
    expect(parseBootSessionUuid("")).toBeUndefined();
  });
});

describe("createDarwinIdentity", () => {
  it("pins the /bin/ps and /usr/sbin/sysctl commands, environment, timeout and buffer", () => {
    const { host, ps, sysctl } = fakeHost({});
    const id = createDarwinIdentity(host);
    expect(id.probe.startOf(42)).toBe(START_2026);
    expect(ps).toEqual([
      {
        file: "/bin/ps",
        args: ["-o", "lstart=", "-p", "42"],
        opts: { env: { LC_ALL: "C", TZ: "UTC0", PATH: "/usr/bin:/bin" }, timeout: 2_000, maxBuffer: 4_096 },
      },
    ]);
    expect(id.readSelf()).toBeDefined();
    expect(sysctl).toEqual([
      {
        file: "/usr/sbin/sysctl",
        args: ["-n", "kern.bootsessionuuid"],
        opts: { env: { LC_ALL: "C", TZ: "UTC0", PATH: "/usr/bin:/bin" }, timeout: 2_000, maxBuffer: 4_096 },
      },
    ]);
  });

  it("startOf: live pid via ps; an EPERM kill still probes", () => {
    expect(createDarwinIdentity(fakeHost({}).host).probe.startOf(7)).toBe(START_2026);
    expect(
      createDarwinIdentity(
        fakeHost({
          kill: () => {
            throw killError("EPERM");
          },
        }).host,
      ).probe.startOf(7),
    ).toBe(START_2026);
  });

  it("startOf: proven ESRCH short-circuits with zero subprocesses", () => {
    const { host, ps } = fakeHost({
      kill: () => {
        throw killError("ESRCH");
      },
    });
    expect(createDarwinIdentity(host).probe.startOf(4_242)).toBeUndefined();
    expect(ps).toHaveLength(0);
  });

  it("startOf: ps exit 1 with empty output means the pid is gone", () => {
    expect(createDarwinIdentity(fakeHost({ ps: exitError(1, "") }).host).probe.startOf(7)).toBeUndefined();
  });

  it('startOf: any other failure or unparseable output is "error", never a guess', () => {
    for (const ps of [
      exitError(1, "junk\n"),
      exitError(2, ""),
      exitError(0, ""),
      Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
    ]) {
      expect(createDarwinIdentity(fakeHost({ ps }).host).probe.startOf(7)).toBe("error");
    }
    expect(
      createDarwinIdentity(fakeHost({ ps: "Dienstag, 17. November 05:40 Uhr 2026\n" }).host).probe.startOf(7),
    ).toBe("error");
  });

  it("startOf rejects non-positive / non-integer pids without spawning", () => {
    const { host, ps } = fakeHost({});
    const id = createDarwinIdentity(host);
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(id.probe.startOf(pid)).toBe("error");
    expect(ps).toHaveLength(0);
  });

  it("pidMayExist: false only on proven ESRCH", () => {
    expect(createDarwinIdentity(fakeHost({}).host).probe.pidMayExist(7)).toBe(true);
    expect(
      createDarwinIdentity(
        fakeHost({
          kill: () => {
            throw killError("EPERM");
          },
        }).host,
      ).probe.pidMayExist(7),
    ).toBe(true);
    expect(
      createDarwinIdentity(
        fakeHost({
          kill: () => {
            throw killError("ESRCH");
          },
        }).host,
      ).probe.pidMayExist(7),
    ).toBe(false);
  });

  it("readSelf: pid + ps start + hostname + sysctl boot", () => {
    const { host, ps, sysctl } = fakeHost({ pid: 4_242, hostname: "mac.test" });
    const id = createDarwinIdentity(host);
    expect(id.readSelf()).toEqual({ pid: 4_242, start: START_2026, host: "mac.test", boot: BOOT_UUID });
    expect(ps).toHaveLength(1);
    expect(sysctl).toHaveLength(1);
  });

  it('readSelf: an unusable boot id or self start yields undefined (mirrors "no /proc")', () => {
    for (const sysctl of [exitError(1, ""), "not-a-uuid\n"]) {
      expect(createDarwinIdentity(fakeHost({ sysctl }).host).readSelf()).toBeUndefined();
    }
    expect(createDarwinIdentity(fakeHost({ ps: exitError(1, "") }).host).readSelf()).toBeUndefined();
    expect(
      createDarwinIdentity(
        fakeHost({
          kill: () => {
            throw killError("ESRCH");
          },
        }).host,
      ).readSelf(),
    ).toBeUndefined();
  });

  it("labels its start domain epoch-ms (cross-domain holders judge unprovable downstream)", () => {
    expect(createDarwinIdentity(fakeHost({}).host).probe.startDomain).toBe("epoch-ms");
  });

  it("keeps the subprocess budget: readSelf=2 spawns, ESRCH=0, external live holder=1 (darwin-plan §3.P1-b #11)", () => {
    const ok = fakeHost({});
    createDarwinIdentity(ok.host).readSelf();
    expect(ok.ps.length + ok.sysctl.length).toBe(2);

    const gone = fakeHost({
      kill: () => {
        throw killError("ESRCH");
      },
    });
    createDarwinIdentity(gone.host).probe.startOf(999);
    expect(gone.ps).toHaveLength(0);
    expect(gone.sysctl).toHaveLength(0);

    const external = fakeHost({});
    createDarwinIdentity(external.host).probe.startOf(999);
    expect(external.ps).toHaveLength(1);
    expect(external.sysctl).toHaveLength(0);
  });
});
