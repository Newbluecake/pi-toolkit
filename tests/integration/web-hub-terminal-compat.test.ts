/** Real 4e15fac1 components, not new code with stripped fields/version flags. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CURRENT_ROOT, lockedBaseline, isolatedMachine, cardFor, drained } from "./web-hub-terminal-compat-baseline.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { login, openSse, postJson, rawRequest } from "../web-hub/http/helpers.js";
import { TERMINAL_HTTP_PATHS } from "../../src/web-hub/protocol/terminal-paths.js";

let baseline: Awaited<ReturnType<typeof lockedBaseline>>;
let oldHappyPath = false;
const machines: ReturnType<typeof isolatedMachine>[] = [];
afterEach(async () => {
  for (const m of machines.splice(0).reverse()) await m.close();
});
beforeAll(async () => {
  baseline = await lockedBaseline();
}, 240000);
const machine = (enabled = true) => {
  const m = isolatedMachine(enabled);
  machines.push(m);
  return m;
};
const journalPath = (h: any) => join(h.paths.stateDir, "terminal-v1", "terminal-resource-fence-v1.json");
const count = (a: any) => a.peer.command("snapshot").then((s: any) => s.backendCount);
async function physical(h: any, m: any, card: any, a: any) {
  const b = await m.browser(h),
    t = await b.open(card);
  await b.input(card, t, 'printf "COMPAT_PID=%s\\n" "$$"; printf "COMPAT_CWD=%s\\n" "$(pwd -P)"\n');
  await waitUntil(() => new RegExp(`COMPAT_PID=\\d+\\r?\\n`).test(b.output(t.termId)), 5000, "old/new real PTY echo");
  const pid = Number(/COMPAT_PID=(\d+)/.exec(b.output(t.termId))![1]);
  await waitUntil(() => b.output(t.termId).includes(`COMPAT_CWD=${a.fixture.cwd}`), 5000, "old/new cwd");
  expect(existsSync(`/proc/${pid}/stat`)).toBe(true);
  const rev = JSON.parse(readFileSync(journalPath(h), "utf8")).revision;
  await b.close(card, t);
  await drained(h, rev + 2);
  expect(existsSync(`/proc/${pid}/stat`)).toBe(false);
  return { pid, cwd: a.fixture.cwd, revision: JSON.parse(readFileSync(journalPath(h), "utf8")).revision };
}
async function browserCase(h: any, card: any, a: any, shown: boolean, allowed: boolean, label: string) {
  const module = process.env.TPS_PLAYWRIGHT_MODULE,
    binary = process.env.TPS_CHROMIUM;
  expect(module, "offline browser package required; no npx/install fallback").toBeTruthy();
  expect(binary).toBeTruthy();
  const { chromium } = await import(pathToFileURL(module!).href);
  const browser = await chromium.launch({ headless: true, executablePath: binary });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
    const origin = `http://127.0.0.1:${h.port}`;
    await context.route("**/*", (route: any) =>
      route
        .request()
        .url()
        .startsWith(origin + "/")
        ? route.continue()
        : route.abort(),
    );
    await context.addInitScript(() => {
      (window as any).__compat = { output: "", csp: [] };
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as any).__compat.csp.push(e.violatedDirective),
      );
      const Original = window.EventSource;
      window.EventSource = class extends Original {
        constructor(...args: ConstructorParameters<typeof EventSource>) {
          super(...args);
          this.addEventListener("terminal", (e) => {
            const x = JSON.parse((e as MessageEvent).data).event;
            if (x.kind === "output") (window as any).__compat.output += atob(x.bytesB64);
          });
        }
      };
    });
    const page = await context.newPage(),
      ops: any[] = [],
      errors: string[] = [],
      network: any[] = [];
    page.on("requestfailed", (r: any) => network.push({ path: new URL(r.url()).pathname, failed: r.failure() }));
    page.on("response", (r: any) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith("/api/")) network.push({ path, status: r.status() });
    });
    page.on("console", (m: any) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e: any) => errors.push(e.message));
    page.on("response", (r: any) => {
      if (new URL(r.url()).pathname.startsWith("/api/terminal/"))
        ops.push({ path: new URL(r.url()).pathname, status: r.status() });
    });
    const token = readFileSync(h.paths.tokenFile, "utf8").trim();
    await page.goto(`${origin}/#t=${encodeURIComponent(token)}`);
    await page.waitForSelector(".agent-card", { timeout: 15000 }).catch(async (error: any) => {
      await page.screenshot({ path: join(baseline.root, `failure-${label}.png`) });
      throw new Error(
        `${error}; ${JSON.stringify({ body: (await page.locator("body").innerText()).slice(0, 4000), errors, ops, network })}`,
      );
    });
    // Only one target in each cell, avoiding any version-specific route shortcut.
    await page.locator(".agent-card").first().click();
    await page.waitForSelector(".detail-header");
    const entry = page.locator('[aria-controls="terminal-panel"]');
    if (shown) {
      await entry.waitFor({ state: "visible", timeout: 10000 });
      await entry.click();
      if (allowed) {
        await page.waitForSelector("[data-terminal-create]", { timeout: 10000 });
        await page.locator("[data-terminal-create]").click();
        await page.waitForSelector('.terminal-panel[data-writable="true"]', { timeout: 15000 });
        await page.locator(".xterm-helper-textarea").focus();
        await page.keyboard.type('printf "UI_COMPAT_PID=%s\\n" "$$"', { delay: 2 });
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => /UI_COMPAT_PID=\d+\r?\n/.test((window as any).__compat.output), undefined, {
          timeout: 10000,
        });
        const text = await page.evaluate(() => (window as any).__compat.output),
          pid = Number(/UI_COMPAT_PID=(\d+)/.exec(text)![1]);
        expect(existsSync(`/proc/${pid}/stat`)).toBe(true);
        await page.locator(".terminal-chrome").getByRole("button", { name: "终止", exact: true }).click();
        await page.locator(".terminal-confirm").getByRole("button", { name: "确认", exact: true }).click();
        await drained(h);
        expect(existsSync(`/proc/${pid}/stat`)).toBe(false);
        expect(ops.filter((o) => o.path.endsWith("/open") && o.status === 200)).toHaveLength(1);
      } else {
        await waitUntil(() => ops.some((o) => o.status !== 200), 10000, "old UI unsupported target rejection");
        expect(ops.some((o) => o.path.endsWith("/open") && o.status === 200)).toBe(false);
      }
    } else {
      // A real ordinary status is already present; wait for header hydration via control.
      await page.waitForSelector(".detail-header");
      expect(await entry.count()).toBe(0);
      expect(ops).toEqual([]);
    }
    expect(await page.evaluate(() => (window as any).__compat.csp)).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(baseline.root, `matrix-${label}.png`), fullPage: true });
    const evidence = { label, shown, allowed, ops, pageErrors: errors, backendCount: await count(a) };
    writeFileSync(join(baseline.root, `matrix-${label}.json`), JSON.stringify(evidence, null, 2));
    console.log(`MIXED_CELL ${JSON.stringify(evidence)}`);
  } finally {
    await browser.close();
  }
}

describe.sequential("#45 locked real-component mixed-version matrix", () => {
  it("O/O/O baseline first: real old login/SSE/authority/PTY/pwd/reap and manifest UI click", async () => {
    const m = machine(),
      h = await m.hub(baseline.root, { legacy: true, uiRoot: baseline.root }),
      a = await m.agent(baseline.root);
    const card = await cardFor(h, a.sessionId, false),
      evidence = await physical(h, m, card, a);
    await browserCase(h, card, a, true, true, "OOO");
    expect(await count(a)).toBe(2);
    oldHappyPath = true;
    writeFileSync(join(baseline.root, "old-happy-path.json"), JSON.stringify(evidence, null, 2));
  }, 120000);
  const cells = [
    { label: "NNN", hub: "N", agent: "N", ui: "N", shown: true, allowed: true },
    { label: "NNO", hub: "N", agent: "N", ui: "O", shown: true, allowed: true },
    { label: "ONO", hub: "O", agent: "N", ui: "O", shown: true, allowed: true },
    { label: "ONN", hub: "O", agent: "N", ui: "N", shown: false, allowed: true },
    { label: "NON", hub: "N", agent: "O", ui: "N", shown: false, allowed: false },
    { label: "NOO", hub: "N", agent: "O", ui: "O", shown: true, allowed: false },
  ];
  for (const cell of cells)
    it(`${cell.label}: real independently selected components`, async () => {
      expect(oldHappyPath, "old-old-old must really open first").toBe(true);
      const m = machine(),
        h = await m.hub(cell.hub === "O" ? baseline.root : CURRENT_ROOT, {
          source: "plain",
          legacy: cell.hub === "O",
          uiRoot: cell.ui === "O" ? baseline.root : CURRENT_ROOT,
        });
      const a = await m.agent(cell.agent === "O" ? baseline.root : CURRENT_ROOT),
        card = await cardFor(h, a.sessionId, cell.hub === "N" && cell.agent === "N");
      if (cell.allowed) await physical(h, m, card, a);
      else {
        const b = await m.browser(h),
          p = await b.post(card, "prepare", { cols: 80, rows: 24 });
        expect(p.status).not.toBe(200);
        expect(p.body).toMatchObject({ ok: false, effect: "none" });
        expect(await count(a)).toBe(0);
      }
      await browserCase(h, card, a, cell.shown, cell.allowed && cell.shown, cell.label);
      expect(await count(a)).toBe(cell.allowed ? (cell.shown ? 2 : 1) : 0);
    }, 120000);
  it.each(["O", "N"])(
    "O/N/%s old config without terminal never dynamically enables",
    async (ui) => {
      expect(oldHappyPath).toBe(true);
      const m = machine(),
        h = await m.hub(baseline.root, { uiRoot: ui === "O" ? baseline.root : CURRENT_ROOT }),
        a = await m.agent();
      const card = await cardFor(h, a.sessionId, false);
      expect(h.caps).not.toContain("terminal.ui.v1");
      const cookie = await login(h.port, h.paths.tokenFile);
      expect(
        (
          await postJson(
            h.port,
            TERMINAL_HTTP_PATHS.prepare,
            {},
            { Cookie: cookie, Origin: `http://127.0.0.1:${h.port}` },
          )
        ).status,
      ).toBe(404);
      await browserCase(h, card, a, false, false, `ON${ui}-off`);
      expect(await count(a)).toBe(0);
    },
    40000,
  );
  it("N from O launcher (missing source) is unavailable despite legacy terminal key; plain restart recovers", async () => {
    expect(oldHappyPath).toBe(true);
    const m = machine(),
      h = await m.hub(undefined, { legacy: true });
    const a = await m.agent();
    await cardFor(h, a.sessionId, false);
    expect(JSON.parse(readFileSync(h.paths.hubJson, "utf8")).terminal).toMatchObject({
      state: "unavailable",
      reason: "startup-domain-unknown",
    });
    expect(h.caps).not.toContain("terminal.ui.v1");
    expect(await count(a)).toBe(0);
    await h.peer.close();
    const h2 = await m.hub(undefined, { source: "plain" });
    const card = await cardFor(h2, a.sessionId);
    await physical(h2, m, card, a);
  }, 90000);
});
