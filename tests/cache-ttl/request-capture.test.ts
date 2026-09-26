/**
 * Direct unit tests for `createRequestCapture()` (src/cache-ttl/cache-ttl.ts, plan.md §2.4
 * "capture helper 抽取"). `tests/cache-ttl/cache-ttl.test.ts` already exercises this helper
 * INDIRECTLY through `wireCacheTtl`'s `before_provider_request`/`before_provider_headers`
 * hooks; these tests call it directly to pin down its own contract in isolation — port
 * switching (a caller re-creating the capture after a stack rebuild), a headers-only
 * half-capture, non-string header values, and the consume-once guarantee.
 */
import { describe, expect, it, vi } from "vitest";
import { createRequestCapture, type CapturedRequestBase } from "../../src/cache-ttl/cache-ttl.js";
import type { KeepalivePort } from "../../src/service/cache-keepalive.js";

function fakePort(instanceId = "inst-1"): KeepalivePort {
  return {
    instanceId,
    noteRequest: vi.fn(),
    noteRequestSettled: vi.fn(),
    invalidate: vi.fn(),
    consumeUpgrade: vi.fn().mockReturnValue(false),
    report: vi.fn(),
  } as unknown as KeepalivePort;
}

function base(overrides: Partial<CapturedRequestBase> = {}): CapturedRequestBase {
  return {
    sessionId: "s1",
    instance: "inst-1",
    payload: { model: "m", messages: [], max_tokens: 1, stream: true },
    fingerprint: {
      sessionId: "s1",
      provider: "anthropic",
      api: "anthropic-messages",
      modelId: "m",
      ctxModelId: "m",
      baseUrl: "https://api.anthropic.com",
      authHeaderKeys: "",
      breakpointPath: "",
      thinkingDigest: "",
      systemDigest: "",
      toolsDigest: "",
      messageCount: 0,
    },
    shape: { ephemeralBreakpoints: 0, ttl1h: false, hasThinking: false, maxTokens: 1 },
    prefix: { tokens: 1000, source: "usage" },
    capturedAt: 0,
    ...overrides,
  };
}

describe("createRequestCapture — port identity", () => {
  it("noteRequest is forwarded to the port instance createRequestCapture was BUILT with, not whatever's live later", () => {
    const port = fakePort();
    const capture = createRequestCapture(port);
    capture.stage(base());
    capture.consumeHeaders({ "content-type": "application/json" });
    expect(port.noteRequest).toHaveBeenCalledTimes(1);
  });

  it("a caller re-creating the RequestCapture (e.g. after a stack rebuild swaps the keepalive port) gets a fresh, independent pairing slot — no cross-instance bleed", () => {
    const portA = fakePort("inst-a");
    const portB = fakePort("inst-b");
    const captureA = createRequestCapture(portA);
    captureA.stage(base({ instance: "inst-a" }));
    // Simulate a rebuild: a brand new RequestCapture bound to the new port, before A's
    // headers ever arrived. A's stage is simply abandoned (a genuinely separate closure) —
    // it must never leak into B's pairing.
    const captureB = createRequestCapture(portB);
    captureB.stage(base({ instance: "inst-b" }));
    captureB.consumeHeaders({ "content-type": "application/json" });

    expect(portB.noteRequest).toHaveBeenCalledTimes(1);
    const captured = (portB.noteRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(captured.instance).toBe("inst-b");
    expect(portA.noteRequest).not.toHaveBeenCalled();

    // A's own (still-live, independent) slot is untouched by B's consumeHeaders call.
    captureA.consumeHeaders({ "content-type": "application/json" });
    expect(portA.noteRequest).toHaveBeenCalledTimes(1);
  });
});

describe("createRequestCapture — half-capture and consume-once", () => {
  it("consumeHeaders with no prior stage() is a no-op — never pings on a headers-only half-capture", () => {
    const port = fakePort();
    const capture = createRequestCapture(port);
    capture.consumeHeaders({ "content-type": "application/json" });
    expect(port.noteRequest).not.toHaveBeenCalled();
  });

  it("clear() discards a staged capture — the next consumeHeaders() is a no-op", () => {
    const port = fakePort();
    const capture = createRequestCapture(port);
    capture.stage(base());
    capture.clear();
    capture.consumeHeaders({ "content-type": "application/json" });
    expect(port.noteRequest).not.toHaveBeenCalled();
  });

  it("consumeHeaders always consumes exactly once — a second call after a successful pairing is a no-op", () => {
    const port = fakePort();
    const capture = createRequestCapture(port);
    capture.stage(base());
    capture.consumeHeaders({ "content-type": "application/json" });
    expect(port.noteRequest).toHaveBeenCalledTimes(1);

    capture.consumeHeaders({ "content-type": "application/json" }); // nothing staged anymore
    expect(port.noteRequest).toHaveBeenCalledTimes(1);
  });

  it("a second stage() before headers arrive replaces (discards) the first — only the second is ever paired", () => {
    const port = fakePort();
    const capture = createRequestCapture(port);
    capture.stage(base({ capturedAt: 1 }));
    capture.stage(base({ capturedAt: 2 }));
    capture.consumeHeaders({ "content-type": "application/json" });
    expect(port.noteRequest).toHaveBeenCalledTimes(1);
    const captured = (port.noteRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(captured.capturedAt).toBe(2);
  });
});

describe("createRequestCapture — header snapshot sanitization", () => {
  it("non-string header values are dropped from the snapshot; string values pass through verbatim", () => {
    const port = fakePort();
    const capture = createRequestCapture(port);
    capture.stage(base());
    capture.consumeHeaders({
      "content-type": "application/json",
      "x-null": null,
      "x-number": 42,
      "x-bool": true,
      "x-array": ["a"],
      "x-object": { nested: true },
      "x-undefined": undefined,
    });
    expect(port.noteRequest).toHaveBeenCalledTimes(1);
    const captured = (port.noteRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(captured.headers).toEqual({ "content-type": "application/json" });
  });

  it("non-object headers (e.g. a string, or undefined) never pair — the staged capture is still consumed (dropped), never left dangling", () => {
    const port = fakePort();
    const capture = createRequestCapture(port);
    capture.stage(base());
    capture.consumeHeaders("not an object");
    expect(port.noteRequest).not.toHaveBeenCalled();

    // The slot was consumed (read-and-cleared) even though pairing failed — a LATER,
    // unrelated consumeHeaders call must not resurrect this stale stage.
    capture.consumeHeaders({ "content-type": "application/json" });
    expect(port.noteRequest).not.toHaveBeenCalled();
  });

  it("an empty headers object still pairs (noteRequest called with an empty snapshot)", () => {
    const port = fakePort();
    const capture = createRequestCapture(port);
    capture.stage(base());
    capture.consumeHeaders({});
    expect(port.noteRequest).toHaveBeenCalledTimes(1);
    const captured = (port.noteRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(captured.headers).toEqual({});
  });
});
