import { describe, expect, it } from "vitest";
import { parseLoadSettings } from "../../src/sysload/settings.js";
import { createLoadHintHook, createLoadHintState } from "../../src/sysload/hook.js";
import type { LoadPort, LoadVerdict } from "../../src/sysload/types.js";

const makeVerdict = (level: LoadVerdict["level"], gating: boolean): LoadVerdict => ({
  level,
  gating,
  metrics: { cpu: { level }, mem: { level: "ok" }, disk: [] },
  mono: 0,
  at: 0,
});

describe("sysload hint hook", () => {
  it("bypasses minIntervalMs on a failed recovery retry", () => {
    let now = 1;
    const state = createLoadHintState();
    state.hasSent = true;
    state.lastSentAt = 1;
    state.rejectedSinceRecovery = true;
    const sent: string[] = [];
    let fail = true;
    const verdict = makeVerdict("ok", false);
    let transitionSeen = false;
    const port: LoadPort = { verdict: () => verdict, top: () => undefined, refreshTop: () => undefined };
    const hook = createLoadHintHook({
      settings: parseLoadSettings({ hint: { minIntervalMs: 100 } }),
      port: () => port,
      state: () => state,
      transition: () => {
        if (transitionSeen) return undefined;
        transitionSeen = true;
        return { gateCleared: true, provenRecovered: true };
      },
      now: () => now,
      sendMessage: (message) => {
        if (fail) {
          fail = false;
          throw new Error("transient");
        }
        sent.push(message.content);
      },
    });
    hook({}, { mode: "interactive" } as never);
    expect(sent).toHaveLength(0);
    now = 10;
    hook({}, { mode: "interactive" } as never);
    expect(sent).toHaveLength(0);
    now = 120_000;
    hook({}, { mode: "interactive" } as never);
    expect(sent).toHaveLength(1);
  });

  it("sends at most one non-triggering message and retries failed sends", () => {
    let verdict = makeVerdict("crit", true);
    const sent: string[] = [];
    let fail = true;
    const state = createLoadHintState();
    const port: LoadPort = { verdict: () => verdict, top: () => undefined, refreshTop: () => undefined };
    const hook = createLoadHintHook({
      settings: parseLoadSettings({ sustainMs: 0 }),
      port: () => port,
      state: () => state,
      now: () => 1,
      sendMessage: (message, options) => {
        expect(options).toEqual({ triggerTurn: false });
        if (fail) {
          fail = false;
          throw new Error("transient");
        }
        sent.push(message.content);
      },
    });
    hook({}, { mode: "interactive" } as never);
    hook({}, { mode: "interactive" } as never);
    expect(sent).toHaveLength(1);
    verdict = makeVerdict("unknown", false);
    hook({}, { mode: "interactive" } as never);
    expect(sent).toHaveLength(1);
  });
});

describe("sysload hint hook — idle machine", () => {
  const run = (levels: LoadVerdict["level"][], top?: () => unknown) => {
    let i = 0;
    let now = 1;
    const sent: string[] = [];
    let refreshed = 0;
    const port: LoadPort = {
      verdict: () => makeVerdict(levels[Math.min(i, levels.length - 1)]!, false),
      top: (top ?? (() => undefined)) as LoadPort["top"],
      refreshTop: () => {
        refreshed++;
      },
    };
    const hook = createLoadHintHook({
      settings: parseLoadSettings({ gate: false }),
      port: () => port,
      now: () => now,
      sendMessage: (message) => sent.push(message.content),
    });
    for (; i < levels.length; i++) {
      hook({}, { mode: "interactive" } as never);
      now += 1_000_000;
    }
    return { sent, refreshed };
  };

  it("never announces an escalation for ok, including the first known sample after unknown", () => {
    expect(run(["unknown", "ok", "ok", "unknown", "ok"]).sent).toEqual([]);
    expect(run(["ok"]).sent).toEqual([]);
  });

  it("still announces warn and crit, with metric detail and a top refresh", () => {
    const { sent, refreshed } = run(["ok", "warn", "crit"]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("[load] warn · CPU");
    expect(sent[0]).toContain("系统负载偏高");
    expect(sent[1]).toContain("系统负载过高");
    expect(refreshed).toBe(2);
  });
});
