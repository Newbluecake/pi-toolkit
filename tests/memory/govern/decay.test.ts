// #36 P6b (arch r5 §6.2) — decay targets, the 7/30-day multiplier
// boundaries, the P/A name-mention requirement, and the PG-tunable
// TOPIC_USER_POOL_CAP living ONLY here (plan r3 裁定 12).

import { describe, expect, test } from "vitest";
import type { EntryTags, MemEntry } from "../../../src/memory/jev/contracts.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import {
  DECAY_MILD_DAYS,
  DECAY_STEEP_DAYS,
  TOPIC_USER_POOL_CAP,
  decayFactor,
  decaySubjectOf,
  isDecayTarget,
  namesSubject,
} from "../../../src/memory/govern/decay.js";

const DAY = 86_400_000;
const TODAY = "2026-11-06";

function iso(daysAgo: number): string {
  return new Date(Date.parse("2026-11-06T00:00:00.000Z") - daysAgo * DAY).toISOString();
}

function subject(over: Partial<Parameters<typeof isDecayTarget>[0]> = {}) {
  return {
    authority: "agent",
    updated: iso(1),
    body: "- run r_abc123 used 62% of the quota window",
    ...over,
  };
}

function sidecar(over: Partial<EntryTags> = {}): EntryTags {
  return {
    file: "quota.001.md",
    type: "fact",
    typeP: 0.9,
    importance: 2,
    tags: {},
    guard: 0.1,
    temporal: "permanent",
    userLike: 0.1,
    model: "opencode/jev-1.13",
    at: "2026-11-01T00:00:00.000Z",
    taxonomyRev: "x",
    ...over,
  };
}

describe("isDecayTarget (arch §6.2 对象)", () => {
  test("agent ∧ snapshot body (run id) ⇒ target", () => {
    expect(isDecayTarget(subject())).toBe(true);
  });

  test("agent ∧ temporal dated/event (sidecar) ⇒ target even without a snapshot body", () => {
    const plain = { ...subject(), body: "- use the proxy for git push this week" };
    expect(isDecayTarget({ ...plain, temporal: "dated" })).toBe(true);
    expect(isDecayTarget({ ...plain, temporal: "event" })).toBe(true);
    expect(isDecayTarget({ ...plain, temporal: "permanent" })).toBe(false);
  });

  test("user blocks never decay (even snapshot + 40 days old)", () => {
    expect(isDecayTarget(subject({ authority: "user", updated: iso(40) }))).toBe(false);
  });

  test("blocks with expires OR until never decay (their own deadline governs, V26)", () => {
    expect(isDecayTarget(subject({ expires: "2026-12-31" }))).toBe(false);
    expect(isDecayTarget(subject({ until: "网络恢复后清理" }))).toBe(false);
    expect(decayFactor(subject({ until: "cleanup after the outage", updated: iso(40) }), TODAY)).toBe(1);
  });

  test("no `updated` (files layout) ⇒ never a target", () => {
    const { updated: _drop, ...files } = subject();
    expect(isDecayTarget(files)).toBe(false);
  });
});

describe("decayFactor m(age) boundaries (7/30 days)", () => {
  test("≤7 days ⇒ 1.0; 8–30 ⇒ 0.8; >30 ⇒ 0.6", () => {
    expect(decayFactor(subject({ updated: iso(0) }), TODAY)).toBe(1);
    expect(decayFactor(subject({ updated: iso(DECAY_MILD_DAYS) }), TODAY)).toBe(1);
    expect(decayFactor(subject({ updated: iso(DECAY_MILD_DAYS + 1) }), TODAY)).toBe(0.8);
    expect(decayFactor(subject({ updated: iso(DECAY_STEEP_DAYS) }), TODAY)).toBe(0.8);
    expect(decayFactor(subject({ updated: iso(DECAY_STEEP_DAYS + 1) }), TODAY)).toBe(0.6);
    expect(decayFactor(subject({ updated: iso(400) }), TODAY)).toBe(0.6);
  });

  test("non-targets are 1.0 regardless of age (user / expires / until / files / plain-permanent)", () => {
    expect(decayFactor(subject({ authority: "user", updated: iso(400) }), TODAY)).toBe(1);
    expect(decayFactor(subject({ expires: "2026-12-31", updated: iso(400) }), TODAY)).toBe(1);
    expect(decayFactor(subject({ until: "after the release lands", updated: iso(400) }), TODAY)).toBe(1);
    expect(decayFactor({ ...subject(), updated: undefined }, TODAY)).toBe(1);
    expect(decayFactor({ ...subject({ updated: iso(400) }), body: "- prefer node 22 for installs" }, TODAY)).toBe(1);
  });

  test("an unparseable updated reads as age 0 (fail-open for freshness)", () => {
    expect(decayFactor(subject({ updated: "not-a-date" }), TODAY)).toBe(1);
  });
});

describe("namesSubject (P/A 点名要求 — reuses match.ts lexicalTokens)", () => {
  const snap = { body: "- run r_dec99 的 5h 窗口配额已用 62%" };

  test("a shared distinctive token (run id / ascii word / CJK bigram) ⇒ named", () => {
    expect(namesSubject("提交前先核对 run r_dec99 的配额", snap)).toBe(true);
    expect(namesSubject("查一下配额", snap)).toBe(true); // CJK bigram 配额
    expect(namesSubject("what about the 5h window", { body: "- 5h 窗口配额" })).toBe(true); // ascii 5h
  });

  test("zero overlap ⇒ not named (the stale-fact-without-audience case)", () => {
    expect(namesSubject("提交这些改动，顺便跑下格式检查", snap)).toBe(false);
    expect(namesSubject("hello world", snap)).toBe(false);
  });

  test("uses the FIRST non-empty body line only; empty body ⇒ false", () => {
    const twoLine = { body: "\n- run r_dec99 配额\n第二行才出现 quota" };
    expect(namesSubject("quota", twoLine)).toBe(false); // second-line token does not count
    expect(namesSubject("", { body: "- anything" })).toBe(false); // empty turn text never names
    expect(namesSubject("x", { body: "   \n" })).toBe(false);
  });
});

describe("decaySubjectOf (MemEntry fold)", () => {
  function entry(over: Partial<MemEntry> & { body: string }): MemEntry {
    const base: MemEntry = {
      file: "quota.001.md",
      section: "",
      ordinal: 1,
      lineStart: 1,
      lineEnd: 2,
      raw: over.body,
      hash: entryHash(over.body),
      guardHash: "g",
      inline: { present: true },
      inlineErrors: [],
      authority: "agent",
      fileStatus: "active",
      secret: false,
      namedPrograms: [],
      ...over,
    };
    return base;
  }

  test("folds block.updated / inline.expires / sidecar temporal and the snapshot regex", () => {
    const e = entry({
      body: "- run r_fold99 quota at 62%",
      authority: "agent",
      inline: { present: true, authority: "lesson" },
      block: { id: "quota.001", status: "active", updated: iso(40) },
    });
    const s = decaySubjectOf(e, sidecar({ temporal: "permanent" }));
    expect(s.updated).toBe(iso(40));
    expect(s.authority).toBe("agent");
    expect(s.snapshot).toBeUndefined(); // the flag is the persisted marker only…
    expect(isDecayTarget(s)).toBe(true); // …the run-id regex lives in isDecayTarget
    expect(decayFactor(s, TODAY)).toBe(0.6);
    // expires folds in from the inline meta and disables decay
    const withExpires = decaySubjectOf({ ...e, inline: { present: true, expires: "2026-12-31" } }, undefined);
    expect(withExpires.expires).toBe("2026-12-31");
    expect(isDecayTarget(withExpires)).toBe(false);
    // until folds in the same way (fix #1: both deadline kinds exempt)
    const withUntil = decaySubjectOf({ ...e, inline: { present: true, until: "发布完成后清理" } }, undefined);
    expect(withUntil.until).toBe("发布完成后清理");
    expect(isDecayTarget(withUntil)).toBe(false);
    // sidecar temporal folds in for a non-snapshot body
    const dated = decaySubjectOf(
      entry({ body: "- use the proxy this week", block: { id: "quota.002", status: "active", updated: iso(1) } }),
      sidecar({ temporal: "dated" }),
    );
    expect(dated.temporal).toBe("dated");
    expect(isDecayTarget(dated)).toBe(true);
  });
});

describe("TOPIC_USER_POOL_CAP (PG G2 tuning point)", () => {
  test("is a positive integer exported only from decay.ts (plan r3 裁定 12)", () => {
    expect(Number.isInteger(TOPIC_USER_POOL_CAP)).toBe(true);
    expect(TOPIC_USER_POOL_CAP).toBeGreaterThan(0);
    expect(TOPIC_USER_POOL_CAP).toBe(64); // default; P6b-fix doubles it under PG
  });
});
