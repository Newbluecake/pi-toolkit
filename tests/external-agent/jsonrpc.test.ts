import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { classifiedInfo, ClassifiedError } from "../../src/core/errors.js";
import { createJsonRpcClient } from "../../src/external-agent/jsonrpc.js";
import type { Envelope, JsonRpcClientOptions, RequestReply } from "../../src/external-agent/types.js";

const envelope: Envelope = {
  decorate: (m) => ({ ...m, ver: "1.0" }),
  check: (m) =>
    m.ver === undefined || m.ver === "1.0"
      ? { ok: true }
      : { ok: false, drift: { expected: "1.0", actual: String(m.ver) } },
};

function setup(over: Partial<JsonRpcClientOptions> = {}) {
  const clock = new FakeClock();
  const written: Array<Record<string, unknown>> = [];
  const notifications: Array<[string, unknown]> = [];
  const errors: ClassifiedError[] = [];
  const drifts: Array<{ expected: string; actual: string }> = [];
  const opts: JsonRpcClientOptions = {
    envelope,
    write: (line) => {
      expect(line.endsWith("\n")).toBe(true);
      written.push(JSON.parse(line) as Record<string, unknown>);
      return true;
    },
    onNotification: (m, p) => notifications.push([m, p]),
    onRequest: () => ({ result: null }),
    onDrift: (d) => drifts.push(d),
    onProtocolError: (e) => errors.push(e),
    clock,
    ...over,
  };
  const client = createJsonRpcClient(opts);
  return { client, clock, written, notifications, errors, drifts };
}
const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("jsonrpc client", () => {
  it("decorates requests, uses monotonic string ids, resolves by id", async () => {
    const s = setup();
    const p1 = s.client.request("a.b", { x: 1 }, 1000);
    const p2 = s.client.request("c.d", undefined, 1000);
    expect(s.written.map((w) => w.id)).toEqual(["1", "2"]);
    expect(s.written[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "a.b",
      params: { x: 1 },
      ver: "1.0",
    });
    s.client.feed(line({ id: "2", result: "two" }) + line({ id: "1", result: { ok: true } }));
    await expect(p1).resolves.toEqual({ ok: true });
    await expect(p2).resolves.toBe("two");
  });

  it("error response rejects with internal ClassifiedError carrying code", async () => {
    const s = setup();
    const p = s.client.request("m", {}, 1000);
    s.client.feed(line({ id: "1", error: { code: -32602, message: "Unknown model" } }));
    const e = await p.catch((x: unknown) => x);
    expect(classifiedInfo(e)?.kind).toBe("internal");
    expect(classifiedInfo(e)?.message).toContain("Unknown model");
    expect((e as { rpcCode?: number }).rpcCode).toBe(-32602);
  });

  it("timeout rejects internal, clears the table; late response is counted, not delivered", async () => {
    const s = setup();
    const p = s.client.request("slow", {}, 500);
    const caught = p.catch((x: unknown) => x);
    s.clock.advance(499);
    expect(s.clock.pendingTimers).toBe(1);
    s.clock.advance(1);
    const e = await caught;
    expect(classifiedInfo(e)?.kind).toBe("internal");
    expect(classifiedInfo(e)?.message).toContain("timed out");
    expect(s.clock.pendingTimers).toBe(0);
    s.client.feed(line({ id: "1", result: 1 }));
    expect(s.client.stats().lateResponses).toBe(1);
    expect(s.errors).toEqual([]);
  });

  it("a response clears its timer", async () => {
    const s = setup();
    const p = s.client.request("m", {}, 500);
    s.client.feed(line({ id: "1", result: 0 }));
    await p;
    expect(s.clock.pendingTimers).toBe(0);
  });

  it("notifications are dispatched; frames split across chunks (incl. multibyte)", () => {
    const s = setup();
    const full = Buffer.from(line({ method: "n", params: { t: "héllo✓" } }));
    for (let i = 0; i < full.length; i += 3) s.client.feed(full.subarray(i, i + 3));
    expect(s.notifications).toEqual([["n", { t: "héllo✓" }]]);
    s.client.feed(line({ method: "a" }) + line({ method: "b" }));
    expect(s.notifications.map((n) => n[0])).toEqual(["n", "a", "b"]);
    s.client.feed('{"method":"c"}\r\n');
    expect(s.notifications.map((n) => n[0])).toEqual(["n", "a", "b", "c"]);
  });

  it("id:null error (-32700) ⇒ fatal internal protocol error, pending rejected", async () => {
    const s = setup();
    const p = s.client.request("m", {}, 1000);
    const caught = p.catch((x: unknown) => x);
    s.client.feed(line({ id: null, error: { code: -32700, message: "Invalid JSON-RPC message" } }));
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]?.info.kind).toBe("internal");
    expect(classifiedInfo(await caught)?.kind).toBe("internal");
    // after fatal: further input ignored, new requests fail fast
    s.client.feed(line({ method: "n" }));
    expect(s.notifications).toEqual([]);
    await expect(s.client.request("x", {}, 100)).rejects.toBeInstanceOf(ClassifiedError);
    expect(s.errors).toHaveLength(1);
  });

  it("reverse request: synchronous reply written with the request id; error replies pass through", () => {
    const seen: Array<[string, string, unknown]> = [];
    const s = setup({
      onRequest: (m, id, p): RequestReply => {
        seen.push([m, id, p]);
        return m === "ok" ? { result: { selected: "x" } } : { error: { code: -32601, message: "not supported" } };
      },
    });
    s.client.feed(line({ type: "request", id: "r1", method: "ok", params: { a: 1 } }));
    s.client.feed(line({ id: 7, method: "nope" }));
    expect(seen).toEqual([
      ["ok", "r1", { a: 1 }],
      ["nope", "7", undefined],
    ]);
    expect(s.written[0]).toMatchObject({ id: "r1", result: { selected: "x" }, ver: "1.0" });
    // provider-specific envelope fields (droid's `type`) are the envelope's job, never the framework's
    expect(s.written.every((w) => !("type" in w))).toBe(true);
    expect(s.written[1]).toMatchObject({ id: 7, error: { code: -32601 } });
    expect(s.errors).toEqual([]);
  });

  it("onRequest throwing ⇒ -32603 reply AND fatal onProtocolError", () => {
    const s = setup({
      onRequest: () => {
        throw new Error("handler bug");
      },
    });
    s.client.feed(line({ id: "r1", method: "x" }));
    expect(s.written).toHaveLength(1);
    expect(s.written[0]).toMatchObject({ id: "r1", error: { code: -32603 } });
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]?.info.message).toContain("handler bug");
  });

  it("reply write throwing ⇒ onProtocolError", () => {
    const s = setup({
      write: () => {
        throw new ClassifiedError({ kind: "internal", message: "EPIPE", retryable: false });
      },
    });
    s.client.feed(line({ id: "r1", method: "x" }));
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]?.info.message).toContain("EPIPE");
  });

  it("request write throwing (EPIPE) ⇒ rejects immediately, table + timer cleaned", async () => {
    const s = setup({
      write: () => {
        throw new ClassifiedError({ kind: "internal", message: "stdin closed", retryable: false });
      },
    });
    await expect(s.client.request("m", {}, 1000)).rejects.toThrow("stdin closed");
    expect(s.clock.pendingTimers).toBe(0);
  });

  it("oversized line (no newline yet, and with newline) ⇒ fatal", () => {
    const a = setup({ maxLineBytes: 64 });
    a.client.feed("x".repeat(40));
    expect(a.errors).toHaveLength(0);
    a.client.feed("y".repeat(40));
    expect(a.errors).toHaveLength(1);
    expect(a.errors[0]?.info.kind).toBe("internal");
    const b = setup({ maxLineBytes: 64 });
    b.client.feed("z".repeat(100) + "\n");
    expect(b.errors).toHaveLength(1);
    // a line within the limit is fine
    const c = setup({ maxLineBytes: 64 });
    c.client.feed(line({ method: "ok" }));
    expect(c.errors).toHaveLength(0);
    expect(c.notifications).toHaveLength(1);
  });

  it("non-JSON lines: ignored+counted; 20 consecutive ⇒ fatal; a JSON line resets the streak", () => {
    const s = setup();
    for (let i = 0; i < 19; i++) s.client.feed("garbage\n");
    s.client.feed(line({ method: "ok" }));
    for (let i = 0; i < 19; i++) s.client.feed("garbage\n");
    expect(s.errors).toHaveLength(0);
    expect(s.client.stats().nonJsonLines).toBe(38);
    s.client.feed("garbage\n");
    expect(s.errors).toHaveLength(1);
    expect(s.notifications).toHaveLength(1);
  });

  it("non-JSON lines: 200 cumulative (interleaved) ⇒ fatal", () => {
    const s = setup();
    for (let i = 0; i < 199; i++) {
      s.client.feed("junk\n");
      if (i % 10 === 9) s.client.feed(line({ method: "ok" }));
    }
    expect(s.errors).toHaveLength(0);
    s.client.feed("junk\n");
    expect(s.errors).toHaveLength(1);
  });

  it("drift: envelope.check failures report once per distinct pair, never fatal", () => {
    const s = setup();
    s.client.feed(
      line({ method: "n", ver: "2.0" }) + line({ method: "n", ver: "2.0" }) + line({ method: "n", ver: "3.0" }),
    );
    expect(s.drifts).toEqual([
      { expected: "1.0", actual: "2.0" },
      { expected: "1.0", actual: "3.0" },
    ]);
    expect(s.notifications).toHaveLength(3);
    expect(s.errors).toEqual([]);
  });

  it("failAll rejects pending, clears timers, and later requests reject with the same error", async () => {
    const s = setup();
    const p = s.client.request("m", {}, 1000);
    const caught = p.catch((x: unknown) => x);
    const err = new ClassifiedError({ kind: "internal", message: "droid exited (code 1)", retryable: false });
    s.client.failAll(err);
    expect(await caught).toBe(err);
    expect(s.clock.pendingTimers).toBe(0);
    await expect(s.client.request("m2", {}, 1000)).rejects.toBe(err);
    expect(s.written).toHaveLength(1);
  });

  it("a throwing notification handler is fatal (reported, not swallowed)", () => {
    const s = setup({
      onNotification: () => {
        throw new Error("boom");
      },
    });
    s.client.feed(line({ method: "n" }));
    expect(s.errors).toHaveLength(1);
  });

  it("onProtocolError throwing does not break the client", () => {
    const fn = vi.fn(() => {
      throw new Error("x");
    });
    const s = setup({ onProtocolError: fn });
    s.client.feed("x".repeat(10) + "\n");
    s.client.feed(line({ id: null, error: { code: -32700, message: "m" } }));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
