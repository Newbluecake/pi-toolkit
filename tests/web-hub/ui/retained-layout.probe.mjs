/** Opt-in real-browser U1 gate; run via tsx after build:web. Never a lifecycle E2E.
 * npm_config_offline=true + the existing Playwright cache are required by the caller.
 * U1_EVIDENCE_DIR may select a separate mutation evidence directory.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createDevHub } from "../../../scripts/web-hub/dev-hub.ts";
import { loadPlaywright } from "../../../scripts/web-hub/lib/playwright.ts";

const dir = process.env.U1_EVIDENCE_DIR ?? "/tmp/webhub-exited-U1-evidence/r2";
await mkdir(dir, { recursive: true });
const at = 1794651000000;
const items = [
  {
    spawnId: "sp-recovery-layout",
    state: "failed",
    createdAt: at - 1000,
    updatedAt: at,
    cwdLabel: "project-with-a-long-readable-cwd-label",
    restore: { attempt: 1 },
    origin: { listener: "loopback", reqId: "old-request" },
  },
];
const policy = {
  allowed: true,
  confirm: "unknown-dir",
  scope: "known",
  max: 10,
  maxPerPrincipal: 10,
  active: 0,
  activeMine: 0,
  registerTimeoutS: 30,
  maxLifetimeMinutes: 720,
};
await writeFile(
  `${dir}/layout.json`,
  JSON.stringify({
    agents: [],
    history: {},
    hubState: { caps: ["spawn.v1", "spawn.relaunch.v1", "spawn.exited.v1"] },
    script: [{ atMs: 0, event: "spawns", data: { items, active: 0, max: 10 } }],
  }),
);
const pw = await loadPlaywright();
if (!pw.ok) throw new Error(pw.reason);
const hub = await createDevHub({
  mode: "token",
  scenario: "layout",
  fixturesDir: dir,
  log: (line) => {
    if (!line.startsWith("dev-hub: token=")) console.log(line);
  },
});
let browser;
const results = [];
try {
  browser = await pw.chromium.launch({ headless: true });
  for (const uiLang of ["zh", "en"]) {
    for (const width of [null, 240]) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: uiLang === "zh" ? "en-US" : "zh-CN",
      });
      try {
        await context.addInitScript(
          ({ uiLang, width }) => {
            localStorage.setItem("pwh_lang", uiLang);
            if (width !== null) localStorage.setItem("pwh_sidebar_w", String(width));
          },
          { uiLang, width },
        );
        const page = await context.newPage();
        const errors = [],
          network = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        page.on("response", (r) => {
          if (new URL(r.url()).pathname.startsWith("/api"))
            network.push({ path: new URL(r.url()).pathname, status: r.status() });
        });
        await page.route("**/api/headless**", (route) => {
          if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/api/headless")
            throw new Error("unexpected request");
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, policy, items }),
          });
        });
        await page.goto(`${hub.url}/#t=${encodeURIComponent(hub.token)}`, { waitUntil: "load" });
        await page.locator(".spawn-row.is-retained-restore").waitFor({ state: "visible" });
        const bounds = await page.evaluate(() => {
          const row = document.querySelector(".spawn-row");
          const r = row.getBoundingClientRect();
          const serialize = (r) => ({
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            right: r.right,
            bottom: r.bottom,
          });
          const buttons = [...row.querySelectorAll("button")].map((button) => {
            const b = button.getBoundingClientRect();
            const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
            return {
              text: button.textContent.trim(),
              rect: serialize(b),
              hit: hit === button || button.contains(hit),
              inside: b.x >= r.x && b.right <= r.right && b.y >= r.y && b.bottom <= r.bottom,
            };
          });
          return {
            row: serialize(r),
            sidebar: document.querySelector(".sidebar").getBoundingClientRect().width,
            cwd: serialize(row.querySelector(".spawn-row-cwd").getBoundingClientRect()),
            buttons,
          };
        });
        const name = `${uiLang}-${width ?? "default-300"}`;
        await page.screenshot({ path: `${dir}/row-${name}.png`, fullPage: true });
        if (Math.abs(bounds.sidebar - (width ?? 300)) > 1)
          throw new Error("unexpected sidebar width " + JSON.stringify(bounds));
        if (bounds.cwd.width <= 0 || bounds.buttons.some((b) => !b.inside || !b.hit)) {
          await writeFile(`${dir}/failure-${name}.json`, JSON.stringify(bounds, null, 2));
          throw new Error("recovery row geometry/hit-test failure: " + JSON.stringify(bounds));
        }
        await page.locator(".sidebar-history-btn").click();
        await page.locator(".history-retained time").waitFor({ state: "visible" });
        async function assertDate(lang) {
          const dates = await page.evaluate(
            ({ at, lang }) => ({
              actual: document.querySelector(".history-retained time").textContent,
              expected: new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(at)),
              browser: navigator.language,
            }),
            { at, lang },
          );
          if (dates.actual !== dates.expected) throw new Error("date locale mismatch " + JSON.stringify(dates));
          return dates;
        }
        const initialDate = await assertDate(uiLang);
        // Exercise real language-menu handlers while retaining the mounted modal. The menu
        // is under its scrim, so dispatch via DOM instead of claiming it is pointer-reachable.
        await page.locator(".lang-toggle").evaluate((el) => el.click());
        const next = uiLang === "zh" ? "en" : "zh";
        await page.locator(`.lang-menu-item[data-lang=${next}]`).evaluate((el) => el.click());
        await page.waitForFunction(
          (lang) =>
            document.querySelector(".history-retained-title")?.textContent ===
            (lang === "zh" ? "最近退出的托管会话" : "Recently exited managed sessions"),
          next,
        );
        const switchedDate = await assertDate(next);
        await page.screenshot({ path: `${dir}/date-${name}.png`, fullPage: true });
        if (errors.length) throw new Error("browser errors " + JSON.stringify(errors));
        if (network.some((r) => r.path.includes("/history"))) throw new Error("managed-only scan");
        results.push({ uiLang, width: width ?? 300, bounds, initialDate, switchedDate, errors, network });
        console.log(`[U1 r2 browser] PASS ${name}`);
      } finally {
        await context.close();
      }
    }
  }
  await writeFile(`${dir}/results.json`, JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await hub.close();
}
