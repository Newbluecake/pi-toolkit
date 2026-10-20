/**
 * 2026-10-20 field report 「手机模式下点击代理按钮没有反应」: the hub re-resolves its UI root
 * whenever a new build lands (`hub/ui-root.ts`), so a tab opened before the rebuild still runs
 * the OLD index — its lazy chunks (ProxyDialog, preview, settings…) now 404, every
 * `defineAsyncComponent` loader rejects and the button looks dead. Vite reports every failed
 * dynamic import as a `vite:preloadError` window event; we latch it into one page-wide flag that
 * App.vue turns into a persistent 「界面已更新，请刷新」 notice. Browser-only module state is fine
 * here (the SPA never re-activates in place the way the pi extension does).
 */
import { readonly, ref, type Ref } from "vue";

const stale = ref(false);

/** True once any lazy chunk failed to load (the page is older than the hub's current build). */
export const staleUi: Readonly<Ref<boolean>> = readonly(stale);

/** Mark the page stale (exported for tests and for loaders that catch their own failures). */
export function markStaleUi(): void {
  stale.value = true;
}

/** Install the window listener once, before mount. */
export function wireStaleUiCapture(win: Pick<Window, "addEventListener">): void {
  win.addEventListener("vite:preloadError", () => markStaleUi());
}
