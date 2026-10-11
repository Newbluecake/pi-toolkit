// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AVATAR_DELETE_PATH, AVATAR_PATH } from "../../../src/web-hub/protocol/avatar.js";
import { createTokenTransport } from "../../../src/web-hub/ui/src/transport/token.js";
import { createPasswordTransport } from "../../../src/web-hub/ui/src/transport/password.js";
import type { PasswordTransportDeps } from "../../../src/web-hub/ui/src/transport/password.js";
import type { TokenTransportDeps } from "../../../src/web-hub/ui/src/transport/token.js";
import type { HubTransport } from "../../../src/web-hub/ui/src/transport/types.js";

const png = readFileSync(new URL("../../fixtures/web-hub-avatar/chrome-canvas.png", import.meta.url));

class FakeEventSource {
  readyState = 1;
  addEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}

interface ResponseInit {
  readonly status: number;
  readonly body?: unknown;
  readonly etag?: string;
}

function response({ status, body = {}, etag }: ResponseInit): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === "ETag" ? (etag ?? null) : null) },
    async json() {
      return body;
    },
    async arrayBuffer() {
      return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
    },
  };
}

function deps(
  mode: "token" | "password",
  calls: Array<{ url: string; init: Record<string, unknown> }>,
  responses: ResponseInit[],
): TokenTransportDeps | PasswordTransportDeps {
  let index = 0;
  const common = {
    fetch: async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init: init ?? {} });
      const next = responses[Math.min(index++, responses.length - 1)] ?? { status: 200 };
      return response(next);
    },
    EventSource: FakeEventSource,
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState: () => {} },
    setTimeout,
    clearTimeout,
    now: Date.now,
    onMessage: () => {},
    onConn: () => {},
  };
  if (mode === "token") {
    return {
      ...common,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    } as TokenTransportDeps;
  }
  return {
    ...common,
    onAuthEvent: () => {},
    onUnauthenticated: () => {},
  } as PasswordTransportDeps;
}

function make(
  mode: "token" | "password",
  calls: Array<{ url: string; init: Record<string, unknown> }>,
  responses: ResponseInit[],
): HubTransport {
  return mode === "token"
    ? createTokenTransport(deps(mode, calls, responses) as TokenTransportDeps)
    : createPasswordTransport(deps(mode, calls, responses) as PasswordTransportDeps);
}

describe.each(["token", "password"] as const)("%s avatar transport contract", (mode) => {
  it("uses the same GET/ETag wire behavior and reuses a 304 body", async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const transport = make(mode, calls, [
      { status: 200, etag: '"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"' },
      { status: 304, etag: '"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"' },
    ]);
    const signal = new AbortController().signal;
    const first = await transport.avatar!.fetch({ signal });
    const second = await transport.avatar!.fetch({ signal });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(calls[0]?.url).toBe(AVATAR_PATH);
    expect(calls[0]?.init.method).toBe("GET");
    expect((calls[0]?.init.headers as Record<string, string>)["X-PWH"]).toBe("1");
    expect((calls[0]?.init.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();
    expect((calls[1]?.init.headers as Record<string, string>)["If-None-Match"]).toBe(
      '"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
    );
  });

  it("never replays an avatar POST after a failed response", async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const transport = make(mode, calls, [{ status: 401, body: { error: "E_AUTH" } }]);
    const result = await transport.avatar!.upload(new Uint8Array([1, 2, 3]));
    expect(result).toMatchObject({ ok: false, error: "E_AUTH", status: 401 });
    expect(calls.filter((call) => call.url === AVATAR_PATH)).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    expect((calls[0]?.init.headers as Record<string, string>)["X-PWH"]).toBe("1");
  });

  it("uses the fixed delete path and honors pre-abort without issuing GET", async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const transport = make(mode, calls, [{ status: 200, body: { avatar: { gen: 2 }, hub: { pid: 1, startedAt: 2 } } }]);
    const result = await transport.avatar!.remove();
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe(AVATAR_DELETE_PATH);
    expect(calls[0]?.init.method).toBe("POST");
    const before = calls.length;
    const aborted = await transport.avatar!.fetch({ signal: AbortSignal.abort() });
    expect(aborted).toMatchObject({ ok: false, error: "E_ABORT", status: 0 });
    expect(calls).toHaveLength(before);
  });
});
