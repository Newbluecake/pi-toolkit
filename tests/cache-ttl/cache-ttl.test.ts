import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wireCacheTtl } from "../../src/cache-ttl/cache-ttl.js";
import { DEFAULT_SETTINGS, loadSettings, parseCacheTtlSettings } from "../../src/config/settings.js";
import type { KeepalivePort } from "../../src/service/cache-keepalive.js";

function setup(mode: "auto" | "on" | "off" = "auto", persist = vi.fn()) {
  const hooks = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, any>();
  const pi = {
    on: (name: string, handler: any) => hooks.set(name, handler),
    registerCommand: (name: string, value: any) => commands.set(name, value),
  } as unknown as ExtensionAPI;
  const notify = vi.fn();
  const status = vi.fn();
  const ctx = { ui: { notify, setStatus: status } } as unknown as ExtensionContext;
  wireCacheTtl(pi, { ...DEFAULT_SETTINGS, cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, mode } }, { persist });
  return { hooks, commands, ctx, notify, status, persist };
}

/** Minimal `KeepalivePort` double for the header/payload pairing tests below. */
function fakePort(overrides: Partial<Record<keyof KeepalivePort, unknown>> = {}): KeepalivePort {
  return {
    instanceId: "inst-1",
    noteRequest: vi.fn(),
    noteRequestSettled: vi.fn(),
    invalidate: vi.fn(),
    consumeUpgrade: vi.fn().mockReturnValue(false),
    report: vi.fn(),
    setEnabled: vi.fn(),
    syncModeState: vi.fn(),
    ...overrides,
  } as unknown as KeepalivePort;
}

function setupWithPort(mode: "auto" | "on" | "off" = "auto") {
  const hooks = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, any>();
  const pi = {
    on: (name: string, handler: any) => hooks.set(name, handler),
    registerCommand: (name: string, value: any) => commands.set(name, value),
  } as unknown as ExtensionAPI;
  const port = fakePort();
  const ctx = {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getSessionId: () => "s1" },
    model: { provider: "anthropic", api: "anthropic-messages", id: "claude-x", baseUrl: "https://api.anthropic.com" },
  } as unknown as ExtensionContext;
  wireCacheTtl(
    pi,
    { ...DEFAULT_SETTINGS, cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, mode } },
    { keepalive: () => port as any },
  );
  return { hooks, ctx, port };
}

function ephemeralPayload() {
  return {
    model: "claude-x",
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    max_tokens: 512,
    stream: true,
  };
}

describe("keepalive header/payload capture pairing (root-cause fix)", () => {
  it("pairs a payload capture with its matching headers snapshot and calls noteRequest exactly once", () => {
    const { hooks, ctx, port } = setupWithPort();
    hooks.get("before_provider_request")!({ payload: ephemeralPayload() }, ctx);
    expect(port.noteRequest).not.toHaveBeenCalled();
    hooks.get("before_provider_headers")!(
      {
        type: "before_provider_headers",
        headers: { "content-type": "application/json", "anthropic-beta": "real-beta" },
      },
      ctx,
    );
    expect(port.noteRequest).toHaveBeenCalledTimes(1);
    const captured = (port.noteRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(captured.headers).toEqual({ "content-type": "application/json", "anthropic-beta": "real-beta" });
  });

  it("filters out null-valued header deletions from the snapshot before pairing", () => {
    const { hooks, ctx, port } = setupWithPort();
    hooks.get("before_provider_request")!({ payload: ephemeralPayload() }, ctx);
    hooks.get("before_provider_headers")!(
      { type: "before_provider_headers", headers: { "content-type": "application/json", "x-deleted": null } },
      ctx,
    );
    const captured = (port.noteRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(captured.headers).toEqual({ "content-type": "application/json" });
    expect("x-deleted" in captured.headers).toBe(false);
  });

  it("payload-only half-capture: headers never arrive — never pings (noteRequest never called)", () => {
    const { hooks, ctx, port } = setupWithPort();
    hooks.get("before_provider_request")!({ payload: ephemeralPayload() }, ctx);
    // No before_provider_headers ever fires for this request.
    expect(port.noteRequest).not.toHaveBeenCalled();
  });

  it("headers-only half-capture: headers arrive with no matching pending payload — never pings", () => {
    const { hooks, ctx, port } = setupWithPort();
    // No before_provider_request preceded this — e.g. keepalive was off when the payload was captured.
    hooks.get("before_provider_headers")!(
      { type: "before_provider_headers", headers: { "content-type": "application/json" } },
      ctx,
    );
    expect(port.noteRequest).not.toHaveBeenCalled();
  });

  it("a second before_provider_request before headers arrive discards the first (never a stale cross-request pairing)", () => {
    const { hooks, ctx, port } = setupWithPort();
    hooks.get("before_provider_request")!({ payload: ephemeralPayload() }, ctx);
    // Second request starts before the first ever got its headers.
    hooks.get("before_provider_request")!({ payload: ephemeralPayload() }, ctx);
    hooks.get("before_provider_headers")!({ type: "before_provider_headers", headers: { "x-request": "second" } }, ctx);
    expect(port.noteRequest).toHaveBeenCalledTimes(1);
    const captured = (port.noteRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(captured.headers).toEqual({ "x-request": "second" });
  });

  it("a half-capture with keepalive disabled at request time never pairs even if re-enabled before headers arrive", () => {
    const hooks = new Map<string, (event: any, ctx: any) => unknown>();
    const pi = {
      on: (name: string, handler: any) => hooks.set(name, handler),
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    let port: KeepalivePort | undefined;
    const ctx = {
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      sessionManager: { getSessionId: () => "s1" },
      model: { provider: "anthropic", api: "anthropic-messages", id: "claude-x", baseUrl: "https://api.anthropic.com" },
    } as unknown as ExtensionContext;
    wireCacheTtl(
      pi,
      { ...DEFAULT_SETTINGS, cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, mode: "auto" } },
      { keepalive: () => port },
    );
    hooks.get("before_provider_request")!({ payload: ephemeralPayload() }, ctx); // port undefined here
    port = fakePort();
    hooks.get("before_provider_headers")!(
      { type: "before_provider_headers", headers: { "content-type": "application/json" } },
      ctx,
    );
    expect(port.noteRequest).not.toHaveBeenCalled();
  });
});

describe("cache TTL settings", () => {
  it("parses only whitelisted modes", () => {
    expect(parseCacheTtlSettings({ mode: "on", extra: true })).toEqual(expect.objectContaining({ mode: "on" }));
    expect(parseCacheTtlSettings({ mode: "adaptive" })).toEqual(expect.objectContaining({ mode: "adaptive" }));
    // adaptive plan §7.1: absent/invalid mode ⇒ flag-gated default (adaptiveEnabled defaults on)
    for (const input of [undefined, null, [], "on", { mode: "bad" }, { mode: 1 }])
      expect(parseCacheTtlSettings(input)).toEqual(expect.objectContaining({ mode: "adaptive" }));
    expect(parseCacheTtlSettings({ adaptiveEnabled: false })).toEqual(expect.objectContaining({ mode: "auto" }));
    expect(loadSettings({ cacheTtl: { mode: "off", extra: true } }).cacheTtl).toEqual(
      expect.objectContaining({ mode: "off" }),
    );
  });

  it("rewrites nested ephemeral controls without mutating the request", () => {
    const { hooks } = setup("on");
    const shared = { cache_control: { type: "ephemeral" } };
    const payload: any = { messages: [{ content: [{ ...shared, system: shared }] }], tools: [{ x: shared }] };
    const original = structuredClone(payload);
    const result: any = hooks.get("before_provider_request")!({ payload }, {});
    expect(result.messages[0].content[0].cache_control.ttl).toBe("1h");
    expect(result.messages[0].content[0].system.cache_control.ttl).toBe("1h");
    expect(result.tools[0].x.cache_control.ttl).toBe("1h");
    expect(payload).toEqual(original);
  });

  it("handles off, auto, malformed payloads, and cycles", () => {
    const off = setup("off");
    const cycle: any = { messages: [], nested: { cache_control: { type: "ephemeral", ttl: "1h" } } };
    cycle.nested.cycle = cycle;
    const result = off.hooks.get("before_provider_request")!({ payload: cycle }, {});
    expect((result as any).nested.cache_control.ttl).toBeUndefined();
    for (const payload of [undefined, null, [], "x", 1, { messages: "x" }])
      expect(off.hooks.get("before_provider_request")!({ payload }, {})).toBeUndefined();
    expect(setup("auto").hooks.get("before_provider_request")!({ payload: cycle }, {})).toBeUndefined();
  });

  it("leaves malformed cache_control variants untouched", () => {
    const { hooks } = setup("on");
    const payload: any = {
      messages: [
        { a: { cache_control: null }, b: { cache_control: [1] }, c: { cache_control: "x" } },
        { d: { cache_control: { type: "other" } }, e: { cache_control: { type: "ephemeral" } } },
      ],
    };
    const result: any = hooks.get("before_provider_request")!({ payload }, {});
    expect(result.messages[0].a.cache_control).toBeNull();
    expect(result.messages[0].b.cache_control).toEqual([1]);
    expect(result.messages[0].c.cache_control).toBe("x");
    expect(result.messages[1].d.cache_control).toEqual({ type: "other" });
    expect(result.messages[1].e.cache_control.ttl).toBe("1h");
  });

  it("returns undefined and warns when the payload cannot be cloned", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { hooks } = setup("on");
    const payload: any = { messages: [], fn: () => undefined };
    expect(hooks.get("before_provider_request")!({ payload }, {})).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("tracks the dirty matrix and status bar across switches and saves", async () => {
    const persist = vi.fn().mockReturnValue(undefined);
    const state = setup("on", persist);
    const cmd = state.commands.get("cache-ttl");
    await cmd.handler("off", state.ctx);
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", "cache 5m*");
    await cmd.handler("on", state.ctx); // 回到持久化值 → clean
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", "cache 1h");
    await cmd.handler("auto", state.ctx);
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", undefined);
    await cmd.handler("on", state.ctx); // auto → on：又回到持久化值 → clean
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", "cache 1h");
    await cmd.handler("save", state.ctx); // clean 时不落盘
    expect(persist).not.toHaveBeenCalled();
    expect(state.notify).toHaveBeenLastCalledWith("no unsaved changes", "info");
    await cmd.handler("off", state.ctx);
    await cmd.handler("save", state.ctx);
    expect(persist).toHaveBeenCalledWith("off");
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", "cache 5m"); // 保存后无 *
  });

  it("shows both runtime and persisted modes when dirty and warns on bad args", async () => {
    const state = setup("on");
    const cmd = state.commands.get("cache-ttl");
    await cmd.handler("off", state.ctx);
    await cmd.handler("", state.ctx);
    expect(state.notify).toHaveBeenLastCalledWith(expect.stringContaining("persisted mode"), "info");
    expect(state.notify.mock.calls.at(-1)![0]).toContain("save");
    await cmd.handler("bogus", state.ctx);
    expect(state.notify).toHaveBeenLastCalledWith(expect.stringContaining("invalid argument"), "warning");
  });

  it("keeps changes in memory until `/cache-ttl save` and retains dirty state on failure", async () => {
    const persist = vi.fn().mockReturnValue(undefined);
    const state = setup("on", persist);
    await state.commands.get("cache-ttl").handler("off", state.ctx);
    expect(persist).not.toHaveBeenCalled();
    await state.commands.get("cache-ttl").handler("save", state.ctx);
    expect(persist).toHaveBeenCalledWith("off");
    const failing = setup("on", vi.fn().mockReturnValue("disk full"));
    await failing.commands.get("cache-ttl").handler("off", failing.ctx);
    await failing.commands.get("cache-ttl").handler("save", failing.ctx);
    expect(failing.notify).toHaveBeenLastCalledWith(expect.stringContaining("disk full"), "error");
    await failing.commands.get("cache-ttl").handler("save", failing.ctx);
    expect(failing.persist).toHaveBeenCalledTimes(2);
  });
});
