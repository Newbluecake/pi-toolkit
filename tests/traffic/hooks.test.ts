import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDb } from "../../src/traffic/db.js";
import { beginAttempt, claimPending, pushPending, settleAttempt } from "../../src/traffic/correlate.js";
import { registerTrafficRecordHandlers } from "../../src/traffic/index.js";
import { resetJqForTest, runJq } from "../../src/traffic/jq.js";
import { acquireSlot, currentSlot, releaseSlot, resetGate } from "../../src/traffic/serialize.js";
import { resetState, state, type PendingRequest } from "../../src/traffic/state.js";

const baseUrl = "https://api.example.test/v1";
const requestUrl = `${baseUrl}/messages`;
const payload = JSON.stringify({ messages: [{ role: "user", content: "hook test" }] });

let dir: string;
let handlers: Map<string, (event: any, ctx: any) => unknown>;
let command: (args: string, ctx: any) => Promise<void>;
let notifications: Array<{ message: string; type?: string }>;

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api: "anthropic-messages",
    baseUrl,
    id: "test-model",
    provider: "test-provider",
    ...overrides,
  };
}

function context(modelValue: Record<string, unknown> | undefined = model()): any {
  return {
    model: modelValue,
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    sessionManager: { getSessionId: () => "hook-session" },
    cwd: process.cwd(),
  };
}

function fakePi(): any {
  handlers = new Map();
  return {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
    registerCommand: (_name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
      command = options.handler;
    },
  };
}

function addRule(): void {
  ensureDb()
    .prepare(
      `INSERT INTO rewrite_rules (name, enabled, priority, body_jq, created_at, updated_at)
			 VALUES (?, 1, 1, ?, ?, ?)`,
    )
    .run("hook-rule", ".", new Date().toISOString(), new Date().toISOString());
}

function pending(rowId: number): PendingRequest {
  return {
    rowId,
    sessionId: "hook-session",
    baseUrl,
    model: "test-model",
    payloadLen: payload.length,
    probe: null,
    createdAt: Date.now(),
    status: "waiting",
    claimedBy: [],
    streamCaptured: false,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-hooks-"));
  resetState();
  resetGate();
  resetJqForTest();
  state.dbPath = join(dir, "traffic.db");
  // 改写引擎按录制开关门控，钩子层用例需显式开启录制才会入闸门。
  state.recording = true;
  notifications = [];
  const pi = fakePi();
  registerTrafficRecordHandlers(pi);
});

afterEach(() => {
  resetGate();
  try {
    state.db?.close();
  } catch {}
  resetState();
  resetJqForTest();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("T8 钩子层", () => {
  it("a: 有启用规则时等待闸门，无规则时同步完成且不创建 timer", async () => {
    const before = handlers.get("before_provider_request")!;
    ensureDb();
    addRule();
    vi.useFakeTimers();
    const gated = before({ payload }, context());
    expect(currentSlot()).not.toBeNull();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await gated;
    releaseSlot(currentSlot()!, "settled");

    // 后半段测「零启用规则 → 同步完成、不建 timer」。
    // 不能用 resetState()：它会把 dbPath 打回真实的 ~/.pi/agent/records/traffic.db，
    // 让本用例的结果取决于用户真库里有没有启用规则（并且顺带打开了用户的真库）。
    ensureDb().exec("DELETE FROM rewrite_rules");
    resetGate();
    const noRules = before({ payload }, context()) as Promise<void>;
    let finished = false;
    void noRules.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("b: baseUrl 为 null 时不入闸门并递增 nullBaseUrlSkips", async () => {
    ensureDb();
    addRule();
    await handlers.get("before_provider_request")!({ payload }, context({ ...model(), baseUrl: undefined }));
    expect(state.nullBaseUrlSkips).toBe(1);
    expect(currentSlot()).toBeNull();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("baseUrl 未知");
  });

  it("c: requests INSERT 失败时释放已取得的闸门", async () => {
    const database = {
      prepare: (sql: string) => {
        if (sql.includes("FROM rewrite_rules"))
          return { all: () => [{ id: 1, name: "rule", enabled: 1, priority: 1, body_jq: "." }] };
        if (sql.includes("FROM rewrite_settings")) return { all: () => [] };
        if (sql.startsWith("INSERT INTO requests")) throw new Error("insert failed");
        return { run: () => ({ lastInsertRowid: 1 }) };
      },
    } as any;
    state.db = database;
    state.recording = true;
    await handlers.get("before_provider_request")!({ payload }, context());
    expect(currentSlot()).toBeNull();
    expect(state.dbError).toContain("insert failed");
  });

  it("d: recording=false 时 after 仍更新已创建行", async () => {
    const db = ensureDb();
    const result = db
      .prepare("INSERT INTO requests (session_id, turn, ts, provider, model, payload) VALUES (?, 0, ?, ?, ?, ?)")
      .run("hook-session", new Date().toISOString(), "test-provider", "test-model", payload);
    const entry = pending(Number(result.lastInsertRowid));
    pushPending(entry);
    const slot = await acquireSlot(
      { sessionId: entry.sessionId, baseUrl, model: entry.model, modelApi: "anthropic-messages" },
      "hook",
    );
    slot.pending = entry;
    const attempt = beginAttempt(requestUrl, "POST")!;
    claimPending(attempt, payload);
    settleAttempt(attempt, new Response(null, { status: 200, headers: { "request-id": "hook-response" } }));
    state.recording = false;
    await handlers.get("after_provider_response")!(
      { status: 200, headers: { "request-id": "hook-response" } },
      context(),
    );
    expect((db.prepare("SELECT status FROM requests WHERE id = ?").get(entry.rowId) as { status: number }).status).toBe(
      200,
    );
    releaseSlot(slot, "settled");
  });

  it("e: Codex no-fetch 交接超时触发一次性提示和 rewrite_warn", async () => {
    ensureDb();
    addRule();
    vi.useFakeTimers();
    const events: string[] = [];
    state.sseClients.add({
      write: (text: string) => {
        events.push(text);
        return true;
      },
    } as never);
    const before = handlers.get("before_provider_request")!;
    await before({ payload }, context(model({ api: "openai-codex-responses" })));
    expect(currentSlot()).not.toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(currentSlot()).toBeNull();
    expect(state.codexWsWarned).toBe(true);
    expect(notifications.filter((item) => item.message.includes("Codex WebSocket"))).toHaveLength(1);
    expect(events.join("\n")).toContain("Codex WebSocket 传输绕过改写，请将 transport 设为 sse");
  });

  it("f: ensureDb 抛错时 status 仍输出故障信息", async () => {
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "block");
    state.dbPath = join(blocker, "traffic.db");
    const ctx = context();
    await command("status", ctx);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("DB 不可用");
    expect(notifications[0]?.message).toContain("改写已禁用，流量放行");
    expect(notifications[0]?.message).toContain("录制状态");
  });

  it.skipIf(!existsSync("/usr/bin/jq"))("g: session_shutdown 后 session_start 恢复 jq 引擎", async () => {
    const shutdown = handlers.get("session_shutdown")!;
    const start = handlers.get("session_start")!;

    await shutdown({}, context());
    await expect(runJq(".", "{}")).rejects.toMatchObject({
      kind: "spawn_error",
      message: "jq spawn_error: engine shutting down",
    });

    await start({}, context());
    await expect(runJq(".", "{}")).resolves.toBe("{}");
  });
});
