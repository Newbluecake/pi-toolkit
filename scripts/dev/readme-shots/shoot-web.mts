// Web UI shots: real built UI (dist/web-hub-ui) served by scripts/web-hub/dev-hub.ts with synthetic fixtures.
// Usage (repo root, after `npm run build:web`):  npx tsx scripts/dev/readme-shots/shoot-web.mts
import { createDevHub, DEFAULT_UI_DIST } from "../../web-hub/dev-hub.js";
import { loadPlaywright } from "../../web-hub/lib/playwright.js";
const OUT = process.env.README_SHOTS_DIR ?? `${process.env.HOME}/readme-shots`;
const pw: any = await loadPlaywright();
if (!pw.ok) throw new Error(`playwright unavailable: ${pw.error}`);
const browser = await pw.chromium.launch({ headless: true });

async function session(
  lang: "zh" | "en",
  theme: "light" | "dark",
  vp: { width: number; height: number },
  mobile: boolean,
) {
  const hub = await createDevHub({
    mode: "token",
    scenario: `demo-${lang}`,
    fixturesDir: `${OUT}/fixtures`,
    root: DEFAULT_UI_DIST,
    log: () => {},
  });
  const ctx = await browser.newContext({
    viewport: vp,
    deviceScaleFactor: mobile ? 2 : 1,
    hasTouch: mobile,
    isMobile: mobile,
  });
  await ctx.addInitScript(`
    localStorage.setItem("pwh_lang","${lang}"); localStorage.setItem("pwh_theme","${theme}");
    for (const v of ["plainHttp","https","local"]) { localStorage.setItem("webhub.controlNotice.dismissed."+v,"1"); sessionStorage.setItem("webhub.controlNotice.dismissed."+v,"1"); }
    // freeze the build chip (real build carries commit hash + build time)
    new MutationObserver(() => { for (const e of document.querySelectorAll(".version-chip")) if (e.textContent !== "ui 0.6.0") e.textContent = "ui 0.6.0"; })
      .observe(document, { childList: true, subtree: true, characterData: true });
  `);
  const page = await ctx.newPage();
  await page.goto(`${hub.url}/#t=${encodeURIComponent(hub.token ?? "")}`);
  await page.waitForSelector(".app");
  return {
    hub,
    ctx,
    page,
    close: async () => {
      await ctx.close();
      await hub.close();
    },
  };
}
const open = async (page: any, key = "agent-alpha") => {
  await page.evaluate(`location.hash="#/agent/${key}"`);
  await page.waitForTimeout(2500);
};
// transcript starts at the TOP so the first user bubble is visible
const toTop = async (page: any) => {
  await page.evaluate(
    `(() => { const t = document.querySelector("#transcript"); const s = [t, ...document.querySelectorAll("#transcript *")].find((e) => e && e.scrollHeight > e.clientHeight + 4); if (s) s.scrollTop = 0; })()`,
  );
  await page.waitForTimeout(400);
};

for (const [lang, theme] of [
  ["zh", "light"],
  ["zh", "dark"],
  ["en", "light"],
] as const) {
  const s = await session(lang, theme, { width: 1440, height: 900 }, false);
  await open(s.page);
  await toTop(s.page);
  await s.page.screenshot({ path: `${OUT}/raw-web-desktop-${lang}-${theme}.png` });
  await s.close();
}
const m = await session("zh", "light", { width: 390, height: 844 }, true);
await m.page.waitForTimeout(1500);
await m.page.screenshot({ path: `${OUT}/raw-web-mobile-list.png` });
await open(m.page);
await toTop(m.page);
await m.page.screenshot({ path: `${OUT}/raw-web-mobile-chat.png` });
await m.page.click(".fleet-summary-bar");
await m.page.waitForTimeout(1200);
await m.page.screenshot({ path: `${OUT}/raw-web-mobile-agents.png` });
await m.close();
await browser.close();
