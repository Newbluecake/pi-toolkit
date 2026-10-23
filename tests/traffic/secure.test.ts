import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patchFetch, unpatchFetch } from "../../src/traffic/capture.js";
import { ensureDb } from "../../src/traffic/db.js";
import { registerTrafficRecordHandlers } from "../../src/traffic/index.js";
import { isSecureSession } from "../../src/traffic/secure.js";
import { resetState, state } from "../../src/traffic/state.js";

let dir: string;
let handlers: Map<string, (event: any, ctx: any) => any>;
let command: (args: string, ctx: any) => Promise<void>;
let notes: string[];

function ctx(): any {
  return {
    model: { api: "anthropic-messages", baseUrl: "https://api.example.test/v1", id: "m", provider: "p" },
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => "sec-session" },
    cwd: process.cwd(),
  };
}

const prev = process.env.PI_SECURE_SESSION;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-secure-"));
  resetState();
  state.dbPath = join(dir, "traffic.db");
  notes = [];
  handlers = new Map();
  registerTrafficRecordHandlers({
    on: (e: string, h: any) => handlers.set(e, h),
    registerCommand: (_n: string, o: any) => {
      command = o.handler;
    },
  } as any);
});

afterEach(() => {
  unpatchFetch();
  try {
    state.db?.close();
  } catch {}
  resetState();
  if (prev === undefined) delete process.env.PI_SECURE_SESSION;
  else process.env.PI_SECURE_SESSION = prev;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("PI_SECURE_SESSION 契约", () => {
  it('仅严格等于 "1" 才判定为加密会话，且每次现场读取', () => {
    delete process.env.PI_SECURE_SESSION;
    expect(isSecureSession()).toBe(false);
    process.env.PI_SECURE_SESSION = "0";
    expect(isSecureSession()).toBe(false);
    process.env.PI_SECURE_SESSION = "1";
    expect(isSecureSession()).toBe(true);
    delete process.env.PI_SECURE_SESSION;
    expect(isSecureSession()).toBe(false);
  });

  it("加密会话：全部钩子不创建 traffic.db、不入队、无广播副作用", async () => {
    state.recording = true;
    process.env.PI_SECURE_SESSION = "1";
    handlers.get("session_start")!({}, ctx());
    handlers.get("model_select")!({}, ctx());
    handlers.get("before_provider_headers")!({ headers: { authorization: "x" } }, ctx());
    await handlers.get("before_provider_request")!({ payload: { secret: "TOPSECRET" } }, ctx());
    handlers.get("after_provider_response")!({ status: 200, headers: {} }, ctx());
    handlers.get("message_end")!({ message: { role: "user", content: "TOPSECRET" } }, ctx());
    expect(existsSync(state.dbPath)).toBe(false);
    expect(state.db).toBeNull();
    expect(state.dbError).toBeNull();
  });

  it("加密会话：ensureDb 拒绝打开，即使 state.db 已存在", () => {
    delete process.env.PI_SECURE_SESSION;
    ensureDb();
    expect(state.db).not.toBeNull();
    process.env.PI_SECURE_SESSION = "1";
    expect(() => ensureDb()).toThrow(/PI_SECURE_SESSION/);
  });

  it("加密会话：/record on 拒绝，不开启录制、不建库", async () => {
    process.env.PI_SECURE_SESSION = "1";
    await command("on", ctx());
    expect(state.recording).toBe(false);
    expect(existsSync(state.dbPath)).toBe(false);
    expect(notes.join("\n")).toContain("PI_SECURE_SESSION=1");
    await command("status", ctx());
    expect(existsSync(state.dbPath)).toBe(false);
  });

  it("加密会话：fetch 透传，不写库、不消费响应体；非加密会话仍记录", async () => {
    const real = vi.fn(
      async () => new Response("data: TOPSECRET\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    globalThis.fetch = real as any;
    patchFetch();
    process.env.PI_SECURE_SESSION = "1";
    const res = await globalThis.fetch("https://api.example.test/v1/messages", { method: "POST", body: "{}" });
    expect(await res.text()).toBe("data: TOPSECRET\n\n");
    expect(real).toHaveBeenCalledTimes(1);
    expect(existsSync(state.dbPath)).toBe(false);

    // 中途切回非加密：同一进程每次现场判定（对照组：钩子正常落库）
    delete process.env.PI_SECURE_SESSION;
    state.recording = true;
    await handlers.get("before_provider_request")!({ payload: { a: 1 } }, ctx());
    expect(existsSync(state.dbPath)).toBe(true);
    const n = (ensureDb().prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it("package.json 声明 piSecure.honors", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "fixtures/source-package.json"), "utf8"));
    expect(pkg.piSecure).toEqual({ honors: "PI_SECURE_SESSION/1" });
  });
});
