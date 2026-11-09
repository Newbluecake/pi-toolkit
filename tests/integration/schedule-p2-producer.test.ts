/** P2 production entry → real single-file writer / strict validation / legacy reader. */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createScheduleTool } from "../../src/tools/schedule-tool.js";
import { createTask, updateTask, setTaskEnabled, deleteTask } from "../../src/schedule/agent/ops.js";
import { catchUpText, whenText } from "../../src/schedule/agent/view.js";
import { reconcileEvery } from "../../src/schedule/core/interval.js";
import { nextEvery, parseCron } from "../../src/schedule/core/cron.js";
import { defHash } from "../../src/schedule/core/spec.js";
import { finishRun, housekeeping } from "../../src/schedule/core/writer.js";
import { createScheduleHubRouter } from "../../src/schedule/agent/coordinator.js";
import { validateStateFile, readSessionStateById } from "../schedule/compat/v1-reader.js";
import { a3Env, basicRaw, T0, type A3Env } from "../schedule/agent/a3-helpers.js";
const A = Date.parse("2026-11-09T10:07:23Z"),
  D = 5_400_000;
const AI = { by: "agent", via: "tool" } as const;
let e: A3Env | undefined;
afterEach(() => {
  e?.cleanup();
  e = undefined;
});
function setup(over: Parameters<typeof a3Env>[0] = {}, at = A) {
  e = a3Env(over);
  e.fake.advance(at - T0);
  return e;
}
function state() {
  const r = e!.agent.readState();
  if (r.kind !== "ok") throw Error(`state: ${r.kind}`);
  return r.state;
}
async function call(params: Record<string, unknown>) {
  const tool = createScheduleTool({ agent: () => e!.agent, ports: () => e!.ports, now: () => e!.fake.now() });
  const result = await tool.execute("p2", params as never, undefined, undefined, {} as never);
  return {
    details: result.details as { ok: boolean; code?: string; id?: string },
    text: (result.content[0] as { text: string }).text,
  };
}
function reconcile(id: string, openedAt = A) {
  return reconcileEvery(e!.agent.ensureStore(), {
    taskId: id,
    openedAt,
    holder: e!.agent.holder!,
    gate: () => undefined,
    deadlineMono: e!.fake.now() + 10_000,
  });
}

describe("P2 production intervals", () => {
  it.each([
    { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    { kind: "once", at: "2026-12-01T09:00", tz: "UTC" },
  ])("legacy $kind create/update remains v1", async (when) => {
    const env = setup();
    const made = await createTask(env.ports, basicRaw({ when }), AI);
    if (!made.ok) throw Error(made.detail);
    expect(state().v).toBe(1);
    expect((await updateTask(env.ports, made.value.id, { name: "renamed" })).ok).toBe(true);
    expect(state().v).toBe(1);
    expect(validateStateFile(state()).ok).toBe(true);
  });

  it.each(["background", "message"] as const)(
    "90m %s create: lock-time anchor +90m, normalized reply and v2",
    async (form) => {
      setup();
      // Parsing clock differs: only the writer's successful commit clock is the anchor.
      e!.ports.now = () => A - 1000;
      const result = await call({ action: "create", name: "90m task", form, every: "90m", prompt: "report" });
      expect(result.details.ok).toBe(true);
      const s = state(),
        task = s.tasks[0]!;
      expect(s.v).toBe(2);
      expect(task.createdAt).toBe(A);
      expect(task.when).toEqual({ kind: "every", everyMs: D, anchorAt: A });
      if (task.when.kind !== "every") throw Error("every");
      expect(nextEvery(task.when, A)).toBe(A + D);
      expect(s.runs).toHaveLength(0);
      expect(s.occ[task.id]!.decidedThrough).toBe(A);
      expect(result.text).toContain(task.id);
      expect(result.text).toContain("5400s");
      expect(result.text).toContain("2026-11-09T10:07:23.000Z");
      expect(result.text).toContain("2026-11-09 11:37:23 UTC");
      expect(result.text).toContain("catch-up: aggregate once");
    },
  );

  it.each(["background", "message"] as const)(
    "pause 3h / resume %s aggregates once and preserves the grid",
    async (form) => {
      const env = setup();
      const made = await createTask(env.ports, basicRaw({ form, when: { kind: "every", every: "90m" } }), AI);
      if (!made.ok) throw Error(made.detail);
      const id = made.value.id,
        store = env.agent.ensureStore();
      expect((await setTaskEnabled(store, id, false)).ok).toBe(true);
      env.fake.advance(3 * 3_600_000);
      expect((await setTaskEnabled(store, id, true)).ok).toBe(true);
      expect((await reconcile(id)).kind).toBe("fired");
      expect(state().runs).toHaveLength(1);
      expect(state().runs[0]!.catchUp).toMatchObject({ cause: "resume", dueCount: 2 });
      expect(state().occ[id]).toMatchObject({ missedTotal: 1, firedTotal: 1, decidedThrough: A + 2 * D });
      expect((await setTaskEnabled(store, id, true)).ok).toBe(true);
      expect((await reconcile(id)).kind).toBe("lost");
      expect(state().runs).toHaveLength(1);
      const when = state().tasks[0]!.when;
      if (when.kind !== "every") throw Error("every");
      expect(nextEvery(when, env.fake.now())).toBe(A + 3 * D);
    },
  );

  it("reopen after 5h aggregates three due points into one marked run", async () => {
    const env = setup();
    expect((await call({ action: "create", name: "x", every: "90m", prompt: "report" })).details.ok).toBe(true);
    const id = state().tasks[0]!.id;
    env.fake.advance(5 * 3_600_000);
    expect((await reconcile(id, env.fake.now())).kind).toBe("fired");
    expect((await reconcile(id, env.fake.now())).kind).toBe("lost");
    expect(state().runs).toHaveLength(1);
    expect(state().runs[0]!.catchUp).toMatchObject({ cause: "reopen", dueCount: 3 });
    expect(catchUpText(state().runs[0]!)).toContain("合并 3 次到期，本次只执行一次");
    expect(state().occ[id]).toMatchObject({ missedTotal: 2, firedTotal: 1 });
  });

  it.each(["2026-03-08T06:30:00Z", "2026-11-01T05:30:00Z"])(
    "production interval stays unique and evenly spaced on DST %s",
    async (iso) => {
      const env = setup({}, Date.parse(iso));
      const made = await createTask(env.ports, basicRaw({ when: { kind: "every", every: "90m" } }), AI);
      if (!made.ok || made.value.when.kind !== "every") throw Error("create every");
      const w = made.value.when;
      const grid = Array.from({ length: 32 }, (_, i) => nextEvery(w, w.anchorAt + i * D));
      expect(new Set(grid).size).toBe(32);
      expect(grid).toEqual(Array.from({ length: 32 }, (_, i) => Date.parse(iso) + (i + 1) * D));
    },
  );

  it("v1 edits stay v1; switch to every upgrades atomically without touching other task hashes; v2 never downgrades", async () => {
    const env = setup();
    const first = await createTask(env.ports, basicRaw(), AI);
    const other = await createTask(env.ports, basicRaw({ name: "other" }), AI);
    if (!first.ok || !other.ok) throw Error("create");
    expect(state().v).toBe(1);
    expect((await updateTask(env.ports, first.value.id, { name: "renamed" })).ok).toBe(true);
    expect(state().v).toBe(1);
    const saved = state().occ[other.value.id];
    expect((await updateTask(env.ports, first.value.id, { when: { kind: "every", every: "90m" } })).ok).toBe(true);
    expect(state().v).toBe(2);
    expect(state().occ[other.value.id]).toEqual(saved);
    expect(defHash(state().tasks[1]!)).toBe(defHash(other.value));
    const hash = defHash(state().tasks[0]!);
    env.fake.advance(1000);
    expect((await updateTask(env.ports, first.value.id, { when: { kind: "every", every: "1.5h" } })).ok).toBe(true);
    expect(state().tasks[0]!.when).toEqual({ kind: "every", everyMs: D, anchorAt: A });
    expect(defHash(state().tasks[0]!)).toBe(hash);
    expect((await updateTask(env.ports, first.value.id, { prompt: "changed execution" })).ok).toBe(true);
    expect(state().tasks[0]!.when).toEqual({ kind: "every", everyMs: D, anchorAt: A + 1000 });
    expect(defHash(state().tasks[0]!)).not.toBe(hash);
    const store = env.agent.ensureStore();
    env.fake.advance(D);
    expect((await reconcile(first.value.id)).kind).toBe("fired");
    expect(
      (
        await store.transact((d, ctx) => {
          finishRun(d, d.runs[0]!.runKey, { state: "completed" }, ctx.now);
          housekeeping(d, ctx.now);
          d.v = 1; // Even a stale caller cannot downgrade.
          return { value: undefined, write: true };
        })
      ).ok,
    ).toBe(true);
    expect(state().v).toBe(2);
    expect((await updateTask(env.ports, first.value.id, { when: { kind: "cron", expr: "0 8 * * *" } })).ok).toBe(true);
    expect(state().v).toBe(2);
    expect((await deleteTask(store, first.value.id)).ok).toBe(true);
    expect(state().v).toBe(2);
  });

  it("unmodified pre-interval v1 reader safely rejects a produced v2 ledger without writing it", async () => {
    const env = setup();
    expect((await createTask(env.ports, basicRaw(), AI)).ok).toBe(true);
    expect(validateStateFile(state()).ok).toBe(true);
    expect((await createTask(env.ports, basicRaw({ when: { kind: "every", every: "90m" } }), AI)).ok).toBe(true);
    const store = env.agent.ensureStore(),
      file = join(store.root.real, store.dirName, "state.json");
    const before = readFileSync(file);
    expect(validateStateFile(state())).toEqual({ ok: false, error: "state.v: unsupported version" });
    expect(readSessionStateById(store.root, store.sessionId)).toMatchObject({
      kind: "degraded",
      reason: "schema",
      detail: "state.v: unsupported version",
    });
    expect(readFileSync(file)).toEqual(before);
  });

  it.each([undefined, false, true])(
    "hub admission handshake=%s: reject before creating directories unless interval ready",
    async (ready) => {
      const router = createScheduleHubRouter({ hubConfig: () => undefined });
      if (ready !== undefined)
        router.bindLink({ ready: () => true, intervalReady: () => ready, send: () => undefined });
      const env = setup({ router });
      const r = await call({ action: "create", name: "x", every: "90m", prompt: "report" });
      if (ready === true) expect(r.details.ok).toBe(true);
      else {
        expect(r.details).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
        expect(r.text).toContain("/webhub restart");
        expect(env.agent.store()).toBeUndefined();
      }
    },
  );
});

describe("P2 actionable validation and historical compatibility", () => {
  it.each([
    [{ every: "90m", tz: "UTC" }, "remove tz"],
    [{ every: "90m", cron: "0 * * * *" }, "give exactly one of cron, at, every"],
    [{ every: "90m", at: "2026-12-01T00:00" }, "give exactly one of cron, at, every"],
    [{ every: "90min" }, "every unit must be s/m/h/d"],
    [{ every: "1ms" }, "every must be whole seconds within 30s..365d"],
    [{ every: "10s" }, "30s..365d"],
    [{ every: null }, "every:"],
    [{ every: "" }, "every unit"],
    [{ cron: "*/90 * * * *" }, "--every 90m"],
    [{ cron: "0 */24 * * *" }, 'cron:"0 0 * * *"'],
    [{ everyMs: D }, "cannot be set"],
    [{ intervalMs: D }, "cannot be set"],
    [{ anchorAt: A }, "cannot be set"],
    [{}, "give exactly one of cron, at, every"],
  ])("create %j returns actionable %s with zero store IO", async (fields, error) => {
    const env = setup();
    const r = await call({ action: "create", name: "x", prompt: "report", ...fields });
    expect(r.details).toMatchObject({ ok: false, code: "E_INVALID" });
    expect(r.text).toContain(error);
    expect(env.agent.store()).toBeUndefined();
    expect(env.changed.n).toBe(0);
  });

  it.each([
    ["*/90 * * * *", "minute", 59],
    ["0 */24 * * *", "hour", 23],
    ["0 0 */32 * *", "day-of-month", 31],
    ["0 0 * */13 *", "month", 12],
    ["0 0 * * */8", "day-of-week", 7],
    ["0/90 * * * *", "minute", 59],
    ["0 0/24 * * *", "hour", 23],
    ["0 0 1/32 * *", "day-of-month", 31],
    ["0 0 * 1/13 *", "month", 12],
    ["0 0 * * 1/8", "day-of-week", 7],
    ["0-5/90 * * * *", "minute", 59],
    ["*/100 * * * *", "minute", 59],
  ])("all new writes reject %s with a field-specific bound and fix", async (expr, field, max) => {
    const env = setup();
    const r = await createTask(env.ports, basicRaw({ when: { kind: "cron", expr, tz: "UTC" } }), AI);
    expect(r).toMatchObject({ ok: false, code: "E_INVALID" });
    if (r.ok) throw Error("must reject");
    expect(r.detail).toContain(`${field} step`);
    expect(r.detail).toContain(`exceeds ${max}`);
    expect(r.detail).toMatch(/use .*every:/);
    expect(env.agent.store()).toBeUndefined();
  });

  it("legacy oversized step compiles as before; name-only edit succeeds, get/list warns, resubmission rejects before sweep", async () => {
    const env = setup();
    const made = await createTask(env.ports, basicRaw(), AI);
    if (!made.ok) throw Error("create");
    const id = made.value.id,
      store = env.agent.ensureStore();
    expect(
      (
        await store.transact((d) => {
          d.tasks[0]!.when = { kind: "cron", expr: "*/90 * * * *", tz: "UTC" };
          d.occ[id]!.defHash = defHash(d.tasks[0]!);
          return { value: undefined, write: true };
        })
      ).ok,
    ).toBe(true);
    const parsed = parseCron("*/90 * * * *");
    expect(parsed.ok && parsed.fields.minute).toEqual([0]);
    expect(whenText(state().tasks[0]!.when)).toContain("legacy-step");
    expect((await call({ action: "list" })).text).toContain("--every 90m");
    expect((await call({ action: "get", id })).text).toContain('every:"90m"');
    expect((await updateTask(env.ports, id, { name: "still manageable" })).ok).toBe(true);
    expect((await updateTask(env.ports, id, { prompt: "new instruction, same legacy cron" })).ok).toBe(true);
    const before = JSON.stringify(state());
    env.fake.advance(5 * 3_600_000);
    expect((await call({ action: "update", id, cron: "*/90 * * * *" })).details.code).toBe("E_INVALID");
    expect((await call({ action: "update", id, every: "90m", tz: "UTC" })).details.code).toBe("E_INVALID");
    expect(JSON.stringify(state())).toBe(before);
    expect(parseCron("0-5/59 * * * *", { strictSteps: true }).ok).toBe(true);
  });
});
