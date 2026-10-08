/**
 * web-hub session-history plan §4.2 (P0): runtime pins for `protocol/session-history.ts` —
 * the `isValidSessionKey` matrix, cursor encode/decode round-trips, the constants, and the
 * module's purity (no typebox / `node:*` imports — the browser UI imports it directly).
 *
 * The `HISTORY_CHILD_MARKER_TYPE` ⇔ `session-driver.ts`'s `SUBAGENT_CHILD_CUSTOM_TYPE`
 * pin reads the driver's SOURCE (never imports it — the driver drags pi modules into what
 * must stay a browser-importable module's test).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CURSOR_EXPIRED_REASON,
  HISTORY_CHILD_MARKER_TYPE,
  HISTORY_CURSOR_MAX_CHARS,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  HISTORY_Q_MAX_CHARS,
  HISTORY_TITLE_MAX,
  SESSION_KEY_MAX_BYTES,
  SESSION_OPEN_REASON,
  decodeHistoryCursor,
  encodeHistoryCursor,
  isValidSessionKey,
} from "../../../src/web-hub/protocol/session-history.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../src/web-hub/protocol/session-history.ts");

describe("isValidSessionKey 矩阵 (plan §4.2)", () => {
  it.each([
    ["plain dir/file", "d1/019a2b3c.jsonl"],
    ["minimal legal shape", "a/b.jsonl"], // dir 1 char, file exactly 7 (".jsonl" + 1)
    ["dotfile dir is not '.'", ".hidden/sess.jsonl"],
    ["segment at exactly 255 chars (dir)", `${"d".repeat(255)}/x.jsonl`],
    ["segment at exactly 255 chars (file)", `a/${"e".repeat(249)}.jsonl`], // 249 + 6 = 255
    ["whole key at exactly 512 UTF-8 bytes", `${"é".repeat(252)}/a.jsonl`], // 504 + 1 + 7 = 512
  ])("accepts: %s", (_name, key) => {
    expect(isValidSessionKey(key)).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["no slash", "019a2b3c.jsonl"],
    ["bare dot", "."],
    ["bare dotdot", ".."],
    ["two slashes", "a/b/c.jsonl"],
    ["absolute path (leading empty segment)", "/home/u/x.jsonl"],
    ["trailing slash (empty file segment)", "a/"],
    ["dir is '..'", "../x.jsonl"],
    ["dir is '.'", "./x.jsonl"],
    ["file is '..'", "a/.."],
    ["file is exactly '.jsonl'", "a/.jsonl"],
    ["not .jsonl", "a/b.json"],
    ["NUL", "a/b\0c.jsonl"],
    ["CR", "a/b\rc.jsonl"],
    ["LF", "a/b\nc.jsonl"],
    ["dir segment 256 chars", `${"d".repeat(256)}/x.jsonl`],
    ["file segment 256 chars", `a/${"e".repeat(250)}.jsonl`], // 250 + 6 = 256
    ["whole key 513 UTF-8 bytes", `${"é".repeat(252)}/ab.jsonl`], // 504 + 1 + 8 = 513
  ])("rejects: %s", (_name, key) => {
    expect(isValidSessionKey(key)).toBe(false);
  });

  it("never throws on arbitrary strings", () => {
    for (const s of ["\u{1F600}".repeat(300), "/", "//", "a//b", "é/😀.jsonl", " ".repeat(600)]) {
      expect(() => isValidSessionKey(s)).not.toThrow();
    }
  });
});

describe("cursor encode/decode (plan §3.1/§4.2)", () => {
  const GEN = "abCD_19-xyz"; // 11 chars, base64url alphabet

  it("encodes as v1.<genId>.<pos> and round-trips", () => {
    for (const pos of [0, 1, 42, 999_999]) {
      const cur = encodeHistoryCursor(GEN, pos);
      expect(cur).toBe(`v1.${GEN}.${pos}`);
      expect(decodeHistoryCursor(cur)).toEqual({ genId: GEN, pos });
    }
  });

  it("decode accepts zero-padded pos (same logical cursor)", () => {
    expect(decodeHistoryCursor(`v1.${GEN}.000042`)).toEqual({ genId: GEN, pos: 42 });
  });

  it.each([
    ["empty", ""],
    ["wrong prefix v2", `v2.${GEN}.1`],
    ["no dot after prefix", `v1${GEN}.1`],
    ["genId 10 chars", `v1.${GEN.slice(0, 10)}.1`],
    ["genId 12 chars", `v1.${GEN}z.1`],
    ["genId with a dot", "v1.abCD.19-xy.1"],
    ["genId with illegal char", `v1.abCD_19-xy$.1`],
    ["negative pos", `v1.${GEN}.-1`],
    ["pos 1000000 (7 digits)", `v1.${GEN}.1000000`],
    ["pos with trailing junk", `v1.${GEN}.1x`],
    ["pos not numeric", `v1.${GEN}.x1`],
    ["missing pos", `v1.${GEN}`],
    ["missing genId", "v1..1"],
    ["length > HISTORY_CURSOR_MAX_CHARS", `v1.${GEN}.${"9".repeat(60)}`],
  ])("decode(%s) ⇒ null", (_name, s) => {
    expect(decodeHistoryCursor(s)).toBeNull();
  });

  it("a well-formed cursor never exceeds HISTORY_CURSOR_MAX_CHARS; decode never throws", () => {
    expect(HISTORY_CURSOR_MAX_CHARS).toBe(64);
    expect(encodeHistoryCursor(GEN, 999_999).length).toBeLessThanOrEqual(HISTORY_CURSOR_MAX_CHARS);
    for (const s of ["v1.", "....", `${"v1.".repeat(30)}`, "v1.\0abc.1", " "]) {
      expect(() => decodeHistoryCursor(s)).not.toThrow();
    }
  });

  it("encode validates its trusted-caller inputs (TypeError; the plan pins Never-throws only on the wire-facing pair)", () => {
    expect(() => encodeHistoryCursor("short", 1)).toThrow(TypeError);
    expect(() => encodeHistoryCursor(`${GEN}z`, 1)).toThrow(TypeError);
    expect(() => encodeHistoryCursor("abCD_19-xy$", 1)).toThrow(TypeError);
    expect(() => encodeHistoryCursor(GEN, -1)).toThrow(TypeError);
    expect(() => encodeHistoryCursor(GEN, 1_000_000)).toThrow(TypeError);
    expect(() => encodeHistoryCursor(GEN, 1.5)).toThrow(TypeError);
  });
});

describe("constants (plan §3.1)", () => {
  it("carries the plan's values", () => {
    expect(HISTORY_LIMIT_DEFAULT).toBe(50);
    expect(HISTORY_LIMIT_MAX).toBe(100);
    expect(HISTORY_Q_MAX_CHARS).toBe(128);
    expect(SESSION_KEY_MAX_BYTES).toBe(512);
    expect(HISTORY_TITLE_MAX).toBe(200);
    expect(HISTORY_CHILD_MARKER_TYPE).toBe("subagent:child");
    expect(SESSION_OPEN_REASON).toBe("session-open");
    expect(CURSOR_EXPIRED_REASON).toBe("cursor-expired");
  });

  it("HISTORY_CHILD_MARKER_TYPE ⇔ session-driver's SUBAGENT_CHILD_CUSTOM_TYPE (§3.1 source-scan pin; read, never imported — the driver drags pi modules)", () => {
    const driver = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../src/runtime/session-driver.ts"),
      "utf8",
    );
    const m = /export const SUBAGENT_CHILD_CUSTOM_TYPE = "([^"]+)"/.exec(driver);
    expect(m?.[1]).toBe(HISTORY_CHILD_MARKER_TYPE);
  });
});

describe("module purity (plan §3.1: browser-importable)", () => {
  it("imports neither typebox nor node:*", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).not.toMatch(/from\s+"@sinclair\//);
    expect(src).not.toMatch(/from\s+"node:/);
    expect(src).not.toMatch(/require\("node:/);
  });
});
