// Pure-logic table-driven tests for the todo staleness nudge (L1 feature).
// No pi imports anywhere in src/todo/nudge.ts, so none are needed here either.

import { describe, expect, it } from "vitest";
import {
  buildHandoffAdvisory,
  buildNudgeText,
  COUNTER_CAP,
  DEFAULT_NUDGE_CONFIG,
  initNudgeState,
  isGitWriteCommand,
  recordEvidence,
  recordTodoTouch,
  tickTurn,
  type NudgeConfig,
  type NudgeState,
} from "../../src/todo/nudge.js";

const CONFIG: NudgeConfig = { graceTurns: 2, fallbackTurns: 20, cooldownTurns: 8 };

/** Drive N turn_end ticks in sequence, collecting each result. */
function tickN(state: NudgeState, config: NudgeConfig, hasInProgressTask: boolean, n: number) {
  const results: { state: NudgeState; fire: boolean }[] = [];
  let current = state;
  for (let i = 0; i < n; i++) {
    const result = tickTurn(current, config, hasInProgressTask);
    current = result.state;
    results.push(result);
  }
  return results;
}

describe("todo/nudge: evidence trigger (grace window)", () => {
  it("does not fire before graceTurns turns have elapsed since the first evidence", () => {
    const evidenced = recordEvidence(initNudgeState(CONFIG), "e1");
    const results = tickN(evidenced, CONFIG, true, CONFIG.graceTurns - 1);
    expect(results.every((r) => r.fire === false)).toBe(true);
  });

  it("fires exactly on the graceTurns-th tick after the first evidence", () => {
    const evidenced = recordEvidence(initNudgeState(CONFIG), "e1");
    const results = tickN(evidenced, CONFIG, true, CONFIG.graceTurns);
    expect(results.at(-1)?.fire).toBe(true);
    expect(results.slice(0, -1).every((r) => r.fire === false)).toBe(true);
  });

  it("anchors the grace window to the FIRST evidence, not the latest", () => {
    // Evidence at turn 0, then one tick, then MORE evidence arrives (e2) —
    // the age must keep counting from the first sighting, not restart.
    let state = recordEvidence(initNudgeState(CONFIG), "e1");
    const afterOneTick = tickTurn(state, CONFIG, true);
    expect(afterOneTick.fire).toBe(false);
    state = recordEvidence(afterOneTick.state, "e2");
    expect(state.e1).toBe(1);
    expect(state.e2).toBe(1);
    // Grace was already 1/2 elapsed before this new evidence; one more tick
    // (age 2) must still fire, not reset to age 1.
    const next = tickTurn(state, CONFIG, true);
    expect(next.fire).toBe(true);
  });

  it("evidence trigger requires at least one in_progress task", () => {
    const evidenced = recordEvidence(initNudgeState(CONFIG), "e1");
    const results = tickN(evidenced, CONFIG, false, CONFIG.graceTurns + 5);
    expect(results.every((r) => r.fire === false)).toBe(true);
  });
});

describe("todo/nudge: fallback trigger", () => {
  it("does not fire before fallbackTurns with zero evidence", () => {
    const results = tickN(initNudgeState(CONFIG), CONFIG, true, CONFIG.fallbackTurns - 1);
    expect(results.every((r) => r.fire === false)).toBe(true);
  });

  it("fires exactly on the fallbackTurns-th tick with zero evidence", () => {
    const results = tickN(initNudgeState(CONFIG), CONFIG, true, CONFIG.fallbackTurns);
    expect(results.at(-1)?.fire).toBe(true);
    expect(results.slice(0, -1).every((r) => r.fire === false)).toBe(true);
  });

  it("never fires under the fallback trigger with only pending tasks (no in_progress)", () => {
    const results = tickN(initNudgeState(CONFIG), CONFIG, false, CONFIG.fallbackTurns + 10);
    expect(results.every((r) => r.fire === false)).toBe(true);
  });

  it("evidence beats the fallback path: once evidence exists, fallback no longer applies", () => {
    // Zero-evidence run just short of fallback, then evidence arrives — the
    // NEXT trigger to fire must be the (shorter) evidence path, not fallback.
    let state = initNudgeState(CONFIG);
    for (let i = 0; i < 5; i++) state = tickTurn(state, CONFIG, true).state;
    state = recordEvidence(state, "e1");
    const results = tickN(state, CONFIG, true, CONFIG.graceTurns);
    expect(results.at(-1)?.fire).toBe(true);
    // e3 is 5 + graceTurns turns in, well short of fallbackTurns=20 — proves
    // this fire came from the evidence path.
    expect(results.at(-1)?.state.e3).toBeLessThan(CONFIG.fallbackTurns);
  });
});

describe("todo/nudge: cooldown and backoff", () => {
  function fireOnce(config: NudgeConfig = CONFIG) {
    const results = tickN(initNudgeState(config), config, true, config.fallbackTurns);
    return results.at(-1)!;
  }

  it("suppresses re-firing for cooldownTurns turns, then re-evaluates the still-true candidate", () => {
    const first = fireOnce();
    expect(first.fire).toBe(true);
    expect(first.state.cooldownTurnsLeft).toBe(CONFIG.cooldownTurns);

    // cooldownTurns silent ticks (the fallback candidate stays true the whole
    // time — no touch happened — but cooldown blocks it).
    const silent = tickN(first.state, CONFIG, true, CONFIG.cooldownTurns);
    expect(silent.every((r) => r.fire === false)).toBe(true);
    expect(silent.at(-1)?.state.cooldownTurnsLeft).toBe(0);

    // The very next tick (the 1st eligible one) fires again.
    const second = tickTurn(silent.at(-1)!.state, CONFIG, true);
    expect(second.fire).toBe(true);
  });

  it("doubles the cooldown length on each consecutive no-touch fire, capped at 4x the base", () => {
    const state = fireOnce().state;
    expect(state.cooldownLength).toBe(CONFIG.cooldownTurns); // 8
    const cap = CONFIG.cooldownTurns * 4; // 32

    const advanceThroughCooldown = (from: NudgeState) => {
      let current = from;
      let last = { state: current, fire: false };
      const maxIterations = from.cooldownTurnsLeft + 1;
      for (let i = 0; i < maxIterations; i++) {
        last = tickTurn(current, CONFIG, true);
        current = last.state;
        if (last.fire) break;
      }
      return last;
    };

    const second = advanceThroughCooldown(state);
    expect(second.fire).toBe(true);
    expect(second.state.cooldownLength).toBe(16);

    const third = advanceThroughCooldown(second.state);
    expect(third.fire).toBe(true);
    expect(third.state.cooldownLength).toBe(32);
    expect(third.state.cooldownLength).toBe(cap);

    // One more: must stay capped, not keep doubling to 64.
    const fourth = advanceThroughCooldown(third.state);
    expect(fourth.fire).toBe(true);
    expect(fourth.state.cooldownLength).toBe(cap);
  });

  it("a todo touch fully resets counters and the cooldown/backoff state", () => {
    const fired = fireOnce();
    expect(fired.state.noTouchStreak).toBe(1);
    const touched = recordTodoTouch(fired.state, CONFIG);
    expect(touched).toEqual(initNudgeState(CONFIG));
  });
});

describe("todo/nudge: Task* touch zeroes all counters", () => {
  it("recordTodoTouch zeroes e1/e2/e3 and evidence age regardless of prior accumulation", () => {
    let state = initNudgeState(CONFIG);
    state = recordEvidence(state, "e1");
    state = recordEvidence(state, "e2");
    state = tickTurn(state, CONFIG, true).state;
    state = tickTurn(state, CONFIG, true).state;
    expect(state.e1 + state.e2 + state.e3).toBeGreaterThan(0);
    const touched = recordTodoTouch(state, CONFIG);
    expect(touched.e1).toBe(0);
    expect(touched.e2).toBe(0);
    expect(touched.e3).toBe(0);
    expect(touched.evidenceAgeTurns).toBeNull();
    expect(touched.cooldownTurnsLeft).toBe(0);
  });
});

describe("todo/nudge: buildNudgeText", () => {
  it("omits a zero-count evidence clause", () => {
    const text = buildNudgeText({ e1: 0, e2: 1, e3: 6 }, [{ id: 1, subject: "Do the thing" }]);
    expect(text).not.toContain("完成");
    expect(text).toContain("1 次 git 提交");
    expect(text).toContain("已过 6 轮");
  });

  it("includes only non-zero clauses when several are zero", () => {
    const text = buildNudgeText({ e1: 0, e2: 0, e3: 20 }, [{ id: 1, subject: "x" }]);
    expect(text).not.toContain("git 提交");
    expect(text).not.toContain("agent/workflow");
    expect(text).toContain("已过 20 轮");
  });

  it("lists at most 5 in_progress tasks", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, subject: `Task ${i + 1}` }));
    const text = buildNudgeText({ e1: 1, e2: 0, e3: 3 }, tasks);
    for (let i = 1; i <= 5; i++) expect(text).toContain(`#${i} Task ${i}`);
    for (let i = 6; i <= 8; i++) expect(text).not.toContain(`#${i} Task ${i}`);
  });

  it("truncates a task title longer than 60 characters with an ellipsis", () => {
    const longTitle = "x".repeat(65);
    const text = buildNudgeText({ e1: 1, e2: 0, e3: 3 }, [{ id: 1, subject: longTitle }]);
    expect(text).toContain(`#1 ${"x".repeat(59)}…`);
    expect(text).not.toContain(`${"x".repeat(60)}…`);
    expect(text).not.toContain("x".repeat(61));
  });

  it("leaves a title of exactly 60 characters untouched", () => {
    const title = "x".repeat(60);
    const text = buildNudgeText({ e1: 1, e2: 0, e3: 3 }, [{ id: 1, subject: title }]);
    expect(text).toContain(`#1 ${title}。`);
  });
});

describe("todo/nudge: isGitWriteCommand", () => {
  it.each([
    "git commit -m 'x'",
    "git commit --amend",
    "git merge origin/main",
    "git cherry-pick abc123",
    "git rebase main",
    "git revert HEAD",
    "cd repo && git commit -am wip",
    "git -C repo commit -m x",
  ])("matches a git write command: %s", (command) => {
    expect(isGitWriteCommand(command)).toBe(true);
  });

  it.each(["git status", "git log --oneline", "git diff", "git push", "git show HEAD", "echo hello", "ls -la"])(
    "does not match a read/non-write command: %s",
    (command) => {
      expect(isGitWriteCommand(command)).toBe(false);
    },
  );
});

describe("todo/nudge: buildHandoffAdvisory (switch_context)", () => {
  it("returns undefined with no open tasks", () => {
    expect(buildHandoffAdvisory({ openTaskCount: 0, turnsSinceTouch: 100, hasEvidence: true })).toBeUndefined();
  });

  it("returns undefined with open tasks but neither evidence nor enough elapsed turns", () => {
    expect(buildHandoffAdvisory({ openTaskCount: 2, turnsSinceTouch: 3, hasEvidence: false })).toBeUndefined();
  });

  it("fires with open tasks and evidence, even with few elapsed turns", () => {
    const text = buildHandoffAdvisory({ openTaskCount: 2, turnsSinceTouch: 1, hasEvidence: true });
    expect(text).toContain("2 个未完成任务");
    expect(text).toContain("已 1 轮未更新");
  });

  it("fires with open tasks and >=10 elapsed turns even without evidence", () => {
    const text = buildHandoffAdvisory({ openTaskCount: 1, turnsSinceTouch: 10, hasEvidence: false });
    expect(text).toContain("1 个未完成任务");
  });

  it("does not fire at 9 elapsed turns without evidence (just under the threshold)", () => {
    expect(buildHandoffAdvisory({ openTaskCount: 1, turnsSinceTouch: 9, hasEvidence: false })).toBeUndefined();
  });
});

describe("todo/nudge: DEFAULT_NUDGE_CONFIG sanity", () => {
  it("matches the documented defaults (graceTurns=2, fallbackTurns=20, cooldownTurns=8)", () => {
    expect(DEFAULT_NUDGE_CONFIG).toEqual({ graceTurns: 2, fallbackTurns: 20, cooldownTurns: 8 });
  });
});

describe("counter saturation", () => {
  it("E1/E2/E3 and evidence age saturate at COUNTER_CAP", () => {
    let st: NudgeState = { ...initNudgeState(CONFIG), e1: COUNTER_CAP, e2: COUNTER_CAP, e3: COUNTER_CAP };
    st = recordEvidence(st, "e1");
    st = recordEvidence(st, "e2");
    st = { ...st, evidenceAgeTurns: COUNTER_CAP };
    st = tickTurn(st, CONFIG, false).state;
    expect(st.e1).toBe(COUNTER_CAP);
    expect(st.e2).toBe(COUNTER_CAP);
    expect(st.e3).toBe(COUNTER_CAP);
    expect(st.evidenceAgeTurns).toBe(COUNTER_CAP);
  });
});
