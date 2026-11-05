/**
 * B1 · family index + root resolution (BA §4.2 / BD4/BD5): real header shapes, moved-path
 * basename fallback, missing parents, cross-cwd forks, cycles, duplicate ids, full-index
 * resolution under `--cwd` filters, family-side split consistency.
 */
import { describe, expect, it } from "vitest";
import { buildFamilyIndex, resolveFamily, type UnresolvedReason } from "../../../../src/reflex/core/backtest/corpus.js";
import { splitOfRoot } from "../../../../src/reflex/core/backtest/split.js";
import { builderFor, feedFile, headerFact, headerLine, userLine, TG, eid } from "./fixtures-b1.js";
import type { SessionHeaderFact } from "../../../../src/reflex/core/types.js";

const DIR = "/sess";

function hdr(
  id: string,
  at: number,
  parentSession: string | undefined,
  file?: string,
  cwd?: string,
): SessionHeaderFact {
  return {
    file: file ?? `${DIR}/${at}_${id}.jsonl`,
    id,
    ...(parentSession !== undefined ? { parentSession } : {}),
    timestamp: at,
    cwd: cwd ?? "/home/unit/proj",
  };
}

describe("buildFamilyIndex + resolveFamily", () => {
  it("resolves a normal grandparent→parent→child chain to the same root", () => {
    const g = hdr("root-0001", TG, undefined);
    const p = hdr("mid-0002", TG + 1000, g.file);
    const c = hdr("leaf-0003", TG + 2000, p.file);
    const idx = buildFamilyIndex([g, p, c]);
    expect(resolveFamily(g.file, idx)).toEqual({ familyRoot: "root-0001" });
    expect(resolveFamily(p.file, idx)).toEqual({ familyRoot: "root-0001" });
    expect(resolveFamily(c.file, idx)).toEqual({ familyRoot: "root-0001" });
  });

  it("falls back to the basename id when the parent file moved directories", () => {
    const rootId = "aaaa1111-2222-3333-4444-555566667777";
    // (a) parent still at the referenced path ⇒ direct byPath hit
    const root = hdr(rootId, TG, undefined, "/old-place/1000_" + rootId + ".jsonl");
    const child = hdr("child-0009", TG + 5000, root.file);
    expect(resolveFamily(child.file, buildFamilyIndex([root, child]))).toEqual({ familyRoot: rootId });
    // (b) parent moved elsewhere; only the moved file is indexed ⇒ basename-id fallback
    const moved = hdr(rootId, TG, undefined, "/new-place/1000_" + rootId + ".jsonl");
    expect(resolveFamily(child.file, buildFamilyIndex([moved, child]))).toEqual({ familyRoot: rootId });
  });

  it("reports missing-parent when neither path nor basename id resolves", () => {
    const orphan = hdr("orphan-1", TG, "/gone/9999_nobody.jsonl");
    const idx = buildFamilyIndex([orphan]);
    expect(resolveFamily(orphan.file, idx)).toEqual<{} & { reason: UnresolvedReason }>({ reason: "missing-parent" });
  });

  it("resolves cross-cwd forks (family index spans ALL cwds regardless of --cwd)", () => {
    const rootCwdA = hdr("root-x", TG, undefined, `${DIR}/1_root-x.jsonl`, "/home/unit/a");
    const forkCwdB = hdr("fork-y", TG + 1000, rootCwdA.file, `${DIR}/2_fork-y.jsonl`, "/home/unit/b");
    const idx = buildFamilyIndex([rootCwdA, forkCwdB]);
    expect(resolveFamily(forkCwdB.file, idx)).toEqual({ familyRoot: "root-x" });
    // and the corpus builder, filtered to cwd B, still splits the fork by the FULL index
    const b = builderFor(
      [
        { id: "root-x", at: TG, cwd: "/home/unit/a", file: rootCwdA.file },
        { id: "fork-y", at: TG + 1000, cwd: "/home/unit/b", parentSession: rootCwdA.file, file: forkCwdB.file },
      ],
      { since: 0, cwd: "/home/unit/b" },
    );
    const fed = feedFile(
      b,
      { id: "fork-y", at: TG + 1000, cwd: "/home/unit/b", file: forkCwdB.file, parentSession: rootCwdA.file },
      [userLine({ id: eid(), at: TG + 2000, text: "后台还有几个 job" })],
    );
    expect(fed.turns).toHaveLength(1);
    expect(fed.turns[0]!.familyRoot).toBe("root-x");
    expect(fed.turns[0]!.split).toBe(splitOfRoot("root-x"));
  });

  it("marks every file on a parent cycle unresolved", () => {
    const a = hdr("cyc-a", TG, undefined);
    const b = hdr("cyc-b", TG + 1, a.file);
    a.parentSession = b.file; // close the loop
    const idx = buildFamilyIndex([a, b]);
    expect(resolveFamily(a.file, idx)).toEqual({ reason: "cycle" });
    expect(resolveFamily(b.file, idx)).toEqual({ reason: "cycle" });
  });

  it("refuses duplicate ids both as chain nodes and as basename fallbacks", () => {
    const d1 = hdr("dup-0001", TG, undefined, `${DIR}/1_dup-0001.jsonl`);
    const d2 = hdr("dup-0001", TG + 1, undefined, `${DIR}/2_dup-0001.jsonl`);
    const child = hdr("kid-0002", TG + 2, d1.file);
    const idx = buildFamilyIndex([d1, d2, child]);
    expect(resolveFamily(child.file, idx)).toEqual({ reason: "duplicate-id" });
    expect(resolveFamily(d1.file, idx)).toEqual({ reason: "duplicate-id" });
    // a moved-path fallback pointing at the duplicated id is not adopted either
    const orphan = hdr("kid-0003", TG + 3, "/moved/9_dup-0001.jsonl");
    const idx2 = buildFamilyIndex([d1, d2, orphan]);
    expect(resolveFamily(orphan.file, idx2)).toEqual({ reason: "missing-parent" });
  });

  it("flags files absent from the index (caller bug channel)", () => {
    const idx = buildFamilyIndex([hdr("solo-1", TG, undefined)]);
    expect(resolveFamily("/elsewhere/1_ghost.jsonl", idx)).toEqual({ reason: "not-in-index" });
  });

  it("keeps both sides of one family on the SAME split", () => {
    const root = hdr("famroot-1", TG, undefined, `${DIR}/1_famroot-1.jsonl`);
    const fork = hdr("forkkid-2", TG + 9, root.file, `${DIR}/2_forkkid-2.jsonl`);
    const idx = buildFamilyIndex([root, fork]);
    const side = splitOfRoot("famroot-1");
    for (const f of [root, fork]) {
      const res = resolveFamily(f.file, idx);
      expect(res.familyRoot).toBe("famroot-1");
    }
    const b = builderFor(
      [
        { id: "famroot-1", at: TG, file: root.file },
        { id: "forkkid-2", at: TG + 9, parentSession: root.file, file: fork.file },
      ],
      { since: 0 },
    );
    const t1 = feedFile(b, { id: "famroot-1", at: TG, file: root.file }, [
      userLine({ id: eid(), at: TG + 10, text: "一" }),
    ]).turns;
    const t2 = feedFile(b, { id: "forkkid-2", at: TG + 9, parentSession: root.file, file: fork.file }, [
      userLine({ id: eid(), at: TG + 20, text: "二" }),
    ]).turns;
    expect(t1[0]!.split).toBe(side);
    expect(t2[0]!.split).toBe(side);
    // unscored ⇔ absent familyRoot
    const u = feedFile(b, { id: "noheader", at: TG + 30, parentSession: "/gone/x.jsonl" }, [
      userLine({ id: eid(), at: TG + 40, text: "三" }),
    ]).turns;
    expect(u[0]!.split).toBe("unscored");
    expect("familyRoot" in u[0]!).toBe(false);
  });

  it("uses real header shapes through parseSessionHeader (ISO timestamps, string parentSession)", () => {
    const line = headerLine({ id: "real-1", at: TG, parentSession: "/sess/0_parent.jsonl" });
    const parsed = JSON.parse(line);
    const fact = headerFact({ id: "real-1", at: TG, parentSession: "/sess/0_parent.jsonl" });
    expect(parsed.parentSession).toBe("/sess/0_parent.jsonl");
    expect(parsed.timestamp).toBe(new Date(TG).toISOString());
    expect(fact.timestamp).toBe(TG);
    expect(typeof parsed.cwd).toBe("string");
  });
});
