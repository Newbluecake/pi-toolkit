/**
 * Seeded property invariants for the hold buffer (plan §9 anchor `hold.property.test.ts`):
 * random interleavings of hold/take/release/recall/markReturned must never let a fully-removed
 * cmdId (sent-and-released, or recalled) reappear in the buffer, and the projection must never
 * contain a duplicate cmdId or a `handing` row. Deterministic LCG seed so a failure is
 * reproducible.
 */
import { describe, expect, it } from "vitest";
import { createHoldBuffer, type HoldBag } from "../../../src/web-hub/agent/hold.js";
import type { CmdOrigin } from "../../../src/web-hub/protocol/messages.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "r1" };

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

type Op = "hold" | "take" | "release" | "recall" | "markReturned";

function runTrial(seed: number, steps: number): void {
  const rand = lcg(seed);
  const bag: HoldBag = { v: 1, rev: 0, items: new Map() };
  const buf = createHoldBuffer({ bag });
  const ids = ["a", "b", "c", "d"];
  const sessionOf = (id: string): string => (id < "c" ? "s1" : "s2");
  const taken = new Set<string>();
  /** ids that have been IRREVERSIBLY removed (sent-and-released, or recalled) — the buffer must
   * never let one of these reappear. */
  const gone = new Set<string>();
  let now = 0;

  for (let i = 0; i < steps; i++) {
    now += 1;
    const id = ids[Math.floor(rand() * ids.length)]!;
    const op: Op = (["hold", "take", "release", "recall", "markReturned"] as const)[Math.floor(rand() * 5)]!;
    switch (op) {
      case "hold": {
        if (gone.has(id)) break; // out of scope: re-holding a fully-removed id is a fresh lifecycle
        buf.hold(
          {
            cmdId: id,
            sessionId: sessionOf(id),
            owner: "o",
            text: `t-${id}`,
            deliver: "steer",
            origin: ORIGIN,
            at: now,
          },
          now,
        );
        break;
      }
      case "take": {
        const t = buf.takeForHandoff(id, now);
        if (t !== undefined) taken.add(id);
        break;
      }
      case "release": {
        if (taken.has(id)) {
          buf.release(id);
          taken.delete(id);
          gone.add(id);
        }
        break;
      }
      case "recall": {
        const before = gone.has(id);
        const outcome = buf.recall(id, now);
        if (before) {
          // a fully-removed id must never be recallable again.
          expect(outcome.kind).toBe("unknown");
        } else if (outcome.kind === "recalled") {
          gone.add(id);
          taken.delete(id);
        }
        break;
      }
      case "markReturned": {
        buf.markReturned([id], "stale", now);
        break;
      }
    }
    // invariant: projection never contains a duplicate cmdId, a `handing` row, or a gone id.
    const s1 = buf.project("s1", now);
    const s2 = buf.project("s2", now);
    for (const rows of [s1, s2]) {
      const seen = new Set<string>();
      for (const row of rows) {
        expect(seen.has(row.cmdId)).toBe(false);
        seen.add(row.cmdId);
        expect(row.state === "held" || row.state === "returned").toBe(true);
        expect(gone.has(row.cmdId)).toBe(false);
      }
    }
  }
}

describe("createHoldBuffer — property: no resurrection of a fully-removed id, no duplicate/handing rows", () => {
  for (const seed of [1, 2, 3, 42, 1337, 999_999]) {
    it(`seed=${seed}`, () => {
      runTrial(seed, 500);
    });
  }
});
