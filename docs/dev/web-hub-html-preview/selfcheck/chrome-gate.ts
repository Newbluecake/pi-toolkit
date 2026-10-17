/**
 * web-hub HTML preview — the AUTOMATED half of the §9 real-browser gate (P3).
 *
 * Not part of any test suite: this is the driver the P3 agent ran to execute the Chrome part
 * of the blocking browser gate, kept here so the run is reproducible:
 *
 *   node <pi's bundled jiti-cli.mjs> docs/dev/web-hub-html-preview/selfcheck/chrome-gate.ts
 *
 * What it does (NEVER touching the user's real hub / ~/.pi/agent / web-hub state):
 *  - stands up a THROWAWAY `createHttpFrontend` (loopback + LAN listeners) in a /tmp scratch
 *    home, with real `createPreviewRoutes({ html: {} })` (no seams) and a REAL LAN login
 *    (async scrypt through hub/kdf.ts);
 *  - mints THREE capabilities: loopback /pvw, loopback raw /pv, LAN /pvw — for the selfcheck
 *    directory of THIS checkout (its own dir + sub/ only, D2-clean);
 *  - launches /usr/bin/chromium-browser headless with a scratch --user-data-dir under $HOME
 *    (snap chromium cannot read /tmp; the dir is deleted afterwards);
 *  - drives it over the CDP websocket (Node 22's built-in WebSocket): navigates each context,
 *    finds the sandboxed frame's execution context, polls `window.__pvSelfcheck` until done;
 *  - re-asserts the hub-side §9 facts: the fake command router saw NOTHING, the history
 *    service was NEVER reached (the page's /api/* died at 401), the SSE subscriber count is
 *    unchanged, and the driver's own authed /api/preview still works;
 *  - prints one JSON verdict and exits 0 iff everything passed (CDN failure is excluded from
 *    the verdict iff the DRIVER's own fetch to the CDN also fails — an offline environment,
 *    recorded as `env.cdn` instead).
 */
import { spawn, spawnSync } from "node:child_process";
import { scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHttpFrontend } from "../../../../src/web-hub/hub/http.js";
import { createKdf } from "../../../../src/web-hub/hub/kdf.js";
import { createKdfAdmission } from "../../../../src/web-hub/hub/kdf-admission.js";
import { createScope } from "../../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../../src/web-hub/hub/net-hosts.js";
import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import { createPreviewRoutes } from "../../../../src/web-hub/hub/preview/routes.js";
import type { CommandRouter, FrontendDeps } from "../../../../src/web-hub/hub/ports.js";
import { createLoginLimiter } from "../../../../src/web-hub/hub/ratelimit.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { fakeLanStore } from "../../../../tests/web-hub/contract/fakes.js";
import { lanPostJson } from "../../../../tests/web-hub/http/lan-helpers.js";
import { fakeDeps, login, makeAgent, postJson, rawRequest } from "../../../../tests/web-hub/http/helpers.js";
import { PV_SANDBOX, PREVIEW_HTML_CAP_PATH } from "../../../../src/web-hub/protocol/preview-html.js";

const CHROME = "/usr/bin/chromium-browser";
const AGENT = "a4242-nonce12";
const SESSION = "sess123";
const LAN_USER = "pvgate";
const LAN_PW = "correct-horse-battery";
const SELFCHECK_DIR = resolve(import.meta.dirname, ".");
const REPO_ROOT = resolve(SELFCHECK_DIR, "../../../..");

interface CdpCtx {
  name: string;
  url: string;
  pageVerdict: string;
  sandboxAttr?: string;
  topUrl: string;
  iframeSrc?: string;
}

let chromeErrTail = "";

const out = {
  env: {} as Record<string, string>,
  contexts: [] as Array<CdpCtx & { pass: boolean; results?: Record<string, { got: string; pass: boolean }> }>,
  hubSide: {} as Record<string, unknown>,
};

function log(...a: unknown[]): void {
  console.error("[chrome-gate]", ...a);
}

async function main(): Promise<void> {
  log("main: start");
  // ---- throwaway hub --------------------------------------------------------------
  const home = mkdtempSync(join(tmpdir(), "pwh-pvgate-"));
  const deps = fakeDeps(home);
  const now = (): number => Date.now();
  deps.now = now;
  deps.agents.set(
    AGENT,
    makeAgent(AGENT, {
      control: true,
      session: { sessionId: SESSION, cwd: join(REPO_ROOT, "docs"), reason: "gate", leafId: null, mode: "tui" },
    }),
  );
  // hub-side oracle #1: every /api/cmd the page attempts must die before the router
  const cmdCalls: string[] = [];
  const commands: CommandRouter = {
    handle: (frame) => {
      cmdCalls.push(String((frame as { op?: string }).op ?? "cmd"));
      return Promise.resolve({ ok: false, status: 503, error: "gate-router" });
    },
  } as unknown as CommandRouter;
  (deps as FrontendDeps).commands = commands;
  const routes = createPreviewRoutes({
    mode: "on",
    denyCtx: denyCtxOf(home, join(home, ".pi", "agent")),
    uploadsRoot: join(home, "uploads"),
    registry: deps.registry,
    log: deps.log,
    now,
    html: {},
  });
  (deps as FrontendDeps).preview = routes;
  const lanStore = fakeLanStore();
  const salt = Buffer.alloc(16, 7);
  lanStore.seedUser({
    id: 1,
    username: LAN_USER,
    kdf: "scrypt",
    n: 16384,
    r: 8,
    p: 1,
    salt,
    hash: scryptSync(LAN_PW, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 + 1024 * 1024 }),
    epoch: 1,
    createdAt: now(),
    updatedAt: now(),
  });
  const limiter = createLoginLimiter({ now });
  const lanPort = await new Promise<number>((resolveP, rejectP) => {
    const srv = createServer();
    srv.once("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => resolveP(a !== null && typeof a === "object" ? a.port : 0));
    });
  });
  (deps as FrontendDeps).lan = {
    cfg: { port: lanPort, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
    store: lanStore,
    kdf: createKdf(),
    limiter,
    admission: createKdfAdmission({ now, isTightened: limiter.isTightened }),
    hosts: createHostsPort(),
    scope: createScope({ log: deps.log, now }),
    onStatus: () => undefined,
  };
  log("main: deps built");
  const fe = createHttpFrontend(deps as FrontendDeps);
  const loopPort = (await fe.listen()).port;
  if (fe.lan === undefined) throw new Error("fe.lan missing");
  const lanSt = await fe.lan.start();
  if (lanSt.state !== "on") throw new Error(`LAN failed: ${JSON.stringify(lanSt)}`);
  log("main: listeners up", loopPort, lanSt.port);
  const cookie = await login(loopPort, deps.paths.tokenFile);
  const q = `agentKey=${AGENT}&sessionId=${SESSION}`;
  const entry = join(SELFCHECK_DIR, "index.html");
  log("main: cookie ok");
  const mintLoop = await postJson(loopPort, `${PREVIEW_HTML_CAP_PATH}?${q}`, { path: entry }, { Cookie: cookie });
  if (mintLoop.status !== 200) throw new Error(`loopback mint: ${mintLoop.status} ${mintLoop.body}`);
  const loopBody = JSON.parse(mintLoop.body) as { url: string; openUrl: string };
  log("main: loop mint", mintLoop.status);
  const lanLogin = await lanPostJson(lanSt.port, "/api/login", { username: LAN_USER, password: LAN_PW });
  if (lanLogin.status !== 200) throw new Error(`LAN login: ${lanLogin.status} ${lanLogin.body}`);
  const lanCookie = (lanLogin.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  const mintLan = await lanPostJson(
    lanSt.port,
    `${PREVIEW_HTML_CAP_PATH}?${q}`,
    { path: entry },
    { Cookie: lanCookie, Origin: `http://127.0.0.1:${lanSt.port}` },
  );
  if (mintLan.status !== 200) throw new Error(`LAN mint: ${mintLan.status} ${mintLan.body}`);
  const lanBody = JSON.parse(mintLan.body) as { url: string; openUrl: string };
  log("main: lan login", lanLogin.status, "lan mint", mintLan.status);
  const listenersBefore = deps.listeners();
  const historyCallsBefore = deps.historyCalls.snapshot.length;

  // ---- chromium --------------------------------------------------------------------
  // snap chromium cannot write hidden dot-dirs in $HOME (AppArmor) — use a VISIBLE scratch dir
  const chromeDir = mkdtempSync(join(homedir(), "pvgate-chrome-"));
  const dbgPort = 10000 + Math.floor(Math.random() * 40000);
  log("main: spawning chromium");
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${dbgPort}`,
      `--user-data-dir=${chromeDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chrome.stderr?.on("data", (c: Buffer) => {
    chromeErrTail = c.toString("utf8").slice(-800);
  });
  try {
    const version = await pollHttp(`http://127.0.0.1:${dbgPort}/json/version`, 20_000);
    log("chromium up:", String(JSON.parse(version).Browser ?? "?"));

    // cdn availability from the DRIVER (env-only exclusion evidence)
    let cdnReachable = true;
    try {
      await fetch("https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js", {
        method: "HEAD",
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      cdnReachable = false;
      out.env.cdn = "unreachable from the driver too — offline environment; G13 recorded, excluded from the verdict";
      log("CDN unreachable from the driver — recording env note");
    }

    const ctxs: Array<{ name: string; url: string }> = [
      { name: "pvw-loopback (D3 wrapper tab)", url: `http://127.0.0.1:${loopPort}${loopBody.openUrl}` },
      { name: "pvw-lan (LAN listener)", url: `http://127.0.0.1:${lanSt.port}${lanBody.openUrl}` },
      { name: "pv-raw-loopback (G17 top-level)", url: `http://127.0.0.1:${loopPort}${loopBody.url}` },
    ];
    for (const c of ctxs) {
      const r = await runContext(dbgPort, c.url, c.name);
      let pass = r.pageVerdict === "PASS";
      if (c.name.startsWith("pvw-")) {
        // D1/D3: the wrapper's iframe sandbox attribute must be EXACTLY PV_SANDBOX
        if (!(r.sandboxAttr ?? "").startsWith(PV_SANDBOX + " | src=/pv/")) {
          r.pageVerdict += ` [wrapper sandbox attr WRONG: ${String(r.sandboxAttr)}]`;
          pass = false;
        }
      } else if (
        !(r.sandboxAttr ?? "").startsWith("(no iframe") &&
        !(r.sandboxAttr ?? "").startsWith("(only a non-pv iframe")
      ) {
        r.pageVerdict += ` [raw context unexpectedly framed: ${String(r.sandboxAttr)}]`;
        pass = false;
      }
      if (!cdnReachable && r.results?.["CDN script load (F3)"]?.pass === false) {
        r.results["CDN script load (F3)"]!.got += " [env: offline — excluded]";
        r.results["CDN script load (F3)"]!.pass = true;
        r.pageVerdict = r.pageVerdict.replace(/^FAIL.*$/, "PASS (cdn excluded, env offline)");
        pass = r.pageVerdict.startsWith("PASS");
      }
      out.contexts.push({ ...r, pass });
      log(`context ${c.name}: ${r.pageVerdict}`);
    }

    // ---- hub-side §9 assertions ------------------------------------------------------
    const control = await rawRequest(loopPort, {
      path: `/api/preview?${q}&path=${encodeURIComponent(join(SELFCHECK_DIR, "selfcheck.js"))}`,
      headers: { "X-PWH": "1", Cookie: cookie },
    });
    out.hubSide = {
      cmdRouterCalls: cmdCalls.length,
      historyServiceCalls: deps.historyCalls.snapshot.length - historyCallsBefore,
      sseSubscribersDelta: deps.listeners() - listenersBefore,
      authedPreviewControl: control.status,
    };
    const hubOk =
      cmdCalls.length === 0 &&
      deps.historyCalls.snapshot.length === historyCallsBefore &&
      deps.listeners() === listenersBefore &&
      control.status === 200;
    const allPass = hubOk && out.contexts.every((c) => c.pass);
    console.log(JSON.stringify({ ...out, hubOk, allPass, verdict: allPass ? "pass" : "fail" }, null, 2));
    process.exitCode = allPass ? 0 : 1;
  } finally {
    chrome.kill("SIGTERM");
    await new Promise<void>((r) => {
      const t = setTimeout(r, 5_000);
      t.unref();
      chrome.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGKILL");
      await new Promise<void>((r) => {
        const t = setTimeout(r, 3_000);
        t.unref();
        chrome.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    }
    try {
      await routes.dispose("close", createReqDeadline(now, 1_000));
      await fe.close();
    } catch {
      /* best effort */
    }
    try {
      // chromium (snap) may still be flushing — retry the scratch dir a little
      rmSync(chromeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      log("WARN: could not fully remove", chromeDir, "— remove it manually");
    }
    rmSync(home, { recursive: true, force: true });
    if (chromeErrTail.trim() !== "") log("chromium stderr tail:", chromeErrTail);
  }
}

function pollHttp(url: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveP, rejectP) => {
    const attempt = (): void => {
      const req = httpRequest(url, { method: "GET" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolveP(Buffer.concat(chunks).toString("utf8")));
      });
      req.setTimeout(2_000, () => {
        req.destroy(new Error("devtools http timeout"));
      });
      req.on("error", (e: Error) => {
        if (Date.now() > deadline) {
          rejectP(
            new Error(
              `devtools endpoint ${url} never came up (${String(e)}; stderr tail: ${chromeErrTail.slice(-200)})`,
            ),
          );
          return;
        }
        setTimeout(attempt, 250);
      });
      req.on("error", () => undefined); // late reset after a response — never unhandled
      req.end();
    };
    attempt();
  });
}

/** One browser context: navigate, wait for the sandboxed frame's report, snapshot wrapper facts. */
async function runContext(
  dbgPort: number,
  url: string,
  name: string,
): Promise<CdpCtx & { results?: Record<string, { got: string; pass: boolean }> }> {
  const created = await new Promise<{ id: string }>((resolveP, rejectP) => {
    const req = httpRequest(
      `http://127.0.0.1:${dbgPort}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolveP(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string });
          } catch (e) {
            rejectP(e as Error);
          }
        });
      },
    );
    req.on("error", rejectP);
    req.on("error", () => undefined); // a late reset after settle must never be unhandled
    req.end();
  });
  const list = await pollHttp(`http://127.0.0.1:${dbgPort}/json/list`, 5_000);
  const targets = JSON.parse(list) as Array<{ id: string; webSocketDebuggerUrl?: string; type: string; url: string }>;
  const target = targets.find((t) => t.id === created.id && t.webSocketDebuggerUrl !== undefined);
  if (target === undefined) throw new Error(`no ws url for target ${created.id}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl!);
  await new Promise<void>((resolveP, rejectP) => {
    ws.addEventListener("open", () => resolveP(), { once: true });
    ws.addEventListener("error", () => rejectP(new Error("ws error")), { once: true });
  });
  let msgId = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const frameContexts = new Map<string, string>(); // frameId -> default executionContext id
  // flat sessions for the sandboxed OOPIF (a cross-origin iframe has its OWN devtools target —
  // the page session never sees its execution contexts)
  const subSessions = new Map<string, string>(); // targetId -> sessionId (url in subUrls)
  const subUrls = new Map<string, string>(); // targetId -> url
  ws.addEventListener("message", (ev: MessageEvent) => {
    const m = JSON.parse(String(ev.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    if (m.method === "Target.attachedToTarget") {
      const p = m.params as { sessionId: string; targetInfo: { targetId: string; url?: string } };
      subSessions.set(p.targetInfo.targetId, p.sessionId);
      if (p.targetInfo.url !== undefined) subUrls.set(p.targetInfo.targetId, p.targetInfo.url);
      return;
    }
    if (m.method === "Target.targetInfoChanged") {
      const p = m.params as { targetId: string; url?: string };
      if (p.url !== undefined) subUrls.set(p.targetId, p.url);
      return;
    }
    if (m.method === "Target.detachedFromTarget") {
      const p = m.params as { sessionId: string };
      for (const [tid, sid] of [...subSessions]) if (sid === p.sessionId) subSessions.delete(tid);
      return;
    }
    if (m.method === "Runtime.executionContextCreated") {
      const ctx = (m.params as { context: { id: string; auxData?: { frameId?: string; isDefault?: boolean } } })
        .context;
      if (ctx.auxData?.isDefault === true && ctx.auxData.frameId !== undefined) {
        frameContexts.set(ctx.auxData.frameId, ctx.id);
      }
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> => {
    const id = ++msgId;
    return new Promise((resolveP, rejectP) => {
      pending.set(id, { resolve: resolveP, reject: rejectP });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectP(new Error(`cdp timeout: ${method}`));
        }
      }, 10_000).unref();
    });
  };
  const evaluate = async (expression: string, contextId?: string): Promise<unknown> => {
    const r = (await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (r.exceptionDetails !== undefined) return { __evalError: JSON.stringify(r.exceptionDetails).slice(0, 200) };
    return r.result?.value;
  };
  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await send("Page.navigate", { url });
    // a background tab in headless Chrome is frozen/throttled to death — foreground it so the
    // sandboxed page's timers and microtasks actually run
    await send("Page.bringToFront").catch(() => undefined);
    // poll up to 25s for the sandboxed frame's finished report
    const deadline = Date.now() + 25_000;
    let report: { verdict: string; results?: Record<string, { got: string; pass: boolean }> } | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      // preferred path: the sandboxed frame's own (flat) session. An OOPIF may attach with an
      // empty url (about:blank) and only later report the real one — so instead of trusting
      // targetInfo, ask each sub-session for its OWN location.href and use the /pv/ one.
      // ask EVERY sub-session for its own location, and read the report from whichever one is
      // the sandboxed /pv/ page (an OOPIF can attach twice across a navigation; stale sessions
      // error and get dropped)
      let sawPvSession = false;
      for (const [tid, sid] of [...subSessions]) {
        try {
          const loc = (await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sid)) as {
            result?: { value?: unknown };
          };
          const u = String(loc.result?.value ?? "");
          subUrls.set(tid, u);
          if (!u.includes("/pv/") || u.includes("popup.html")) continue;
          sawPvSession = true;
          const raw = (await send(
            "Runtime.evaluate",
            { expression: "window.__pvSelfcheck ? JSON.stringify(window.__pvSelfcheck) : null", returnByValue: true },
            sid,
          )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
          const v = raw.exceptionDetails !== undefined ? undefined : raw.result?.value;
          if (typeof v === "string" && v !== "null") {
            const parsed = JSON.parse(v) as typeof report;
            if (parsed && parsed.verdict !== "running") {
              report = parsed;
              break;
            }
          }
        } catch {
          subSessions.delete(tid); // stale (re-navigated) session
        }
      }
      if (sawPvSession) continue;
      // fallback (raw /pv top-level): the main frame's default execution context
      const frames = (await send("Page.getFrameTree")) as { frameTree: FrameNode };
      const pvFrame = findPvFrame([frames.frameTree]);
      const ctxId =
        pvFrame === undefined ? frameContexts.get(frames.frameTree.frame.id) : frameContexts.get(pvFrame.frame.id);
      if (ctxId === undefined) continue;
      const raw = await evaluate("window.__pvSelfcheck ? JSON.stringify(window.__pvSelfcheck) : null", ctxId);
      if (typeof raw === "string" && raw !== "null") {
        const parsed = JSON.parse(raw) as typeof report;
        if (parsed && parsed.verdict !== "running") {
          report = parsed;
          break;
        }
      }
    }
    const topInfo = (await evaluate("location.href")) as string;
    const sandboxProbe = (await evaluate(
      `(function(){var f=document.querySelector('iframe[src^="/pv/"]');if(f)return f.getAttribute('sandbox')+' | src='+f.getAttribute('src');return document.querySelector('iframe')?'(only a non-pv iframe (the form sink) — raw top-level document)':'(no iframe — raw top-level document)';})()`,
    )) as string;
    if (report === undefined) {
      log("attached sub-targets:", JSON.stringify([...subUrls.values()]));
      for (const [tid, sid] of [...subSessions]) {
        const u = subUrls.get(tid) ?? "";
        if (!u.includes("/pv/")) continue;
        try {
          const txt = (await send(
            "Runtime.evaluate",
            { expression: "document.body ? document.body.innerText.slice(0, 120) : 'NO BODY'", returnByValue: true },
            sid,
          )) as { result?: { value?: unknown } };
          log("pv target body:", JSON.stringify(txt.result?.value));
        } catch {
          /* session gone */
        }
      }
      return {
        name,
        url,
        pageVerdict: "NO REPORT (frame never finished or context not found)",
        topUrl: String(topInfo),
        sandboxAttr: String(sandboxProbe),
        pass: false,
      };
    }
    return {
      name,
      url,
      pageVerdict: report.verdict,
      results: report.results,
      topUrl: String(topInfo),
      sandboxAttr: String(sandboxProbe),
      pass: false,
    };
  } finally {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
    // close the tab
    try {
      const closeReq = httpRequest(`http://127.0.0.1:${dbgPort}/json/close/${created.id}`, { method: "GET" });
      closeReq.on("error", () => undefined);
      closeReq.end();
    } catch {
      /* tab close is best-effort */
    }
  }
}

interface FrameNode {
  frame: { id: string; url: string };
  childFrames?: FrameNode[];
}

function findPvFrame(nodes: FrameNode[]): FrameNode | undefined {
  for (const n of nodes) {
    if (n.frame.url.includes("/pv/")) return n;
    if (n.childFrames !== undefined) {
      const hit = findPvFrame(n.childFrames);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

void main().catch((err: unknown) => {
  console.error("chrome-gate failed:", String(err));
  console.log(JSON.stringify({ ...out, verdict: "fail", error: String(err) }, null, 2));
  process.exitCode = 1;
});
