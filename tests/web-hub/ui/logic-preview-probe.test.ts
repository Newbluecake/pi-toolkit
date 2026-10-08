// @vitest-environment node
/**
 * web-hub content preview — the PROBE pipeline's pure logic (web-hub-preview 2026-10-07 修订
 * 「先探测后标记」, `logic/previewProbe.js`): the state store (pending/confirmed/missing/
 * failed, scope isolation, LRU), the wire-batch planner (count cap / REAL UTF-8 byte budget),
 * and the 200-body parser contract.
 */
import { describe, expect, it } from "vitest";
import {
  parseProbeResults,
  planProbeBatches,
  PreviewProbeStore,
  PROBE_BATCH_BYTES,
  PROBE_LRU_CAP,
} from "../../../src/web-hub/ui/src/logic/previewProbe.js";
import { PREVIEW_PROBE_KINDS, PREVIEW_PROBE_MAX_PATHS } from "@protocol/preview.ts";

describe("PreviewProbeStore — states", () => {
  it("unknown ⇒ undefined; markPending stages only unknown paths (dedup within the call)", () => {
    const s = new PreviewProbeStore();
    expect(s.get("k", "/p/a.ts")).toBeUndefined();
    expect(s.markPending("k", ["/p/a.ts", "/p/a.ts", "/p/b.ts"])).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(s.get("k", "/p/a.ts")).toBe("pending");
    // in-flight paths are not re-staged
    expect(s.markPending("k", ["/p/a.ts", "/p/c.ts"])).toEqual(["/p/c.ts"]);
  });

  it("settle: text/image ⇒ confirmed, missing ⇒ missing — in request order", () => {
    const s = new PreviewProbeStore();
    const fresh = s.markPending("k", ["/p/a.ts", "/p/b.png", "/p/gone.ts"]);
    s.settle("k", fresh, ["text", "image", "missing"]);
    expect(s.get("k", "/p/a.ts")).toBe("confirmed");
    expect(s.get("k", "/p/b.png")).toBe("confirmed");
    expect(s.get("k", "/p/gone.ts")).toBe("missing");
  });

  it("fail: the WHOLE batch degrades to failed (plain-text rendering, terminal)", () => {
    const s = new PreviewProbeStore();
    const fresh = s.markPending("k", ["/p/a.ts", "/p/b.ts"]);
    s.fail("k", fresh);
    expect(s.get("k", "/p/a.ts")).toBe("failed");
    expect(s.get("k", "/p/b.ts")).toBe("failed");
    // terminal states are never re-staged
    expect(s.markPending("k", ["/p/a.ts"])).toEqual([]);
  });

  it("scope isolation is structural: the same path under another scopeKey is independent", () => {
    const s = new PreviewProbeStore();
    s.markPending("scopeA", ["/p/a.ts"]);
    s.settle("scopeA", ["/p/a.ts"], ["text"]);
    expect(s.get("scopeA", "/p/a.ts")).toBe("confirmed");
    expect(s.get("scopeB", "/p/a.ts")).toBeUndefined();
    expect(s.markPending("scopeB", ["/p/a.ts"])).toEqual(["/p/a.ts"]);
  });
});

describe("PreviewProbeStore — LRU", () => {
  it("evicts the oldest entry beyond the cap; a read refreshes recency", () => {
    const s = new PreviewProbeStore(3);
    s.markPending("k", ["/p/1.ts", "/p/2.ts", "/p/3.ts"]);
    expect(s.size).toBe(3);
    s.get("k", "/p/1.ts"); // touch ⇒ 1 becomes most recent
    s.markPending("k", ["/p/4.ts"]); // evicts 2, not 1
    expect(s.size).toBe(3);
    expect(s.get("k", "/p/2.ts")).toBeUndefined();
    expect(s.get("k", "/p/1.ts")).toBe("pending");
  });

  it("the default cap is the spec's ~256", () => {
    const s = new PreviewProbeStore();
    expect(PROBE_LRU_CAP).toBe(256);
    for (let i = 0; i < 300; i++) s.markPending("k", [`/p/${i}.ts`]);
    expect(s.size).toBe(256);
    expect(s.get("k", "/p/0.ts")).toBeUndefined(); // oldest evicted
    expect(s.get("k", "/p/299.ts")).toBe("pending");
  });
});

describe("planProbeBatches — wire caps", () => {
  it("respects the 100-entry cap (server 400s above it)", () => {
    const paths = Array.from({ length: 250 }, (_, i) => `/p/${i}.ts`);
    const batches = planProbeBatches(paths);
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(250);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(PREVIEW_PROBE_MAX_PATHS);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(paths); // order preserved
  });

  it("splits by REAL UTF-8 bytes, not UTF-16 units (CJK path = 3 bytes/char on the wire)", () => {
    const cjk = `/${"路".repeat(600)}.ts`; // 600×3B + overhead > 8 KiB budget ⇒ own batches
    const paths = [cjk, cjk];
    const batches = planProbeBatches(paths, { maxPaths: 100, maxBytes: 1024 });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([cjk]);
  });

  it("splits a long-path list by the byte budget (each batch ≤ budget, none empty)", () => {
    const paths = Array.from({ length: 20 }, (_, i) => `/p/${String(i).padStart(4, "0")}-${"y".repeat(150)}.ts`);
    const batches = planProbeBatches(paths, { maxBytes: 2048 });
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.length).toBeGreaterThan(0);
      const bytes = b.reduce((n, p) => n + Buffer.byteLength(p) + 4, 0);
      expect(bytes).toBeLessThanOrEqual(2048);
    }
  });

  it("empty input ⇒ no batches; default budget is the 8 KiB body cap minus headroom", () => {
    expect(planProbeBatches([])).toEqual([]);
    expect(PROBE_BATCH_BYTES).toBeLessThan(8 * 1024);
    expect(PROBE_BATCH_BYTES).toBeGreaterThanOrEqual(7 * 1024);
  });
});

describe("parseProbeResults — 200-body contract", () => {
  it("accepts {kind} objects in request order", () => {
    const out = parseProbeResults({ results: [{ kind: "text" }, { kind: "image" }, { kind: "missing" }] }, 3);
    expect(out).toEqual({ ok: true, kinds: ["text", "image", "missing"] });
  });

  // dir-plan §1.3 (P2): "dir" joins the wire kind set — the parser judges membership by the
  // protocol's single-source PREVIEW_PROBE_KINDS tuple; whether a dirs-less request SHOULD
  // see it is the clients' fold, never the parser's business.
  it('accepts "dir" entries (a dirs:true probe\'s directory answers)', () => {
    const out = parseProbeResults(
      { results: [{ kind: "text" }, { kind: "dir" }, { kind: "missing" }, { kind: "image" }] },
      4,
    );
    expect(out).toEqual({ ok: true, kinds: ["text", "dir", "missing", "image"] });
  });

  it("traverses PREVIEW_PROBE_KINDS: every tuple member accepted, any other string rejected", () => {
    expect([...PREVIEW_PROBE_KINDS]).toEqual(["text", "image", "dir", "missing"]);
    for (const kind of PREVIEW_PROBE_KINDS) {
      expect(parseProbeResults({ results: [{ kind }] }, 1)).toEqual({ ok: true, kinds: [kind] });
    }
    for (const kind of ["binary", "DIR", "", "tex", "folder", "dirr"]) {
      expect(parseProbeResults({ results: [{ kind }] }, 1)).toEqual({ ok: false, error: "E_BAD_RESPONSE" });
    }
  });

  it("rejects: non-object body, missing/non-array results, length mismatch, bad kind, plain strings", () => {
    for (const [raw, n] of [
      [null, 0],
      [[], 0],
      [{}, 0],
      [{ results: "x" }, 0],
      [{ results: [{ kind: "text" }] }, 2],
      [{ results: [{ kind: "binary" }] }, 1],
      [{ results: ["text"] }, 1],
      [{ results: [null] }, 1],
    ] as Array<[unknown, number]>) {
      expect(parseProbeResults(raw, n)).toEqual({ ok: false, error: "E_BAD_RESPONSE" });
    }
  });
});
