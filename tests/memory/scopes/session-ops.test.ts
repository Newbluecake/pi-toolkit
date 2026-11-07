/** #39 P1 op planner: exactly one entry per op, 32nd-op snap with cause, strict caps/CAS. */
import { describe, expect, it } from "vitest";
import { planSessionOp } from "../../../src/memory/scopes/session-ops.js";
import { foldSessionMemory } from "../../../src/memory/scopes/session-fold.js";
import { SESSION_MEMORY_ENTRY_TYPE, SESSION_MEMORY_SNAPSHOT_INTERVAL } from "../../../src/memory/scopes/types.js";

const STAMP = "2026-11-07T00:00:00.000Z";
const now = () => STAMP;
const sid = "s1";

const emptyBranch: unknown[] = [];
const state = (branch: unknown[]) => foldSessionMemory(branch, sid);

function putEntry(n: number, text: string): unknown {
  return {
    type: "custom",
    customType: SESSION_MEMORY_ENTRY_TYPE,
    id: `e${n}`,
    data: { v: 1, sid, op: "put", item: { id: `n${n}`, text, authority: "agent", created: STAMP, updated: STAMP } },
  };
}

describe("put/del planning", () => {
  it("allocates n1, n2, … and returns exactly ONE entry per operation", () => {
    let current = state(emptyBranch);
    const first = planSessionOp(current, sid, { op: "put", text: "a", authority: "agent" }, now);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.entry).toMatchObject({ v: 1, sid, op: "put" });
      expect(first.entry.op === "put" && first.entry.item.id).toBe("n1");
      expect(first.id).toBe("n1");
      expect(first.rev).toMatch(/^[a-f0-9]{8}$/);
      current = first.after;
    }
    const second = planSessionOp(current, sid, { op: "put", text: "b", authority: "agent" }, now);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.entry.op === "put" && second.entry.item.id).toBe("n2");
  });

  it("update requires expectRev and rejects a stale rev (E_REV_REQUIRED / E_CONFLICT)", () => {
    const base = state([putEntry(1, "a")]);
    const noRev = planSessionOp(base, sid, { op: "put", id: "n1", text: "b", authority: "agent" }, now);
    expect(noRev).toMatchObject({ ok: false, code: "E_REV_REQUIRED" });
    const stale = planSessionOp(
      base,
      sid,
      { op: "put", id: "n1", text: "b", authority: "agent", expectRev: "deadbeef" },
      now,
    );
    expect(stale).toMatchObject({ ok: false, code: "E_CONFLICT" });
    const rev = base.items[0]!.rev;
    const ok = planSessionOp(base, sid, { op: "put", id: "n1", text: "b", authority: "agent", expectRev: rev }, now);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.entry.op === "put" && ok.entry.item.created).toBe(STAMP); // created preserved on update
      expect(ok.after.items.length).toBe(1);
    }
  });

  it("del requires an existing id and a matching rev", () => {
    const base = state([putEntry(1, "a")]);
    expect(planSessionOp(base, sid, { op: "del", id: "n9", expectRev: "x" }, now)).toMatchObject({
      ok: false,
      code: "E_NOT_FOUND",
    });
    expect(planSessionOp(base, sid, { op: "del", id: "n1" }, now)).toMatchObject({ ok: false, code: "E_REV_REQUIRED" });
    const rev = base.items[0]!.rev;
    const ok = planSessionOp(base, sid, { op: "del", id: "n1", expectRev: rev }, now);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.entry).toMatchObject({ op: "del", id: "n1" });
      expect(ok.after.items.length).toBe(0);
      expect(ok.after.nextN).toBe(2); // ids are never reused
    }
  });

  it("user-authority put carries the grant through to the planned item", () => {
    const grant = { via: "dialog" as const, turn: "aabbccdd", cap: "11223344", channel: "tui" as const };
    const ok = planSessionOp(state(emptyBranch), sid, { op: "put", text: "user fact", authority: "user", grant }, now);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.entry.op === "put" && ok.entry.item.grant).toEqual(grant);
  });

  it("from/originSid are validated (E_FROM_INVALID / E_META_INVALID)", () => {
    expect(
      planSessionOp(state(emptyBranch), sid, { op: "put", text: "x", authority: "agent", from: "hub:1" }, now),
    ).toMatchObject({ ok: false, code: "E_FROM_INVALID" });
    expect(
      planSessionOp(state(emptyBranch), sid, { op: "put", text: "x", authority: "agent", originSid: "../p" }, now),
    ).toMatchObject({ ok: false, code: "E_META_INVALID" });
  });
});

describe("product capacity (equality / +1)", () => {
  it("text: 1024 bytes accepted, 1025 rejected", () => {
    const base = state(emptyBranch);
    expect(planSessionOp(base, sid, { op: "put", text: "\0".repeat(1024), authority: "agent" }, now).ok).toBe(true);
    expect(planSessionOp(base, sid, { op: "put", text: "\0".repeat(1025), authority: "agent" }, now)).toMatchObject({
      ok: false,
      code: "E_TOO_LARGE",
    });
  });

  it("count: 48 accepted, 49th rejected with E_FULL", () => {
    const branch: unknown[] = [];
    for (let i = 1; i <= 48; i++) branch.push(putEntry(i, "x"));
    const base = state(branch);
    expect(base.items.length).toBe(48);
    expect(planSessionOp(base, sid, { op: "put", text: "y", authority: "agent" }, now)).toMatchObject({
      ok: false,
      code: "E_FULL",
    });
  });

  it("body total: 8192 accepted, 8193 rejected with E_TOO_LARGE (update shrink still ok)", () => {
    // 8 maximal items: 8×1024 = 8192 raw with plenty of count headroom, so the BODY budget
    // is the binding constraint, not the 48-item cap.
    const branch: unknown[] = [];
    for (let n = 1; n <= 8; n++) branch.push(putEntry(n, "\0".repeat(1024)));
    const base = state(branch);
    expect(base.items.reduce((sum, f) => sum + Buffer.byteLength(f.item.text, "utf8"), 0)).toBe(8192);
    expect(planSessionOp(base, sid, { op: "put", text: "\0", authority: "agent" }, now)).toMatchObject({
      ok: false,
      code: "E_TOO_LARGE",
    });
    const rev = base.items[0]!.rev;
    const shrink = planSessionOp(
      base,
      sid,
      { op: "put", id: "n1", text: "\0".repeat(1023), authority: "agent", expectRev: rev },
      now,
    );
    expect(shrink.ok).toBe(true); // shrinking frees budget
    if (shrink.ok)
      expect(planSessionOp(shrink.after, sid, { op: "put", text: "\0", authority: "agent" }, now).ok).toBe(true);
  });

  it("a fold-history state above product caps blocks new writes (48/64 boundary)", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `n${i + 1}`, text: "x" }));
    const branch: unknown[] = [
      {
        type: "custom",
        customType: SESSION_MEMORY_ENTRY_TYPE,
        id: "esnap",
        data: {
          v: 1,
          sid,
          op: "snap",
          items: items.map((it) => ({ id: it.id, text: it.text, authority: "agent", created: STAMP, updated: STAMP })),
          nextN: 51,
        },
      },
    ];
    const base = state(branch);
    expect(base.items.length).toBe(50); // fold tolerates history
    expect(planSessionOp(base, sid, { op: "put", text: "y", authority: "agent" }, now)).toMatchObject({
      ok: false,
      code: "E_FULL",
    });
  });
});

describe("the 32nd operation becomes a full snap with cause (never two appends)", () => {
  it("ops 1..31 are single put/del entries; op 32 is a snap containing its own effect", () => {
    let current = state(emptyBranch);
    for (let i = 1; i < SESSION_MEMORY_SNAPSHOT_INTERVAL; i++) {
      const planned = planSessionOp(current, sid, { op: "put", text: `t${i}`, authority: "agent" }, now);
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      expect(planned.entry.op).toBe("put");
      current = planned.after;
    }
    expect(current.opsSinceSnap).toBe(SESSION_MEMORY_SNAPSHOT_INTERVAL - 1);
    const snapOp = planSessionOp(current, sid, { op: "put", text: "t32", authority: "agent" }, now);
    expect(snapOp.ok).toBe(true);
    if (!snapOp.ok) return;
    expect(snapOp.entry.op).toBe("snap");
    if (snapOp.entry.op === "snap") {
      expect(snapOp.entry.items.length).toBe(SESSION_MEMORY_SNAPSHOT_INTERVAL);
      expect(snapOp.entry.cause).toEqual({ op: "put", id: "n32" });
      expect(snapOp.entry.items.some((item) => item.id === "n32" && item.text === "t32")).toBe(true);
      expect(snapOp.entry.nextN).toBe(33);
    }
    expect(snapOp.after.opsSinceSnap).toBe(0);
  });

  it("the 32nd del also snaps, with cause {op:'del'} and the item absent", () => {
    const branch: unknown[] = [putEntry(1, "a")];
    const base = { ...state(branch), opsSinceSnap: 31 } as ReturnType<typeof state>;
    const planned = planSessionOp(base, sid, { op: "del", id: "n1", expectRev: base.items[0]!.rev }, now);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.entry.op).toBe("snap");
    if (planned.entry.op === "snap") {
      expect(planned.entry.cause).toEqual({ op: "del", id: "n1" });
      expect(planned.entry.items.length).toBe(0);
    }
  });

  it("planned entries always survive the final-DTO gate (validated as written data)", () => {
    const planned = planSessionOp(
      state(emptyBranch),
      sid,
      {
        op: "put",
        text: "\0".repeat(1024),
        authority: "user",
        grant: { via: "dialog", turn: "aabbccdd", cap: "11223344", channel: "web" },
        from: "session:n1",
        originSid: "parent-sid",
      },
      now,
    );
    expect(planned.ok).toBe(true);
    if (planned.ok) expect(JSON.stringify(planned.entry).length).toBeLessThanOrEqual(8704);
  });
});

describe("id-space exhaustion refuses new writes, never reuses an id (K9 / Root minor-fix)", () => {
  const exhaustedBranch: unknown[] = [
    {
      type: "custom",
      customType: SESSION_MEMORY_ENTRY_TYPE,
      id: "emax",
      data: {
        v: 1,
        sid,
        op: "put",
        item: { id: "n999999", text: "untouchable", authority: "agent", created: STAMP, updated: STAMP },
      },
    },
  ];
  const exhausted = () => state(exhaustedBranch);

  it("nextN reaches the internal sentinel; create ⇒ E_FULL with the state (and body) unchanged", () => {
    const base = exhausted();
    expect(base.nextN).toBe(1_000_000);
    const refused = planSessionOp(base, sid, { op: "put", text: "new", authority: "agent" }, now);
    expect(refused).toEqual({ ok: false, code: "E_FULL" });
    expect(state(exhaustedBranch).items[0]?.item.text).toBe("untouchable");
  });

  it("update and delete of n999999 still work by explicit id + rev (not hostage to exhaustion)", () => {
    const base = exhausted();
    const rev = base.items[0]!.rev;
    const updated = planSessionOp(
      base,
      sid,
      { op: "put", id: "n999999", text: "rewritten", authority: "agent", expectRev: rev },
      now,
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.entry.op === "put" && updated.entry.item.text).toBe("rewritten");
      expect(updated.after.nextN).toBe(1_000_000);
      const del = planSessionOp(updated.after, sid, { op: "del", id: "n999999", expectRev: updated.rev ?? rev }, now);
      expect(del.ok).toBe(true);
      if (del.ok) {
        expect(del.after.items.length).toBe(0);
        expect(del.after.nextN).toBe(1_000_000); // the number is NOT freed
        // after the delete a create still refuses: no reuse of n999999
        expect(planSessionOp(del.after, sid, { op: "put", text: "again", authority: "agent" }, now)).toEqual({
          ok: false,
          code: "E_FULL",
        });
      }
    }
  });

  it("boundary: n999998 present ⇒ the last legal create is n999999; the 32nd-op snap keeps ids unique and publishes nextN 999999", () => {
    const branch: unknown[] = [
      {
        type: "custom",
        customType: SESSION_MEMORY_ENTRY_TYPE,
        id: "e999998",
        data: {
          v: 1,
          sid,
          op: "put",
          item: { id: "n999998", text: "penultimate", authority: "agent", created: STAMP, updated: STAMP },
        },
      },
    ];
    const atEdge = { ...state(branch), opsSinceSnap: 31 } as ReturnType<typeof state>;
    const lastLegal = planSessionOp(atEdge, sid, { op: "put", text: "final", authority: "agent" }, now);
    expect(lastLegal.ok).toBe(true);
    if (!lastLegal.ok) return;
    expect(lastLegal.id).toBe("n999999");
    expect(lastLegal.entry.op).toBe("snap"); // 32nd op
    if (lastLegal.entry.op === "snap") {
      const ids = lastLegal.entry.items.map((item) => item.id).sort();
      expect(new Set(ids).size).toBe(ids.length); // no duplicated id inside the snap
      expect(lastLegal.entry.nextN).toBe(999999); // published field stays in range
      expect(lastLegal.after.nextN).toBe(1_000_000); // internal sentinel preserved
    }
    // re-folding the emitted snap reconstructs the sentinel and refuses further creates
    const refolded = foldSessionMemory(
      [{ type: "custom", customType: SESSION_MEMORY_ENTRY_TYPE, id: "esnap", data: lastLegal.entry }],
      sid,
    );
    expect(refolded.nextN).toBe(1_000_000);
    expect(planSessionOp(refolded, sid, { op: "put", text: "overflow", authority: "agent" }, now)).toEqual({
      ok: false,
      code: "E_FULL",
    });
  });
});
