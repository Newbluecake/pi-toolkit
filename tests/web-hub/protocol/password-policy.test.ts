import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMON_PASSWORD_COUNT, COMMON_PASSWORDS } from "../../../src/web-hub/protocol/common-passwords.js";
import { checkLanPassword, LAN_PASSWORD_POLICY_VERSION } from "../../../src/web-hub/protocol/password-policy.js";
import { MAX_LAN_PASSWORD_LENGTH, MIN_LAN_PASSWORD_LENGTH } from "../../../src/web-hub/protocol/lan.js";

const check = (password: string, username = "alice") => checkLanPassword(password, { username });
const strong = "maple orbit velvet canoe";

describe("LAN password policy P4 / D5", () => {
  it("import and length/pattern rejection do not construct the lazy corpus lookup", () => {
    const key = Symbol.for("pi-subagent:lan-password-policy:v1");
    expect(Reflect.get(globalThis, key)).toBeUndefined();
    expect(check("short")).toEqual({ ok: false, reason: "length" });
    expect(check("aaaaaaaaaa")).toEqual({ ok: false, reason: "pattern" });
    expect(Reflect.get(globalThis, key)).toBeUndefined();
    expect(check(strong)).toEqual({ ok: true });
    const lookup = Reflect.get(globalThis, key);
    expect(typeof lookup).toBe("function");
    expect(check("password123")).toEqual({ ok: false, reason: "common" });
    expect(Reflect.get(globalThis, key)).toBe(lookup);
  });

  it("pins policy version, actual unique corpus count, content digest and data file size", () => {
    expect(LAN_PASSWORD_POLICY_VERSION).toBe(1);
    expect(COMMON_PASSWORD_COUNT).toBe(9126);
    const entries = COMMON_PASSWORDS.split("\n");
    expect(entries).toHaveLength(COMMON_PASSWORD_COUNT);
    expect(new Set(entries).size).toBe(COMMON_PASSWORD_COUNT);
    expect(entries.every((p) => p === p.normalize("NFKC").toLowerCase())).toBe(true);
    expect(createHash("sha256").update(COMMON_PASSWORDS).digest("hex")).toBe(
      "6e584555cbb81c7e59c1dde0fce774828814392c34425561f25e5584fa80d2c4",
    );
    expect(
      readFileSync(new URL("../../../src/web-hub/protocol/common-passwords.ts", import.meta.url)).byteLength,
    ).toBeLessThan(150_000);
  });

  it.each([strong, "Tr0ub4dor&3x9", "清晨山间微风伴我漫步看星空", "abcdacbdadbcabdc"])(
    "accepts %s without composition or character-variety rules",
    (password) => {
      expect(check(password)).toEqual({ ok: true });
    },
  );

  it.each([
    "password123",
    "Password2024!",
    "p@ssw0rd!!",
    "123password456",
    "W3lc0m32024!",
    "!!adm1n!!42",
    "Ｐａｓｓｗｏｒｄ２０２４！",
    "!!m1ch3113!!42",
    "123bmw456!",
    "123@dm1n456!",
  ])("rejects common/leet/wrapped credentials %s", (password) => {
    expect(check(password)).toEqual({ ok: false, reason: "common" });
  });

  it.each([
    "qwertyuiop",
    "poiuytrewq",
    "9876543210",
    "abcdefghij",
    "aaaaaaaaaa",
    "ababababab",
    "abcabcabca",
    "你好你好你好你好你好",
  ])("rejects keyboard, arithmetic and short-unit repetition %s", (password) => {
    expect(check(password)).toEqual({ ok: false, reason: "pattern" });
  });

  it.each(["alice-secret-1", "my-webhub-pass", "my-pi-webhub-pass", "ＡＬＩＣＥ-orbit-velvet"])(
    "rejects normalized account/service names %s",
    (password) => {
      expect(check(password)).toEqual({ ok: false, reason: "username" });
    },
  );
  it("ignores usernames shorter than three characters and compares Unicode case-insensitively", () => {
    expect(check("ab-orbit-velvet", "ab")).toEqual({ ok: true });
    expect(check("ÅLICE-orbit-velvet", "ålice")).toEqual({ ok: false, reason: "username" });
  });

  it("counts original UTF-16 units at 9/10/256/257, including surrogate pairs", () => {
    expect(MIN_LAN_PASSWORD_LENGTH).toBe(10);
    expect(MAX_LAN_PASSWORD_LENGTH).toBe(256);
    const ten = "vJ8!kR2@xQ";
    for (const [password, ok] of [
      [ten.slice(0, 9), false],
      [ten, true],
      [strong.padEnd(256, "x"), true],
      [strong.padEnd(257, "x"), false],
      ["😀vJ8!kR2@", true],
      ["😀vJ8!kR2", false],
    ] as const) {
      expect(check(password)).toEqual(ok ? { ok: true } : { ok: false, reason: "length" });
    }
  });
  it("NFKC expansion/contraction does not change the length bounds", () => {
    // U+FB03 expands from 1 to 3; U+1D400 contracts from 2 UTF-16 units to 1.
    expect(check("ﬃvJ8!kR2@")).toEqual({ ok: false, reason: "length" });
    expect(check("𝐀vJ8!kR2@")).toEqual({ ok: true });
    expect(check("ＶＪ８！ｋＲ２＠ｘＱ")).toEqual({ ok: true });
  });
});
