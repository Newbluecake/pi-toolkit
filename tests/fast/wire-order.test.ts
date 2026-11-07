import { describe, expect, it, vi } from "vitest";
import { wireChildSession } from "../../src/child/wire.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import * as budget from "../../src/runtime/input-budget-registry.js";
import { fakePi, fakeCtx } from "../integration/helpers/schedule-activate.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("child keepalive → Fast → lazy budget → traffic order", () => {
  it.each([true, false])(
    "registry synchronous replay=%s and repeated registrations install one budget handler",
    async (replay) => {
      const registry = budget.createInputBudgetRegistry();
      const spy = vi.spyOn(budget, "getInputBudgetRegistry").mockReturnValue(registry);
      const f = fakePi();
      const c = fakeCtx("/tmp/fast-order-fixture");
      c.ctx.sessionManager.getBranch = () => [
        { type: "custom", customType: "subagent:fast", data: { v: 1, mode: "on" } },
      ];
      const measured = vi.fn();
      const abort = vi.fn();
      const entry = { maxInputTokens: 10000, bytesPerToken: 2 as const, onMeasure: measured, abort };
      let registration: ReturnType<typeof registry.register>;
      try {
        if (replay) registration = registry.register(c.ctx.sessionManager.getSessionId(), entry);
        wireChildSession(f.pi, { ...DEFAULT_SETTINGS, cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: true } });
        const early = f.handlers.get("before_provider_request")!.length;
        if (!replay) registration = registry.register(c.ctx.sessionManager.getSessionId(), entry);
        const after = f.handlers.get("before_provider_request")!.length;
        expect(early).toBe(replay ? 3 : 2);
        expect(after).toBe(3);
        registry.register("another-child", entry);
        expect(f.handlers.get("before_provider_request")).toHaveLength(3);
        let payload: unknown = { model: "physical", input: [], stream: true, store: false, service_tier: "flex" };
        const observed: unknown[] = [];
        for (const fn of f.handlers.get("before_provider_request")!) {
          const result = await fn({ type: "before_provider_request", payload }, c.ctx as unknown as ExtensionContext);
          if (result !== undefined) payload = result;
          observed.push(payload);
        }
        expect(observed[0]).toHaveProperty("service_tier", "flex"); // capture-only keepalive
        expect(observed[1]).toHaveProperty("service_tier", "priority");
        expect(observed[2]).toBe(observed[1]);
        expect(measured).toHaveBeenCalledWith(Buffer.byteLength(JSON.stringify(payload), "utf8"));
        expect(abort).not.toHaveBeenCalled();
      } finally {
        registration?.unregister();
        spy.mockRestore();
        for (const fn of f.handlers.get("session_shutdown") ?? []) await fn({ reason: "quit" }, c.ctx);
      }
    },
  );
});
