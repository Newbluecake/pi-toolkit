/**
 * web-hub-preview-windows plan r2 §8.2 (W3): the injectable, reactive wrapper around the pure
 * `logic/htmlCapLedger.ts` simulation, plus the `PREVIEW_HTML_LEDGER` injection key.
 *
 * Wiring (the W3 half lives in PreviewHtml; the PROVIDE is one of the two lines W2 adds to
 * `PreviewHost.vue` — see the W3 report):
 *
 * - PreviewHost: `provide(PREVIEW_HTML_LEDGER, createPreviewHtmlLedger())` — ONE ledger for
 *   the whole tab (all windows share the login's 8 slots).
 * - PreviewHtml: `inject(PREVIEW_HTML_LEDGER, null)` — absent ⇒ byte-identical pre-W3
 *   behavior (no notice, no accounting).
 *
 * Reactivity: a single `version` ref bumps on every mutation and `isEvicted` reads it, so a
 * `computed`/template calling `isEvicted(token)` re-evaluates when a LATER mint evicts the
 * token it holds — without wrapping the pure class in reactive().
 */
import { ref, type InjectionKey } from "vue";
import { HtmlCapLedger } from "@logic/htmlCapLedger.js";

/** The face PreviewHtml consumes (and tests fake/inspect). */
export interface PreviewHtmlLedgerFace {
  /** Record a successful mint (the cap URL is the token — unique per mint). */
  minted(token: string, now?: number): void;
  /** Record the preview being torn down (the slot still occupies until the idle TTL). */
  unmounted(token: string, now?: number): void;
  /** Reactive: does `token` currently look FIFO-evicted? Reads the version ref on every call. */
  isEvicted(token: string): boolean;
  /** Live (occupying) entry count — diagnostics/tests. */
  liveCount(): number;
}

export function createPreviewHtmlLedger(): PreviewHtmlLedgerFace {
  const ledger = new HtmlCapLedger();
  const version = ref(0);
  return {
    minted(token: string, now?: number): void {
      ledger.minted(token, now ?? Date.now());
      version.value++;
    },
    unmounted(token: string, now?: number): void {
      ledger.unmounted(token, now ?? Date.now());
      version.value++;
    },
    isEvicted(token: string): boolean {
      void version.value; // dependency: later mints/unmounts re-run whoever reads this
      return ledger.evictedOf(token);
    },
    liveCount(): number {
      void version.value;
      return ledger.liveCount();
    },
  };
}

export const PREVIEW_HTML_LEDGER: InjectionKey<PreviewHtmlLedgerFace> = Symbol("web-hub-preview-html-ledger");
