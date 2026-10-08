/**
 * dir-plan v3.1 §2.3/§2.7 (P1a) — the denylist v2 regression corpus.
 *
 * Pure-function walk over `tests/fixtures/preview-denylist-corpus.json`: every `mustDeny` row
 * must hit `denyListHit` under the corpus ctx (homes=[/home/tester], agentDirs=[the default
 * .pi/agent shape]), every `mustAllow` row must not, and the fixture's `version` must equal
 * `PREVIEW_DENYLIST_VERSION` — the maintenance contract (§2.7): a PR that changes any rule
 * without bumping the version AND refreshing the corpus turns this suite red.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  denyListHit,
  PREVIEW_DENYLIST_VERSION,
  type PreviewDenyContext,
} from "../../../../src/web-hub/hub/preview/admit.js";

interface Corpus {
  version: number;
  ctx: { homes: string[]; agentDirs: string[] };
  mustDeny: string[];
  mustAllow: string[];
}

const corpus: Corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../fixtures/preview-denylist-corpus.json", import.meta.url)), "utf8"),
) as Corpus;

const ctx: PreviewDenyContext = { homes: corpus.ctx.homes, agentDirs: corpus.ctx.agentDirs };

describe("denylist v2 corpus (§2.3/§2.7)", () => {
  it("the fixture's version equals PREVIEW_DENYLIST_VERSION (rule change ⇒ bump + corpus refresh)", () => {
    expect(corpus.version).toBe(PREVIEW_DENYLIST_VERSION);
  });

  it(`every mustDeny row hits (${corpus.mustDeny.length} rows)`, () => {
    const misses = corpus.mustDeny.filter((p) => denyListHit(p, ctx) !== true);
    expect(misses).toEqual([]);
  });

  it(`every mustAllow row passes (${corpus.mustAllow.length} rows — near-miss lookalikes stay readable)`, () => {
    const falsePositives = corpus.mustAllow.filter((p) => denyListHit(p, ctx) !== false);
    expect(falsePositives).toEqual([]);
  });

  it("the corpus is non-trivial: ≥60 deny rows, ≥40 allow rows, and a second-home prefix is exercised", () => {
    expect(corpus.mustDeny.length).toBeGreaterThanOrEqual(60);
    expect(corpus.mustAllow.length).toBeGreaterThanOrEqual(40);
    expect(corpus.mustDeny.some((p) => p.startsWith("/home/other/"))).toBe(true);
  });
});
