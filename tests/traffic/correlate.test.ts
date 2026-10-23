import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProbe, respKeyOf, urlMatchesBase } from "../../src/traffic/correlate.js";
import { type GateSlot } from "../../src/traffic/serialize.js";
import { type Attempt, type PendingRequest } from "../../src/traffic/state.js";
import type { TrafficEngine } from "../../src/traffic/engine.js";
import { makeEngine } from "./helpers/engine.js";

let state: TrafficEngine;

const baseUrl = "https://api.example.test/v1";
const fetchUrl = `${baseUrl}/messages`;
const body = JSON.stringify({ messages: [{ role: "user", content: "same payload used by concurrent requests" }] });

function pending(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    rowId: 1,
    sessionId: "session",
    baseUrl,
    model: "model",
    payloadLen: body.length,
    probe: null,
    createdAt: Date.now(),
    status: "waiting",
    claimedBy: [],
    streamCaptured: false,
    ...overrides,
  };
}

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

async function acquire(
  entry: PendingRequest | null,
  overrides: { baseUrl?: string | null; sessionId?: string } = {},
): Promise<GateSlot> {
  const slot = await state.gate.acquireSlot(
    {
      sessionId: overrides.sessionId ?? entry?.sessionId ?? "session",
      baseUrl: overrides.baseUrl === undefined ? (entry?.baseUrl ?? baseUrl) : overrides.baseUrl,
      model: "model",
      modelApi: "api",
      rules: [],
      pending: entry,
      handoffMs: 60_000,
      retryGraceMs: 60_000,
      maxHoldMs: 60_000,
      queueWaitMs: 60_000,
    },
    "hook",
  );
  if (entry) entry.slot = slot;
  return slot;
}

function syntheticAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    seq: 1,
    url: fetchUrl,
    method: "POST",
    origin: "https://api.example.test",
    path: "/v1/messages",
    slot: null,
    pending: null,
    rowId: null,
    startedAt: 1,
    outcome: "response",
    status: 200,
    respKey: null,
    afterConsumed: false,
    rewriteRuleIds: [],
    settledAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.PI_RECORD_DEBUG_CORRELATE;
  state = makeEngine(tmpdir());
});

afterEach(() => {
  delete process.env.PI_RECORD_DEBUG_CORRELATE;
  state.gate.resetGate();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("请求关联层 T6", () => {
  it("a: 闸门档 O(1) 认领 holder.pending，URL 不匹配时拒绝并降级", async () => {
    const holderEntry = pending({ rowId: 11 });
    const unrelatedEarlier = pending({ rowId: 99, createdAt: holderEntry.createdAt - 1 });
    state.corr.pushPending(unrelatedEarlier);
    state.corr.pushPending(holderEntry);
    const slot = await acquire(holderEntry);

    const exact = state.corr.beginAttempt(fetchUrl, "post")!;
    expect(exact.slot).toBe(slot);
    expect(state.corr.claimPending(exact, body)).toBe(holderEntry);
    expect(exact.rowId).toBe(11);
    expect(unrelatedEarlier.status).toBe("waiting");

    const other = pending({ rowId: 22, baseUrl: "https://other.example.test/v1" });
    state.corr.pushPending(other);
    const mismatch = state.corr.beginAttempt("https://other.example.test/v1/messages", "POST")!;
    expect(mismatch.slot).toBe(slot);
    expect(state.corr.claimPending(mismatch, body)).toBeNull();
    expect(mismatch.degraded).toBe(true);
    expect(state.unlinkedRewrites).toBe(1);

    const orphanEntry = other;
    const orphan = syntheticAttempt({ url: "https://other.example.test/v1/messages", slot: null });
    expect(state.corr.claimPending(orphan, body)).toBe(orphanEntry);
    expect(orphan.degraded).toBe(true);
    expect(orphanEntry.slot).toBeUndefined();
    state.gate.releaseSlot(slot, "settled");
  });

  it("b/A1: 相同 payload 的并发请求经 hook park 后各自归属自己的行、URL、响应头和状态", async () => {
    const firstEntry = pending({ rowId: 101, sessionId: "A" });
    const firstSlot = await acquire(firstEntry, { sessionId: "A" });
    state.corr.pushPending(firstEntry);

    let secondReleased = false;
    const secondSlotPromise = state.gate
      .acquireSlot(
        {
          sessionId: "B",
          baseUrl,
          model: "model",
          modelApi: "api",
          rules: [],
          pending: null,
          handoffMs: 60_000,
          retryGraceMs: 60_000,
          maxHoldMs: 60_000,
          queueWaitMs: 60_000,
        },
        "hook",
      )
      .then((slot) => {
        secondReleased = true;
        return slot;
      });
    await Promise.resolve();
    expect(secondReleased).toBe(false);

    const firstAttempt = state.corr.beginAttempt(`${baseUrl}/messages/A`, "POST")!;
    expect(state.corr.claimPending(firstAttempt, body)).toBe(firstEntry);
    state.corr.settleAttempt(firstAttempt, response(201, { "request-id": "response-A" }));
    expect(state.corr.matchAfter(201, { "request-id": "response-A" })).toBe(firstAttempt);
    state.gate.releaseSlot(firstSlot, "settled");

    const secondSlot = await secondSlotPromise;
    const secondEntry = pending({ rowId: 202, sessionId: "B", slot: secondSlot });
    secondSlot.pending = secondEntry;
    state.corr.pushPending(secondEntry);
    const secondAttempt = state.corr.beginAttempt(`${baseUrl}/messages/B`, "POST")!;
    expect(state.corr.claimPending(secondAttempt, body)).toBe(secondEntry);
    state.corr.settleAttempt(secondAttempt, response(202, { "x-request-id": "response-B" }));
    expect(state.corr.matchAfter(202, { "x-request-id": "response-B" })).toBe(secondAttempt);

    expect(firstAttempt).toMatchObject({
      rowId: 101,
      url: `${baseUrl}/messages/A`,
      status: 201,
      respKey: "response-A",
    });
    expect(secondAttempt).toMatchObject({
      rowId: 202,
      url: `${baseUrl}/messages/B`,
      status: 202,
      respKey: "response-B",
    });
    expect(firstEntry.status).toBe("resolved");
    expect(secondEntry.status).toBe("resolved");
    state.gate.releaseSlot(secondSlot, "settled");
  });

  it("c: 闸门关闭时乱序 fetch 会已知降级错配，闸门开启时 B.hook 必须等待 A", async () => {
    const createdAt = Date.now();
    const first = pending({ rowId: 1, sessionId: "A", createdAt });
    const second = pending({ rowId: 2, sessionId: "B", createdAt: createdAt + 1 });
    state.corr.pushPending(first);
    state.corr.pushPending(second);
    const bFetchFirst = state.corr.beginAttempt(`${baseUrl}/messages/B`, "POST")!;
    const aFetchSecond = state.corr.beginAttempt(`${baseUrl}/messages/A`, "POST")!;
    expect(state.corr.claimPending(bFetchFirst, body)).toBe(first);
    expect(state.corr.claimPending(aFetchSecond, body)).toBe(second);
    expect([bFetchFirst.rowId, aFetchSecond.rowId]).toEqual([1, 2]);

    state.corr.resetCorrelation();
    const gatedA = pending({ rowId: 10, sessionId: "A" });
    const slotA = await acquire(gatedA, { sessionId: "A" });
    state.corr.pushPending(gatedA);
    let bAcquired = false;
    const slotBPromise = acquire(null, { sessionId: "B" }).then((slot) => {
      bAcquired = true;
      return slot;
    });
    await Promise.resolve();
    expect(state.gate.currentSlot()).toBe(slotA);
    expect(bAcquired).toBe(false);
    state.gate.releaseSlot(slotA, "settled");
    const slotB = await slotBPromise;
    expect(bAcquired).toBe(true);
    expect(state.gate.currentSlot()).toBe(slotB);
    state.gate.releaseSlot(slotB, "settled");
  });

  it("d: 同一 slot 的 retry 复认领同一 pending 与 rowId", async () => {
    const entry = pending({ rowId: 7 });
    const slot = await acquire(entry);
    state.corr.pushPending(entry);
    const first = state.corr.beginAttempt(fetchUrl, "POST")!;
    expect(state.corr.claimPending(first, body)).toBe(entry);
    state.corr.settleAttempt(first, response(429, { "request-id": "retry-1" }));
    expect(state.corr.matchAfter(429, { "request-id": "retry-1" })).toBe(first);

    const retry = state.corr.beginAttempt(fetchUrl, "POST")!;
    expect(state.corr.claimPending(retry, body)).toBe(entry);
    expect(retry.rowId).toBe(7);
    expect(entry.claimedBy).toEqual([first.seq, retry.seq]);
    expect(state.pendingRequests).toEqual([entry]);
    state.gate.releaseSlot(slot, "settled");
  });

  it("e/V14: URL 使用 origin 与路径边界，null/空 baseUrl 永不匹配或创建 provider attempt", () => {
    expect(urlMatchesBase(`${baseUrl}/messages`, baseUrl)).toBe(true);
    expect(urlMatchesBase("https://api.example.test/v10/messages", baseUrl)).toBe(false);
    expect(urlMatchesBase("https://other.example.test/v1/messages", baseUrl)).toBe(false);
    expect(urlMatchesBase(fetchUrl, null)).toBe(false);
    expect(urlMatchesBase(fetchUrl, "")).toBe(false);
    state.corr.pushPending(pending({ baseUrl: null }));
    expect(state.corr.beginAttempt(fetchUrl, "POST")).toBeNull();
    expect(state.corr.beginAttempt("not a URL", "POST")).toBeNull();
  });

  it("f1: matchAfter 闸门档取当前 slot 唯一未消费 response，不依赖 recording/status/key", async () => {
    const entry = pending({ rowId: 31 });
    const slot = await acquire(entry);
    state.corr.pushPending(entry);
    const attempt = state.corr.beginAttempt(fetchUrl, "POST")!;
    state.corr.claimPending(attempt, body);
    state.corr.settleAttempt(attempt, response(418, { "request-id": "real-key" }));
    state.recording = false;
    expect(state.corr.matchAfter(200, { "request-id": "different-key" })).toBe(attempt);
    expect(attempt.afterConsumed).toBe(true);
    expect(entry.status).toBe("resolved");
    expect(state.corr.matchAfter(200, {})).toBeNull();
    state.gate.releaseSlot(slot, "settled");
  });

  it("f2: matchAfter 依次使用 respKey 精确档、status+settledAt 最近档，均不成立返回 null", () => {
    const keyed = syntheticAttempt({ seq: 1, status: 500, respKey: "keyed", settledAt: 10 });
    const older = syntheticAttempt({ seq: 2, status: 200, settledAt: 20 });
    const recent = syntheticAttempt({ seq: 3, status: 200, settledAt: 30 });
    const attempts = [keyed, older, recent];
    expect(respKeyOf({ "X-Request-Id": "keyed" })).toBe("keyed");
    expect(state.corr.matchAfter(attempts, 200, { "x-request-id": "keyed" })).toBe(keyed);
    expect(state.corr.matchAfter(attempts, 200, {})).toBe(recent);
    expect(state.corr.matchAfter(attempts, 200, {})).toBe(older);
    expect(state.corr.matchAfter(attempts, 404, {})).toBeNull();
    expect(state.corr.matchAfter(attempts, 200, {})).toBeNull();
  });

  it("g: Codex 同 slot 的 429/200 两次 response 分别消费，最终 pending 为 resolved", async () => {
    const entry = pending({ rowId: 44 });
    const slot = await acquire(entry);
    state.corr.pushPending(entry);
    const throttled = state.corr.beginAttempt(fetchUrl, "POST")!;
    state.corr.claimPending(throttled, body);
    state.corr.settleAttempt(throttled, response(429, { "request-id": "codex-429" }));
    expect(state.corr.matchAfter(429, { "request-id": "codex-429" })).toBe(throttled);
    expect(entry.status).toBe("sent");

    const success = state.corr.beginAttempt(fetchUrl, "POST")!;
    state.corr.claimPending(success, body);
    state.corr.settleAttempt(success, response(200, { "request-id": "codex-200" }));
    expect(state.corr.matchAfter(200, { "request-id": "codex-200" })).toBe(success);
    expect(success.rowId).toBe(44);
    expect(entry.status).toBe("resolved");
    expect(state.pendingRequests).not.toContain(entry);
    state.gate.releaseSlot(slot, "settled");
  });

  it("h: blockAttempt 立即移出首条 pending，第二条 after 不会写错位", () => {
    const createdAt = Date.now();
    const firstEntry = pending({ rowId: 1, createdAt });
    const secondEntry = pending({ rowId: 2, createdAt: createdAt + 1 });
    state.corr.pushPending(firstEntry);
    state.corr.pushPending(secondEntry);
    const first = state.corr.beginAttempt(fetchUrl, "POST")!;
    state.corr.claimPending(first, body);
    state.corr.blockAttempt(first);
    expect(firstEntry.status).toBe("blocked");
    expect(state.pendingRequests).not.toContain(firstEntry);

    const second = state.corr.beginAttempt(fetchUrl, "POST")!;
    expect(state.corr.claimPending(second, body)).toBe(secondEntry);
    state.corr.settleAttempt(second, response(200, { "request-id": "second" }));
    expect(state.corr.matchAfter(200, { "request-id": "second" })).toBe(second);
    expect(second.rowId).toBe(2);
    expect(first.afterConsumed).toBe(true);
  });

  it("i/V8: hook headers consume-once，并在 5 秒 TTL 后失效", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    state.corr.stashHookHeaders('{"authorization":"redacted"}');
    expect(state.corr.takeHookHeaders()).toBe('{"authorization":"redacted"}');
    expect(state.corr.takeHookHeaders()).toBeNull();

    state.corr.stashHookHeaders('{"x-request":"stale"}');
    vi.advanceTimersByTime(5_000);
    expect(state.corr.takeHookHeaders()).toBeNull();
  });

  it("V6: 零规则同 URL 多 waiting 候选时，传入 bodyText 用 includes 消歧且不依赖 debug 开关", () => {
    const first = pending({ rowId: 56, probe: '"feature":"first"' });
    const second = pending({ rowId: 57, probe: '"feature":"second"', createdAt: first.createdAt + 1 });
    state.corr.pushPending(first);
    state.corr.pushPending(second);
    const attempt = state.corr.beginAttempt(fetchUrl, "POST")!;

    expect(state.corr.claimPending(attempt, '{"feature":"second"}')).toBe(second);
    expect(attempt.rowId).toBe(57);
    expect(first.status).toBe("waiting");
  });

  it("probe 无条件计算（供 V6 消歧）；断言仅在 debug 模式执行，失败只告警计数且不改变认领", async () => {
    expect(makeProbe("short")).toBeNull();
    expect(makeProbe(body)).not.toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entry = pending({ rowId: 55, debugProbe: "expected-fragment" });
    const slot = await acquire(entry);
    state.corr.pushPending(entry);
    const attempt = state.corr.beginAttempt(fetchUrl, "POST")!;
    // 未开 debug：断言不执行，不计数
    expect(state.corr.claimPending(attempt, "different body")).toBe(entry);
    expect(state.correlationAssertFailures).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    // 开启 debug：断言执行，失败告警计数但不改变认领
    process.env.PI_RECORD_DEBUG_CORRELATE = "1";
    const attempt2 = state.corr.beginAttempt(fetchUrl, "POST")!;
    expect(state.corr.claimPending(attempt2, "different body")).toBe(entry);
    expect(attempt2.rowId).toBe(55);
    expect(state.correlationAssertFailures).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    state.gate.releaseSlot(slot, "settled");
  });

  it("A2: 小于 24 字符且 probe=null 的 payload 仍按 URL 认领并保留请求/响应元数据", () => {
    const shortBody = '{"x":1}';
    const entry = pending({ rowId: 66, payloadLen: shortBody.length, probe: makeProbe(shortBody) });
    expect(entry.probe).toBeNull();
    state.corr.pushPending(entry);
    const attempt = state.corr.beginAttempt(fetchUrl, "patch")!;
    expect(state.corr.claimPending(attempt, shortBody)).toBe(entry);
    state.corr.settleAttempt(attempt, response(204, { "x-amzn-requestid": "short-response" }));
    expect(state.corr.matchAfter(204, { "x-amzn-requestid": "short-response" })).toBe(attempt);
    expect(attempt).toMatchObject({
      rowId: 66,
      url: fetchUrl,
      method: "PATCH",
      status: 204,
      respKey: "short-response",
    });
  });

  it("j1: TTL 与容量上限回收 pending/attempt", () => {
    state.corr.pushPending(pending({ createdAt: 0 }));
    state.corr.reap(5 * 60 * 1000);
    expect(state.pendingRequests).toHaveLength(0);
    const now = Date.now();
    for (let i = 0; i < 40; i++) state.corr.pushPending(pending({ rowId: i, createdAt: now + i }));
    expect(state.pendingRequests).toHaveLength(32);
    for (let i = 0; i < 70; i++) {
      state.attempts.push(syntheticAttempt({ seq: i, startedAt: now + i, settledAt: now + i }));
    }
    state.corr.reap(now + 70);
    expect(state.attempts).toHaveLength(64);
  });

  it("j2: resetCorrelation 清空 pool、attempt、计数与 hook headers 暂存", () => {
    state.corr.pushPending(pending());
    state.attempts.push(syntheticAttempt());
    state.attemptSeq = 9;
    state.unlinkedRewrites = 3;
    state.correlationAssertFailures = 2;
    state.corr.stashHookHeaders("cached");
    state.corr.resetCorrelation();
    expect(state.pendingRequests).toHaveLength(0);
    expect(state.attempts).toHaveLength(0);
    expect(state.attemptSeq).toBe(0);
    expect(state.unlinkedRewrites).toBe(0);
    expect(state.correlationAssertFailures).toBe(0);
    expect(state.corr.takeHookHeaders()).toBeNull();
  });
});
