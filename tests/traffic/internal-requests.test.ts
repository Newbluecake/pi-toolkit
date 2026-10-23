/**
 * #7 内部请求接入矩阵（plan §5.4）：逐行以真实调用形状（fake runtime）断言「结构上无票据即透传」。
 *
 * | 来源                                   | 钩子              | 票据   | 录制 | 改写 |
 * | -------------------------------------- | ----------------- | ------ | ---- | ---- |
 * | 主/子会话 agent loop                   | headers + payload | 有     | 是   | 是   |
 * | pi 原生 cache warmer                   | headers + payload | 有     | 可证明时绑定 | （规则启用时 T5 否决） |
 * | compaction / branch summary            | 仅 headers        | 未配对 | 否   | 否   |
 * | title（modelRegistry.complete）        | 无                | 无     | 否   | 否   |
 * | topic judge（streamSimple / complete） | 无                | 无     | 否   | 否   |
 * | keepalive pipeline ping / measure / probe（自带 transformHeaders） | 无 | 无 | 否 | 否 |
 * | quota、ping-client、web_search、feishu、hub（裸 fetch） | 无 | 无 | 否 | 否 |
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDb } from "../../src/traffic/db.js";
import { peekEngine, type TrafficEngine } from "../../src/traffic/engine.js";
import { TICKET_HEADER } from "../../src/traffic/tap.js";
import {
  activate,
  beginRequest,
  createUpstream,
  fullRequest,
  URL_MESSAGES,
  type Activation,
  type Upstream,
} from "./helpers/harness.js";
import { teardownEngine } from "./helpers/engine.js";

const HAS_JQ = existsSync("/usr/bin/jq");
const body = { model: "m", temperature: 1, messages: [{ role: "user", content: "hi" }] };
const bodyText = JSON.stringify(body);

let dir: string;
let dbPath: string;
let realFetch: typeof globalThis.fetch;
let up: Upstream;
let host: Activation;
let engine: TrafficEngine;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-internal-"));
  dbPath = join(dir, "traffic.db");
  realFetch = globalThis.fetch;
  up = createUpstream();
  globalThis.fetch = up.fetch;
  host = activate({ dbPath, sessionId: "S-main" });
  await host.commands.get("record")!("on", host.ctx());
  engine = peekEngine()!;
  if (HAS_JQ) {
    const now = new Date().toISOString();
    ensureDb(engine)
      .prepare(
        "INSERT INTO rewrite_rules (name, enabled, priority, body_jq, created_at, updated_at) VALUES ('t0', 1, 1, '.temperature = 0', ?, ?)",
      )
      .run(now, now);
    engine.refreshRules(); // 发送路径只读内存快照（安全评审 #4）
  }
});

afterEach(async () => {
  await teardownEngine(engine);
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

async function rows(): Promise<Array<Record<string, any>>> {
  await engine.dbPort.whenIdle();
  return ensureDb(engine).prepare("SELECT * FROM requests ORDER BY id").all() as Array<Record<string, any>>;
}

/** 不经扩展钩子的「模型调用」：直通 runtime 的 complete/streamSimple，或自带 transformHeaders 的 pipeline，或裸 fetch。 */
async function hooklessCall(extraHeaders: Record<string, string> = {}): Promise<void> {
  const res = await globalThis.fetch(URL_MESSAGES, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k", ...extraHeaders },
    body: bodyText,
  });
  await res.text();
}

describe("§5.4 接入矩阵", () => {
  it.skipIf(!HAS_JQ)("主会话 agent loop：有票据、录制、改写", async () => {
    await fullRequest(host, body);
    expect(JSON.parse(up.calls[0]!.body!).temperature).toBe(0);
    const [row] = await rows();
    expect(row).toMatchObject({ session_id: "S-main", rewrite_status: "applied", status: 200, url: URL_MESSAGES });
  });

  it.skipIf(!HAS_JQ)(
    "子会话 agent loop（consult / verifier / workflow 子 agent 同路径）：有票据、以子会话 id 录制、改写",
    async () => {
      const child = activate({ role: "child", dbPath, sessionId: "S-child" });
      await fullRequest(child, body);
      expect(JSON.parse(up.calls[0]!.body!).temperature).toBe(0);
      const [row] = await rows();
      expect(row).toMatchObject({ session_id: "S-child", rewrite_status: "applied" });
    },
  );

  it("子会话 childSessions=false：票据照常（改写仍精确归属），不落库", async () => {
    const child = activate({ role: "child", dbPath, sessionId: "S-child", childPersist: false });
    const req = await beginRequest(child);
    expect(req.ticket()).not.toBeNull();
    await req.payload(body);
    expect(engine.tickets.lookup(req.ticket()!)!.generation).not.toBeNull();
    const res = await req.fetch(bodyText);
    await res.text();
    expect(await rows()).toHaveLength(0);
    if (HAS_JQ) {
      expect(JSON.parse(up.calls[0]!.body!).temperature).toBe(0);
      // 安全评审 #8：「实际改写已发出」与是否录行解耦（T5 vetoCapture 依赖）。
      expect(engine.lastRewrittenAt.get("S-child")).toEqual(expect.any(Number));
    }
  });

  it("pi 原生 cache warmer（复制 requestOptions ⇒ 两个钩子都触发，maxTokens:1）：可证明时绑定并录制", async () => {
    await host.emit("cache_warming_decision", { action: "send", warmCost: 0, missCost: 1, continuationProbability: 1 });
    const warm = await beginRequest(host);
    expect(warm.ticket()).not.toBeNull();
    await warm.payload({ ...body, max_tokens: 1 });
    const res = await warm.fetch(JSON.stringify({ ...body, max_tokens: 1 }));
    await warm.respond(res);
    await res.text();
    const [row] = await rows();
    expect(JSON.parse(row!.payload).max_tokens).toBe(1);
    expect(row!.status).toBe(200);
  });

  it("compaction / branch summary（只触发 headers）：票据未配对 ⇒ 不录、不改写、剥离票据头", async () => {
    const comp = await beginRequest(host);
    expect(comp.ticket()).not.toBeNull();
    const res = await comp.fetch(bodyText);
    await res.text();
    expect(up.calls[0]!.body).toBe(bodyText);
    expect(up.calls[0]!.headers[TICKET_HEADER]).toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });

  it("title（modelRegistry.complete 直通 runtime，不经钩子）：无票据 ⇒ 字节不变、不录", async () => {
    await hooklessCall();
    expect(up.calls[0]!.body).toBe(bodyText);
    expect(await rows()).toHaveLength(0);
  });

  it("topic judge（streamSimple / complete）：无票据 ⇒ 字节不变、不录", async () => {
    await hooklessCall({ accept: "text/event-stream" });
    expect(up.calls[0]!.body).toBe(bodyText);
    expect(await rows()).toHaveLength(0);
  });

  it("keepalive pipeline ping / measure / probe（自带 transformHeaders，不是扩展 runner 的）：无票据 ⇒ 不录不改写", async () => {
    // 即使与一个已配对的会话请求并发（同 URL、同正文），也不会被认领。
    const req = await beginRequest(host);
    await req.payload(body);
    await hooklessCall({ "anthropic-beta": "prompt-caching" });
    expect(up.calls[0]!.body).toBe(bodyText);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.url).toBeNull();
  });

  it("quota / ping-client / web_search / feishu / hub（裸 fetch，非 provider URL）：纯透传、零 DB 访问", async () => {
    const res = await globalThis.fetch("https://quota.example.test/usage", { headers: { authorization: "Bearer x" } });
    await res.text();
    expect(up.calls[0]!.url).toBe("https://quota.example.test/usage");
    expect(await rows()).toHaveLength(0);
    expect(engine.tickets.counters.staleTickets).toBe(0);
  });
});
