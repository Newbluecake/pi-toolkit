import { describe, expect, it } from "vitest";
import {
  PREDICT_SAFETY_MARGIN_MS,
  PREDICT_TTL_1H_MS,
  PREDICT_TTL_MS,
  createAnchorLedger,
  snapDigestOf,
} from "../../src/consult/anchor-ledger.js";

/** cache-thread plan §5.1 + plan-author ruling: warm/cold/unknown truth table, evidence-bound. */

const ROUTE = { provider: "cr-anthropic", model: "claude-opus-5-5" };
const API = "anthropic-messages";
const DIGEST = snapDigestOf({ tools: [{ name: "read" }], systemSections: { a: "x" }, cwd: "/w", sourceKey: "1:1" });

function setup(start = 10_000_000) {
  let t = start;
  const ledger = createAnchorLedger({ now: () => t });
  return {
    ledger,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

const q = (over: Record<string, unknown> = {}) => ({
  expertRunId: "r_EXP",
  route: ROUTE,
  api: API,
  snapDigest: DIGEST,
  ...over,
});

const touch = (at: number, over: Record<string, unknown> = {}) => ({
  expertRunId: "r_EXP",
  route: ROUTE,
  snapDigest: DIGEST,
  anchor: "added" as const,
  touchedAt: at,
  ...over,
});

describe("anchor ledger: prediction truth table", () => {
  it("warm right after a proven touch; evidence records source/ttl/touch time", () => {
    const e = setup();
    e.ledger.noteTouch(touch(e.now() - 1000));
    const p = e.ledger.predict(q());
    expect(p).toEqual({
      state: "warm",
      evidence: { source: "anchor-ledger", ttlMs: PREDICT_TTL_MS, lastProvenTouchAt: e.now() - 1000 },
    });
  });

  it("TTL boundary ±15 s: warm strictly before touch+TTL−15s, then unknown(ttl-margin), cold from touch+TTL", () => {
    const e = setup();
    const t0 = e.now();
    e.ledger.noteTouch(touch(t0));
    e.set(t0 + PREDICT_TTL_MS - PREDICT_SAFETY_MARGIN_MS - 1);
    expect(e.ledger.predict(q()).state).toBe("warm");
    e.set(t0 + PREDICT_TTL_MS - PREDICT_SAFETY_MARGIN_MS);
    expect(e.ledger.predict(q())).toMatchObject({ state: "unknown", reason: "ttl-margin" });
    e.set(t0 + PREDICT_TTL_MS - 1);
    expect(e.ledger.predict(q()).state).toBe("unknown");
    e.set(t0 + PREDICT_TTL_MS);
    expect(e.ledger.predict(q())).toMatchObject({ state: "cold", evidence: { source: "anchor-ledger" } });
  });

  it("a 1h-carrying touch never raises the warm window, only relaxes the COLD threshold to 60 min", () => {
    const e = setup();
    const t0 = e.now();
    e.ledger.noteTouch(touch(t0, { ttl1h: true }));
    e.set(t0 + PREDICT_TTL_MS + 1000);
    expect(e.ledger.predict(q()).state).toBe("unknown"); // 5 min up, 1h survival not claimed
    e.set(t0 + PREDICT_TTL_1H_MS - 1);
    expect(e.ledger.predict(q()).state).toBe("unknown");
    e.set(t0 + PREDICT_TTL_1H_MS);
    expect(e.ledger.predict(q()).state).toBe("cold");
  });

  it("route / digest are part of the key: different route or digest never matches", () => {
    const e = setup();
    e.ledger.noteTouch(touch(e.now()));
    expect(e.ledger.predict(q({ route: { provider: "cr-anthropic", model: "other" } })).state).toBe("unknown");
    expect(e.ledger.predict(q({ snapDigest: "different" }))).toMatchObject({
      state: "unknown",
      reason: "digest-mismatch",
    });
    expect(e.ledger.predict(q({ snapDigest: undefined }))).toMatchObject({
      state: "unknown",
      reason: "digest-mismatch",
    });
    expect(e.ledger.predict(q({ expertRunId: "r_OTHER" })).state).toBe("unknown");
  });

  it("a FIRST consult by a different asker matches the same expert's touch (cross-asker warm)", () => {
    const e = setup();
    e.ledger.noteTouch(touch(e.now() - 5000));
    // nothing about the asker is part of the query ⇒ any asker with the same expert/route/digest is warm
    expect(e.ledger.predict(q()).state).toBe("warm");
  });

  it("cold without a ledger entry only when the expert settled > TTL ago; otherwise no-evidence", () => {
    const e = setup();
    expect(e.ledger.predict(q({ settledAt: e.now() - PREDICT_TTL_MS - 1 }))).toEqual({
      state: "cold",
      evidence: { source: "expert-settle", ttlMs: PREDICT_TTL_MS, settledAt: e.now() - PREDICT_TTL_MS - 1 },
    });
    expect(e.ledger.predict(q({ settledAt: e.now() - 1000 }))).toEqual({ state: "unknown", reason: "no-evidence" });
    expect(e.ledger.predict(q())).toEqual({ state: "unknown", reason: "no-evidence" });
    expect(e.ledger.predict(q({ settledAt: Number.NaN })).state).toBe("unknown");
  });

  it("unknown reasons: main, non-anthropic, no-snapshot, oauth-limit, degraded-anchor", () => {
    const e = setup();
    e.ledger.noteTouch(touch(e.now()));
    expect(e.ledger.predict(q({ isMain: true }))).toEqual({ state: "unknown", reason: "main" });
    expect(e.ledger.predict(q({ api: "openai-completions" }))).toEqual({ state: "unknown", reason: "non-anthropic" });
    expect(e.ledger.predict(q({ api: undefined }))).toEqual({ state: "unknown", reason: "no-snapshot" });
    expect(e.ledger.predict(q({ route: undefined }))).toEqual({ state: "unknown", reason: "no-snapshot" });
    expect(e.ledger.predict(q({ oauth: true }))).toEqual({ state: "unknown", reason: "oauth-limit" });
    expect(e.ledger.predict(q({ followUpWithoutBase: true }))).toEqual({ state: "unknown", reason: "degraded-anchor" });

    const d = setup();
    d.ledger.noteTouch(touch(d.now(), { degraded: true }));
    expect(d.ledger.predict(q())).toEqual({ state: "unknown", reason: "degraded-anchor" });
  });

  it("a delayed (older) touch never moves the window backwards; a newer touch extends it", () => {
    const e = setup();
    const t0 = e.now();
    e.ledger.noteTouch(touch(t0));
    e.ledger.noteTouch(touch(t0 - 100_000)); // late delivery
    e.set(t0 + PREDICT_TTL_MS + 1);
    expect(e.ledger.predict(q()).state).toBe("cold");
    e.ledger.noteTouch(touch(t0 + 200_000));
    expect(e.ledger.predict(q()).state).toBe("warm");
  });

  it("is bounded (FIFO) and close() clears and neuters it", () => {
    const e = setup();
    for (let i = 0; i < 300; i++) e.ledger.noteTouch(touch(e.now(), { expertRunId: `r_${i}` }));
    expect(e.ledger.size()).toBe(256);
    e.ledger.close();
    expect(e.ledger.size()).toBe(0);
    e.ledger.noteTouch(touch(e.now()));
    expect(e.ledger.size()).toBe(0);
    expect(e.ledger.predict(q({ expertRunId: "r_299" })).state).toBe("unknown");
  });

  it("snapDigestOf is stable and sensitive to every component", () => {
    const base = { tools: [1], systemSections: { a: "b" }, cwd: "/w", sourceKey: "1:1" };
    expect(snapDigestOf(base)).toBe(snapDigestOf({ ...base }));
    expect(snapDigestOf({ ...base, tools: [2] })).not.toBe(snapDigestOf(base));
    expect(snapDigestOf({ ...base, systemSections: { a: "c" } })).not.toBe(snapDigestOf(base));
    expect(snapDigestOf({ ...base, cwd: "/x" })).not.toBe(snapDigestOf(base));
    expect(snapDigestOf({ ...base, sourceKey: "2:2" })).not.toBe(snapDigestOf(base));
  });
});
