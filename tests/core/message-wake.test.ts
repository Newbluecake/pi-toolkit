import { describe, expect, it } from "vitest";
import { authorize, type MessageKind, type MessageRelation } from "../../src/core/message.js";

/**
 * fabric-cross-session plan v3 §4.1 (S0): `route.kind === "wake_result"` ⇒ only `kind === "result" && from ===
 * "system"`; every legacy call (no route) authorizes exactly as before.
 */
const route = { kind: "wake_result", runId: "r_SUCC0001" } as const;
const KINDS: MessageKind[] = ["progress", "finding", "directive", "result", "dead_letter"];
const RELATIONS: MessageRelation[] = ["self", "parent", "child", "ancestor", "descendant", "sibling", "unrelated"];

describe("authorize() with a wake_result route", () => {
  it("allows exactly system → result", () => {
    expect(authorize({ kind: "result", relation: "unrelated", from: "system", route })).toBe(true);
    // the relation / can_message rules are irrelevant to a system receipt
    for (const relation of RELATIONS)
      expect(authorize({ kind: "result", relation, from: "system", route, canMessage: [] })).toBe(true);
  });

  it("refuses every other (kind, from) combination", () => {
    for (const kind of KINDS)
      for (const from of ["root", "system", "r_ABCDEFGH", undefined] as const) {
        const expected = kind === "result" && from === "system";
        expect(
          authorize({ kind, relation: "child", from, route, canMessage: ["parent", "child", "mention"] }),
          `${kind}/${from}`,
        ).toBe(expected);
      }
  });

  it("never combines with a mention route, and an unknown kind is still refused first", () => {
    expect(
      authorize({
        kind: "result",
        relation: "child",
        from: "system",
        route,
        mention: { kind: "mention", label: "x", target: "r_ABCDEFGH" },
      }),
    ).toBe(false);
    expect(authorize({ kind: "nope" as MessageKind, relation: "child", from: "system", route })).toBe(false);
  });

  it("legacy calls (no route) are unchanged: a system `result` still needs a child relation", () => {
    expect(authorize({ kind: "result", relation: "child", from: "system" })).toBe(true);
    expect(authorize({ kind: "result", relation: "unrelated", from: "system" })).toBe(false);
    expect(authorize({ kind: "result", relation: "parent", from: "system" })).toBe(false);
    expect(authorize({ kind: "dead_letter", relation: "unrelated", from: "system" })).toBe(true);
    expect(authorize({ kind: "finding", relation: "parent", canMessage: ["parent"] })).toBe(true);
  });
});
