/**
 * `subagent:web-origin` entry + notify (plan §4.7/D12/D18/D27, §9.1 v2 addendum).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createOriginEntry,
  registerOriginEntryRenderer,
  WEB_ORIGIN_ENTRY_TYPE,
} from "../../../src/web-hub/agent/origin-entry.js";
import { fakeCtx, fakePi } from "./helpers.js";
import type { CmdOrigin } from "../../../src/web-hub/protocol/messages.js";

const LAN_ORIGIN: CmdOrigin = { listener: "lan", ip: "192.168.31.9", user: "admin", reqId: "3fa1c2d4e5f6a7b8" };
const LOOPBACK_ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "9b0e11aa22bb33cc" };

describe("createOriginEntry — appendOrigin (D12/U10: no body text, no IP)", () => {
  it("appends a subagent:web-origin entry with only whitelisted fields", () => {
    const { pi } = fakePi();
    const spy = vi.spyOn(pi, "appendEntry");
    const port = createOriginEntry(pi);
    port.appendOrigin("prompt", "cmd1", LAN_ORIGIN, "steer");
    expect(spy).toHaveBeenCalledWith(WEB_ORIGIN_ENTRY_TYPE, {
      v: 1,
      cmdId: "cmd1",
      reqId: LAN_ORIGIN.reqId,
      listener: "lan",
      user: "admin",
      op: "prompt",
      deliver: "steer",
    });
    const data = spy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(data)).not.toContain("192.168.31.9");
  });

  it("omits user/deliver when absent (token/loopback path)", () => {
    const { pi } = fakePi();
    const spy = vi.spyOn(pi, "appendEntry");
    const port = createOriginEntry(pi);
    port.appendOrigin("prompt", "cmd1", LOOPBACK_ORIGIN);
    const data = spy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(data.user).toBeUndefined();
    expect(data.deliver).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("127.0.0.1");
  });

  it("swallows appendEntry throwing (stale ctx) without propagating", () => {
    const { pi } = fakePi();
    pi.appendEntry = () => {
      throw new Error("stale");
    };
    const port = createOriginEntry(pi);
    expect(() => port.appendOrigin("prompt", "cmd1", LOOPBACK_ORIGIN)).not.toThrow();
  });
});

describe("createOriginEntry — notify (U6/D18)", () => {
  it("emits a compact 'web ▸ <op> · lan <user>@<ip> · #<reqId8>' line for a LAN origin", () => {
    const { pi } = fakePi();
    const port = createOriginEntry(pi);
    const { ctx, state } = fakeCtx({ mode: "tui" });
    port.notify(ctx, "stop subagent r_58XP", LAN_ORIGIN);
    expect(state.notifyCalls).toEqual([["web ▸ stop subagent r_58XP · lan admin@192.168.31.9 · #3fa1c2d4", undefined]]);
  });

  it("emits 'loopback <ip>' (no username) for a loopback/token origin", () => {
    const { pi } = fakePi();
    const port = createOriginEntry(pi);
    const { ctx, state } = fakeCtx({ mode: "tui" });
    port.notify(ctx, "/compact", LOOPBACK_ORIGIN);
    expect(state.notifyCalls).toEqual([["web ▸ /compact · loopback 127.0.0.1 · #9b0e11aa", undefined]]);
  });

  it("does not notify outside tui mode", () => {
    const { pi } = fakePi();
    const port = createOriginEntry(pi);
    const { ctx, state } = fakeCtx({ mode: "rpc" });
    port.notify(ctx, "abort", LOOPBACK_ORIGIN);
    expect(state.notifyCalls).toEqual([]);
  });

  it("does not notify when hasUI is false", () => {
    const { pi } = fakePi();
    const port = createOriginEntry(pi);
    const { ctx, state } = fakeCtx({ mode: "tui", hasUI: false });
    port.notify(ctx, "abort", LOOPBACK_ORIGIN);
    expect(state.notifyCalls).toEqual([]);
  });

  it("swallows ctx.ui.notify throwing", () => {
    const { pi } = fakePi();
    const port = createOriginEntry(pi);
    const { ctx } = fakeCtx({ mode: "tui" });
    (ctx.ui as { notify: () => void }).notify = () => {
      throw new Error("boom");
    };
    expect(() => port.notify(ctx, "abort", LOOPBACK_ORIGIN)).not.toThrow();
  });
});

describe("registerOriginEntryRenderer (D27/K23: must return a real pi-tui Component)", () => {
  it("registers a renderer under WEB_ORIGIN_ENTRY_TYPE whose return value has a render method", () => {
    const { pi } = fakePi();
    let captured: ((entry: unknown, options: unknown, theme: unknown) => unknown) | undefined;
    pi.registerEntryRenderer = ((_type: string, renderer: typeof captured) => {
      captured = renderer;
    }) as typeof pi.registerEntryRenderer;
    registerOriginEntryRenderer(pi);
    expect(captured).toBeDefined();
    const theme = { fg: (_color: string, text: string) => text };
    const component = captured!({ data: { listener: "lan", user: "admin", reqId: "3fa1c2d4e5f6a7b8" } }, {}, theme);
    expect(component).toBeDefined();
    expect(typeof (component as { render?: unknown }).render).toBe("function");
  });

  it("renders 'local' (not 'loopback') for a non-lan origin", () => {
    const { pi } = fakePi();
    let captured: ((entry: unknown, options: unknown, theme: unknown) => { toString?(): string }) | undefined;
    pi.registerEntryRenderer = ((_type: string, renderer: typeof captured) => {
      captured = renderer;
    }) as typeof pi.registerEntryRenderer;
    registerOriginEntryRenderer(pi);
    const theme = { fg: (_color: string, text: string) => text };
    const component = captured!({ data: { listener: "loopback", reqId: "9b0e11aa22bb33cc" } }, {}, theme) as {
      render(width: number): string[];
    };
    expect(component.render(80).join("\n").trim()).toBe("\u21b3 web \u00b7 local \u00b7 #9b0e11aa");
  });

  it("does nothing when pi.registerEntryRenderer is unavailable (older/minimal pi)", () => {
    const { pi } = fakePi();
    (pi as { registerEntryRenderer?: unknown }).registerEntryRenderer = undefined;
    expect(() => registerOriginEntryRenderer(pi)).not.toThrow();
  });
});
