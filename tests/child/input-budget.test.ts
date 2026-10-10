import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { wireChildSession } from "../../src/child/wire.js";
import { getInputBudgetRegistry } from "../../src/runtime/input-budget-registry.js";
import type { AgentSettings } from "../../src/config/settings.js";

describe("child input-budget provider measurer", () => {
  function setup() {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        const current = handlers.get(event) ?? [];
        current.push(handler);
        handlers.set(event, current);
      },
    };
    wireChildSession(
      pi as any,
      { cacheTtl: { keepalive: false }, compact: { enabled: false } } as unknown as AgentSettings,
    );
    return { handlers, registry: getInputBudgetRegistry() };
  }

  it("does nothing for an unregistered session", () => {
    const { handlers, registry } = setup();
    const onMeasure = vi.fn();
    const abort = vi.fn();
    const registration = registry.register(randomUUID(), {
      maxInputTokens: 2,
      bytesPerToken: 2,
      onMeasure,
      abort,
    })!;
    const handler = handlers.get("before_provider_request")?.[0];
    expect(handler).toBeDefined();
    handler!({ payload: { prompt: "hello" } }, { sessionManager: { getSessionId: () => randomUUID() } });
    expect(onMeasure).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    registration.unregister();
  });

  it("installs one handler for N registrations and no-ops for unrelated sessions", () => {
    const { handlers, registry } = setup();
    const sessionId = randomUUID();
    const unrelatedSessionId = randomUUID();
    const order: string[] = [];
    const registration = registry.register(sessionId, {
      maxInputTokens: 2,
      bytesPerToken: 2,
      onMeasure: (bytes) => {
        order.push(`measure:${bytes}`);
      },
      abort: (reason) => {
        order.push(`abort:${reason}`);
      },
    })!;
    const unrelated = registry.register(unrelatedSessionId, {
      maxInputTokens: 2,
      bytesPerToken: 2,
      onMeasure: () => order.push("unrelated-measure"),
      abort: () => order.push("unrelated-abort"),
    })!;
    expect(handlers.get("before_provider_request")).toHaveLength(1);
    const handler = handlers.get("before_provider_request")![0]!;
    const payload = { prompt: "12345" };
    handler({ payload }, { sessionManager: { getSessionId: () => sessionId } });
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(order[0]).toBe(`measure:${bytes}`);
    expect(order[1]).toContain("abort:input-budget:");
    handler({ payload }, { sessionManager: { getSessionId: () => randomUUID() } });
    expect(order).not.toContain("unrelated-measure");
    expect(order).not.toContain("unrelated-abort");
    registration.unregister();
    unrelated.unregister();
  });
});
