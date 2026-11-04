/**
 * scheduled-reports plan r3 §5.2 (S0): the `/schedule` row of the web command-policy table
 * (src/web-hub/agent/command-policy.ts). Lives under tests/web-hub/protocol/ because the S0 file
 * domain only admits schedule*.test.ts there (the policy module itself is agent-side).
 */
import { describe, expect, it } from "vitest";
import { resolveCommandPolicy, schedulePolicy } from "../../../src/web-hub/agent/command-policy.js";

const HASH = "fd9fcbba309bbae09b0d3c6d69258712ce12370868bc09012b3649c28daa08e9";

function policy(args: string, overrides?: Record<string, "allow" | "confirm" | "deny">) {
  return resolveCommandPolicy({
    name: "schedule",
    args,
    kind: "extension",
    ...(overrides !== undefined ? { overrides } : {}),
  }).policy;
}

describe("command policy: /schedule (§5.2 web column)", () => {
  it("bare / list / show / log are allow (incl. read-only --all forms)", () => {
    for (const args of ["", "   ", "list", "show s_abcd2345", "log s_abcd2345", "list --all", "show s_abcd2345 --all"])
      expect(policy(args)).toBe("allow");
  });

  it("pause / resume / rm / run are confirm (anti-misclick only)", () => {
    for (const sub of ["pause", "resume", "rm", "run"]) expect(policy(`${sub} s_abcd2345`)).toBe("confirm");
  });

  it("--all write forms are deny", () => {
    for (const sub of ["pause", "resume", "rm", "run"]) expect(policy(`${sub} s_abcd2345 --all`)).toBe("deny");
  });

  it("approve / reject / __put are deny in every shape (removed with the approval concept; tightened from allow)", () => {
    for (const args of [
      `approve s_abcd2345 ${HASH}`,
      "approve s_abcd2345",
      "approve",
      `approve s_abcd2345 ${HASH} --all`,
      `reject s_abcd2345 ${HASH}`,
      "reject s_abcd2345",
      "reject",
      `__put {"name":"a b","prompt":"x --all y"} ${HASH}`,
      `__put {"name":"x"}`,
      `__put ${HASH}`,
    ])
      expect(policy(args)).toBe("deny");
  });

  it("add / edit / repair / unknown are deny", () => {
    for (const args of ["add", "add 0 8 * * * hello", "edit s_abcd2345", "repair", "bogus", "delete s_abcd2345"])
      expect(policy(args)).toBe("deny");
  });

  it("webCommandPolicy.schedule overrides the whole name", () => {
    expect(policy("list", { schedule: "deny" })).toBe("deny");
    expect(policy("add", { schedule: "allow" })).toBe("allow");
    expect(policy("rm s_abcd2345", { schedule: "allow" })).toBe("allow");
  });

  it("schedulePolicy is the table row: bare ⇒ allow, anything unknown ⇒ deny", () => {
    expect(schedulePolicy([])).toEqual({ policy: "allow" });
    expect(schedulePolicy(["approve", "s_abcd2345", HASH])).toEqual({ policy: "deny" });
    expect(schedulePolicy(["__put", "{}", HASH])).toEqual({ policy: "deny" });
    expect(schedulePolicy(["pause", "s_abcd2345"])).toEqual({ policy: "confirm" });
  });
});
