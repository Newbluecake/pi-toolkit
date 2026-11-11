import { afterEach, describe, expect, it, vi } from "vitest";
import activate from "../../src/index.js";
import { DEFAULT_SETTINGS, loadSettings, TIME_SETTING_MS_PATHS } from "../../src/config/settings.js";
import { isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";
import { BASELINE, emit, fakeCtx, fakePi, resetGlobals, sandbox } from "./helpers/schedule-activate.js";

afterEach(() => resetGlobals());

describe("retired objective-loop session entries", () => {
  it("ignores legacy settings without disturbing live settings", () => {
    const legacy = {
      enabled: true,
      maxTurns: 7,
      maxMinutes: 30,
      budgetTokens: 100,
      budgetCostUsd: 2,
      verifierType: "verifier",
      verifierModelHint: "old/model",
      evalTimeoutS: 2,
      untilCmdTimeoutS: 3,
      deliveryWatchdogS: 4,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const goal of [legacy, null, "malformed", [], 7]) {
        expect(loadSettings({ concurrencyLimit: 7, goal })).toEqual(loadSettings({ concurrencyLimit: 7 }));
      }
      expect(Object.keys(DEFAULT_SETTINGS)).not.toContain("goal");
      expect(Object.keys(SETTING_SPECS).filter((key) => key.startsWith("goal."))).toEqual([]);
      expect(TIME_SETTING_MS_PATHS.filter((key) => key.startsWith("goal."))).toEqual([]);
      for (const key of Object.keys(legacy)) expect(isKnownSettingKey(`goal.${key}`)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["startup", "resume", "fork", "reload", "new"] as const)(
    "%s skips active, malformed and unreadable legacy entries without restoring an owner",
    async (reason) => {
      const box = sandbox("retired-goal-");
      resetGlobals();
      try {
        box.writeSettings({
          ...BASELINE,
          fast: { enabled: false },
          quota: { enabled: false },
          reload: { defer: false },
        });
        const host = fakePi();
        const continuations: string[] = [];
        host.pi.sendUserMessage = (text) => void continuations.push(text);
        const appended: string[] = [];
        host.pi.appendEntry = (customType) => void appended.push(customType);
        activate(host.pi);
        expect(host.commandOrder).not.toContain("goal");
        expect(host.commandOrder).toContain("agent");
        const env = fakeCtx(box.home, { mode: "tui" });
        env.ctx.hasUI = true;
        const payloadRead = vi.fn(() => {
          throw new Error("retired payload must not be read");
        });
        const branch = [
          { type: "custom", customType: "subagent:goal", data: { v: 1, state: "active", objective: "old" } },
          { type: "custom", customType: "subagent:goal", data: "malformed" },
          {
            type: "custom",
            customType: "subagent:goal",
            get data() {
              return payloadRead();
            },
          },
        ];
        env.ctx.sessionManager.getBranch = () => branch;
        env.ctx.sessionManager.getEntries = () => branch;
        await emit(host, "session_start", { type: "session_start", reason }, env.ctx);
        await emit(host, "agent_end", { type: "agent_end", messages: [] }, env.ctx);
        await emit(host, "agent_settled", { type: "agent_settled" }, env.ctx);
        await emit(host, "session_shutdown", { type: "session_shutdown", reason: "quit" }, env.ctx);
        expect(payloadRead).not.toHaveBeenCalled();
        expect(continuations).toEqual([]);
        expect(appended).not.toContain("subagent:goal");
        expect(env.statuses.some(([key]) => key === "goal")).toBe(false);
        expect(env.notices.some((text) => text.includes("/goal"))).toBe(false);
      } finally {
        resetGlobals();
        box.cleanup();
      }
    },
  );
});
