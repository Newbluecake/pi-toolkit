import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalTransport } from "../../../src/web-hub/ui/src/transport/terminal.js";
const body = {
  agentKey: "agent",
  expect: { sessionId: "session", epoch: "epoch" },
  clientId: "client",
  connectionInstance: "instance",
  connectionToken: "private-token",
};
afterEach(() => vi.useRealTimers());
describe("terminal POST transport (§4.2/§4.4)", () => {
  it("uses only JSON POST + existing same-origin cookie/X-PWH; no credentials in URL and no retry", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, revision: 1, rows: [] })));
    const transport = createTerminalTransport({ fetch, onConn: vi.fn() });
    expect(await transport.request("list", body)).toEqual({ ok: true, revision: 1, rows: [] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/terminal/list");
    const init = (fetch.mock.calls[0] as any)[1];
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers["X-PWH"]).toBe("1");
    expect(JSON.parse(init.body)).toEqual(body);
  });
  it("401 invalidates the current login without silent replaying a terminal operation", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    const onConn = vi.fn();
    expect(await createTerminalTransport({ fetch, onConn }).request("list", body)).toEqual({
      ok: false,
      code: "E_AUTH",
      effect: "none",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onConn).toHaveBeenCalledWith("auth");
  });
  it("has a hard deadline covering a stalled JSON body, not just fetch response headers", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ({ status: 200, json: () => new Promise(() => {}) }));
    const result = createTerminalTransport({ fetch, onConn: vi.fn() }).request("list", body);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual({ ok: false, code: "E_DEADLINE", effect: "unknown" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("bounds the actual streamed body before JSON and handles caller cancellation promptly", async () => {
    const huge = createTerminalTransport({ fetch: async () => new Response("x".repeat(16385)), onConn: vi.fn() });
    expect((await huge.request("list", body)).ok).toBe(false);
    const abort = new AbortController();
    const pending = createTerminalTransport({ fetch: () => new Promise(() => {}), onConn: vi.fn() }).request(
      "list",
      body,
      abort.signal,
    );
    abort.abort();
    expect(await pending).toEqual({ ok: false, code: "E_DEADLINE", effect: "unknown" });
  });
});
