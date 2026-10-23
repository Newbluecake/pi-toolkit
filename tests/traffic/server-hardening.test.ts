/**
 * T4（traffic-merge plan §4.1 第一期加固 / §8.2 #9）：网页服务加固验收。
 *
 * 覆盖：
 * - 默认绑定 127.0.0.1（LAN 需显式 opt-in：createTrafficServer(engine, { host: "0.0.0.0" })）；
 * - Host 白名单（鉴权前）：127.0.0.1/localhost/[::1]（LAN 绑定时加本机各网卡 IPv4），带端口；否则 421；
 * - 全部 /api/* 要 token（回环亦然）：GET/HEAD 接受 x-record-token 头或 ?token=，状态变更只认头；
 *   摘要定长常量时间比较、空串恒拒、变长候选不抛错；
 * - 反嵌入/元数据头（所有响应）：XFO DENY、CSP frame-ancestors 'none' + base-uri 'none' + form-action 'self'
 *   （不限制 script）、nosniff、Referrer-Policy: no-referrer；敏感路径 Cache-Control: no-store；
 * - 跨域：无 ACAO；OPTIONS 一律 405；非 GET 的 Origin:null / 同站异端口 / Sec-Fetch-Site: cross-site ⇒ 403；
 * - 页面 /：回环免 token（HTML 注入 record-token meta），非回环须带 token；
 * - 外部持锁（busy_timeout=0）下规则写 ⇒ 503「数据库忙」（不无限重试）；
 * - T2b：rewrite settings 响应无 gate 键、serialize_* 标注停用。
 */
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/traffic/db.js";
import type { TrafficEngine } from "../../src/traffic/engine.js";
import { createTrafficServer, type TrafficServer } from "../../src/traffic/server.js";
import { makeEngine, teardownEngine } from "./helpers/engine";

const { DatabaseSync: DatabaseSyncImpl } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

let dir: string;
let engine: TrafficEngine;
let web: TrafficServer;
let port: number;

/** 任意 Host / 头的裸 HTTP 请求（undici 不允许改 Host）。 */
function raw(
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
  hostOverride?: string,
  portOverride?: number,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: portOverride ?? port,
        path,
        method,
        headers: { ...headers, ...(hostOverride ? { host: hostOverride } : {}), connection: "close" },
      },
      (res: IncomingMessage) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function tokenHeader(): Record<string, string> {
  return { "x-record-token": engine.accessToken ?? "" };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-hardening-"));
  engine = makeEngine(dir);
});

afterEach(async () => {
  await teardownEngine(engine);
  rmSync(dir, { recursive: true, force: true });
});

describe("T4 §4.1：默认绑定与监听地址", () => {
  it("默认监听 127.0.0.1（LAN 需显式 opt-in）；/api/state 报告实际绑定", async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
    expect((engine.server!.address() as { address: string }).address).toBe("127.0.0.1");
    const res = await raw("/api/state", tokenHeader());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).host).toBe("127.0.0.1");
  });

  it("LAN opt-in（host: 0.0.0.0）：监听全网卡，accessUrls 带 token 与明文风险提示", async () => {
    web = createTrafficServer(engine, { host: "0.0.0.0" });
    port = await web.startServer();
    expect((engine.server!.address() as { address: string }).address).toBe("0.0.0.0");
    const urls = web.accessUrls(port);
    expect(urls.some((u) => u.includes("?token="))).toBe(true);
    expect(urls.some((u) => u.includes("明文 HTTP"))).toBe(true);
  });

  it("默认绑定时 accessUrls 只报回环（不带 token）", async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
    expect(web.accessUrls(port)).toEqual([`http://127.0.0.1:${port}`]);
  });
});

describe("T4 §4.1：Host 白名单（鉴权前，防 DNS rebinding）", () => {
  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
  });

  it("坏 Host ⇒ 421（带安全头）；无 Host / 无端口同样拒", async () => {
    for (const bad of ["evil.test:4177", "127.0.0.1", "localhost", "evil.test", "[::1]"]) {
      const res = await raw("/api/state", tokenHeader(), "GET", undefined, bad);
      expect(res.status, `Host: ${bad}`).toBe(421);
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
    const none = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/state",
          method: "GET",
          setHost: false,
          headers: { connection: "close" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    // 缺 Host 的 HTTP/1.1 请求可能被 node 解析层直接 400——关键是永远到不了鉴权/路由。
    expect([400, 421]).toContain(none.status);
  });

  it("合法 Host（127.0.0.1 / localhost / [::1]，带端口）通过 Host 闸（进入 token 闸）", async () => {
    for (const good of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const noToken = await raw("/api/state", {}, "GET", undefined, good);
      expect(noToken.status, `Host: ${good}`).toBe(401); // 过了 421，卡在 token
      const withToken = await raw("/api/state", tokenHeader(), "GET", undefined, good);
      expect(withToken.status, `Host: ${good}`).toBe(200);
    }
  });

  it("LAN opt-in 时 Host 白名单包含本机网卡 IPv4；默认绑定时间一 Host ⇒ 421", async () => {
    // 用独立 engine：共享 engine 会复用 beforeEach 已启动的默认绑定 listener（不会真的重绑 0.0.0.0）。
    const lanEngine = makeEngine(dir);
    let lanWeb: TrafficServer | undefined;
    try {
      lanWeb = createTrafficServer(lanEngine, { host: "0.0.0.0" });
      const lanPort = await lanWeb.startServer();
      expect((lanEngine.server!.address() as { address: string }).address).toBe("0.0.0.0");
      const lanIps = Object.values(networkInterfaces())
        .flat()
        .filter((a): a is { family: string; address: string; internal: boolean } => !!a)
        .filter((a) => a.family === "IPv4" && !a.internal)
        .map((a) => a.address);
      expect(lanIps.length).toBeGreaterThan(0);
      for (const ip of lanIps) {
        const res = await raw(
          "/api/state",
          { "x-record-token": lanEngine.accessToken ?? "" },
          "GET",
          undefined,
          `${ip}:${lanPort}`,
          lanPort,
        );
        expect(res.status, `Host: ${ip}:${lanPort}`).toBe(200);
      }
    } finally {
      await teardownEngine(lanEngine);
    }
    // 默认绑定（beforeEach 的 127.0.0.1 listener）时间一 LAN Host ⇒ 421
    const res = await raw("/api/state", tokenHeader(), "GET", undefined, `192.168.31.25:${port}`);
    expect(res.status).toBe(421);
  });
});

describe("T4 §4.1：token 门禁（全部 /api/*，回环亦然）", () => {
  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
  });

  it("回环来源无 token / 错 token ⇒ 401；GET 接受 ?token= 或头", async () => {
    expect((await raw("/api/state", {})).status).toBe(401);
    expect((await raw("/api/state", { "x-record-token": "wrong" })).status).toBe(401);
    expect((await raw(`/api/state?token=${engine.accessToken}`, {})).status).toBe(200);
    expect((await raw("/api/state", tokenHeader())).status).toBe(200);
  });

  it("空串 / 超长候选恒拒且不抛错（摘要比较对变长候选安全）", async () => {
    expect((await raw("/api/state?token=", {})).status).toBe(401);
    const long = "x".repeat(5000);
    const res = await raw(`/api/state?token=${long}`, {});
    expect(res.status).toBe(401);
    expect(res.text).not.toContain("Internal Server Error");
  });

  it("重放 POST 必须带 token + 自定义头：?token= 单独出现 ⇒ 401，头形式通过鉴权", async () => {
    const body = JSON.stringify({ request_id: 1 });
    const queryOnly = await raw(
      `/api/replay?token=${engine.accessToken}`,
      { "content-type": "application/json" },
      "POST",
      body,
    );
    expect(queryOnly.status).toBe(401);
    expect(queryOnly.text).toContain("x-record-token");
    // 头形式 ⇒ 过鉴权（无源记录 ⇒ 404，不是 401/403）
    const viaHeader = await raw("/api/replay", { ...tokenHeader(), "content-type": "application/json" }, "POST", body);
    expect(viaHeader.status).toBe(404);
  });
});

describe("T4 §4.1：跨域与预检", () => {
  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
  });

  it("OPTIONS 一律 405（带不带 token、任意路径），且响应无 ACAO", async () => {
    for (const [path, headers] of [
      ["/api/state", {}],
      ["/api/state", tokenHeader()],
      ["/", {}],
      ["/api/replay", { origin: "http://127.0.0.1:9999", "access-control-request-method": "POST" }],
    ] as const) {
      const res = await raw(path, headers, "OPTIONS");
      expect(res.status, path).toBe(405);
      for (const h of Object.keys(res.headers)) {
        expect(h.startsWith("access-control-allow"), `${path} ${h}`).toBe(false);
      }
    }
  });

  it("非 GET：Origin:null ⇒ 403；同站异端口 Origin ⇒ 403；Sec-Fetch-Site: cross-site ⇒ 403", async () => {
    const body = JSON.stringify({ request_id: 1 });
    const cases: Array<[string, Record<string, string>]> = [
      ["origin: null", { origin: "null" }],
      ["同站异端口", { origin: `http://127.0.0.1:${port + 1}` }],
      ["Sec-Fetch-Site", { "sec-fetch-site": "cross-site" }],
    ];
    for (const [name, extra] of cases) {
      const res = await raw(
        "/api/replay",
        { ...tokenHeader(), "content-type": "application/json", ...extra },
        "POST",
        body,
      );
      expect(res.status, name).toBe(403);
    }
  });

  it("同源 Origin + token 头的 POST 不被跨域闸拒绝；GET 不受 Origin 影响", async () => {
    const res = await raw(
      "/api/replay",
      { ...tokenHeader(), "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      "POST",
      JSON.stringify({ request_id: 1 }),
    );
    expect(res.status).toBe(404); // 过了 403/401，卡在源记录不存在
    const get = await raw("/api/state", { ...tokenHeader(), origin: "http://evil.test" });
    expect(get.status).toBe(200);
  });
});

describe("T4 §4.1：响应头集合（所有响应）", () => {
  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
  });

  const SECURITY_HEADERS: Record<string, string> = {
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };

  it("页面 200 / 401 / 404 / 421 / 405 / API 200 全部带安全头；页面与 /api/* no-store；无 ACAO", async () => {
    const cases: Array<{ name: string; run: () => Promise<{ status: number; headers: Record<string, string> }> }> = [
      { name: "页面 200", run: () => raw("/", {}) },
      { name: "API 401", run: () => raw("/api/state", {}) },
      { name: "API 200", run: () => raw("/api/state", tokenHeader()) },
      { name: "API 404", run: () => raw("/api/nope", tokenHeader()) },
      { name: "Host 421", run: () => raw("/api/state", tokenHeader(), "GET", undefined, "evil.test:1") },
      { name: "OPTIONS 405", run: () => raw("/api/state", {}, "OPTIONS") },
      { name: "静态 404", run: () => raw("/favicon.ico", {}) },
    ];
    for (const c of cases) {
      const res = await c.run();
      for (const [h, v] of Object.entries(SECURITY_HEADERS)) {
        expect(`${c.name} ${h}: ${String(res.headers[h])}`).toBe(`${c.name} ${h}: ${v}`);
      }
      for (const h of Object.keys(res.headers)) {
        expect(h.startsWith("access-control-allow"), `${c.name} ${h}`).toBe(false);
      }
      if (c.name.includes("API") || c.name.startsWith("页面")) {
        expect(res.headers["cache-control"], `${c.name} cache-control`).toBe("no-store");
      }
      if (c.name === "静态 404") {
        expect(res.headers["cache-control"]).toBeUndefined(); // 非敏感路径不强加
      }
    }
  });

  it("页面回环免 token：200 + 注入 record-token meta（内容 = engine token）", async () => {
    const res = await raw("/", {});
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<meta name="record-token" content="${engine.accessToken}">`);
  });

  it("SSE：?token= 查询参数鉴权 + no-store + text/event-stream", async () => {
    // SSE 响应不结束：只读响应头即断开（401 响应会正常结束，走 raw()）。
    const headers = await new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `/api/events?token=${engine.accessToken}`,
          method: "GET",
          headers: { connection: "close" },
        },
        (res) => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string> });
          req.destroy();
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(headers.status).toBe(200);
    expect(headers.headers["content-type"]).toContain("text/event-stream");
    expect(headers.headers["cache-control"]).toBe("no-store");
    expect((await raw("/api/events", {})).status).toBe(401);
  });
});

describe("T4 §4.1：非回环来源的页面门禁（handleHttp 直调，伪造 remoteAddress）", () => {
  interface Captured {
    status: number;
    headers: Record<string, string>;
    body: string;
  }
  function fakeRes(capture: { value: Captured | null }) {
    const set: Record<string, string> = {};
    const lower = (o: Record<string, string>): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = v;
      return out;
    };
    return {
      setHeader: (k: string, v: string) => {
        set[k.toLowerCase()] = String(v);
      },
      writeHead: (status: number, headers?: Record<string, string>) => {
        capture.value = { status, headers: { ...lower(set), ...lower(headers ?? {}) }, body: "" };
      },
      write: (chunk: string) => {
        if (capture.value) capture.value.body += chunk;
      },
      end: (chunk?: string | Buffer) => {
        if (capture.value && chunk !== undefined) capture.value.body += chunk.toString();
      },
    } as never;
  }
  function fakeReq(
    opts: { url: string; method?: string; headers: Record<string, string>; remote: string },
    localPort: number = port,
  ) {
    return {
      url: opts.url,
      method: opts.method ?? "GET",
      headers: opts.headers,
      socket: { remoteAddress: opts.remote, localPort },
      on: () => {},
    } as never;
  }

  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
  });

  it("非回环：无 token 页面 ⇒ 401；?token= ⇒ 200（带 meta + no-store）", async () => {
    // Host 本身合法（默认绑定的回环白名单），来源地址非回环 ⇒ 走 token 闸。
    const remote = "192.168.1.50";
    const denied: { value: Captured | null } = { value: null };
    web.handleHttp(fakeReq({ url: "/", headers: { host: `127.0.0.1:${port}` }, remote }), fakeRes(denied));
    expect(denied.value?.status).toBe(401);

    const allowed: { value: Captured | null } = { value: null };
    web.handleHttp(
      fakeReq({ url: `/?token=${engine.accessToken}`, headers: { host: `127.0.0.1:${port}` }, remote }),
      fakeRes(allowed),
    );
    expect(allowed.value?.status).toBe(200);
    expect(allowed.value?.body).toContain(`<meta name="record-token" content="${engine.accessToken}">`);
    expect(allowed.value?.headers["cache-control"]).toBe("no-store");
  });

  it("LAN 绑定下非回环 Host（本机网卡 IPv4）通过 Host 闸（卡在 token）；evil Host 仍 421", async () => {
    const lanEngine = makeEngine(dir);
    let lanWeb: TrafficServer | undefined;
    try {
      lanWeb = createTrafficServer(lanEngine, { host: "0.0.0.0" });
      const lanPort = await lanWeb.startServer();
      const ip =
        Object.values(networkInterfaces())
          .flat()
          .find(
            (a): a is { family: string; address: string; internal: boolean } =>
              !!a && a.family === "IPv4" && !a.internal,
          )?.address ?? "10.0.0.1";
      const ok: { value: Captured | null } = { value: null };
      lanWeb.handleHttp(
        fakeReq({ url: "/", headers: { host: `${ip}:${lanPort}` }, remote: "192.168.1.50" }, lanPort),
        fakeRes(ok),
      );
      // Host 过闸 ⇒ 进入 token 闸：非回环来源、无 token ⇒ 401（不是 421）
      expect(ok.value?.status).toBe(401);
      const withToken: { value: Captured | null } = { value: null };
      lanWeb.handleHttp(
        fakeReq(
          { url: `/?token=${lanEngine.accessToken}`, headers: { host: `${ip}:${lanPort}` }, remote: "192.168.1.50" },
          lanPort,
        ),
        fakeRes(withToken),
      );
      expect(withToken.value?.status).toBe(200);
      const bad: { value: Captured | null } = { value: null };
      lanWeb.handleHttp(
        fakeReq({ url: "/", headers: { host: `rebind.evil:${lanPort}` }, remote: "192.168.1.50" }, lanPort),
        fakeRes(bad),
      );
      expect(bad.value?.status).toBe(421);
    } finally {
      await teardownEngine(lanEngine);
    }
  });
});

describe("T2b 对接：闸门退役 + 外部持锁 ⇒ 503", () => {
  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
    openDb(engine.dbPath, { legacyDbPath: null }); // 建库
  });

  it("rewrite settings 响应无 gate 键；serialize_* 标注停用（serialize_retired）", async () => {
    const res = await raw("/api/rewrite/settings", tokenHeader());
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(body.gate).toBeUndefined();
    expect(body.serialize_retired).toBe(true);
    expect(body.serialize_handoff_ms).toBe(10000); // 旧键仍在（页面展示停用值）
  });

  it("外部进程持写锁（busy_timeout=0）下规则写 ⇒ 503「数据库忙」，不无限重试", async () => {
    const holder = new DatabaseSyncImpl(engine.dbPath);
    try {
      holder.exec("PRAGMA busy_timeout = 0");
      holder.exec("BEGIN IMMEDIATE");
      const rule = JSON.stringify({ name: "r", priority: 100 });
      const t0 = Date.now();
      const res = await raw(
        "/api/rewrite/rules",
        { ...tokenHeader(), "content-type": "application/json" },
        "POST",
        rule,
      );
      expect(Date.now() - t0).toBeLessThan(2000); // 立即失败，不是挂等
      expect(res.status).toBe(503);
      expect(res.text).toContain("数据库忙");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    // 释放后恢复
    const ok = await raw(
      "/api/rewrite/rules",
      { ...tokenHeader(), "content-type": "application/json" },
      "POST",
      JSON.stringify({ name: "r", priority: 100 }),
    );
    expect(ok.status).toBe(201);
  });
});

describe("T4：连接记账不被加固破坏（T2a 行为保持）", () => {
  it("accepted socket unref 并记账，close 后清空", async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
    const res = await raw("/api/state", tokenHeader());
    expect(res.status).toBe(200);
    expect(engine.connections.size).toBeGreaterThanOrEqual(1);
    await engine.close("test");
    expect(engine.connections.size).toBe(0);
    // close 后端口可重绑（无残留 listener）
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(port, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});

describe("安全评审 #1：导出跨页（keyset 游标）——messages 必须选 id", () => {
  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
    const d = openDb(engine.dbPath, { legacyDbPath: null });
    // 450 对请求/assistant：超过 2 个分页（200 行/页），覆盖游标跨页前进
    const insReq = d.prepare(
      `INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers, url, method)
       VALUES ('S-exp', 0, ?, 'p', 'm', ?, '{}', 'http://up/', 'POST')`,
    );
    const insMsg = d.prepare(
      `INSERT INTO messages (session_id, ts, role, message) VALUES ('S-exp', ?, 'assistant', ?)`,
    );
    for (let i = 0; i < 450; i++) {
      insReq.run(new Date(2025, 0, 1, 0, 0, i).toISOString(), JSON.stringify({ i }));
      insMsg.run(new Date(2025, 0, 2, 0, 0, i).toISOString(), JSON.stringify({ reply: `r${i}` }));
    }
    // 一条 replay 行与一条 blocked 行不进数据集
    d.prepare(
      `INSERT INTO requests (session_id, turn, ts, payload, origin) VALUES ('S-exp', 0, 't2', '{}', 'replay')`,
    ).run();
    d.prepare(
      `INSERT INTO requests (session_id, turn, ts, payload, rewrite_status) VALUES ('S-exp', 0, 't3', '{}', 'blocked')`,
    ).run();
  });

  it("跨多页导出：行数与全量一致、配对逐行正确、无 NaN 游标丢行", async () => {
    const res = await raw(`/api/export?session_id=S-exp`, tokenHeader());
    expect(res.status).toBe(200);
    const lines = res.text.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(450); // 全量：450 对，replay/blocked 不进
    for (let i = 0; i < lines.length; i++) {
      const row = JSON.parse(lines[i]!) as { request_id: number; request: { i: number }; response: { reply: string } };
      expect(row.request_id, `第 ${i} 行 request_id`).toBe(i + 1); // id 升序、无跳页
      expect(row.request.i).toBe(i);
      expect(row.response?.reply).toBe(`r${i}`); // 配对：第 k 请求 ↔ 第 k assistant
    }
  });
});

describe("安全评审 #2：流式导出（背压 + 客户端断开取消 + 有界内存）", () => {
  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
    const d = openDb(engine.dbPath, { legacyDbPath: null });
    const insReq = d.prepare(
      `INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers, url, method)
       VALUES ('S-stream', 0, ?, 'p', 'm', ?, '{}', 'http://up/', 'POST')`,
    );
    const insMsg = d.prepare(
      `INSERT INTO messages (session_id, ts, role, message) VALUES ('S-stream', ?, 'assistant', ?)`,
    );
    // 1200 对（≥6 页/段），单行 payload 加大促使页内预算让出（提前 yield 后继续读取）
    // 单行 64 KiB：首页（200 行 ≈ 12.8 MiB）必然超出内核/写缓冲 ⇒ drain 阻塞发生在第 1-2 页内
    const fat = "x".repeat(65_536);
    for (let i = 0; i < 1200; i++) {
      insReq.run(new Date(2025, 0, 1, 0, 0, i).toISOString(), JSON.stringify({ i, fat }));
      insMsg.run(new Date(2025, 0, 2, 0, 0, i).toISOString(), JSON.stringify({ reply: `r${i}`, fat }));
    }
  });

  /**
   * 安全评审 #2 第二轮：包装 async iterable 本身——只统计**每次实际 next() 产出一页**的推进
   * （不是迭代器创建次数）；转发取消参数（deadlineMs/signal）；保留迭代器清理（return 转发）。
   */
  function probePages(): {
    advances: () => number;
    returns: () => number;
    lastSignal: () => AbortSignal | undefined;
    restore: () => void;
  } {
    const target = engine.dbPort as unknown as {
      pages: (q: unknown, opts?: { deadlineMs?: number; signal?: AbortSignal }) => AsyncIterable<unknown[]>;
    };
    const orig = target.pages.bind(engine.dbPort);
    let advanced = 0;
    let returned = 0;
    let signal: AbortSignal | undefined;
    target.pages = (q, opts) => {
      signal = opts?.signal;
      const inner = orig(q, opts);
      const wrap = {
        next: async (...a: [] | [unknown]) => {
          const r = await inner.next(...(a as []));
          if (!r.done) advanced++; // 仅真实产出一页才计
          return r;
        },
        return: async (v?: unknown) => {
          returned++;
          return inner.return!(v);
        },
        throw: async (e?: unknown) => inner.throw!(e),
      };
      return { [Symbol.asyncIterator]: () => wrap } as AsyncIterable<unknown[]>;
    };
    return {
      advances: () => advanced,
      returns: () => returned,
      lastSignal: () => signal,
      restore: () => delete target.pages,
    };
  }

  it("背压期间不推进；断开 ⇒ 推进停止 + signal aborted + 迭代器已 return", async () => {
    const probe = probePages();
    let status = 0;
    let firstChunk: Buffer | null = null;
    let resClosed: (() => void) | null = null;
    const closedPromise = new Promise<void>((r) => (resClosed = r));
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/export?session_id=S-stream",
        method: "GET",
        headers: { ...tokenHeader(), connection: "close" },
      },
      (res) => {
        status = res.statusCode ?? 0;
        res.once("data", (c: Buffer) => {
          firstChunk = c;
          res.pause(); // 慢消费者：拿到首块即停 —— 服务端必须卡在 drain 上
        });
        res.once("close", () => resClosed?.());
      },
    );
    req.on("error", () => resClosed?.()); // destroy 之后的 reset 属预期，同样视作断开
    // 显式制造背压：把客户端接收窗压到 ~8 KiB（内核回环会吞掉几十 MB——不缩窗就永远等不到 drain）
    req.on("socket", (sock) => {
      sock.setNoDelay(true);
      try {
        sock.setRecvBufferSize(8192);
      } catch {}
    });
    req.end();

    // ① 显式背压：拿到首块即暂停读取 ⇒ 服务端写缓冲填满 ⇒ 卡在 drain 上
    const deadline = Date.now() + 10_000;
    while (firstChunk === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(status).toBe(200);
    expect(firstChunk !== null && firstChunk.length > 0).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const frozen = probe.advances();
    // 8 KiB 接收窗 ⇒ 首个 64 KiB 行就应卡 drain；预算碎片页（2ms 预算可提前让出）放宽到 ≤6，
    // 全量跑完需要 ~20+ 次推进——冻结值必须远小于它。
    expect(frozen).toBeLessThanOrEqual(6);
    await new Promise((r) => setTimeout(r, 400));
    expect(probe.advances()).toBe(frozen); // 背压窗口内零推进（等待 drain 不拉页）

    // ② 断开：推进停止、signal 已 aborted、迭代器已退出（return 被转发调用）
    req.destroy();
    await closedPromise;
    await new Promise((r) => setTimeout(r, 400));
    expect(probe.advances()).toBe(frozen); // 断开后零推进
    expect(probe.lastSignal()?.aborted).toBe(true);
    expect(probe.returns()).toBeGreaterThanOrEqual(2); // requests + assistants 两个迭代器都被 return
    probe.restore();
  });

  it("完整导出大集合：流式完成后行数正确（背压路径下不丢行）", async () => {
    const res = await raw(`/api/export?session_id=S-stream`, tokenHeader());
    expect(res.status).toBe(200);
    const lines = res.text.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1200);
    const first = JSON.parse(lines[0]!) as { request: { i: number }; response: { reply: string } };
    const last = JSON.parse(lines[1199]!) as { request: { i: number }; response: { reply: string } };
    expect(first.request.i).toBe(0);
    expect(first.response.reply).toBe("r0");
    expect(last.request.i).toBe(1199);
    expect(last.response.reply).toBe("r1199");
  });
});

describe("安全评审 #3：readBody 字节上限（越限停读 + 413）", () => {
  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
    openDb(engine.dbPath, { legacyDbPath: null });
  });

  it("超过 32 MiB 的 POST ⇒ 413（或连接关闭），服务保持健康", async () => {
    const outcome = await new Promise<{ status: number | null; reset: boolean }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/rewrite/rules",
          method: "POST",
          headers: {
            ...tokenHeader(),
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            connection: "close",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, reset: false }));
        },
      );
      req.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ECONNRESET" || code === "EPIPE") resolve({ status: null, reset: true });
        else reject(err);
      });
      // 持续上传 40 MiB（服务端在 32 MiB 处停读并回 413 + close）
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const pump = (): void => {
        while (sent < 40 && req.write(chunk)) sent++;
        if (sent >= 40) {
          req.end();
          return;
        }
        sent++;
        req.once("drain", pump);
      };
      pump();
    });
    expect([413, null]).toContain(outcome.status); // 413 到达或连接被关（有界丢弃）
    // 服务未被拖垮：后续请求正常
    const ok = await raw("/api/state", tokenHeader());
    expect(ok.status).toBe(200);
  }, 20_000);
});

describe("安全评审 #4：公开错误边界（内部异常不泄露细节）", () => {
  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
    openDb(engine.dbPath, { legacyDbPath: null });
  });

  it("内部异常 ⇒ E_INTERNAL 固定文案；db_error 清洗；响应不含路径/token 哨兵", async () => {
    const sentinelPath = "/home/sentinel-user/secret-dir";
    const sentinelToken = "sk-sentinel-api-key-123";
    const realDb = engine.db;
    // 注入：db.prepare 抛出携带哨兵的内部异常
    (engine as { db: unknown }).db = {
      prepare: () => {
        throw new Error(`boom at ${sentinelPath} with ${sentinelToken}`);
      },
      exec: () => {
        throw new Error("boom");
      },
    };
    try {
      const res = await raw("/api/requests", tokenHeader());
      expect(res.status).toBe(500);
      expect(res.text).toContain("internal error");
      expect(res.text).toContain("E_INTERNAL");
      expect(res.text).not.toContain(sentinelPath);
      expect(res.text).not.toContain(sentinelToken);
      expect(res.text).not.toContain("/home/");
      // db_error 字段（/api/state，200 响应）同样清洗
      const state = await raw("/api/state", tokenHeader());
      expect(state.status).toBe(200);
      const dbError = String(JSON.parse(state.text).db_error ?? "");
      expect(dbError).not.toContain(sentinelPath);
      expect(dbError).not.toContain(sentinelToken);
      expect(dbError).not.toContain("/home/");
    } finally {
      (engine as { db: unknown }).db = realDb;
    }
  });
});

describe("安全评审 #5：攻击矩阵（Host 变体 / X-Forwarded-* / 简单请求 / 零副作用）", () => {
  let upstreamHits = 0;
  let upstreamSrv: ReturnType<typeof createServer>;
  let replayableId: number;
  let rowsBefore = 0;

  beforeEach(async () => {
    upstreamHits = 0;
    upstreamSrv = createServer((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => upstreamSrv.listen(0, "127.0.0.1", r));
    web = createTrafficServer(engine);
    port = await web.startServer();
    const d = openDb(engine.dbPath, { legacyDbPath: null });
    const upPort = (upstreamSrv.address() as { port: number }).port;
    replayableId = Number(
      d
        .prepare(
          `INSERT INTO requests (session_id, turn, ts, payload, request_headers, url, method)
           VALUES ('S-attack', 0, 't', '{}', '{}', ?, 'POST')`,
        )
        .run(`http://127.0.0.1:${upPort}/x`).lastInsertRowid,
    );
    rowsBefore = (d.prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;
  });

  afterEach(async () => {
    await new Promise<void>((r) => upstreamSrv.close(() => r()));
  });

  function rows(): number {
    const d = openDb(engine.dbPath, { legacyDbPath: null });
    return (d.prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;
  }

  /** 断言被拒请求零副作用：上游零命中、requests 表零新增。 */
  const expectNoSideEffects = (): void => {
    expect(upstreamHits).toBe(0);
    expect(rows()).toBe(rowsBefore);
  };

  it("Host 变体：大小写与三种回环写法放行；错误端口/尾点/别名/扩展 IPv6 拒绝", async () => {
    const allowed = [
      `LOCALHOST:${port}`,
      `Localhost:${port}`,
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ];
    for (const host of allowed) {
      const res = await raw("/api/state", tokenHeader(), "GET", undefined, host);
      expect(res.status, `Host: ${host}`).toBe(200);
    }
    const rejected = [
      `localhost:${port + 1}`, // 正确主机、错误端口
      `localhost.:${port}`, // 尾点
      `127.0.0.1.:${port}`, // IPv4 尾点
      `127.0.0.2:${port}`, // 回环别名（不在白名单）
      `[0:0:0:0:0:0:0:1]:${port}`, // 扩展 IPv6 写法（不在白名单）
      `[::1]`, // IPv6 无端口
      `ip6-localhost:${port}`, // 别名
    ];
    for (const host of rejected) {
      const res = await raw("/api/state", tokenHeader(), "GET", undefined, host);
      expect(res.status, `Host: ${host}`).toBe(421);
    }
  });

  it("X-Forwarded-Host/For/Proto 不影响判定：合法 Host 照常 200，坏 Host 仍 421", async () => {
    const forwarded = {
      "x-forwarded-host": "evil.test",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "https",
      forwarded: "for=127.0.0.1;host=evil.test;proto=https",
    };
    const good = await raw("/api/state", { ...tokenHeader(), ...forwarded }, "GET", undefined, `localhost:${port}`);
    expect(good.status).toBe(200);
    const bad = await raw("/api/state", { ...tokenHeader(), ...forwarded }, "GET", undefined, "evil.test:4177");
    expect(bad.status).toBe(421);
  });

  it("表单 urlencoded / text/plain 简单请求 POST（无自定义头 token）⇒ 401，零副作用", async () => {
    for (const contentType of ["application/x-www-form-urlencoded", "text/plain"]) {
      const res = await raw("/api/replay", { "content-type": contentType }, "POST", `request_id=${replayableId}`);
      expect(res.status, contentType).toBe(401); // 简单请求带不了 x-record-token ⇒ 恒拒
      expectNoSideEffects();
    }
  });

  it("合法 token 头 + 无 Origin（缺元数据）⇒ 按规格放行；Origin:null 带合法 token 仍拒", async () => {
    const body = JSON.stringify({ request_id: replayableId });
    // 缺元数据 + 头 token + text/plain（内容仍是合法 JSON）⇒ 放行（重放成功，200）
    const ok = await raw("/api/replay", { ...tokenHeader(), "content-type": "text/plain" }, "POST", body);
    expect(ok.status).toBe(200);
    expect(upstreamHits).toBe(1);
    rowsBefore = rows(); // 产生了重放行（合法副作用），更新基线
    // Origin:null + 合法 token ⇒ 仍拒（跨域闸在 token 闸之后仍生效）
    const denied = await raw(
      "/api/replay",
      { ...tokenHeader(), "content-type": "application/json", origin: "null" },
      "POST",
      body,
    );
    expect(denied.status).toBe(403);
    expect(upstreamHits).toBe(1); // 无新上游调用
    expect(rows()).toBe(rowsBefore); // rowsBefore 已含那次合法重放行；被拒请求零新增
  });
});

describe("安全评审 #4 第二轮：公开错误边界（PublicInputError 白名单 + 三类哨兵注入）", () => {
  const SENTINEL_PATH = "/home/sentinel-user/secret-dir";
  const SENTINEL_KEY = "sk-sentinel-api-key-123";
  const SENTINEL_TEXT = "internal-quirk-detail";

  function sentinelDb(): { restore: () => void } {
    const real = engine.db;
    (engine as { db: unknown }).db = {
      prepare: () => {
        throw new Error(`${SENTINEL_TEXT} at ${SENTINEL_PATH} with ${SENTINEL_KEY}`);
      },
      exec: () => {
        throw new Error(SENTINEL_TEXT);
      },
    };
    return { restore: () => ((engine as { db: unknown }).db = real) };
  }

  /** 响应正文不得包含任何哨兵（路径 / API-key / 内部错误文本）。 */
  const expectClean = (text: string): void => {
    expect(text).not.toContain(SENTINEL_PATH);
    expect(text).not.toContain(SENTINEL_KEY);
    expect(text).not.toContain(SENTINEL_TEXT);
    expect(text).not.toContain("/home/");
  };

  beforeEach(async () => {
    web = createTrafficServer(engine);
    port = await web.startServer();
    openDb(engine.dbPath, { legacyDbPath: null });
  });

  it("白名单保持：参数校验错误（PublicInputError）仍回 400 + 公开文案", async () => {
    const bad = await raw(
      "/api/rewrite/rules",
      { ...tokenHeader(), "content-type": "application/json" },
      "POST",
      JSON.stringify({ name: "r", priority: 999999 }),
    );
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("priority 必须是");
    const badBody = await raw("/api/rewrite/rules", { ...tokenHeader() }, "POST", "{not json");
    expect(badBody.status).toBe(400);
    expect(badBody.text).toContain("请求体不是合法 JSON");
  });

  it("写接口（规则 POST）：合法入参 + 内部异常 ⇒ E_INTERNAL，哨兵不出站", async () => {
    const guard = sentinelDb();
    try {
      const res = await raw(
        "/api/rewrite/rules",
        { ...tokenHeader(), "content-type": "application/json" },
        "POST",
        JSON.stringify({ name: "r", priority: 100 }),
      );
      expect(res.status).toBe(500);
      expect(res.text).toContain("internal error");
      expect(res.text).toContain("E_INTERNAL");
      expectClean(res.text);
    } finally {
      guard.restore();
    }
  });

  it("重放 DB 失败：源查询抛内部异常 ⇒ 503 固定 db 文案，哨兵不出站", async () => {
    const guard = sentinelDb();
    try {
      const res = await raw(
        "/api/replay",
        { ...tokenHeader(), "content-type": "application/json" },
        "POST",
        JSON.stringify({ request_id: 1 }),
      );
      expect(res.status).toBe(503);
      expect(res.text).toContain("数据库不可用");
      expectClean(res.text);
    } finally {
      guard.restore();
    }
  });

  it("重放 DB 打开失败（tryDb 的 !d 分支）⇒ 503 固定 db 文案，哨兵不出站", async () => {
    const e = engine as unknown as { db: unknown; loadSqlite: unknown };
    const realDb = e.db;
    const realLoad = e.loadSqlite;
    e.db = null;
    e.loadSqlite = () => {
      throw new Error(`${SENTINEL_TEXT} at ${SENTINEL_PATH} with ${SENTINEL_KEY}`);
    };
    try {
      const res = await raw(
        "/api/replay",
        { ...tokenHeader(), "content-type": "application/json" },
        "POST",
        JSON.stringify({ request_id: 1 }),
      );
      expect(res.status).toBe(503);
      expect(res.text).toContain("数据库不可用");
      expectClean(res.text);
    } finally {
      e.db = realDb;
      e.loadSqlite = realLoad;
    }
  });

  it("上游失败：fetch 抛含哨兵的异常 ⇒ 502 固定文案，哨兵不出站", async () => {
    // 种一条可重放记录（真实 url，合法入参）
    const d = openDb(engine.dbPath, { legacyDbPath: null });
    const srcId = Number(
      d
        .prepare(
          `INSERT INTO requests (session_id, turn, ts, payload, request_headers, url, method)
           VALUES ('S-upstream', 0, 't', '{}', '{}', 'http://127.0.0.1:1/x', 'POST')`,
        )
        .run().lastInsertRowid,
    );
    // 让重放的 fetch 以含哨兵的内部异常失败（重放走 globalThis.fetch 兜底——本引擎未安装 tap）
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error(`${SENTINEL_TEXT} at ${SENTINEL_PATH} with ${SENTINEL_KEY}`);
    }) as typeof globalThis.fetch;
    try {
      const res = await raw(
        "/api/replay",
        { ...tokenHeader(), "content-type": "application/json" },
        "POST",
        JSON.stringify({ request_id: srcId }),
      );
      expect(res.status).toBe(502);
      expect(res.text).toContain("上游请求失败");
      expectClean(res.text);
      // 行内记录的是清洗后的细节（库内行不是公开响应，但同样不得带 token/路径哨兵）
      const row = openDb(engine.dbPath, { legacyDbPath: null })
        .prepare("SELECT response_headers FROM requests WHERE origin = 'replay'")
        .get() as { response_headers: string } | undefined;
      expect(row).toBeTruthy();
      expect(row!.response_headers).not.toContain(SENTINEL_PATH);
      expect(row!.response_headers).not.toContain(SENTINEL_KEY);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
