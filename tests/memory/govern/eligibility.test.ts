// #36 P3 (arch r5 §3.3.6) — the ONE eligibility verdict: seven layers
// (U/A/E/B/P/S/R + external) × negative cases, the two-check contract's
// pure half, plus the midnight (fake-clock) agent-expiry flip. The
// commit-time recheck and the async rev drop are wired in wire.ts and pinned
// by tests/memory/jev/wire-recall.test.ts / tests/memory/blocks/hub-wiring.test.ts.

import { describe, expect, test } from "vitest";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import {
  eligible,
  frontmatterAudience,
  type EligibilityCtx,
  type EligibilityLayer,
} from "../../../src/memory/govern/eligibility.js";
import { blockRaw } from "../blocks/helpers.js";

const TODAY = "2026-11-06";

function parsed(spec: Parameters<typeof blockRaw>[0]) {
  const block = parseBlockFile(`${spec.id}.md`, blockRaw(spec));
  if ("stray" in block) throw new Error("fixture produced a stray block");
  return block;
}

function ctx(over: Partial<EligibilityCtx> = {}): EligibilityCtx {
  return { today: TODAY, isChild: false, ledger: new Set<string>(), layer: "U", ...over };
}

const LAYERS: readonly EligibilityLayer[] = ["U", "A", "E", "B", "P", "S"];

describe("eligible — admission rules 1–5", () => {
  test("active agent block passes every message layer", () => {
    const b = parsed({ id: "quota.001", body: "- use quota-aware dispatch" });
    for (const layer of LAYERS) expect(eligible(b, undefined, ctx({ layer }))).toEqual({ ok: true });
  });

  test("rule 1: superseded status / supersededBy edge fails everywhere (incl. R/external)", () => {
    const byStatus = parsed({ id: "quota.001", status: "superseded", body: "x" });
    const byEdge = parsed({ id: "quota.002", supersededBy: "quota.009", body: "x" });
    for (const layer of [...LAYERS, "R", "external"] as const) {
      expect(eligible(byStatus, undefined, ctx({ layer })).ok).toBe(false);
      expect(eligible(byEdge, undefined, ctx({ layer })).ok).toBe(false);
    }
  });

  test("rule 2: exists=false (deleted between selection and commit) fails everywhere", () => {
    const b = parsed({ id: "quota.001", body: "x" });
    const verdict = eligible(b, undefined, ctx({ exists: () => false }));
    expect(verdict).toEqual({ ok: false, why: "deleted" });
    expect(eligible(b, undefined, ctx({ exists: (id) => id === "quota.001" })).ok).toBe(true);
  });

  test("rule 3: expired AGENT blocks fail; expired USER rules stay (annotated at render)", () => {
    const agent = parsed({ id: "quota.001", authority: "agent", expires: "2026-11-05", body: "x" });
    const user = parsed({ id: "general.001", authority: "user", scope: "global", expires: "2026-11-05", body: "x" });
    expect(eligible(agent, undefined, ctx())).toEqual({ ok: false, why: "expired" });
    expect(eligible(user, undefined, ctx()).ok).toBe(true);
    // valid on the day itself
    expect(
      eligible(parsed({ id: "quota.002", authority: "agent", expires: TODAY, body: "x" }), undefined, ctx()).ok,
    ).toBe(true);
  });

  test("rule 4: audience — child session rejects main, main session rejects child", () => {
    const mainOnly = parsed({ id: "general.001", audience: "main", body: "x" });
    const childOnly = parsed({ id: "general.002", audience: "child", body: "x" });
    const all = parsed({ id: "general.003", body: "x" });
    expect(eligible(mainOnly, undefined, ctx({ isChild: true }))).toEqual({ ok: false, why: "audience" });
    expect(eligible(childOnly, undefined, ctx({ isChild: false }))).toEqual({ ok: false, why: "audience" });
    expect(eligible(mainOnly, undefined, ctx()).ok).toBe(true);
    expect(eligible(childOnly, undefined, ctx({ isChild: true })).ok).toBe(true);
    expect(eligible(all, undefined, ctx()).ok).toBe(true);
    expect(eligible(all, undefined, ctx({ isChild: true })).ok).toBe(true);
  });

  test("rule 4: ctx.audienceOf overrides the frontmatter (P6b seam)", () => {
    const b = parsed({ id: "general.001", body: "x" }); // frontmatter ⇒ all
    expect(frontmatterAudience(b)).toBe("all");
    expect(eligible(b, undefined, ctx({ isChild: true, audienceOf: () => "main" })).ok).toBe(false);
    expect(eligible(b, undefined, ctx({ isChild: true, audienceOf: () => "child" })).ok).toBe(true);
  });

  test("rule 5: private and secret-looking bodies fail (incl. external egress)", () => {
    const priv = parsed({
      id: "general.001",
      authority: "user",
      scope: "global",
      private: true,
      body: "- never send this out",
    });
    const secret = parsed({ id: "general.002", body: "- api key: sk-abcdefghijklmnopqrstuvwxyz012345" });
    for (const layer of [...LAYERS, "R", "external"] as const) {
      expect(eligible(priv, undefined, ctx({ layer })).ok).toBe(false);
      expect(eligible(secret, undefined, ctx({ layer })).ok).toBe(false);
    }
  });
});

describe("eligible — rule 6 per layer", () => {
  const resident = parsed({
    id: "general.001",
    authority: "user",
    scope: "global",
    body: "- always ask before pushing",
  });
  const topicUser = parsed({ id: "general.002", authority: "user", scope: "topic", body: "- prefer flash for review" });
  const agent = parsed({ id: "quota.001", body: "- watch the quota gate" });

  test("message layers exclude ledger ids; R does not", () => {
    const ledger = new Set(["general.001"]);
    for (const layer of LAYERS) {
      expect(eligible(resident, undefined, ctx({ layer, ledger }))).toEqual({ ok: false, why: "ledger" });
    }
    expect(eligible(resident, undefined, ctx({ layer: "R", ledger })).ok).toBe(true);
    expect(eligible(agent, undefined, ctx({ layer: "U", ledger })).ok).toBe(true);
  });

  test("R delivers global user rules only", () => {
    expect(eligible(resident, undefined, ctx({ layer: "R" })).ok).toBe(true);
    expect(eligible(topicUser, undefined, ctx({ layer: "R" }))).toEqual({ ok: false, why: "not-resident" });
    expect(eligible(agent, undefined, ctx({ layer: "R" }))).toEqual({ ok: false, why: "not-resident" });
  });

  test("external renders resident section + index only — non-resident index material passes rule 6", () => {
    expect(eligible(resident, undefined, ctx({ layer: "external" })).ok).toBe(true);
    expect(eligible(agent, undefined, ctx({ layer: "external" })).ok).toBe(true);
    expect(eligible(topicUser, undefined, ctx({ layer: "external" })).ok).toBe(true);
  });
});

describe("eligible — cross-midnight (fake clock)", () => {
  test("an agent block flips from eligible to expired as `today` advances past expires", () => {
    const b = parsed({
      id: "quota.001",
      authority: "agent",
      expires: "2026-11-06",
      body: "- route around the outage until it clears",
    });
    expect(eligible(b, undefined, ctx({ today: "2026-11-06" })).ok).toBe(true); // valid on the day
    expect(eligible(b, undefined, ctx({ today: "2026-11-07" }))).toEqual({ ok: false, why: "expired" });
  });

  test("an expired-global USER rule stays eligible on both sides of midnight (annotation changes at render)", () => {
    const b = parsed({
      id: "general.001",
      authority: "user",
      scope: "global",
      expires: "2026-11-06",
      body: "- ask before release",
    });
    expect(eligible(b, undefined, ctx({ today: "2026-11-06", layer: "R" })).ok).toBe(true);
    expect(eligible(b, undefined, ctx({ today: "2026-11-07", layer: "R" })).ok).toBe(true);
  });
});
