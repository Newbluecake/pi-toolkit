import { describe, expect, it, vi } from "vitest";
import {
  readLocalFile,
  classifyLocalAuthority,
  probeLocalProcess,
  type LocalProcessProbeDeps,
  type TerminalAuthorityRecord,
} from "../../../src/web-hub/protocol/terminal-local.js";
const fileFacts = vi.hoisted(() => ({
  uid: process.getuid!(),
  mode: 0o600,
  nlink: 1,
  size: 4,
  regular: true,
  short: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: vi.fn(() => 42),
    closeSync: vi.fn(),
    fstatSync: vi.fn(() => ({ ...fileFacts, isFile: () => fileFacts.regular })),
    readSync: vi.fn((_fd, buffer: Buffer, offset: number, length: number, position: number) => {
      const bytes = Buffer.from(fileFacts.short ? "x" : "data");
      return bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length));
    }),
  };
});
const boot = "11111111-1111-4111-8111-111111111111";
const old = "22222222-2222-4222-8222-222222222222";
const ns = { pid: "pid:[1]", mnt: "mnt:[2]", user: "user:[3]" };
const identity = (pid: number) => ({ bootId: boot, pid, uid: process.getuid!(), starttime: "123" });
const fail = (code: string): never => {
  throw Object.assign(new Error("private"), { code });
};
function facts(kind = "present"): LocalProcessProbeDeps {
  return {
    identity: (pid) => (pid === process.pid || kind === "present" ? identity(pid) : fail(kind)),
    namespaces: () => ns,
    directory: (pid) => {
      if (pid !== process.pid && kind === "ENOENT") fail("ENOENT");
    },
  };
}
const record = (bootId = boot) =>
  ({ process: { ...identity(99999999), bootId }, namespaces: ns }) as TerminalAuthorityRecord;
describe("read-only authority process classification (injected facts)", () => {
  it("requires previous boot AND independently confirmed absent PID; old namespaces may differ", () => {
    expect(
      classifyLocalAuthority(
        { ...record(old), namespaces: { pid: "pid:[9]", mnt: "mnt:[8]", user: "user:[7]" } },
        facts("ENOENT"),
      ),
    ).toBe("previous-boot");
    expect(() => classifyLocalAuthority(record(old), facts())).toThrowError("stale-authority-prev-boot-pid-present");
    expect(() => classifyLocalAuthority(record(), facts("ENOENT"))).toThrowError("stale-authority-same-boot");
  });
  it("preserves exact live current authority and refuses PID reuse", () => {
    expect(classifyLocalAuthority(record(), facts())).toBe("current");
    expect(() =>
      classifyLocalAuthority({ ...record(), process: { ...identity(99999999), starttime: "124" } }, facts()),
    ).toThrowError("stale-authority-same-boot");
  });
  it.each(["EACCES", "EPERM", "EIO", "EINVAL"])("never treats %s as absence", (code) => {
    expect(probeLocalProcess(99999999, facts(code))).toEqual({ kind: "unavailable" });
    expect(() => classifyLocalAuthority(record(old), facts(code))).toThrowError("authority-proc-unavailable");
  });
  it("child ENOENT with still-present directory is retried once, never absent", () => {
    const deps = facts("ENOENT");
    deps.directory = vi.fn();
    const read = vi.fn(deps.identity);
    deps.identity = read;
    expect(probeLocalProcess(99999999, deps)).toEqual({ kind: "unavailable" });
    expect(read.mock.calls.filter(([pid]) => pid === 99999999)).toHaveLength(2);
  });
  it("self/proc unreadable or changed before/after fails closed", () => {
    const deps = facts("ENOENT");
    deps.namespaces = () => fail("EIO");
    expect(probeLocalProcess(99999999, deps)).toEqual({ kind: "unavailable" });
  });
  it("same boot namespace mismatch is not death; old invalid UUID is not recoverable", () => {
    expect(() => classifyLocalAuthority({ ...record(), namespaces: { ...ns, pid: "pid:[9]" } }, facts())).toThrowError(
      "authority-namespace-mismatch",
    );
    expect(() => classifyLocalAuthority(record("legacy-boot"), facts("ENOENT"))).toThrowError("authority-corrupt");
  });
});

describe("owned no-follow local file reader (injected filesystem facts)", () => {
  const reset = () =>
    Object.assign(fileFacts, { uid: process.getuid!(), mode: 0o600, nlink: 1, size: 4, regular: true, short: false });
  it("reads exact bytes with NOFOLLOW/NONBLOCK and always closes the held file", async () => {
    reset();
    const fs = await import("node:fs");
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.closeSync).mockClear();
    expect(readLocalFile("/private-fixture")).toEqual(Buffer.from("data"));
    const flags = vi.mocked(fs.openSync).mock.calls[0]![1] as number;
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
    expect(fs.closeSync).toHaveBeenCalledWith(42);
  });
  it.each(["foreign-owner", "wide-mode", "hardlink", "fifo", "oversize"])(
    "rejects %s before reading any bytes",
    async (kind) => {
      reset();
      const fs = await import("node:fs");
      vi.mocked(fs.readSync).mockClear();
      vi.mocked(fs.closeSync).mockClear();
      if (kind === "foreign-owner") fileFacts.uid++;
      if (kind === "wide-mode") fileFacts.mode = 0o644;
      if (kind === "hardlink") fileFacts.nlink = 2;
      if (kind === "fifo") fileFacts.regular = false;
      if (kind === "oversize") fileFacts.size = 131073;
      expect(() => readLocalFile("/private-fixture")).toThrowError("unsafe-file");
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(fs.closeSync).toHaveBeenCalledTimes(1);
      expect(fs.closeSync).toHaveBeenCalledWith(42);
    },
  );
  it("short/changed file is not accepted as an exact snapshot", () => {
    reset();
    fileFacts.short = true;
    expect(() => readLocalFile("/private-fixture")).toThrowError("file-changed");
  });
});
