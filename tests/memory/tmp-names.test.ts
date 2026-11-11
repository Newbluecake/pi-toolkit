import { describe, expect, it } from "vitest";
import { parseTmpName, TMP_KINDS, TMP_RE, tmpNameFor, type TmpKind } from "../../src/memory/tmp-names.js";

describe("shared transaction temporary-name grammar", () => {
  it("round-trips the historical operation name and rejects unrelated legacy names", () => {
    const name = tmpNameFor("deadbeef", 12, "b");
    expect(name).toBe(".pt-deadbeef-12-b.tmp");
    expect(TMP_RE.test(name)).toBe(true);
    expect(parseTmpName(name)).toEqual({ nonce8: "deadbeef", seq: 12, kind: "b" });
    expect(parseTmpName(".topic.123.tmp")).toBeUndefined();
    expect(() => tmpNameFor("deadbeef", 1, "m")).toThrow();
  });
  it.each(Object.keys(TMP_KINDS) as TmpKind[])("validates kind %s and enforces non-operation seq=0", (kind) => {
    const name = tmpNameFor("0123abcd", 0, kind);
    expect(TMP_RE.test(name)).toBe(true);
    expect(parseTmpName(name)).toEqual({ nonce8: "0123abcd", seq: 0, kind });
    for (const seq of [1, 999999]) {
      if (kind === "b" || kind === "c") {
        expect(parseTmpName(tmpNameFor("0123abcd", seq, kind))).toEqual({ nonce8: "0123abcd", seq, kind });
      } else {
        expect(() => tmpNameFor("0123abcd", seq, kind)).toThrow("requires sequence 0");
        expect(parseTmpName(`.pt-0123abcd-${seq}-${kind}.tmp`)).toBeUndefined();
      }
    }
  });
  it.each(["DEADBEEF", "abcdefg1", "abcdef0", "abcdef012", "../abcde", "deadbeef\n"])(
    "rejects invalid nonce %j",
    (nonce) => {
      expect(() => tmpNameFor(nonce, 0, "b")).toThrow();
      expect(parseTmpName(`.pt-${nonce}-0-b.tmp`)).toBeUndefined();
    },
  );
  it.each([-1, 1.5, NaN, Infinity, 1000000])("rejects invalid sequence %s", (seq) => {
    expect(() => tmpNameFor("deadbeef", seq, "b")).toThrow("invalid tmp sequence");
    expect(parseTmpName(`.pt-deadbeef-${seq}-b.tmp`)).toBeUndefined();
  });
  it.each(["", "z", "__proto__", "toString"])("rejects invalid kind %j", (kind) => {
    expect(() => tmpNameFor("deadbeef", 0, kind as TmpKind)).toThrow("invalid tmp kind");
    expect(parseTmpName(`.pt-deadbeef-0-${kind}.tmp`)).toBeUndefined();
  });
  it.each(["pt-deadbeef-1-b.tmp", ".pt-deadbeef-1-b.tmp/", ".pt-deadbeef-1-b.txt", ".pt-deadbeef-1-b.tmp.extra"])(
    "rejects malformed name %s",
    (name) => {
      expect(parseTmpName(name)).toBeUndefined();
    },
  );
});
