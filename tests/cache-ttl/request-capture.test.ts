/**
 * Direct unit tests for `captureRequest()` (src/cache-ttl/cache-ttl.ts) — the payload-only capture builder shared
 * by the main and child wirings (capture-pairing-plan r7 §3.1). The old two-hook pairing helper
 * (`createRequestCapture`: stage/clear/consumeHeaders) is deleted: pi fires `before_provider_headers` BEFORE
 * `before_provider_request`, so a request is captured from the payload alone.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as cacheTtl from "../../src/cache-ttl/cache-ttl.js";
import { compareFingerprint } from "../../src/cache-ttl/keepalive-state.js";
import type { KeepalivePort } from "../../src/cache-ttl/keepalive-service.js";

function fakePort(instanceId = "inst-1"): KeepalivePort {
  return {
    instanceId,
    noteRequest: vi.fn(),
    noteRequestSettled: vi.fn(),
    invalidate: vi.fn(),
    report: vi.fn(),
  } as unknown as KeepalivePort;
}

function ctxFor(model: Record<string, unknown> | undefined): ExtensionContext {
  return { model } as unknown as ExtensionContext;
}

const MODEL = {
  provider: "anthropic",
  api: "anthropic-messages",
  id: "claude-x",
  baseUrl: "https://api.anthropic.com",
};
const PAYLOAD = {
  model: "claude-x",
  system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 512,
  stream: true,
};

describe("captureRequest — payload-only capture", () => {
  it("builds a CapturedRequest from the payload + live ctx + port identity, with no headers field", () => {
    const port = fakePort("inst-9");
    const captured = cacheTtl.captureRequest(PAYLOAD, ctxFor(MODEL), "s1", port, { tokens: 1234, source: "usage" });
    expect(captured).toMatchObject({
      sessionId: "s1",
      instance: "inst-9",
      payload: PAYLOAD,
      prefix: { tokens: 1234, source: "usage" },
      shape: { ephemeralBreakpoints: 1, ttl1h: false },
      fingerprint: {
        sessionId: "s1",
        provider: "anthropic",
        api: "anthropic-messages",
        ctxModelId: "claude-x",
        modelId: "claude-x",
      },
    });
    expect("headers" in captured).toBe(false);
    expect(typeof captured.capturedAt).toBe("number");
  });

  it("the old pairing helper is gone from the module surface", () => {
    expect("createRequestCapture" in cacheTtl).toBe(false);
  });

  it("authHeaderKeys is inert: always the empty string on a capture, so it can never differ from the service's tick-time side", () => {
    const captured = cacheTtl.captureRequest(PAYLOAD, ctxFor(MODEL), "s1", fakePort(), { tokens: 1, source: "usage" });
    expect(captured.fingerprint.authHeaderKeys).toBe("");
    const other = cacheTtl.captureRequest(
      PAYLOAD,
      ctxFor({ ...MODEL, headers: { "x-routing": "a" } }),
      "s1",
      fakePort(),
      {
        tokens: 1,
        source: "usage",
      },
    );
    expect(compareFingerprint(captured.fingerprint, other.fingerprint)).toBeUndefined();
  });

  it("a missing model degrades to empty route fields instead of throwing", () => {
    const captured = cacheTtl.captureRequest(PAYLOAD, ctxFor(undefined), "s1", fakePort(), {
      tokens: 0,
      source: "unknown",
    });
    expect(captured.fingerprint).toMatchObject({ provider: "", api: "", ctxModelId: "", baseUrl: "" });
  });
});
