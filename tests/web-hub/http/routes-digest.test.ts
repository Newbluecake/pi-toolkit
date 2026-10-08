/**
 * session-history plan §4.6.6: `routes.ts`'s `intentDigest` byte-stability golden test.
 *
 * The golden hex values below were computed from the SHIPPED `intentDigest` for three
 * no-session intents (plain, +model, +firstPrompt) — they must never change: a session-backed
 * intent must hash BYTE-IDENTICALLY to the pre-feature digest whenever `session` is absent,
 * so old idempotency-LRU entries keep hitting across the hub upgrade (§5's byte-identical
 * guarantee). The suite then asserts the NEW behavior on top: a `session` ref changes the
 * digest, and a different `mode` on an otherwise-identical session ref changes it again.
 */
import { describe, expect, it } from "vitest";
import { intentDigest, type SpawnIntent } from "../../../src/web-hub/hub/spawn/routes.js";

function baseIntent(over: Partial<SpawnIntent> = {}): SpawnIntent {
  return {
    id: "req-aaaaaaaaaaaaaaaa",
    cwd: "/home/u/proj",
    confirmed: false,
    expectCwd: undefined,
    model: undefined,
    session: undefined,
    firstPrompt: undefined,
    ...over,
  };
}

describe("routes.ts intentDigest — byte-stability golden (session-history plan §4.6.6)", () => {
  it("plain cwd-only intent: golden hex, computed BEFORE this package's changes", () => {
    expect(intentDigest(baseIntent())).toBe("b40c162fcda128763acf957b44c09cbbcb8cc97cf3fdc9b653eb5c31fee10cb5");
  });

  it("+model intent: golden hex, computed BEFORE this package's changes", () => {
    expect(intentDigest(baseIntent({ model: "anthropic/claude" }))).toBe(
      "15178ae1aabb12bf9deaa5d79323553a5a13efbb64e9f0ab970ef82d548c161b",
    );
  });

  it("+firstPrompt intent: golden hex, computed BEFORE this package's changes", () => {
    expect(intentDigest(baseIntent({ firstPrompt: { text: "hi", deliver: "followUp" } }))).toBe(
      "8579f06e98446c092385b2e8d1d1a250be6f0179dd536e2feb18c0b7052c0f9e",
    );
  });

  it("every golden digest is a 64-hex-char sha256 (sanity on the fixture itself)", () => {
    for (const intent of [
      baseIntent(),
      baseIntent({ model: "anthropic/claude" }),
      baseIntent({ firstPrompt: { text: "hi", deliver: "followUp" } }),
    ]) {
      expect(intentDigest(intent)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("a session ref changes the digest vs. the identical no-session intent", () => {
    const plain = baseIntent();
    const withSession = baseIntent({ session: { key: "dir/a.jsonl", id: "sess-1", mode: "resume" } });
    expect(intentDigest(withSession)).not.toBe(intentDigest(plain));
  });

  it("a different mode on an otherwise-identical session ref changes the digest too", () => {
    const resume = baseIntent({ session: { key: "dir/a.jsonl", id: "sess-1", mode: "resume" } });
    const fork = baseIntent({ session: { key: "dir/a.jsonl", id: "sess-1", mode: "fork" } });
    expect(intentDigest(fork)).not.toBe(intentDigest(resume));
  });

  it("a different key or id on an otherwise-identical session ref changes the digest too", () => {
    const a = baseIntent({ session: { key: "dir/a.jsonl", id: "sess-1", mode: "resume" } });
    const diffKey = baseIntent({ session: { key: "dir/b.jsonl", id: "sess-1", mode: "resume" } });
    const diffId = baseIntent({ session: { key: "dir/a.jsonl", id: "sess-2", mode: "resume" } });
    expect(intentDigest(diffKey)).not.toBe(intentDigest(a));
    expect(intentDigest(diffId)).not.toBe(intentDigest(a));
  });

  it("the same session ref hashes identically across calls (determinism)", () => {
    const i1 = baseIntent({ session: { key: "dir/a.jsonl", id: "sess-1", mode: "resume" } });
    const i2 = baseIntent({ session: { key: "dir/a.jsonl", id: "sess-1", mode: "resume" } });
    expect(intentDigest(i1)).toBe(intentDigest(i2));
  });
});
