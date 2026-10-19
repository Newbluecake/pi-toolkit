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
  function enterIsSameOrigin(enterUrl: string): boolean {
    const pageOrigin = opts.locationOrigin ?? (typeof window === "undefined" ? null : window.location.origin);
    if (pageOrigin === null) return true;
    try {
      return new URL(enterUrl).origin === pageOrigin;
    } catch {
      return true;
    }
  }

  function fail(href: string, myGen: number, error: ProxyFetchError): void {
    view.value = { phase: "error", href, gen: myGen, key: proxyErrorKey(error) };
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
        view.value = { phase: "ready", href, gen: myGen, origin: out.origin, enterUrl: out.enterUrl };
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
