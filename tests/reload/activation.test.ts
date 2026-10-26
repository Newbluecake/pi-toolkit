import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import activate from "../../src/index.js";
import * as reloadWiring from "../../src/reload/index.js";
import { consumeReloadContinue, writeReloadContinue } from "../../src/reload/continue.js";
import { BASELINE, emit, fakeCtx, fakePi, resetGlobals, sandbox } from "../integration/helpers/schedule-activate.js";

const KEY = Symbol.for("pi-subagent:reload-continue");

afterEach(() => {
  vi.restoreAllMocks();
  resetGlobals();
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

describe("reload activation assembly", () => {
  it("defer off preserves the frozen tool/command tables and ALL handler counts", () => {
    const sb = sandbox("pi-reload-off-");
    resetGlobals();
    try {
      sb.writeSettings({ ...BASELINE, reload: { defer: false } });
      const h = fakePi();
      activate(h.pi);
      const golden = JSON.parse(readFileSync(new URL("../fixtures/schedule-off-golden.json", import.meta.url), "utf8"));
      expect(h.toolOrder).toEqual(golden.surface.tools);
      expect(h.commandOrder).toEqual(golden.surface.commands);
      expect(Object.fromEntries([...h.handlers].map(([name, handlers]) => [name, handlers.length]))).toEqual(
        golden.surface.handlerCounts,
      );
      expect(h.sent.filter(({ message }) => message.customType?.startsWith("subagent:reload-"))).toEqual([]);
    } finally {
      sb.cleanup();
    }
  });

  it("real main-session Agent/resume/workflow tools read the late-bound pending dependency", async () => {
    const sb = sandbox("pi-reload-admission-");
    resetGlobals();
    const original = reloadWiring.wireDeferredReload;
    let controller: ReturnType<typeof original> | undefined;
    vi.spyOn(reloadWiring, "wireDeferredReload").mockImplementation((pi, deps) => {
      controller = original(pi, deps);
      controller.arm(1);
      return controller;
    });
    try {
      sb.writeSettings({ ...BASELINE, reload: { defer: false }, workflow: { enabled: true } });
      const h = fakePi();
      activate(h.pi);
      // Deliberately no stack/session_start: a mistakenly unwired gate would reach requireStack and throw.
      for (const [name, params] of [
        ["Agent", { description: "new", prompt: "work", subagent_type: "general-purpose" }],
        ["Agent", { description: "resume", prompt: "work", subagent_type: "general-purpose", resume: "r_OLD" }],
        ["SubagentWorkflow", { script: "export const meta={name:'x'}; return 1;" }],
      ] as const) {
        const result = await h.tools.get(name).execute("tc", params, undefined, undefined, {});
        expect(result.isError).toBe(true);
        expect(result.details.error.code).toBe("E_RELOAD_PENDING");
      }
      controller!.disarm();
      // The same registered tool reads the new state, then reaches the real unwired-stack error.
      await expect(
        h.tools
          .get("Agent")
          .execute(
            "tc",
            { description: "new", prompt: "work", subagent_type: "general-purpose" },
            undefined,
            undefined,
            {},
          ),
      ).rejects.toThrow("no active session");
      await emit(h, "session_shutdown", { reason: "quit" }, fakeCtx(sb.home).ctx);
    } finally {
      sb.cleanup();
    }
  });

  it("child activation does not wire reload or consume the main-session handoff", async () => {
    const sb = sandbox("pi-reload-child-");
    resetGlobals();
    try {
      sb.writeSettings(BASELINE);
      const main = fakePi();
      activate(main.pi);
      const ctx = fakeCtx(sb.home).ctx;
      writeReloadContinue(ctx);
      const child = fakePi();
      activate(child.pi); // HOST_KEY belongs to main; child remains inert post-guard.
      await emit(child, "session_start", { reason: "reload" }, ctx);
      expect(child.commands.has("agent")).toBe(false);
      expect(child.tools.has("Agent")).toBe(false);
      expect(child.tools.has("SubagentWorkflow")).toBe(false);
      expect(child.sent.some(({ message }) => message.customType === "subagent:reload-continue")).toBe(false);
      expect(consumeReloadContinue(ctx, "reload")).toBe(true);
      await emit(main, "session_shutdown", { reason: "quit" }, ctx);
    } finally {
      sb.cleanup();
    }
  });
});
