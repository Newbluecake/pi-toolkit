import { describe, expect, it } from "vitest";
import { isRunId, newRunId } from "../../../src/core/ids.js";
import { SSE_EVENTS } from "../../../src/web-hub/protocol/http-contract.js";
import { LIMITS, TIMING } from "../../../src/web-hub/protocol/messages.js";
import {
  RUN_API,
  RUN_ID_PATTERN,
  RUN_SSE_EVENTS,
  RUN_TX,
  RUN_TX_REASONS,
  TAP_ID_PATTERN,
} from "../../../src/web-hub/protocol/run-transcript.js";

/** Deterministic PRNG (mulberry32) so a failing sample is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("RUN_TX budget block (fleet-drawer §3.3/§3.5/§5.1)", () => {
  it("pins every value", () => {
    expect(RUN_TX).toEqual({
      tailDefault: 200,
      pageMax: 400,
      maxBytes: 2 << 20,
      tapsPerAgent: 8,
      subsPerClient: 2,
      reqDeadlineMs: 5_000,
      clientPendingMs: 10_000,
      resyncMaxPer10s: 3,
      endPendingMax: 32,
      endPendingTtlMs: 600_000,
      endLedgerMax: 256,
      endLedgerTtlMs: 900_000,
      scanChunkBytes: 1 << 20,
      maxScanBytes: 256 << 20,
      scanConcurrency: 2,
      cursorCacheMax: 16,
    });
  });

  it("maxBytes / reqDeadlineMs mirror messages.ts's LIMITS.branchReplyBytes / TIMING.snapshotMs", () => {
    // run-transcript.ts cannot import these at runtime (top-level cycle with messages.ts's
    // schema import — see its file header), so the literals are pinned HERE instead.
    expect(RUN_TX.maxBytes).toBe(LIMITS.branchReplyBytes);
    expect(RUN_TX.reqDeadlineMs).toBe(TIMING.snapshotMs);
    // single reply stays under the 4 MiB frame budget (ndjson MAX_FRAME_BYTES)
    expect(RUN_TX.maxBytes).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("RUN_TX_REASONS (fleet-drawer §3.6)", () => {
  it("is exactly the 10 frozen denial reasons, in order", () => {
    expect([...RUN_TX_REASONS]).toEqual([
      "unknown_run",
      "not_persisted",
      "file_missing",
      "leaf_unknown",
      "leaf_missing",
      "too_large",
      "parse_error",
      "unsupported",
      "busy",
      "resync_storm",
    ]);
  });
});

describe("RUN_ID_PATTERN mirrors core/ids.ts isRunId (F0 acceptance)", () => {
  const re = new RegExp(RUN_ID_PATTERN);
  const rand = mulberry32(0xc0ffee);
  const ALLOWED = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const POISON = "ILOUilou@_-#.abcxyz";

  function randomFrom(alphabet: string, len: number): string {
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
    return s;
  }

  function mutatedSample(): string {
    const id = newRunId();
    const kind = Math.floor(rand() * 8);
    const pos = 2 + Math.floor(rand() * 8); // body position (never the "r_" prefix)
    switch (kind) {
      case 0:
        return id.slice(0, 7); // too short
      case 1:
        return id + ALLOWED[Math.floor(rand() * ALLOWED.length)]; // too long
      case 2:
        return id.slice(2); // prefix dropped
      case 3:
        return "x_" + id.slice(2); // wrong prefix
      case 4:
        return id.slice(0, pos) + POISON[Math.floor(rand() * POISON.length)] + id.slice(pos + 1);
      case 5:
        return id.slice(0, pos) + id[pos]!.toLowerCase() + id.slice(pos + 1); // lowercased body char
      case 6:
        return ""; // empty
      default:
        return id.slice(0, pos) + ALLOWED[Math.floor(rand() * ALLOWED.length)] + id.slice(pos + 1); // still valid
    }
  }

  it("agrees with isRunId on 1k seeded random samples (no drift in either direction)", () => {
    const samples: string[] = [];
    for (let i = 0; i < 150; i++) samples.push(newRunId());
    for (let i = 0; i < 600; i++) samples.push(mutatedSample());
    for (let i = 0; i < 250; i++) {
      const len = Math.floor(rand() * 18);
      const alphabet = rand() < 0.5 ? ALLOWED + POISON : "rn_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      samples.push(rand() < 0.5 ? randomFrom(alphabet, len) : "r_" + randomFrom(alphabet, len));
    }
    expect(samples).toHaveLength(1000);
    for (const s of samples) {
      expect(re.test(s), JSON.stringify(s)).toBe(isRunId(s));
    }
  });

  it("accepts a known-good id and rejects the canonical bad shapes", () => {
    expect(re.test("r_ABCD1234")).toBe(true);
    expect(re.test("r_ABCDEFGH")).toBe(true); // H allowed, I is not
    expect(re.test("r_ABCDEFGI")).toBe(false); // I excluded (Crockford)
    expect(re.test("r_ABCDEFGL")).toBe(false); // L excluded
    expect(re.test("r_ABCDEFGO")).toBe(false); // O excluded
    expect(re.test("r_ABCDEFGU")).toBe(false); // U excluded
    expect(re.test("r_abcd1234")).toBe(false); // lowercase body
    expect(re.test("R_ABCD1234")).toBe(false); // uppercase prefix
  });
});

describe("TAP_ID_PATTERN (fleet-drawer §3.3 #1)", () => {
  const re = new RegExp(TAP_ID_PATTERN);
  it("accepts a 16-char base64url tapId and rejects bad lengths/chars", () => {
    expect(re.test("abcdefghijklmnop")).toBe(true);
    expect(re.test("ab-_89-_")).toBe(true); // 8 chars: lower bound, url-safe punctuation
    expect(re.test("abc123_-")).toBe(true);
    expect(re.test("abc123_-".repeat(4))).toBe(true); // 32 chars: upper bound
    expect(re.test("abc123_")).toBe(false); // 7 chars
    expect(re.test("abc123_-".repeat(4) + "a")).toBe(false); // 33 chars
    expect(re.test("abc 1234")).toBe(false); // whitespace
    expect(re.test("abcd+123")).toBe(false); // non-url-safe base64 char
  });
});

describe("browser surface constants (fleet-drawer §3.4)", () => {
  it("RUN_API pins the three endpoint literals", () => {
    expect(RUN_API).toEqual({
      subscribe: "/api/run/subscribe",
      unsubscribe: "/api/run/unsubscribe",
      history: "/api/run/history",
    });
  });

  it("RUN_SSE_EVENTS is exactly the three direct-send events, all present in http-contract SSE_EVENTS", () => {
    expect([...RUN_SSE_EVENTS]).toEqual(["run_history", "run_ev", "run_end"]);
    for (const name of RUN_SSE_EVENTS) {
      expect(SSE_EVENTS, name).toContain(name);
    }
  });
});
