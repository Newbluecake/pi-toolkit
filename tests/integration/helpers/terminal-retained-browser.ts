/** Opt-in real provided Chromium over the actual retained N hub/SDK/PTY. No
 * transport/auth/renderer stub, injected UI store, npx, install or network fallback. */
import { expect } from "vitest";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { loadTerminalPlaywright } from "../../../scripts/web-hub/lib/terminal-playwright.js";
export async function probeRetainedBrowser(options: {
  port: number;
  tokenFile: string;
  ledgerPath: string;
  scope: { agentKey: string; sessionId: string; epoch: string };
  legacyCount: 1 | 2;
  output: string;
  backendCalls(): number;
}) {
  const playwright = await loadTerminalPlaywright();
  if (!playwright.ok) throw new Error(`provided browser required: ${playwright.reason}`);
  const browser = await playwright.chromium.launch({ headless: true, executablePath: playwright.executablePath });
  const baseline = options.backendCalls(),
    originalLegacy = JSON.parse(readFileSync(options.ledgerPath, "utf8")).legacyObligations;
  const origin = `http://127.0.0.1:${options.port}`,
    ops: string[] = [],
    errors: string[] = [];
  let page: any;
  try {
    // The shared loader intentionally exposes only a minimal PwContext surface;
    // this pinned real-browser probe also uses Playwright's routing/function-script APIs.
    const context: any = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route("**/*", (route: any) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await context.addInitScript(() => {
      const w = globalThis as any;
      w.localStorage.setItem("pwh_lang", "en");
      const facts = { output: "", violations: [] as string[] };
      w.__retainedBrowser = facts;
      w.document.addEventListener("securitypolicyviolation", (event: any) =>
        facts.violations.push(event.violatedDirective),
      );
      const original = w.fetch.bind(w);
      w.fetch = async (...args: any[]) => {
        const response = await original(...args);
        if (String(args[0]).endsWith("/api/terminal/v2/view") && response.ok) {
          const reader = response.clone().body?.getReader(),
            decoder = new TextDecoder();
          if (reader)
            void (async () => {
              let partial = "";
              try {
                for (;;) {
                  const read = await reader.read();
                  if (read.done) break;
                  partial += decoder.decode(read.value, { stream: true });
                  if (partial.length > 65536) throw Error("bounded observer");
                  for (let newline; (newline = partial.indexOf("\n")) >= 0;) {
                    const frame = JSON.parse(partial.slice(0, newline));
                    partial = partial.slice(newline + 1);
                    if (frame.t === "output") facts.output = (facts.output + w.atob(frame.bytesB64)).slice(-65536);
                  }
                }
              } catch {
                /* Original collapse/close cancels the real stream. */
              } finally {
                await reader.cancel().catch(() => {});
              }
            })();
        }
        return response; // Original response/ACK/renderer behavior is never replaced.
      };
    });
    page = await context.newPage();
    page.on("pageerror", (error: Error) => errors.push(error.name));
    page.on("request", (request: any) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/terminal/v2/")) ops.push(path.split("/").pop()!);
    });
    await page.goto(`${origin}/#t=${encodeURIComponent(readFileSync(options.tokenFile, "utf8").trim())}`, {
      waitUntil: "load",
    });
    const card = page.locator(`a.agent-card[href="#/agent/${encodeURIComponent(options.scope.agentKey)}"]`);
    await card.waitFor({ state: "visible", timeout: 15000 });
    await card.click();
    await page.waitForSelector('[data-fold="terminal"]', { timeout: 15000 });
    expect(ops).toEqual([]);
    await page.click('[data-fold="terminal"]');
    await page.waitForSelector(".terminal-v2-unknown", { timeout: 15000 });
    const unknown = page.locator(".terminal-v2-unknown");
    expect(await unknown.locator("button,input,textarea,[role=tab],canvas").count()).toBe(0);
    expect(await unknown.locator("strong").textContent()).toMatch(/·\s*1\s*$/); // Only CURRENT verified session's row.
    let pid: number | undefined, webgl: unknown;
    if (options.legacyCount === 1) {
      await page.waitForSelector('.terminal-v2-panel[data-writable="true"]', { timeout: 15000 });
      expect(options.backendCalls()).toBe(baseline + 1);
      webgl = await page.evaluate(() => {
        const canvas = (globalThis as any).document.querySelector("canvas[data-terminal-webgl-canvas]");
        const gl = canvas?.getContext("webgl2");
        if (!gl) throw Error("real WebGL2 missing");
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          version: gl.getParameter(gl.VERSION),
          renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        };
      });
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("printf 'T51_RETAINED_BROWSER_PID=%s\\n' \"$$\"");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => /T51_RETAINED_BROWSER_PID=\d+/.test((globalThis as any).__retainedBrowser.output),
        undefined,
        { timeout: 8000 },
      );
      pid = await page.evaluate(() =>
        Number(/T51_RETAINED_BROWSER_PID=(\d+)/.exec((globalThis as any).__retainedBrowser.output)![1]),
      );
      expect(pid).toBeGreaterThan(1);
    } else {
      await page.waitForFunction(() =>
        (globalThis as any).document.querySelector('.terminal-v2-panel[data-writable="false"]'),
      );
      expect(options.backendCalls()).toBe(baseline);
      expect(ops.includes("view")).toBe(false);
      expect(ops.includes("input")).toBe(false);
    }
    expect(await page.locator(".terminal-v2-quota").textContent()).toMatch(/2\s*\/\s*2/);
    const createButtons = page.getByRole("button", { name: /New terminal/ });
    expect(await createButtons.count()).toBeGreaterThan(0);
    for (const button of await createButtons.all()) expect(await button.isDisabled()).toBe(true);
    const limited = await page.evaluate(async (scope: any) => {
      const w = globalThis as any;
      const post = async (op: string, body: object) =>
        (
          await w.fetch(`/api/terminal/v2/${op}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-PWH": "1" },
            body: JSON.stringify(body),
          })
        ).json();
      const list = await post("list", { scope });
      return await post("create", {
        scope,
        hubInstance: list.hubInstance,
        requestId: w.crypto.randomUUID(),
        mode: "new",
        cols: 80,
        rows: 24,
      });
    }, options.scope);
    expect(limited.code).toBe("E_LIMIT");
    expect(options.backendCalls()).toBe(baseline + (options.legacyCount === 1 ? 1 : 0));
    await page.screenshot({ path: join(options.output, `retained-browser-L${options.legacyCount}.png`) });
    if (options.legacyCount === 1) {
      await page
        .locator(".terminal-v2-tabs")
        .getByRole("button", { name: /^Close / })
        .click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
      await page.waitForFunction(
        () => !(globalThis as any).document.querySelector('.terminal-v2-tabs [role="tab"]'),
        undefined,
        { timeout: 15000 },
      );
    }
    const ledger = JSON.parse(readFileSync(options.ledgerPath, "utf8"));
    expect(ledger.legacyObligations).toEqual(originalLegacy);
    expect(ledger.allocations).toEqual([]);
    expect(await page.evaluate(() => (globalThis as any).__retainedBrowser.violations)).toEqual([]);
    expect(errors).toEqual([]);
    writeFileSync(
      join(options.output, `retained-browser-L${options.legacyCount}.json`),
      JSON.stringify(
        {
          v: 1,
          browser: "provided Chromium1255 / PW1.65.1",
          hardwareGpuCoverage: "NOT RUN",
          ...(webgl ? { webgl } : {}),
          legacyCount: options.legacyCount,
          unknownReadonly: true,
          quotaLimit: "E_LIMIT",
          backendDelta: options.backendCalls() - baseline,
          ...(pid ? { newPtyPid: pid } : {}),
          actualRendererAndInput: options.legacyCount === 1,
          ops,
          originalLegacyPreserved: true,
          realKernelReboot: false,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    return { backendDelta: options.backendCalls() - baseline, physicalPrunes: options.legacyCount === 1 ? 1 : 0 };
  } catch (error) {
    if (page) await page.screenshot({ path: join(options.output, "retained-browser-failure.png") }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
