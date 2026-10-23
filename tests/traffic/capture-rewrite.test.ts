import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSpawnCount } from "../../src/traffic/jq.js";
import { ensureDb } from "../../src/traffic/db.js";
import { patchFetch, setRewriteBlockedHandler, unpatchFetch } from "../../src/traffic/capture.js";
import { matchAfter, makeProbe, pushPending, resetCorrelation } from "../../src/traffic/correlate.js";
import { acquireSlot, currentSlot, resetGate, type GateSlot } from "../../src/traffic/serialize.js";
import { resetState, state, type PendingRequest } from "../../src/traffic/state.js";
import type { EngineSettings, RewriteRule } from "../../src/traffic/rewrite.js";

let dir: string;
let originalFetch: typeof globalThis.fetch;
let sent: Array<{ input: unknown; init: RequestInit | undefined }>;

const url = "https://api.example.test/v1/messages";
const baseUrl = "https://api.example.test/v1";
const originalBody = JSON.stringify({
  messages: [{ role: "user", content: "capture rewrite test payload" }],
  temperature: 1,
});
const settings: EngineSettings = {
  jqPath: "",
  timeoutMs: 2000,
  handoffMs: 1000,
  retryGraceMs: 20,
  maxHoldMs: 5000,
  queueWaitMs: 1000,
};

function rule(overrides: Partial<RewriteRule> = {}): RewriteRule {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? "test rule",
    enabled: overrides.enabled ?? 1,
    priority: overrides.priority ?? 1,
    url_pattern: overrides.url_pattern ?? null,
    method: overrides.method ?? null,
    model: overrides.model ?? null,
    body_jq: overrides.body_jq ?? null,
    headers_jq: overrides.headers_jq ?? null,
  };
}

function addRow(id = 1, payload = originalBody): void {
  ensureDb()
    .prepare(
      `INSERT INTO requests (id, session_id, turn, ts, provider, model, payload, request_headers)
			 VALUES (?, 'session', 0, ?, 'provider', 'model', ?, NULL)`,
    )
    .run(id, new Date().toISOString(), payload);
}

function addEnabledRule(rewriteRule: RewriteRule = rule()): void {
  ensureDb()
    .prepare(
      `INSERT INTO rewrite_rules (id, name, enabled, priority, url_pattern, method, model, body_jq, headers_jq, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rewriteRule.id,
      rewriteRule.name,
      rewriteRule.enabled,
      rewriteRule.priority,
      rewriteRule.url_pattern,
      rewriteRule.method,
      rewriteRule.model,
      rewriteRule.body_jq,
      rewriteRule.headers_jq,
      new Date().toISOString(),
      new Date().toISOString(),
    );
}

function row(id = 1): Record<string, unknown> {
  return ensureDb().prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown>;
}

function entry(rowId: number | null, payload = originalBody, sessionId = "session"): PendingRequest {
  return {
    rowId,
    sessionId,
    baseUrl,
    model: "model",
    payloadLen: payload.length,
    probe: makeProbe(payload),
    createdAt: Date.now(),
    status: "waiting",
    claimedBy: [],
    streamCaptured: false,
  };
}

async function hookSlot(pending: PendingRequest, rules: RewriteRule[]): Promise<GateSlot> {
  const slot = await acquireSlot(
    {
      sessionId: pending.sessionId,
      baseUrl: pending.baseUrl,
      model: pending.model,
      modelApi: "test",
      rules,
      settings,
    },
    "hook",
  );
  slot.pending = pending;
  pending.slot = slot;
  pushPending(pending);
  return slot;
}

function installOrigin(handler: typeof globalThis.fetch): void {
  unpatchFetch();
  globalThis.fetch = handler;
  patchFetch();
}

function applyAfter(status: number, headers: Record<string, string>): void {
  const attempt = matchAfter(status, headers);
  if (!attempt || attempt.rowId === null) return;
  ensureDb()
    .prepare("UPDATE requests SET status = ?, response_headers = ? WHERE id = ?")
    .run(status, JSON.stringify(headers), attempt.rowId);
}

async function waitForChunks(id: number, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = ensureDb()
      .prepare("SELECT data FROM stream_chunks WHERE request_id = ? ORDER BY seq")
      .all(id) as Array<{ data: string }>;
    const text = rows.map((item) => item.data).join("");
    if (text) return text;
    if (Date.now() >= deadline) throw new Error(`stream #${id} was not captured`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  dir = mkdtempSync(join(tmpdir(), "pi-capture-rewrite-"));
  resetState();
  resetCorrelation();
  resetGate();
  state.dbPath = join(dir, "traffic.db");
  state.recording = true;
  ensureDb();
  sent = [];
  globalThis.fetch = async (input: unknown, init?: RequestInit) => {
    sent.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": `r-${sent.length}` },
    });
  };
  patchFetch();
});

afterEach(() => {
  unpatchFetch();
  setRewriteBlockedHandler(null);
  globalThis.fetch = originalFetch;
  resetGate();
  try {
    state.db?.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  resetState();
  vi.useRealTimers();
});

describe("capture rewrite interception T7", () => {
  it("a: rewrites before orig and records final plus original payload/header metadata", async () => {
    addRow();
    const pending = entry(1);
    await hookSlot(pending, [
      rule({ headers_jq: '. + {"Content-Length":"1", "X-Changed":"yes"}', body_jq: ".temperature = 0" }),
    ]);
    await globalThis.fetch(url, {
      method: "POST",
      body: originalBody,
      headers: { "content-type": "application/json" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.init?.body).toBe(
      '{"messages":[{"role":"user","content":"capture rewrite test payload"}],"temperature":0}',
    );
    expect(sent[0]?.init?.headers).toMatchObject({ "x-changed": "yes" });
    expect((sent[0]?.init?.headers as Record<string, string>)["content-length"]).toBeUndefined();
    expect(row()).toMatchObject({
      payload: '{"messages":[{"role":"user","content":"capture rewrite test payload"}],"temperature":0}',
      orig_payload: originalBody,
      rewrite_status: "applied",
      payload_encoding: "identity",
      payload_bytes: 87,
    });
    expect(JSON.parse(row().rewrite_rule_ids as string)).toEqual([1]);
  });

  it("b: blocks before orig, broadcasts safe events, and releases after poison grace", async () => {
    vi.useFakeTimers();
    addRow();
    const pending = entry(1);
    const slot = await hookSlot(pending, [rule({ body_jq: 'error("boom")' })]);
    const events: string[] = [];
    state.sseClients.add({
      write: (text: string) => {
        events.push(text);
        return true;
      },
    } as never);

    await expect(globalThis.fetch(url, { method: "POST", body: originalBody })).rejects.toThrow(
      'traffic-record rewrite blocked: [规则 "test rule" #1] body runtime_error',
    );
    expect(sent).toHaveLength(0);
    expect(row()).toMatchObject({ status: 0, rewrite_status: "blocked" });
    expect(events.join("\n")).toContain('"type":"rewrite_error"');
    expect(events.join("\n")).toContain('"type":"response"');
    expect(slot.blocked).not.toBeNull();
    expect(currentSlotId()).toBe(slot.id);
    await vi.advanceTimersByTimeAsync(settings.retryGraceMs);
    expect(currentSlotId()).toBeNull();
  });

  it("c: removes blocked row from correlation so the next request writes its own row", async () => {
    addRow(1);
    addRow(2, JSON.stringify({ messages: [{ role: "user", content: "second" }], temperature: 1 }));
    const first = entry(1);
    const firstSlot = await hookSlot(first, [rule({ body_jq: 'error("boom")' })]);
    await expect(globalThis.fetch(url, { method: "POST", body: originalBody })).rejects.toThrow();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(settings.retryGraceMs);
    resetGate();
    const second = entry(2, JSON.stringify({ messages: [{ role: "user", content: "second" }], temperature: 1 }));
    await hookSlot(second, [rule({ body_jq: ".temperature = 0" })]);
    await globalThis.fetch(url, { method: "POST", body: secondPayload(second) });
    applyAfter(200, { "request-id": "r-1" });

    expect(first.status).toBe("blocked");
    expect(second.status).toBe("resolved");
    expect(row(1).status).toBe(0);
    expect(row(2).status).toBe(200);
    expect(row(1).payload).toBe(originalBody);
    expect(firstSlot.state).toBe("released");
  });

  it("d: poison absorbs two SDK retries without another spawn, row write, or broadcast", async () => {
    vi.useFakeTimers();
    addRow();
    const pending = entry(1);
    await hookSlot(pending, [rule({ body_jq: 'error("boom")' })]);
    const events: string[] = [];
    state.sseClients.add({
      write: (text: string) => {
        events.push(text);
        return true;
      },
    } as never);
    const before = getSpawnCount();
    await expect(globalThis.fetch(url, { method: "POST", body: originalBody })).rejects.toThrow();
    const afterFirst = getSpawnCount();
    await expect(globalThis.fetch(url, { method: "POST", body: originalBody })).rejects.toThrow();
    await expect(globalThis.fetch(url, { method: "POST", body: originalBody })).rejects.toThrow();
    expect(afterFirst).toBeGreaterThanOrEqual(before);
    expect(getSpawnCount()).toBe(afterFirst);
    expect(events.filter((event) => event.includes('"type":"rewrite_error"'))).toHaveLength(1);
    expect(row().rewrite_status).toBe("blocked");
  });

  it("d2: blocked notifies pi once across SDK retries, without leaking stderr", async () => {
    vi.useFakeTimers();
    addRow();
    const pending = entry(1);
    await hookSlot(pending, [rule({ body_jq: 'error("boom-secret-stderr")' })]);
    const notices: string[] = [];
    setRewriteBlockedHandler((message: string) => notices.push(message));

    await expect(globalThis.fetch(url, { method: "POST", body: originalBody })).rejects.toThrow();
    await expect(globalThis.fetch(url, { method: "POST", body: originalBody })).rejects.toThrow();
    await expect(globalThis.fetch(url, { method: "POST", body: originalBody })).rejects.toThrow();

    // poison 窗口吸收重试：三次调用只弹一次。
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("改写阻断");
    expect(notices[0]).toContain("test rule");
    // 安全边界：jq stderr 绝不能进入抛给 pi 的消息。
    expect(notices[0]).not.toContain("boom-secret-stderr");
  });

  it("e: records rewrite metadata even when the response has no body", async () => {
    addRow();
    const pending = entry(1);
    await hookSlot(pending, [rule({ body_jq: ".temperature = 0" })]);
    installOrigin(async (input, init) => {
      sent.push({ input, init });
      return new Response(null, { status: 204 });
    });
    await globalThis.fetch(url, { method: "POST", body: originalBody });
    expect(sent).toHaveLength(1);
    expect(row()).toMatchObject({
      rewrite_status: "applied",
      orig_payload: originalBody,
      payload_encoding: "identity",
    });
  });

  it("f: after and stream capture continue after recording is turned off", async () => {
    addRow();
    const pending = entry(1);
    await hookSlot(pending, [rule({ body_jq: ".temperature = 0" })]);
    installOrigin(async (input, init) => {
      sent.push({ input, init });
      state.recording = false;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"ok":true}\\n\\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream", "request-id": "stream-1" } },
      );
    });
    await globalThis.fetch(url, { method: "POST", body: originalBody });
    applyAfter(200, { "request-id": "stream-1" });
    const stream = await waitForChunks(1);
    expect(stream).toContain('"ok":true');
    expect(row(1).status).toBe(200);
  });

  it("g: does not rewrite while recording is off, even with an already-acquired slot", async () => {
    const before = getSpawnCount();
    state.recording = false;
    const pending = entry(null);
    // slot 在录制开启时取得（hookSlot 内部 acquire），随后录制被关闭：
    // tryRewrite 的 recording 复查必须拦住它，否则 degraded slot 的规则快照会照旧生效。
    await hookSlot(pending, [rule({ body_jq: ".temperature = 0" })]);
    await globalThis.fetch(url, { method: "POST", body: originalBody });
    expect(sent[0]?.init?.body).toBe(originalBody);
    expect(sent[0]?.init?.body).not.toContain('"temperature":0');
    expect(getSpawnCount()).toBe(before);
    expect(state.unlinkedRewrites).toBe(0);
  });

  it("h: passes non-provider fetches through without DB lookup, gate, or jq", async () => {
    const before = getSpawnCount();
    state.db?.close();
    state.db = null;
    state.dbPath = "/dev/null/traffic.db";
    await globalThis.fetch("https://unrelated.example.test/data", { method: "POST", body: originalBody });
    expect(sent[0]?.input).toBe("https://unrelated.example.test/data");
    expect(currentSlotId()).toBeNull();
    expect(getSpawnCount()).toBe(before);
    expect(state.dbError).toBeNull();
  });

  it("i: decompresses and recompresses zstd while persisting plaintext and wire bytes", async () => {
    const zlib = (await import("node:zlib")) as typeof import("node:zlib") & {
      zstdCompressSync?: (input: Uint8Array) => Uint8Array;
    };
    if (!zlib.zstdCompressSync) return;
    const source = zlib.zstdCompressSync(Buffer.from(originalBody));
    addRow();
    const pending = entry(1);
    await hookSlot(pending, [rule({ body_jq: ".temperature = 0" })]);
    await globalThis.fetch(url, { method: "POST", body: source, headers: { "content-encoding": "zstd" } });
    const wire = sent[0]?.init?.body as Uint8Array;
    expect(wire).toBeInstanceOf(Uint8Array);
    const decoded = zlib.zstdDecompressSync?.(wire);
    expect(new TextDecoder().decode(decoded)).toContain('"temperature":0');
    expect(row()).toMatchObject({ payload_encoding: "zstd", payload_bytes: wire.byteLength });
    expect(row().payload).toContain('"temperature":0');
  });

  it("j: rebuilds Request input while preserving method, signal, and rewritten body", async () => {
    addRow();
    const pending = entry(1);
    await hookSlot(pending, [rule({ body_jq: ".temperature = 0" })]);
    const controller = new AbortController();
    const request = new Request(url, { method: "PATCH", body: originalBody, signal: controller.signal });
    await globalThis.fetch(request);
    const sentRequest = sent[0]?.input as Request;
    expect(sentRequest).toBeInstanceOf(Request);
    expect(sentRequest.method).toBe("PATCH");
    expect(sentRequest.signal.aborted).toBe(false);
    expect(await sentRequest.text()).toContain('"temperature":0');
  });

  it("k: with no enabled rules, records the unchanged request without gate/timer/jq overhead", async () => {
    const before = getSpawnCount();
    addRow();
    const pending = entry(1);
    pushPending(pending);
    const db = ensureDb();
    const prepareSpy = vi.spyOn(db, "prepare");
    vi.useFakeTimers();
    const timerCount = vi.getTimerCount();
    await globalThis.fetch(url, {
      method: "PATCH",
      body: originalBody,
      headers: { "content-type": "application/json" },
    });
    expect(vi.getTimerCount()).toBe(timerCount);
    expect(getSpawnCount()).toBe(before);
    expect(state.dbError).toBeNull();
    expect(currentSlotId()).toBeNull();
    expect(prepareSpy.mock.calls.filter(([sql]) => String(sql).includes("FROM rewrite_rules"))).toHaveLength(0);
    expect(row()).toMatchObject({
      url,
      method: "PATCH",
      payload_encoding: "identity",
      payload_bytes: Buffer.byteLength(originalBody, "utf8"),
    });
    expect(row().url).not.toBeNull();
    expect(row().method).not.toBeNull();
    expect(JSON.parse(row().request_headers as string)).toEqual({ "content-type": "application/json" });
  });

  it("l: orphan retry after grace rewrites with a fresh rule snapshot and is degraded", async () => {
    vi.useFakeTimers();
    addRow();
    addEnabledRule(rule({ body_jq: ".temperature = 0" }));
    const pending = entry(1);
    await hookSlot(pending, [rule({ body_jq: ".temperature = 0" })]);
    let calls = 0;
    installOrigin(async (input, init) => {
      sent.push({ input, init });
      calls++;
      return new Response(null, { status: calls === 1 ? 429 : 200, headers: { "request-id": `retry-${calls}` } });
    });

    await globalThis.fetch(url, { method: "POST", body: originalBody });
    applyAfter(429, { "request-id": "retry-1" });
    await vi.advanceTimersByTimeAsync(settings.retryGraceMs);
    expect(currentSlotId()).toBeNull();

    await globalThis.fetch(url, { method: "POST", body: originalBody });
    const lateAttempt = state.attempts[1];
    expect(sent[1]?.init?.body).toContain('"temperature":0');
    expect(lateAttempt?.degraded).toBe(true);
    expect(state.unlinkedRewrites).toBe(1);
    expect(row()).toMatchObject({ rewrite_status: "applied", payload: expect.stringContaining('"temperature":0') });
  });

  it("m: falls back to hook headers for an unchanged request and leaves its response available", async () => {
    addRow();
    const pending = entry(1);
    pending.hookHeaders = JSON.stringify({ Authorization: "Bearer hook-token" });
    await hookSlot(pending, []);
    const response = await globalThis.fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(JSON.parse(row().request_headers as string)).toEqual({ authorization: "Bearer hook-token" });
    expect(state.streamDone.size).toBe(0);
  });

  it("n: recording off with enabled rules in the DB is a total bypass — no query, gate, timer, or jq", async () => {
    const before = getSpawnCount();
    addRow();
    addEnabledRule(rule({ body_jq: ".temperature = 0" }));
    state.recording = false;
    pushPending(entry(1));
    const db = ensureDb();
    const prepareSpy = vi.spyOn(db, "prepare");
    vi.useFakeTimers();
    const timerCount = vi.getTimerCount();

    await globalThis.fetch(url, { method: "POST", body: originalBody });

    expect(sent[0]?.init?.body).toBe(originalBody);
    expect(vi.getTimerCount()).toBe(timerCount);
    expect(getSpawnCount()).toBe(before);
    expect(currentSlotId()).toBeNull();
    expect(state.dbError).toBeNull();
    // 录制关闭时连规则表都不查 —— 门槛前置于 loadEnabledRules。
    expect(prepareSpy.mock.calls.filter(([sql]) => String(sql).includes("FROM rewrite_rules"))).toHaveLength(0);
  });

  it("o: turning recording back on restores rewriting for subsequent requests", async () => {
    addRow();
    addEnabledRule(rule({ body_jq: ".temperature = 0" }));
    state.recording = false;
    pushPending(entry(1));
    await globalThis.fetch(url, { method: "POST", body: originalBody });
    expect(sent[0]?.init?.body).toBe(originalBody);

    state.recording = true;
    await hookSlot(entry(1), [rule({ body_jq: ".temperature = 0" })]);
    await globalThis.fetch(url, { method: "POST", body: originalBody });
    expect(sent[1]?.init?.body).toContain('"temperature":0');
  });
});

function secondPayload(_pending: PendingRequest): string {
  return JSON.stringify({ messages: [{ role: "user", content: "second" }], temperature: 1 });
}

function currentSlotId(): number | null {
  return currentSlot()?.id ?? null;
}
