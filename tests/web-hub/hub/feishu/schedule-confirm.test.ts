import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFeishuScheduleConfirm,
  renderScheduleConfirmCard,
  type ScheduleConfirmDeps,
  type ScheduleConfirmStatePort,
} from "../../../../src/web-hub/hub/feishu/schedule-confirm.js";
import type { FeishuNonce, FeishuBinding } from "../../../../src/web-hub/hub/feishu/state.js";
import type { FeishuInstallation, FeishuIdentityContext } from "../../../../src/web-hub/hub/feishu/admission.js";
import type {
  FeishuScheduleOfferRow,
  FeishuScheduleOfferClosed,
  FeishuScheduleRow,
  ScheduleDecideResult,
} from "../../../../src/web-hub/hub/feishu/schedule.js";
import type { HubSchedulePort } from "../../../../src/web-hub/hub/schedule/feishu-port.js";
import { FEISHU_CAPS } from "../../../../src/web-hub/protocol/feishu.js";
import { SCHED_REQ_ID_RE } from "../../../../src/web-hub/protocol/schedule.js";
import { createFakeClock, settle as flush } from "../../../fixtures/feishu/fake-http.js";
import { f8Rig, eventually } from "../../../fixtures/feishu/f8.js";
import {
  callbackEnvelope,
  messageEnvelope,
  OWNER as REAL_OWNER,
  NOW as REAL_NOW,
} from "../../../fixtures/feishu/f6.js";

const NOW = 1_790_000_000_000;
const OWNER = "ou_owner";
const HASH = "a".repeat(64);
const IDENTITY: FeishuIdentityContext = { senderOpenId: OWNER, installGen: 1, tenantKey: "tenant" };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function offer(n = 0, sid = "session-1"): FeishuScheduleOfferRow {
  return {
    sessionId: sid,
    sessionLabel: "日报会话",
    online: true,
    offerId: `offer_${String(n).padStart(16, "0")}`,
    expiresAt: NOW + 100_000 + n,
    defHash: HASH,
    task: {
      id: `s_aaaaaaa${String.fromCharCode(97 + n)}`,
      name: "日报",
      form: "background",
      when: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
      prompt: "汇总项目进展",
      feishu: true,
      enabled: true,
      bg: {
        type: "general",
        timeoutS: 300,
        thinking: "high",
        consultMain: false,
        handoff: true,
        model: { provider: "test", id: "model" },
        isolation: "worktree",
      },
      ownerCwd: "/project",
      createdBy: "agent",
      createdVia: "tool",
      createdAt: NOW,
    },
  };
}
function rig(initial = [offer()]) {
  const clock = createFakeClock(NOW);
  const nonces = new Map<string, FeishuNonce>(),
    bindings = new Map<string, FeishuBinding>(),
    proofs = new Map<string, string>();
  const allowed = new Set([OWNER]);
  let seq = 0,
    tenant = "tenant",
    failed = false;
  let installation: FeishuInstallation = {
    appId: "cli_test",
    installSecret: "test",
    gen: 1,
    ownerOpenId: OWNER,
    active: true,
  };
  let rows = initial,
    closed: FeishuScheduleOfferClosed[] = [],
    ledger: FeishuScheduleRow[] = [];
  let evidence: NonNullable<HubSchedulePort["ledgerTask"]> = () => ({ kind: "unknown", reason: "no-session" });
  const commit = vi.fn(async () => true);
  const state: ScheduleConfirmStatePort = {
    commit,
    persistFailed: () => failed,
    allowList: { has: (id) => allowed.has(id) },
    tenant: { get: () => tenant },
    bindings: { get: (key) => bindings.get(key), list: () => [...bindings.values()] },
    nonces: {
      issue(input, ttl, opts) {
        if (nonces.size >= (opts?.maxTotal ?? FEISHU_CAPS.nonces)) return { ok: false, refused: "cap" };
        const value: FeishuNonce = {
          ...input,
          nonce: `n${String(++seq).padStart(21, "0")}`,
          createdAt: clock.now(),
          expiresAt: opts?.expiresAt ?? clock.now() + (ttl ?? 100_000),
        };
        nonces.set(value.nonce, value);
        return { ok: true, value: { ...value } };
      },
      get: (n) => nonces.get(n),
      list: (f) => [...nonces.values()].filter(f ?? (() => true)),
      purge: (f) => {
        let n = 0;
        for (const [k, r] of nonces) if (f(r) && nonces.delete(k)) n++;
        return n;
      },
      get size() {
        return nonces.size;
      },
    },
  };
  const sendCard = vi.fn<ScheduleConfirmDeps["sendCard"]>(async (_id, target) => {
    const receive = target.scope === "p2p" && target.via === "send" ? target.receiveId : "";
    return { messageId: `message-${sendCard.mock.calls.length}`, chatId: receive };
  });
  const patch = vi.fn<ScheduleConfirmDeps["patch"]>(async () => ({ ok: true, data: undefined }));
  const deleteMessage = vi.fn<ScheduleConfirmDeps["deleteMessage"]>(async () => ({ ok: true, data: undefined }));
  const notice = vi.fn<ScheduleConfirmDeps["notice"]>(async () => {});
  const decide = vi.fn(
    async (_req: Parameters<NonNullable<ScheduleConfirmDeps["port"]["decide"]>>[0]): Promise<ScheduleDecideResult> => ({
      kind: "approved",
    }),
  );
  const admission = vi.fn<ScheduleConfirmDeps["admission"]["callback"]>(() => ({ ok: true }));
  const count = vi.fn();
  const deps: ScheduleConfirmDeps = {
    state,
    clock,
    port: {
      offers: () => rows,
      closedOffers: () => closed,
      list: () => ledger,
      ledgerTask: (sid, taskId, opts) => evidence(sid, taskId, opts),
      decide,
      run: async () => ({ kind: "unavailable" }),
      receiptsChanged: () => {},
    },
    installation: () => installation,
    provenOwner: (b) => proofs.get(b.key) === installation.ownerOpenId,
    admission: { callback: admission },
    ready: () => true,
    link: () => "https://hub.example/#/agent/agent-1",
    sendCard,
    patch,
    deleteMessage,
    notice,
    count,
  };
  function bind(
    chat = "owner-chat",
    sender: string | undefined = OWNER,
    sid = "session-1",
    extra: Partial<FeishuBinding> = {},
  ) {
    const key = extra.chatType === "group" ? `grp:${chat}:thread` : `p2p:${chat}`;
    bindings.set(key, {
      key,
      rev: bindings.size + 1,
      chatId: chat,
      chatType: "p2p",
      sessionId: sid,
      updatedAt: NOW,
      ...extra,
    });
    if (sender !== undefined) proofs.set(key, sender);
    return key;
  }
  bind();
  let kit = createFeishuScheduleConfirm(deps);
  cleanups.push(() => kit.dispose());
  function button(action = "sched-ok", messageId?: string) {
    const n = [...nonces.values()].find(
      (n) => n.action === action && (messageId === undefined || n.messageId === messageId),
    );
    expect(n).toBeDefined();
    return n!;
  }
  function redeem(record: FeishuNonce) {
    expect(nonces.delete(record.nonce)).toBe(true);
    return record;
  }
  return {
    clock,
    deps,
    state,
    commit,
    nonces,
    bindings,
    proofs,
    allowed,
    sendCard,
    patch,
    deleteMessage,
    notice,
    decide,
    admission,
    count,
    bind,
    button,
    redeem,
    get kit() {
      return kit;
    },
    get rows() {
      return rows;
    },
    setRows(v: FeishuScheduleOfferRow[]) {
      rows = v;
    },
    setClosed(v: FeishuScheduleOfferClosed[]) {
      closed = v;
    },
    setEvidence(fn: NonNullable<HubSchedulePort["ledgerTask"]>) {
      evidence = fn;
    },
    setLedger(approved: boolean, hash = HASH) {
      ledger = [
        {
          sessionId: "session-1",
          sessionLabel: "test",
          online: true,
          taskId: offer().task.id,
          name: "test",
          form: "message",
          when: "once",
          enabled: true,
          approved,
          defHash: hash,
        },
      ];
    },
    gen(n: number) {
      installation = { ...installation, gen: n };
    },
    tenant(v: string) {
      tenant = v;
    },
    failed(v: boolean) {
      failed = v;
    },
    restart() {
      kit.dispose();
      kit = createFeishuScheduleConfirm(deps);
    },
  };
}
const text = (r: ReturnType<typeof rig>): string => r.patch.mock.calls.map(([, card]) => card).join("\n");
const close = (
  row: FeishuScheduleOfferRow,
  by = "tui",
  outcome: FeishuScheduleOfferClosed["outcome"] = "approved",
): FeishuScheduleOfferClosed => ({ sessionId: row.sessionId, offerId: row.offerId, by, outcome });

describe("#61 F2 owner-only schedule cards (fake C0 port)", () => {
  it("fail-closed: group/topic/offline/non-owner/missing proof never receive full prompt", async () => {
    const r = rig();
    r.bindings.clear();
    r.allowed.add("ou_other");
    r.bind("group", OWNER, "session-1", { chatType: "group", threadId: "thread" });
    r.bind("offline", OWNER, "session-1", { offline: "lost" });
    r.bind("third-party", "ou_other");
    const unproven = r.bind("unproven");
    r.proofs.delete(unproven);
    await r.kit.reconcile("session-1");
    expect(r.sendCard).not.toHaveBeenCalled();
    expect(r.count).toHaveBeenCalledWith("sched-confirm-no-owner");
    r.bind("proven");
    await r.kit.reconcile("session-1");
    expect(r.sendCard).toHaveBeenCalledTimes(1);
    expect(r.sendCard.mock.calls[0]?.[1]).toEqual({
      scope: "p2p",
      via: "send",
      receiveIdType: "chat_id",
      receiveId: "proven",
    });
  });
  it("owner not in allow-list, bot inactive, and offline offer do not send", async () => {
    const r = rig();
    r.allowed.clear();
    await r.kit.reconcile("session-1");
    expect(r.sendCard).not.toHaveBeenCalled();
    r.allowed.add(OWNER);
    r.setRows([{ ...offer(), online: false }]);
    await r.kit.reconcile("session-1");
    expect(r.sendCard).not.toHaveBeenCalled();
  });
  it("placeholder precedes durable anchor + buttons, which carry gen/tenant/hash/chat/message", async () => {
    const r = rig(),
      gate = deferred<boolean>();
    r.commit.mockReturnValue(gate.promise);
    const work = r.kit.reconcile("session-1");
    await flush(30);
    expect(r.sendCard).toHaveBeenCalledTimes(1);
    expect(r.sendCard.mock.calls[0]?.[0]).toMatch(/^fsc/);
    expect(r.sendCard.mock.calls[0]?.[2]).not.toContain("callback");
    expect(r.patch).not.toHaveBeenCalled();
    expect(r.nonces.size).toBe(3);
    const anchor = [...r.nonces.values()].find((n) => n.action === "sched-card")!;
    expect(JSON.parse(anchor.target)).toMatchObject({
      offerId: offer().offerId,
      defHash: HASH,
      bindingKey: "p2p:owner-chat",
    });
    expect(anchor).toMatchObject({
      installGen: 1,
      tenantKey: "tenant",
      operatorOpenId: OWNER,
      chatId: "owner-chat",
      messageId: "message-1",
      expiresAt: offer().expiresAt,
    });
    gate.resolve(true);
    await work;
    expect(text(r)).toContain("callback");
    expect(text(r)).not.toContain(anchor.nonce);
    expect(text(r)).toContain("timeoutS");
    expect(text(r)).toContain("Asia/Shanghai");
    expect(text(r)).toContain("汇总项目进展");
  });
  it("offer settled during send is recalled after messageId arrives; no stale buttons are published", async () => {
    const r = rig(),
      gate = deferred<{ messageId: string; chatId: string }>();
    r.sendCard.mockReturnValueOnce(gate.promise);
    const opening = r.kit.reconcile("session-1");
    await flush(20);
    r.setRows([]);
    r.setClosed([close(offer())]);
    gate.resolve({ messageId: "late-message", chatId: "owner-chat" });
    await opening;
    expect(r.deleteMessage).toHaveBeenCalledWith("late-message");
    expect(text(r)).not.toContain("callback");
    expect(r.nonces.size).toBe(0);
  });
  it("commit false leaves placeholder without buttons and no decision; recovery can attach", async () => {
    const r = rig();
    r.commit.mockResolvedValue(false);
    await r.kit.reconcile("session-1");
    expect(r.patch).not.toHaveBeenCalled();
    expect(r.decide).not.toHaveBeenCalled();
    r.commit.mockResolvedValue(true);
    await r.kit.reconcile("session-1");
    expect(text(r)).toContain("callback");
  });
  it.each(["non-owner", "generation", "tenant", "rate", "allow"])(
    "callback rejects %s without decide",
    async (kind) => {
      const r = rig();
      await r.kit.reconcile("session-1");
      const n = r.redeem(r.button());
      let identity = IDENTITY;
      if (kind === "non-owner") identity = { ...IDENTITY, senderOpenId: "ou_other" };
      if (kind === "generation") r.gen(2);
      if (kind === "tenant") r.tenant("changed");
      if (kind === "rate") r.admission.mockReturnValue({ ok: false, code: "E_RATE" });
      if (kind === "allow") r.allowed.clear();
      await r.kit.callback(n, identity, "event");
      expect(r.decide).not.toHaveBeenCalled();
    },
  );
  it("approval goes through only port.decide with stable reqId/full hash; sibling and anchor purge", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    await r.kit.callback(r.redeem(r.button()), IDENTITY, "event");
    expect(r.decide).toHaveBeenCalledTimes(1);
    expect(r.decide.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-1",
      taskId: offer().task.id,
      offerId: offer().offerId,
      defHash: HASH,
      decision: "approve",
    });
    expect(SCHED_REQ_ID_RE.test(r.decide.mock.calls[0]![0].reqId)).toBe(true);
    expect(r.nonces.size).toBe(0);
    expect(text(r)).toContain("已通过飞书批准");
    expect(r.deleteMessage).not.toHaveBeenCalled();
  });
  it("reject button forwards reject, displays rollback/deletion terminal", async () => {
    const r = rig();
    r.decide.mockResolvedValue({ kind: "rejected" });
    await r.kit.reconcile("session-1");
    await r.kit.callback(r.redeem(r.button("sched-no")), IDENTITY, "event");
    expect(r.decide.mock.calls[0]?.[0].decision).toBe("reject");
    expect(text(r)).toContain("已通过飞书拒绝");
    expect(r.nonces.size).toBe(0);
  });
  it("double click during decide answers processing and never queues a second decision", async () => {
    const r = rig(),
      gate = deferred<ScheduleDecideResult>();
    r.decide.mockReturnValue(gate.promise);
    await r.kit.reconcile("session-1");
    const first = r.redeem(r.button()),
      second = r.redeem(r.button("sched-no"));
    const work = r.kit.callback(first, IDENTITY, "first");
    await flush(20);
    await r.kit.callback(second, IDENTITY, "second");
    expect(r.notice.mock.calls.at(-1)?.[1]).toBe("处理中，请稍候");
    expect(r.decide).toHaveBeenCalledTimes(1);
    gate.resolve({ kind: "approved" });
    await work;
    expect(text(r)).toContain("已通过飞书批准");
  });
  it("late second click re-reads approved outcome instead of claiming handled elsewhere", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    const first = r.redeem(r.button()),
      second = r.redeem(r.button("sched-no"));
    await r.kit.callback(first, IDENTITY, "first");
    r.setClosed([close(offer(), "feishu")]);
    await r.kit.callback(second, IDENTITY, "second");
    expect(r.decide).toHaveBeenCalledTimes(1);
    expect(r.patch.mock.calls.at(-1)?.[1]).toContain("已批准");
    expect(r.patch.mock.calls.at(-1)?.[1]).not.toContain("已在其他端处理");
  });
  it("purged anchor or superseded hash never submits old hash", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    const n = r.redeem(r.button());
    r.setRows([{ ...offer(), defHash: "b".repeat(64) }]);
    await r.kit.callback(n, IDENTITY, "old");
    expect(r.decide).not.toHaveBeenCalled();
    r.nonces.clear();
    await r.kit.callback(n, IDENTITY, "purged");
    expect(r.decide).not.toHaveBeenCalled();
    expect(r.notice).toHaveBeenCalled();
  });
  it("TUI wins: recall claim durable before DELETE; failure does only one neutral PATCH", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    r.setRows([]);
    r.setClosed([close(offer())]);
    const barrier = deferred<boolean>();
    r.commit.mockReturnValue(barrier.promise);
    const work = r.kit.reconcile("session-1");
    await flush(20);
    expect(r.nonces.size).toBe(0);
    expect(r.deleteMessage).not.toHaveBeenCalled();
    r.deleteMessage.mockResolvedValue({
      ok: false,
      kind: "timeout",
      reason: "failed",
      retryable: false,
      effect: "unknown",
    });
    barrier.resolve(true);
    await work;
    await r.kit.reconcile("session-1");
    r.restart();
    await r.kit.reconcile("session-1");
    expect(r.deleteMessage).toHaveBeenCalledTimes(1);
    expect(r.patch.mock.calls.filter(([, c]) => c.includes("已在其他端批准"))).toHaveLength(1);
  });
  it("TUI DELETE success does not PATCH and does not retry", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    const patches = r.patch.mock.calls.length;
    r.setRows([]);
    r.setClosed([close(offer())]);
    await r.kit.reconcile("session-1");
    await r.kit.reconcile("session-1");
    expect(r.deleteMessage).toHaveBeenCalledTimes(1);
    expect(r.patch).toHaveBeenCalledTimes(patches);
  });
  it("durable closed.by feishu + same offerId wins after restart, not unrelated by feishu", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    r.restart();
    r.setClosed([close(offer(1), "feishu")]);
    r.setRows([]);
    await r.kit.reconcile("session-1");
    expect(r.deleteMessage).not.toHaveBeenCalled();
    r.setClosed([close(offer(), "feishu")]);
    await r.kit.reconcile("session-1");
    expect(text(r)).toContain("已通过飞书批准");
    expect(r.deleteMessage).not.toHaveBeenCalled();
  });
  it("missing authoritative offer/closed survives restart; positive same-hash ledger approval yields neutral PATCH", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    r.restart();
    r.setRows([]);
    await r.kit.reconcile("session-1");
    expect(r.nonces.size).toBe(3);
    expect(r.deleteMessage).not.toHaveBeenCalled();
    r.setLedger(true, "b".repeat(64));
    await r.kit.reconcile("session-1");
    expect(r.nonces.size).toBe(3);
    r.setLedger(true);
    await r.kit.reconcile("session-1");
    expect(r.patch.mock.calls.at(-1)?.[1]).toContain("已批准");
    expect(r.nonces.size).toBe(0);
    expect(r.deleteMessage).not.toHaveBeenCalled();
  });
  describe("ledger evidence port (H2 ledgerTask) for a card whose offer is neither open nor closed", () => {
    const gone = async () => {
      const r = rig();
      await r.kit.reconcile("session-1");
      r.restart(); // agent /reload: open + closed lists are empty
      r.setRows([]);
      return r;
    };
    it("deleted (proved by a scan that started after the anchor) ⇒ neutral 「任务已删除」 PATCH, purge, no DELETE", async () => {
      const r = await gone();
      const since: Array<number | undefined> = [];
      r.setEvidence((_sid, _id, o) => {
        since.push(o?.since);
        return { kind: "deleted", scannedAt: NOW + 1 };
      });
      await r.kit.reconcile("session-1");
      expect(r.patch.mock.calls.at(-1)?.[1]).toContain("任务已删除");
      expect(r.nonces.size).toBe(0);
      expect(r.deleteMessage).not.toHaveBeenCalled();
      expect(r.decide).not.toHaveBeenCalled();
      expect(since.every((v) => v === NOW)).toBe(true); // anchor createdAt is the proof floor
    });
    it.each([
      ["stale", { kind: "unknown", reason: "stale" }],
      ["degraded", { kind: "unknown", reason: "degraded" }],
      ["root-degraded", { kind: "unknown", reason: "root-degraded" }],
      ["no-session", { kind: "unknown", reason: "no-session" }],
    ] as const)("unknown/%s ⇒ the card is kept (fail-closed, never a guessed deletion)", async (_n, ev) => {
      const r = await gone();
      r.setEvidence(() => ev);
      await r.kit.reconcile("session-1");
      expect(r.nonces.size).toBe(3);
      expect(r.deleteMessage).not.toHaveBeenCalled();
      expect(text(r)).not.toContain("任务已删除");
    });
    it("present + approved + same hash ⇒ 「已批准」; a different hash (definition changed) keeps the card", async () => {
      const r = await gone();
      r.setEvidence(() => ({ kind: "present", approved: true, defHash: "b".repeat(64), scannedAt: NOW }));
      await r.kit.reconcile("session-1");
      expect(r.nonces.size).toBe(3);
      r.setEvidence(() => ({ kind: "present", approved: false, defHash: HASH, scannedAt: NOW }));
      await r.kit.reconcile("session-1");
      expect(r.nonces.size).toBe(3);
      r.setEvidence(() => ({ kind: "present", approved: true, defHash: HASH, scannedAt: NOW }));
      await r.kit.reconcile("session-1");
      expect(r.patch.mock.calls.at(-1)?.[1]).toContain("已批准");
      expect(r.nonces.size).toBe(0);
    });
    it("a throwing evidence port is unknown, not a crash", async () => {
      const r = await gone();
      r.setEvidence(() => {
        throw new Error("boom");
      });
      await expect(r.kit.reconcile("session-1")).resolves.toBeUndefined();
      expect(r.nonces.size).toBe(3);
    });
    it("a refused decide on a task the ledger proves deleted says 「任务已删除」, not 「已批准」 and not a recall", async () => {
      const r = rig();
      await r.kit.reconcile("session-1");
      r.decide.mockImplementation(async () => {
        r.setEvidence(() => ({ kind: "deleted", scannedAt: NOW + 5 }));
        return { kind: "refused", reason: "E_REV" };
      });
      await r.kit.callback(r.redeem(r.button()), IDENTITY, "event");
      expect(r.patch.mock.calls.at(-1)?.[1]).toContain("任务已删除");
      expect(r.deleteMessage).not.toHaveBeenCalled();
    });
    it("a delayed second click after settle reports the proven deletion instead of 「已在其他端处理」", async () => {
      const r = rig();
      await r.kit.reconcile("session-1");
      const stale = { ...r.button() };
      r.setRows([]);
      r.setEvidence(() => ({ kind: "deleted", scannedAt: NOW + 5 }));
      await r.kit.reconcile("session-1"); // settles the card as deleted
      expect(r.patch.mock.calls.at(-1)?.[1]).toContain("任务已删除");
      r.nonces.set(stale.nonce, stale);
      await r.kit.callback(r.redeem(stale), IDENTITY, "late");
      expect(r.decide).not.toHaveBeenCalled();
      expect(text(r)).not.toContain("已在其他端处理");
      expect(r.notice.mock.calls.at(-1)?.[1]).toContain("卡片已失效");
    });
  });
  it("already-approved and E_REV responses re-read latest approved evidence before PATCH/recall", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    r.decide.mockImplementation(async () => {
      r.setClosed([close(offer(), "feishu")]);
      return { kind: "refused", reason: "E_REV" };
    });
    await r.kit.callback(r.redeem(r.button()), IDENTITY, "event");
    expect(r.patch.mock.calls.at(-1)?.[1]).toContain("已批准");
    expect(r.deleteMessage).not.toHaveBeenCalled();
  });
  it.each(["E_REV", "offer-gone"])("%s without approval recalls old card", async (reason) => {
    const r = rig();
    await r.kit.reconcile("session-1");
    r.decide.mockResolvedValue({ kind: "refused", reason });
    await r.kit.callback(r.redeem(r.button()), IDENTITY, "event");
    expect(r.deleteMessage).toHaveBeenCalledTimes(1);
  });
  it("supersede recalls old and sends fresh card with new hash", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    const next = { ...offer(1), task: offer().task, defHash: "b".repeat(64) };
    r.setRows([next]);
    r.setClosed([close(offer(), "elsewhere", "superseded")]);
    await r.kit.reconcile("session-1");
    expect(r.deleteMessage).toHaveBeenCalledTimes(1);
    expect(r.sendCard).toHaveBeenCalledTimes(2);
    expect([...r.nonces.values()].every((n) => JSON.parse(n.target).defHash === next.defHash)).toBe(true);
  });
  it("offline click retains anchor, re-signs consumed button, resumes on attach", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    const n = r.redeem(r.button());
    r.setRows([{ ...offer(), online: false }]);
    await r.kit.callback(n, IDENTITY, "offline");
    await r.kit.reconcile("session-1");
    expect(r.decide).not.toHaveBeenCalled();
    expect(text(r)).toContain("会话离线");
    expect(r.button().nonce).not.toBe(n.nonce);
    expect(r.nonces.size).toBe(3);
    r.setRows([offer()]);
    await r.kit.reconcile("session-1");
    await r.kit.callback(r.redeem(r.button()), IDENTITY, "online");
    expect(r.decide).toHaveBeenCalledTimes(1);
  });
  it("12 s hung decide is unknown, anchor retained, dispose clears expiry timers", async () => {
    const r = rig(),
      gate = deferred<ScheduleDecideResult>();
    await r.kit.reconcile("session-1");
    r.decide.mockReturnValue(gate.promise);
    const work = r.kit.callback(r.redeem(r.button()), IDENTITY, "hang");
    await flush(20);
    r.clock.advance(12_000);
    await work;
    expect(text(r)).toContain("未确认是否生效");
    expect([...r.nonces.values()].some((n) => n.action === "sched-card")).toBe(true);
    r.kit.dispose();
    gate.resolve({ kind: "approved" });
    await flush(20);
    expect(text(r)).not.toContain("已通过飞书批准");
  });
  it("physical buttons PATCH timeout cannot overwrite a queued terminal PATCH", async () => {
    const r = rig(),
      gate = deferred<Awaited<ReturnType<ScheduleConfirmDeps["patch"]>>>();
    r.patch.mockReturnValueOnce(gate.promise);
    const opening = r.kit.reconcile("session-1");
    await flush(30);
    expect(r.patch).toHaveBeenCalledTimes(1);
    r.clock.advance(8_000);
    await opening;
    r.setRows([]);
    r.setClosed([close(offer(), "feishu")]);
    await r.kit.reconcile("session-1");
    expect(r.patch).toHaveBeenCalledTimes(1);
    expect(r.nonces.size).toBe(0);
    gate.resolve({ ok: true, data: undefined });
    await flush(30);
    expect(r.patch).toHaveBeenCalledTimes(2);
    expect(r.patch.mock.calls.at(-1)?.[1]).toContain("已通过飞书批准");
  });
  it("known failed buttons PATCH heals on reconcile, not a permanent text-card", async () => {
    const r = rig();
    r.patch.mockResolvedValueOnce({
      ok: false,
      kind: "unreachable",
      reason: "network",
      retryable: true,
      effect: "none",
    });
    await r.kit.reconcile("session-1");
    await r.kit.reconcile("session-1");
    expect(r.patch).toHaveBeenCalledTimes(2);
    expect(r.patch.mock.calls.at(-1)?.[1]).toContain("callback");
  });
  it("throwing/missing optional H2 decision port stays unknown, not unhandled", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    r.decide.mockRejectedValue(new Error("port"));
    await r.kit.callback(r.redeem(r.button()), IDENTITY, "error");
    expect(text(r)).toContain("未确认是否生效");
    const s = rig();
    delete s.deps.port.decide;
    await s.kit.reconcile("session-1");
    await s.kit.callback(s.redeem(s.button()), IDENTITY, "missing");
    expect(text(s)).toContain("未确认是否生效");
  });
  it("anchor expiry patches expired, never decide/recall", async () => {
    const r = rig();
    await r.kit.reconcile("session-1");
    r.clock.advance(100_000);
    await r.kit.reconcile("session-1");
    expect(text(r)).toContain("已过期");
    expect(r.nonces.size).toBe(0);
    expect(r.deleteMessage).not.toHaveBeenCalled();
  });
  it("6 offers sorted by expiry: only 4 cards; settle frees slot for fifth", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => offer(i));
    const r = rig([...rows].reverse());
    await r.kit.reconcile("session-1");
    expect(r.sendCard).toHaveBeenCalledTimes(4);
    expect(r.count).toHaveBeenCalledWith("sched-confirm-card-cap");
    expect(
      [...r.nonces.values()].filter((n) => n.action === "sched-card").map((n) => JSON.parse(n.target).offerId),
    ).toEqual(rows.slice(0, 4).map((r) => r.offerId));
    r.setRows(rows.slice(1));
    r.setClosed([close(rows[0]!)]);
    await r.kit.reconcile("session-1");
    expect(r.sendCard).toHaveBeenCalledTimes(5);
  });
  it("global 16 and nonce reserve are never invaded", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      Array.from({ length: 4 }, (_, j) => offer(j, `session-${i + 1}`)),
    ).flat();
    const r = rig(rows);
    for (let i = 2; i <= 5; i++) r.bind(`chat-${i}`, OWNER, `session-${i}`);
    await Promise.all(Array.from({ length: 5 }, (_, i) => r.kit.reconcile(`session-${i + 1}`)));
    expect(r.sendCard).toHaveBeenCalledTimes(16);
    const s = rig();
    const budget = FEISHU_CAPS.nonces - FEISHU_CAPS.noncesReservedForOthers;
    for (let i = 0; i < budget - 2; i++)
      s.nonces.set(`reserved-${i}`, { nonce: `reserved-${i}`, action: "other" } as FeishuNonce);
    await s.kit.reconcile("session-1");
    expect(s.sendCard).not.toHaveBeenCalled();
    expect(s.count).toHaveBeenCalledWith("sched-confirm-nonce-cap");
  });
  it("binding add/remove, gen revoke and repeated reconcile taps are idempotent", async () => {
    const r = rig();
    r.bindings.clear();
    await r.kit.reconcile("session-1");
    expect(r.sendCard).not.toHaveBeenCalled();
    const key = r.bind();
    r.kit.reconcileAll(8);
    await r.kit.reconcile("session-1");
    expect(r.sendCard).toHaveBeenCalledTimes(1);
    r.bindings.delete(key);
    await r.kit.reconcile("session-1");
    expect(r.deleteMessage).toHaveBeenCalledTimes(1);
    const s = rig();
    await s.kit.reconcile("session-1");
    const old = [...s.nonces.values()].filter((n) => n.action === "sched-card");
    s.restart();
    s.nonces.clear();
    s.gen(2);
    s.setRows([]);
    s.kit.revoked(old);
    await s.kit.reconcile("session-1");
    expect(s.deleteMessage).toHaveBeenCalledTimes(1);
  });
  it("connector reconnect catch-up schedules only 8 sessions", async () => {
    const r = rig([]);
    r.bindings.clear();
    r.setRows(Array.from({ length: 10 }, (_, i) => offer(0, `session-${i}`)));
    for (let i = 0; i < 10; i++) r.bind(`chat-${i}`, OWNER, `session-${i}`);
    r.kit.reconcileAll(8);
    await Promise.all(Array.from({ length: 8 }, (_, i) => r.kit.reconcile(`session-${i}`)));
    expect(r.sendCard).toHaveBeenCalledTimes(8);
    r.kit.reconcileAll();
    await r.kit.reconcile("session-9");
    expect(r.sendCard).toHaveBeenCalledTimes(10);
  });
  it("8 KiB CJK and adversarial fences clip ONLY prompt, retain both buttons and hash/web", () => {
    const row = offer();
    row.task.prompt = "日报`<at id=all>😀".repeat(2000);
    const card = renderScheduleConfirmCard(row, "https://hub.example/#/agent/one", {
      approve: "approve-nonce",
      reject: "reject-nonce",
    });
    expect(Buffer.byteLength(card)).toBeLessThanOrEqual(20_000);
    expect(card).toContain("完整内容见 web");
    expect(card).toContain("approve-nonce");
    expect(card).toContain("reject-nonce");
    expect(card).toContain(HASH.slice(0, 8));
    expect(card).toContain("在 web 中打开");
    expect(card).not.toContain("<at id=all>");
    const cjk = { ...row, task: { ...row.task, prompt: "中".repeat(8192 / 3 + 1) } };
    expect(
      Buffer.byteLength(renderScheduleConfirmCard(cjk, undefined, { approve: "yes", reject: "no" })),
    ).toBeLessThanOrEqual(20_000);
  });
});

describe("#61 F2 service taps with real inbound/nonce persistence × fake H2", () => {
  it("durable /unbind tap recalls without waiting for a hub scan", async () => {
    const row = { ...offer(), expiresAt: REAL_NOW + 100_000 };
    const r = await f8Rig({
      schedule: {
        list: () => [],
        offers: () => [row],
        closedOffers: () => [],
        decide: async () => ({ kind: "approved" }),
        run: async () => ({ kind: "unavailable" }),
        receiptsChanged: () => {},
      },
    });
    cleanups.push(() => r.close());
    await r.ready();
    await r.bind();
    r.send(messageEnvelope("proof-unbind", "owner 证明"));
    await eventually(() =>
      expect(r.fake.callsTo("PATCH", /messages/).some((c) => JSON.stringify(c.json).includes("prompt"))).toBe(true),
    );
    r.send(messageEnvelope("unbind-schedule", "/unbind"));
    await eventually(() => expect(r.fake.callsTo("DELETE", /messages/)).toHaveLength(1));
    const disk = await r.disk();
    expect(Object.values(disk["nonces"]).some((n: any) => n.action === "sched-card")).toBe(false);
  });
  it("new binding is unproven until request; offersChanged routes callback, replay never decides twice", async () => {
    const row = { ...offer(), expiresAt: REAL_NOW + 100_000 };
    const decide = vi.fn(async () => ({ kind: "approved" as const }));
    const r = await f8Rig({
      schedule: {
        list: () => [],
        offers: () => [{ ...row, sessionId: "session-1" }],
        closedOffers: () => [],
        decide,
        run: async () => ({ kind: "unavailable" }),
        receiptsChanged: () => {},
      },
    });
    cleanups.push(() => r.close());
    await r.ready();
    await r.bind();
    r.service.schedule.offersChanged("session-1");
    await flush(30);
    expect(r.fake.callsTo("PATCH", /messages/).some((c) => JSON.stringify(c.json).includes("定时任务待确认"))).toBe(
      false,
    );
    r.send(messageEnvelope("owner-proof", "记录 owner 证明"));
    await eventually(() => expect(r.request).toHaveBeenCalled());
    // Request durable tap establishes proof and reconciles without a manual offersChanged call.
    await eventually(() =>
      expect(r.fake.callsTo("PATCH", /messages/).some((c) => JSON.stringify(c.json).includes("prompt"))).toBe(true),
    );
    const disk = await r.disk();
    const n = Object.values(disk["nonces"]).find((n: any) => n.action === "sched-ok") as FeishuNonce;
    expect(n.operatorOpenId).toBe(REAL_OWNER);
    const cb = callbackEnvelope(n.nonce, { chatId: n.chatId, messageId: n.messageId });
    r.send(cb);
    await eventually(() => expect(decide).toHaveBeenCalledTimes(1));
    r.send(cb);
    await eventually(() =>
      expect(r.fake.callsTo("PATCH", /messages/).some((c) => JSON.stringify(c.json).includes("已通过飞书批准"))).toBe(
        true,
      ),
    );
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
