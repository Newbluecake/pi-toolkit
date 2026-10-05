/**
 * Hash-based deep-link routing (vue-plan.md v2.1 §3.7, §5.2 — P0). `#/` ⇒ list; `#/agent/<key>`
 * (percent-encoded) ⇒ that agent; `#/settings` ⇒ the standalone settings page (user-decided
 * 2026-10: theme / font size / default delivery mode moved here off the top bar and composer);
 * anything else (including a lingering `#t=` token fragment) parses as `list` — never as an
 * agent key.
 *
 * **Ordering constraint (plan §3.7)**: in token mode, `@logic/token-client.js`'s `start()`
 * consumes and clears any `#t=` fragment (via `history.replaceState`) before this composable's
 * `start()` is called, so a token never has a chance to be mis-parsed as an agent key. Callers
 * must not call `start()` until that has happened.
 */
import { ref, type Ref } from "vue";
import type { Route } from "../types.js";

type RouteWindow = Pick<Window, "location" | "history" | "addEventListener" | "removeEventListener">;

export interface HashRouteHandle {
  readonly route: Readonly<Ref<Route>>;
  /** Begin listening to `hashchange`; also does one synchronous parse of the current hash. */
  start(): void;
  dispose(): void;
  /** Programmatic navigation — a real hash change (`history.pushState`-equivalent via `location.hash`), so back/forward work. */
  navigate(next: Route): void;
}

export function parseRouteHash(hash: string): Route {
  if (hash === "#/settings") return { name: "settings" };
  const prefix = "#/agent/";
  if (hash.startsWith(prefix)) {
    const raw = hash.slice(prefix.length);
    if (raw === "") return { name: "list" };
    try {
      const key = decodeURIComponent(raw);
      return key === "" ? { name: "list" } : { name: "agent", key };
    } catch {
      return { name: "list" };
    }
  }
  return { name: "list" };
}

export function routeToHash(route: Route): string {
  if (route.name === "settings") return "#/settings";
  return route.name === "list" ? "#/" : `#/agent/${encodeURIComponent(route.key)}`;
}

export function useHashRoute(win: RouteWindow): HashRouteHandle {
  const route = ref<Route>(parseRouteHash(win.location.hash)) as Ref<Route>;
  const onHashChange = () => {
    route.value = parseRouteHash(win.location.hash);
  };
  return {
    route,
    start() {
      onHashChange();
      win.addEventListener("hashchange", onHashChange);
    },
    dispose() {
      win.removeEventListener("hashchange", onHashChange);
    },
    navigate(next) {
      const hash = routeToHash(next);
      if (win.location.hash !== hash) win.location.hash = hash;
    },
  };
}
