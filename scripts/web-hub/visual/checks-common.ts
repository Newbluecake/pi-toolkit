/**
 * P2's own assertion module for the visual harness (vue-plan.md v2.1 §4.4, §5.2). The only
 * checks that make sense before P3/P4 exist at all: pure network/security hygiene (never a
 * CSP violation, never a console error, never a cross-origin request, never a failed request)
 * plus the theme three-state toggle + refresh-persistence, which is fully driven by
 * `public/theme-init.js` (shipped in P0) and needs no application UI to exercise.
 */
import type { CheckContext, CheckModule, CheckOutcome } from "../visual.js";

const THEME_KEY = "pwh_theme";

function outcome(name: string, ok: boolean, detail?: string): CheckOutcome {
  return ok ? { name, ok } : { name, ok, detail: detail ?? "failed" };
}

async function checkNoCspViolations(ctx: CheckContext): Promise<CheckOutcome> {
  return outcome("no-csp-violations", ctx.cspViolations.length === 0, JSON.stringify(ctx.cspViolations));
}

async function checkNoConsoleErrors(ctx: CheckContext): Promise<CheckOutcome> {
  return outcome("no-console-errors", ctx.consoleErrors.length === 0, ctx.consoleErrors.join(" | "));
}

async function checkNoPageErrors(ctx: CheckContext): Promise<CheckOutcome> {
  return outcome("no-uncaught-page-errors", ctx.pageErrors.length === 0, ctx.pageErrors.join(" | "));
}

async function checkNoCrossOriginRequests(ctx: CheckContext): Promise<CheckOutcome> {
  const foreign = ctx.requests.filter((r) => !r.sameOrigin);
  return outcome("no-cross-origin-requests", foreign.length === 0, foreign.map((r) => r.url).join(" | "));
}

async function checkNoFailedRequests(ctx: CheckContext): Promise<CheckOutcome> {
  return outcome(
    "no-failed-requests",
    ctx.failedRequests.length === 0,
    ctx.failedRequests.map((r) => `${r.url} (${r.reason})`).join(" | "),
  );
}

/** Sets `pwh_theme`, reloads (so `theme-init.js` re-reads it before first paint — this is the
 * "刷新保持" half of the assertion, not just an in-memory toggle), and reports the resulting
 * `<html>` class state. */
async function applyThemeAndReload(
  ctx: CheckContext,
  pref: "light" | "dark" | "system",
): Promise<{ light: boolean; dark: boolean }> {
  await ctx.page.evaluate(
    (args) => {
      try {
        if (args.pref === "system") window.localStorage.removeItem(args.key);
        else window.localStorage.setItem(args.key, args.pref);
      } catch {
        /* ignore — matches theme-init.js's own defensive posture */
      }
    },
    { key: THEME_KEY, pref },
  );
  await ctx.page.reload({ waitUntil: "load" });
  await ctx.refreshCspViolations();
  return ctx.page.evaluate(() => ({
    light: document.documentElement.classList.contains("theme-light"),
    dark: document.documentElement.classList.contains("theme-dark"),
  }));
}

async function checkThemeThreeStateAndPersist(ctx: CheckContext): Promise<CheckOutcome> {
  const light = await applyThemeAndReload(ctx, "light");
  if (light.light !== true || light.dark !== false) {
    return outcome(
      "theme-three-state-persist",
      false,
      `after pwh_theme=light: light=${light.light} dark=${light.dark}`,
    );
  }
  const dark = await applyThemeAndReload(ctx, "dark");
  if (dark.dark !== true || dark.light !== false) {
    return outcome("theme-three-state-persist", false, `after pwh_theme=dark: light=${dark.light} dark=${dark.dark}`);
  }
  const system = await applyThemeAndReload(ctx, "system");
  if (system.light !== false || system.dark !== false) {
    return outcome(
      "theme-three-state-persist",
      false,
      `after pwh_theme=system: light=${system.light} dark=${system.dark}`,
    );
  }
  return outcome("theme-three-state-persist", true);
}

export const check: CheckModule = {
  id: "common",
  async run(ctx: CheckContext): Promise<CheckOutcome[]> {
    return [
      await checkNoCspViolations(ctx),
      await checkNoConsoleErrors(ctx),
      await checkNoPageErrors(ctx),
      await checkNoCrossOriginRequests(ctx),
      await checkNoFailedRequests(ctx),
      await checkThemeThreeStateAndPersist(ctx),
    ];
  },
};
