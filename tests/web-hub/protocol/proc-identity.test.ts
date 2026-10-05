/**
 * web-hub-spawn plan v2.1 §SP1: `protocol/proc-identity.ts` — pure parser fixtures and the
 * 7 `verifySpawnedIdentity` branches (arch §7.4's reason table), all with injected
 * `readFile`/`platform`/`getuid` — no real `/proc` is ever read here.
 */
import { describe, expect, it } from "vitest";
import {
  parseCmdline,
  parsePgrp,
  parseStartTicks,
  parseUidLine,
  readBootId,
  readBtime,
  readStatSync,
  verifySpawnedIdentity,
  type ProcIdentityDeps,
  type ProcSyncDeps,
  type SpawnedIdentity,
} from "../../../src/web-hub/protocol/proc-identity.js";

const PID = 123;
const BOOT_ID = "b0071111-2222-3333-4444-555566667777";
const TICKS = 987_654;
const UID = 1000;

/** `/proc/<pid>/stat` line; comm may contain spaces and `)` — parsers must split after the LAST `)`.
 * 19 placeholder fields before starttime: state ppid pgrp session tty tpgid flags minflt cminflt
 * majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue (starttime = field 22). */
function statLine(comm: string, opts: { starttime: number; pgrp?: number }): string {
  const fields = [
    "S",
    "1",
    String(opts.pgrp ?? PID),
    "1",
    "1",
    "1",
    "1",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "20",
    "0",
    "1",
    "0",
  ];
  return `${PID} (${comm}) ${fields.join(" ")} ${opts.starttime} 0 0`;
}

function statusLine(uid: { real: number; effective: number }): string {
  return `Name:\tpi\nState:\tS (sleeping)\nUid:\t${uid.real}\t${uid.effective}\t${uid.real}\t${uid.real}\nGid:\t${uid.real}\t${uid.effective}\t${uid.real}\t${uid.real}\n`;
}

function goodFiles(): Record<string, string> {
  return {
    "/proc/sys/kernel/random/boot_id": `${BOOT_ID}\n`,
    [`/proc/${PID}/stat`]: statLine("pi", { starttime: TICKS }),
    [`/proc/${PID}/status`]: statusLine({ real: UID, effective: UID }),
  };
}

function expected(over: Partial<SpawnedIdentity> = {}): SpawnedIdentity {
  return { pid: PID, procStartTicks: TICKS, bootId: BOOT_ID, uid: UID, ...over };
}

/** deps with a canned file table; a value of `null` means "read throws". */
function deps(files: Record<string, string | null>, over: { platform?: string } = {}): ProcIdentityDeps {
  return {
    readFile: async (path: string) => {
      const v = files[path];
      if (v === undefined || v === null) throw new Error("ENOENT");
      return v;
    },
    getuid: () => UID,
    platform: over.platform ?? "linux",
  };
}

describe("parseStartTicks / parsePgrp (comm with spaces and `)`)", () => {
  it("reads starttime (field 22) and pgrp (field 5) past a comm containing spaces and parens", () => {
    const stat = statLine("weird (comm) name", { starttime: 42, pgrp: 7 });
    expect(parseStartTicks(stat)).toBe(42);
    expect(parsePgrp(stat)).toBe(7);
  });

  it("reads the plain pi comm shape too", () => {
    const stat = statLine("pi", { starttime: TICKS, pgrp: PID });
    expect(parseStartTicks(stat)).toBe(TICKS);
    expect(parsePgrp(stat)).toBe(PID);
  });

  it("undefined on malformed input (no comm close, missing fields, non-numeric)", () => {
    for (const bad of ["garbage", "", "123 pi S", `${PID} (pi) S 1`]) {
      expect(parseStartTicks(bad)).toBeUndefined();
      expect(parsePgrp(bad)).toBeUndefined();
    }
    // field 22 present but non-numeric ("x" lands at index 19 after 19 placeholder fields)
    const stat = `${PID} (pi) ${"0 ".repeat(19)}x 0`;
    expect(parseStartTicks(stat)).toBeUndefined();
  });
});

describe("parseCmdline / parseUidLine (moved verbatim from agent/proc-identity.ts)", () => {
  it("cmdline splits on NUL and drops the trailing empty tail", () => {
    expect(parseCmdline("/bin/node\0/x/pi\0--mode\0rpc\0")).toEqual(["/bin/node", "/x/pi", "--mode", "rpc"]);
    expect(parseCmdline("/bin/node\0/x")).toEqual(["/bin/node", "/x"]);
  });

  it("uid line parses real/effective; missing or malformed lines are undefined", () => {
    expect(parseUidLine(statusLine({ real: 1000, effective: 1001 }))).toEqual({ real: 1000, effective: 1001 });
    expect(parseUidLine("Name:\tpi\n")).toBeUndefined();
    expect(parseUidLine("Uid:\tonlyone\n")).toBeUndefined();
  });
});

describe("readBootId / readBtime / readStatSync", () => {
  it("readBootId trims; undefined on throw or non-linux", async () => {
    expect(await readBootId(deps({ "/proc/sys/kernel/random/boot_id": `  ${BOOT_ID}\n` }))).toBe(BOOT_ID);
    expect(await readBootId(deps({ "/proc/sys/kernel/random/boot_id": null }))).toBeUndefined();
    expect(await readBootId(deps({}, { platform: "darwin" }))).toBeUndefined();
  });

  it("readBtime parses the btime line (seconds); undefined when missing/invalid/non-linux", async () => {
    const stat = `cpu  1 2 3\ncpu0 1 2 3\nbtime 1759550000\nctxt 123\n`;
    expect(await readBtime(deps({ "/proc/stat": stat }))).toBe(1_759_550_000);
    expect(await readBtime(deps({ "/proc/stat": "cpu 1 2 3\n" }))).toBeUndefined();
    expect(await readBtime(deps({ "/proc/stat": "btime notanumber\n" }))).toBeUndefined();
    expect(await readBtime(deps({ "/proc/stat": null }))).toBeUndefined();
    expect(await readBtime(deps({}, { platform: "darwin" }))).toBeUndefined();
  });

  it("readStatSync reads synchronously; undefined on throw or non-linux", () => {
    const sync = (files: Record<string, string | null>, platform?: string): ProcSyncDeps => ({
      readFileSync: (p: string) => {
        const v = files[p];
        if (v === undefined || v === null) throw new Error("ENOENT");
        return v;
      },
      ...(platform === undefined ? {} : { platform }),
    });
    const stat = statLine("pi", { starttime: TICKS });
    expect(readStatSync(PID, sync({ [`/proc/${PID}/stat`]: stat }))).toBe(stat);
    expect(readStatSync(PID, sync({}))).toBeUndefined();
    expect(readStatSync(PID, sync({ [`/proc/${PID}/stat`]: stat }, "darwin"))).toBeUndefined();
  });
});

describe("verifySpawnedIdentity (arch §7.4 — 7 branches, table order)", () => {
  it("① all checks pass ⇒ ok (group kill shape: pgrp === pid)", async () => {
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(goodFiles()))).resolves.toEqual({ ok: true });
  });

  it("② non-linux platform ⇒ non-linux (fail closed)", async () => {
    await expect(
      verifySpawnedIdentity(expected(), { group: true }, deps(goodFiles(), { platform: "darwin" })),
    ).resolves.toEqual({ ok: false, reason: "non-linux" });
  });

  it("③ boot id differs / is unreadable ⇒ boot-mismatch", async () => {
    const otherBoot = { ...goodFiles(), "/proc/sys/kernel/random/boot_id": "deadbeef-0000\n" };
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(otherBoot))).resolves.toEqual({
      ok: false,
      reason: "boot-mismatch",
    });
    const noBoot = { ...goodFiles(), "/proc/sys/kernel/random/boot_id": null };
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(noBoot))).resolves.toEqual({
      ok: false,
      reason: "boot-mismatch",
    });
  });

  it("④ /proc/<pid>/* unreadable ⇒ no-proc (process gone / permission)", async () => {
    const gone: Record<string, string | null> = { ...goodFiles(), [`/proc/${PID}/stat`]: null };
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(gone))).resolves.toEqual({
      ok: false,
      reason: "no-proc",
    });
    const noStatus: Record<string, string | null> = { ...goodFiles(), [`/proc/${PID}/status`]: null };
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(noStatus))).resolves.toEqual({
      ok: false,
      reason: "no-proc",
    });
  });

  it("⑤ starttime differs (pid reuse) / is unparseable ⇒ starttime-mismatch", async () => {
    const reused = {
      ...goodFiles(),
      [`/proc/${PID}/stat`]: statLine("pi", { starttime: TICKS + 1 }),
    };
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(reused))).resolves.toEqual({
      ok: false,
      reason: "starttime-mismatch",
    });
    await expect(
      verifySpawnedIdentity(expected({ procStartTicks: 1 }), { group: true }, deps(goodFiles())),
    ).resolves.toEqual({
      ok: false,
      reason: "starttime-mismatch",
    });
  });

  it("⑥ real or effective uid differs / Uid line missing ⇒ uid-mismatch", async () => {
    const realDiff = {
      ...goodFiles(),
      [`/proc/${PID}/status`]: statusLine({ real: 0, effective: UID }),
    };
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(realDiff))).resolves.toEqual({
      ok: false,
      reason: "uid-mismatch",
    });
    const effDiff = {
      ...goodFiles(),
      [`/proc/${PID}/status`]: statusLine({ real: UID, effective: 12345 }),
    };
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(effDiff))).resolves.toEqual({
      ok: false,
      reason: "uid-mismatch",
    });
    const noUidLine = { ...goodFiles(), [`/proc/${PID}/status`]: "Name:\tpi\n" };
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(noUidLine))).resolves.toEqual({
      ok: false,
      reason: "uid-mismatch",
    });
  });

  it("⑦ group:true with pgrp !== pid ⇒ pgrp-mismatch; group:false skips the pgrp check", async () => {
    const notGroupLeader = {
      ...goodFiles(),
      [`/proc/${PID}/stat`]: statLine("pi", { starttime: TICKS, pgrp: 999 }),
    };
    await expect(verifySpawnedIdentity(expected(), { group: true }, deps(notGroupLeader))).resolves.toEqual({
      ok: false,
      reason: "pgrp-mismatch",
    });
    // same fixture, single-pid kill: identity itself is fine — only the group precondition differs
    await expect(verifySpawnedIdentity(expected(), { group: false }, deps(notGroupLeader))).resolves.toEqual({
      ok: true,
    });
  });
});
