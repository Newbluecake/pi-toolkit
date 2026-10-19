/**
 * In-page proxy preview — the App-level state machine (link-preview plan §4.3, package LP3).
 *
 * `closed | opening | ready | error`, driven by `open(href)`:
 *  1. the click target is ALWAYS the LP2-normalized href (path + query included — the full
 *     string is POSTed verbatim as `{target: href}`, the returned one-time enter URL is used
 *     unmodified as the iframe `src`);
 *  2. a generation counter + `AbortController` drop stale/abort previous opens (a re-open,
 *     `reload()` and `close()` all invalidate the in-flight request);
 *  3. a same-href `open()` while still `opening` is a no-op (§3: the only remaining 429 is
 *     `codes` — >16 opens of one instance within 60 s whose iframes never redeemed);
 *  4. mount guards (§2.5): the enter URL must satisfy `isSafeEnterUrl` AND be cross-origin to
 *     the hub page — a same-origin enter URL becomes an `error`, never an iframe.
 *
 * `scope` is the FRAME scope (`proxyFrameScopeOf` — LP0's `proxy.frame.v1` cap on top of the
 * X2 proxy scope): `null` ⇒ `open()` is a no-op and the caller keeps the new-tab flow (§4.1
 * tiers 1-2 stay byte-identical). No `window.open` on this path, so popup blockers do not
 * apply. The dialog closes on an agent-route change (the selected agent key) and when the
 * frame scope is lost (caps dropped on reconnect).
 */
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { isSafeEnterUrl, proxyErrorKey, proxyFrameScopeOf, proxyScopeOf } from "@logic/proxy.js";
import type { ProxyScope } from "../types.js";
import type { ProxyFetchError, ProxyTransport } from "../transport/types.js";

export type ProxyPreviewView =
  | { readonly phase: "closed" }
  | { readonly phase: "opening"; readonly href: string; readonly gen: number }
  | {
      readonly phase: "ready";
      readonly href: string;
      readonly gen: number;
      readonly origin: string;
      readonly enterUrl: string;
      /** The iframe's CURRENT src: the one-time enter URL on first mount, `origin + the initial
       * target's path+query` after an in-place reload (the cross-origin frame's own location is
       * unknowable, so a reload always returns to the link's original path). */
      readonly frameUrl: string;
      /** Bumped per in-place reload so the iframe remounts even when the URL is unchanged. */
      readonly nonce: number;
    }
  | { readonly phase: "error"; readonly href: string; readonly gen: number; readonly key: string };

export interface ProxyPreviewHandle {
  readonly view: Readonly<Ref<ProxyPreviewView>>;
  /** `null` ⇒ no `proxy.frame.v1` cap (or no proxy scope at all): `open()` is a no-op. */
  readonly scope: ComputedRef<ProxyScope | null>;
  open(href: string): void;
  /** Re-open the current href with a fresh one-time code (§2.3 「重新加载」). */
  reload(): void;
  close(): void;
  dispose(): void;
}

export interface UseProxyPreviewOptions {
  /** `hub.transport.proxy` (absent ⇒ no scope, same rule as `useProxyOpen`). */
  readonly proxy: ProxyTransport | undefined;
  /** The hub state (caps + selected agent key feed the scope / route-change close). */
  readonly state: { readonly value: { readonly hub: unknown; readonly selected: string | null } };
  readonly mode?: "token" | "password" | undefined;
  /** Test seam: override the hub page origin for the §2.5 same-origin mount guard. */
  readonly locationOrigin?: string;
}

function capsOf(hub: unknown): unknown {
  return hub !== null && typeof hub === "object" ? (hub as { caps?: unknown }).caps : undefined;
}

/** Pure form of the in-place reload mount guard (exported for tests): `null` unless `href` is
 * http AND the constructed `origin + pathname + search` URL stays on EXACTLY the open result's
 * proxy origin AND that origin is not the hub page's own. */
export function proxyFrameReloadUrl(origin: string, href: string, pageOrigin: string | null): string | null {
  if (pageOrigin === null) return null;
  try {
    const u = new URL(href);
    if (u.protocol !== "http:") return null;
    const url = `${origin}${u.pathname}${u.search}`;
    const o = new URL(url).origin;
    return o === origin && o !== pageOrigin ? url : null;
  } catch {
    return null;
  }
}

export function useProxyPreview(opts: UseProxyPreviewOptions): ProxyPreviewHandle {
  const view = ref<ProxyPreviewView>({ phase: "closed" }) as Ref<ProxyPreviewView>;

  const scope = computed<ProxyScope | null>(() => {
    const caps = capsOf(opts.state.value.hub);
    return proxyFrameScopeOf(
      caps,
      proxyScopeOf(caps, opts.proxy === undefined ? null : { proxy: opts.proxy }, opts.mode),
    );
  });

  let gen = 0;
  let ctl: AbortController | null = null;

  function abortInFlight(): void {
    gen += 1;
    if (ctl !== null) {
      ctl.abort();
      ctl = null;
    }
  }

  /** §2.5 mount guard: the framed origin must differ from the hub page's. Fails CLOSED when
   * the page origin cannot be determined or the URL does not parse. */
  function pageOrigin(): string | null {
    return opts.locationOrigin ?? (typeof window === "undefined" ? null : window.location.origin);
  }

  function enterIsSameOrigin(enterUrl: string): boolean {
    const page = pageOrigin();
    if (page === null) return true;
    try {
      return new URL(enterUrl).origin === page;
    } catch {
      return true;
    }
  }

  function fail(href: string, myGen: number, error: ProxyFetchError): void {
    view.value = { phase: "error", href, gen: myGen, key: proxyErrorKey(error) };
  }

  /** The in-place reload URL (2026-10-19 user ruling: 重新加载 in `ready` must NOT burn the
   * `/api/proxy/open` token bucket — 10 burst, +1/6 s): `<origin> + the normalized href's
   * pathname+search`, riding the EXISTING gate session cookie — no new code, no POST. The
   * mount guard mirrors the enter guard: http only, origin must be exactly the open result's
   * proxy origin (by construction — re-checked), never the hub page's own origin. If the gate
   * session expired in the meantime, the frame simply shows the proxy's 401 page and the user
   * re-opens the dialog (a fresh code is minted then) — no automatic recovery here. */
  function reloadTargetOf(origin: string, href: string): string | null {
    return proxyFrameReloadUrl(origin, href, pageOrigin());
  }

  function open(href: string): void {
    const tr = opts.proxy;
    if (scope.value === null || tr === undefined) return;
    const cur = view.value;
    if (cur.phase === "opening" && cur.href === href) return; // §3 same-href dedupe
    abortInFlight();
    const myGen = gen;
    const c = new AbortController();
    ctl = c;
    view.value = { phase: "opening", href, gen: myGen };
    void tr.open({ target: href }, { signal: c.signal }).then(
      (out) => {
        if (myGen !== gen) return; // stale: a newer open / close superseded this request
        if (ctl === c) ctl = null;
        if (!out.ok) {
          fail(href, myGen, out);
          return;
        }
        if (!isSafeEnterUrl(out.enterUrl) || enterIsSameOrigin(out.enterUrl)) {
          fail(href, myGen, { ok: false, status: 0, error: "E_BAD_RESPONSE" });
          return;
        }
        view.value = {
          phase: "ready",
          href,
          gen: myGen,
          origin: out.origin,
          enterUrl: out.enterUrl,
          frameUrl: out.enterUrl,
          nonce: 0,
        };
      },
      () => {
        if (myGen !== gen) return;
        if (ctl === c) ctl = null;
        fail(href, myGen, { ok: false, status: 0, error: "E_NETWORK" });
      },
    );
  }

  function reload(): void {
    const cur = view.value;
    // 2026-10-19 user ruling: in `ready` the frame is navigated IN PLACE (open's per-user
    // token bucket is 10 burst +1/6 s — rapid reloads must not hit 「操作太频繁」). A guard
    // failure degrades to the error phase (no POST, no automatic navigation). In
    // `error`/`opening` reload keeps calling open(href) (which mints a fresh one-time code).
    if (cur.phase === "ready") {
      const target = reloadTargetOf(cur.origin, cur.href);
      if (target === null) {
        fail(cur.href, cur.gen, { ok: false, status: 0, error: "E_BAD_RESPONSE" });
        return;
      }
      view.value = { ...cur, frameUrl: target, nonce: cur.nonce + 1 };
      return;
    }
    if (cur.phase !== "closed") open(cur.href);
  }

  function close(): void {
    abortInFlight();
    if (view.value.phase !== "closed") view.value = { phase: "closed" };
  }

  // §4.3: the dialog closes on an agent-route change (another session's links are not ours)
  // and when the frame scope is lost (caps dropped on a reconnect).
  const stopRouteWatch = watch(
    () => opts.state.value.selected,
    (next, prev) => {
      if (next !== prev) close();
    },
  );
  const stopScopeWatch = watch(
    () => (scope.value === null ? null : scope.value.lan),
    (next, prev) => {
      if (next !== prev) close();
    },
  );

  function dispose(): void {
    stopRouteWatch();
    stopScopeWatch();
    close();
  }

  return { view, scope, open, reload, close, dispose };
}
