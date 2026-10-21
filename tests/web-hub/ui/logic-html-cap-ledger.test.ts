/**
 * web-hub-preview-windows plan r2 §8.2 (W3): the tab-local HTML capability FIFO simulation —
 * the DETERMINISTIC single-tab cases from §10.2 (all times explicit, no clocks).
 *
 * The mirrored hub constants (`PV_CAPS_PER_PRINCIPAL`=8, `PV_IDLE_TTL_MS`=15 min,
 * `PV_HARD_TTL_MS`=60 min) are the constructor DEFAULTS imported from the protocol — one
 * test pins that so the ledger can never drift from `hub/preview/html-cap.ts`.
 */
import { describe, expect, it } from "vitest";
import { PV_CAPS_PER_PRINCIPAL, PV_HARD_TTL_MS, PV_IDLE_TTL_MS } from "../../../src/web-hub/protocol/preview-html.js";
import { HtmlCapLedger } from "../../../src/web-hub/ui/src/logic/htmlCapLedger.js";

const MIN = 60_000;
const CAP = PV_CAPS_PER_PRINCIPAL; // 8

function mintN(ledger: HtmlCapLedger, n: number, at: number, prefix = "t"): void {
  for (let i = 0; i < n; i++) ledger.minted(`${prefix}${i}`, at + i);
}

describe("logic/htmlCapLedger.ts — protocol constants", () => {
  it("defaults mirror the hub's frozen limits exactly (8 caps / 15 min idle / 60 min hard)", () => {
    expect(PV_CAPS_PER_PRINCIPAL).toBe(8);
    expect(PV_IDLE_TTL_MS).toBe(15 * MIN);
    expect(PV_HARD_TTL_MS).toBe(60 * MIN);
    // The ledger itself answers liveCount() so tests can observe the default cap directly.
    const ledger = new HtmlCapLedger();
    mintN(ledger, 9, 0);
    expect(ledger.liveCount()).toBe(CAP); // the 9th mint evicted the oldest, not an extra slot
  });
});

describe("logic/htmlCapLedger.ts — deterministic FIFO eviction", () => {
  it("keep A mounted, mint 8 more ⇒ A is flagged evicted (and only then)", () => {
    const ledger = new HtmlCapLedger();
    ledger.minted("A", 0);
    for (let i = 0; i < CAP - 1; i++) {
      ledger.minted(`x${i}`, 1_000 + i);
      expect(ledger.evictedOf("A")).toBe(false); // below the cap nothing is displaced
    }
    ledger.minted("x7", 2_000);
    expect(ledger.evictedOf("A")).toBe(true); // the 8th additional mint displaced A
    expect(ledger.liveCount()).toBe(CAP);
  });

  it("evicts strictly FIFO by mint order: the second-oldest goes next", () => {
    const ledger = new HtmlCapLedger();
    mintN(ledger, CAP + 1, 0); // t0..t8 — t0 evicted by t8's mint
    expect(ledger.evictedOf("t0")).toBe(true);
    expect(ledger.evictedOf("t1")).toBe(false);
    ledger.minted("t9", 9_000); // t1 goes next
    expect(ledger.evictedOf("t1")).toBe(true);
    expect(ledger.evictedOf("t2")).toBe(false);
  });

  it("re-minting a token clears its evicted state (a fresh token is never displaced)", () => {
    const ledger = new HtmlCapLedger();
    mintN(ledger, CAP + 1, 0, "m"); // m0 evicted
    expect(ledger.evictedOf("m0")).toBe(true);
    ledger.minted("m0", 5_000); // the window's 「重新加载」 — a NEW hub cap, same token key
    expect(ledger.evictedOf("m0")).toBe(false);
  });

  it("a repeated mint of a live token does not double-occupy the FIFO", () => {
    const ledger = new HtmlCapLedger();
    ledger.minted("dup", 0);
    ledger.minted("dup", 1);
    expect(ledger.liveCount()).toBe(1);
  });

  it("evicted entries stop occupying: liveCount stays at the cap across further mints", () => {
    const ledger = new HtmlCapLedger();
    mintN(ledger, 20, 0, "z");
    expect(ledger.liveCount()).toBe(CAP);
    // z0..z11 evicted (20 mints − 8 live), the newest 8 occupy.
    for (let i = 0; i < 12; i++) expect(ledger.evictedOf(`z${i}`)).toBe(true);
    expect(ledger.evictedOf("z12")).toBe(false);
  });
});

describe("logic/htmlCapLedger.ts — TTL cleanup", () => {
  it("an entry unmounted ≥ 15 min ago is cleaned by the next mint and no longer displaces anyone", () => {
    const ledger = new HtmlCapLedger();
    const t0 = 0;
    ledger.minted("A", t0);
    ledger.unmounted("A", t0 + 1); // the preview window closed — but the hub slot lives on
    mintN(ledger, CAP - 1, t0 + 2, "y"); // 8 live incl. A; nothing evicted yet
    expect(ledger.evictedOf("A")).toBe(false);
    // 15 minutes pass with A unmounted; the next mint FIRST cleans A (idle TTL), so the
    // mint fits WITHOUT evicting anyone — dead A no longer displaces the living.
    const late = t0 + 1 + PV_IDLE_TTL_MS + 5_000;
    ledger.minted("y9", late);
    expect(ledger.evictedOf("A")).toBe(false); // cleaned, flag gone, never displaced anyone
    expect(ledger.evictedOf("y0")).toBe(false); // the freed slot absorbed the 9th mint
    expect(ledger.liveCount()).toBe(CAP);
    ledger.minted("y10", late + 1); // now genuinely full again ⇒ FIFO evicts the oldest live
    expect(ledger.evictedOf("y0")).toBe(true);
  });

  it("unmounted but NOT yet idle-expired entries keep occupying (the hub cannot see the close)", () => {
    const base = 10 * MIN; // keep every hard deadline (base + 60 min) far out of the picture
    const ledger = new HtmlCapLedger();
    ledger.minted("A", base);
    ledger.unmounted("A", base + 1);
    mintN(ledger, CAP - 1, base + 2, "y"); // A + 7 y's = 8 live, no eviction
    // now is 1 ms BEFORE A's idle deadline (base+1+15 min): A still occupies ⇒ the 9th
    // mint's FIFO eviction lands on A (a dead-at-the-hub slot displacing a mounted one is
    // exactly the §8.1 hazard the ledger exists to surface).
    ledger.minted("y9", base + PV_IDLE_TTL_MS);
    expect(ledger.evictedOf("A")).toBe(true);
    expect(ledger.evictedOf("y0")).toBe(false);
  });

  it("the hard cap cleans every entry at mintedAt + 60 min, boundary inclusive", () => {
    const ledger = new HtmlCapLedger();
    ledger.minted("A", 0); // hard deadline exactly PV_HARD_TTL_MS
    ledger.minted("B", 10); // hard deadline PV_HARD_TTL_MS + 10
    ledger.minted("C", PV_HARD_TTL_MS - 10);
    const cMint = PV_HARD_TTL_MS - 10;
    const at = PV_HARD_TTL_MS + 11; // A and B both ≥ 60 min old; C is 21 ms short
    ledger.minted("D", at);
    expect(ledger.evictedOf("A")).toBe(false); // expired ⇒ cleaned ⇒ answers false
    expect(ledger.evictedOf("B")).toBe(false);
    expect(ledger.evictedOf("C")).toBe(false);
    expect(ledger.liveCount()).toBe(2); // C + D
    ledger.minted("E", cMint + PV_HARD_TTL_MS + 1); // now C is dead too; D/E live
    expect(ledger.liveCount()).toBe(2);
  });

  it("evictedOf answers false for unknown tokens and unmounted() is a no-op on them", () => {
    const ledger = new HtmlCapLedger();
    expect(ledger.evictedOf("nope")).toBe(false);
    expect(() => ledger.unmounted("nope", 5)).not.toThrow();
  });
});
