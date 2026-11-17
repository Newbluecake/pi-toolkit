import { describe, expect, it, vi } from "vitest";
import {
  classifyLocalAuthority,
  probeLocalProcess,
  type LocalProcessProbeDeps,
  type TerminalAuthorityRecord,
} from "../../../src/web-hub/protocol/terminal-local.js";
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
