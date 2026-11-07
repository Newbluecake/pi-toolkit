import { describe, expect, it } from "vitest";
import {
  crossLayerDupMarkers,
  dedupeKeyOf,
  duplicateMarkerUtf8Bytes,
  fitsRenderBudget,
  planThreeLayerDuplicates,
  projectedDuplicateMarkers,
  type ThreeLayerDuplicateCandidate,
} from "../../../src/memory/scopes/render.js";

const candidate = (
  layer: ThreeLayerDuplicateCandidate["layer"],
  authority: ThreeLayerDuplicateCandidate["authority"],
  id: string = layer,
  visibility: ThreeLayerDuplicateCandidate["visibility"] = "full",
  text = "same",
): ThreeLayerDuplicateCandidate => ({ layer, authority, id, visibility, text });

describe("three-layer visible duplicate kernel", () => {
  it("uses existing normalization, not semantic matching", () => {
    expect(dedupeKeyOf(" Ａ  b <!-- mem user -->")).toBe(dedupeKeyOf("A\nb"));
    expect(dedupeKeyOf("same meaning")).not.toBe(dedupeKeyOf("equal meaning"));
    const plan = planThreeLayerDuplicates([
      candidate("session", "agent", "n1", "full", " Ａ b <!-- mem user -->"),
      candidate("hub", "user", "g.1", "full", "A\nb"),
    ]);
    expect(plan.markers).toEqual([{ layer: "hub", id: "g.1" }, undefined]);
  });

  it.each(["session", "project", "hub"] as const)("%s user outranks every agent specificity", (layer) => {
    const entries = [
      candidate("session", "agent"),
      candidate("project", "agent"),
      candidate("hub", "agent"),
      candidate(layer, "user", "u"),
    ];
    expect(planThreeLayerDuplicates(entries).markers).toEqual([
      { layer, id: "u" },
      { layer, id: "u" },
      { layer, id: "u" },
      undefined,
    ]);
  });

  it("ties use specificity then stable id, independent of layer input order", () => {
    const entries = [
      candidate("hub", "user"),
      candidate("project", "user"),
      candidate("session", "user", "n9"),
      candidate("session", "user", "n1"),
    ];
    const plan = planThreeLayerDuplicates(entries);
    expect(plan.markers).toEqual([
      { layer: "session", id: "n1" },
      { layer: "session", id: "n1" },
      { layer: "session", id: "n1" },
      undefined,
    ]);
    expect(planThreeLayerDuplicates([...entries].reverse()).markers).toEqual([...plan.markers].reverse());
  });

  it("index-only candidates NEVER win, even with higher authority; no full means no winner", () => {
    expect(
      planThreeLayerDuplicates([candidate("project", "user", "index", "index"), candidate("hub", "agent")]).markers,
    ).toEqual([{ layer: "hub", id: "hub" }, undefined]);
    expect(
      planThreeLayerDuplicates([candidate("session", "user", "a", "index"), candidate("project", "user", "b", "index")])
        .markers,
    ).toEqual([undefined, undefined]);
    expect(planThreeLayerDuplicates([])).toEqual({ candidates: [], markers: [], markerMaxBytes: [] });
  });

  it("does not mutate DTOs; exact full consumer matching rejects stale bodies/authority/index", () => {
    const entry = Object.freeze(candidate("session", "agent", "n1"));
    const entries = Object.freeze([entry, Object.freeze(candidate("project", "user"))]);
    const plan = planThreeLayerDuplicates(entries);
    expect(entries[0]).toEqual(entry);
    expect(plan.candidates[0]).not.toBe(entry);
    expect(projectedDuplicateMarkers(plan, "session", [entry])).toEqual([{ layer: "project", id: "project" }]);
    expect(
      projectedDuplicateMarkers(plan, "session", [
        { ...entry, text: "changed" },
        { ...entry, authority: "user" },
      ]),
    ).toEqual([undefined, undefined]);
    expect(projectedDuplicateMarkers(plan, "hub", [entry])).toEqual([undefined]);
  });

  it("reserves marker UTF-8 for EVERY entry, including multi-byte ids and leading separator", () => {
    const entries = [
      candidate("hub", "user", "規則"),
      candidate("session", "agent", "a"),
      candidate("session", "agent", "b"),
    ];
    const plan = planThreeLayerDuplicates(entries);
    const suffix = " (dup of hub 規則)";
    const bytes = Buffer.byteLength(suffix, "utf8");
    expect(duplicateMarkerUtf8Bytes({ layer: "hub", id: "規則" })).toBe(bytes);
    expect(plan.markerMaxBytes[1]).toBeGreaterThanOrEqual(bytes);
    expect(plan.markerMaxBytes[2]).toBeGreaterThanOrEqual(bytes);
    expect(plan.markerMaxBytes.slice(1).reduce((a, b) => a + b, 0)).toBe(2 * bytes);
    const body = "x"; // 1B raw body; final marker is part of admission, not free metadata
    expect(fitsRenderBudget(body, 1)).toBe(true);
    expect(fitsRenderBudget(body + suffix, 1 + bytes)).toBe(true);
    expect(fitsRenderBudget(body + suffix, bytes)).toBe(false); // +1 over budget
    expect(fitsRenderBudget(body + suffix + "x", 1 + bytes)).toBe(false);
  });

  it("single full has no loser suffix reservation; unrelated/index entries cannot enlarge it", () => {
    const plan = planThreeLayerDuplicates([
      candidate("session", "user", "n1"),
      candidate("hub", "user", "long-index-anchor", "index"),
      candidate("project", "user", "unrelated-anchor", "full", "different"),
    ]);
    expect(plan.markers).toEqual([undefined, { layer: "session", id: "n1" }, undefined]);
    expect(plan.markerMaxBytes).toEqual([0, Buffer.byteLength(" (dup of session n1)"), 0]);
    expect(planThreeLayerDuplicates([candidate("session", "user", "n1")]).markerMaxBytes).toEqual([0]);
  });

  it("multiple full bounds exclude self; current winner has zero ACTUAL marker bytes", () => {
    const plan = planThreeLayerDuplicates([
      candidate("session", "user", "n1"),
      candidate("hub", "agent", "長い-anchor"),
    ]);
    expect(plan.markers).toEqual([undefined, { layer: "session", id: "n1" }]);
    expect(plan.markerMaxBytes).toEqual([
      Buffer.byteLength(" (dup of hub 長い-anchor)", "utf8"),
      Buffer.byteLength(" (dup of session n1)", "utf8"),
    ]);
    expect(plan.markers.map((marker) => (marker === undefined ? 0 : duplicateMarkerUtf8Bytes(marker)))).toEqual([
      0,
      Buffer.byteLength(" (dup of session n1)"),
    ]);
  });

  it("same-layer id/position tiebreaks keep per-entry UTF8 bounds aligned, not future-plan reservations", () => {
    const entries = [
      candidate("session", "user", "z"),
      candidate("session", "user", "a"),
      candidate("session", "user", "a"),
    ];
    const plan = planThreeLayerDuplicates(entries);
    expect(plan.markers).toEqual([{ layer: "session", id: "a" }, undefined, { layer: "session", id: "a" }]);
    expect(plan.markerMaxBytes).toEqual(entries.map(() => Buffer.byteLength(" (dup of session z)")));
    const next = planThreeLayerDuplicates([...entries, candidate("hub", "user", "very-long-new-anchor")]);
    expect(next.markerMaxBytes[0]).toBeGreaterThan(plan.markerMaxBytes[0]!);
    expect(plan.markerMaxBytes[0]).toBe(Buffer.byteLength(" (dup of session z)"));
  });

  it("keeps the old two-layer export unchanged (empty output shape)", () => {
    expect(crossLayerDupMarkers([], [])).toEqual({ session: [], hub: [] });
  });
});
