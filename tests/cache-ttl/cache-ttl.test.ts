import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createInitialSessionTotals, createInitialWindowState } from "../../src/cache-ttl/keepalive-state.js";
import { wireCacheTtl, legacyCapNote } from "../../src/cache-ttl/cache-ttl.js";
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
  const wiring = wireCacheTtl(
    pi,
    { ...DEFAULT_SETTINGS, cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, mode } },
    { persist },
  );
  return { hooks, commands, ctx, notify, status, persist, wiring };
}

/** Minimal `KeepalivePort` double for the header/payload pairing tests below. */
function fakePort(overrides: Partial<Record<keyof KeepalivePort, unknown>> = {}): KeepalivePort {
  return {
    instanceId: "inst-1",
    noteRequest: vi.fn(),
    noteRequestSettled: vi.fn(),
    invalidate: vi.fn(),
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
    for (const input of [undefined, null, [], "on", { mode: "bad" }, { mode: 1 }])
      expect(parseCacheTtlSettings(input)).toEqual(expect.objectContaining({ mode: "auto" }));
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

  it("wiring.status() follows mode/dirty across on/off/auto/save", async () => {
    const persist = vi.fn().mockReturnValue(undefined);
    const state = setup("on", persist);
    const cmd = state.commands.get("cache-ttl");
    expect(state.wiring.status()).toEqual({ mode: "on", dirty: false });
    await cmd.handler("off", state.ctx);
    expect(state.wiring.status()).toEqual({ mode: "off", dirty: true });
    await cmd.handler("auto", state.ctx);
    expect(state.wiring.status()).toEqual({ mode: "auto", dirty: true });
    await cmd.handler("off", state.ctx);
    await cmd.handler("save", state.ctx);
    expect(state.wiring.status()).toEqual({ mode: "off", dirty: false });
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

describe("/cache-ttl getArgumentCompletions", () => {
  it("returns all subcommands for an empty prefix and filters by prefix", () => {
    const state = setup("on");
    const cmd = state.commands.get("cache-ttl");
    expect(
      cmd
        .getArgumentCompletions("")!
        .map((i: any) => i.value)
        .sort(),
    ).toEqual(["auto", "keepalive", "off", "on", "probe", "save", "status"]);
    expect(cmd.getArgumentCompletions("ad")!.map((i: any) => i.value)).toEqual([]);
  });

  it("second level: keepalive on/off", () => {
    const state = setup("on");
    const cmd = state.commands.get("cache-ttl");
    expect(
      cmd
        .getArgumentCompletions("keepalive ")!
        .map((i: any) => i.value)
        .sort(),
    ).toEqual(["keepalive off", "keepalive on", "keepalive reset"]);
    expect(
      cmd
        .getArgumentCompletions("keepalive o")!
        .map((i: any) => i.value)
        .sort(),
    ).toEqual(["keepalive off", "keepalive on"]);
  });

  it("unknown prefix returns empty and never throws", () => {
    const state = setup("on");
    const cmd = state.commands.get("cache-ttl");
    expect(cmd.getArgumentCompletions("bogus")).toEqual([]);
    expect(cmd.getArgumentCompletions("keepalive bogus")).toEqual([]);
    expect(() => cmd.getArgumentCompletions(null as unknown as string)).not.toThrow();
  });
});

describe("/cache-ttl keepalive reset", () => {
  function run(resetResult: unknown, hasPort = true) {
    const commands = new Map<string, any>();
    const pi = { on: vi.fn(), registerCommand: (n: string, v: any) => commands.set(n, v) } as unknown as ExtensionAPI;
    const port = fakePort({ resetBreakers: vi.fn(() => resetResult) });
    wireCacheTtl(pi, DEFAULT_SETTINGS, { keepalive: () => (hasPort ? (port as any) : undefined) });
    const notify = vi.fn();
    return { notify, port, go: () => commands.get("cache-ttl").handler("keepalive reset", { ui: { notify } }) };
  }

  it("reports what was cleared, with the economic warning when proven-write was cleared", async () => {
    const t = run({ sessionDisabled: "proven-write", openLines: 2, economicCleared: true, evidenceCleared: true });
    await t.go();
    const text = t.notify.mock.calls[0]![0] as string;
    expect(text).toContain("keepalive reset: cleared session-disabled(proven-write) · 2 line breaker(s)");
    expect(text).toContain("counters zeroed");
    expect(text).toContain("evidence(no-cache-value, current line only)");
    expect(text).toContain("resumes on next real request");
    expect(text).toContain("注意：已手动清除经济类熔断");
  });

  it("no economic warning for line-only resets; 'nothing to clear' and unavailable paths", async () => {
    const a = run({ sessionDisabled: undefined, openLines: 1, economicCleared: false, evidenceCleared: false });
    await a.go();
    expect(a.notify.mock.calls[0]![0]).not.toContain("注意");
    const b = run({ sessionDisabled: undefined, openLines: 0, economicCleared: false, evidenceCleared: false });
    await b.go();
    expect(b.notify.mock.calls[0]![0]).toBe("keepalive reset: nothing to clear (no breaker open)");
    const c = run({}, false);
    await c.go();
    expect(c.notify.mock.calls[0]![0]).toContain("keepalive service unavailable");
    expect(c.notify.mock.calls[0]![1]).toBe("warning");
  });
});

describe("legacy cap status note only (R2-5)", () => {
  it.each([{ keepaliveMaxPings: 5 }, { keepaliveMaxPings: 0 }, { keepaliveMaxPings: "x" }, {}])(
    "shows presence/value only on status, with unavailable service (%j)",
    async (raw) => {
      const cfg = parseCacheTtlSettings({ keepalive: false, ...raw });
      const hooks = new Map<string, any>();
      const commands = new Map<string, any>();
      const pi = {
        on: (name: string, fn: any) => hooks.set(name, fn),
        registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
      } as unknown as ExtensionAPI;
      const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
      wireCacheTtl(pi, { ...DEFAULT_SETTINGS, cacheTtl: cfg });
      await hooks.get("session_start")({}, ctx);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      await commands.get("cache-ttl").handler("status", ctx);
      const text = vi.mocked(ctx.ui.notify).mock.calls[0]![0];
      expect(text).toContain("service unavailable");
      if ("keepaliveMaxPings" in raw) {
        expect(text).toContain(
          'note: cacheTtl.keepaliveMaxPings is deprecated and ignored — the per-window cap now comes from the model\'s cache prices; use "cacheTtl.keepalive": false to turn keepalive off, and remove the old key',
        );
        expect(text).toContain(
          `legacy value: ${typeof raw.keepaliveMaxPings === "number" ? raw.keepaliveMaxPings : "(invalid)"}`,
        );
      } else {
        expect(text).not.toContain("deprecated");
        expect(legacyCapNote(cfg)).toBeUndefined();
      }
    },
  );
});

describe("legacy cap note with a live report", () => {
  it("appends the identical note AFTER the cap report and never notifies on startup", async () => {
    const hooks = new Map<string, any>();
    const commands = new Map<string, any>();
    const pi = {
      on: (name: string, fn: any) => hooks.set(name, fn),
      registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
    } as unknown as ExtensionAPI;
    const cfg = parseCacheTtlSettings({ keepalive: true, keepaliveMaxPings: 0 });
    const port = fakePort({
      report: () => ({
        enabled: true,
        armed: false,
        config: { enabled: true, intervalMs: 240_000, maxPings: 48, maxPingsSource: "priced", minPrefixTokens: 20_000 },
        window: createInitialWindowState(),
        session: createInitialSessionTotals(),
        costUsd: undefined,
        dropped: { sessionMismatch: 0, instanceMismatch: 0, epochMismatch: 0 },
        lastSkip: undefined,
        prefixSource: undefined,
        supportsLongCacheRetention: true,
        lastPingDiagnostics: undefined,
      }),
    });
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
    wireCacheTtl(pi, { ...DEFAULT_SETTINGS, cacheTtl: cfg }, { keepalive: () => port as any });
    await hooks.get("session_start")({}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    await commands.get("cache-ttl").handler("status", ctx);
    const text = vi.mocked(ctx.ui.notify).mock.calls[0]![0];
    expect(text).toContain("cap: 48/window (priced)");
    expect(text.indexOf("note: ")).toBeGreaterThan(text.indexOf("cap:"));
    expect(text).toContain(legacyCapNote(cfg));
    expect(text).toContain("legacy value: 0");
  });
});

describe("r_FFWC8SBT — main-session real usage forwarding", () => {
  it.each(["message_end", "turn_end"])("%s forwards this response's FULL input (not ledger/prefix/output)", (event) => {
    const { hooks, ctx, port } = setupWithPort();
    const message = {
      role: "assistant",
      provider: "anthropic",
      model: "claude-x",
      stopReason: "stop",
      usage: { input: 25_000, cacheRead: 30_000, cacheWrite: 17, output: 9_000_000 },
    };
    // Deliberately contradictory prior ledger data must never be used by this forwarding hook.
    Object.assign(ctx.sessionManager, {
      getEntries: () => [
        { type: "message", message: { role: "assistant", usage: { input: 1, cacheRead: 2, cacheWrite: 3 } } },
      ],
    });
    hooks.get(event)!({ message }, ctx);
    expect(port.noteRequestSettled).toHaveBeenCalledTimes(1);
    expect(port.noteRequestSettled).toHaveBeenCalledWith(
      "s1",
      "inst-1",
      true,
      { provider: "anthropic", modelId: "claude-x" },
      55_017,
    );
  });
  it.each(["message_end", "turn_end"])("%s does not invent full input from partial usage", (event) => {
    const { hooks, ctx, port } = setupWithPort();
    hooks.get(event)!(
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-x",
          usage: { cacheRead: 30_000, cacheWrite: 0 },
        },
      },
      ctx,
    );
    expect(port.noteRequestSettled).toHaveBeenCalledTimes(1);
    expect(port.noteRequestSettled).toHaveBeenCalledWith(
      "s1",
      "inst-1",
      true,
      { provider: "anthropic", modelId: "claude-x" },
      undefined,
    );
  });
});
