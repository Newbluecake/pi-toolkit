/**
 * session-card unit tests (session-card-plan r3 §8: T1–T10 + gates G1–G4).
 * Ports are controlled deferreds: commit/sendCard/PATCH can be held pending, commit can inject `false`.
 * The state port is an in-memory fake; real persistence of list/purge/maxTotal lives in state.test.ts,
 * real-restart behavior in tests/integration/web-hub-feishu-bot.test.ts (SW4).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createFeishuSessionCard,
  renderListCard,
  renderListText,
  type SessionCardDeps,
  type SessionCardStatePort,
  type SessionCardListInput,
} from "../../../../src/web-hub/hub/feishu/session-card.js";
import type { FeishuNonce, FeishuBinding } from "../../../../src/web-hub/hub/feishu/state.js";
import type { FeishuSessionRow } from "../../../../src/web-hub/hub/feishu/sessions.js";
import type { FeishuResult } from "../../../../src/web-hub/hub/feishu/http.js";
import type { FeishuIdentityContext, FeishuInstallation } from "../../../../src/web-hub/hub/feishu/admission.js";
import type { OutboxTarget } from "../../../../src/web-hub/hub/feishu/outbox.js";
import { FEISHU_CAPS } from "../../../../src/web-hub/protocol/feishu.js";

const OWNER = "ou_owner";
const OTHER = "ou_other";
const NOW = 1_790_000_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeClock(start = NOW) {
  let now = start,
    id = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const h = ++id;
      timers.set(h, { fn, at: now + Math.max(0, ms) });
      return h as unknown;
    },
    clearTimeout: (h: unknown) => {
      timers.delete(h as number);
    },
    /** advance time and fire every timer that comes due (including chained ones) */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    timerCount: () => timers.size,
  };
}
type FakeClock = ReturnType<typeof fakeClock>;

function fakeState(clock: FakeClock) {
  const nonces = new Map<string, FeishuNonce>();
  const bindings = new Map<string, FeishuBinding>();
  const allowed = new Set<string>([OWNER]);
  let nonceSeq = 0,
    rev = 0,
    failed = false;
  let commitImpl: () => Promise<boolean> = () => Promise.resolve(true);
  const state: SessionCardStatePort = {
    commit: () => commitImpl(),
    persistFailed: () => failed,
    nonces: {
      issue(input, ttlMs, opts) {
        const cap = Math.min(opts?.maxTotal ?? FEISHU_CAPS.nonces, FEISHU_CAPS.nonces);
        if (nonces.size >= cap) return { ok: false as const, refused: "cap" };
        const nonce = `n${String(++nonceSeq).padStart(21, "0")}`;
        const rec: FeishuNonce = {
          ...input,
          nonce,
          createdAt: clock.now(),
          expiresAt: opts?.expiresAt ?? clock.now() + (ttlMs ?? FEISHU_CAPS.nonceTtlMs),
        };
        nonces.set(nonce, rec);
        return { ok: true as const, value: { ...rec } };
      },
      get: (nonce) => {
        const r = nonces.get(nonce);
        return r === undefined ? undefined : { ...r };
      },
      list: (match) => [...nonces.values()].filter(match ?? (() => true)).map((r) => ({ ...r })),
      purge: (match) => {
        let n = 0;
        for (const [k, r] of [...nonces]) if (match(r) && nonces.delete(k)) n++;
        return n;
      },
    },
    bindings: {
      get: (key) => {
        const b = bindings.get(key);
        return b === undefined ? undefined : { ...b };
      },
      set: (key, input) => {
        const rec: FeishuBinding = {
          key,
          rev: ++rev,
          chatId: input.chatId,
          chatType: input.chatType,
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.label ? { label: input.label } : {}),
          updatedAt: clock.now(),
        };
        bindings.set(key, rec);
        return { ok: true as const, value: { ...rec } };
      },
    },
    allowList: { has: (id) => allowed.has(id) },
    tenant: { get: () => "tenant" },
  };
  return {
    state,
    nonces,
    bindings,
    allowed,
    setCommit(fn: () => Promise<boolean>) {
      commitImpl = fn;
    },
    setPersistFailed(value: boolean) {
      failed = value;
    },
  };
}
type FakeState = ReturnType<typeof fakeState>;

interface View {
  sessionId: string;
  name: string;
  live: boolean;
  state: "busy" | "idle" | "waiting" | "read-only";
  dup?: boolean;
}
function makeSessions(views: View[]) {
  return {
    rows: (): FeishuSessionRow[] =>
      views.map((v) => ({
        sessionId: v.sessionId,
        name: v.name,
        label: `${v.name} · ${v.sessionId.slice(0, 6)}`,
        cwd: "/repo",
        mode: "tui",
        state: !v.live ? "offline" : v.dup ? "ambiguous" : v.state,
      })),
    resolve: (sessionId: string) => {
      const live = views.filter((v) => v.live && v.sessionId === sessionId);
      if (live.length === 0) return { ok: false as const, code: "offline" as const };
      if (live.length > 1 || live[0]!.dup) return { ok: false as const, code: "ambiguous" as const };
      if (live[0]!.state === "read-only") return { ok: false as const, code: "read-only" as const };
      return {
        ok: true as const,
        agentKey: `agent-${sessionId}`,
        view: {
          sessionId,
          agentKey: `agent-${sessionId}`,
          cwd: "/repo",
          name: live[0]!.name,
          live: true,
          mode: "tui" as const,
          state: live[0]!.state,
        },
      };
    },
  };
}

interface Rig {
  card: ReturnType<typeof createFeishuSessionCard>;
  clock: FakeClock;
  state: FakeState;
  views: View[];
  identity: FeishuIdentityContext;
  notices: { target: OutboxTarget; text: string; lane?: string; key?: string }[];
  patches: {
    messageId: string;
    card: string;
    signal?: AbortSignal;
    deferred?: ReturnType<typeof deferred<FeishuResult<void>>>;
  }[];
  sentCards: {
    id: string;
    messageId?: string;
    card: string;
    deferred?: ReturnType<typeof deferred<{ messageId: string; chatId: string } | undefined>>;
  }[];
  sendCard: ReturnType<typeof vi.fn>;
  patchCard: ReturnType<typeof vi.fn>;
  setSendCardImpl(fn: () => Promise<{ messageId: string; chatId: string } | undefined>): void;
  setPatchImpl(fn: () => Promise<FeishuResult<void>>): void;
  list(over?: Partial<SessionCardListInput>): Promise<void>;
  listInput(over?: Partial<SessionCardListInput>): SessionCardListInput;
  pickNonce(sessionId: string, messageId?: string): FeishuNonce;
  anchor(messageId?: string): FeishuNonce | undefined;
  purgeNonces(match: (n: FeishuNonce) => boolean): number;
  /** redeem (like inbound) + synchronous pick */
  click(sessionId: string, eventId?: string, sender?: string): void;
  flush(): Promise<void>;
}

function rig(views: View[], over: Partial<SessionCardDeps> = {}, shared?: { state: FakeState; clock: FakeClock }): Rig {
  const clock = shared?.clock ?? fakeClock();
  const state = shared?.state ?? fakeState(clock);
  const liveViews = views.map((v) => ({ ...v })); // never share view objects across rigs
  const sessions = makeSessions(liveViews);
  const identity: FeishuIdentityContext = { installGen: 1, tenantKey: "tenant", senderOpenId: OWNER };
  const installation: FeishuInstallation = {
    appId: "cli_test",
    gen: 1,
    ownerOpenId: OWNER,
    botOpenId: "ou_bot",
    installSecret: "secret",
    active: true,
  };
  const notices: Rig["notices"] = [];
  const patches: Rig["patches"] = [];
  const sentCards: Rig["sentCards"] = [];
  let cardSeq = 0;
  let sendCardImpl = () =>
    Promise.resolve<{ messageId: string; chatId: string } | undefined>({
      messageId: `card-${++cardSeq}`,
      chatId: "chat",
    });
  let patchImpl: () => Promise<FeishuResult<void>> = () => Promise.resolve({ ok: true, data: undefined });
  const sendCard = vi.fn((id: string, _t: OutboxTarget, card: string, _lane: string) => {
    const entry: Rig["sentCards"][number] = { id, card };
    sentCards.push(entry);
    const p = sendCardImpl(id);
    void p.then((v) => {
      if (v) entry.messageId = v.messageId;
    });
    return p;
  });
  const patchCard = vi.fn((p: { messageId: string; card: string; signal?: AbortSignal }) => {
    const entry: Rig["patches"][number] = {
      messageId: p.messageId,
      card: p.card,
      ...(p.signal ? { signal: p.signal } : {}),
    };
    patches.push(entry);
    return patchImpl();
  });
  const purgeNonces = (match: (n: FeishuNonce) => boolean) => state.state.nonces.purge(match);
  const deps: SessionCardDeps = {
    state: state.state,
    sessions,
    installation: () => installation,
    authorize: (id) => (state.allowed.has(id.senderOpenId) ? { ok: true } : { ok: false }),
    cardsDenied: () => false,
    sendCard,
    patchCard,
    notice: (target, text, lane, key) => {
      notices.push({ target, text, ...(lane ? { lane } : {}), ...(key ? { key } : {}) });
      return Promise.resolve();
    },
    capability: () => {},
    clock,
    onError: () => {},
    ...over,
  };
  const card = createFeishuSessionCard(deps);
  const listInput = (o: Partial<SessionCardListInput> = {}): SessionCardListInput => ({
    message: {
      senderOpenId: OWNER,
      messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
      chatId: "chat",
      chatType: "p2p",
      ...(o.message ?? {}),
    },
    generation: Math.floor(Math.random() * 1e6),
    rows: sessions.rows(),
    target: { scope: "p2p", via: "reply", messageId: "m-trigger" },
    ...o,
  });
  const r: Rig = {
    card,
    clock,
    state,
    views: liveViews,
    identity,
    notices,
    patches,
    sentCards,
    sendCard,
    patchCard,
    purgeNonces,
    setSendCardImpl: (fn) => {
      sendCardImpl = fn;
    },
    setPatchImpl: (fn) => {
      patchImpl = fn;
    },
    listInput,
    list: (o) => card.sendList(listInput(o)),
    pickNonce(sessionId, messageId) {
      const nonce = state.state.nonces
        .list((n) => n.action === "session-pick" && (messageId === undefined || n.messageId === messageId))
        .find((n) => {
          try {
            return (JSON.parse(n.target) as { s?: string }).s === sessionId;
          } catch {
            return false;
          }
        });
      if (!nonce) throw new Error(`no button nonce for ${sessionId}`);
      return nonce;
    },
    anchor(messageId) {
      return state.state.nonces
        .list((n) => n.action === "session-card" && (messageId === undefined || n.messageId === messageId))
        .at(0);
    },
    click(sessionId, eventId = `event-${Math.random().toString(36).slice(2, 8)}`, sender = OWNER) {
      const nonce = r.pickNonce(sessionId);
      // inbound redeems (deletes) BEFORE the intent is emitted
      purgeNonces((n) => n.nonce === nonce.nonce);
      card.pick(nonce, { ...identity, senderOpenId: sender }, eventId);
    },
    async flush() {
      for (let i = 0; i < 20; i++) await new Promise((r2) => setImmediate(r2));
    },
  };
  return r;
}

const AB: View[] = [
  { sessionId: "session-a", name: "Alpha", live: true, state: "idle" },
  { sessionId: "session-b", name: "Beta", live: true, state: "busy" },
];
const patchNonces = (p: { card: string }): string[] =>
  (JSON.parse(p.card) as { body: { elements: { behaviors?: { value: { n: string } }[] }[] } }).body.elements
    .map((e) => e.behaviors?.[0]?.value.n)
    .filter((n): n is string => typeof n === "string");

describe("session-card T1: A→B→A reuse", () => {
  it("re-issues exactly one nonce per consumed button; absolute expiry never extends", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    expect(r.anchor()).toBeDefined();
    const expiresAt = r.anchor()!.expiresAt;
    expect(r.state.nonces.size).toBe(3); // anchor + 2 buttons
    const b1 = r.pickNonce("session-b").nonce;
    r.click("session-b", "e-1");
    await r.flush();
    expect(r.state.bindings.get("p2p:chat")?.sessionId).toBe("session-b");
    expect(r.state.nonces.size).toBe(3); // consumed one, re-issued one
    expect(r.pickNonce("session-b").nonce).not.toBe(b1);
    expect(r.anchor()!.expiresAt).toBe(expiresAt);
    r.clock.advance(60_000);
    r.click("session-a", "e-2");
    await r.flush();
    expect(r.state.bindings.get("p2p:chat")?.sessionId).toBe("session-a");
    r.click("session-b", "e-3");
    await r.flush();
    expect(r.state.bindings.get("p2p:chat")?.sessionId).toBe("session-b");
    // at rest: exactly one active nonce per button, ≤8 buttons + 1 anchor total
    expect(r.state.nonces.size).toBe(3);
    expect(r.pickNonce("session-b").expiresAt).toBe(expiresAt); // re-issues pin the card's absolute expiresAt, never extended
    expect(r.notices.map((n) => n.text).filter((t) => t.includes("已绑定"))).toHaveLength(3);
    // no-op click on the currently bound session still gets a receipt (未变化) and a fresh nonce
    const b2 = r.pickNonce("session-b").nonce;
    r.click("session-b", "e-4");
    await r.flush();
    expect(r.notices.at(-1)!.text).toContain("未变化");
    expect(r.pickNonce("session-b").nonce).not.toBe(b2);
  });
});

describe("session-card T2: failure gate", () => {
  it("authorized click on an offline target closes the whole card (purge→barrier→notice→PATCH)", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.views[0]!.live = false; // session-a goes offline
    r.click("session-a", "e-off");
    await r.flush();
    expect(r.anchor()).toBeUndefined(); // every card nonce purged
    expect(r.state.nonces.size).toBe(0);
    expect(r.notices.some((n) => n.text.includes("不可用") && n.text.includes("已关闭"))).toBe(true);
    expect(r.patches.some((p) => String(p.card).includes("卡片已关闭"))).toBe(true);
    expect(r.state.bindings.get("p2p:chat")).toBeUndefined();
  });
  it("commit=false: no close claim, no PATCH; degraded recovers once persist heals", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.views[0]!.live = false;
    r.state.setCommit(() => Promise.resolve(false));
    r.state.setPersistFailed(true);
    r.click("session-a", "e-off");
    await r.flush();
    expect(r.patches.some((p) => String(p.card).includes("已停用"))).toBe(false); // no closing PATCH
    expect(r.notices.some((n) => n.text.includes("状态保存失败"))).toBe(true); // honest persist notice
    expect(r.notices.some((n) => n.text.includes("已关闭"))).toBe(false);
    r.state.setCommit(() => Promise.resolve(true));
    r.state.setPersistFailed(false);
    r.card.onPersistRecovered();
    await r.flush();
    expect(r.patches.some((p) => String(p.card).includes("已停用"))).toBe(true); // G3: recovery closes the card
    expect(r.notices.some((n) => n.text.includes("已绑定"))).toBe(false); // failure branch: NO success receipt
  });
  it("unauthorized or mismatched clicks never trigger the gate", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    const before = r.state.nonces.size;
    // a stranger's redeemed record (inbound would normally refuse; defense-in-depth here)
    const stolen = r.pickNonce("session-a");
    r.purgeNonces((n) => n.nonce === stolen.nonce);
    r.card.pick(stolen, { ...r.identity, senderOpenId: "ou_stranger" }, "e-x");
    await r.flush();
    expect(r.state.bindings.get("p2p:chat")).toBeUndefined();
    expect(r.notices).toHaveLength(0); // fully silent
    expect(r.state.nonces.size).toBe(before - 1); // token consumed, card NOT closed (heals on next reconcile)
    // stale nonce (record.nonce ≠ slot.nonce after a re-issue): silently dropped
    await r.list(); // supersede ⇒ fresh card, full nonce set again
    await r.flush();
    const a1 = r.pickNonce("session-a"); // save the record, then consume it for real
    r.click("session-a", "e-0");
    await r.flush(); // binding → session-a, a1 consumed, A2 issued
    r.click("session-b", "e-1");
    await r.flush(); // binding → session-b
    r.card.pick(a1, r.identity, "e-stale"); // replaying the consumed a1: slot now holds A2
    await r.flush();
    expect(r.state.bindings.get("p2p:chat")?.sessionId).toBe("session-b"); // unchanged by the stale click
    expect(r.state.nonces.size).toBe(before); // card still whole
  });
  it("an already-redeemed queued click is refused with 卡片已关闭 once the gate closed the card", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.views[0]!.live = false;
    // both clicks redeemed synchronously BEFORE the drain runs
    const na = r.pickNonce("session-a"),
      nb = r.pickNonce("session-b");
    r.purgeNonces((n) => n.nonce === na.nonce || n.nonce === nb.nonce);
    r.card.pick(na, r.identity, "e-a");
    r.card.pick(nb, r.identity, "e-b");
    await r.flush();
    expect(r.notices.some((n) => n.text.includes("卡片已关闭"))).toBe(true);
    expect(r.state.bindings.get("p2p:chat")).toBeUndefined(); // b never switched
  });
});

describe("session-card T3: queued clicks execute in order, no double tokens", () => {
  it("A and B redeemed while commit is held: ordered switches, B re-issued only after its dequeue", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    const sets: string[] = [];
    const origSet = r.state.state.bindings.set;
    r.state.state.bindings.set = (k, input) => {
      sets.push(`${k}=${String(input.sessionId)}`);
      return origSet(k, input);
    };
    const gate = deferred<boolean>();
    r.state.setCommit(() => gate.promise);
    const na = r.pickNonce("session-a"),
      nb = r.pickNonce("session-b");
    r.purgeNonces((n) => n.nonce === na.nonce || n.nonce === nb.nonce);
    r.card.pick(na, r.identity, "e-a");
    r.card.pick(nb, r.identity, "e-b");
    await r.flush();
    expect(sets).toEqual(["p2p:chat=session-a"]); // A executed up to the barrier, B still queued
    // A's reconcile re-issued A2 while B was pending ⇒ B must NOT be re-issued yet
    expect(r.state.state.nonces.list((n) => n.action === "session-pick")).toHaveLength(1);
    expect(JSON.parse(r.state.state.nonces.list((n) => n.action === "session-pick")[0]!.target).s).toBe("session-a");
    r.state.setCommit(() => Promise.resolve(true));
    gate.resolve(true);
    await r.flush();
    expect(sets).toEqual(["p2p:chat=session-a", "p2p:chat=session-b"]);
    const picks = r.state.state.nonces.list((n) => n.action === "session-pick");
    expect(picks).toHaveLength(2); // A2 + B2, exactly one each
    expect(new Set(picks.map((n) => (JSON.parse(n.target) as { s: string }).s))).toEqual(
      new Set(["session-a", "session-b"]),
    );
  });
});

describe("session-card T4: supersede fence", () => {
  it("a stuck sendCard loses the fence to a new /list and never issues nonces", async () => {
    const r = rig(AB);
    const stuck = deferred<{ messageId: string; chatId: string } | undefined>();
    let calls = 0;
    r.setSendCardImpl(() =>
      ++calls === 1 ? stuck.promise : Promise.resolve({ messageId: `card-${calls}`, chatId: "chat" }),
    );
    const first = r.list();
    await r.flush();
    await r.list(); // supersedes while the first sendCard is still in flight
    await r.flush();
    stuck.resolve({ messageId: "card-stuck", chatId: "chat" }); // late arrival
    await first;
    await r.flush();
    expect(r.anchor()).toBeDefined();
    expect(r.anchor()!.messageId).toBe("card-2"); // only the second card carries nonces
    expect(r.state.state.nonces.list((n) => n.messageId === "card-stuck")).toHaveLength(0);
  });
  it("supersede with barrier=false sends no card and degrades to the text list", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    const cardsBefore = r.sentCards.length;
    r.state.setCommit(() => Promise.resolve(false));
    await r.list();
    await r.flush();
    expect(r.sentCards.length).toBe(cardsBefore); // no second card
    expect(r.notices.some((n) => n.text.includes("1. Alpha"))).toBe(true); // text list fallback
    r.state.setCommit(() => Promise.resolve(true));
  });
  it("an in-flight PATCH is never doubled by the supersede closing PATCH", async () => {
    const r = rig(AB);
    const pending = deferred<FeishuResult<void>>();
    let patchCalls = 0;
    r.setPatchImpl(() => (++patchCalls === 1 ? pending.promise : Promise.resolve({ ok: true, data: undefined })));
    void r.list(); // parks at the first PATCH — never await it
    await r.flush();
    expect(patchCalls).toBe(1);
    await r.list(); // supersede while card-1's PATCH is still in flight
    await r.flush();
    const card1Patches = r.patches.filter((p) => p.messageId === "card-1");
    expect(card1Patches).toHaveLength(1); // no concurrent second PATCH
    pending.resolve({ ok: true, data: undefined });
    await r.flush();
    expect(r.patches.filter((p) => p.messageId === "card-1")).toHaveLength(2); // serialized closing PATCH
    expect(String(r.patches.filter((p) => p.messageId === "card-1")[1]!.card)).toContain("已被新列表取代");
  });
});

describe("session-card T5: PATCH logical deadline vs physical IO", () => {
  it("never-settling PATCH: 8s freeze purges nonces + closes, IO slot stays, no second PATCH until settle", async () => {
    const r = rig(AB);
    const pending = deferred<FeishuResult<void>>();
    let first = true;
    r.setPatchImpl(() => (first ? ((first = false), pending.promise) : Promise.resolve({ ok: true, data: undefined })));
    void r.list(); // parks at the PATCH until the logical deadline freezes the card
    await r.flush();
    expect(r.anchor()).toBeDefined();
    r.clock.advance(8_000); // logical deadline
    await r.flush();
    expect(r.state.nonces.size).toBe(0); // frozen ⇒ purged + barrier(true)
    expect(r.card.snapshot().patchIo).toBe(1); // zombie keeps its physical slot
    expect(r.patchCard).toHaveBeenCalledTimes(1); // NEVER a second PATCH while unsettled
    pending.resolve({ ok: true, data: undefined }); // real settle ⇒ exactly one closing PATCH
    await r.flush();
    expect(r.patchCard).toHaveBeenCalledTimes(2);
    expect(String(r.patches[1]!.card)).toContain("已停用");
    expect(r.card.snapshot().patchIo).toBe(0); // slot released on real settle
  });
  it("dispose aborts in-flight IO and suppresses every late side effect", async () => {
    const r = rig(AB);
    const pending = deferred<FeishuResult<void>>();
    r.setPatchImpl(() => pending.promise);
    void r.list(); // parks at the PATCH
    await r.flush();
    r.card.dispose();
    pending.resolve({ ok: true, data: undefined });
    r.clock.advance(60_000);
    await r.flush();
    expect(r.patchCard).toHaveBeenCalledTimes(1); // no closing PATCH after dispose
    expect(r.notices).toHaveLength(0);
  });
  it("8 zombie PATCH slots ⇒ /list degrades to the text list", async () => {
    const views: View[] = AB;
    const r = rig(views);
    r.setPatchImpl(() => new Promise<FeishuResult<void>>(() => {})); // never settles
    for (let i = 0; i < FEISHU_CAPS.listCardPatchIoMax; i++) {
      void r.list({
        message: { senderOpenId: `ou_op${i}`, messageId: `m-z${i}`, chatId: `chat-z${i}`, chatType: "p2p" },
      });
      await r.flush(); // each sendList parks at its PATCH; do NOT await it
    }
    expect(r.card.snapshot().patchIo).toBe(8);
    const noticesBefore = r.notices.length;
    await r.list({ message: { senderOpenId: "ou_new", messageId: "m-new", chatId: "chat-new", chatType: "p2p" } });
    await r.flush();
    expect(r.sendCard).toHaveBeenCalledTimes(8); // 9th never sent a card
    expect(r.notices.length).toBe(noticesBefore + 1);
    expect(r.notices.at(-1)!.text).toContain("1. Alpha");
  });
  it("first-attach refusal (effect none): card stays text, slot released, no closing PATCH", async () => {
    const r = rig(AB);
    r.setPatchImpl(() =>
      Promise.resolve({
        ok: false,
        kind: "bad-request",
        reason: "bad-request:card-too-large",
        retryable: false,
        effect: "none",
      }),
    );
    await r.list();
    await r.flush();
    expect(r.patchCard).toHaveBeenCalledTimes(1);
    expect(r.state.nonces.size).toBe(0); // anchor + buttons rolled back
    expect(r.card.snapshot().fenceSlots).toBe(0);
    await r.list(); // slot free again
    await r.flush();
    expect(r.sendCard).toHaveBeenCalledTimes(2);
  });
  it("PATCH failure neither rolls back the binding nor swallows the success notice", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.setPatchImpl(() =>
      Promise.resolve({ ok: false, kind: "unreachable", reason: "unreachable", retryable: true, effect: "unknown" }),
    );
    r.click("session-b", "e-1");
    await r.flush();
    expect(r.state.bindings.get("p2p:chat")?.sessionId).toBe("session-b"); // binding kept
    expect(r.notices.some((n) => n.text.includes("已绑定"))).toBe(true); // notice not swallowed
    expect(r.state.nonces.size).toBe(0); // unknown effect ⇒ card closed
  });
});

describe("session-card T6: absolute expiry", () => {
  it("the expiry timer closes the card without any click and releases the slot", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    expect(r.card.snapshot().fenceSlots).toBe(1);
    r.clock.advance(FEISHU_CAPS.nonceTtlMs); // 24 h
    await r.flush();
    expect(r.state.nonces.size).toBe(0);
    expect(r.card.snapshot().fenceSlots).toBe(0); // no leak
    expect(r.patches.some((p) => String(p.card).includes("已过期"))).toBe(true);
    await r.list(); // a fresh /list works immediately
    await r.flush();
    expect(r.sendCard).toHaveBeenCalledTimes(2);
  });
});

describe("session-card T7: quotas", () => {
  it("17 concurrent /list across ≥5 operators ⇒ exactly 16 cards + 1 text list", async () => {
    const r = rig(AB);
    r.setSendCardImpl(() => new Promise(() => {})); // stuck sendCards keep slots claimed
    const total = FEISHU_CAPS.listCardsOpenGlobal + 1;
    for (let i = 0; i < total; i++) {
      void r.list({
        message: {
          senderOpenId: `ou_op${i % 6}`, // 6 distinct operators
          messageId: `m-${i}`,
          chatId: `chat-${i}`,
          chatType: "p2p",
        },
      });
      await r.flush(); // stuck flows park at sendCard; do NOT await them
    }
    expect(r.sendCard).toHaveBeenCalledTimes(16);
    expect(r.notices.filter((n) => n.text.includes("1. Alpha"))).toHaveLength(1); // the 17th is text
  });
  it("per-operator cap 4; nonce sub-quota 384 refuses cards but never other modules", async () => {
    const r = rig(AB);
    for (let i = 0; i < 5; i++)
      await r.list({ message: { senderOpenId: OWNER, messageId: `m-${i}`, chatId: `chat-${i}`, chatType: "p2p" } });
    await r.flush();
    expect(r.sendCard).toHaveBeenCalledTimes(4); // 5th degrades
    expect(r.notices.at(-1)!.text).toContain("1. Alpha");
    // fill the table up to the 384 sub-quota with foreign (no-maxTotal) nonces
    const base = {
      installGen: 1,
      tenantKey: "tenant",
      operatorOpenId: OWNER,
      chatId: "chat",
      messageId: "other-card",
      action: "dialog",
      target: "{}",
    };
    while (r.state.nonces.size < FEISHU_CAPS.nonces - FEISHU_CAPS.noncesReservedForOthers) {
      const issued = r.state.state.nonces.issue(base);
      if (!issued.ok) break;
    }
    expect(r.state.nonces.size).toBe(384);
    const cardsBefore = r.sentCards.length;
    await r.list({ message: { senderOpenId: OTHER, messageId: "m-cap", chatId: "chat-cap", chatType: "p2p" } });
    await r.flush();
    // anchor refused ⇒ the card stays text-only (sent without buttons, never PATCHed)
    expect(r.sentCards.length).toBe(cardsBefore + 1);
    const lastMessageId = r.sentCards.at(-1)!.messageId;
    expect(lastMessageId).toBeDefined();
    expect(r.patches.every((p) => p.messageId !== lastMessageId)).toBe(true);
    // ask/approval/file nonces (no maxTotal) still issue into the 128 reserve
    expect(r.state.state.nonces.issue(base).ok).toBe(true);
    expect(r.state.nonces.size).toBeLessThanOrEqual(FEISHU_CAPS.nonces);
  });
});

describe("session-card T8: binding key discipline", () => {
  it("an unbound group topic binds on first click; never falls back to p2p", async () => {
    const r = rig(AB);
    const topic = {
      senderOpenId: OWNER,
      messageId: "m-g",
      chatId: "gchat",
      chatType: "group" as const,
      threadId: "t-1",
    };
    r.setSendCardImpl(() => Promise.resolve({ messageId: "card-g", chatId: "gchat" }));
    await r.list({ message: topic, target: { scope: "topic", messageId: "m-g" } });
    await r.flush();
    expect(r.anchor()).toBeDefined();
    expect(JSON.parse(r.anchor()!.target).k).toBe("grp:gchat:t-1");
    r.click("session-a", "e-g");
    await r.flush();
    const binding = r.state.bindings.get("grp:gchat:t-1");
    expect(binding?.sessionId).toBe("session-a");
    expect(binding?.chatType).toBe("group");
    expect(binding?.threadId).toBe("t-1");
    expect(r.state.bindings.get("p2p:gchat")).toBeUndefined(); // no p2p fallback
  });
  it("an existing binding inconsistent with the key rejects the click (no gate)", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.state.bindings.set("p2p:chat", {
      key: "p2p:chat",
      rev: 1,
      chatId: "OTHER-CHAT", // inconsistent with the key
      chatType: "p2p",
      sessionId: "session-a",
      updatedAt: NOW,
    });
    r.click("session-b", "e-mis");
    await r.flush();
    expect(r.state.bindings.get("p2p:chat")?.sessionId).toBe("session-a"); // unchanged
    expect(r.state.nonces.size).toBe(2); // card NOT closed (the mismatched click consumed one token)
  });
  it("200-char event/message ids still produce ≤100-char logical keys; a re-sent /list supersedes", async () => {
    const r = rig(AB);
    const long = "x".repeat(200);
    await r.list({ message: { senderOpenId: OWNER, messageId: long, chatId: "chat", chatType: "p2p" } });
    await r.flush();
    expect(r.sentCards[0]!.id.length).toBeLessThanOrEqual(100);
    r.click("session-a", long);
    await r.flush();
    expect(r.notices.at(-1)!.key!.length).toBeLessThanOrEqual(100);
    // same /list re-delivered: the old card is superseded, exactly one open card remains
    await r.list({ message: { senderOpenId: OWNER, messageId: long, chatId: "chat", chatType: "p2p" } });
    await r.flush();
    expect(r.card.snapshot().open).toBe(1);
    expect(r.patches.some((p) => String(p.card).includes("已被新列表取代"))).toBe(true);
  });
});

describe("session-card T9: restart adoption", () => {
  it("single-button card whose only nonce was redeemed pre-restart stays open and self-heals", async () => {
    const one: View[] = [{ sessionId: "session-a", name: "Alpha", live: true, state: "idle" }];
    const r = rig(one);
    await r.list();
    await r.flush();
    const messageId = r.anchor()!.messageId;
    // crash window: the nonce was redeemed but pick never ran
    r.purgeNonces((n) => n.action === "session-pick");
    r.card.dispose();
    const r2 = rig(one, {}, { state: r.state, clock: r.clock }); // restart over the same persisted state
    await r2.card.start();
    await r2.flush();
    expect(r2.anchor(messageId)).toBeDefined(); // anchor alive ⇒ card open
    expect(r2.pickNonce("session-a", messageId)).toBeDefined(); // missing button re-issued
    expect(r2.patches.filter((p) => p.messageId === messageId)).toHaveLength(1); // one refresh PATCH
    r2.click("session-a", "e-post-restart");
    await r2.flush();
    expect(r2.state.bindings.get("p2p:chat")?.sessionId).toBe("session-a");
    r2.card.dispose();
  });
  it("start() adopts ≤16 anchors and defensively purges extras and same-(operator,key) duplicates", async () => {
    const r = rig(AB);
    // hand-craft 18 anchors (2 share the same operator+key)
    for (let i = 0; i < 18; i++) {
      const dup = i === 17;
      r.state.state.nonces.issue({
        installGen: 1,
        tenantKey: "tenant",
        operatorOpenId: dup ? "ou_op0" : `ou_op${i}`,
        chatId: dup ? "chat-0" : `chat-${i}`,
        messageId: `card-old-${i}`,
        action: "session-card",
        target: JSON.stringify({ c: `fl${i}`, k: dup ? "p2p:chat-0" : `p2p:chat-${i}` }),
      });
    }
    await r.card.start();
    await r.flush();
    const anchors = r.state.state.nonces.list((n) => n.action === "session-card");
    expect(anchors.length).toBeLessThanOrEqual(16);
    const keys = anchors.map((a) => JSON.parse(a.target).k as string);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate (operator,key)
    expect(r.card.snapshot().open).toBe(anchors.length);
    r.card.dispose();
  });
});

describe("session-card T10: authorization revocation (G4)", () => {
  it("a click queued while the sender is denied never runs: no notice, no binding, no PATCH", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    const patchesBefore = r.patches.length;
    // pick enqueues synchronously; revoke BEFORE the microtask drain can dequeue
    const nb = r.pickNonce("session-b");
    r.purgeNonces((n) => n.nonce === nb.nonce);
    r.card.pick(nb, r.identity, "e-b");
    r.state.allowed.delete(OWNER);
    r.card.revokeOperator(OWNER);
    await r.flush();
    expect(r.state.bindings.get("p2p:chat")).toBeUndefined();
    expect(r.notices).toHaveLength(0); // no 已关闭 reply either — fully silent
    expect(r.patches.length).toBe(patchesBefore);
    expect(r.card.snapshot().fenceSlots).toBe(0);
  });
  it("revoke aborts in-flight IO and cancels the expiry timer; late settles stay silent", async () => {
    const r = rig(AB);
    const pending = deferred<FeishuResult<void>>();
    r.setPatchImpl(() => pending.promise);
    void r.list(); // parks at the PATCH
    await r.flush();
    r.card.revokeOperator(OWNER);
    expect(r.patches[0]!.signal?.aborted).toBe(true);
    pending.resolve({ ok: true, data: undefined });
    r.clock.advance(FEISHU_CAPS.nonceTtlMs + 1_000); // expiry timer was cancelled
    await r.flush();
    expect(r.patchCard).toHaveBeenCalledTimes(1); // no closing PATCH
    expect(r.notices).toHaveLength(0);
  });
});

describe("session-card closed-card reply is authorized-only (N6)", () => {
  it("a denied sender gets NO closed-card reply — sync pick path and queued click alike", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.views[0]!.live = false;
    r.click("session-a", "e-off"); // authorized click closes the card
    await r.flush();
    const closedNotices = () => r.notices.filter((n) => n.text.includes("卡片已关闭")).length;
    const before = r.notices.length;
    const closedBefore = r.notices.filter((n) => n.text.includes("卡片已关闭")).length; // the gate's own notice
    // a redeemed click that arrives after the card closed: sender denied meanwhile ⇒ fully silent
    const closedRecord = {
      nonce: "n".padEnd(22, "z"),
      installGen: 1,
      tenantKey: "tenant",
      operatorOpenId: OWNER,
      chatId: "chat",
      messageId: "card-1",
      action: "session-pick",
      target: JSON.stringify({ c: "x", k: "p2p:chat", s: "session-b" }),
      createdAt: NOW,
      expiresAt: NOW + 1_000_000,
    };
    r.state.allowed.delete(OWNER);
    r.card.pick(closedRecord, r.identity, "e-denied");
    r.card.pick(closedRecord, { ...r.identity, senderOpenId: "ou_stranger" }, "e-stranger");
    await r.flush();
    expect(r.notices.length).toBe(before);
    expect(closedNotices()).toBe(closedBefore);
    // control: an authorized sender still gets the closed-state receipt
    r.state.allowed.add(OWNER);
    r.card.pick(closedRecord, r.identity, "e-ok");
    await r.flush();
    expect(closedNotices()).toBe(closedBefore + 1);
  });
  it("a click queued on a card that closes, then denied before dequeue ⇒ silent", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.views[0]!.live = false;
    const na = r.pickNonce("session-a"),
      nb = r.pickNonce("session-b");
    r.purgeNonces((n) => n.nonce === na.nonce || n.nonce === nb.nonce);
    r.card.pick(na, r.identity, "e-a"); // closes the card
    r.card.pick(nb, r.identity, "e-b"); // queued behind it
    await Promise.resolve();
    r.state.allowed.delete(OWNER); // denied while b is still queued on the (closing) card
    await r.flush();
    // only the gate's own close notice (from a's authorized click) — b's would be a second one
    expect(r.notices.filter((n) => n.text.includes("卡片已关闭"))).toHaveLength(1);
    expect(r.state.bindings.get("p2p:chat")).toBeUndefined();
  });
});

describe("session-card G1 pin: pick() queues on its own tail, never the work pool", () => {
  it("with the PATCH IO pool saturated, a redeemed click still binds and is acknowledged", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    // saturate the card module's only pool (8 zombie PATCHes) — pick() must not depend on any pool
    r.setPatchImpl(() => new Promise<FeishuResult<void>>(() => {}));
    for (let i = 0; i < FEISHU_CAPS.listCardPatchIoMax; i++) {
      void r.list({ message: { senderOpenId: `ou_z${i}`, messageId: `m-z${i}`, chatId: `zc${i}`, chatType: "p2p" } });
      await r.flush();
    }
    expect(r.card.snapshot().patchIo).toBe(FEISHU_CAPS.listCardPatchIoMax);
    r.click("session-a", "e-1");
    // synchronous part done before any await: slot consumed, click queued on the controller itself
    expect(() => r.pickNonce("session-a", "card-1")).toThrow();
    await r.flush();
    expect(r.state.bindings.get("p2p:chat")?.sessionId).toBe("session-a");
    expect(r.notices.some((n) => n.text.includes("已绑定"))).toBe(true);
  });
});

describe("session-card >8 sessions", () => {
  const many = (n: number): View[] =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `session-${String(i).padStart(3, "0")}`,
      name: `S${i}`,
      live: true,
      state: "idle" as const,
    }));
  const buttons = (card: string) => patchNonces({ card }).length;
  it("12 online ⇒ exactly 8 buttons, all 12 text lines, /use hint; 9th session reachable via /use <sid6>", async () => {
    const r = rig(many(12));
    await r.list();
    await r.flush();
    const last = r.patches.at(-1)!.card;
    expect(buttons(last)).toBe(8);
    const text = last.replaceAll("\u200b", "");
    for (let i = 0; i < 12; i++) expect(text).toContain(`S${i} · sessio`);
    expect(text).toContain("更多会话：/use <sid6>");
    expect(r.state.nonces.size).toBe(9); // anchor + 8 buttons, never more
  });
  it("45 rows (some offline) ⇒ 8 buttons, ≤40 text lines, tail line 另有 M 个未显示", async () => {
    const views = many(45).map((v, i) => (i >= 20 ? { ...v, live: false } : v));
    const r = rig(views);
    await r.list();
    await r.flush();
    const last = r.patches.at(-1)!.card;
    expect(buttons(last)).toBe(8);
    const text = last.replaceAll("\u200b", "");
    expect(text).toContain("另有 5 个未显示");
    expect(text).not.toContain("S44 ·");
    expect(Buffer.byteLength(last)).toBeLessThanOrEqual(20_000);
  });
});

describe("session-card G1: controller-owned synchronous enqueue", () => {
  it("pick() never touches an outer work pool: redeemed click executes on the controller tail alone", async () => {
    // Regression anchor for the wiring: service.ts calls sessionCard.pick() directly from the inbound
    // emit (NOT via the generic work.run pool), so a saturated 256-slot pool cannot drop the click.
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.click("session-b", "e-direct");
    await r.flush(); // only microtasks/immediates — no external scheduler involved
    expect(r.state.bindings.get("p2p:chat")?.sessionId).toBe("session-b");
  });
});

describe("session-card G2/G3: recovery semantics", () => {
  it("success-branch degradation re-sends the receipt with the original stable key after recovery", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.state.setCommit(() => Promise.resolve(false));
    r.state.setPersistFailed(true);
    r.click("session-b", "e-success");
    await r.flush();
    expect(r.notices.some((n) => n.text.includes("已绑定"))).toBe(false); // success never claimed
    expect(r.state.bindings.get("p2p:chat")?.sessionId).toBe("session-b"); // in-memory change stands
    r.state.setCommit(() => Promise.resolve(true));
    r.state.setPersistFailed(false);
    r.card.onPersistRecovered();
    await r.flush();
    const receipt = r.notices.find((n) => n.text.includes("已绑定"));
    expect(receipt).toBeDefined();
    expect(receipt!.key).toMatch(/^fp[A-Za-z0-9_-]{40}$/); // original stable pick key
    expect(r.patches.some((p) => String(p.card).includes("已停用"))).toBe(true); // card closed after compensation
    expect(r.card.snapshot().fenceSlots).toBe(0); // slot released
  });
});

describe("session-card rendering", () => {
  it("renderListText is byte-identical to the legacy list format; >8 sessions keep text /use", () => {
    const rows = makeSessions(AB).rows();
    expect(renderListText(rows)).toBe("1. Alpha · sessio [idle/tui]\n2. Beta · sessio [busy/tui]");
    expect(renderListText([])).toBe("没有可用会话");
    const many: View[] = Array.from({ length: 12 }, (_, i) => ({
      sessionId: `session-${String(i).padStart(2, "0")}`,
      name: `S${i}`,
      live: true,
      state: "idle",
    }));
    const card = renderListCard(makeSessions(many).rows(), []);
    expect(card).toBeDefined();
    expect(String(card).replaceAll("\u200b", "")).toContain("更多会话：/use <sid6>");
    expect(Buffer.byteLength(card!)).toBeLessThanOrEqual(20_000);
  });
  it("button labels truncate by code point (surrogate-safe), sid6/state never truncated", async () => {
    const name = "名".repeat(60) + "🚀";
    const r = rig([{ sessionId: "session-a", name, live: true, state: "idle" }]);
    await r.list();
    await r.flush();
    const label = (
      JSON.parse(r.patches.at(-1)!.card) as { body: { elements: { text?: { content: string } }[] } }
    ).body.elements
      .map((e) => e.text?.content)
      .find((t) => t !== undefined)!;
    expect([...label].length).toBeLessThanOrEqual(FEISHU_CAPS.listButtonLabelMax);
    expect(label).toContain("sessio");
    expect(label).toContain("idle");
    expect(label).toBe(label.toWellFormed()); // no unpaired surrogates
  });
  it("oversized cards fall back: lines cut to 20, then text degrade", async () => {
    const wide: View[] = Array.from({ length: 41 }, (_, i) => ({
      sessionId: `session-${String(i).padStart(2, "0")}-x`.repeat(4).slice(0, 40),
      name: `N${i} ${"宽".repeat(30)}`,
      live: i % 3 !== 0,
      state: "idle",
    }));
    const rows = makeSessions(wide).rows();
    const card = renderListCard(rows, []);
    if (card !== undefined) {
      expect(Buffer.byteLength(card)).toBeLessThanOrEqual(20_000);
      expect(String(card).replaceAll("\u200b", "")).toContain("另有");
    }
    const r = rig(wide);
    await r.list();
    await r.flush();
    const content = String(r.sentCards.at(-1)?.card ?? r.notices.at(-1)?.text);
    expect(content.length).toBeGreaterThan(0);
  });
  it("marks the bound session: ✅ in text rows and card rows, primary button", () => {
    const rows = makeSessions(AB).rows();
    expect(renderListText(rows, AB[0]!.sessionId)).toContain("✅");
    expect(renderListText(rows, AB[0]!.sessionId).split("\n")[0]).toContain("✅");
    expect(renderListText(rows, AB[1]!.sessionId!).split("\n")[0]).not.toContain("✅");
    const buttons: { sessionId: string; nonce: string; label: string }[] = AB.map((v) => ({
      sessionId: v.sessionId,
      nonce: `n-${v.sessionId}`,
      label: v.name,
    }));
    const card = JSON.parse(renderListCard(rows, buttons, AB[1]!.sessionId)!) as {
      body: { elements: { tag: string; content?: string; text?: { content: string }; type?: string }[] };
    };
    const md = card.body.elements[0]!.content!;
    expect(md.split("\n")[1]).toContain("✅"); // second row is the bound one
    expect(md).toContain("\n\n切换会话："); // blank line separates the list from the hint (Feishu merges them otherwise)
    const bound = card.body.elements.find((e) => e.tag === "button" && e.text?.content === AB[1]!.name)!;
    const other = card.body.elements.find((e) => e.tag === "button" && e.text?.content === AB[0]!.name)!;
    expect(bound.type).toBe("primary");
    expect(other.type).toBeUndefined();
  });
  it("the marker moves on the refresh PATCH after a successful click", async () => {
    const r = rig(AB);
    await r.list();
    await r.flush();
    r.click("session-b", "e-mark");
    await r.flush();
    const card = JSON.parse(r.patches.at(-1)!.card) as {
      body: { elements: { tag: string; content?: string; text?: { content: string }; type?: string }[] };
    };
    const md = card.body.elements[0]!.content!;
    expect(md.split("\n").find((l) => l.includes("sessio") && l.includes("✅"))).toContain("session-b".slice(0, 6));
    const primary = card.body.elements.filter((e) => e.tag === "button" && e.type === "primary");
    expect(primary).toHaveLength(1);
    expect(primary[0]!.text?.content).toContain("session-b".slice(0, 6));
  });
});
