/**
 * Proxy preview injection key (link-preview plan §4.3, package LP3).
 *
 * `PROXY_PREVIEW_CTX` is provided by App.vue next to `PREVIEW_CTX` and holds the App-level
 * `useProxyPreview` state machine. `PathText` / `MdInline` inject it: present AND
 * `handle.scope.value !== null` (the hub advertises `proxy.frame.v1` on top of a proxy scope,
 * §4.1 tier 3) ⇒ a plain click opens the in-page dialog; absent / no frame scope ⇒ the X2
 * new-tab flow, byte-identical to before.
 */
import type { InjectionKey } from "vue";
import type { ProxyPreviewHandle } from "../../composables/useProxyPreview.js";

export interface ProxyPreviewContext {
  /** LP3 `useProxyPreview`'s handle — the App-level proxy-preview state machine. */
  readonly handle: ProxyPreviewHandle;
}

export const PROXY_PREVIEW_CTX: InjectionKey<ProxyPreviewContext> = Symbol("web-hub-proxy-preview");
