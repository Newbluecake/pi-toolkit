/**
 * 页面（Vue 内联应用）测试：
 * 1. PAGE 结构：含 #app 挂载点与 Vue 特征串，无未替换的 ${VUE_JS}/${APP_JS} sentinel
 * 2. happy-dom 挂载冒烟：执行内联脚本（Vue global build + app.js），断言挂载成功、
 *    header 与四个主 tab 渲染；T4：token 经 <meta name="record-token"> 注入，fetch 走
 *    x-record-token 头（EventSource/导出链接保留 ?token= 查询）
 * 3. 交互：主 tab 切换（v-show）、flow 行点击触发详情 fetch
 */
import { Window } from "happy-dom";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPage } from "../../src/traffic/page.js";
import type { TrafficEngine } from "../../src/traffic/engine.js";
import { createTrafficServer, type TrafficServer } from "../../src/traffic/server.js";
import { makeEngine, teardownEngine } from "./helpers/engine.js";

// T2a：页面在首次 buildPage() 时组装（模块顶层零 IO）。
const { html: PAGE, gzip: PAGE_GZIP } = buildPage();
// T4：带 token 的页面（服务端注入 <meta name="record-token">）——挂载冒烟用它。
const PAGE_TOKENED = buildPage("test-token").html;
let state: TrafficEngine;

describe("PAGE 结构", () => {
  it("含 #app 挂载点与 Vue 特征串，无未替换 sentinel", () => {
    expect(PAGE).toContain('id="app"');
    // Vue 特征串：global build 版本注释 + createApp 导出
    expect(PAGE).toMatch(/vue v3\.\d+\.\d+/);
    expect(PAGE).toContain("createApp");
    // 占位 sentinel 必须已被替换（不检查泛化 ${ 或 {{，模板语法是合法的）
    expect(PAGE).not.toContain("${VUE_JS}");
    expect(PAGE).not.toContain("${APP_JS}");
    // 内联 sanitize 生效后，script 块内部不得出现会提前闭合标签的 </script
    const scripts = extractScripts(PAGE);
    expect(scripts.length).toBe(2);
    for (const s of scripts) expect(s).not.toMatch(/<\/script/i);
  });

  it("PAGE_GZIP 是 PAGE 的 gzip 压缩副本", () => {
    expect(gunzipSync(PAGE_GZIP).toString("utf8")).toBe(PAGE);
  });

  it('T4 token meta：buildPage(token) 注入 <meta name="record-token">；无 token 不注入；属性值转义', () => {
    // 无 token ⇒ 无 meta 标签（app.js 注释/选择器串不含 content= 形式）
    expect(PAGE).not.toContain('<meta name="record-token" content=');
    expect(PAGE_TOKENED).toContain('<meta name="record-token" content="test-token">');
    // token 按不可信文本转义（token 本为 hex，此为纵深）
    const hostile = buildPage('a"b<c>&');
    expect(hostile.html).not.toContain('content="a"b');
    expect(hostile.html).toContain(
      "content=&quot;b&lt;c&gt;&amp;".replace("content=", 'content="a&quot;b&lt;c&gt;&amp;"').slice(0, 0) ||
        'content="a&quot;b&lt;c&gt;&amp;"',
    );
  });
});

// ---------- happy-dom 挂载冒烟 ----------

function extractScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]!);
  return out;
}

const SESSION = {
  id: "sess-1",
  started_at: "2025-01-01T00:00:00",
  cwd: "/tmp",
  provider: "p",
  model: "m",
  req_count: 1,
  msg_count: 1,
};
const FLOW_ROW = {
  id: 1,
  session_id: "sess-1",
  turn: 0,
  ts: "2025-01-01T00:00:01.000Z",
  provider: "p",
  model: "m",
  status: 200,
  origin: null,
  replay_of: null,
  size: 2,
};
const DETAIL = {
  ...FLOW_ROW,
  payload: { model: "m" },
  request_headers: { "x-api-key": "k" },
  response_headers: { "content-type": "text/event-stream" },
  response: null,
  replay_body: null,
  stream: null,
  url: "http://example.com/v1/chat",
  method: "POST",
};

const REWRITE_RULE = {
  id: 1,
  name: "降温",
  enabled: 1,
  priority: 10,
  url_pattern: "/v1/messages$",
  method: "POST",
  model: null,
  body_jq: ".temperature = 0",
  headers_jq: null,
  created_at: "2025-01-01T00:00:00",
  updated_at: "2025-01-01T00:00:00",
};
const REWRITE_SETTINGS = {
  jq_path: "",
  timeout_ms: 2000,
  jq_version: "1.6",
  jq_available: true,
  db_error: null,
};
/** v3（§3.9）：settings 追加 serialize_* / correlation_mode；r2 起闸门退役（serialize_* 停用）；db_error 红条 */
const REWRITE_SETTINGS_V3 = {
  jq_path: "",
  timeout_ms: 2000,
  serialize_handoff_ms: 10000,
  serialize_retry_grace_ms: 30000,
  serialize_max_hold_ms: 120000,
  serialize_queue_wait_ms: 60000,
  jq_version: "1.6",
  jq_available: true,
  db_error: "attempt to write a readonly database",
  correlation_mode: "exact",
  gate: {
    active: true,
    queueDepth: 2,
    holderId: 7,
    holderAgeMs: 123,
    gateAcquired: 5,
    gateTimeouts: 1,
    gateNoFetch: 3,
    gateBypassed: 4,
    gateMaxQueueDepth: 2,
  },
};
/** v3（§3.9）：/api/state 的 rewrite 块（codex_ws_warning 红条 + 顶栏「规则生效中」数据源） */
const STATE_REWRITE = {
  enabled_rules: 1,
  correlation_mode: "exact",
  gate: REWRITE_SETTINGS_V3.gate,
  jq_available: true,
  jq_version: "1.6",
  db_error: null,
  codex_ws_warning: true,
};
/** rewrite_status='applied' 的详情：payload/headers 被改写，orig_* 保留改写前值 */
const DETAIL_APPLIED = {
  ...DETAIL,
  rewrite_status: "applied",
  rewrite_rule_ids: [1],
  rule_names: ["降温"],
  payload: { model: "m", temperature: 0 },
  orig_payload: { model: "m", temperature: 0.7 },
  request_headers: { "x-api-key": "sk-live-secret", "content-type": "application/json" },
  orig_request_headers: { "x-api-key": "sk-orig-secret", "content-type": "application/json" },
  rewrite_error: null,
  // v3（V2）：线级编码与字节数 → MetaCard「发送编码」一行
  payload_encoding: "zstd",
  payload_bytes: 1234,
};
/** rewrite_status='blocked' 的详情：jq 失败被阻断，含结构化错误 */
const DETAIL_BLOCKED = {
  ...DETAIL,
  status: 0,
  rewrite_status: "blocked",
  rewrite_rule_ids: [1],
  rule_names: ["坏规则"],
  payload: { model: "m" },
  orig_payload: { model: "m" },
  request_headers: { "x-api-key": "sk-x" },
  orig_request_headers: { "x-api-key": "sk-x" },
  rewrite_error: {
    kind: "compile_error",
    phase: "body",
    rule_id: 1,
    rule_name: "坏规则",
    message: "jq 编译失败",
    detail: null,
  },
};

interface MountOptions {
  rows?: unknown[];
  detail?: unknown;
  rules?: unknown[];
  settings?: unknown;
  state?: unknown;
}
interface MountResult {
  window: Window;
  document: Document;
  fetchCalls: string[];
  /** 完整请求记录（含 method/body/headers），fetchCalls 仅 url */
  fetchLog: { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }[];
  esUrls: string[];
  /** 最后创建的 EventSource stub（页面只有一个 SSE 连接） */
  es: { onmessage: ((ev: { data: string }) => void) | null } | null;
  cleanup: () => void;
}

async function mountPage(opts: MountOptions = {}): Promise<MountResult> {
  // T4：token 不再走 URL——注入 <meta name="record-token">（app.js 首选 meta，URL 仅兜底）
  const window = new Window({ url: "http://127.0.0.1:4177/" });
  const document = window.document;
  document.head.innerHTML = '<meta name="record-token" content="test-token">';
  const bodyHtml = PAGE_TOKENED.match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script>[\s\S]*?<\/script>/g, "");
  document.body.innerHTML = bodyHtml;

  const fetchCalls: string[] = [];
  const fetchLog: MountResult["fetchLog"] = [];
  const esUrls: string[] = [];
  let lastEs: InstanceType<typeof EventSourceStub> | null = null;
  const fetchStub = vi.fn(
    (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      fetchCalls.push(u);
      fetchLog.push({ url: u, init });
      let data: unknown = {};
      if (u.startsWith("/api/state")) data = opts.state ?? { recording: true, sessionId: "sess-1" };
      else if (u.startsWith("/api/sessions")) data = [SESSION];
      else if (u.startsWith("/api/rewrite/settings")) data = opts.settings ?? REWRITE_SETTINGS;
      else if (u.startsWith("/api/rewrite/rules")) data = opts.rules ?? [REWRITE_RULE];
      else if (u.startsWith("/api/requests/")) data = opts.detail ?? DETAIL;
      else if (u.startsWith("/api/requests")) data = opts.rows ?? [FLOW_ROW];
      return Promise.resolve({ json: () => Promise.resolve(data) });
    },
  );
  class EventSourceStub {
    url: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      esUrls.push(url);
      lastEs = this;
    }
    close() {}
  }

  // 内联脚本读取浏览器全局：把 happy-dom window 的成员 + stub 挂到 globalThis 后用间接 eval 执行
  const g = globalThis as Record<string, unknown>;
  const savedKeys = [
    "window",
    "document",
    "localStorage",
    "location",
    "fetch",
    "EventSource",
    "setInterval",
    "clearInterval",
    "Vue",
    // Vue 运行时在挂载/patch 路径会引用这些 DOM 构造器与 API，由 happy-dom window 提供
    "SVGElement",
    "Element",
    "HTMLElement",
    "Node",
    "Text",
    "Comment",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "getComputedStyle",
    "Document",
    "ShadowRoot",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
    "HTMLAnchorElement",
    "HTMLFormElement",
    "NodeFilter",
    "TreeWalker",
    "Range",
    "Selection",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "MutationObserver",
    "DOMParser",
    "CSS",
  ];
  // 注：navigator 在 Node 22 的 globalThis 上是只读 getter，无法覆盖；Vue prod 运行时非必需，跳过
  const saved: Record<string, unknown> = {};
  for (const k of savedKeys) saved[k] = g[k];
  g.window = window;
  g.document = document;
  g.localStorage = window.localStorage;
  g.location = window.location;
  g.fetch = fetchStub;
  g.EventSource = EventSourceStub;
  g.setInterval = () => 0; // 测试内不真正启动轮询
  g.clearInterval = () => {};
  for (const k of savedKeys.slice(9)) {
    // 未定义的构造器（happy-dom 未实现）跳过，不覆盖 Node 原生全局
    const v = (window as unknown as Record<string, unknown>)[k];
    if (v === undefined) continue;
    try {
      g[k] = v;
    } catch {
      // 个别全局（只读 getter）无法覆盖，忽略
    }
  }

  const scripts = extractScripts(PAGE);
  const indirectEval = eval; // 间接 eval：脚本运行于全局作用域
  try {
    indirectEval(scripts[0]!); // vue.global.prod.js → 定义全局 Vue
    expect(typeof g.Vue).toBe("object");
    indirectEval(scripts[1]!); // app.js → createApp(App).mount('#app')
  } catch (err) {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
    throw err;
  }

  return {
    window,
    document: document as unknown as Document,
    fetchCalls,
    fetchLog,
    esUrls,
    get es() {
      return lastEs;
    },
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
      window.close();
    },
  };
}

/** 等待条件成立（Vue 渲染 + fetch promise 链均为异步） */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("/ 路由 gzip 响应", () => {
  let tmp: string;
  let port: number;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "record-page-gzip-"));
    state = makeEngine(tmp);
    port = await createTrafficServer(state).startServer();
  });
  afterEach(async () => {
    await teardownEngine(state);
    rmSync(tmp, { recursive: true, force: true });
  });

  // T4：服务端页面携带 engine token 的 <meta name="record-token">（回环 GET / 免 token）
  const servedPage = (): string => buildPage(state.accessToken ?? undefined).html;

  it("accept-encoding 含 gzip 时回发压缩副本并带 content-encoding 头", async () => {
    // 注意：undici 会按 content-encoding 自动解压，res.text() 拿到的已是解压后文本；
    // 压缩副本本身的正确性由「PAGE_GZIP 是 PAGE 的 gzip 压缩副本」用例保证
    // connection: close — 避免 undici 跨用例复用 keep-alive 连接（同端口重启 server 后会读到上一个连接的残留）
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "accept-encoding": "gzip", connection: "close" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await res.text()).toBe(servedPage());
  });

  it("客户端不支持 gzip 时回退原文", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "accept-encoding": "identity", connection: "close" },
    });
    expect(res.headers.get("content-encoding")).toBeNull();
    const text = await res.text();
    expect(text).toBe(servedPage());
    expect(text).toContain(`<meta name="record-token" content="${state.accessToken}">`);
  });
});

describe("happy-dom 挂载冒烟", () => {
  let mounted: MountResult | null = null;
  beforeEach(async () => {
    mounted = await mountPage();
  });
  afterEach(() => {
    mounted?.cleanup();
    mounted = null;
  });
  it("#app 挂载成功，header / 四个主 tab / badge 渲染", () => {
    const { document } = mounted!;
    const app = document.querySelector("#app")!;
    expect(app.querySelector("header")).toBeTruthy();
    expect(app.querySelector(".logo")!.textContent).toContain("pi traffic record");
    const tabs = Array.from(app.querySelectorAll(".tab")).map((b) => b.textContent);
    expect(tabs).toEqual(["实时", "历史", "导出", "改写"]);
    expect(app.querySelector("#themeBtn")).toBeTruthy();
    // 四个 pane 均存在（v-show 保留 DOM）
    expect(app.querySelector("#pane-live")).toBeTruthy();
    expect(app.querySelector("#pane-history")).toBeTruthy();
    expect(app.querySelector("#pane-export")).toBeTruthy();
    expect(app.querySelector("#pane-rules")).toBeTruthy();
    // /api/state 默认无 rewrite 块：顶栏不显示「规则生效中」
    expect(app.querySelector("header")!.textContent).not.toContain("规则生效中");
  });

  it("token 经 x-record-token 头携带到所有 fetch；EventSource 保留 ?token= 查询", async () => {
    const { fetchCalls, fetchLog, esUrls } = mounted!;
    await waitFor(() => fetchCalls.some((u) => u.startsWith("/api/requests")), "等待 /api/requests 请求");
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const u of fetchCalls) expect(u).not.toContain("token="); // fetch 不再走 URL
    for (const c of fetchLog) {
      expect(c.init?.headers?.["x-record-token"]).toBe("test-token");
    }
    expect(esUrls.length).toBe(1);
    expect(esUrls[0]).toBe("/api/events?token=test-token");
  });

  it("实时列表渲染 flow 行，点击触发详情 fetch（token 头）并渲染 meta", async () => {
    const { document, fetchLog } = mounted!;
    await waitFor(() => !!document.querySelector("#pane-live .flow"), "等待 flow 行渲染");
    const row = document.querySelector("#pane-live .flow") as HTMLElement;
    expect(row.textContent).toContain("#1");
    (row as unknown as { click(): void }).click();
    await waitFor(() => fetchLog.some((c) => c.url.startsWith("/api/requests/1")), "等待详情 fetch");
    expect(fetchLog.find((c) => c.url.startsWith("/api/requests/1"))!.init?.headers?.["x-record-token"]).toBe(
      "test-token",
    );
    await waitFor(() => !!document.querySelector("#pane-live .detail .meta"), "等待详情 meta 渲染");
    expect(document.querySelector("#pane-live .detail .meta")!.textContent).toContain("#1");
    // 详情子 tab 五个
    const dtabs = Array.from(document.querySelectorAll("#pane-live .dtab")).map((b) =>
      (b.childNodes[0]?.textContent ?? "").trim(),
    );
    expect(dtabs).toEqual(["输出", "输入", "流式", "Header", "重放"]);
  });

  it("主 tab 切换（v-show 保留 DOM）", async () => {
    const { document } = mounted!;
    const live = document.querySelector("#pane-live") as HTMLElement;
    const history = document.querySelector("#pane-history") as HTMLElement;
    expect(live.style.display).not.toBe("none");
    expect(history.style.display).toBe("none");
    const tabs = document.querySelectorAll(".tab");
    (tabs[1] as unknown as { click(): void }).click(); // 历史
    await waitFor(() => history.style.display !== "none", "等待历史 pane 显示");
    expect(live.style.display).toBe("none");
    (tabs[0] as unknown as { click(): void }).click(); // 回到实时
    await waitFor(() => live.style.display !== "none", "等待实时 pane 显示");
  });
});

describe("改写功能（T7）", () => {
  let mounted: MountResult | null = null;
  afterEach(() => {
    mounted?.cleanup();
    mounted = null;
  });

  it("切到「改写」tab 触发 /api/rewrite/rules 与 settings（token 头），表格与引擎卡片渲染，enabled 复选框点击即 PUT", async () => {
    mounted = await mountPage();
    const { document, fetchCalls, fetchLog } = mounted;
    // 初始（实时 tab）不应拉取规则
    expect(fetchCalls.some((u) => u.startsWith("/api/rewrite/"))).toBe(false);
    const tabs = document.querySelectorAll(".tab");
    (tabs[3] as unknown as { click(): void }).click(); // 改写
    await waitFor(() => fetchCalls.some((u) => u.startsWith("/api/rewrite/rules")), "等待 rules fetch");
    expect(fetchLog.find((c) => c.url.startsWith("/api/rewrite/rules"))!.init?.headers?.["x-record-token"]).toBe(
      "test-token",
    );
    await waitFor(() => fetchCalls.some((u) => u.startsWith("/api/rewrite/settings")), "等待 settings fetch");
    expect(fetchLog.find((c) => c.url.startsWith("/api/rewrite/settings"))!.init?.headers?.["x-record-token"]).toBe(
      "test-token",
    );
    // 引擎卡片（第一张卡片）
    await waitFor(() => !!document.querySelector("#pane-rules .rw-engine"), "等待引擎卡片渲染");
    const engine = document.querySelector("#pane-rules .rw-card")!;
    expect(engine.textContent).toContain("1.6");
    expect(engine.textContent).toContain("可用");
    // 规则表格
    await waitFor(() => !!document.querySelector("#pane-rules .rw-table tbody tr td"), "等待规则表格渲染");
    const table = document.querySelector("#pane-rules .rw-table")!;
    expect(table.textContent).toContain("降温");
    expect(table.textContent).toContain("/v1/messages$");
    expect(table.textContent).toContain("body: .temperature = 0");
    // enabled 复选框：点击即全量 PUT（1 → 0），token 头
    const cb = document.querySelector("#pane-rules .rw-table input[type=checkbox]") as HTMLElement;
    cb.dispatchEvent(new (mounted.window.Event as unknown as typeof Event)("change"));
    await waitFor(
      () => fetchLog.some((c) => c.init?.method === "PUT" && c.url.startsWith("/api/rewrite/rules/1")),
      "等待 enabled 切换 PUT",
    );
    const put = fetchLog.find((c) => c.init?.method === "PUT" && c.url.startsWith("/api/rewrite/rules/1"))!;
    expect(put.init?.headers?.["x-record-token"]).toBe("test-token");
    expect(JSON.parse(put.init!.body!).enabled).toBe(0);
  });

  it("applied 详情：第 6 个子 tab + ✎ 徽章 + 原始/改写后双栏，header 展示为脱敏副本", async () => {
    mounted = await mountPage({
      detail: DETAIL_APPLIED,
      rows: [{ ...FLOW_ROW, rewrite_status: "applied" }],
    });
    const { document } = mounted;
    await waitFor(() => !!document.querySelector("#pane-live .flow"), "等待 flow 行渲染");
    // FlowList 行内改写标记
    expect(document.querySelector("#pane-live .flow")!.textContent).toContain("✎");
    (document.querySelector("#pane-live .flow") as unknown as { click(): void }).click();
    await waitFor(() => !!document.querySelector("#pane-live .detail .meta"), "等待详情 meta 渲染");
    // MetaCard 徽章
    expect(document.querySelector("#pane-live .detail .meta")!.textContent).toContain("✎ 已改写");
    // v3（V2/V7）：MetaCard「发送编码」一行（payload_encoding/payload_bytes）
    expect(document.querySelector("#pane-live .detail .meta")!.textContent).toContain("发送编码：zstd（1234 B）");
    // 六个子 tab，末位为「改写」
    const dtabs = Array.from(document.querySelectorAll("#pane-live .dtab")).map((b) =>
      (b.childNodes[0]?.textContent ?? "").trim(),
    );
    expect(dtabs).toEqual(["输出", "输入", "流式", "Header", "重放", "改写"]);
    expect(document.querySelectorAll("#pane-live .dtab")[5]!.textContent).toContain("✎ 已改写");
    (document.querySelectorAll("#pane-live .dtab")[5] as unknown as { click(): void }).click();
    await waitFor(() => !!document.querySelector("#pane-live .rw-cols"), "等待双栏对比渲染");
    const text = document.querySelector("#pane-live .detail")!.textContent!;
    expect(text).toContain("命中规则");
    expect(text).toContain("降温");
    expect(text).toContain("原始 payload");
    expect(text).toContain("改写后 payload");
    expect(text).toContain('"temperature": 0.7'); // 原始
    expect(text).toContain('"temperature": 0\n'); // 改写后
    expect(text).toContain("原始 header");
    expect(text).toContain("改写后 header");
    // header 走 redactHeaderMap 脱敏副本：密钥值不出现
    expect(text).toContain("«REDACTED»");
    expect(text).not.toContain("sk-orig-secret");
    expect(text).not.toContain("sk-live-secret");
    // V7 命名对齐：改写对比栏与 Header 面板均为「发送请求头」，不再宣称线级 header
    expect(text).toContain("发送请求头对比");
    expect(text).toContain("不含由传输层重算的 host / content-length");
    (document.querySelectorAll("#pane-live .dtab")[3] as unknown as { click(): void }).click(); // Header
    await waitFor(
      () => (document.querySelector("#pane-live .detail")!.textContent || "").includes("发送请求头（"),
      "等待 Header 面板渲染",
    );
    const headersText = document.querySelector("#pane-live .detail")!.textContent!;
    expect(headersText).toContain("发送请求头");
    expect(headersText).toContain("不含由传输层重算的 host / content-length");
  });

  it("blocked 详情：子 tab 仍出现（⛔ 徽章）+ 错误块渲染 + 列表行失败标记（I4）", async () => {
    mounted = await mountPage({
      detail: DETAIL_BLOCKED,
      rows: [{ ...FLOW_ROW, status: 0, rewrite_status: "blocked" }],
    });
    const { document } = mounted;
    await waitFor(() => !!document.querySelector("#pane-live .flow"), "等待 flow 行渲染");
    expect(document.querySelector("#pane-live .flow")!.textContent).toContain("⛔");
    (document.querySelector("#pane-live .flow") as unknown as { click(): void }).click();
    await waitFor(() => !!document.querySelector("#pane-live .detail .meta"), "等待详情 meta 渲染");
    expect(document.querySelector("#pane-live .detail .meta")!.textContent).toContain("⛔ 已阻断");
    const dtabs = Array.from(document.querySelectorAll("#pane-live .dtab")).map((b) =>
      (b.childNodes[0]?.textContent ?? "").trim(),
    );
    expect(dtabs).toEqual(["输出", "输入", "流式", "Header", "重放", "改写"]);
    expect(document.querySelectorAll("#pane-live .dtab")[5]!.textContent).toContain("⛔ 已阻断");
    (document.querySelectorAll("#pane-live .dtab")[5] as unknown as { click(): void }).click();
    await waitFor(() => !!document.querySelector("#pane-live .rw-err"), "等待错误块渲染");
    const text = document.querySelector("#pane-live .detail")!.textContent!;
    expect(text).toContain("compile_error");
    expect(text).toContain("phase: body");
    expect(text).toContain("坏规则");
    expect(text).toContain("jq 编译失败");
  });

  it("SSE rewrite_error/rewrite_warn → 全局 toast（只渲染安全字段，不含密钥）；rewrite_rules → 重新拉取", async () => {
    mounted = await mountPage();
    const { document, fetchCalls, es } = mounted;
    await waitFor(() => !!es && !!es.onmessage, "等待 SSE onmessage 就绪");
    // 事件携带一个不应被渲染的字段（模拟未脱敏通道），前端只渲染 kind/rule_name/message 安全字段
    es!.onmessage!({
      data: JSON.stringify({
        type: "rewrite_error",
        kind: "runtime_error",
        rule_name: "降温",
        message: "jq 运行时错误",
        detail: null,
        stderr: "jq: error (at <stdin>:1): sk-secret-value",
      }),
    });
    await waitFor(() => !!document.querySelector(".toast"), "等待 toast 出现");
    const toast = document.querySelector(".toast")!;
    expect(toast.textContent).toContain("降温");
    expect(toast.textContent).toContain("runtime_error");
    expect(toast.textContent).toContain("jq 运行时错误");
    expect(document.body.textContent).not.toContain("sk-secret-value");
    // warn 类事件同样出 toast
    es!.onmessage!({ data: JSON.stringify({ type: "rewrite_warn", message: "规则正则非法，已跳过" }) });
    await waitFor(() => document.querySelectorAll(".toast").length >= 2, "等待 warn toast");
    // 规则变更事件 → 重新拉取规则与设置（当前不在改写 tab 也会刷新缓存）
    const before = fetchCalls.filter((u) => u.startsWith("/api/rewrite/rules")).length;
    es!.onmessage!({ data: JSON.stringify({ type: "rewrite_rules" }) });
    await waitFor(
      () => fetchCalls.filter((u) => u.startsWith("/api/rewrite/rules")).length > before,
      "等待 rules 重新拉取",
    );
  });

  it("app.js 不使用 v-html（用户数据走 {{ }} 默认转义），且不宣称「真实线级 header」（V7）", () => {
    const appJs = readFileSync(new URL("../../src/traffic/web/app.js", import.meta.url), "utf8");
    expect(appJs).not.toMatch(/v-html\s*=/);
    expect(appJs).not.toMatch(/v-html[\s>]/);
    expect(appJs).not.toContain("真实线级");
    expect(appJs).toContain("发送请求头");
  });

  it("v3 引擎卡片：高级区 serialize_* 已停用但仍展示旧值并随保存提交；correlation_mode / db_error / codex_ws_warning 红条渲染；顶栏「规则生效中」", async () => {
    mounted = await mountPage({
      settings: REWRITE_SETTINGS_V3,
      state: { recording: true, sessionId: "sess-1", rewrite: STATE_REWRITE },
    });
    const { document, fetchLog } = mounted;
    // 顶栏标记：/api/state rewrite.correlation_mode === "exact"（r2 起为「规则生效中」）
    await waitFor(
      () => (document.querySelector("header")!.textContent || "").includes("规则生效中"),
      "等待顶栏「规则生效中」标记",
    );
    const tabs = document.querySelectorAll(".tab");
    (tabs[3] as unknown as { click(): void }).click(); // 改写
    await waitFor(() => !!document.querySelector("#pane-rules .rw-engine"), "等待引擎卡片渲染");
    const card = document.querySelector("#pane-rules .rw-card")!;
    const text = card.textContent!;
    // correlation_mode（r2 起串行化闸门退役 ⇒ 精确（票据归属））
    expect(text).toContain("关联模式: 精确（票据归属）");
    // T2b：闸门退役——gate 计数行不再渲染
    expect(text).not.toContain("串行化闸门:");
    // db_error 红条（V3）
    expect(text).toContain("数据库错误");
    expect(text).toContain("attempt to write a readonly database");
    // codex_ws_warning 红条（V12，来自 /api/state rewrite）
    expect(text).toContain("Codex WebSocket 传输绕过改写，请将 transport 设为 sse");
    // 折叠「高级」区含四个 serialize_* 参数（已停用标注 + 输入禁用，仅展示旧值）
    const adv = card.querySelector("details.rw-adv")!;
    expect(adv).toBeTruthy();
    expect(adv.querySelector("summary")!.textContent).toContain("已停用");
    for (const k of [
      "serialize_handoff_ms",
      "serialize_retry_grace_ms",
      "serialize_max_hold_ms",
      "serialize_queue_wait_ms",
    ]) {
      expect(adv.textContent).toContain(k);
      expect(adv.textContent).toContain("已停用");
    }
    // 保存引擎配置 → PUT 仍携带全部 serialize_* 键（停用键原样回写；token 头）
    const saveBtn = Array.from(card.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("保存引擎配置"),
    )! as HTMLElement;
    saveBtn.click();
    await waitFor(
      () => fetchLog.some((c) => c.init?.method === "PUT" && c.url.startsWith("/api/rewrite/settings")),
      "等待 settings PUT",
    );
    const put = fetchLog.find((c) => c.init?.method === "PUT" && c.url.startsWith("/api/rewrite/settings"))!;
    expect(put.init?.headers?.["x-record-token"]).toBe("test-token");
    const body = JSON.parse(put.init!.body!);
    expect(body.serialize_handoff_ms).toBe(10000);
    expect(body.serialize_retry_grace_ms).toBe(30000);
    expect(body.serialize_max_hold_ms).toBe(120000);
    expect(body.serialize_queue_wait_ms).toBe(60000);
    // 等保存触发的 reload 落地（第二次 GET settings）并让响应链/Vue 重渲染冲刷完，
    // 否则测试结束 cleanup 还原全局后，残留的异步重渲染会向 stderr 打噪音
    await waitFor(
      () => fetchLog.filter((c) => c.url.startsWith("/api/rewrite/settings") && !c.init?.method).length >= 2,
      "等待保存后的 settings 重拉",
    );
    await new Promise((r) => setTimeout(r, 20));
  });

  it("SSE gate_warn → 全局 toast（warn 级，只渲染安全字段，不含密钥）", async () => {
    mounted = await mountPage();
    const { document, es } = mounted;
    await waitFor(() => !!es && !!es.onmessage, "等待 SSE onmessage 就绪");
    es!.onmessage!({
      data: JSON.stringify({
        type: "gate_warn",
        reason: "max-hold",
        slot_id: 3,
        message: "槽位持有超上限，已释放",
        stderr: "sk-gate-secret", // 非安全字段，绝不被渲染
      }),
    });
    await waitFor(() => !!document.querySelector(".toast"), "等待 gate_warn toast");
    const toast = document.querySelector(".toast")!;
    expect(toast.className).toContain("warn");
    expect(toast.textContent).toContain("max-hold");
    expect(toast.textContent).toContain("槽位持有超上限，已释放");
    expect(document.body.textContent).not.toContain("sk-gate-secret");
  });
});
