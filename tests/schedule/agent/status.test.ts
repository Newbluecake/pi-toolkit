import { afterEach, describe, expect, it } from "vitest";
import { createScheduleStatus, nextLabel, renderStatus } from "../../../src/schedule/agent/status.js";
import { createTask } from "../../../src/schedule/agent/ops.js";
import { emptyStateFile, type ScheduleStateFile } from "../../../src/schedule/core/spec.js";
import { approve, makeTask, SID, utc } from "../core/fixtures.js";
import { a3Env, basicRaw, type A3Env } from "./a3-helpers.js";

let env: A3Env;
afterEach(() => env?.cleanup());

const NOW = utc("2026-01-01T00:00:30Z"); // 08:00:30 in Asia/Shanghai
function stateWith(tasks: ReturnType<typeof makeTask>[]): ScheduleStateFile {
  const s = emptyStateFile(SID);
  s.tasks = tasks;
  return s;
}
const daily = (over = {}) =>
  approve(makeTask({ when: { kind: "cron", expr: "30 9 * * *", tz: "Asia/Shanghai" }, ...over }));

describe("renderStatus", () => {
  it("clears (undefined) with no tasks", () => {
    expect(renderStatus({ state: undefined, now: NOW, busy: false, capability: "verified" })).toBeUndefined();
    expect(renderStatus({ state: stateWith([]), now: NOW, busy: false, capability: "verified" })).toBeUndefined();
  });
  it("count + next (same local day ⇒ HH:mm, otherwise MM-DD HH:mm), English tokens only", () => {
    const s = stateWith([daily()]);
    expect(renderStatus({ state: s, now: NOW, busy: false, capability: "verified" })).toBe("sched 1 · next 09:30");
    const tomorrow = stateWith([daily({ when: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" } })]);
    expect(nextLabel(tomorrow, NOW)).toBe("01-02 07:00");
    expect(renderStatus({ state: s, now: NOW, busy: false, capability: "verified" })).not.toMatch(/[\u4e00-\u9fff]/);
  });
  it("earliest next wins across tasks; paused / pending tasks do not arm; pending counted", () => {
    const s = stateWith([
      daily(),
      daily({ when: { kind: "cron", expr: "15 9 * * *", tz: "Asia/Shanghai" } }),
      daily({ enabled: false, when: { kind: "cron", expr: "5 9 * * *", tz: "Asia/Shanghai" } }),
      makeTask({ when: { kind: "cron", expr: "1 9 * * *", tz: "Asia/Shanghai" } }), // never approved
    ]);
    expect(renderStatus({ state: s, now: NOW, busy: false, capability: "verified" })).toBe(
      "sched 4 · next 09:15 · pending 1",
    );
  });
  it("run count, busy, and capability markers", () => {
    const s = stateWith([daily({ form: "message" })]);
    s.runs.push({
      runKey: `${s.tasks[0]!.id}@1`,
      taskId: s.tasks[0]!.id,
      kind: "auto",
      form: "message",
      scheduledAt: 1,
      defHash: "x",
      state: "queued",
      holder: { pid: 1, start: 1, host: "h", boot: "b", epoch: "e" },
      startedAt: 1,
      note: "none",
    });
    expect(renderStatus({ state: s, now: NOW, busy: true, capability: "absent" })).toBe(
      "sched 1 · next 09:30 · run 1 · busy · msg off",
    );
    expect(renderStatus({ state: s, now: NOW, busy: false, capability: "unknown" })).toBe(
      "sched 1 · next 09:30 · run 1 · msg ?",
    );
  });
});

describe("controller", () => {
  it("sets only on change, clears with no tasks, re-renders on its unref'd timer, and clears on dispose", async () => {
    env = a3Env();
    const sets: Array<string | undefined> = [];
    const ctl = createScheduleStatus({
      agent: () => env.agent,
      setStatus: (t) => void sets.push(t),
      capability: () => "verified",
      clock: env.fake,
    });
    ctl.start();
    expect(sets).toEqual([]); // nothing to show ⇒ never touches the bar
    await createTask(env.ports, basicRaw(), { by: "agent", via: "tool" });
    ctl.refresh();
    ctl.refresh();
    expect(sets).toHaveLength(1);
    expect(sets[0]).toBe("sched 1 · pending 1"); // pending tasks never arm ⇒ no `next`
    env.fake.advance(15_100); // timer tick: nothing changed ⇒ no new call
    expect(sets).toHaveLength(1);
    ctl.dispose();
    expect(sets.at(-1)).toBeUndefined();
    expect(sets).toHaveLength(2);
    ctl.refresh(); // disposed ⇒ inert
    expect(sets).toHaveLength(2);
  });
  it("a throwing setStatus (stale ctx) is swallowed; print mode shows nothing", async () => {
    env = a3Env({}, "print");
    const ctl = createScheduleStatus({
      agent: () => env.agent,
      setStatus: () => {
        throw new Error("stale");
      },
      capability: () => "verified",
      clock: env.fake,
    });
    expect(() => ctl.start()).not.toThrow();
    ctl.dispose();
  });
});
