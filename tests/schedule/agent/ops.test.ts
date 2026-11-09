import { afterEach, describe, expect, it } from "vitest";
import { createTask, deleteTask, setTaskEnabled, updateTask } from "../../../src/schedule/agent/ops.js";
import { isExecutable } from "../../../src/schedule/core/spec.js";
import { validateStateFile } from "../../../src/schedule/core/reader.js";
import { a3Env, basicRaw, CRON, stripApproval, type A3Env } from "./a3-helpers.js";
import { holder } from "../core/fixtures.js";
import type { RunRecord } from "../../../src/schedule/core/spec.js";

let env: A3Env;
afterEach(() => env?.cleanup());
const AI = { by: "agent", via: "tool" } as const;
const USER = { by: "user", via: "tui" } as const;
const state = () => {
  const r = env.agent.readState();
  if (r.kind !== "ok") throw new Error(`state ${r.kind}`);
  return r.state;
};

describe("createTask", () => {
  it("AI create writes NO approval, is executable at once, and initializes the watermark", async () => {
    env = a3Env();
    const r = await createTask(env.ports, basicRaw(), AI);
    expect(r.ok).toBe(true);
    const t = state().tasks[0]!;
    expect(t).not.toHaveProperty("approval");
    expect(isExecutable(t)).toBe(true);
    expect(t.createdBy).toBe("agent");
    expect(t.createdVia).toBe("tool");
    expect(t.ownerCwd).toBe(env.ports.ownerCwd());
    expect(state().occ[t.id]!.decidedThrough).toBe(env.fake.now());
    expect(env.changed.n).toBe(1);
    // D7 defaults for a background task
    expect(t.feishu).toBe(true);
    expect(t.bg).toEqual({ type: "general-purpose", timeoutS: 1800, consultMain: false, handoff: false });
  });

  it("user create (tui / web via) writes no approval either and is executable", async () => {
    env = a3Env();
    const a = await createTask(env.ports, basicRaw(), USER);
    const b = await createTask(env.ports, basicRaw({ name: "w" }), { by: "user", via: "web" });
    if (!a.ok || !b.ok) throw new Error("create failed");
    expect(a.value).not.toHaveProperty("approval");
    expect(b.value).not.toHaveProperty("approval");
    expect(b.value.createdVia).toBe("web");
    expect(isExecutable(a.value)).toBe(true);
    expect(isExecutable(b.value)).toBe(true);
  });

  it("caps at 8 tasks per session (E_LIMIT) without writing", async () => {
    env = a3Env();
    for (let i = 0; i < 8; i++) expect((await createTask(env.ports, basicRaw({ name: `t${i}` }), AI)).ok).toBe(true);
    const rev = state().rev;
    const r = await createTask(env.ports, basicRaw({ name: "ninth" }), AI);
    expect(r).toMatchObject({ ok: false, code: "E_LIMIT" });
    expect(state().rev).toBe(rev);
  });

  it("message tasks default feishu off; message + bg options is rejected", async () => {
    env = a3Env();
    const m = await createTask(env.ports, basicRaw({ form: "message" }), AI);
    if (!m.ok) throw new Error(m.detail);
    expect(m.value.feishu).toBe(false);
    expect(m.value.bg).toBeUndefined();
    const bad = await createTask(env.ports, basicRaw({ form: "message", bg: { timeoutS: 120 } }), AI);
    expect(bad).toMatchObject({ ok: false, code: "E_INVALID" });
  });

  it.each([
    ["bad cron", { when: { kind: "cron", expr: "99 * * * *", tz: "UTC" } }],
    ["never-hitting cron", { when: { kind: "cron", expr: "0 0 31 2 *", tz: "UTC" } }],
    ["bad tz", { when: { kind: "cron", expr: "0 8 * * *", tz: "Mars/Base" } }],
    ["past once", { when: { kind: "once", at: "2020-01-01T00:00", tz: "UTC" } }],
    ["unknown field in when", { when: { ...CRON, extra: 1 } }],
    ["empty prompt", { prompt: "   " }],
    ["huge prompt", { prompt: "x".repeat(8193) }],
    ["long name", { name: "n".repeat(41) }],
    ["multiline name", { name: "a\nb" }],
    ["unknown agent type", { bg: { type: "nope" } }],
    ["unknown bg key", { bg: { bogus: 1 } }],
    ["bad model", { bg: { model: "gpt" } }],
    ["timeout too small", { bg: { timeoutS: 10 } }],
    ["timeout too large", { bg: { timeoutS: 99_999 } }],
    ["bad thinking", { bg: { thinking: "max" } }],
    ["bad form", { form: "cron" }],
  ])("rejects %s with E_INVALID", async (_n, over) => {
    env = a3Env();
    const r = await createTask(env.ports, basicRaw(over as Record<string, unknown>), AI);
    expect(r).toMatchObject({ ok: false, code: "E_INVALID" });
    expect(env.agent.readState().kind).toBe("absent"); // nothing created
  });

  it("an unknown model is refused only when the registry says so", async () => {
    env = a3Env();
    env.ports.knownModel = (ref) => (ref.id === "ghost" ? false : undefined);
    const bad = await createTask(env.ports, basicRaw({ bg: { model: "p/ghost" } }), AI);
    expect(bad).toMatchObject({ ok: false, code: "E_INVALID" });
    const ok = await createTask(env.ports, basicRaw({ bg: { model: "p/real" } }), AI);
    expect(ok.ok).toBe(true);
  });

  it("capability absent ⇒ E_UNSUPPORTED for message form and for handoff, background without handoff still works", async () => {
    env = a3Env();
    env.cap.state = "absent";
    expect(await createTask(env.ports, basicRaw({ form: "message" }), AI)).toMatchObject({ code: "E_UNSUPPORTED" });
    expect(await createTask(env.ports, basicRaw({ bg: { handoff: true } }), AI)).toMatchObject({
      code: "E_UNSUPPORTED",
    });
    expect((await createTask(env.ports, basicRaw(), AI)).ok).toBe(true);
  });

  it("the mode gate refuses (print mode) before anything is touched", async () => {
    env = a3Env({}, "print");
    const r = await createTask(env.ports, basicRaw(), AI);
    expect(r).toMatchObject({ ok: false, code: "E_MODE" });
  });
});

describe("update (no approval)", () => {
  async function newTask() {
    const r = await createTask(env.ports, basicRaw(), USER);
    if (!r.ok) throw new Error(r.detail);
    return r.value;
  }

  it("an update by anyone writes no approval, stays executable, and leaves a paused task paused", async () => {
    env = a3Env();
    const t = await newTask();
    const edited = await updateTask(env.ports, t.id, { prompt: "new prompt" });
    if (!edited.ok) throw new Error(edited.detail);
    expect(edited.value).not.toHaveProperty("approval");
    expect(isExecutable(edited.value)).toBe(true);
    await setTaskEnabled(env.agent.ensureStore(), t.id, false);
    const paused = await updateTask(env.ports, t.id, { prompt: "while paused" });
    if (!paused.ok) throw new Error(paused.detail);
    expect(paused.value.enabled).toBe(false);
    const resumed = await setTaskEnabled(env.agent.ensureStore(), t.id, true);
    if (!resumed.ok) throw new Error(resumed.detail);
    expect(isExecutable(resumed.value)).toBe(true);
    expect(resumed.value).not.toHaveProperty("approval");
  });

  it("a legacy approval (matching, stale, auto:true) is kept byte-for-byte by update / pause / resume — never rewritten, never stripped", async () => {
    env = a3Env();
    for (const legacy of [
      { hash: "a".repeat(64), by: "user", via: "tui", at: 7 },
      { hash: "b".repeat(64), by: "user", via: "web", auto: true, at: 9 },
    ] as const) {
      const t = await newTask();
      await env.agent.ensureStore().transact((d) => {
        d.tasks.find((x) => x.id === t.id)!.approval = structuredClone(legacy) as never;
        return { value: undefined, write: true };
      });
      await updateTask(env.ports, t.id, { prompt: `edit ${legacy.at}` });
      await setTaskEnabled(env.agent.ensureStore(), t.id, false);
      await setTaskEnabled(env.agent.ensureStore(), t.id, true);
      const now = state().tasks.find((x) => x.id === t.id)!;
      expect(now.approval).toEqual(legacy);
      expect(isExecutable(now)).toBe(true);
      expect(validateStateFile(JSON.parse(JSON.stringify(state()))).ok).toBe(true);
    }
  });

  it("an old-ledger task with no approval (what pre-r2 code called pending) updates fine and stays approval-free", async () => {
    env = a3Env();
    const t = await newTask();
    await stripApproval(env, t.id);
    const up = await updateTask(env.ports, t.id, { prompt: "touched" });
    if (!up.ok) throw new Error(up.detail);
    expect(up.value).not.toHaveProperty("approval");
    expect(isExecutable(state().tasks[0]!)).toBe(true);
    expect(validateStateFile(JSON.parse(JSON.stringify(state()))).ok).toBe(true);
  });

  it("an edit voids the watermark of the new definition (no spurious misses) via changeTask", async () => {
    env = a3Env();
    const t = await newTask();
    env.fake.advance(3 * 3_600_000);
    const e = await updateTask(env.ports, t.id, { when: { kind: "cron", expr: "30 9 * * *", tz: "UTC" } });
    expect(e.ok).toBe(true);
    const occ = state().occ[t.id]!;
    expect(occ.decidedThrough).toBeGreaterThanOrEqual(env.fake.now());
    expect(occ.missedTotal).toBe(0);
  });

  it("update on an unknown task / bad id is E_INVALID; delete removes the task", async () => {
    env = a3Env();
    const t = await newTask();
    expect(await updateTask(env.ports, "s_aaaaaaaa", { name: "x" })).toMatchObject({ code: "E_INVALID" });
    expect(await updateTask(env.ports, "nope", { name: "x" })).toMatchObject({ code: "E_INVALID" });
    const d = await deleteTask(env.agent.ensureStore(), t.id);
    expect(d.ok).toBe(true);
    expect(state().tasks).toHaveLength(0);
    expect(state().occ[t.id]).toBeUndefined();
    expect(await deleteTask(env.agent.ensureStore(), t.id)).toMatchObject({ ok: false, code: "E_INVALID" });
  });

  it("switching background→message drops bg and re-applies the feishu default; E_UNSUPPORTED when capability absent", async () => {
    env = a3Env();
    const t = await newTask();
    env.cap.state = "absent";
    expect(await updateTask(env.ports, t.id, { form: "message" })).toMatchObject({ code: "E_UNSUPPORTED" });
    env.cap.state = "verified";
    const m = await updateTask(env.ports, t.id, { form: "message" });
    if (!m.ok) throw new Error(m.detail);
    expect(m.value.bg).toBeUndefined();
    expect(m.value.feishu).toBe(false);
  });
});

describe("pause / delete revoke queued message runs (I1, A2 residual 3)", () => {
  async function mkTask(name = "t") {
    const r = await createTask(env.ports, basicRaw({ name }), USER);
    if (!r.ok) throw new Error(r.detail);
    return r.value;
  }
  async function queuedRun(taskId: string, over: Partial<RunRecord> = {}): Promise<RunRecord> {
    const run: RunRecord = {
      runKey: over.runKey ?? `${taskId}@${env.fake.now()}`,
      taskId,
      kind: "auto",
      form: "message",
      scheduledAt: env.fake.now(),
      defHash: "0".repeat(64),
      state: "queued",
      holder: holder(),
      startedAt: env.fake.now(),
      note: "none",
      ...over,
    };
    await env.agent.ensureStore().transact((d) => {
      d.runs.push(run);
      return { value: undefined, write: true };
    });
    return run;
  }

  it("pause: queued message runs of THAT task become dropped(task-changed) in the ledger; other tasks, other forms and non-queued runs are untouched; resume revokes nothing", async () => {
    env = a3Env();
    const t = await mkTask();
    const other = await mkTask("other");
    const q = await queuedRun(t.id);
    const qOther = await queuedRun(other.id);
    const dispatched = await queuedRun(t.id, { runKey: `${t.id}@m-aaaaaaa1`, kind: "manual", state: "dispatched" });
    const bg = await queuedRun(t.id, {
      runKey: `${t.id}@m-aaaaaaa2`,
      kind: "manual",
      form: "background",
      state: "running",
    });
    const revoked: string[] = [];
    const rr = await setTaskEnabled(env.agent.ensureStore(), t.id, true, { revoke: (id) => revoked.push(id) });
    expect(rr, JSON.stringify(rr)).toMatchObject({ ok: true });
    expect(revoked).toEqual([]);
    expect(state().runs.find((r) => r.runKey === q.runKey)?.state).toBe("queued");
    expect((await setTaskEnabled(env.agent.ensureStore(), t.id, false, { revoke: (id) => revoked.push(id) })).ok).toBe(
      true,
    );
    expect(revoked).toEqual([t.id]);
    const by = (k: string) => state().runs.find((r) => r.runKey === k)!;
    expect(by(q.runKey)).toMatchObject({ state: "dropped", reason: "task-changed" });
    expect(by(qOther.runKey).state).toBe("queued");
    expect(by(dispatched.runKey).state).toBe("dispatched");
    expect(by(bg.runKey).state).toBe("running");
  });

  it("delete: the task's queued message run is dropped (or swept) too, and the in-memory revoke is called", async () => {
    env = a3Env();
    const t = await mkTask();
    const q = await queuedRun(t.id);
    const revoked: string[] = [];
    expect((await deleteTask(env.agent.ensureStore(), t.id, { revoke: (id) => revoked.push(id) })).ok).toBe(true);
    expect(revoked).toEqual([t.id]);
    // (the next write's housekeeping may already have swept an orphaned run — either way it is not queued any more)
    const rec = state().runs.find((r) => r.runKey === q.runKey);
    expect(rec === undefined || (rec.state === "dropped" && rec.reason === "task-changed")).toBe(true);
  });

  it("a failed pause (unknown task) revokes nothing", async () => {
    env = a3Env();
    const revoked: string[] = [];
    expect(
      await setTaskEnabled(env.agent.ensureStore(), "s_aaaaaaaa", false, { revoke: (id) => revoked.push(id) }),
    ).toMatchObject({ ok: false });
    expect(revoked).toEqual([]);
  });
});

describe("interval P1 has no production producer", () => {
  it.each([
    { every: "90m" },
    { everyMs: 5_400_000 },
    { intervalMs: 5_400_000 },
    { anchorAt: 1 },
    { when: { kind: "every", everyMs: 5_400_000, anchorAt: 1 } },
  ])("rejects internal interval creation before directory creation: %j", async (fields) => {
    env = a3Env();
    expect(await createTask(env.ports, basicRaw(fields), AI)).toMatchObject({ ok: false, code: "E_INVALID" });
    expect(env.agent.store()).toBeUndefined();
    expect(env.changed.n).toBe(0);
  });
  it("invalid updates cannot sweep/advance rev while validating; */90 behavior is deliberately unchanged until P2", async () => {
    env = a3Env();
    const made = await createTask(env.ports, basicRaw({ when: { kind: "cron", expr: "*/90 * * * *", tz: "UTC" } }), AI);
    if (!made.ok) throw Error(made.detail);
    const before = JSON.stringify(state());
    env.fake.advance(10 * 3_600_000);
    expect(
      await updateTask(env.ports, made.value.id, { when: { kind: "every", everyMs: 5_400_000, anchorAt: 1 } }),
    ).toMatchObject({ ok: false, code: "E_INVALID" });
    expect(JSON.stringify(state())).toBe(before);
  });
});
