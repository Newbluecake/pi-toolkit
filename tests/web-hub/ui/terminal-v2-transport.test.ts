import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalViewFrameV2 } from "../../../src/web-hub/ui/src/components/terminal/protocol-v2.js";
import { createTerminalTransportV2, type TerminalFetchV2 } from "../../../src/web-hub/ui/src/transport/terminal-v2.js";
import { attachedFrameV2, hubV2, requestV2, scopeV2, termV2, viewV2 } from "./terminal-v2-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

function transportWith(response: Response | (() => Promise<Response>)) {
  const fetch = vi.fn(async () => (typeof response === "function" ? response() : response));
  const onConn = vi.fn();
  return {
    fetch,
    onConn,
    transport: createTerminalTransportV2({ fetch: fetch as TerminalFetchV2, onConn }),
  };
}

function ndjson(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status,
      headers: {
        "Content-Type": status === 200 ? "application/x-ndjson" : "application/json",
        "Content-Encoding": "identity",
      },
    },
  );
}

describe("terminal v2 JSON transport", () => {
  it("uses frozen routes, same-origin cookie/X-PWH and no implicit retry", async () => {
    const { transport, fetch } = transportWith(Response.json({ ok: true, acceptedThrough: 4 }));
    const body = {
      scope: scopeV2,
      hubInstance: hubV2,
      termId: termV2,
      viewId: viewV2,
      seq: 4,
      queryOnly: true,
    } as const;
    expect(await transport.request("input", body)).toEqual({ ok: true, acceptedThrough: 4 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/terminal/v2/input");
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toEqual({ "Content-Type": "application/json", "X-PWH": "1" });
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sent).toEqual(body);
    expect("bytesB64" in sent).toBe(false);
    expect("kind" in sent).toBe(false);
  });

  it("reports 401 to the existing auth state without replaying", async () => {
    const { transport, fetch, onConn } = transportWith(Response.json({}, { status: 401 }));
    expect(await transport.request("creation", { scope: scopeV2, hubInstance: hubV2, requestId: requestV2 })).toEqual({
      ok: false,
      code: "E_AUTH",
      effect: "none",
    });
    expect(onConn).toHaveBeenCalledWith("auth");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps cancellation/body deadline effect unknown rather than claiming none", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ({ status: 200, json: () => new Promise<unknown>(() => {}) }) as Response);
    const pending = createTerminalTransportV2({ fetch: fetch as TerminalFetchV2, onConn: vi.fn() }).request("list", {
      scope: scopeV2,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ ok: false, code: "E_DEADLINE", effect: "unknown" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects the forbidden E_INPUT_UNKNOWN + none response pair", async () => {
    const { transport } = transportWith(Response.json({ ok: false, code: "E_INPUT_UNKNOWN", effect: "none" }));
    expect(
      await transport.request("input", {
        scope: scopeV2,
        hubInstance: hubV2,
        termId: termV2,
        viewId: viewV2,
        seq: 0,
        queryOnly: true,
      }),
    ).toEqual({ ok: false, code: "E_UNAVAILABLE", effect: "unknown" });
  });

  it("rejects non-canonical outgoing input without issuing fetch", async () => {
    const { transport, fetch } = transportWith(Response.json({ ok: true, acceptedThrough: 0 }));
    expect(
      await transport.request("input", {
        scope: scopeV2,
        hubInstance: hubV2,
        termId: termV2,
        viewId: viewV2,
        seq: 0,
        bytesB64: "YR==",
        kind: "user",
      }),
    ).toEqual({ ok: false, code: "E_BAD_REQUEST", effect: "none" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("terminal v2 independent NDJSON transport", () => {
  it("decodes split UTF-8 lines and yields validated frames in FIFO order", async () => {
    const attached = attachedFrameV2();
    if (attached.t === "attached" && attached.metadata) attached.metadata.cwd = "/工作";
    const bytes = new TextEncoder().encode(`${JSON.stringify(attached)}\n{"t":"ping"}\n`);
    const split = bytes.findIndex((byte) => byte >= 0x80);
    const first = bytes.slice(0, split > 0 ? split + 1 : 7);
    const second = bytes.slice(first.byteLength);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          controller.enqueue(second);
          controller.close();
        },
      }),
      { headers: { "Content-Type": "application/x-ndjson", "Content-Encoding": "identity" } },
    );
    const { transport, fetch } = transportWith(response);
    const frames: TerminalViewFrameV2[] = [];
    await transport.view({ scope: scopeV2, hubInstance: hubV2, termId: termV2 }, (frame) => frames.push(frame));
    expect(frames).toEqual([attached, { t: "ping" }]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/terminal/v2/view");
  });

  it("fails closed on an oversized incomplete line and cancels only its own reader", async () => {
    const cancel = vi.fn(async () => {});
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(24_577)));
        },
        cancel,
      }),
      { headers: { "Content-Type": "application/x-ndjson", "Content-Encoding": "identity" } },
    );
    const { transport } = transportWith(response);
    await expect(transport.view({ scope: scopeV2, hubInstance: hubV2, termId: termV2 }, vi.fn())).rejects.toMatchObject(
      { code: "E_UNAVAILABLE", effect: "unknown" },
    );
    expect(cancel).toHaveBeenCalled();
  });

  it("does not accept gzip, a JSON success, or malformed stream errors as a view", async () => {
    for (const response of [
      Response.json({ ok: true }),
      ndjson(['{"t":"output","offset":0,"bytesB64":"YR=="}\n']),
      ndjson(['{"t":"error","code":"NEW_CODE"}\n']),
    ]) {
      const { transport } = transportWith(response);
      await expect(
        transport.view({ scope: scopeV2, hubInstance: hubV2, termId: termV2 }, vi.fn()),
      ).rejects.toMatchObject({ effect: "unknown" });
    }
    const gzip = ndjson(['{"t":"ping"}\n']);
    gzip.headers.set("Content-Encoding", "gzip");
    const { transport } = transportWith(gzip);
    await expect(transport.view({ scope: scopeV2, hubInstance: hubV2, termId: termV2 }, vi.fn())).rejects.toMatchObject(
      { code: "E_UNAVAILABLE" },
    );
  });

  it("maps a pre-header 401 to auth and never starts a frame loop", async () => {
    const { transport, onConn } = transportWith(
      Response.json({ ok: false, code: "E_AUTH", effect: "none" }, { status: 401 }),
    );
    const onFrame = vi.fn();
    await expect(transport.view({ scope: scopeV2, hubInstance: hubV2, termId: termV2 }, onFrame)).rejects.toMatchObject(
      { code: "E_AUTH", effect: "none" },
    );
    expect(onConn).toHaveBeenCalledWith("auth");
    expect(onFrame).not.toHaveBeenCalled();
  });
});
