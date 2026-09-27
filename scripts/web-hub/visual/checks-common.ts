/**
 * P2's own assertion module for the visual harness (vue-plan.md v2.1 §4.4, §5.2). The only
 * checks that make sense before P3/P4 exist at all: pure network/security hygiene (never a
 * CSP violation, never a console error, never a cross-origin request, never a failed request)
 * plus the theme three-state toggle + refresh-persistence, which is fully driven by
 * `public/theme-init.js` (shipped in P0) and needs no application UI to exercise.
 */
import type { CheckContext, CheckModule, CheckOutcome } from "../visual.js";

const THEME_KEY = "pwh_theme";

/** Password mode's own pre-login auth-recovery protocol (`password-client.js`'s `start()`/error
 * handler) deliberately probes `GET /api/session` and opens an `EventSource` at `/api/events`
 * *before* any credentials exist — both come back `401` while the visitor is still looking at
 * the sign-in form, and that is the intended, spec'd behavior (vue-plan.md §3.9), not a bug.
 * Only these two same-origin paths, and only a bare `HTTP 401`, are allowlisted here — a 403/
 * 404/5xx on the same paths, or a 401 anywhere else (e.g. `/api/subscribe` after a real submit
 * failure), still fails the check. See `tests/web-hub/ui/checks-common-401-allowlist.test.ts`.
 *
 * Literal strings, not `import { API } from "../../../src/web-hub/web/contract.js"`: that file
 * is untyped plain JS with no `.d.ts`, and this module must also pass a standalone strict `tsc`
 * invocation with no `allowJs` — importing it there is a `TS7016` implicit-any error. The
 * allowlist test cross-checks these two literals against the real `API.session`/`API.events`
 * (imported there under vitest's normal, allowJs-friendly transform) so a rename can't drift. */
const API_SESSION_PATH = "/api/session";
const API_EVENTS_PATH = "/api/events";
const EXPECTED_PRE_LOGIN_401_PATHS: ReadonlySet<string> = new Set([API_SESSION_PATH, API_EVENTS_PATH]);

export function isExpectedPreLoginAuthProbe(record: { readonly url: string; readonly reason: string }): boolean {
  if (record.reason !== "HTTP 401") return false;
  let pathname: string;
  try {
    pathname = new URL(record.url).pathname;
  } catch {
    return false;
  }
  return EXPECTED_PRE_LOGIN_401_PATHS.has(pathname);
}

/** Chrome/CDP itself (not page-authored code) also mirrors a same failed resource load into the
 * console as an `error`-level message shaped `"Failed to load resource: the server responded
 * with a status of <code> (<statusText>) [<url>]"` (`visual.ts`'s console listener appends the
 * `[url]` suffix from `ConsoleMessage.location()`) — same allowlist, same reasoning as above. */
const CONSOLE_401_RE = /^Failed to load resource: the server responded with a status of 401 \(Unauthorized\) \[(.+)\]$/;

export function isExpectedPreLoginConsole401(message: string): boolean {
  const m = CONSOLE_401_RE.exec(message);
  if (!m) return false;
  try {
    return EXPECTED_PRE_LOGIN_401_PATHS.has(new URL(m[1]!).pathname);
  } catch {
    return false;
  }
}

function outcome(name: string, ok: boolean, detail?: string): CheckOutcome {
  return ok ? { name, ok } : { name, ok, detail: detail ?? "failed" };
}

async function checkNoCspViolations(ctx: CheckContext): Promise<CheckOutcome> {
  return outcome("no-csp-violations", ctx.cspViolations.length === 0, JSON.stringify(ctx.cspViolations));
}

async function checkNoConsoleErrors(ctx: CheckContext): Promise<CheckOutcome> {
  const unexpected = ctx.consoleErrors.filter((m) => !isExpectedPreLoginConsole401(m));
  return outcome("no-console-errors", unexpected.length === 0, unexpected.join(" | "));
}

async function checkNoPageErrors(ctx: CheckContext): Promise<CheckOutcome> {
  return outcome("no-uncaught-page-errors", ctx.pageErrors.length === 0, ctx.pageErrors.join(" | "));
}

async function checkNoCrossOriginRequests(ctx: CheckContext): Promise<CheckOutcome> {
  const foreign = ctx.requests.filter((r) => !r.sameOrigin);
  return outcome("no-cross-origin-requests", foreign.length === 0, foreign.map((r) => r.url).join(" | "));
}

async function checkNoFailedRequests(ctx: CheckContext): Promise<CheckOutcome> {
  const unexpected = ctx.failedRequests.filter((r) => !isExpectedPreLoginAuthProbe(r));
  return outcome(
    "no-failed-requests",
    unexpected.length === 0,
    unexpected.map((r) => `${r.url} (${r.reason})`).join(" | "),
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
