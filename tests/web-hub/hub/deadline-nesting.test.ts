import { describe, expect, it } from "vitest";
import { UPLOAD_CHUNK_BODY_MS, UPLOAD_TOTAL_MS } from "../../../src/web-hub/protocol/upload.js";
import {
  AGENT_TOTAL_CAP_MS,
  AGENT_TOTAL_RESERVE_MS,
  BODY_CAP_MS,
  BODY_RESERVE_MS,
  computeAgentBudgets,
  deriveBudget,
  FORWARD_MIN_REMAINING_MS,
  LAN_AUTH_CAP_MS,
  REGISTRY_WAIT_GRACE_MS,
  REGISTRY_WAIT_RESERVE_MS,
  WRITE_TOTAL_MS,
} from "../../../src/web-hub/hub/req-deadline.js";
import { LAN_REQUEST_TIMEOUT_MS } from "../../../src/web-hub/hub/http.js";
import { CMD_REQUEST_TIMEOUT_MS as TOKEN_CMD_REQUEST_TIMEOUT_MS } from "../../../src/web-hub/ui/src/logic/token-client.js";
import { CMD_REQUEST_TIMEOUT_MS as PASSWORD_CMD_REQUEST_TIMEOUT_MS } from "../../../src/web-hub/ui/src/logic/password-client.js";

/** Deterministic xorshift-ish PRNG so a failure is reproducible without pulling in a fuzzing lib. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

describe("§3.3 nested deadline invariant (plan: agentDeadlineMs <= registryWaitMs <= remaining <= WRITE_TOTAL_MS)", () => {
  it("holds for the full [0, WRITE_TOTAL_MS] range at 1ms resolution", () => {
    for (let remaining = 0; remaining <= WRITE_TOTAL_MS; remaining++) {
      const { agentDeadlineMs, registryWaitMs } = computeAgentBudgets(remaining);
      expect(agentDeadlineMs).toBeGreaterThanOrEqual(0);
      expect(registryWaitMs).toBeGreaterThanOrEqual(0);
      expect(agentDeadlineMs).toBeLessThanOrEqual(registryWaitMs);
      expect(registryWaitMs).toBeLessThanOrEqual(remaining);
      expect(remaining).toBeLessThanOrEqual(WRITE_TOTAL_MS);
    }
  });

  it("holds for 5,000 random `remaining` samples spanning well beyond the normal range (fake-clock randomization, C3 acceptance)", () => {
    const rand = prng(20260929);
    for (let i = 0; i < 5_000; i++) {
      const remaining = Math.floor(rand() * WRITE_TOTAL_MS * 2 - WRITE_TOTAL_MS * 0.2); // includes some negative
      const { agentDeadlineMs, registryWaitMs } = computeAgentBudgets(remaining);
      expect(agentDeadlineMs).toBeGreaterThanOrEqual(0);
      expect(registryWaitMs).toBeGreaterThanOrEqual(agentDeadlineMs);
      expect(registryWaitMs).toBeLessThanOrEqual(Math.max(0, remaining));
    }
  });

  it("at remaining = WRITE_TOTAL_MS, agentDeadlineMs hits its cap and registryWaitMs is agentDeadlineMs + grace", () => {
    const { agentDeadlineMs, registryWaitMs } = computeAgentBudgets(WRITE_TOTAL_MS);
    expect(agentDeadlineMs).toBe(AGENT_TOTAL_CAP_MS);
    expect(registryWaitMs).toBe(AGENT_TOTAL_CAP_MS + REGISTRY_WAIT_GRACE_MS);
  });

  it("body-read reserve is the largest of the three (body read happens earliest, needs the most headroom)", () => {
    expect(BODY_RESERVE_MS).toBeGreaterThan(AGENT_TOTAL_RESERVE_MS);
    expect(AGENT_TOTAL_RESERVE_MS).toBeGreaterThan(REGISTRY_WAIT_RESERVE_MS);
  });

  it("the forward-or-refuse threshold sits strictly below WRITE_TOTAL_MS", () => {
    expect(FORWARD_MIN_REMAINING_MS).toBeLessThan(WRITE_TOTAL_MS);
  });

  it(
    "§3.3's outer nesting invariant holds across process boundaries: server WRITE_TOTAL_MS(13s) < both" +
      " listeners' Node requestTimeout(15s) < the browser fetch AbortController(16s) (C3 acceptance)",
    () => {
      expect(WRITE_TOTAL_MS).toBe(13_000);
      expect(WRITE_TOTAL_MS).toBeLessThan(LAN_REQUEST_TIMEOUT_MS);
      expect(LAN_REQUEST_TIMEOUT_MS).toBe(15_000);
      expect(LAN_REQUEST_TIMEOUT_MS).toBeLessThan(TOKEN_CMD_REQUEST_TIMEOUT_MS);
      expect(LAN_REQUEST_TIMEOUT_MS).toBeLessThan(PASSWORD_CMD_REQUEST_TIMEOUT_MS);
      expect(TOKEN_CMD_REQUEST_TIMEOUT_MS).toBe(16_000);
      expect(PASSWORD_CMD_REQUEST_TIMEOUT_MS).toBe(16_000);
    },
  );

  it("body budget derivation matches deriveBudget directly (no separate formula drift)", () => {
    for (const remaining of [0, 1_000, 4_999, 5_000, 5_001, 9_000, WRITE_TOTAL_MS]) {
      expect(deriveBudget(remaining, BODY_CAP_MS, BODY_RESERVE_MS)).toBe(
        Math.max(0, Math.min(BODY_CAP_MS, remaining - BODY_RESERVE_MS)),
      );
    }
  });

  it("web-hub-upload plan §1.3 (U3): the chunk request deadline nests inside the listener socket timeout chain", () => {
    expect(UPLOAD_CHUNK_BODY_MS).toBe(12_000);
    expect(UPLOAD_TOTAL_MS).toBe(14_000);
    expect(UPLOAD_CHUNK_BODY_MS).toBeLessThan(UPLOAD_TOTAL_MS);
    expect(UPLOAD_TOTAL_MS).toBeLessThan(LAN_REQUEST_TIMEOUT_MS);
    expect(LAN_REQUEST_TIMEOUT_MS).toBeLessThan(TOKEN_CMD_REQUEST_TIMEOUT_MS);
    // §1.3: the first LAN authorize keeps 11s of the 14s in reserve for body+write
    expect(UPLOAD_TOTAL_MS - LAN_AUTH_CAP_MS).toBe(11_000);
  });
});

describe("web-hub-preview plan v3 §3.1/§6 (PV3): preview budget nesting", () => {
  it("§3.1 ②: LAN auth keeps ≥4s of the 8s admission budget for the fs phases", async () => {
    const { PREVIEW_ADMIT_TOTAL_MS, PREVIEW_STREAM_MS, PREVIEW_VERIFY_MS } =
      await import("../../../src/web-hub/protocol/preview.js");
    const { LAN_AUTH_CAP_MS, deriveBudget } = await import("../../../src/web-hub/hub/req-deadline.js");
    const { PREVIEW_AUTH_RESERVE_MS } = await import("../../../src/web-hub/hub/preview/routes.js");
    expect(PREVIEW_AUTH_RESERVE_MS).toBe(4_000);
    // at full remaining the auth budget is its 3s cap…
    expect(deriveBudget(PREVIEW_ADMIT_TOTAL_MS, LAN_AUTH_CAP_MS, PREVIEW_AUTH_RESERVE_MS)).toBe(LAN_AUTH_CAP_MS);
    // …and what CAN remain afterwards (≥ the 4s reserve) still covers the fs phases
    expect(PREVIEW_ADMIT_TOTAL_MS - LAN_AUTH_CAP_MS).toBeGreaterThanOrEqual(PREVIEW_AUTH_RESERVE_MS);
  });

  it("§0 budget chain: ADMIT(8s) + STREAM.lan(30s) ≤ CLIENT_TIMEOUT(40s); VERIFY ≤ STREAM.lan", async () => {
    const { PREVIEW_ADMIT_TOTAL_MS, PREVIEW_STREAM_MS, PREVIEW_VERIFY_MS, PREVIEW_CLIENT_TIMEOUT_MS } =
      await import("../../../src/web-hub/protocol/preview.js");
    expect(PREVIEW_ADMIT_TOTAL_MS + PREVIEW_STREAM_MS.lan).toBeLessThanOrEqual(PREVIEW_CLIENT_TIMEOUT_MS);
    expect(PREVIEW_VERIFY_MS).toBeLessThanOrEqual(PREVIEW_STREAM_MS.lan);
  });
});
