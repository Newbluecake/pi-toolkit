/**
 * P3's assertion module for the visual harness (vue-plan.md v2.1 §4.4.2, §5.2, §5.3 — P3
 * exclusive). Covers the shell/agent-list/detail-header/login rows of ui-design.md §6's
 * per-item table: §6.1 (breakpoints/no horizontal scroll/split vs. single view/sidebar width),
 * §6.2 (deep link → detail, list vs. detail mutual exclusivity below 1025px — todo #7 re-cut
 * the split from 768 to 1025 and added the 481–1024 overlay-drawer checks), §6.3 (coarse-
 * pointer touch targets, no `[title]` tooltips), §6.5 (viewport meta, app-shell height, the
 * dock never `position: fixed`/`sticky`), §6.7 (mobile login card + plaintext-HTTP banner
 * clamp/expand). `checks-body.ts` (P4) and `checks-e2e.ts` (P6) cover the rest.
 */
import type { CheckContext, CheckModule, CheckOutcome } from "../visual.js";

function outcome(name: string, ok: boolean, detail?: string): CheckOutcome {
  return ok ? { name, ok } : { name, ok, detail: detail ?? "failed" };
}

/** §6.1: at no breakpoint should nowrap content widen the page past the viewport. */
async function checkNoHorizontalScroll(ctx: CheckContext): Promise<CheckOutcome> {
  const scrollWidth = await ctx.page.evaluate(() => document.documentElement.scrollWidth);
  return outcome(
    "shell-no-horizontal-scroll",
    scrollWidth <= ctx.width,
    `scrollWidth=${scrollWidth} width=${ctx.width}`,
  );
}

/** §6.1/§6.2/§6.3 + todo #7's mid band: below 1025px only one of `.sidebar`/`.detail` is ever
 * mounted at a time (≤767 single-view; 481–1024 single-view with the sidebar closed by
 * default — it only mounts as the overlay drawer, which no scenario opens by default); at/above
 * 1025px both are mounted side by side. Only meaningful for scenarios that reach the
 * authenticated dashboard shell at all (`login` never does). */
async function checkListDetailSplit(ctx: CheckContext): Promise<CheckOutcome | null> {
  if (ctx.scenario === "login") return null;
  const info = await ctx.page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const detail = document.querySelector(".detail");
    const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
    const detailRect = detail ? detail.getBoundingClientRect() : null;
    return {
      sidebarVisible: sidebarRect !== null && sidebarRect.width > 0 && sidebarRect.height > 0,
      detailVisible: detailRect !== null && detailRect.width > 0 && detailRect.height > 0,
    };
  });
  if (ctx.width < 1025) {
    const exactlyOne = info.sidebarVisible !== info.detailVisible;
    return outcome("shell-single-view-below-1025", exactlyOne, JSON.stringify(info));
  }
  return outcome("shell-split-view-at-1025-plus", info.sidebarVisible && info.detailVisible, JSON.stringify(info));
}

/** §6.1: sidebar width is 288px at the todo-#7 1025px split breakpoint, 340px at 1280+
 * (below 1025 there is no fixed sidebar column at all — the mid band's drawer is overlay-sized
 * and covered by `checkMidDrawer` instead). */
function expectedSidebarWidth(width: number): number | null {
  if (width < 1025) return null;
  if (width < 1280) return 288;
  return 340;
}

async function checkSidebarWidth(ctx: CheckContext): Promise<CheckOutcome | null> {
  if (ctx.scenario === "login" || ctx.width < 1025) return null;
  const expected = expectedSidebarWidth(ctx.width);
  if (expected === null) return null;
  const actual = await ctx.page.evaluate(() => document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0);
  return outcome("shell-sidebar-width", Math.abs(actual - expected) <= 1, `expected=${expected} actual=${actual}`);
}

/** todo #7's 481–1024 mid band: on the detail route the sidebar opens as an overlay drawer
 * (toggle button in the detail header → `.sidebar-drawer` + scrim above the still-mounted
 * detail pane), and Escape closes it without navigating anywhere. */
async function checkMidDrawer(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "detail" || ctx.width < 481 || ctx.width > 1024) return [];
  const toggle = await ctx.page.$(".detail-drawer-toggle");
  if (toggle === null) return [outcome("shell-mid-drawer-toggle-present", false, "no .detail-drawer-toggle")];
  await toggle.click();
  const open = await ctx.page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const rect = sidebar?.getBoundingClientRect();
    return {
      drawerClass: sidebar?.classList.contains("sidebar-drawer") ?? false,
      visible: rect !== undefined && rect !== null && rect.width > 0 && rect.height > 0,
      overlay: sidebar !== null && getComputedStyle(sidebar).position === "absolute",
      scrim: document.querySelector(".drawer-scrim") !== null,
      detailKept: document.querySelector(".detail") !== null,
    };
  });
  const outcomes: CheckOutcome[] = [
    outcome("shell-mid-drawer-opens-overlay", open.drawerClass && open.visible && open.overlay, JSON.stringify(open)),
    outcome("shell-mid-drawer-scrim", open.scrim, "no .drawer-scrim"),
    outcome("shell-mid-drawer-detail-kept", open.detailKept, ".detail unmounted while drawer open"),
  ];
  await ctx.page.keyboard.press("Escape");
  await ctx.page.waitForTimeout(100);
  const closed = await ctx.page.evaluate(() => ({
    sidebarGone: document.querySelector(".sidebar") === null,
    hash: window.location.hash,
  }));
  outcomes.push(
    outcome("shell-mid-drawer-esc-closes", closed.sidebarGone, JSON.stringify(closed)),
    outcome("shell-mid-drawer-esc-keeps-route", closed.hash.includes("/agent/"), closed.hash),
  );
  return outcomes;
}

/** §6.3: any coarse pointer, any width — every interactive element's hit box is ≥44×44, and no
 * `[title]` tooltip exists anywhere (ui-design §6.3: "不依赖 hover"). */
async function checkTouchTargets(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!ctx.hasTouch) return [];
  const result = await ctx.page.evaluate(() => {
    const undersized: string[] = [];
    const selector = "a,button,input,summary,[role=button],label.switch";
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // not rendered (e.g. an inert v-if branch)
      if (r.width < 44 || r.height < 44) {
        undersized.push(`${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""}`);
      }
    }
    const titled = document.querySelectorAll("[title]").length;
    const touchAction = getComputedStyle(document.documentElement).touchAction;
    return { undersized, titled, touchAction };
  });
  return [
    outcome("shell-touch-targets-44px", result.undersized.length === 0, result.undersized.join(", ")),
    outcome("shell-no-title-tooltips", result.titled === 0, `${result.titled} [title] elements`),
    outcome("shell-touch-action-manipulation", result.touchAction === "manipulation", result.touchAction),
  ];
}

/** §6.5: exact viewport meta, no `maximum-scale`/`user-scalable`. */
async function checkViewportMeta(ctx: CheckContext): Promise<CheckOutcome> {
  const content = await ctx.page.evaluate(
    () => document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
  );
  return outcome("shell-viewport-meta", content === "width=device-width, initial-scale=1, viewport-fit=cover", content);
}

/** §6.5: the app shell tracks the real viewport height (`100dvh`), not a stale `100vh`. */
async function checkAppShellHeight(ctx: CheckContext): Promise<CheckOutcome | null> {
  if (ctx.scenario === "login") return null;
  const info = await ctx.page.evaluate(() => {
    const app = document.querySelector(".app");
    return { appHeight: app?.getBoundingClientRect().height ?? -1, innerHeight: window.innerHeight };
  });
  if (info.appHeight < 0) return null; // `.app` not mounted in this scenario/state (e.g. token-invalid gate)
  return outcome("shell-app-shell-height", Math.abs(info.appHeight - info.innerHeight) <= 1, JSON.stringify(info));
}

/** §6.5: the bottom dock lives in the document flow, never `position: fixed`/`sticky` — so it
 * can never cover the transcript or steal focus from it. */
async function checkDockNotOverlay(ctx: CheckContext): Promise<CheckOutcome | null> {
  if (ctx.scenario !== "detail") return null;
  const position = await ctx.page.evaluate(() => {
    const dock = document.querySelector(".dock");
    return dock ? getComputedStyle(dock).position : null;
  });
  if (position === null) return null;
  return outcome("shell-dock-not-overlay", position !== "fixed" && position !== "sticky", position);
}

/** §6.7: the plaintext-HTTP safety banner clamps to ≤2 lines / ≤60px on phones, has no close
 * button (persistent), and expands on tap — `dev-hub` always serves over plain HTTP, so this
 * banner is present on every `login` run without any fixture flag. */
async function checkLoginPlaintextBanner(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "login" || ctx.width > 767) return [];
  const before = await ctx.page.evaluate(() => {
    const notice = document.querySelector("details.notice-compact");
    if (!notice) return null;
    const rect = notice.getBoundingClientRect();
    return {
      height: rect.height,
      hasCloseButton: notice.querySelector("button") !== null,
      open: (notice as HTMLDetailsElement).open,
    };
  });
  if (before === null)
    return [outcome("shell-login-plaintext-banner-present", false, "no details.notice-compact found")];
  const outcomes: CheckOutcome[] = [
    outcome("shell-login-plaintext-banner-clamped", before.height <= 60, `height=${before.height}`),
    outcome("shell-login-plaintext-banner-no-close", !before.hasCloseButton, "found a <button> inside the notice"),
  ];
  await ctx.page.click("details.notice-compact > summary");
  const after = await ctx.page.evaluate(
    () => (document.querySelector("details.notice-compact") as HTMLDetailsElement | null)?.open ?? false,
  );
  outcomes.push(outcome("shell-login-plaintext-banner-expands", after === true, `open=${after}`));
  return outcomes;
}

/** §6.7: the login card fits comfortably on a 375-wide phone with the submit button visible in
 * the first screenful, and its inputs meet the 44px / 16px / no-zoom rules. */
async function checkLoginCardMobile(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "login" || ctx.width > 480) return [];
  const info = await ctx.page.evaluate(() => {
    const card = document.querySelector(".login-card");
    const cardRect = card?.getBoundingClientRect();
    const submit = document.querySelector('button[type="submit"]');
    const submitRect = submit?.getBoundingClientRect();
    const username = document.querySelector("#login-username");
    const usernameStyle = username ? getComputedStyle(username) : null;
    const showPw = document.querySelector(".input-wrap .btn-icon");
    const showPwRect = showPw?.getBoundingClientRect();
    return {
      cardWidth: cardRect?.width ?? -1,
      submitBottom: submitRect?.bottom ?? Infinity,
      innerHeight: window.innerHeight,
      usernameFontSize: usernameStyle?.fontSize ?? "",
      usernameAutocapitalize: username?.getAttribute("autocapitalize") ?? "",
      usernameSpellcheck: username?.getAttribute("spellcheck") ?? "",
      showPwWidth: showPwRect?.width ?? -1,
      showPwHeight: showPwRect?.height ?? -1,
    };
  });
  return [
    outcome("shell-login-card-width", info.cardWidth <= 400, `cardWidth=${info.cardWidth}`),
    outcome(
      "shell-login-submit-visible-first-screen",
      info.submitBottom <= info.innerHeight,
      `submitBottom=${info.submitBottom} innerHeight=${info.innerHeight}`,
    ),
    outcome("shell-login-input-16px", info.usernameFontSize === "16px", info.usernameFontSize),
    outcome(
      "shell-login-input-no-autocap-spellcheck",
      info.usernameAutocapitalize === "none" && info.usernameSpellcheck === "false",
      `autocapitalize=${info.usernameAutocapitalize} spellcheck=${info.usernameSpellcheck}`,
    ),
    outcome(
      "shell-login-show-password-44px",
      info.showPwWidth >= 44 && info.showPwHeight >= 44,
      `${info.showPwWidth}x${info.showPwHeight}`,
    ),
  ];
}

/** §6.7's "显示密码" toggle actually flips the input type + `aria-pressed` (behavioral, not
 * just a size check — cheap enough to run once per `login` cell regardless of width). */
async function checkShowPasswordToggle(ctx: CheckContext): Promise<CheckOutcome | null> {
  if (ctx.scenario !== "login") return null;
  const before = await ctx.page.evaluate(
    () => (document.querySelector("#login-password") as HTMLInputElement | null)?.type ?? "",
  );
  await ctx.page.click('button[aria-label="Show password"]');
  const after = await ctx.page.evaluate(
    () => (document.querySelector("#login-password") as HTMLInputElement | null)?.type ?? "",
  );
  return outcome(
    "shell-show-password-toggles-type",
    before === "password" && after === "text",
    `${before} -> ${after}`,
  );
}

export const check: CheckModule = {
  id: "shell",
  async run(ctx: CheckContext): Promise<CheckOutcome[]> {
    const outcomes: CheckOutcome[] = [await checkNoHorizontalScroll(ctx), await checkViewportMeta(ctx)];
    const optional = await Promise.all([
      checkListDetailSplit(ctx),
      checkSidebarWidth(ctx),
      checkAppShellHeight(ctx),
      checkDockNotOverlay(ctx),
      checkShowPasswordToggle(ctx),
    ]);
    for (const o of optional) if (o !== null) outcomes.push(o);
    outcomes.push(...(await checkTouchTargets(ctx)));
    outcomes.push(...(await checkMidDrawer(ctx)));
    outcomes.push(...(await checkLoginPlaintextBanner(ctx)));
    outcomes.push(...(await checkLoginCardMobile(ctx)));
    return outcomes;
  },
};
