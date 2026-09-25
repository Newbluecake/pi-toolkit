import { describe, expect, it } from "vitest";
import {
  P1_CAPS,
  PROTO,
  RESERVED_FRAME_TYPES,
  compareVersions,
  protoCompatible,
} from "../../../src/web-hub/protocol/version.js";

describe("compareVersions", () => {
  type Row = [string, string, -1 | 0 | 1];
  const rows: Row[] = [
    ["1.0.0", "1.0.0", 0],
    ["1.0.0", "2.0.0", -1],
    ["2.0.0", "1.0.0", 1],
    ["1.2.3", "1.2.4", -1],
    ["1.2.3", "1.3.0", -1],
    ["1.9.0", "1.10.0", -1], // numeric, not lexicographic
    ["0.2.1", "0.2.2", -1],
    ["10.0.0", "9.99.99", 1],
    ["1.2.3-beta.1", "1.2.3", 0], // prerelease ignored (core three segments only)
    ["1.2.3+build.7", "1.2.3+build.8", 0],
    ["v1.2.3", "1.2.3", 0], // leading v tolerated
    [" 1.2.3 ", "1.2.3", 0],
    ["garbage", "0.0.0", 0], // invalid → 0.0.0
    ["garbage", "0.0.1", -1],
    ["1.2", "1.2.0", -1], // missing patch segment → invalid → 0.0.0
    ["", "0.0.0", 0],
    ["1.2.3.4", "1.2.3", 0],
  ];

  it.each(rows)("compareVersions(%j, %j) === %d", (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
  });

  it("is antisymmetric", () => {
    expect(compareVersions("0.2.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0", "0.2.1")).toBe(1);
  });
});

describe("protoCompatible", () => {
  it("accepts same major", () => {
    expect(protoCompatible({ major: PROTO.major })).toBe(true);
  });
  it("rejects other majors", () => {
    expect(protoCompatible({ major: PROTO.major + 1 })).toBe(false);
    expect(protoCompatible({ major: PROTO.major - 1 })).toBe(false);
  });
});

describe("constants", () => {
  it("P1_CAPS / RESERVED_FRAME_TYPES are stable", () => {
    expect([...P1_CAPS]).toEqual(["ev.v1", "fleet.v1", "snapshot.v1", "branch.v1"]);
    expect([...RESERVED_FRAME_TYPES]).toEqual([
      "cmd",
      "cmd_result",
      "dialog_open",
      "dialog_closed",
      "dialog_answer",
      "superseded",
    ]);
    expect(PROTO).toEqual({ major: 1, minor: 0 });
  });
});
