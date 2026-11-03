/**
 * 飞书话题换绑方案 r3 (P1) — hub 侧 rebind/acquire 业务逻辑验收：A1/A2/A4/A5/A6/A7/A7b/A8/
 * A11c/A14/A15/A19 + §4.4 请求去重（pending/replay）+ §4.1 off 门。
 *
 * A11/A11b（routedOutcome / lateRouted 的代际复核）在 thread-requests.test.ts；session-selector
 * 阶梯单测在 session-selector.test.ts；A3/A3b/A3c/A1b 已由 bindings-transfer.test.ts 覆盖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeishuState, FEISHU_STATE_FILE, type FeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import {
  createFeishuThreads,
  feishuThreadHandle,
  THREAD_REBIND_RATE_PER_MIN,
  type FeishuThreads,
} from "../../../../src/web-hub/hub/feishu/thread-hub.js";
import { createBindingTransfer, type BindingTransfer } from "../../../../src/web-hub/hub/feishu/bindings-transfer.js";
import {
  createFeishuRequests,
  type FeishuRequestEvent,
  type FeishuRequests,
} from "../../../../src/web-hub/hub/feishu/requests.js";
import { systemFeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import { createFakeClock, settle, type FakeClock } from "../../../fixtures/feishu/fake-http.js";
import { OWNER } from "../../../fixtures/feishu/f6.js";
import type { FeishuSessionView } from "../../../../src/web-hub/hub/feishu/sessions.js";
import type { FeishuInstallation } from "../../../../src/web-hub/hub/feishu/admission.js";
import type {
  ThrAcquireReqFrame,
  ThrRebindReqFrame,
  ThrReqFrame,
  ThrResFrame,
} from "../../../../src/web-hub/protocol/thread.js";

const NOW = 1_790_000_000_000;
const SECRET = "s";
const KEY = "grp:chat:t1";
const CONFIG = {
  handbackWindowMin: 10,
  startTimeoutMin: 8,
  retainMin: 15,
  replyPerThreadPerMin: 6,
  replyPerThreadPerHour: 60,
};
const H = (key: string = KEY) => feishuThreadHandle(SECRET, key);

const dirs: string[] = [];
const disposers: Array<() => void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of disposers.splice(0).reverse()) fn();
  for (const d of dirs.splice(0).reverse()) await rm(d, { recursive: true, force: true });
});

interface Rig {
  dir: string;
  clock: FakeClock;
  state: FeishuState;
  threads: FeishuThreads;
  transfer: BindingTransfer;
  requests: FeishuRequests | undefined;
  views: FeishuSessionView[];
  aliases: Map<string, string>;
  sent: Array<{ agentKey: string; frame: unknown }>;
  reconcile: ReturnType<typeof vi.fn>;
  events: FeishuRequestEvent[];
  call(agentKey: string, frame: ThrReqFrame): Promise<ThrResFrame[]>;
  rebindFrame(over?: Partial<ThrRebindReqFrame>): ThrRebindReqFrame;
  acquireFrame(over?: Partial<ThrAcquireReqFrame>): ThrAcquireReqFrame;
  seedRetained(id: string): void;
}

async function rig(options: { rebind?: boolean; withRequests?: boolean } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "feishu-rebind-"));
  dirs.push(dir);
  const clock = createFakeClock(NOW);
  const state = createFeishuState({ dir, groupCommitMs: 0, clock: { ...systemFeishuClock, now: clock.now } });
  disposers.push(() => state.dispose());
  await state.load();
  await state.adoptInstall({ appId: "cli_test", ownerOpenId: OWNER });
  state.tenant.pin("tenant");
  const views: FeishuSessionView[] = [
    {
      sessionId: "session-1",
      agentKey: "agent-1",
      cwd: "/router",
      name: "Router",
      mode: "tui",
      live: true,
      state: "idle",
    },
    {
      sessionId: "session-2",
      agentKey: "agent-2",
      cwd: "/worker",
      name: "Worker",
      mode: "tui",
      live: true,
      state: "idle",
    },
  ];
  const aliases = new Map<string, string>();
  const sent: Rig["sent"] = [];
  const reconcile = vi.fn();
  const events: FeishuRequestEvent[] = [];
  const installation: FeishuInstallation = {
    appId: "cli_test",
    gen: 1,
    ownerOpenId: OWNER,
    installSecret: SECRET,
    active: true,
  };
  let transfer!: BindingTransfer;
  let requests: FeishuRequests | undefined;
  const threads = createFeishuThreads({
    clock,
    config: { ...CONFIG, ...(options.rebind === undefined ? {} : { rebind: options.rebind }) },
    state,
    installation: () => installation,
    transport: () => ({
      getCaps: () => ["thr.v1", "thr.rebind.v1"],
      send: (agentKey, frame) => {
        sent.push({ agentKey, frame });
        return true;
      },
    }),
    agentForSession: (sid) => views.find((v) => v.sessionId === sid && v.live)?.agentKey,
    sessionOf: (key) => views.find((v) => v.agentKey === key && v.live)?.sessionId,
    sessionViews: () => views,
    aliasOf: (sid) => aliases.get(sid),
    transfer: () => transfer,
    closedByRebind: (id) => {
      void requests?.closedByRebind(id);
    },
    notice: async () => {},
    enqueueNotice: async () => ({ ok: true, sendIds: [], durable: true, duplicate: false }),
    addReceiptReaction: async () => true,
    reactionsDenied: () => false,
    deleteTypingReaction: async () => {},
    run: (task) => void task(),
    label: (sid) => sid,
    targetFor: (r) => ({ scope: "topic", messageId: r.triggerMessageId }),
    log: () => {},
  });
  disposers.push(() => threads.dispose());
  transfer = createBindingTransfer({
    state,
    threads,
    scheduleConfirm: { reconcile: (sid: string) => reconcile(sid) },
    log: () => {},
  });
  if (options.withRequests === true) {
    requests = createFeishuRequests({
      state,
      installation: () => installation,
      admission: {
        dispatch: async () => {
          throw new Error("dispatch is unused in this rig");
        },
        resolve: () => ({ ok: false as const, code: "offline" as const }),
      },
      clock,
      debounceMs: 1_500,
      staleMessageS: 300,
      emit: (e) => events.push(e),
    });
    disposers.push(() => requests!.dispose());
  }
  state.bindings.set(KEY, {
    chatId: "chat",
    chatType: "group",
    threadId: "t1",
    sessionId: "session-1",
    label: "Topic",
    offline: null,
  });
  await state.commit();
  const replies: ThrResFrame[] = [];
  let ridSeq = 0;
  const api: Rig = {
    dir,
    clock,
    state,
    threads,
    transfer,
    requests,
    views,
    aliases,
    sent,
    reconcile,
    events,
    async call(agentKey, frame) {
      const before = replies.length;
      await threads.thrReq(agentKey, frame, (res) => replies.push(res));
      return replies.slice(before);
    },
    rebindFrame(over = {}) {
      return {
        t: "thr_req",
        rid: `rid-${++ridSeq}`,
        op: "rebind",
        h: H(),
        sessionId: "session-1",
        to: "session-2",
        fromRev: state.bindings.get(KEY)!.rev,
        ...over,
      };
    },
    acquireFrame(over = {}) {
      return { t: "thr_req", rid: `rid-${++ridSeq}`, op: "acquire", h: H(), sessionId: "session-1", ...over };
    },
    seedRetained(id) {
      const received = state.requests.receive({
        id,
        batchId: "b".repeat(64),
        sessionId: "session-1",
        bindingKey: KEY,
        bindingRev: state.bindings.get(KEY)!.rev,
        senderOpenId: OWNER,
        senderDisplay: "Owner",
        chatLabel: "P",
        chatId: "chat",
        chatType: "group",
        threadId: "t1",
        triggerMessageId: "m1",
        textDigest: "d".repeat(64),
        payload: { body: "event", messageIds: [id], uploadIds: [] },
        sourceCreatedAt: NOW,
        installGen: 1,
        tenantKey: "tenant",
      });
      expect(received.ok).toBe(true);
      expect(state.requests.transition(id, "dispatching").ok).toBe(true);
      expect(state.requests.transition(id, "accepted", { code: "thr:routed" }).ok).toBe(true);
      threads.onRouted({ request: state.requests.get(id)!, runs: [], retained: true, recovered: false });
    },
  };
  return api;
}

describe('thr_req{op:"rebind"} (rebind-plan r3 §4.4–§4.6, P1)', () => {
  it("A1: the holder rebinds to a live worker — identity fields preserved, thr_closed exactly once", async () => {
    const r = await rig({ rebind: true });
    const before = r.state.bindings.get(KEY)!;
    const res = await r.call("agent-1", r.rebindFrame({ rid: "r1" }));
    expect(res).toEqual([
      {
        t: "thr_res",
        rid: "r1",
        ok: true,
        data: { rebound: true, h: H(), sessionId: "session-2", rev: before.rev + 1, changed: true, label: "Worker" },
      },
    ]);
    const after = r.state.bindings.get(KEY)!;
    expect(after).toMatchObject({
      sessionId: "session-2",
      rev: before.rev + 1,
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
    });
    expect(after.offline).toBeUndefined();
    expect(r.sent).toEqual([{ agentKey: "agent-1", frame: { t: "thr_closed", h: H(), reason: "rebound" } }]);
    expect(r.reconcile.mock.calls.flat()).toEqual(["session-1", "session-2"]);
  });

  it("A1/§4.6: the `to` ladder accepts a unique prefix, an exact alias and an exact name", async () => {
    const r = await rig({ rebind: true });
    r.aliases.set("session-2", "worker");
    const byPrefix = await r.call("agent-1", r.rebindFrame({ rid: "p1", to: "session" })); // unique? no — two sids
    expect(byPrefix[0]).toMatchObject({ ok: false, code: "E_THR_TARGET_AMBIGUOUS" });
    const byAlias = await r.call(
      "agent-1",
      r.rebindFrame({ rid: "p2", to: "@Worker", fromRev: r.state.bindings.get(KEY)!.rev }),
    );
    expect(byAlias[0]).toMatchObject({ ok: true, data: { sessionId: "session-2" } });
    // hand it back, then resolve by exact name
    await r.call(
      "agent-2",
      r.rebindFrame({ rid: "p3", sessionId: "session-2", to: "session-1", fromRev: r.state.bindings.get(KEY)!.rev }),
    );
    const byName = await r.call(
      "agent-1",
      r.rebindFrame({ rid: "p4", to: "Worker", fromRev: r.state.bindings.get(KEY)!.rev }),
    );
    expect(byName[0]).toMatchObject({ ok: true, data: { sessionId: "session-2" } });
  });

  it("A2: a retained accepted{thr:routed} on the binding finalizes replied{thread-closed} (retainedCount −1)", async () => {
    const r = await rig({ rebind: true });
    r.seedRetained("fs" + "a".repeat(30));
    expect(r.threads.retainedCount).toBe(1);
    await r.call("agent-1", r.rebindFrame({ rid: "r1" }));
    expect(r.state.requests.get("fs" + "a".repeat(30))).toMatchObject({ state: "replied", code: "thread-closed" });
    expect(r.threads.retainedCount).toBe(0);
  });

  it("A4: a stale fromRev is E_THR_STALE — no write, no commit, no thr_closed", async () => {
    const r = await rig({ rebind: true });
    const before = r.state.bindings.get(KEY)!;
    const commitSpy = vi.spyOn(r.state, "commit");
    const res = await r.call("agent-1", r.rebindFrame({ rid: "r1", fromRev: before.rev + 1 }));
    expect(res).toEqual([{ t: "thr_res", rid: "r1", ok: false, code: "E_THR_STALE", effect: "none" }]);
    expect(r.state.bindings.get(KEY)!.rev).toBe(before.rev);
    expect(commitSpy).not.toHaveBeenCalled();
    expect(r.sent).toEqual([]);
  });

  it("A5 (P1 no-op): target = self while still the holder ⇒ changed:false, no write/commit/notify", async () => {
    const r = await rig({ rebind: true });
    const before = r.state.bindings.get(KEY)!;
    const commitSpy = vi.spyOn(r.state, "commit");
    const res = await r.call("agent-1", r.rebindFrame({ rid: "r1", to: "session-1" }));
    expect(res).toEqual([
      {
        t: "thr_res",
        rid: "r1",
        ok: true,
        data: { rebound: true, h: H(), sessionId: "session-1", rev: before.rev, changed: false, label: "Topic" },
      },
    ]);
    expect(r.state.bindings.get(KEY)!.rev).toBe(before.rev);
    expect(commitSpy).not.toHaveBeenCalled();
    expect(r.sent).toEqual([]);
    expect(r.reconcile).not.toHaveBeenCalled();
  });

  it("A6: the four target-resolution failures map to the four codes; the binding is untouched", async () => {
    const r = await rig({ rebind: true });
    r.views.push(
      {
        sessionId: "off-session",
        agentKey: "agent-9",
        cwd: "/x",
        name: "Off",
        mode: "tui",
        live: false,
        state: "idle",
      },
      {
        sessionId: "ro-session",
        agentKey: "agent-8",
        cwd: "/x",
        name: "Ro",
        mode: "tui",
        live: true,
        state: "read-only",
      },
      { sessionId: "ambig-aaa", agentKey: "agent-7", cwd: "/x", name: "A", mode: "tui", live: true, state: "idle" },
      { sessionId: "ambig-bbb", agentKey: "agent-6", cwd: "/x", name: "B", mode: "tui", live: true, state: "idle" },
    );
    const rev = () => r.state.bindings.get(KEY)!.rev;
    const fail = async (to: string, code: string) => {
      const res = await r.call("agent-1", r.rebindFrame({ to, fromRev: rev() }));
      expect(res[0]).toMatchObject({ ok: false, code, effect: "none" });
    };
    await fail("no-such-session", "E_THR_TARGET_UNKNOWN");
    await fail("ambig-", "E_THR_TARGET_AMBIGUOUS"); // 6-unit prefix hitting two sids
    await fail("off-session", "E_THR_TARGET_OFFLINE");
    await fail("ro-session", "E_THR_TARGET_READONLY");
    expect(r.state.bindings.get(KEY)).toMatchObject({ sessionId: "session-1" });
    expect(r.sent).toEqual([]);
  });

  it("A7 (P3): commit failure ⇒ E_THR_COMMIT/unknown; memory moved, disk NOT; no thr_closed; acquire ⇒ E_THR_NO_OWNER", async () => {
    const r = await rig({ rebind: true });
    vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    const res = await r.call("agent-1", r.rebindFrame({ rid: "r1" }));
    expect(res).toEqual([{ t: "thr_res", rid: "r1", ok: false, code: "E_THR_COMMIT", effect: "unknown" }]);
    expect(r.state.bindings.get(KEY)!.sessionId).toBe("session-2"); // memory already moved
    expect(r.sent).toEqual([]); // NO thr_closed without the barrier
    // The disk still has the OLD owner (the failed commit never wrote).
    const disk = JSON.parse(readFileSync(join(r.dir, FEISHU_STATE_FILE), "utf8")) as {
      bindings: Record<string, { sessionId?: string }>;
    };
    expect(disk.bindings[KEY]?.sessionId).toBe("session-1");
    // §4.9 P3: the Router probes with acquire — memory says it is no longer the owner.
    const probe = await r.call("agent-1", r.acquireFrame({ rid: "r2" }));
    expect(probe).toEqual([{ t: "thr_res", rid: "r2", ok: false, code: "E_THR_NO_OWNER", effect: "none" }]);
    // ...and never a changed:false success shape.
    expect(res[0]).not.toMatchObject({ data: { changed: false } });
  });

  it("§4.4: a concurrent duplicate gets E_THR_PENDING/unknown; the in-flight request completes", async () => {
    const r = await rig({ rebind: true });
    let release!: () => void;
    const spy = vi
      .spyOn(r.state, "commit")
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = () => resolve(true))));
    const fromRev = r.state.bindings.get(KEY)!.rev;
    // Per-call reply capture (the shared r.call buffer interleaves under concurrency).
    const one = (frame: ThrReqFrame) =>
      new Promise<ThrResFrame>((resolve) => {
        void r.threads.thrReq("agent-1", frame, resolve);
      });
    const p1 = one(r.rebindFrame({ rid: "p1", fromRev }));
    const dup = await one(r.rebindFrame({ rid: "p2", fromRev }));
    expect(dup).toEqual({ t: "thr_res", rid: "p2", ok: false, code: "E_THR_PENDING", effect: "unknown" });
    release();
    expect(await p1).toMatchObject({ ok: true, data: { rebound: true, changed: true } });
    spy.mockRestore();
  });

  it("A7b (P2): a lost success receipt replays from the dedup table; after LRU eviction it degrades to E_THR_NO_OWNER", async () => {
    const r = await rig({ rebind: true });
    const fromRev = r.state.bindings.get(KEY)!.rev;
    const first = await r.call("agent-1", r.rebindFrame({ rid: "r1", fromRev }));
    expect(first[0]).toMatchObject({ ok: true, data: { rebound: true, changed: true } });
    // Same dedupKey (h/sessionId/to/fromRev), fresh rid ⇒ the ORIGINAL receipt, re-stamped to the new rid.
    const replay = await r.call("agent-1", r.rebindFrame({ rid: "r2", fromRev }));
    expect(replay).toEqual([{ ...first[0]!, rid: "r2" }]);
    expect(replay[0]).not.toMatchObject({ code: "E_THR_NO_OWNER" });
    // Evict the entry with 128 unrelated dedupKeys (distinct h ⇒ distinct per-h rate buckets).
    for (let i = 0; i < 128; i++) {
      const key = `grp:chat:tx${i}`;
      r.state.bindings.set(key, {
        chatId: "chat",
        chatType: "group",
        threadId: `tx${i}`,
        sessionId: "session-1",
        label: `T${i}`,
        offline: null,
      });
      await r.state.commit();
      const res = await r.call(
        "agent-1",
        r.rebindFrame({ h: H(key), to: "session-2", fromRev: r.state.bindings.get(key)!.rev }),
      );
      expect(res[0]).toMatchObject({ ok: true });
    }
    // The evicted dedup entry can no longer replay — the documented degradation is E_THR_NO_OWNER.
    const degraded = await r.call("agent-1", r.rebindFrame({ rid: "r3", fromRev }));
    expect(degraded[0]).toMatchObject({ ok: false, code: "E_THR_NO_OWNER", effect: "none" });
  });

  it("A8: per-h rate limit (3/min + 20/h) — successes AND post-validation failures count; buckets are per-h and independent of post", async () => {
    const r = await rig({ rebind: true });
    expect(THREAD_REBIND_RATE_PER_MIN).toBe(3);
    const revOf = () => r.state.bindings.get(KEY)!.rev;
    // 1: session-1 → session-2 (success counts)
    expect((await r.call("agent-1", r.rebindFrame({ fromRev: revOf() })))[0]).toMatchObject({ ok: true });
    // 2: session-2 → session-1 with a FAILED commit (E_THR_COMMIT — reached the write op ⇒ counts)
    const spy = vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    const failed = await r.call(
      "agent-2",
      r.rebindFrame({ sessionId: "session-2", to: "session-1", fromRev: revOf() }),
    );
    expect(failed[0]).toMatchObject({ ok: false, code: "E_THR_COMMIT" });
    spy.mockRestore();
    // 3: session-1 → session-2 (success counts — that is #3 inside the minute)
    expect((await r.call("agent-1", r.rebindFrame({ fromRev: revOf() })))[0]).toMatchObject({ ok: true });
    // 4: over the 3/min budget ⇒ E_THR_RATE (and it is NOT cached as done — see below)
    const limited = await r.call(
      "agent-2",
      r.rebindFrame({ sessionId: "session-2", to: "session-1", fromRev: revOf() }),
    );
    expect(limited[0]).toMatchObject({ ok: false, code: "E_THR_RATE", effect: "none" });
    // per-h isolation: another thread has a fresh bucket.
    r.state.bindings.set("grp:chat:t2", {
      chatId: "chat",
      chatType: "group",
      threadId: "t2",
      sessionId: "session-2",
      label: "T2",
      offline: null,
    });
    await r.state.commit();
    const other = await r.call(
      "agent-2",
      r.rebindFrame({
        h: H("grp:chat:t2"),
        sessionId: "session-2",
        to: "session-1",
        fromRev: r.state.bindings.get("grp:chat:t2")!.rev,
      }),
    );
    expect(other[0]).toMatchObject({ ok: true });
    // independence from the post buckets: a post on the SAME h is not rate-rejected.
    const post = await r.call("agent-2", {
      t: "thr_req",
      rid: "post-1",
      op: "post",
      h: H(),
      sessionId: "session-2",
      by: { runId: "r_23456789", label: "w" },
      postId: "r_23456789:1",
      text: "hi",
    });
    expect(post[0]).toMatchObject({ ok: false });
    expect(post[0]).not.toMatchObject({ code: "E_THR_RATE" });
    // The minute window slides: the SAME dedupKey as the rate-limited attempt runs fresh
    // (a rate-limited request was never cached as done) and succeeds.
    r.clock.advance(61_000);
    const retry = await r.call("agent-2", r.rebindFrame({ sessionId: "session-2", to: "session-1", fromRev: revOf() }));
    expect(retry[0]).toMatchObject({ ok: true, data: { rebound: true, changed: true } });
  });

  it("A14: a forged sessionId dies at the sessionOf gate (E_THR_STATE); an unknown h is E_THR_NOT_BOUND", async () => {
    const r = await rig({ rebind: true });
    const forged = await r.call("agent-1", r.rebindFrame({ rid: "f1", sessionId: "session-2" }));
    expect(forged).toEqual([{ t: "thr_res", rid: "f1", ok: false, code: "E_THR_STATE", effect: "none" }]);
    const forgedAcquire = await r.call("agent-1", r.acquireFrame({ rid: "f2", sessionId: "session-2" }));
    expect(forgedAcquire).toEqual([{ t: "thr_res", rid: "f2", ok: false, code: "E_THR_STATE", effect: "none" }]);
    const unknown = await r.call("agent-1", r.rebindFrame({ rid: "f3", h: "fs:AAAAAAAAAAAA" }));
    expect(unknown).toEqual([{ t: "thr_res", rid: "f3", ok: false, code: "E_THR_NOT_BOUND", effect: "none" }]);
    expect(r.state.bindings.get(KEY)!.sessionId).toBe("session-1");
    expect(r.sent).toEqual([]);
  });

  it("A15: the holder may transfer ANOTHER topic it holds; a topic it does NOT hold is E_THR_NO_OWNER", async () => {
    const r = await rig({ rebind: true });
    r.state.bindings.set("grp:chat:t2", {
      chatId: "chat",
      chatType: "group",
      threadId: "t2",
      sessionId: "session-1",
      label: "T2",
      offline: null,
    });
    r.state.bindings.set("grp:chat:t3", {
      chatId: "chat",
      chatType: "group",
      threadId: "t3",
      sessionId: "session-2",
      label: "T3",
      offline: null,
    });
    await r.state.commit();
    const held = await r.call(
      "agent-1",
      r.rebindFrame({ h: H("grp:chat:t2"), fromRev: r.state.bindings.get("grp:chat:t2")!.rev }),
    );
    expect(held[0]).toMatchObject({ ok: true, data: { rebound: true, h: H("grp:chat:t2"), sessionId: "session-2" } });
    const notHeld = await r.call(
      "agent-1",
      r.rebindFrame({ h: H("grp:chat:t3"), fromRev: r.state.bindings.get("grp:chat:t3")!.rev }),
    );
    expect(notHeld[0]).toMatchObject({ ok: false, code: "E_THR_NO_OWNER", effect: "none" });
  });

  it("§4.1: a rebind-off hub (flag false OR key absent) answers E_THR_STATE to both ops", async () => {
    for (const rebind of [false, undefined] as const) {
      const r = await rig(rebind === undefined ? {} : { rebind });
      const rb = await r.call("agent-1", r.rebindFrame({ rid: "o1" }));
      expect(rb).toEqual([{ t: "thr_res", rid: "o1", ok: false, code: "E_THR_STATE", effect: "none" }]);
      const acq = await r.call("agent-1", r.acquireFrame({ rid: "o2" }));
      expect(acq).toEqual([{ t: "thr_res", rid: "o2", ok: false, code: "E_THR_STATE", effect: "none" }]);
      expect(r.state.bindings.get(KEY)!.sessionId).toBe("session-1");
      expect(r.sent).toEqual([]);
    }
  });
});

describe('thr_req{op:"acquire"} (rebind-plan r3 §3.2 step 7 / §4.7, P1)', () => {
  it("the current holder gets {owned:true, label, rev}", async () => {
    const r = await rig({ rebind: true });
    const rev = r.state.bindings.get(KEY)!.rev;
    const res = await r.call("agent-1", r.acquireFrame({ rid: "a1" }));
    expect(res).toEqual([{ t: "thr_res", rid: "a1", ok: true, data: { owned: true, h: H(), label: "Topic", rev } }]);
  });

  it("after a rebind the NEW owner acquires (fresh rev); the OLD owner gets E_THR_NO_OWNER", async () => {
    const r = await rig({ rebind: true });
    await r.call("agent-1", r.rebindFrame({ rid: "r1" }));
    const rev = r.state.bindings.get(KEY)!.rev;
    const owned = await r.call("agent-2", r.acquireFrame({ rid: "a1", sessionId: "session-2" }));
    expect(owned).toEqual([{ t: "thr_res", rid: "a1", ok: true, data: { owned: true, h: H(), label: "Worker", rev } }]);
    const old = await r.call("agent-1", r.acquireFrame({ rid: "a2" }));
    expect(old).toEqual([{ t: "thr_res", rid: "a2", ok: false, code: "E_THR_NO_OWNER", effect: "none" }]);
  });

  it("an unknown h is E_THR_NO_OWNER (acquire never reveals existence)", async () => {
    const r = await rig({ rebind: true });
    const res = await r.call("agent-1", r.acquireFrame({ rid: "a1", h: "fs:BBBBBBBBBBBB" }));
    expect(res).toEqual([{ t: "thr_res", rid: "a1", ok: false, code: "E_THR_NO_OWNER", effect: "none" }]);
  });

  it("acquire is not rate-limited and not deduped (read-only probe)", async () => {
    const r = await rig({ rebind: true });
    for (let i = 0; i < THREAD_REBIND_RATE_PER_MIN + 2; i++) {
      const res = await r.call("agent-1", r.acquireFrame());
      expect(res[0]).toMatchObject({ ok: true, data: { owned: true } });
    }
  });
});

describe("§4.10 retention-expiry generation recheck (A11c) + handback regression (A19)", () => {
  it("A11c: retention expiry with a moved generation finalizes replied{thread-closed}, never thread-routed", async () => {
    const r = await rig({ rebind: true, withRequests: true });
    r.seedRetained("fs" + "b".repeat(30));
    await r.state.commit();
    expect(r.threads.retainedCount).toBe(1);
    // A binding write that BYPASSES the lifecycle hooks (the defensive case the recheck exists for).
    r.state.bindings.set(KEY, {
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      sessionId: "session-2",
      offline: null,
    });
    await r.state.commit();
    r.clock.advance(16 * 60_000);
    await settle();
    expect(r.state.requests.get("fs" + "b".repeat(30))).toMatchObject({ state: "replied", code: "thread-closed" });
    expect(r.threads.retainedCount).toBe(0);
  });

  it("A11c control: with an UNMOVED generation the retention timer still finalizes thread-routed", async () => {
    const r = await rig({ rebind: true, withRequests: true });
    r.seedRetained("fs" + "e".repeat(30));
    await r.state.commit();
    r.clock.advance(16 * 60_000);
    await settle();
    expect(r.state.requests.get("fs" + "e".repeat(30))).toMatchObject({ state: "replied", code: "thread-routed" });
  });

  it("A19 (regression): after a rebind the old holder's handback is E_THR_HANDBACK_GONE", async () => {
    const r = await rig({ rebind: true, withRequests: true });
    r.seedRetained("fs" + "c".repeat(30));
    await r.state.commit();
    await r.call("agent-1", r.rebindFrame({ rid: "r1" }));
    expect(r.state.requests.get("fs" + "c".repeat(30))).toMatchObject({ state: "replied", code: "thread-closed" });
    const res = await r.requests!.handback({
      eventId: "fs" + "c".repeat(30),
      sessionId: "session-1",
      by: { runId: "r_23456789", label: "worker" },
      note: "超范围",
      ctx: { installGen: 1, tenantKey: "tenant" },
    });
    expect(res).toEqual({ ok: false, code: "E_THR_HANDBACK_GONE", effect: "none" });
  });
});
