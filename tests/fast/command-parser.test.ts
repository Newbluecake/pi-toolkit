import { expect, it } from "vitest";
import { parseFastCommand, resolveFastCommandMode } from "../../src/fast/state.js";
it.each([
  ["", "toggle"],
  ["  ToGgLe ", "toggle"],
  ["ON", "on"],
  [" off ", "off"],
  ["reset", "inherit"],
  ["inherit", "inherit"],
  [" STATUS ", "status"],
])("parse %s", (args, command) => {
  expect(parseFastCommand(args)).toEqual({ kind: "command", command });
});
it.each(["on off", "on\nstatus", "auto", "ultrafast", "on x", "status x", "/fast on"])(
  "invalid %s has zero state effects",
  (args) => {
    const old = Object.freeze({ mode: "on" as const, revision: 3 });
    const command = parseFastCommand(args);
    expect(command).toEqual({ kind: "usage" });
    expect(resolveFastCommandMode(old.mode, command)).toBeUndefined();
    expect(old).toEqual({ mode: "on", revision: 3 });
  },
);
it("status is read-only, same-mode commands are no-op; reset is explicit inherit", () => {
  expect(resolveFastCommandMode("on", parseFastCommand("status"))).toBeUndefined();
  expect(resolveFastCommandMode("on", parseFastCommand("on"))).toBeUndefined();
  expect(resolveFastCommandMode("on", parseFastCommand("reset"))).toBe("inherit");
  expect(resolveFastCommandMode("inherit", parseFastCommand(""))).toBe("on");
});
