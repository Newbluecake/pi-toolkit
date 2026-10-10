import { describe, expect, it } from "vitest";
import { createLoadHintHook, createLoadHintState } from "../../src/sysload/hook.js";
import type { LoadPort, LoadTransition, LoadVerdict } from "../../src/sysload/types.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";

function verdict(level: LoadVerdict["level"], gating: boolean): LoadVerdict {
  return {
    level,
    gating,
    metrics: { cpu: { level }, mem: { level }, disk: [] },
    mono: 100,
    at: 100,
  };
}

describe("load turn_end wiring", () => {
  it("sends escalation and recovery notices without triggering a turn", () => {
    const settings = {
      ...DEFAULT_SETTINGS.load,
      hint: { ...DEFAULT_SETTINGS.load.hint, minIntervalMs: 0, repeatMs: 1 },
    };
    let current = verdict("crit", true);
    let nextTransition: LoadTransition | undefined = { gateCleared: false, provenRecovered: false };
    const port: LoadPort = { verdict: () => current, top: () => undefined, refreshTop: () => undefined };
    const messages: Array<{ customType: string; content: string; display: boolean }> = [];
    const options: Array<{ triggerTurn: false }> = [];
    const hook = createLoadHintHook({
      settings,
      port: () => port,
      state: () => createLoadHintState(),
      transition: () => nextTransition,
      sendMessage: (message, sendOptions) => {
        messages.push(message);
        options.push(sendOptions);
      },
    });

    hook({}, { mode: "tui" } as never);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.customType).toBe("subagent:load");
    expect(messages[0]?.content).toContain("crit");
    expect(options[0]).toEqual({ triggerTurn: false });

    current = verdict("ok", false);
    nextTransition = { gateCleared: true, provenRecovered: true };
    hook({}, { mode: "tui" } as never);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain("ok");
  });
});
