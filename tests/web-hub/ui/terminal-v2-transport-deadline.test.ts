import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalTransportV2, type TerminalFetchV2 } from "../../../src/web-hub/ui/src/transport/terminal-v2.js";
import { hubV2, scopeV2, termV2, turnV2 } from "./terminal-v2-fixtures.js";

afterEach(() => vi.useRealTimers());

function viewRequest(fetch: TerminalFetchV2) {
  const onConn = vi.fn();
  const transport = createTerminalTransportV2({ fetch, onConn });
  const pending = transport.view({ scope: scopeV2, hubInstance: hubV2, termId: termV2 }, vi.fn());
  let settled = false;
  const observed = pending.then(
    () => {
      settled = true;
      return { kind: "resolved" } as const;
    },
    (error: unknown) => {
      settled = true;
      return { kind: "rejected", error } as const;
    },
  );
  return { observed, onConn, settled: () => settled };
}

describe("P4 F6 view error-body absolute deadline", () => {
  it("a hanging 503 JSON body settles at the original 5s boundary", async () => {
    vi.useFakeTimers();
    const response = {
      status: 503,
      ok: false,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: () => new Promise(() => {}),
    } as unknown as Response;
    const call = viewRequest(vi.fn(async () => response) as TerminalFetchV2);
    await turnV2();
    await vi.advanceTimersByTimeAsync(4999);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await call.observed;
    expect(result).toMatchObject({ kind: "rejected", error: { code: "E_DEADLINE", effect: "unknown" } });
  });

  it("headers after 4s leave only 1s for the error body, with no fresh 5s budget", async () => {
    vi.useFakeTimers();
    let headers!: () => void;
    const response = {
      status: 503,
      ok: false,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: () => new Promise(() => {}),
    } as unknown as Response;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          headers = () => resolve(response);
        }),
    );
    const call = viewRequest(fetch as TerminalFetchV2);
    await vi.advanceTimersByTimeAsync(4000);
    headers();
    await turnV2();
    await vi.advanceTimersByTimeAsync(999);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await call.observed).toMatchObject({ kind: "rejected", error: { code: "E_DEADLINE" } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("deadline cancels only the private error response reader and does not signal public auth/SSE", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => {});
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { status: 503, headers: { "Content-Type": "application/json" } });
    const call = viewRequest(vi.fn(async () => response) as TerminalFetchV2);
    await turnV2();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await call.observed).toMatchObject({ kind: "rejected", error: { code: "E_DEADLINE" } });
    expect(cancel).toHaveBeenCalled();
    expect(call.onConn).not.toHaveBeenCalled();
  });
});
