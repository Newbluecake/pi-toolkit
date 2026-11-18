#!/usr/bin/env -S tsx
/** Tier3: manifest-verified UI + real SDK 1.5 event context + real startHub/UDS,
 * real isolated Python PTY and independent NDJSON. No site, install or network fallback.
 * Explicit contract-fixture v2 initialization is NOT trusted fresh maintenance evidence. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createTerminalTestBackend } from "../../src/web-hub/hub/terminal/v2/backend.js";
import { webHubStateDir } from "../../src/web-hub/protocol/paths.js";
import { makeTerminalFixture } from "../../tests/integration/terminal-v2-backend-fixture.js";
import { createTerminalSdkAgent } from "../../tests/integration/helpers/terminal-v2-sdk.js";
import { openSse } from "../../tests/web-hub/http/helpers.js";
import { terminalFontMetrics } from "./lib/terminal-font-metrics.js";
assert.equal(process.env.npm_config_offline, "true", "explicit offline-only cache required");
assert(
  !process.env.XDG_RUNTIME_DIR && !process.env.NODE_OPTIONS && !process.env.PI_CODING_AGENT_DIR,
  "unset runtime/agent-dir/NODE_OPTIONS",
);
const entry = process.env.TPS_PLAYWRIGHT_MODULE,
  binary = process.env.TPS_CHROMIUM;
assert(
  entry && binary && existsSync(entry) && existsSync(binary),
  "NOT RUN: explicit already-installed Playwright/Chromium assets required; never installs",
);
assert.equal(JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version, "1.63.0");
const playwright = await import(pathToFileURL(entry).href);
const fixture = makeTerminalFixture();
const home = fixture.fixture.home,
  state = webHubStateDir(home),
  socketDir = join(fixture.fixture.root, "s");
const out = resolve(process.env.PWH_TERMINAL_EVIDENCE_DIR ?? join(fixture.fixture.root, "evidence"));
mkdirSync(out, { recursive: true, mode: 0o700 });
chmodSync(out, 0o700);
mkdirSync(state, { recursive: true, mode: 0o700 });
mkdirSync(socketDir, { mode: 0o700 });
const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
put(join(home, ".pi/agent/pi-toolkit.json"), { webHub: { terminal: { enabled: true } } });
const marker = { v: 2, storeId: "s".repeat(24), initialization: "fresh", checkpointId: "c".repeat(24) };
mkdirSync(join(state, "terminal-v2"), { mode: 0o700 });
put(join(state, ".terminal-initialized-v2"), marker);
put(join(state, "terminal-v2/marker.json"), marker);
put(join(state, "terminal-v2/ledger.json"), { v: 2, storeId: marker.storeId, revision: 0, allocations: [] });
process.env.HOME = home;
process.env.PI_WEBHUB_TERMINAL_SOURCE = "plain";
const version = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;
const result: Record<string, unknown> = {
  status: "IN PROGRESS",
  firefox: "NOT RUN",
  deviceIme: "NOT RUN",
  maintenance: "NOT RUN",
  steps: [],
};
const steps = result.steps as string[],
  ops: string[] = [],
  errors: string[] = [];
let hub: RunningHub | undefined,
  sdk: Awaited<ReturnType<typeof createTerminalSdkAgent>> | undefined,
  browser: any,
  ordinary: Awaited<ReturnType<typeof openSse>> | undefined;
try {
  let initialized: Promise<void> | undefined;
  const started = await startHub(
    { v: 1, home, port: 0, idleExitMinutes: 10, pluginVersion: version, buildId: "terminal-v2-browser-probe" },
    createHttpFrontend,
    {
      xdgRuntimeDir: socketDir,
      terminalV2Test: {
        backend: (options) => createTerminalTestBackend(options, fixture.fixture),
        ready: (work) => {
          initialized = work;
        },
      },
    },
  );
  assert("httpPort" in started, "private hub startup failed");
  hub = started;
  await initialized;
  sdk = await createTerminalSdkAgent({ home, cwd: fixture.fixture.cwd, socketDir, version });
  const origin = `http://127.0.0.1:${hub.httpPort}`,
    token = readFileSync(hub.paths.tokenFile, "utf8").trim();
  browser = await playwright.chromium.launch({ headless: true, executablePath: binary });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", (route: any) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await context.addInitScript(() => {
    localStorage.setItem("pwh_lang", "en");
    const facts = { output: "", violations: [] as unknown[], privatePublicEvents: 0 };
    (window as any).__terminalV2Probe = facts;
    document.addEventListener("securitypolicyviolation", (event) =>
      facts.violations.push({ directive: event.violatedDirective }),
    );
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith("/api/terminal/v2/view") && response.ok) {
        // Probe-only bounded observer, never substitutes ACK or changes the real response.
        const clone = response.clone(),
          reader = clone.body?.getReader(),
          decoder = new TextDecoder();
        if (reader)
          void (async () => {
            let partial = "";
            try {
              for (;;) {
                const read = await reader.read();
                if (read.done) break;
                partial += decoder.decode(read.value, { stream: true });
                if (partial.length > 65536) throw new Error("probe frame cap");
                for (let newline; (newline = partial.indexOf("\n")) >= 0;) {
                  const frame = JSON.parse(partial.slice(0, newline));
                  partial = partial.slice(newline + 1);
                  if (frame.t === "output") facts.output = (facts.output + atob(frame.bytesB64)).slice(-65536);
                }
              }
            } catch {
              /* Original view cancellation is expected on collapse/reload. */
            } finally {
              await reader.cancel().catch(() => {});
            }
          })();
      }
      return response;
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error: Error) => errors.push(error.message.slice(0, 1024)));
  page.on("request", (req: any) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/api/terminal/")) ops.push(path.split("/").pop()!);
  });
  await page.goto(`${origin}/#t=${encodeURIComponent(token)}`, { waitUntil: "load" });
  await page.waitForSelector('[data-fold="terminal"]', { timeout: 15000 });
  assert.deepEqual(ops, [], "terminal API before explicit click");
  const cookie = (await context.cookies(origin)).find((value: any) => value.name === "pwh_sid");
  assert(cookie, "real token login cookie missing");
  ordinary = await openSse(hub.httpPort, { cookie: `pwh_sid=${cookie.value}` });
  await ordinary.waitFor((event) => event.event === "hello");
  await page.click('[data-fold="terminal"]');
  await page.waitForSelector('.terminal-v2-panel[data-writable="true"]', { timeout: 15000 });
  assert.equal(ops.filter((op) => op === "create").length, 1);
  steps.push("real SDK → matching status → explicit lazy open → real PTY ready");
  const font = await terminalFontMetrics(page);
  result.font = font;
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf 'T51_BROWSER_PID=%s\\n' \"$$\"");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /T51_BROWSER_PID=\d+/.test((window as any).__terminalV2Probe.output), undefined, {
    timeout: 8000,
  });
  const pid = await page.evaluate(() =>
    Number(/T51_BROWSER_PID=(\d+)/.exec((window as any).__terminalV2Probe.output)![1]),
  );
  assert(existsSync(`/proc/${pid}/stat`));
  await page.screenshot({ path: join(out, "terminal-v2-initial.png") });
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-terminal-webgl-canvas]")!;
    (window as any).__terminalV2PreviousCanvas = canvas;
    const gl = canvas.getContext("webgl2")!;
    const lose = gl.getExtension("WEBGL_lose_context");
    if (!lose) throw new Error("real loss extension unavailable");
    lose.loseContext();
  });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas[data-terminal-webgl-canvas]");
      return (
        canvas &&
        canvas !== (window as any).__terminalV2PreviousCanvas &&
        document.querySelector('.terminal-v2-panel[data-writable="true"]')
      );
    },
    undefined,
    { timeout: 15000 },
  );
  assert.equal(ops.filter((op) => op === "create").length, 1);
  assert(existsSync(`/proc/${pid}/stat`));
  steps.push("real WebGL loss → bounded renderer recovery, no new create, same PID remains");
  await page.getByRole("button", { name: "Collapse terminal (keep shells)", exact: true }).click();
  await page.waitForSelector(".terminal-v2-panel", { state: "detached" });
  assert(existsSync(`/proc/${pid}/stat`));
  assert.equal(ordinary.ended, false);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector('[data-fold="terminal"]');
  assert.equal(ops.filter((op) => op === "create").length, 1);
  await page.click('[data-fold="terminal"]');
  await page.waitForSelector('.terminal-v2-panel[data-writable="true"]', { timeout: 15000 });
  assert.equal(ops.filter((op) => op === "create").length, 1);
  assert(existsSync(`/proc/${pid}/stat`));
  steps.push("collapse/reload requires explicit click, reattaches original term without create");
  await page
    .locator(".terminal-v2-tabs")
    .getByRole("button", { name: /^Close / })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.terminal-v2-tabs [role="tab"]'), undefined, {
    timeout: 15000,
  });
  const disk = JSON.parse(readFileSync(join(state, "terminal-v2/ledger.json"), "utf8"));
  assert.deepEqual(disk.allocations, []);
  assert(disk.revision >= 2);
  assert(!existsSync(`/proc/${pid}/stat`));
  assert.equal(ordinary.ended, false);
  assert(!JSON.stringify(ordinary.events).includes("T51_BROWSER_PID"));
  const violations = await page.evaluate(() => (window as any).__terminalV2Probe.violations);
  assert.deepEqual(violations, []);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(out, "terminal-v2-clean.png") });
  steps.push("confirmed close → real physical proof + durable prune + PID gone, ordinary SSE intact");
  result.status = "PASS — scoped browser scenario only";
  result.ops = ops;
  result.revision = disk.revision;
} catch (error) {
  result.status = "FAIL";
  result.reason = error instanceof Error ? error.message : "probe failed";
  process.exitCode = 1;
} finally {
  ordinary?.close();
  await browser?.close();
  await sdk?.close();
  await hub?.close("private-browser-probe");
  put(join(out, "terminal-v2-e2e.json"), result);
  // Evidence is retained. Exact fixture cleanup is intentionally omitted when the
  // evidence directory lives inside it; no broad /tmp/site cleanup is permitted.
  if (!out.startsWith(fixture.fixture.root + "/")) fixture.cleanup();
}
