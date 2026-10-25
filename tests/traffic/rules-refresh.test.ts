/**
 * 规则快照即时刷新（T2b 安全评审 #4 收尾）：发送路径只读 engine 的内存规则快照；网页规则 CRUD / settings PUT 成功后
 * 立即 `engine.refreshRules()`，紧接着的 provider 请求即使用新规则（不等 1s 后台定时器）。后台定时器 unref、close 时清除。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peekEngine, RULES_REFRESH_MS, type TrafficEngine } from "../../src/traffic/engine.js";
import { activate, createUpstream, fullRequest, type Activation, type Upstream } from "./helpers/harness.js";
import { teardownEngine } from "./helpers/engine.js";

const HAS_JQ = existsSync("/usr/bin/jq");

let dir: string;
let realFetch: typeof globalThis.fetch;
let up: Upstream;
let host: Activation;
let engine: TrafficEngine;
let setIntervalSpy: ReturnType<typeof vi.spyOn>;
let clearIntervalSpy: ReturnType<typeof vi.spyOn>;

/**
 * 直连 hub 端点（绕过已装 tap 的 globalThis.fetch：网页 API 不是 provider 请求）。`connection: close`：每个用例的 hub
 * 都监听同一端口，复用上一用例已被服务端销毁的 keep-alive 连接会偶发 "other side closed"。
 */
async function api(path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await realFetch(`http://127.0.0.1:${engine.serverPort}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-record-token": engine.accessToken ?? "", connection: "close" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

function sentTemperature(i: number): unknown {
  return JSON.parse(up.calls[i]!.body!).temperature;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-rules-refresh-"));
  realFetch = globalThis.fetch;
  up = createUpstream();
  globalThis.fetch = up.fetch;
  setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  host = activate({ dbPath: join(dir, "traffic.db"), sessionId: "S-rules" });
  await host.commands.get("record")!("on", host.ctx({ mode: "tui" }));
  engine = peekEngine()!;
  expect(engine.recording).toBe(true);
  expect(engine.serverPort).not.toBeNull();
});

afterEach(async () => {
  await teardownEngine(engine);
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAS_JQ)("网页规则 CRUD ⇒ 快照立即刷新", () => {
  it("POST / PUT / DELETE 规则后紧接着的请求即使用新规则（不等后台定时器）", async () => {
    const names = (): string[] => engine.rulesSnapshot.rules.map((r) => r.name);
    await fullRequest(host, { temperature: 1, n: 0 });
    expect(sentTemperature(0)).toBe(1);

    const created = await api("/api/rewrite/rules", "POST", {
      name: "zero",
      enabled: true,
      body_jq: ".temperature = 0",
    });
    expect(created.status).toBe(201);
    // 响应到达时快照已更新 ⇒ 生效来自 CRUD 后的同步刷新，而不是 1s 后台定时器（不依赖墙钟）。
    expect(names()).toEqual(["zero"]);
    await fullRequest(host, { temperature: 1, n: 1 });
    expect(sentTemperature(1)).toBe(0);

    const id = created.json.id as number;
    const updated = await api(`/api/rewrite/rules/${id}`, "PUT", {
      name: "half",
      enabled: true,
      body_jq: ".temperature = 0.5",
    });
    expect(updated.status).toBe(200);
    expect(names()).toEqual(["half"]);
    await fullRequest(host, { temperature: 1, n: 2 });
    expect(sentTemperature(2)).toBe(0.5);

    const disabled = await api(`/api/rewrite/rules/${id}`, "PUT", {
      name: "half",
      enabled: false,
      body_jq: ".temperature = 0.5",
    });
    expect(disabled.status).toBe(200);
    expect(names()).toEqual([]);
    await fullRequest(host, { temperature: 1, n: 3 });
    expect(sentTemperature(3)).toBe(1);

    await api(`/api/rewrite/rules/${id}`, "PUT", { name: "half", enabled: true, body_jq: ".temperature = 0.5" });
    const deleted = await api(`/api/rewrite/rules/${id}`, "DELETE");
    expect(deleted.status).toBe(200);
    expect(names()).toEqual([]);
    await fullRequest(host, { temperature: 1, n: 4 });
    expect(sentTemperature(4)).toBe(1);
  });

  it("rewrite settings PUT 后快照设置立即更新", async () => {
    expect(engine.rulesSnapshot.settings.timeoutMs).toBe(2000);
    const res = await api("/api/rewrite/settings", "PUT", { timeout_ms: 1500 });
    expect(res.status).toBe(200);
    expect(engine.rulesSnapshot.settings.timeoutMs).toBe(1500);
  });
});

describe("后台刷新定时器", () => {
  it("间隔 1s、unref（不挂住 print 模式进程）；engine.close 时清除", async () => {
    const calls = setIntervalSpy.mock.calls.filter(([, ms]) => ms === RULES_REFRESH_MS);
    expect(calls).toHaveLength(1);
    const timer = setIntervalSpy.mock.results[setIntervalSpy.mock.calls.findIndex(([, ms]) => ms === RULES_REFRESH_MS)]!
      .value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    // 幂等：再次 /record on 不新建定时器。
    await host.commands.get("record")!("on", host.ctx({ mode: "tui" }));
    expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === RULES_REFRESH_MS)).toHaveLength(1);
    await engine.close("test");
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });
});
