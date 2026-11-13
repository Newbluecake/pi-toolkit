#!/usr/bin/env -S npx tsx
/** Tier3 only: real hub/Unix agent/HTTP/SSE/PTY + the manifest-verified production UI.
 * No real pi account, user rc, existing daemon, dependency install or network fallback.
 * The only injected production seam is the audited isolated UID/rc backend fixture.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { TERMINAL_JOURNAL_FILE } from "../../src/web-hub/protocol/terminal.js";
import { TERMINAL_LOCAL_DIR } from "../../src/web-hub/protocol/terminal-local.js";
import { makeTerminalFixture } from "../../tests/integration/web-hub-terminal-fixture.js";
import { waitUntil } from "../../tests/web-hub/agent/helpers.js";
import { loadPlaywright } from "./lib/playwright.js";

assert.equal(process.env.npm_config_offline, "true", "explicit offline-only cache required");
assert(!process.env.XDG_RUNTIME_DIR && !process.env.NODE_OPTIONS, "unset XDG_RUNTIME_DIR/NODE_OPTIONS");
assert(!process.env.PI_CODING_AGENT_DIR, "unset PI_CODING_AGENT_DIR");
const out = resolve(process.env.PWH_TERMINAL_EVIDENCE_DIR ?? join(tmpdir(), "pwh-terminal-e2e-evidence"));
mkdirSync(out, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(tmpdir(), "te-"));
chmodSync(root, 0o700);
const home = join(root, "h");
mkdirSync(home, { mode: 0o700 });
// Freeze all future library HOME lookups before hub/fixture startup. Never use ~/.pi.
process.env.HOME = home;
process.umask(0o022);
const fixture = makeTerminalFixture();
const limits = { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
const version = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;
const result: Record<string, unknown> = { firefox: "NOT RUN — accepted GTK3/NSS limitation", steps: [] };
const steps = result.steps as string[];
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let child: ReturnType<typeof spawn> | undefined;
let browser: any;
let page: any;
let stage = "offline loader";
const ops: Array<{ op: string; status: number }> = [];
const listResponses: unknown[] = [];
let errors = "";
try {
  const pw = await loadPlaywright();
  assert(pw.ok, pw.ok ? "" : pw.reason);
  assert.equal(pw.source, "offline");
  result.playwright = pw.version;
  stage = "real hub and agent";
  let deps: any;
  assert(
    resolveHubPaths({ home, uid: process.getuid!() }).socketPath.startsWith(home + "/"),
    "scratch path too long: refuse shared socket fallback before starting a hub",
  );
  hub = await startHub(
    {
      v: 1,
      home,
      port: 0,
      idleExitMinutes: 10,
      pluginVersion: version,
      buildId: "terminal-tier3",
      privacy: true,
      terminal: limits,
    },
    (d) => {
      deps = d;
      return createHttpFrontend(d);
    },
  );
  assert(!("exists" in hub), "must own a fresh private daemon");
  const running = hub;
  const cfg = join(root, "agent.json");
  writeFileSync(cfg, JSON.stringify({ home, fixture: fixture.fixture, pluginVersion: version }), { mode: 0o600 });
  child = spawn(process.execPath, ["--import", "tsx", resolve("tests/integration/fixtures/terminal-agent.ts"), cfg], {
    stdio: "pipe",
    env: { ...process.env, HOME: home },
  });
  child.stderr!.on("data", (b: Buffer) => {
    errors = (errors + b.toString()).slice(-8192);
  });
  await waitUntil(
    () => deps.registry.list().some((v: any) => v.session?.sessionId === "child-terminal-session"),
    10000,
  );
  const card = deps.registry.list().find((v: any) => v.session?.sessionId === "child-terminal-session");
  assert.equal(card.agentId.pid, child.pid);
  const url = `http://127.0.0.1:${running.httpPort}`;
  const token = readFileSync(running.paths.tokenFile, "utf8").trim();
  browser = await pw.chromium.launch({ headless: true, executablePath: pw.executablePath });
  result.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  // No external requests, even if an accidental UI path tries them.
  await context.route("**/*", (route: any) =>
    route
      .request()
      .url()
      .startsWith(url + "/")
      ? route.continue()
      : route.abort(),
  );
  await context.addInitScript(() => {
    (window as any).__terminalEvidence = { violations: [], output: "", exits: [] };
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as any).__terminalEvidence.violations.push({ directive: e.violatedDirective, uri: e.blockedURI });
    });
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      constructor(...args: ConstructorParameters<typeof EventSource>) {
        super(...args);
        this.addEventListener("terminal", (event) => {
          const e = JSON.parse((event as MessageEvent).data).event;
          const evidence = (window as any).__terminalEvidence;
          if (e.kind === "output") evidence.output = (evidence.output + atob(e.bytesB64)).slice(-65536);
          if (e.kind === "exit") evidence.exits.push({ reap: e.reap, reason: e.reason });
        });
      }
    };
  });
  page = await context.newPage();
  const consoleErrors: string[] = [];
  const documentCsp: unknown[][] = [];
  const captureDocumentCsp = async () => {
    const violations = await page.evaluate(() => (window as any).__terminalEvidence.violations);
    documentCsp.push(violations);
    assert.deepEqual(violations, []);
  };
  page.on("pageerror", (e: Error) => consoleErrors.push(e.message));
  page.on("console", (m: any) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("response", (r: any) => {
    const path = new URL(r.url()).pathname;
    if (path === "/api/login") ops.push({ op: "login", status: r.status() });
    if (path === "/api/terminal/list")
      void r
        .json()
        .then((v: any) => listResponses.push(v))
        .catch(() => {});
    if (path.startsWith("/api/terminal/")) ops.push({ op: path.split("/").pop()!, status: r.status() });
  });
  const shot = (name: string) => page.screenshot({ path: join(out, name + ".png"), fullPage: true });
  const button = (name: string) => page.locator(".terminal-chrome").getByRole("button", { name, exact: true });
  const writable = () => page.waitForSelector('.terminal-panel[data-writable="true"]', { timeout: 15000 });
  const send = async (command: string, marker: string) => {
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+c"); // cancel readline state left by the deliberate raw Esc
    await page.keyboard.type(command, { delay: 5 });
    await page.keyboard.press("Enter");
    await page.waitForFunction((m: string) => (window as any).__terminalEvidence.output.includes(m), marker, {
      timeout: 10000,
    });
  };
  const waitRelease = () =>
    waitUntil(
      () => {
        const dir = join(running.paths.stateDir, TERMINAL_LOCAL_DIR);
        const j = JSON.parse(readFileSync(join(dir, TERMINAL_JOURNAL_FILE), "utf8"));
        return j.resources.length === 0 && readdirSync(join(dir, "receipts")).length === 0;
      },
      60000,
      "physical receipt + durable prune + exact ACK",
    );
  stage = "login and detail terminal entry";
  await page.goto(`${url}/#t=${encodeURIComponent(token)}`);
  await page.waitForSelector(".agent-card", { timeout: 15000 });
  await page.locator(".agent-card").first().click();
  await page.locator('[aria-controls="terminal-panel"]').click();
  await page.waitForSelector(".terminal-list");
  steps.push("real token login → terminal button → bottom list");
  await page.locator("[data-terminal-create]").click();
  await writable();
  stage = "real shell echo";
  await send("echo P3_ECHO_OK", "\rP3_ECHO_OK\r\n");
  await send("printf '\\nP3_BEFORE=%s\\n' \"$$\"", "P3_BEFORE=");
  await page.waitForFunction(() => /P3_BEFORE=\d+/.test((window as any).__terminalEvidence.output));
  const pid = Number(await page.evaluate(() => /P3_BEFORE=(\d+)/.exec((window as any).__terminalEvidence.output)![1]));
  result.shellPid = pid;
  assert(pid > 0);
  await shot("01-echo");
  steps.push("echo and real shell PID rendered through PTY/SSE/WebGL");
  stage = "maximize and Escape";
  await button("最大化").click();
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Escape");
  assert(await page.locator(".terminal-panel.is-maximized").isVisible());
  assert.equal(ops.filter((o) => o.op === "close").length, 0);
  await shot("02-maximized-escape");
  await button("还原").click();
  steps.push("maximize → Esc preserves panel, maximization and shell");
  stage = "renderer loss same physical shell";
  const beforeLoss = ops.filter((o) => ["prepare", "open", "close"].includes(o.op)).length;
  await page.evaluate(() => {
    const canvas = [...document.querySelectorAll<HTMLCanvasElement>(".xterm canvas")].find((c) =>
      c.getContext("webgl2"),
    );
    const lose = canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context");
    if (!lose) throw new Error("real WEBGL_lose_context required");
    lose.loseContext();
  });
  // Writable disappears during recovery; wait for a new renderer/attach cutover via HTTP ops.
  await waitUntil(() => ops.some((o) => o.op === "attach"), 10000, "recovery attach");
  await writable();
  await send("printf '\\nP3_RECOVERED=%s\\n' \"$$\"", `P3_RECOVERED=${pid}\r\n`);
  assert.equal(ops.filter((o) => ["prepare", "open", "close"].includes(o.op)).length, beforeLoss);
  await shot("03-renderer-recovered");
  steps.push("real context loss → renderer rebuild → attach same PID; zero prepare/open/close");
  stage = "background refresh same PID";
  const cookiesBefore = await context.cookies();
  await button("放到后台").click();
  await page.waitForSelector(".terminal-panel", { state: "detached" });
  await captureDocumentCsp();
  await page.reload();
  result.sameCookies = JSON.stringify(cookiesBefore) === JSON.stringify(await context.cookies());
  await page.waitForSelector('[aria-controls="terminal-panel"]');
  await page.locator('[aria-controls="terminal-panel"]').click();
  await page.locator(".terminal-list").getByRole("button", { name: "接回", exact: true }).click();
  await writable();
  await send("printf '\\nP3_AFTER=%s\\n' \"$$\"", `P3_AFTER=${pid}\r\n`);
  assert.equal(ops.filter((o) => o.op === "open").length, 1);
  await shot("04-refresh-same-pid");
  steps.push("background → real page reload → list attach preserves same PID (one open)");
  stage = "confirmed close and quota reuse";
  await button("终止").click();
  assert(await page.locator('[aria-modal="true"]').isVisible());
  assert.equal(ops.filter((o) => o.op === "close").length, 0);
  await shot("05-close-confirm");
  await page.locator(".terminal-confirm").getByRole("button", { name: "确认", exact: true }).click();
  await waitRelease();
  assert.throws(() => process.kill(pid, 0));
  await page.locator("[data-terminal-create]").click();
  await writable();
  steps.push("explicit close confirmation → process gone → durable quota/receipt release → reopen");
  stage = "privacy lock immediate invalidation";
  const lockAt = Date.now();
  const locked = await page.evaluate(async (agentKey: string) => {
    const response = await fetch("/api/privacy/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PWH": "1" },
      body: JSON.stringify({ agentKey, sessionId: "child-terminal-session", locked: true }),
    });
    return response.status;
  }, card.agentKey);
  assert.equal(locked, 200);
  await page.waitForFunction(() => !document.querySelector(".terminal-panel[data-writable]"), undefined, {
    timeout: 2000,
  });
  result.privacyInvalidationMs = Date.now() - lockAt;
  await shot("06-privacy-invalidated");
  await waitRelease();
  steps.push("authoritative privacy lock immediately freezes/clears panel and reaps shell");
  await page.evaluate(async (agentKey: string) => {
    const r = await fetch("/api/privacy/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PWH": "1" },
      body: JSON.stringify({ agentKey, sessionId: "child-terminal-session", locked: false }),
    });
    if (!r.ok) throw new Error("unlock fixture failed");
  }, card.agentKey);
  await captureDocumentCsp();
  await page.reload();
  await page.locator('[aria-controls="terminal-panel"]').click();
  await page.locator("[data-terminal-create]").click();
  await writable();
  stage = "auth revoke immediate invalidation";
  const revokeAt = Date.now();
  await page.evaluate(async () => {
    localStorage.removeItem("pwh_token"); // prevent the ordinary token client's automatic fresh login
    const r = await fetch("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PWH": "1" },
      body: "{}",
    });
    if (!r.ok) throw new Error("fixture logout failed");
  });
  await page.waitForFunction(() => !document.querySelector(".terminal-panel[data-writable]"), undefined, {
    timeout: 2000,
  });
  result.revokeInvalidationMs = Date.now() - revokeAt;
  await shot("07-revoke-invalidated");
  await waitRelease();
  steps.push("real logout/revoke immediately invalidates panel and reaps shell");
  const evidence = await page.evaluate(() => (window as any).__terminalEvidence);
  assert.deepEqual(evidence.violations, []);
  documentCsp.push(evidence.violations);
  result.cspByDocument = documentCsp;
  result.cspViolations = documentCsp.flat();
  assert.deepEqual(result.cspViolations, []);
  result.consoleErrors = consoleErrors;
  assert.deepEqual(consoleErrors, []);
  // Expected auth HTTP errors are preserved; CSP and uncaught exceptions are separately asserted.
  stage = "WebGL unavailable Chinese refusal, zero shell open";
  const disabled = await pw.chromium.launch({
    headless: true,
    executablePath: pw.executablePath,
    args: ["--disable-webgl"],
  });
  try {
    const dc = await disabled.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
    await dc.route("**/*", (route: any) =>
      route
        .request()
        .url()
        .startsWith(url + "/")
        ? route.continue()
        : route.abort(),
    );
    await dc.addInitScript(() => {
      (window as any).__disabledCsp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as any).__disabledCsp.push(e.violatedDirective),
      );
    });
    const dp = await dc.newPage();
    const attempted: string[] = [];
    dp.on("request", (r: any) => {
      if (/\/api\/terminal\/(prepare|open)$/.test(r.url())) attempted.push(r.url());
    });
    await dp.goto(`${url}/#t=${encodeURIComponent(token)}`);
    await dp.waitForSelector(".agent-card");
    await dp.locator(".agent-card").first().click();
    await dp.locator('[aria-controls="terminal-panel"]').click();
    await dp.locator("[data-terminal-create]").click();
    await dp.waitForFunction(
      () =>
        /WebGL/.test(document.querySelector(".terminal-panel")?.textContent ?? "") &&
        /终端未启动/.test(document.querySelector(".terminal-panel")?.textContent ?? ""),
    );
    assert.deepEqual(attempted, []);
    result.disabledCspViolations = await dp.evaluate(() => (window as any).__disabledCsp);
    assert.deepEqual(result.disabledCspViolations, []);
    assert.equal(await dp.locator(".xterm").count(), 0);
    await dp.screenshot({ path: join(out, "08-webgl-unavailable.png"), fullPage: true });
    steps.push("--disable-webgl: Chinese refusal before prepare/open, no xterm or shell");
  } finally {
    await disabled.close();
  }
  result.ops = ops;
  result.listResponses = listResponses;
  result.status = "PASS";
} catch (error) {
  result.status = "FAIL";
  result.stage = stage;
  result.error = String(error);
  result.agentDiagnostics = errors;
  result.ops = ops;
  result.listResponses = listResponses;
  if (page) {
    result.observed = await page.evaluate(() => (window as any).__terminalEvidence).catch(() => null);
    result.body = (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).slice(-6000);
    await page.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  // Keep the browser connection alive through the unref'd production teardown clocks.
  // Publish PASS only after owned child + hub + browser cleanup actually finishes.
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.stdin!.end("STOP\n");
    const timer = setTimeout(() => child!.kill("SIGKILL"), 6000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }
  if (hub && !("exists" in hub)) await hub.close("test");
  await browser?.close();
  fixture.cleanup();
  rmSync(root, { recursive: true, force: true });
  result.cleanup = "owned agent/hub/browser stopped; scratch removed";
  writeFileSync(join(out, "e2e-report.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
