import { afterEach, describe, expect, it } from "vitest";
import {
  createTask,
  deleteTask,
  previewHash,
  resolveDef,
  setTaskEnabled,
  updateTask,
  defOf,
} from "../../../src/schedule/agent/ops.js";
import { defHash, isApproved, isExecutable } from "../../../src/schedule/core/spec.js";
import { a3Env, basicRaw, CRON, type A3Env } from "./a3-helpers.js";
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
  it("AI create writes NO approval (pending) and initializes the watermark", async () => {
    env = a3Env();
    const r = await createTask(env.ports, basicRaw(), AI);
    expect(r.ok).toBe(true);
    const t = state().tasks[0]!;
    expect(t.approval).toBeUndefined();
    expect(isApproved(t)).toBe(false);
    expect(t.createdBy).toBe("agent");
    expect(t.createdVia).toBe("tool");
    expect(t.ownerCwd).toBe(env.ports.ownerCwd());
    expect(state().occ[t.id]!.decidedThrough).toBe(env.fake.now());
    expect(env.changed.n).toBe(1);
    // D7 defaults for a background task
    expect(t.feishu).toBe(true);
    expect(t.bg).toEqual({ type: "general-purpose", timeoutS: 1800, consultMain: false, handoff: false });
  });

  it("user create is approved with exactly the stored definition hash (tui / web via)", async () => {
    env = a3Env();
    const a = await createTask(env.ports, basicRaw(), USER);
    const b = await createTask(env.ports, basicRaw({ name: "w" }), { by: "user", via: "web" });
    if (!a.ok || !b.ok) throw new Error("create failed");
    expect(a.value.approval).toMatchObject({ hash: defHash(a.value), by: "user", via: "tui" });
    expect(b.value.approval?.via).toBe("web");
    expect(isExecutable(a.value)).toBe(true);
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

  it("__put expectHash: matching hash stores, mismatching ⇒ E_REV with nothing written", async () => {
    env = a3Env();
    const def = resolveDef(basicRaw(), undefined, env.ports);
    if (!def.ok) throw new Error("def");
    const good = previewHash(def.value, env.ports.ownerCwd());
    const bad = await createTask(env.ports, basicRaw(), USER, { expectHash: "0".repeat(64) });
    expect(bad).toMatchObject({ ok: false, code: "E_REV" });
    expect(env.agent.readState().kind).toBe("absent");
    const ok = await createTask(env.ports, basicRaw(), USER, { expectHash: good });
    if (!ok.ok) throw new Error(ok.detail);
    expect(defHash(ok.value)).toBe(good);
  });
});

describe("approval semantics (S2)", () => {
  async function approvedTask() {
    const r = await createTask(env.ports, basicRaw(), USER);
    if (!r.ok) throw new Error(r.detail);
    return r.value;
  }

  it("AI update of an execution field invalidates the approval (enabled or paused alike); name-only keeps it", async () => {
    env = a3Env();
    const t = await approvedTask();
    const nameOnly = await updateTask(env.ports, t.id, { name: "renamed" }, AI);
    if (!nameOnly.ok) throw new Error(nameOnly.detail);
    expect(isApproved(nameOnly.value)).toBe(true);
    const edited = await updateTask(env.ports, t.id, { prompt: "exfiltrate" }, AI);
    if (!edited.ok) throw new Error(edited.detail);
    expect(isApproved(edited.value)).toBe(false);
    expect(edited.value.approval?.hash).not.toBe(defHash(edited.value)); // stale, not erased
    expect(isExecutable(edited.value)).toBe(false);
  });

  it("pause → AI edits prompt → resume: still not executable and run_now is refused", async () => {
    env = a3Env();
    env.agent.setExecutor("background", { dispatch: () => undefined });
    const t = await approvedTask();
    await setTaskEnabled(env.agent.ensureStore(), t.id, false);
    await updateTask(env.ports, t.id, { prompt: "changed while paused" }, AI);
    const resumed = await setTaskEnabled(env.agent.ensureStore(), t.id, true);
    if (!resumed.ok) throw new Error(resumed.detail);
    expect(resumed.value.enabled).toBe(true);
    expect(isExecutable(resumed.value)).toBe(false);
    const run = await env.agent.runNow({ taskId: t.id, reqId: "r".repeat(16) });
    expect(run).toMatchObject({ kind: "refused", code: "E_UNAPPROVED" });
    expect(state().runs).toHaveLength(0);
  });

  it("a USER edit keeps an approved task approved (new hash) but never approves a pending one", async () => {
    env = a3Env();
    const t = await approvedTask();
    const e1 = await updateTask(env.ports, t.id, { prompt: "user edit" }, USER);
    if (!e1.ok) throw new Error(e1.detail);
    expect(isApproved(e1.value)).toBe(true);
    expect(e1.value.approval?.hash).toBe(defHash(e1.value));

    const ai = await createTask(env.ports, basicRaw({ name: "ai" }), AI);
    if (!ai.ok) throw new Error(ai.detail);
    const e2 = await updateTask(env.ports, ai.value.id, { prompt: "user touched" }, USER);
    if (!e2.ok) throw new Error(e2.detail);
    expect(isApproved(e2.value)).toBe(false);
    expect(e2.value.approval).toBeUndefined();
  });

  it("an edit voids the watermark of the new definition (no spurious misses) via changeTask", async () => {
    env = a3Env();
    const t = await approvedTask();
    env.fake.advance(3 * 3_600_000);
    const e = await updateTask(env.ports, t.id, { when: { kind: "cron", expr: "30 9 * * *", tz: "UTC" } }, USER);
    expect(e.ok).toBe(true);
    const occ = state().occ[t.id]!;
    expect(occ.decidedThrough).toBeGreaterThanOrEqual(env.fake.now());
    expect(occ.missedTotal).toBe(0);
  });

  it("baseHash CAS and expectHash CAS refuse with E_REV and leave the task untouched", async () => {
    env = a3Env();
    const t = await approvedTask();
    const before = state().tasks[0]!;
    const stale = await updateTask(env.ports, t.id, { prompt: "x" }, USER, { baseHash: "f".repeat(64) });
    expect(stale).toMatchObject({ ok: false, code: "E_REV" });
    const wrong = await updateTask(env.ports, t.id, { prompt: "x" }, USER, {
      baseHash: defHash(t),
      expectHash: "0".repeat(64),
    });
    expect(wrong).toMatchObject({ ok: false, code: "E_REV" });
    expect(state().tasks[0]).toEqual(before);
    const def = resolveDef({ prompt: "x" }, defOf(t), env.ports);
    if (!def.ok) throw new Error("def");
    const ok = await updateTask(env.ports, t.id, { prompt: "x" }, USER, {
      baseHash: defHash(t),
      expectHash: previewHash(def.value, t.ownerCwd),
    });
    expect(ok.ok).toBe(true);
  });

  it("update on an unknown task / bad id is E_INVALID; delete removes the task", async () => {
    env = a3Env();
    const t = await approvedTask();
    expect(await updateTask(env.ports, "s_aaaaaaaa", { name: "x" }, AI)).toMatchObject({ code: "E_INVALID" });
    expect(await updateTask(env.ports, "nope", { name: "x" }, AI)).toMatchObject({ code: "E_INVALID" });
    const d = await deleteTask(env.agent.ensureStore(), t.id);
    expect(d.ok).toBe(true);
    expect(state().tasks).toHaveLength(0);
    expect(state().occ[t.id]).toBeUndefined();
    expect(await deleteTask(env.agent.ensureStore(), t.id)).toMatchObject({ ok: false, code: "E_INVALID" });
  });

  it("switching background→message drops bg and re-applies the feishu default; E_UNSUPPORTED when capability absent", async () => {
    env = a3Env();
    const t = await approvedTask();
    env.cap.state = "absent";
    expect(await updateTask(env.ports, t.id, { form: "message" }, AI)).toMatchObject({ code: "E_UNSUPPORTED" });
    env.cap.state = "verified";
    const m = await updateTask(env.ports, t.id, { form: "message" }, AI);
    if (!m.ok) throw new Error(m.detail);
    expect(m.value.bg).toBeUndefined();
    expect(m.value.feishu).toBe(false);
  });
});

describe("approveReviewed (__put)", () => {
  it("a reviewed, hash-bound user edit approves even a previously pending task; without the flag it does not", async () => {
    env = a3Env();
    const ai = await createTask(env.ports, basicRaw(), AI);
    if (!ai.ok) throw new Error(ai.detail);
    const def = resolveDef({ prompt: "reviewed text" }, defOf(ai.value), env.ports);
    if (!def.ok) throw new Error("def");
    const expectHash = previewHash(def.value, ai.value.ownerCwd);
    const plain = await updateTask(env.ports, ai.value.id, { prompt: "reviewed text" }, USER, { expectHash });
    if (!plain.ok) throw new Error(plain.detail);
    expect(isApproved(plain.value)).toBe(false);
    const reviewed = await updateTask(env.ports, ai.value.id, { prompt: "reviewed text" }, USER, {
      expectHash,
      approveReviewed: true,
    });
    if (!reviewed.ok) throw new Error(reviewed.detail);
    expect(isApproved(reviewed.value)).toBe(true); // reviewed + bound ⇒ approved even with an unchanged hash
    const def2 = resolveDef({ prompt: "reviewed again" }, defOf(reviewed.value), env.ports);
    if (!def2.ok) throw new Error("def2");
    const h2 = previewHash(def2.value, ai.value.ownerCwd);
    const r2 = await updateTask(env.ports, ai.value.id, { prompt: "reviewed again" }, USER, {
      expectHash: h2,
      approveReviewed: true,
    });
    if (!r2.ok) throw new Error(r2.detail);
    expect(isApproved(r2.value)).toBe(true);
    expect(r2.value.approval?.hash).toBe(h2);
  });
});

describe("pause / delete revoke queued message runs (I1, A2 residual 3)", () => {
  async function approvedTask(name = "t") {
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
    const t = await approvedTask();
    const other = await approvedTask("other");
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
    const t = await approvedTask();
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

describe("updateTask onBase (#61)", () => {
  it("receives a clone of the task as it was, once, inside the write — and not at all when the update is refused", async () => {
    env = a3Env();
    const c = await createTask(env.ports, basicRaw(), USER);
    if (!c.ok) throw new Error(c.detail);
    const seen: ReturnType<typeof structuredClone>[] = [];
    const ok = await updateTask(env.ports, c.value.id, { prompt: "new" }, AI, {
      onBase: (b) => {
        seen.push(b);
        b.prompt = "mutated by the observer"; // a clone: must not leak into the ledger
      },
    });
    if (!ok.ok) throw new Error(ok.detail);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { prompt: string }).prompt).toBe("mutated by the observer");
    expect(state().tasks[0]!.prompt).toBe("new");
    expect(isApproved(state().tasks[0]!)).toBe(false);

    let refusedCalls = 0;
    const bad = await updateTask(env.ports, c.value.id, { form: "nope" }, AI, { onBase: () => void refusedCalls++ });
    expect(bad.ok).toBe(false);
    expect(refusedCalls).toBe(0);
  });

  it("a throwing observer never breaks the write", async () => {
    env = a3Env();
    const c = await createTask(env.ports, basicRaw(), AI);
    if (!c.ok) throw new Error(c.detail);
    const r = await updateTask(env.ports, c.value.id, { prompt: "x" }, AI, {
      onBase: () => {
        throw new Error("boom");
      },
    });
    expect(r.ok).toBe(true);
    expect(state().tasks[0]!.prompt).toBe("x");
  });
});
