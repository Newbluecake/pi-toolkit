// sysprompt-stable plan v3.1 §4.1 / §7.3: exhaustive transition-matrix and I9
// byte-accounting boundary tests for the pure `stable-section.ts` state
// machine. `stable-fold.test.ts` keeps the original broad-assertion smoke
// tests; this file drives every branch of the spec's `resolveAtTurn` /
// `resolveAtSeed` pseudocode individually so a future refactor of the state
// machine cannot silently change a branch without a failing test.

import { describe, expect, it } from "vitest";
import {
  POINTED,
  SKIP,
  UPDATE_LIMITS,
  initialSectionState,
  resolveAtSeed,
  resolveAtTurn,
  type SectionState,
} from "../../src/prompt-sections/stable-section.js";

const fresh = (): SectionState => initialSectionState();
const withSnapshot = (overrides: Partial<SectionState> = {}): SectionState => ({
  snapshot: "OLD",
  announced: "OLD",
  stale: false,
  sentCount: 0,
  sentBytes: 0,
  ...overrides,
});

describe("resolveAtTurn: transition matrix", () => {
  describe("refresh branch (state.stale || snapshot === undefined)", () => {
    it("fresh + SKIP ⇒ state unchanged, text empty, stale stays true (never falls back to a phantom snapshot)", () => {
      const state = fresh();
      const r = resolveAtTurn(state, SKIP);
      expect(r).toEqual({ state, text: "" });
      expect(r.state.stale).toBe(true);
      expect(r.update).toBeUndefined();
    });

    it("stale-with-existing-snapshot + SKIP ⇒ state UNCHANGED, old content preserved (not blanked)", () => {
      const state: SectionState = { snapshot: "OLD", announced: "OLD", stale: true, sentCount: 2, sentBytes: 20 };
      const r = resolveAtTurn(state, SKIP);
      expect(r).toEqual({ state, text: "OLD" }); // literally the same state object's values
      expect(r.update).toBeUndefined();
    });

    it("fresh + non-SKIP ⇒ refreshes silently (no update), counters reset", () => {
      const r = resolveAtTurn(fresh(), "hello");
      expect(r).toEqual({
        state: { snapshot: "hello", announced: "hello", stale: false, sentCount: 0, sentBytes: 0 },
        text: "hello",
      });
      expect(r.update).toBeUndefined();
    });

    it("stale (was populated) + non-SKIP ⇒ silently overwrites the snapshot, no update, counters reset", () => {
      const state: SectionState = { snapshot: "OLD", announced: POINTED, stale: true, sentCount: 3, sentBytes: 999 };
      const r = resolveAtTurn(state, "NEW");
      expect(r).toEqual({
        state: { snapshot: "NEW", announced: "NEW", stale: false, sentCount: 0, sentBytes: 0 },
        text: "NEW",
      });
      expect(r.update).toBeUndefined();
    });

    it("stale + live === \"\" ⇒ silent refresh TO empty (not a 'removed' update: that kind only exists in the non-stale branch)", () => {
      const state: SectionState = { snapshot: "OLD", announced: "OLD", stale: true, sentCount: 0, sentBytes: 0 };
      const r = resolveAtTurn(state, "");
      expect(r).toEqual({
        state: { snapshot: "", announced: "", stale: false, sentCount: 0, sentBytes: 0 },
        text: "",
      });
      expect(r.update).toBeUndefined();
    });
  });

  describe("non-stale, live unknown/unchanged/pointed ⇒ unchanged (I1/I3)", () => {
    it("SKIP ⇒ state and text unchanged", () => {
      const state = withSnapshot();
      const r = resolveAtTurn(state, SKIP);
      expect(r).toEqual({ state, text: "OLD" });
      expect(r.update).toBeUndefined();
    });

    it("live === announced (no real change) ⇒ unchanged, no repeat message", () => {
      const state = withSnapshot({ announced: "SAME" });
      const r = resolveAtTurn(state, "SAME");
      expect(r).toEqual({ state, text: "OLD" });
      expect(r.update).toBeUndefined();
    });

    it("live === announced === \"\" (already reported removed) ⇒ no repeat 'removed'", () => {
      const state = withSnapshot({ announced: "" });
      const r = resolveAtTurn(state, "");
      expect(r).toEqual({ state, text: "OLD" });
      expect(r.update).toBeUndefined();
    });

    it("announced === POINTED ⇒ unchanged even for genuinely new content (at most one pointer until refresh/forgetAnnounced)", () => {
      const state = withSnapshot({ announced: POINTED });
      const r = resolveAtTurn(state, "BRAND NEW CONTENT");
      expect(r).toEqual({ state, text: "OLD" });
      expect(r.update).toBeUndefined();
    });
  });

  describe("non-stale, genuine change ⇒ update/removed/pointer", () => {
    it('live === "" (was non-empty) ⇒ removed, sentCount += 1, head unchanged', () => {
      const state = withSnapshot();
      const r = resolveAtTurn(state, "");
      expect(r.update).toEqual({ kind: "removed" });
      expect(r.text).toBe("OLD");
      expect(r.state).toEqual({ snapshot: "OLD", announced: "", stale: false, sentCount: 1, sentBytes: 0 });
    });

    it("live is new non-empty content within limits ⇒ update, sentCount/sentBytes advance", () => {
      const state = withSnapshot();
      const r = resolveAtTurn(state, "abc");
      expect(r.update).toEqual({ kind: "update", content: "abc" });
      expect(r.state).toEqual({ snapshot: "OLD", announced: "abc", stale: false, sentCount: 1, sentBytes: 3 });
    });

    it("exceeding maxCount ⇒ pointer; counters left untouched (I9: 'counters not cleared')", () => {
      const state = withSnapshot({ sentCount: 3, sentBytes: 10 });
      const r = resolveAtTurn(state, "new", { maxCount: 3, maxBytes: 1000 });
      expect(r.update).toEqual({ kind: "pointer" });
      expect(r.state).toEqual({ snapshot: "OLD", announced: POINTED, stale: false, sentCount: 3, sentBytes: 10 });
    });

    it("exceeding maxBytes ⇒ pointer even under the count limit", () => {
      const state = withSnapshot({ sentCount: 0, sentBytes: 8 });
      const r = resolveAtTurn(state, "xx", { maxCount: 100, maxBytes: 9 }); // 8 + 2 > 9
      expect(r.update).toEqual({ kind: "pointer" });
      expect(r.state.announced).toBe(POINTED);
      expect(r.state.sentBytes).toBe(8); // untouched
    });
  });

  describe("I9 byte accounting at the DEFAULT 32KB / 3-update boundary", () => {
    it("exactly 3 updates go through; the 4th converts to a pointer; the 5th is silent", () => {
      let state = resolveAtTurn(initialSectionState(), "seed").state; // fresh snapshot, counters at 0
      const u1 = resolveAtTurn(state, "u1");
      expect(u1.update).toEqual({ kind: "update", content: "u1" });
      state = u1.state;
      const u2 = resolveAtTurn(state, "u2");
      expect(u2.update).toEqual({ kind: "update", content: "u2" });
      state = u2.state;
      const u3 = resolveAtTurn(state, "u3");
      expect(u3.update).toEqual({ kind: "update", content: "u3" });
      state = u3.state;
      expect(state.sentCount).toBe(3);

      const u4 = resolveAtTurn(state, "u4"); // 4th ⇒ pointer
      expect(u4.update).toEqual({ kind: "pointer" });
      state = u4.state;

      const u5 = resolveAtTurn(state, "u5"); // already POINTED ⇒ silent
      expect(u5.update).toBeUndefined();
    });

    it("cumulative bytes landing exactly on 32768 is still an update; one more byte tips into pointer", () => {
      const state = resolveAtTurn(initialSectionState(), "seed").state;
      const exact = "x".repeat(UPDATE_LIMITS.maxBytes); // exactly 32768 bytes
      const r1 = resolveAtTurn(state, exact);
      expect(r1.update).toEqual({ kind: "update", content: exact });
      expect(r1.state.sentBytes).toBe(UPDATE_LIMITS.maxBytes);

      const r2 = resolveAtTurn(r1.state, "y"); // 32768 + 1 > 32768
      expect(r2.update).toEqual({ kind: "pointer" });
      expect(r2.state.sentBytes).toBe(UPDATE_LIMITS.maxBytes); // untouched by the pointer branch
    });

    it("a single update whose own content exceeds 32KB goes straight to pointer on a fresh section", () => {
      const state = resolveAtTurn(initialSectionState(), "seed").state; // sentBytes = 0
      const big = "z".repeat(UPDATE_LIMITS.maxBytes + 1);
      const r = resolveAtTurn(state, big);
      expect(r.update).toEqual({ kind: "pointer" });
      expect(r.state.sentBytes).toBe(0); // never incremented
    });

    it("UTF-8 byte accounting: multi-byte characters count their encoded size, not their character count", () => {
      // "€" is U+20AC, 3 bytes in UTF-8; 1 character each.
      const state = resolveAtTurn(initialSectionState(), "seed").state;
      const content = "€".repeat(10_923); // 10_923 * 3 = 32_769 bytes: one over the limit
      const r = resolveAtTurn(state, content);
      expect(content.length).toBe(10_923); // character count is nowhere near the byte limit
      expect(r.update).toEqual({ kind: "pointer" }); // but byte accounting still trips
    });

    it("pointer state persists across turns until a refresh or forgetAnnounced clears it", () => {
      let state = resolveAtTurn(initialSectionState(), "seed").state;
      for (const content of ["u1", "u2", "u3", "u4"]) {
        state = resolveAtTurn(state, content).state;
      }
      expect(state.announced).toBe(POINTED);
      // repeated distinct content, still pointed and silent
      state = resolveAtTurn(state, "u5-different").state;
      expect(state.announced).toBe(POINTED);
      expect(resolveAtTurn(state, "u6-different").update).toBeUndefined();
    });
  });
});

describe("resolveAtSeed: never emits an update, thunk laziness", () => {
  it("stale + snapshot undefined ⇒ invokes the thunk and refreshes", () => {
    let calls = 0;
    const r = resolveAtSeed(initialSectionState(), () => {
      calls += 1;
      return "seeded";
    });
    expect(calls).toBe(1);
    expect(r).toEqual({
      state: { snapshot: "seeded", announced: "seeded", stale: false, sentCount: 0, sentBytes: 0 },
      text: "seeded",
    });
  });

  it("stale + existing snapshot ⇒ still invokes the thunk (session_compact-style markStale)", () => {
    const state: SectionState = { snapshot: "OLD", announced: "OLD", stale: true, sentCount: 1, sentBytes: 3 };
    let calls = 0;
    const r = resolveAtSeed(state, () => {
      calls += 1;
      return "NEW";
    });
    expect(calls).toBe(1);
    expect(r.text).toBe("NEW");
    expect(r.state).toEqual({ snapshot: "NEW", announced: "NEW", stale: false, sentCount: 0, sentBytes: 0 });
  });

  it("stale thunk returns SKIP ⇒ state unchanged, falls back to the OLD snapshot (not blanked)", () => {
    const state: SectionState = { snapshot: "OLD", announced: "OLD", stale: true, sentCount: 0, sentBytes: 0 };
    const r = resolveAtSeed(state, () => SKIP);
    expect(r).toEqual({ state, text: "OLD" });
  });

  it("not stale ⇒ the thunk is NEVER called, even if it would return different content", () => {
    const state = withSnapshot({ stale: false });
    let calls = 0;
    const r = resolveAtSeed(state, () => {
      calls += 1;
      return "should not be read";
    });
    expect(calls).toBe(0);
    expect(r).toEqual({ state, text: "OLD" });
  });

  it("never produces an `update` field regardless of branch", () => {
    const r1 = resolveAtSeed(initialSectionState(), () => "x");
    const r2 = resolveAtSeed(withSnapshot({ stale: false }), () => "y");
    const r3 = resolveAtSeed(
      { snapshot: "OLD", announced: "OLD", stale: true, sentCount: 0, sentBytes: 0 },
      () => SKIP,
    );
    for (const r of [r1, r2, r3]) expect(Object.hasOwn(r, "update")).toBe(false);
  });
});
