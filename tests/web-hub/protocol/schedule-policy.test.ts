/**
 * scheduled-reports plan r3 §5.2 (S0): the `/schedule` row of the web command-policy table
 * (src/web-hub/agent/command-policy.ts). Lives under tests/web-hub/protocol/ because the S0 file
 * domain only admits schedule*.test.ts there (the policy module itself is agent-side).
 */
import { describe, expect, it } from "vitest";
import { resolveCommandPolicy, schedulePolicy } from "../../../src/web-hub/agent/command-policy.js";
import { SCHED_HASH_RE } from "../../../src/web-hub/protocol/schedule.js";

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
    expect(policy(`approve s_abcd2345 ${HASH} --all`)).toBe("deny");
  });

  it("reject mirrors approve: allow ONLY with exactly <id> <64-hex hash> (#61)", () => {
    expect(policy(`reject s_abcd2345 ${HASH}`)).toBe("allow");
    expect(policy("reject s_abcd2345")).toBe("deny");
    expect(policy("reject")).toBe("deny");
    expect(policy(`reject s_abcd2345 ${HASH.slice(0, 8)}`)).toBe("deny");
    expect(policy(`reject s_abcd2345 ${HASH} extra`)).toBe("deny");
    expect(policy(`reject s_abcd2345 ${HASH} --all`)).toBe("deny");
    expect(policy(`reject s_abcd2345 ${HASH}`, { schedule: "confirm" })).toBe("confirm");
  });

  it("approve is allow ONLY with exactly <id> <64-hex hash>", () => {
    expect(policy(`approve s_abcd2345 ${HASH}`)).toBe("allow");
    expect(policy("approve s_abcd2345")).toBe("deny");
    expect(policy("approve")).toBe("deny");
    expect(policy(`approve s_abcd2345 ${HASH.slice(0, 8)}`)).toBe("deny");
    expect(policy(`approve s_abcd2345 ${HASH.toUpperCase()}`)).toBe("deny");
    expect(policy(`approve s_abcd2345 ${HASH} extra`)).toBe("deny");
  });

  it("__put <json…> <hash> is allow; without a trailing hash it is deny", () => {
    expect(policy(`__put {"name":"a b","prompt":"x --all y"} ${HASH}`)).toBe("allow");
    expect(policy(`__put {"name":"x"}`)).toBe("deny");
    expect(policy(`__put ${HASH}`)).toBe("deny");
    expect(policy(`__put {"name":"x"} nothash`)).toBe("deny");
  });

  it("add / edit / repair / unknown are deny", () => {
    for (const args of ["add", "add 0 8 * * * hello", "edit s_abcd2345", "repair", "bogus", "delete s_abcd2345"])
      expect(policy(args)).toBe("deny");
  });

  it("webCommandPolicy.schedule overrides the whole name", () => {
    expect(policy("list", { schedule: "deny" })).toBe("deny");
    expect(policy("add", { schedule: "allow" })).toBe("allow");
    expect(policy(`approve s_abcd2345 ${HASH}`, { schedule: "confirm" })).toBe("confirm");
  });

  it("schedulePolicy is the table row and its hash shape mirrors SCHED_HASH_RE", () => {
    expect(schedulePolicy([])).toEqual({ policy: "allow" });
    expect(SCHED_HASH_RE.test(HASH)).toBe(true);
    // Every hash the mirror accepts the protocol accepts too (and vice versa) on a small corpus.
    for (const h of [HASH, HASH.toUpperCase(), HASH.slice(1), `${HASH}0`, "g".repeat(64)])
      expect(schedulePolicy(["approve", "s_abcd2345", h]).policy === "allow").toBe(SCHED_HASH_RE.test(h));
  });
});
