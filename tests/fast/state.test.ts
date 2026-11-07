import { describe, expect, it } from "vitest";
import {
  foldFastBranch,
  readFastMode,
  snapshotToFastSeed,
  validateFastRecord,
  toggleFast,
} from "../../src/fast/state.js";
const entry = (data: unknown) => ({ type: "custom", customType: "subagent:fast", data });
describe("Fast history pure state", () => {
  it("folds only the selected branch, last record wins including inherit tombstones", () => {
    const branch = Object.freeze([entry({ v: 1, mode: "on" }), entry({ v: 1, mode: "off" })]);
    expect(foldFastBranch([])).toEqual({ mode: "inherit", invalidRecord: false });
    expect(readFastMode(branch)).toBe("off");
    expect(readFastMode(branch.slice(0, 1))).toBe("on");
    expect(readFastMode([...branch, entry({ v: 1, mode: "inherit" })])).toBe("inherit");
    expect(readFastMode([{ ...entry({ v: 1, mode: "on" }), type: "message" }])).toBe("inherit");
  });
  it.each([null, {}, { v: 2, mode: "on" }, { v: 1, mode: "ON" }, { v: 1 }, Object.create({ v: 1, mode: "on" })])(
    "latest invalid record does not resurrect on: %s",
    (data) => {
      expect(foldFastBranch([entry({ v: 1, mode: "on" }), entry(data)])).toEqual({
        mode: "inherit",
        invalidRecord: true,
      });
    },
  );
  it("does not execute record/entry accessors or inherit prototype fields", () => {
    let reads = 0;
    const bad = Object.defineProperty({}, "mode", {
      get() {
        reads++;
        return "on";
      },
    });
    expect(validateFastRecord(bad)).toBeUndefined();
    expect(
      foldFastBranch([
        entry({ v: 1, mode: "on" }),
        Object.defineProperty(entry(null), "data", {
          get() {
            reads++;
            return { v: 1, mode: "on" };
          },
        }),
      ]),
    ).toEqual({ mode: "inherit", invalidRecord: true });
    expect(
      foldFastBranch([
        entry({ v: 1, mode: "on" }),
        Object.assign(Object.create({ evil: true }), entry({ v: 1, mode: "off" })),
      ]),
    ).toEqual({ mode: "inherit", invalidRecord: true });
    expect(reads).toBe(0);
  });
  it("ignores unknown record fields without reading them; seed projects exactly two keys", () => {
    const data = Object.defineProperty({ v: 1, mode: "on" }, "future", {
      get() {
        throw Error("must not read");
      },
    });
    expect(validateFastRecord(data)).toEqual({ v: 1, mode: "on" });
    const state = Object.freeze({ mode: "off" as const, revision: 77, incarnation: {}, owner: "secret" });
    expect(snapshotToFastSeed(state)).toEqual({ v: 1, mode: "off" });
    expect(Object.keys(snapshotToFastSeed(state))).toEqual(["v", "mode"]);
  });
  it("toggle never guesses provider default", () => {
    expect(["inherit", "on", "off"].map((m) => toggleFast(m as "inherit" | "on" | "off"))).toEqual(["on", "off", "on"]);
  });
});
it("prototype-only Fast entries and accessor type cannot tunnel to an older on", () => {
  const prior = entry({ v: 1, mode: "on" });
  expect(
    foldFastBranch([
      prior,
      Object.create({ customType: "subagent:fast", type: "custom", data: { v: 1, mode: "off" } }),
    ]),
  ).toEqual({ mode: "inherit", invalidRecord: true });
  const latest = Object.defineProperty(entry({ v: 1, mode: "off" }), "type", {
    get() {
      throw Error("must not execute");
    },
  });
  expect(foldFastBranch([prior, latest])).toEqual({ mode: "inherit", invalidRecord: true });
});
it("seeded branch-fold invariants: prefixes/forks and future tombstones", async () => {
  const fc = await import("fast-check");
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("inherit" as const, "on" as const, "off" as const), { maxLength: 40 }),
      (modes) => {
        const branch = modes.map((mode) => Object.freeze(entry(Object.freeze({ v: 1, mode }))));
        const frozen = Object.freeze(branch);
        for (let n = 0; n <= branch.length; n++)
          expect(readFastMode(frozen.slice(0, n))).toBe(modes[n - 1] ?? "inherit");
        expect(foldFastBranch([...frozen, entry({ v: 99, mode: "on" })])).toEqual({
          mode: "inherit",
          invalidRecord: true,
        });
        expect(modes).toEqual(branch.map((e) => (e.data as { mode: string }).mode));
      },
    ),
    { seed: 5501, numRuns: 100 },
  );
});
it.each([{}, { type: "message" }, { type: undefined }])(
  "a malformed latest own Fast envelope masks an older on: %s",
  (extra) => {
    const prior = entry({ v: 1, mode: "on" });
    const latest = { customType: "subagent:fast", data: { v: 1, mode: "off" }, ...extra };
    expect(foldFastBranch([prior, latest])).toEqual({ mode: "inherit", invalidRecord: true });
  },
);
