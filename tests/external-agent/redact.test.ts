import { describe, expect, it } from "vitest";
import { createRedactor } from "../../src/external-agent/redact.js";

describe("createRedactor", () => {
  it("masks the exact FACTORY_API_KEY value by default", () => {
    const r = createRedactor({ FACTORY_API_KEY: "fk-abcdef123456" });
    expect(r("auth failed for fk-abcdef123456, retry fk-abcdef123456")).toBe("auth failed for ***, retry ***");
  });
  it("masks values of caller-supplied env keys (provider-agnostic) and not the default key then", () => {
    const r = createRedactor({ CODEX_KEY: "cx-998877", FACTORY_API_KEY: "fk-abcdef123456" }, ["CODEX_KEY"]);
    expect(r("x cx-998877 y fk-abcdef123456")).toBe("x *** y fk-abcdef123456");
  });
  it("applies the generic hygiene rule", () => {
    const r = createRedactor({});
    expect(r("api_key=SECRET1 and token: abc and Authorization: Bearer zzz")).not.toMatch(/SECRET1|abc\b|zzz/);
    expect(r("api-key SECRET2")).toBe("api-key ***");
    expect(r("nothing sensitive here")).toBe("nothing sensitive here");
  });
  it("ignores unset / too-short env values (does not blank unrelated text)", () => {
    const r = createRedactor({ FACTORY_API_KEY: "ab" });
    expect(r("a b ab c")).toBe("a b ab c");
    expect(createRedactor({})("hello")).toBe("hello");
    expect(r("")).toBe("");
  });
});
