/** alias-force-default plan §5.1/§5.2 (AF0): pure auto-claim helpers. */
import { describe, expect, it } from "vitest";
import { type AutoClaimFacts, deriveAutoAlias, shouldAutoClaim } from "../../src/fabric/xs/alias-auto.js";

const dirs = { home: "/home/u", tmpdir: "/tmp" };

describe("deriveAutoAlias", () => {
  it("normal project directories derive their basename", () => {
    expect(deriveAutoAlias("/home/u/ai/web", dirs)).toEqual({ ok: true, alias: "web" });
    expect(deriveAutoAlias("/home/u/ai/My Project/", dirs)).toEqual({ ok: true, alias: "my-project" });
    expect(deriveAutoAlias("/home/u/项目/前端", dirs)).toEqual({ ok: true, alias: "前端" });
    expect(deriveAutoAlias("C:\\work\\admin-ui", dirs)).toEqual({ ok: true, alias: "admin-ui" });
  });

  it("/, $HOME, os.tmpdir() and an empty cwd are skipped as `dir` (trailing/duplicate separators do not matter)", () => {
    for (const cwd of ["/", "//", "", undefined, "/home/u", "/home/u/", "/home//u", "/tmp", "/tmp/"]) {
      expect(deriveAutoAlias(cwd, dirs), String(cwd)).toEqual({ ok: false, reason: "dir" });
    }
  });

  it("only the exact $HOME / tmpdir is special — their children and look-alikes are fine", () => {
    expect(deriveAutoAlias("/home/u/work", dirs)).toEqual({ ok: true, alias: "work" });
    expect(deriveAutoAlias("/tmp/build", dirs)).toEqual({ ok: true, alias: "build" });
    expect(deriveAutoAlias("/home/user", dirs)).toEqual({ ok: false, reason: "invalid" }); // "user" is reserved — but not a `dir` skip
    expect(deriveAutoAlias("/home/uu", dirs)).toEqual({ ok: true, alias: "uu" });
  });

  it("missing home/tmpdir injections disable only that comparison", () => {
    expect(deriveAutoAlias("/home/u", {})).toEqual({ ok: true, alias: "u" });
    expect(deriveAutoAlias("/home/u")).toEqual({ ok: true, alias: "u" });
  });

  it("underivable basenames are skipped as `invalid` — no parent fallback, no suffix, no prefix stripping (D4)", () => {
    for (const cwd of [
      "/home/u/ai/pi-toolkit",
      "/home/u/ai/deadbeef",
      "/home/u/ai/123",
      "/home/u/ai/🚀",
      "/srv/root",
    ]) {
      expect(deriveAutoAlias(cwd, dirs), cwd).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("shouldAutoClaim", () => {
  const all: AutoClaimFacts = {
    autoFromCwd: true,
    mainSession: true,
    aliasUsable: true,
    hubAliasV2: true,
    joined: true,
    decided: false,
    pendingHandoff: false,
  };

  it("all clauses satisfied ⇒ claim", () => {
    expect(shouldAutoClaim(all)).toEqual({ claim: true });
  });

  it("each clause failing alone blocks the claim, with the matching status token", () => {
    expect(shouldAutoClaim({ ...all, autoFromCwd: false })).toEqual({ claim: false, skip: "off" });
    expect(shouldAutoClaim({ ...all, mainSession: false })).toEqual({ claim: false, skip: "off" });
    expect(shouldAutoClaim({ ...all, aliasUsable: false })).toEqual({ claim: false, skip: "off" });
    expect(shouldAutoClaim({ ...all, hubAliasV2: false })).toEqual({ claim: false, skip: "hub-cap" });
    expect(shouldAutoClaim({ ...all, joined: false })).toEqual({ claim: false, skip: "not-joined" });
    expect(shouldAutoClaim({ ...all, decided: true })).toEqual({ claim: false, skip: "decided" });
    expect(shouldAutoClaim({ ...all, pendingHandoff: true })).toEqual({ claim: false, skip: "handoff-pending" });
  });

  it("full truth table: claim iff every fact is favourable (128 combinations)", () => {
    const keys = [
      "autoFromCwd",
      "mainSession",
      "aliasUsable",
      "hubAliasV2",
      "joined",
      "decided",
      "pendingHandoff",
    ] as const;
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const facts = Object.fromEntries(keys.map((k, i) => [k, (mask & (1 << i)) !== 0])) as unknown as AutoClaimFacts;
      const expected =
        facts.autoFromCwd &&
        facts.mainSession &&
        facts.aliasUsable &&
        facts.hubAliasV2 &&
        facts.joined &&
        !facts.decided &&
        !facts.pendingHandoff;
      expect(shouldAutoClaim(facts).claim, JSON.stringify(facts)).toBe(expected);
    }
  });

  it("clause order: an earlier failing clause wins the reported reason", () => {
    const worst: AutoClaimFacts = {
      ...all,
      autoFromCwd: false,
      hubAliasV2: false,
      joined: false,
      decided: true,
      pendingHandoff: true,
    };
    expect(shouldAutoClaim(worst)).toEqual({ claim: false, skip: "off" });
    expect(shouldAutoClaim({ ...worst, autoFromCwd: true })).toEqual({ claim: false, skip: "hub-cap" });
    expect(shouldAutoClaim({ ...worst, autoFromCwd: true, hubAliasV2: true })).toEqual({
      claim: false,
      skip: "not-joined",
    });
    expect(shouldAutoClaim({ ...worst, autoFromCwd: true, hubAliasV2: true, joined: true })).toEqual({
      claim: false,
      skip: "decided",
    });
  });
});
