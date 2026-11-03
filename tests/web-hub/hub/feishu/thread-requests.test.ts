import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupF6, f6Rig, OWNER } from "../../../fixtures/feishu/f6.js";
import {
  createFeishuRequests,
  feishuBatchIdentity,
  type FeishuRequestEvent,
} from "../../../../src/web-hub/hub/feishu/requests.js";
import { createFeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import {
  feishuThreadHandle,
  feishuThreadMetaFor,
  parseThreadRoutedResult,
  type FeishuThreadGate,
} from "../../../../src/web-hub/hub/feishu/thread-hub.js";
import type { FeishuRequestRecord } from "../../../../src/web-hub/hub/feishu/state.js";
import type { CmdFrame, CmdResultFrame } from "../../../../src/web-hub/protocol/messages.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";
import { systemFeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";

const RUN = { runId: "r_23456789", label: "worker" };
const ROUTED_DATA = {
  op: "prompt",
  delivery: "observed",
  behavior: "followUp",
  thread: { outcome: "routed", runs: [RUN] },
};
const routedResult = (id: string): CmdResultFrame => ({
  t: "cmd_result",
  rid: "",
  id,
  ok: true,
  data: ROUTED_DATA as never,
});

const extraDisposals: Array<() => void> = [];
afterEach(async () => {
  for (const fn of extraDisposals.splice(0).reverse()) fn();
  await cleanupF6();
});

/** f6Rig provides state/admission/sessions; requests is REBUILT here with the thread gate so
 *  the shared fixture stays untouched (P2 file domain). */
async function threadRig(options: { caps?: string[]; overRetain?: boolean } = {}) {
  const base = await f6Rig({ debounceMs: 1_500 });
  const caps = options.caps ?? ["thr.v1"];
  let overRetain = options.overRetain ?? false;
  const order: string[] = [];
  const detachRun = vi.fn((id: string) => order.push(`detach:${id}`));
  const gate: FeishuThreadGate & { setOverRetain(v: boolean): void } = {
    metaFor: (record, agentKey) =>
      feishuThreadMetaFor({ record, agentKey, installSecret: base.install()!.installSecret, agentCaps: caps }),
    routedResultOk: (data, agentKey) => (caps.includes("thr.v1") ? parseThreadRoutedResult(data) : undefined),
    retainWouldExceed: () => overRetain,
    setOverRetain: (v) => (overRetain = v),
  };
  const events: FeishuRequestEvent[] = [];
  const requests = createFeishuRequests({
    state: base.state,
    installation: base.install,
    admission: base.admission,
    clock: base.clock,
    debounceMs: 1_500,
    staleMessageS: 300,
    emit: (e) => events.push(e),
    threads: gate,
    detachRun,
  });
  extraDisposals.push(() => requests.dispose());
  // Group-topic binding for the thread tests (f6 binds p2p only).
  base.state.bindings.set("grp:chat:t1", {
    chatId: "chat",
    chatType: "group",
    threadId: "t1",
    sessionId: "session-1",
    offline: null,
  });
  await base.state.commit();
  const input = (id: string, body = id, over: Partial<Parameters<typeof base.input>[0]> = {}) =>
    ({
      ...base.input(id, body),
      bindingKey: "grp:chat:t1",
      bindingRev: base.state.bindings.get("grp:chat:t1")!.rev,
      chatType: "group" as const,
      threadId: "t1",
      ...over,
    }) as Parameters<typeof base.input>[0];
  const receive = async (id: string, body = id, over = {}) => {
    const result = requests.receive(input(id, body, over));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("receive refused");
    await base.state.commit();
    requests.release(result.value.id);
    return result.value.id;
  };
  const dispatchRouted = async (id: string) => {
    base.request.mockImplementationOnce(async (frame: CmdFrame) => routedResult(frame.id));
    await requests.flushChat("chat");
  };
  return { ...base, requests, events, detachRun, order, gate, input, receive, dispatchRouted, caps };
}

describe("§4.2 cmd.thread attach", () => {
  it("attaches the meta only for group topics with the agent cap; the event carries the candidate flag", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    const frame = r.request.mock.calls[0]![0] as CmdFrame;
    expect(frame.cmd.op === "prompt" && frame.cmd.thread).toEqual({
      h: feishuThreadHandle("a-secret-key", "grp:chat:t1"),
      label: "Private",
      sentAt: expect.any(Number),
    });
    expect(r.events.find((e) => e.type === "dispatching")).toMatchObject({ thread: true });
  });
  it("a thb:/main: synthetic member sets bypass and drops the candidate flag", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello", {
      payload: { body: "hello", messageIds: ["thb:fs" + "a".repeat(30)], uploadIds: [] },
    });
    await r.dispatchRouted(id);
    const frame = r.request.mock.calls[0]![0] as CmdFrame;
    expect(frame.cmd.op === "prompt" && frame.cmd.thread?.bypass).toBe(true);
    expect(r.events.find((e) => e.type === "dispatching")).not.toHaveProperty("thread");
  });
  it("a cap-less agent gets NO thread field — byte-identical frame (G2b)", async () => {
    const r = await threadRig({ caps: ["cmd.v1"] });
    const id = await r.receive("m1", "hello");
    r.request.mockImplementationOnce(async (frame: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: frame.id,
      ok: true,
      data: { op: "prompt", delivery: "observed" } as never,
    }));
    await r.requests.flushChat("chat");
    const frame = r.request.mock.calls[0]![0] as CmdFrame;
    expect(frame.cmd.op === "prompt" && "thread" in frame.cmd).toBe(false);
    expect(r.state.requests.get(id)?.state).toBe("accepted"); // plain path, no thr: code
  });
});

describe("§8.1 routed branch", () => {
  it("detaches BEFORE the migration, then accepted{thr:routed} and the routed event after commit", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    const record = r.state.requests.get(id)!;
    expect(record.state).toBe("accepted");
    expect(record.code).toBe("thr:routed");
    expect(record.payload?.body).toBe("hello"); // retained (non-terminal keeps payload)
    expect(r.events.at(-1)).toMatchObject({ type: "routed", runs: [RUN], retained: true, recovered: false });
    expect(r.order[0]).toBe(`detach:${id}`);
    expect(r.detachRun).toHaveBeenCalledTimes(1);
  });
  it("commit failure parks the receipt — the routed event fires only after the retry", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    // commit#1 (dispatching) succeeds; commit#2 (the routed migration) fails ⇒ park.
    const commit = vi.spyOn(r.state, "commit").mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    r.request.mockImplementationOnce(async (frame: CmdFrame) => routedResult(frame.id));
    await r.requests.flushChat("chat");
    expect(r.state.requests.get(id)?.code).toBe("thr:routed"); // in-memory already migrated
    expect(r.events.find((e) => e.type === "routed")).toBeUndefined(); // no receipt yet
    await r.requests.retryPending();
    commit.mockRestore();
    expect(r.events.find((e) => e.type === "routed")).toMatchObject({ retained: true });
  });
  it("§8.2 over-cap ⇒ immediate replied{thread-routed}, payload dropped, routed event retained:false", async () => {
    const r = await threadRig({ overRetain: true });
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    const record = r.state.requests.get(id)!;
    expect(record.state).toBe("replied");
    expect(record.code).toBe("thread-routed");
    expect(record.payload).toBeUndefined();
    expect(r.events.find((e) => e.type === "routed")).toMatchObject({ retained: false });
  });
  it("a format-invalid thread result falls back to the plain accepted path", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    r.request.mockImplementationOnce(async (frame: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: frame.id,
      ok: true,
      data: { op: "prompt", delivery: "observed", thread: { outcome: "nope", runs: [] } } as never,
    }));
    await r.requests.flushChat("chat");
    const record = r.state.requests.get(id)!;
    expect(record.state).toBe("accepted");
    expect(record.code).toBeUndefined();
    expect(r.detachRun).not.toHaveBeenCalled();
  });
  it("§8.1 lateRouted: uncertain + a routed cmd_late ⇒ the same branch (recovered)", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    r.state.requests.transition(id, "dispatching");
    r.state.requests.transition(id, "uncertain", { code: "router-threw" });
    await r.state.commit();
    await r.requests.lateRouted(id, ROUTED_DATA, "agent-1");
    expect(r.state.requests.get(id)).toMatchObject({ state: "accepted", code: "thr:routed" });
    expect(r.events.find((e) => e.type === "routed")).toMatchObject({ recovered: true });
  });
  it("lateRouted ignores dispatching/non-routed data", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    r.state.requests.transition(id, "dispatching");
    await r.requests.lateRouted(id, ROUTED_DATA, "agent-1");
    expect(r.state.requests.get(id)?.state).toBe("dispatching");
    r.state.requests.transition(id, "uncertain", { code: "router-threw" });
    await r.requests.lateRouted(id, { op: "prompt", delivery: "observed" }, "agent-1");
    expect(r.state.requests.get(id)?.state).toBe("uncertain");
  });
});

describe("§4.10 generation recheck (rebind-plan r3, P1): A11/A11b", () => {
  const REBOUND = {
    chatId: "chat",
    chatType: "group" as const,
    threadId: "t1",
    sessionId: "session-2",
    offline: null,
  };
  it("A11: a routed result arriving after a rebind finalizes via the LEGAL dispatching→accepted→replied chain", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    // The rebind lands BETWEEN the forward and the routed result.
    r.request.mockImplementationOnce(async (frame: CmdFrame) => {
      r.state.bindings.set("grp:chat:t1", REBOUND);
      return routedResult(frame.id);
    });
    const transitionLog: Array<{ to: unknown; ok: boolean }> = [];
    const rawTransition = r.state.requests.transition.bind(r.state.requests);
    const spy = vi
      .spyOn(r.state.requests, "transition")
      .mockImplementation((...args: Parameters<typeof rawTransition>) => {
        const result = rawTransition(...args);
        transitionLog.push({ to: args[1], ok: result.ok });
        return result;
      });
    const commitSpy = vi.spyOn(r.state, "commit");
    await r.requests.flushChat("chat");
    spy.mockRestore();
    const record = r.state.requests.get(id)!;
    expect(record).toMatchObject({ state: "replied", code: "thread-closed" });
    expect(record.payload).toBeUndefined(); // terminal drops the payload
    // The full chain was legal — dispatching→accepted (silent waypoint) →replied, every step ok.
    expect(transitionLog).toEqual([
      { to: "dispatching", ok: true },
      { to: "accepted", ok: true },
      { to: "replied", ok: true },
    ]);
    // No routed/accepted event ever emitted, no retention armed; detachRun ran FIRST.
    expect(r.events.find((e) => e.type === "routed")).toBeUndefined();
    expect(r.events.find((e) => e.type === "accepted")).toBeUndefined();
    expect(r.detachRun).toHaveBeenCalledTimes(1);
    expect(r.order[0]).toBe(`detach:${id}`);
    // Exactly two commits over the flush: the dispatching barrier + the closedByRebind barrier.
    expect(commitSpy).toHaveBeenCalledTimes(2);
  });
  it("A11: a matched generation still takes the routed branch (control)", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    expect(r.state.requests.get(id)).toMatchObject({ state: "accepted", code: "thr:routed" });
    expect(r.events.find((e) => e.type === "routed")).toBeDefined();
  });
  it("A11b: uncertain + a generation-mismatched late routed ⇒ closedByRebind (uncertain→accepted→replied, no emit)", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    r.state.requests.transition(id, "dispatching");
    r.state.requests.transition(id, "uncertain", { code: "router-threw" });
    await r.state.commit();
    // The rebind lands while the request sits uncertain.
    r.state.bindings.set("grp:chat:t1", REBOUND);
    await r.state.commit();
    await r.requests.lateRouted(id, ROUTED_DATA, "agent-1");
    expect(r.state.requests.get(id)).toMatchObject({ state: "replied", code: "thread-closed" });
    expect(r.events.find((e) => e.type === "routed")).toBeUndefined();
    expect(r.detachRun).toHaveBeenCalledTimes(1);
  });
});

describe("§8.3 handback (S4b–S4d)", () => {
  const note = { note: "超范围", by: RUN, sessionId: "session-1", ctx: { installGen: 1, tenantKey: "tenant" } };
  it("S4b① first delivery then an identical retry ⇒ same requestId, dup, ONE successor", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    const first = await r.requests.handback({ ...note, eventId: id });
    expect(first).toEqual({ ok: true, requestId: feishuBatchIdentity([`thb:${id}`]).id });
    const source = r.state.requests.get(id)!;
    expect(source).toMatchObject({ state: "replied", code: "thread-handback" });
    const successor = r.state.requests.get(feishuBatchIdentity([`thb:${id}`]).id)!;
    expect(successor.state).toBe("received");
    expect(successor.payload?.body.startsWith("[thread handback · @worker（run_id: r_23456789）")).toBe(true);
    expect(successor.payload?.body.endsWith("hello")).toBe(true);
    expect(successor.payload?.messageIds).toEqual([`thb:${id}`]);
    expect(successor.sourceCreatedAt).toBeGreaterThan(0);
    const retry = await r.requests.handback({ ...note, eventId: id });
    expect(retry).toEqual({ ok: true, requestId: feishuBatchIdentity([`thb:${id}`]).id, dup: true });
    expect(r.state.requests.list().filter((x) => x.payload?.messageIds.includes(`thb:${id}`)).length).toBe(1);
  });
  it("S4b② commit failure ⇒ E_THR_STATE{unknown}; the retry crosses the barrier and gets dup", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    const commit = vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    const failed = await r.requests.handback({ ...note, eventId: id });
    expect(failed).toEqual({ ok: false, code: "E_THR_STATE", effect: "unknown" });
    commit.mockRestore();
    const retry = await r.requests.handback({ ...note, eventId: id });
    expect(retry).toMatchObject({ ok: true, dup: true });
    expect(r.state.requests.list().filter((x) => x.payload?.messageIds.includes(`thb:${id}`)).length).toBe(1);
  });
  it("S4b③ concurrent co-subscriber + system return ⇒ one successor, three identical requestIds", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    const a = await r.requests.handback({ ...note, eventId: id });
    const b = await r.requests.handback({ ...note, eventId: id, by: { runId: "r_3456789A", label: "second" } });
    const c = await r.requests.handback({ ...note, eventId: id, by: "system" });
    expect(new Set([a, b, c].map((x) => (x.ok ? x.requestId : "err"))).size).toBe(1);
    expect(b).toMatchObject({ ok: true, dup: true });
    expect(c).toMatchObject({ ok: true, dup: true });
  });
  it("S4b④ successor established, then the sender is denied ⇒ E_THR_REVOKED; effect none while received", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    await r.requests.handback({ ...note, eventId: id });
    r.state.allowList.remove(OWNER);
    const denied = await r.requests.handback({ ...note, eventId: id });
    expect(denied).toEqual({ ok: false, code: "E_THR_REVOKED", effect: "none" });
    const sid = feishuBatchIdentity([`thb:${id}`]).id;
    r.state.requests.transition(sid, "dispatching");
    const afterDispatch = await r.requests.handback({ ...note, eventId: id });
    expect(afterDispatch).toEqual({ ok: false, code: "E_THR_REVOKED", effect: "unknown" });
  });
  it("E_THR_HANDBACK_GONE for an expired/released source; E_THR_REBOUND for a rebound binding; E_THR_REVOKED for the source sender", async () => {
    const r = await threadRig();
    const gone = await r.receive("m1", "hello");
    await r.dispatchRouted(gone);
    r.state.requests.transition(gone, "replied", { code: "thread-routed" });
    await r.state.commit();
    expect(await r.requests.handback({ ...note, eventId: gone })).toEqual({
      ok: false,
      code: "E_THR_HANDBACK_GONE",
      effect: "none",
    });
    const rebound = await r.receive("m2", "hello");
    await r.dispatchRouted(rebound);
    r.state.bindings.set("grp:chat:t1", {
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      sessionId: "session-2",
      offline: null,
    });
    await r.state.commit();
    expect(await r.requests.handback({ ...note, eventId: rebound })).toEqual({
      ok: false,
      code: "E_THR_REBOUND",
      effect: "none",
    });
    // Re-point the binding at session-1 again (the REBOUND probe above moved it to session-2),
    // so the new record is received against the restored rev.
    r.state.bindings.set("grp:chat:t1", {
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      sessionId: "session-1",
      offline: null,
    });
    await r.state.commit();
    const revoked = await r.receive("m3", "hello");
    await r.dispatchRouted(revoked);
    r.state.allowList.remove(OWNER);
    expect(await r.requests.handback({ ...note, eventId: revoked })).toEqual({
      ok: false,
      code: "E_THR_REVOKED",
      effect: "none",
    });
  });
  it("a wrong-session caller is refused before anything is written", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    expect(await r.requests.handback({ ...note, eventId: id, sessionId: "session-other" })).toMatchObject({
      ok: false,
      code: "E_THR_STATE",
    });
  });
});

describe("§8.2 revocation sweep", () => {
  it("revokeSender finalizes retained thr:routed as replied{thread-revoked}", async () => {
    const r = await threadRig();
    const id = await r.receive("m1", "hello");
    await r.dispatchRouted(id);
    await r.requests.revokeSender(OWNER);
    expect(r.state.requests.get(id)).toMatchObject({ state: "replied", code: "thread-revoked" });
    expect(r.state.allowList.has(OWNER)).toBe(false);
  });
});

describe("state round-trip (T-state ① precondition)", () => {
  it("an accepted{thr:routed} record reloads through the UNMODIFIED parser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feishu-thr-state-"));
    extraDisposals.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const clock = createFakeClock(1_790_000_000_000);
    const state = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
    await state.load();
    await state.adoptInstall({ appId: "cli_test", ownerOpenId: OWNER });
    state.tenant.pin("tenant");
    const ids = feishuBatchIdentity(["m1"]);
    const record: Parameters<typeof state.requests.receive>[0] = {
      ...ids,
      sessionId: "session-1",
      bindingKey: "grp:chat:t1",
      bindingRev: 1,
      senderOpenId: OWNER,
      senderDisplay: "Owner",
      chatLabel: "Proj",
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      triggerMessageId: "m1",
      textDigest: "d".repeat(64),
      payload: { body: "hello", messageIds: ["m1"], uploadIds: [] },
      sourceCreatedAt: clock.now(),
      installGen: 1,
      tenantKey: "tenant",
    };
    expect(state.requests.receive(record).ok).toBe(true);
    state.requests.transition(ids.id, "dispatching");
    state.requests.transition(ids.id, "accepted", { code: "thr:routed" });
    expect(await state.commit()).toBe(true);
    state.dispose();
    const reload = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
    const outcome = await reload.load();
    expect(outcome).toMatchObject({ kind: "loaded" });
    const parsed = reload.requests.get(ids.id) as FeishuRequestRecord;
    expect(parsed).toMatchObject({ state: "accepted", code: "thr:routed" });
    expect(parsed.payload?.body).toBe("hello");
    reload.dispose();
  });
});
