/**
 * #61 confirm-on-the-spot (C1): offer registry, decide arbitration, revalidate, TUI presenter discipline.
 * Real schedule agent + real ledger (a3Env); only the pi UI / clock / publish / notice ports are fakes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIRM_OPT_APPROVE,
  CONFIRM_OPT_LATER,
  CONFIRM_OPT_REJECT_DELETE,
  CONFIRM_OPT_REJECT_RESTORE,
  CONFIRM_QUIET_INPUT_MS,
  CONFIRM_REVALIDATE_MS,
  createScheduleConfirm,
  type OfferOrigin,
  type ScheduleConfirm,
} from "../../../src/schedule/agent/confirm.js";
import { createTask, updateTask } from "../../../src/schedule/agent/ops.js";
import { approveTask } from "../../../src/schedule/core/claim.js";
import { defHash, isApproved, type ScheduleTask } from "../../../src/schedule/core/spec.js";
import { SCHED_CONFIRM_OFFERS_MAX, SCHED_CONFIRM_TTL_MS } from "../../../src/web-hub/protocol/schedule.js";
import { a3Env, basicRaw, type A3Env } from "./a3-helpers.js";

let env: A3Env;
let confirm: ScheduleConfirm | undefined;
afterEach(() => {
  confirm?.dispose();
  confirm = undefined;
  env?.cleanup();
});

const AI = { by: "agent", via: "tool" } as const;

interface Harness {
  confirm: ScheduleConfirm;
  published: Array<{ sessionId: string; open: Array<{ offerId: string; taskId: string }>; closed: any[] }>;
  notices: Array<{ text: string; details: any }>;
  notes: Array<{ text: string; level: string }>;
  selects: Array<{ title: string; options: string[]; argc: number }>;
  answer(i: number, choice: string | undefined): void;
  revoked: string[];
  ui: { idle: boolean; hasUI: boolean; mode: string };
  hub: { ready: boolean };
}

function harness(opts: { ui?: boolean; mode?: string; hub?: boolean; e?: A3Env } = {}): Harness {
  env = opts.e ?? env ?? a3Env();
  const published: Harness["published"] = [];
  const notices: Harness["notices"] = [];
  const notes: Harness["notes"] = [];
  const selects: Harness["selects"] = [];
  const resolvers: Array<(v: string | undefined) => void> = [];
  const revoked: string[] = [];
  const ui = { idle: true, hasUI: opts.ui ?? true, mode: opts.mode ?? "tui" };
  const hub = { ready: opts.hub ?? false };
  confirm = createScheduleConfirm({
    agent: env.agent,
    ...(opts.ui === false
      ? {}
      : {
          ui: {
            get mode() {
              return ui.mode;
            },
            get hasUI() {
              return ui.hasUI;
            },
            select: (...args: unknown[]) => {
              selects.push({ title: args[0] as string, options: args[1] as string[], argc: args.length });
              return new Promise<string | undefined>((res) => resolvers.push(res));
            },
            notify: (text: string, level: string) => void notes.push({ text, level }),
            isIdle: () => ui.idle,
          } as never,
        }),
    hubConfirmReady: () => hub.ready,
    publish: (f) => void published.push(f as never),
    notice: (text, details) => void notices.push({ text, details }),
    revoke: (id) => void revoked.push(id),
    clock: env.fake,
  });
  return {
    confirm,
    published,
    notices,
    notes,
    selects,
    answer: (i, c) => resolvers[i]!(c),
    revoked,
    ui,
    hub,
  };
}

async function aiTask(raw: Record<string, unknown> = {}): Promise<ScheduleTask> {
  const r = await createTask(env.ports, basicRaw(raw) as never, AI);
  if (!r.ok) throw new Error(r.detail);
  return r.value;
}
const createOrigin: OfferOrigin = { kind: "create" };
const tick = () => new Promise<void>((r) => setImmediate(r));
const readTasks = () => {
  const s = env.agent.readState();
  if (s.kind !== "ok") throw new Error("state");
  return s.state.tasks;
};

describe("offer()", () => {
  it("unavailable: non-interactive mode, already approved, no UI and no hub, disposed", async () => {
    env = a3Env({}, "print");
    const hp = harness({ e: env });
    const r = await createTask(env.ports, basicRaw() as never, AI).catch(() => undefined);
    expect(r).toBeDefined();
    const t0 = { id: "s_aaaaaaaa", name: "x" } as unknown as ScheduleTask;
    expect(hp.confirm.offer(t0, createOrigin)).toBe("unavailable");
    confirm?.dispose();
    env.cleanup();

    env = a3Env();
    const h = harness({ e: env });
    const t = await aiTask();
    const store = env.agent.store()!;
    await approveTask(store, t.id, defHash(t), "tui");
    const approved = readTasks()[0]!;
    expect(isApproved(approved)).toBe(true);
    expect(h.confirm.offer(approved, createOrigin)).toBe("unavailable");
    expect(h.published).toHaveLength(0);

    confirm?.dispose();
    const hn = harness({ e: env, ui: false, hub: false });
    const t2 = await aiTask({ name: "two" });
    expect(hn.confirm.offer(t2, createOrigin)).toBe("unavailable");
    hn.hub.ready = true;
    expect(hn.confirm.offer(t2, createOrigin)).toBe("offered"); // hub alone is a channel
    hn.confirm.dispose();
    expect(hn.confirm.offer(t2, createOrigin)).toBe("unavailable");
  });

  it("registers, publishes the full list; a same-hash re-offer (rename) changes nothing", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const t = await aiTask();
    expect(h.confirm.offer(t, createOrigin)).toBe("offered");
    expect(h.published).toHaveLength(1);
    const f = h.published[0]!;
    expect(f.sessionId).toBe(env.agent.sessionId);
    expect(f.open).toHaveLength(1);
    expect(f.open[0]).toMatchObject({ taskId: t.id, defHash: defHash(t) });
    expect(f.open[0]).toHaveProperty("expiresAt", env.fake.now() + SCHED_CONFIRM_TTL_MS);
    h.confirm.offer({ ...t, name: "renamed" }, createOrigin);
    expect(h.published).toHaveLength(1);
    expect(h.confirm.hasLiveOffer(t.id, defHash(t))).toBe(true);
    expect(h.confirm.hasLiveOffer(t.id, "0".repeat(64))).toBe(false);
  });

  it("a changed hash supersedes the old offer; the chain keeps the FIRST origin (create ⇒ still delete on reject)", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const t = await aiTask();
    h.confirm.offer(t, createOrigin);
    const first = h.confirm.liveOffer(t.id)!;
    // updateTask's own agent.changed() re-validates first: the old offer is already closed (superseded)
    // when the tool gets to offer() — the chain must survive that
    const u = await updateTask(env.ports, t.id, { prompt: "second" }, AI);
    if (!u.ok) throw new Error(u.detail);
    expect(h.confirm.liveOffer(t.id)).toBeUndefined();
    // the second offer even claims to be an update with some base: it must inherit "create"
    h.confirm.offer(u.value, { kind: "update", base: { ...t, bg: t.bg } as never });
    const second = h.confirm.liveOffer(t.id)!;
    expect(second.offerId).not.toBe(first.offerId);
    expect(second.kind).toBe("create");
    const last = h.published.at(-1)!;
    expect(last.open.map((o) => o.offerId)).toEqual([second.offerId]);
    expect(last.closed).toEqual([expect.objectContaining({ offerId: first.offerId, outcome: "superseded" })]);
    const res = await h.confirm.decide({
      taskId: t.id,
      defHash: second.defHash,
      decision: "reject",
      via: "feishu",
      offerId: second.offerId,
    });
    expect(res).toEqual({ kind: "rejected", removed: true });
    expect(readTasks()).toHaveLength(0);
  });

  it("a superseded chain is only inherited within the grace window", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const t = await aiTask();
    h.confirm.offer(t, createOrigin);
    const u = await updateTask(env.ports, t.id, { prompt: "later" }, AI);
    if (!u.ok) throw new Error(u.detail);
    env.fake.advance(61_000);
    h.confirm.offer(u.value, {
      kind: "update",
      base: { form: t.form, when: t.when, prompt: t.prompt, feishu: t.feishu },
    });
    expect(h.confirm.liveOffer(t.id)!.kind).toBe("update");
  });

  it("evicts the oldest open offer beyond the cap as withdrawn", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    // the ledger caps a session at 8 tasks (= the offer cap): drive the registry with synthetic task ids
    const base = await aiTask();
    const ids: string[] = [];
    for (let i = 0; i < SCHED_CONFIRM_OFFERS_MAX + 1; i++) {
      const t = { ...base, id: `s_aaaaaaa${i}`, prompt: `p${i}` };
      ids.push(t.id);
      h.confirm.offer(t, createOrigin);
    }
    const last = h.published.at(-1)!;
    expect(last.open).toHaveLength(SCHED_CONFIRM_OFFERS_MAX);
    expect(last.closed).toEqual([expect.objectContaining({ taskId: ids[0], outcome: "withdrawn" })]);
    expect(h.confirm.liveOffer(ids[0]!)).toBeUndefined();
    expect(h.confirm.liveOffer(ids[8]!)).toBeDefined();
  });
});

describe("decide()", () => {
  async function offered(h: Harness, raw: Record<string, unknown> = {}) {
    const t = await aiTask(raw);
    h.confirm.offer(t, createOrigin);
    return { t, live: h.confirm.liveOffer(t.id)! };
  }

  it("approve (feishu): CAS ok, offer closed by feishu, ONE notice, via recorded as web", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const { t, live } = await offered(h);
    const res = await h.confirm.decide({
      taskId: t.id,
      defHash: live.defHash,
      decision: "approve",
      via: "feishu",
      offerId: live.offerId,
    });
    expect(res).toEqual({ kind: "approved" });
    expect(readTasks()[0]!.approval).toMatchObject({ via: "web", by: "user" });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.text).toContain("飞书");
    expect(h.notices[0]!.details).toEqual({ kind: "confirm", taskId: t.id, outcome: "approved", by: "feishu" });
    expect(h.published.at(-1)).toMatchObject({
      open: [],
      closed: [expect.objectContaining({ offerId: live.offerId, outcome: "approved", by: "feishu" })],
    });
  });

  it("two concurrent decisions on one offer share one promise: one notice, one closed.by", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const { t, live } = await offered(h);
    const req = { taskId: t.id, defHash: live.defHash, decision: "approve" as const, offerId: live.offerId };
    const p1 = h.confirm.decide({ ...req, via: "tui" });
    const p2 = h.confirm.decide({ ...req, via: "feishu" });
    expect(p2).toBe(p1);
    expect(await p1).toEqual({ kind: "approved" });
    expect(h.notices).toHaveLength(1);
    const closedFrames = h.published.flatMap((f) => f.closed).filter((c) => c.offerId === live.offerId);
    expect(new Set(closedFrames.map((c) => c.by))).toEqual(new Set(["tui"]));
  });

  it("different offers race through the ledger lock: the loser sees already-approved", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const { t, live } = await offered(h);
    // someone else (web `/schedule approve`) wins the CAS first, without going through confirm
    await approveTask(env.agent.store()!, t.id, live.defHash, "web");
    const res = await h.confirm.decide({
      taskId: t.id,
      defHash: live.defHash,
      decision: "approve",
      via: "tui",
      offerId: live.offerId,
    });
    expect(res).toMatchObject({ kind: "refused", code: "already-approved" });
    // the refused decision itself notifies nothing; the ledger's verdict ("approved elsewhere") does, once
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.details).toMatchObject({ outcome: "approved", by: "elsewhere" });
    // the refused decision leaves the offer to the ledger's verdict
    await vi.waitFor(() => expect(h.confirm.liveOffer(t.id)).toBeUndefined());
    expect(h.published.at(-1)!.closed).toEqual([
      expect.objectContaining({ offerId: live.offerId, outcome: "approved", by: "elsewhere" }),
    ]);
  });

  it("feishu / reject need a live matching offer; a local approve may CAS without one", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const { t, live } = await offered(h);
    const base = { taskId: t.id, defHash: live.defHash };
    expect(
      await h.confirm.decide({ ...base, decision: "approve", via: "feishu", offerId: "x".repeat(16) }),
    ).toMatchObject({ kind: "refused", code: "offer-gone" });
    expect(await h.confirm.decide({ ...base, defHash: "0".repeat(64), decision: "reject", via: "web" })).toMatchObject({
      kind: "refused",
      code: "offer-gone",
    });
    // local approve against a changed definition ⇒ E_REV from the ledger
    const u = await updateTask(env.ports, t.id, { prompt: "changed after the box opened" }, AI);
    expect(u.ok).toBe(true);
    expect(await h.confirm.decide({ ...base, decision: "approve", via: "tui" })).toMatchObject({
      kind: "refused",
      code: "E_REV",
    });
    expect(isApproved(readTasks()[0]!)).toBe(false);
  });

  it("reject an AI update ⇒ restored to the pre-change definition, old approval live again; revoke not called", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const t = await aiTask();
    await approveTask(env.agent.store()!, t.id, defHash(t), "tui");
    let before: ScheduleTask | undefined;
    const u = await updateTask(env.ports, t.id, { prompt: "ai edit" }, AI, { onBase: (b) => void (before = b) });
    if (!u.ok) throw new Error(u.detail);
    expect(before?.prompt).toBe(t.prompt);
    h.confirm.offer(u.value, {
      kind: "update",
      base: { form: before!.form, when: before!.when, prompt: before!.prompt, feishu: before!.feishu, bg: before!.bg! },
      wasApproved: true,
    });
    const live = h.confirm.liveOffer(t.id)!;
    expect(live.kind).toBe("update");
    const res = await h.confirm.decide({
      taskId: t.id,
      defHash: live.defHash,
      decision: "reject",
      via: "web",
      offerId: live.offerId,
    });
    expect(res).toEqual({ kind: "rejected", removed: false });
    expect(readTasks()[0]!.prompt).toBe(t.prompt);
    expect(isApproved(readTasks()[0]!)).toBe(true);
    expect(h.revoked).toEqual([]);
    expect(h.notices[0]!.text).toContain("恢复");
  });

  it("reject an AI create ⇒ deleted, queued runs revoked, notice says deleted", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const { t, live } = await offered(h);
    const res = await h.confirm.decide({
      taskId: t.id,
      defHash: live.defHash,
      decision: "reject",
      via: "feishu",
      offerId: live.offerId,
    });
    expect(res).toEqual({ kind: "rejected", removed: true });
    expect(readTasks()).toHaveLength(0);
    expect(h.revoked).toEqual([t.id]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.text).toContain("已删除");
  });

  it("gate refusals pass through (E_NOT_OWNER)", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const { t, live } = await offered(h);
    env.sidRef.id = "019a9999-aaaa-7bbb-8ccc-dddddddddddd";
    const res = await h.confirm.decide({
      taskId: t.id,
      defHash: live.defHash,
      decision: "approve",
      via: "feishu",
      offerId: live.offerId,
    });
    expect(res).toMatchObject({ kind: "refused", code: "E_NOT_OWNER" });
    env.sidRef.id = env.agent.sessionId!;
    expect(isApproved(readTasks()[0]!)).toBe(false);
  });
});

describe("revalidate()", () => {
  it("closes as approved/elsewhere when the ledger is approved outside confirm (agent.changed ⇒ synchronous)", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const t = await aiTask();
    h.confirm.offer(t, createOrigin);
    await approveTask(env.agent.store()!, t.id, defHash(t), "web");
    env.agent.changed();
    expect(h.confirm.liveOffer(t.id)).toBeUndefined();
    expect(h.published.at(-1)!.closed[0]).toMatchObject({ outcome: "approved", by: "elsewhere" });
    expect(h.notices[0]!.details).toMatchObject({ outcome: "approved", by: "elsewhere" });
  });

  it("a foreign process's write is found by the 15 s poll", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const t = await aiTask();
    h.confirm.offer(t, createOrigin);
    await approveTask(env.agent.store()!, t.id, defHash(t), "web"); // no agent.changed(): "another process"
    expect(h.confirm.liveOffer(t.id)).toBeDefined();
    env.fake.advance(CONFIRM_REVALIDATE_MS);
    expect(h.confirm.liveOffer(t.id)).toBeUndefined();
  });

  it("task deleted ⇒ withdrawn; definition changed ⇒ superseded; TTL ⇒ expired (no notice for any)", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const a = await aiTask({ name: "a", prompt: "a" });
    const b = await aiTask({ name: "b", prompt: "b" });
    const c = await aiTask({ name: "c", prompt: "c" });
    for (const t of [a, b, c]) h.confirm.offer(t, createOrigin);
    const { deleteTask } = await import("../../../src/schedule/agent/ops.js");
    await deleteTask(env.agent.store()!, a.id);
    await updateTask(env.ports, b.id, { prompt: "b2" }, AI);
    env.agent.changed();
    const outcomes = Object.fromEntries(h.published.at(-1)!.closed.map((x: any) => [x.taskId, x.outcome]));
    expect(outcomes).toEqual({ [a.id]: "withdrawn", [b.id]: "superseded" });
    env.fake.advance(SCHED_CONFIRM_TTL_MS + 1);
    expect(h.published.at(-1)!.closed.find((x: any) => x.taskId === c.id)).toMatchObject({ outcome: "expired" });
    expect(h.notices).toHaveLength(0);
  });

  it("an unreadable ledger never closes an offer", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const t = await aiTask();
    h.confirm.offer(t, createOrigin);
    const real = env.agent.readState;
    env.agent.readState = () => ({ kind: "degraded", reason: "io", detail: "x" }) as never;
    env.agent.changed();
    env.fake.advance(CONFIRM_REVALIDATE_MS);
    expect(h.confirm.liveOffer(t.id)).toBeDefined();
    env.agent.readState = real;
  });

  it("closed echo is kept 120 s, then dropped; onHubCaps re-publishes the full (even empty) list", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true, ui: false });
    const t = await aiTask();
    h.confirm.offer(t, createOrigin);
    const live = h.confirm.liveOffer(t.id)!;
    await h.confirm.decide({
      taskId: t.id,
      defHash: live.defHash,
      decision: "reject",
      via: "feishu",
      offerId: live.offerId,
    });
    const n = h.published.length;
    h.confirm.onHubCaps();
    expect(h.published).toHaveLength(n + 1);
    expect(h.published.at(-1)!.closed).toHaveLength(1);
    env.fake.advance(121_000);
    h.confirm.onHubCaps();
    expect(h.published.at(-1)).toMatchObject({ open: [], closed: [] });
  });
});

describe("TUI presenter", () => {
  async function queued(h: Harness, raw: Record<string, unknown> = {}) {
    const t = await aiTask(raw);
    const r = h.confirm.offer(t, createOrigin);
    expect(r).toBe("offered");
    return t;
  }

  it("opens a three-option select with exactly (title, options) — never a timeout or signal", async () => {
    env = a3Env();
    const h = harness({ e: env });
    const t = await queued(h);
    expect(h.selects).toHaveLength(1);
    const s = h.selects[0]!;
    expect(s.argc).toBe(2);
    expect(s.options).toEqual([CONFIRM_OPT_APPROVE, CONFIRM_OPT_REJECT_DELETE, CONFIRM_OPT_LATER]);
    expect(s.title).toContain(`AI 新建了定时任务 ${t.id}`);
    expect(s.title).toContain(t.prompt);
    expect(s.title).toContain(defHash(t).slice(0, 8));
  });

  it("an AI edit of an approved task offers 'restore' and mentions the invalidated approval", async () => {
    env = a3Env();
    const h = harness({ e: env });
    const t = await aiTask();
    await approveTask(env.agent.store()!, t.id, defHash(t), "tui");
    const u = await updateTask(env.ports, t.id, { prompt: "edit" }, AI);
    if (!u.ok) throw new Error(u.detail);
    h.confirm.offer(u.value, {
      kind: "update",
      base: { form: t.form, when: t.when, prompt: t.prompt, feishu: t.feishu, bg: t.bg! },
      wasApproved: true,
    });
    expect(h.selects[0]!.options[1]).toBe(CONFIRM_OPT_REJECT_RESTORE);
    expect(h.selects[0]!.title).toContain("原批准已失效");
  });

  it("choosing 批准 runs the same CAS: ledger approved, local notice, no re-open", async () => {
    env = a3Env();
    const h = harness({ e: env });
    const t = await queued(h);
    h.answer(0, CONFIRM_OPT_APPROVE);
    await vi.waitFor(() => expect(isApproved(readTasks()[0]!)).toBe(true));
    expect(readTasks()[0]!.approval).toMatchObject({ via: "tui" });
    await vi.waitFor(() => expect(h.notes.some((n) => n.text.includes("已批准"))).toBe(true));
    expect(h.notices).toHaveLength(1);
    expect(h.selects).toHaveLength(1);
    expect(h.confirm.liveOffer(t.id)).toBeUndefined();
  });

  it("choosing 批准 after the definition changed ⇒ E_REV warning, nothing approved", async () => {
    env = a3Env();
    const h = harness({ e: env });
    const t = await queued(h);
    await updateTask(env.ports, t.id, { prompt: "edit while the box is open" }, AI);
    h.answer(0, CONFIRM_OPT_APPROVE);
    await vi.waitFor(() => expect(h.notes.some((n) => n.text.startsWith("E_REV"))).toBe(true));
    expect(isApproved(readTasks()[0]!)).toBe(false);
  });

  it("choosing 拒绝 deletes an AI-created task", async () => {
    env = a3Env();
    const h = harness({ e: env });
    await queued(h);
    h.answer(0, CONFIRM_OPT_REJECT_DELETE);
    await vi.waitFor(() => expect(readTasks()).toHaveLength(0));
    expect(h.revoked).toHaveLength(1);
  });

  it("稍后 / Esc: not re-opened, pointer to /schedule approve; the task stays pending", async () => {
    env = a3Env();
    const h = harness({ e: env });
    const t = await queued(h);
    h.answer(0, CONFIRM_OPT_LATER);
    await vi.waitFor(() => expect(h.notes.some((n) => n.text.includes(`/schedule approve ${t.id}`))).toBe(true));
    h.confirm.onAgentSettled();
    env.fake.advance(10_000);
    expect(h.selects).toHaveLength(1);
    expect(h.confirm.liveOffer(t.id)).toBeDefined();
  });

  it("does not open during a turn; opens after agent_settled", async () => {
    env = a3Env();
    const h = harness({ e: env });
    h.confirm.onBeforeAgentStart();
    await queued(h);
    expect(h.selects).toHaveLength(0);
    env.fake.advance(10_000); // polling alone never opens it
    expect(h.selects).toHaveLength(0);
    h.confirm.onAgentSettled();
    expect(h.selects).toHaveLength(1);
  });

  it("waits while pi is not idle (polls) and while an external ui prompt is open", async () => {
    env = a3Env();
    const h = harness({ e: env });
    h.ui.idle = false;
    await queued(h);
    expect(h.selects).toHaveLength(0);
    h.ui.idle = true;
    env.fake.advance(3_000);
    expect(h.selects).toHaveLength(1);
    h.answer(0, CONFIRM_OPT_LATER);
    await tick();

    h.confirm.onUiPrompt(true, { kind: "confirm", title: "other dialog" });
    await queued(h, { name: "two", prompt: "two" });
    expect(h.selects).toHaveLength(1);
    h.confirm.onUiPrompt(false, { kind: "confirm", title: "other dialog" });
    expect(h.selects).toHaveLength(2);
  });

  it("our own box's ui_prompt events never count as an external prompt", async () => {
    env = a3Env();
    const h = harness({ e: env });
    await queued(h);
    const title = h.selects[0]!.title;
    h.confirm.onUiPrompt(true, { kind: "select", title });
    h.answer(0, CONFIRM_OPT_LATER);
    await tick();
    h.confirm.onUiPrompt(false, { kind: "select", title });
    await queued(h, { name: "two", prompt: "two" });
    expect(h.selects).toHaveLength(2);
  });

  it(`stays closed for ${CONFIRM_QUIET_INPUT_MS} ms after the user's last input`, async () => {
    env = a3Env();
    const h = harness({ e: env });
    h.confirm.onInput();
    await queued(h);
    expect(h.selects).toHaveLength(0);
    env.fake.advance(CONFIRM_QUIET_INPUT_MS - 100);
    expect(h.selects).toHaveLength(0);
    env.fake.advance(200);
    expect(h.selects).toHaveLength(1);
  });

  it("FIFO: one box at a time, the next opens after the first is answered", async () => {
    env = a3Env();
    const h = harness({ e: env });
    await queued(h, { name: "one", prompt: "one" });
    await queued(h, { name: "two", prompt: "two" });
    expect(h.selects).toHaveLength(1);
    h.answer(0, CONFIRM_OPT_LATER);
    await vi.waitFor(() => expect(h.selects).toHaveLength(2));
    expect(h.selects[1]!.title).toContain("two");
  });

  it("no local box when !hasUI, or in rpc while the hub channel is ready; rpc without hub falls back to it", async () => {
    env = a3Env();
    const h1 = harness({ e: env, ui: false, hub: true });
    await queued(h1);
    expect(h1.selects).toHaveLength(0);
    confirm?.dispose();

    const h2 = harness({ e: env, mode: "rpc", hub: true });
    await queued(h2, { name: "r", prompt: "r" });
    expect(h2.selects).toHaveLength(0);
    confirm?.dispose();

    const h3 = harness({ e: env, mode: "rpc", hub: false });
    await queued(h3, { name: "r3", prompt: "r3" });
    expect(h3.selects).toHaveLength(1);
  });

  it("closing the offer elsewhere while the box is showing only notifies — the box is never aborted", async () => {
    env = a3Env();
    const h = harness({ e: env });
    const t = await queued(h);
    await approveTask(env.agent.store()!, t.id, defHash(t), "web");
    env.agent.changed();
    expect(h.confirm.liveOffer(t.id)).toBeUndefined();
    expect(h.notes.some((n) => n.text.includes("已在") && n.text.includes("批准"))).toBe(true);
    expect(h.selects[0]!.argc).toBe(2); // still no signal/timeout bag
    // a later click on the stale box ⇒ already-approved, no side effect
    h.answer(0, CONFIRM_OPT_APPROVE);
    await vi.waitFor(() => expect(h.notes.some((n) => n.text.includes("已在其他入口批准"))).toBe(true));
    expect(readTasks()[0]!.approval).toMatchObject({ via: "web" });
  });

  it("superseded while showing ⇒ notify; the replacement offer is asked after the stale box is dismissed", async () => {
    env = a3Env();
    const h = harness({ e: env });
    const t = await queued(h);
    const u = await updateTask(env.ports, t.id, { prompt: "v2" }, AI);
    if (!u.ok) throw new Error(u.detail);
    h.confirm.offer(u.value, {
      kind: "update",
      base: { form: t.form, when: t.when, prompt: t.prompt, feishu: t.feishu },
    });
    expect(h.notes.some((n) => n.text.includes("定义已变更"))).toBe(true);
    expect(h.selects).toHaveLength(1);
    h.answer(0, CONFIRM_OPT_LATER);
    await vi.waitFor(() => expect(h.selects).toHaveLength(2));
    expect(h.selects[1]!.title).toContain("v2");
  });

  it("dispose() withdraws everything, publishes it, and does not touch a box already on screen", async () => {
    env = a3Env();
    const h = harness({ e: env, hub: true });
    const t = await queued(h);
    h.confirm.dispose();
    expect(h.published.at(-1)).toMatchObject({
      open: [],
      closed: [expect.objectContaining({ taskId: t.id, outcome: "withdrawn" })],
    });
    expect(h.notices).toHaveLength(0);
    expect(h.notes).toHaveLength(0); // no "closed elsewhere" notify for our own teardown
    // the pending select is simply abandoned: answering it later does not approve anything
    h.answer(0, CONFIRM_OPT_APPROVE);
    await tick();
    expect(isApproved(readTasks()[0]!)).toBe(false);
  });
});
