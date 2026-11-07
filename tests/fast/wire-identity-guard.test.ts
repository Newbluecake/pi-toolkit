import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { wireFastMain } from "../../src/fast/wire.js";

/**
 * Host capability absence (sessionManager missing, or missing getSessionId/getSessionFile) must
 * degrade Fast to inert — never crash the session open via `identity()`. A real host (all three
 * methods present) keeps the original identity semantics.
 */

function api() {
  type Handler = (event: never, ctx: ExtensionCommandContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
      };
    }),
    registerCommand: vi.fn((name: string, def: typeof commands extends Map<string, infer V> ? V : never) =>
      commands.set(name, def),
    ),
    appendEntry: vi.fn(),
    events: { on: () => () => undefined },
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    commands,
    append: pi.appendEntry,
    emit(event: string, data: unknown, ctx: ExtensionCommandContext) {
      let value = data;
      for (const h of handlers.get(event) ?? []) {
        const r = h({ type: event, payload: value } as never, ctx);
        if (r !== undefined) value = r;
      }
      return value;
    },
  };
}

function mkCtx(sessionManager: unknown) {
  const ui = { notify: vi.fn(), setStatus: vi.fn() };
  const ctx = { sessionManager, ui } as unknown as ExtensionCommandContext;
  return { ctx, ui };
}

const rec = (mode: string) => ({ type: "custom", customType: "subagent:fast", data: { v: 1, mode } });
const body = { model: "route-physical", store: false, stream: true, input: [], service_tier: "flex" };

describe("Fast host-identity capability guard", () => {
  it.each([
    ["missing getSessionId", { getSessionFile: () => undefined, getBranch: () => [rec("on")] }],
    ["missing getSessionFile", { getSessionId: () => "same-id", getBranch: () => [rec("on")] }],
    ["sessionManager undefined", undefined],
  ])("open does not throw and Fast stays inert when %s", async (_name, sessionManager) => {
    const f = api();
    const { ctx } = mkCtx(sessionManager);
    const wire = wireFastMain(f.pi, true)!;

    const ports = wire.open(ctx); // must not throw, even with a valid on-branch
    expect(ports.workflow.capture()).toBeUndefined();
    expect(ports.parent.snapshot("child-run")).toBeUndefined();

    await f.commands.get("fast")!.handler("on", ctx);
    expect(f.append).not.toHaveBeenCalled();
    expect(f.emit("before_provider_request", body, ctx)).toBe(body);
    ports.dispose();
  });

  it("a getter that throws is a real failure, not capability absence: open propagates it", () => {
    const f = api();
    const { ctx } = mkCtx({
      getSessionId: () => {
        throw new Error("stale ctx getter");
      },
      getSessionFile: () => undefined,
      getBranch: () => [rec("on")],
    });
    const wire = wireFastMain(f.pi, true)!;
    expect(() => wire.open(ctx)).toThrow("stale ctx getter");
  });

  it("a real host keeps the original identity semantics after a degraded open", () => {
    const f = api();
    const wire = wireFastMain(f.pi, true)!;
    const degraded = mkCtx(undefined);
    expect(wire.open(degraded.ctx).workflow.capture()).toBeUndefined();

    const ok = mkCtx({ getSessionId: () => "id", getSessionFile: () => undefined, getBranch: () => [rec("off")] });
    const ports = wire.open(ok.ctx);
    expect(ports.workflow.capture()).toEqual({ v: 1, mode: "off" });
    ports.dispose();
  });
});
