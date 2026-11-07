import { describe, expect, it } from "vitest";
import {
  authorize,
  effectiveCanMessage,
  formatMessage,
  isMessageKind,
  makeMessageKey,
  parseMessageKey,
  type FabricRecord,
  type MessageKind,
  type MessageRelation,
} from "../../src/core/message.js";

const LEGACY_KIND: string = "finding"; // #34 legacy input

describe("fabric message protocol", () => {
  it("round-trips strict four-part message keys", () => {
    const key = makeMessageKey("r_ABCDEFGH", "r_12345678", 3, 9);
    expect(parseMessageKey(key)).toEqual({ from: "r_ABCDEFGH", to: "r_12345678", generation: 3, seq: 9, key });
    for (const invalid of [
      "r_ABCDEFGH:r_12345678:3",
      "r_ABCDEFGH:r_12345678:x:1",
      "r:root:0:1",
      "r_ABCDEFGH:r_12345678:0:0",
      "system:r_12345678:1:1",
      "r_ABCDEFGH:r_12345678:01:1",
      "r_ABCDEFGH:r_12345678:1:01",
    ]) {
      expect(parseMessageKey(invalid)).toBeUndefined();
    }
  });

  it("defaults undefined canMessage to parent", () => {
    expect(effectiveCanMessage(undefined)).toEqual(["parent"]);
    expect(authorize({ kind: "report", relation: "parent" })).toBe(true);
    expect(authorize({ kind: "report", relation: "child" })).toBe(false);
    expect(authorize({ kind: "result", relation: "child" })).toBe(true);
    expect(authorize({ kind: "result", relation: "parent" })).toBe(false);
    expect(authorize({ kind: "directive", relation: "parent" })).toBe(true);
    expect(authorize({ kind: "directive", relation: "ancestor" })).toBe(false);
    expect(authorize({ kind: "dead_letter", relation: "parent", from: "r_ABCDEFGH" })).toBe(false);
    expect(authorize({ kind: "dead_letter", relation: "unrelated", from: "system" })).toBe(true);
    expect(
      authorize({
        kind: "report",
        relation: "unrelated",
        from: "r_ABCDEFGH",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
        canMessage: ["mention"],
      }),
    ).toBe(true);
    expect(
      authorize({
        kind: "report",
        relation: "unrelated",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
      }),
    ).toBe(false);
    expect(
      authorize({
        kind: "directive",
        relation: "unrelated",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
        canMessage: ["mention"],
      }),
    ).toBe(false);
    expect(
      authorize({
        kind: "result",
        relation: "unrelated",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
        canMessage: ["mention"],
      }),
    ).toBe(false);
    expect(
      authorize({
        kind: "report",
        relation: "unrelated",
        from: "r_12345678",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
        canMessage: ["mention"],
      }),
    ).toBe(false);
  });

  it("keeps untrusted-input declaration in the header only", () => {
    const base = {
      key: makeMessageKey("r_ABCDEFGH", "r_12345678", 1, 1),
      from: "r_ABCDEFGH" as const,
      to: "r_12345678" as const,
      seq: 1,
      payload: { text: "do this" },
    };
    expect(formatMessage({ ...base, kind: "report" }, "parent").header).toContain("不可信输入");
    expect(formatMessage({ ...base, kind: "report" }, "parent").text).toContain("do this");
    expect(formatMessage({ ...base, kind: "directive" }, "parent").text).toContain("<fabric-directive>");
    expect(formatMessage({ ...base, kind: "directive" }, "sibling").text).toContain("do this");
    expect(
      formatMessage({ ...base, kind: "report", via: { mode: "mention", lca: "root", hops: [] } }, "sibling").header,
    ).toContain("relation=mention");
    expect(formatMessage({ ...base, kind: "report", via: { lca: "root", hops: [] } }, "sibling").header).toContain(
      "relation=sibling",
    );
  });

  it("represents rejected and dead-letter records with the prescribed states", () => {
    const rejected: FabricRecord = {
      ...{
        key: makeMessageKey("r_ABCDEFGH", "root", 1, 1),
        from: "r_ABCDEFGH",
        to: "root",
        kind: "report",
        seq: 1,
        generation: 1,
        payload: { text: "x" },
        ttlMs: 1,
        createdAt: 0,
      },
      state: "dropped",
      attempts: 0,
      updatedAt: 0,
      rejected: { reason: "quota_exhausted" },
    };
    expect(rejected.state).toBe("dropped");
    expect(rejected.attempts).toBe(0);
  });
});

describe("#34 unknown-kind predicate (T-U1)", () => {
  it("isMessageKind accepts exactly the five current kinds and nothing else", () => {
    for (const kind of ["progress", "report", "directive", "result", "dead_letter"])
      expect(isMessageKind(kind)).toBe(true);
    for (const bad of [LEGACY_KIND, "", undefined, 42, null, {}, []]) expect(isMessageKind(bad)).toBe(false);
  });

  it("authorize is false for a pre-#34 kind across every relation x can_message combination", () => {
    const relations: readonly MessageRelation[] = [
      "self",
      "parent",
      "child",
      "ancestor",
      "descendant",
      "sibling",
      "unrelated",
    ];
    const canSets = [
      undefined,
      [],
      ["parent"],
      ["child"],
      ["ancestor"],
      ["descendant"],
      ["sibling"],
      ["self"],
      ["mention"],
      ["parent", "mention"],
    ] as const;
    for (const relation of relations)
      for (const canMessage of canSets) {
        const base = {
          kind: LEGACY_KIND as MessageKind,
          relation,
          ...(canMessage === undefined ? {} : { canMessage }),
        };
        expect(authorize(base)).toBe(false);
        expect(authorize({ ...base, from: "r_ABCDEFGH" })).toBe(false);
        expect(
          authorize({
            ...base,
            from: "r_ABCDEFGH",
            mention: { kind: "mention", label: "l", target: "r_12345678" },
          }),
        ).toBe(false);
        expect(authorize({ ...base, from: "system", route: { kind: "wake_result", runId: "r_12345678" } })).toBe(false);
      }
  });
});
