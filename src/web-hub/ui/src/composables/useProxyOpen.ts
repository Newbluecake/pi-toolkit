/**
 * web-hub port proxy — the open flow (web-hub-proxy plan v2 §8, package X2).
 *
 * `openProxyTab(transport, target, opts)` is the pure flow behind every entry point (the TopBar
 * dialog, a clickable `http://127.0.0.1:<port>/…` in a message):
 *  1. SYNCHRONOUSLY `window.open("about:blank", "_blank")` — before the first `await`, while the
 *     click's user activation is alive (popup blockers, Safari);
 *  2. `POST /api/proxy/open`;
 *  3. success ⇒ `w.opener = null; w.location.replace(enterUrl)` — the one-time enter URL is used
 *     by exactly this navigation (replace: no history entry; never logged, never stored by this
 *     module). `w === null` (popup blocked) ⇒ the outcome carries the URL so the caller can show
 *     it as `<a target=_blank rel="noopener noreferrer">`;
 *  4. error ⇒ `w.close()` + a prose error key (`proxyErrorKey`).
 *
 * `useProxyOpen()` is the component-facing wrapper: scope derivation off the injected hub
 * (`HUB_CTX` caps + `CONTROL_ENV.authMode` + the transport's `proxy` member), a `busy` flag and
 * the last error / popup-blocked fallback. Cap or transport absent ⇒ `scope` is `null` and the
 * caller renders no affordance at all.
 */
import { computed, inject, ref, type ComputedRef, type Ref } from "vue";
import { isSafeEnterUrl, proxyErrorKey, proxyScopeOf } from "@logic/proxy.js";
import type { ProxyOpenResult } from "@protocol/proxy.js";
import { CONTROL_ENV, HUB_CTX } from "../components/control/controlContext.js";
import type { ProxyScope } from "../types.js";
import type { ProxyFetchError, ProxyTransport } from "../transport/types.js";

/** Minimal `Window` surface the flow needs (test seam). */
export interface ProxyWindowLike {
  open(url?: string, target?: string): ProxyTabLike | null;
}
export interface ProxyTabLike {
  opener: unknown;
  closed?: boolean;
  location: { replace(url: string): void };
  close(): void;
}

export type ProxyOpenOutcome =
  /** The tab navigated to the enter URL. */
  | { readonly ok: true; readonly blocked: false; readonly result: ProxyOpenResult }
  /** Popup blocked (or the tab vanished): show `result.enterUrl` as a link. */
  | { readonly ok: true; readonly blocked: true; readonly result: ProxyOpenResult }
  | { readonly ok: false; readonly key: string; readonly error: ProxyFetchError };

export interface OpenProxyTabOptions {
  readonly win?: ProxyWindowLike | null;
  readonly signal?: AbortSignal;
}

function browserWindow(): ProxyWindowLike | null {
  return typeof window === "undefined" ? null : (window as unknown as ProxyWindowLike);
}

export async function openProxyTab(
  transport: ProxyTransport,
  target: string,
  opts: OpenProxyTabOptions = {},
): Promise<ProxyOpenOutcome> {
  const win = opts.win === undefined ? browserWindow() : opts.win;
  // (1) MUST precede every await.
  let tab: ProxyTabLike | null = null;
  try {
    tab = win === null ? null : win.open("about:blank", "_blank");
  } catch {
    tab = null;
  }
  const closeTab = (): void => {
    try {
      tab?.close();
    } catch {
      /* already gone */
    }
  };

  let out;
  try {
    out = await transport.open({ target }, opts.signal === undefined ? undefined : { signal: opts.signal });
  } catch {
    closeTab();
    const error: ProxyFetchError = { ok: false, status: 0, error: "E_NETWORK" };
    return { ok: false, key: proxyErrorKey(error), error };
  }
  if (!out.ok) {
    closeTab();
    return { ok: false, key: proxyErrorKey(out), error: out };
  }
  const result: ProxyOpenResult = {
    instanceId: out.instanceId,
    origin: out.origin,
    enterUrl: out.enterUrl,
    target: out.target,
  };
  if (!isSafeEnterUrl(result.enterUrl)) {
    closeTab();
    const error: ProxyFetchError = { ok: false, status: 0, error: "E_BAD_RESPONSE" };
    return { ok: false, key: proxyErrorKey(error), error };
  }
  if (tab === null || tab.closed === true) return { ok: true, blocked: true, result };
  try {
    tab.opener = null;
    tab.location.replace(result.enterUrl);
  } catch {
    closeTab();
    return { ok: true, blocked: true, result };
  }
  return { ok: true, blocked: false, result };
}

export interface ProxyOpenHandle {
  /** `null` ⇒ no cap / no transport method: render no proxy affordance. */
  readonly scope: ComputedRef<ProxyScope | null>;
  readonly transport: ComputedRef<ProxyTransport | null>;
  readonly busy: Readonly<Ref<boolean>>;
  /** i18n key of the last failure (cleared by the next `open()` / `clear()`). */
  readonly errorKey: Readonly<Ref<string | null>>;
  /** Popup-blocked fallback: the one-time enter URL to render as a link. */
  readonly fallbackUrl: Readonly<Ref<string | null>>;
  /** Resolves `true` iff a tab was navigated or a fallback link is available. */
  open(target: string): Promise<boolean>;
  clear(): void;
}

interface HubLike {
  readonly state: { readonly value: { readonly hub: unknown } };
  readonly transport?: { readonly proxy?: ProxyTransport };
}

export function useProxyOpen(opts: { readonly win?: ProxyWindowLike | null } = {}): ProxyOpenHandle {
  const hub = inject(HUB_CTX, null) as unknown as HubLike | null;
  const env = inject(CONTROL_ENV, null);
  const transport = computed<ProxyTransport | null>(() => hub?.transport?.proxy ?? null);
  const scope = computed<ProxyScope | null>(() => {
    const frame = hub?.state.value.hub;
    const caps = frame !== null && typeof frame === "object" ? (frame as { caps?: unknown }).caps : undefined;
    return proxyScopeOf(caps, hub?.transport, env?.authMode);
  });
  const busy = ref(false);
  const errorKey = ref<string | null>(null);
  const fallbackUrl = ref<string | null>(null);

  function clear(): void {
    errorKey.value = null;
    fallbackUrl.value = null;
  }

  function open(target: string): Promise<boolean> {
    const tr = transport.value;
    if (tr === null || scope.value === null || busy.value) return Promise.resolve(false);
    clear();
    busy.value = true;
    // `openProxyTab` runs synchronously up to its first await ⇒ window.open happens inside the
    // caller's click handler.
    return openProxyTab(tr, target, opts.win === undefined ? {} : { win: opts.win }).then((o) => {
      busy.value = false;
      if (!o.ok) {
        errorKey.value = o.key;
        return false;
      }
      if (o.blocked) fallbackUrl.value = o.result.enterUrl;
      return true;
    });
  }

  return { scope, transport, busy, errorKey, fallbackUrl, open, clear };
}
