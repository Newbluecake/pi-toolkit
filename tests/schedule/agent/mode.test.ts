import { describe, expect, it } from "vitest";
import {
  actionRefusal,
  assertExecutable,
  resolveScheduleMode,
  type ExecGatePorts,
  type ScheduleModeFacts,
  type ScheduleToolAction,
} from "../../../src/schedule/agent/mode.js";

const base: ScheduleModeFacts = { mode: "tui", sessionFile: "/s/a.jsonl", childFile: false, secure: "plain" };
const ALL: ScheduleToolAction[] = [
  "list",
  "get",
  "create",
  "update",
  "pause",
  "resume",
  "delete",
  "run_now",
  "history",
];

describe("§3.3 run-mode matrix", () => {
  it.each([
    [{}, "interactive", true],
    [{ mode: "rpc" }, "interactive", true],
    [{ mode: "print" }, "print", false],
    [{ mode: "json" }, "print", false],
    [{ mode: "something-new" }, "print", false],
    [{ sessionFile: undefined }, "ephemeral", false],
    [{ sessionFile: "" }, "ephemeral", false],
    [{ childFile: true }, "child", false],
    [{ secure: "secure" }, "secure", false],
    [{ secure: "locked" }, "secure", false],
    // precedence: secure > child > ephemeral > print
    [{ secure: "secure", childFile: true, sessionFile: undefined, mode: "print" }, "secure", false],
    [{ childFile: true, sessionFile: undefined, mode: "print" }, "child", false],
    [{ sessionFile: undefined, mode: "print" }, "ephemeral", false],
  ] as const)("%j ⇒ %s (arm %s)", (over, kind, arm) => {
    expect(resolveScheduleMode({ ...base, ...over })).toEqual({ kind, arm });
  });

  it("tool actions per mode", () => {
    const of = (over: Partial<ScheduleModeFacts>) => resolveScheduleMode({ ...base, ...over });
    for (const a of ALL) expect(actionRefusal(of({}), a)).toBeUndefined();
    for (const a of ALL) expect(actionRefusal(of({ secure: "locked" }), a)?.code).toBe("E_SECURE");
    for (const a of ALL) expect(actionRefusal(of({ childFile: true }), a)?.code).toBe("E_CHILD");
    const print = of({ mode: "print" });
    expect(ALL.filter((a) => actionRefusal(print, a) === undefined)).toEqual(["list", "get", "history"]);
    for (const a of ["create", "update", "pause", "resume", "delete", "run_now"] as const)
      expect(actionRefusal(print, a)?.code).toBe("E_MODE");
    const eph = of({ sessionFile: undefined });
    expect(actionRefusal(eph, "create")?.code).toBe("E_EPHEMERAL");
    expect(actionRefusal(eph, "list")).toBeUndefined(); // "treated as empty"
  });
});

describe("assertExecutable (§7.6)", () => {
  const ports = (over: Partial<ExecGatePorts> = {}): ExecGatePorts => ({
    verdict: { kind: "interactive", arm: true },
    ownerSessionId: "sid-1",
    currentSessionId: () => "sid-1",
    disposed: () => false,
    ...over,
  });

  it("passes for the live owner of an interactive plain session", () => {
    expect(assertExecutable(ports())).toBeUndefined();
  });
  it("disposed stack ⇒ E_NOT_OWNER", () => {
    expect(assertExecutable(ports({ disposed: () => true }))?.code).toBe("E_NOT_OWNER");
  });
  it("non-interactive verdicts map to their matrix codes", () => {
    expect(assertExecutable(ports({ verdict: { kind: "print", arm: false } }))?.code).toBe("E_MODE");
    expect(assertExecutable(ports({ verdict: { kind: "secure", arm: false } }))?.code).toBe("E_SECURE");
    expect(assertExecutable(ports({ verdict: { kind: "child", arm: false } }))?.code).toBe("E_CHILD");
    expect(assertExecutable(ports({ verdict: { kind: "ephemeral", arm: false } }))?.code).toBe("E_EPHEMERAL");
  });
  it("a runtime LOCK (mid-session unmount) ⇒ E_SECURE", () => {
    expect(assertExecutable(ports({ lockedReason: () => "unmounted" }))).toEqual({
      code: "E_SECURE",
      detail: "session LOCKED: unmounted",
    });
  });
  it("another current session, or a stale ctx that throws ⇒ E_NOT_OWNER", () => {
    expect(assertExecutable(ports({ currentSessionId: () => "sid-2" }))?.code).toBe("E_NOT_OWNER");
    expect(assertExecutable(ports({ currentSessionId: () => undefined }))?.code).toBe("E_NOT_OWNER");
    const stale = () => {
      throw new Error("stale ctx");
    };
    expect(assertExecutable(ports({ currentSessionId: stale }))?.code).toBe("E_NOT_OWNER");
  });
  it("ownerCwd inside a vault (literal or canonical) ⇒ E_SECURE; unresolvable ⇒ E_INVALID", () => {
    const inVault = (p: string) => p.startsWith("/vault/");
    const task = (ownerCwd: string) => ({ ownerCwd });
    expect(assertExecutable(ports({ inVault, realpath: (p) => p }), task("/home/u/p"))).toBeUndefined();
    expect(assertExecutable(ports({ inVault, realpath: (p) => p }), task("/vault/x"))?.code).toBe("E_SECURE");
    // a symlink pointing into the vault: only the canonical form reveals it
    expect(assertExecutable(ports({ inVault, realpath: () => "/vault/real" }), task("/home/u/link"))?.code).toBe(
      "E_SECURE",
    );
    const boom = () => {
      throw new Error("ENOENT");
    };
    expect(assertExecutable(ports({ inVault, realpath: boom }), task("/gone"))?.code).toBe("E_INVALID");
  });
});
