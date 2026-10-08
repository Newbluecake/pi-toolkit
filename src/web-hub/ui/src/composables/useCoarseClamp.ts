/**
 * Coarse-pointer vertical clamp (2026-10 transcript scroll-freeze fix, part 2). Touch devices
 * get NO nested vertical scrolling inside the transcript: a capped inner scroller latches the
 * touch/wheel gesture (the browser keeps the gesture on the container it started in) and the
 * page appears frozen. So the three capped regions — `.thinking-text`, `.tool-section .pre`,
 * `.diff` (`styles/transcript.css`) — render on `(pointer: coarse)` height-clamped with
 * `overflow: hidden` + a bottom fade plus a Show-all toggle (`ClampToggle.vue`); "expanded"
 * just drops the cap (CSS `max-height: none`), under which the element grows to its content so
 * the base `overflow-y: auto` can never actually scroll vertically and the content flows with
 * the page. Desktop (fine pointer) keeps today's inner scrolling untouched — there the handle
 * is permanently inert (`dataCc` stays `undefined`, no toggle, no observers measuring).
 *
 * Measurement is deliberately cheap: `scrollHeight > clientHeight` on the target itself (under
 * `overflow: hidden` the scrollHeight still reports the full content height), re-run on mount,
 * when a ResizeObserver sees the target's box change (a `<details>` body gaining layout, the
 * clamp/expand class flip, uncapped growth), when the passed-in reactive sources change
 * (streaming text growth — a clamped element's box is pinned at the cap, so the observer alone
 * would miss it), and when the pointer class flips. The cap height in px is cached from any
 * capped measurement so an EXPANDED re-measure (no cap in effect, `clientHeight ===
 * scrollHeight`) still knows what it would collapse back to — valid because all three sites
 * use fixed-px caps. happy-dom does no layout (zero rects), so component tests stub
 * `scrollHeight`/`clientHeight` per element and drive re-measures through the sources.
 */
import { computed, onMounted, onScopeDispose, ref, watch, type WatchSource } from "vue";
import { useMedia } from "./useMedia.js";

export interface CoarseClampHandle {
  /** Bound as `:data-cc` on the target element. `undefined` on "flow" (fine pointer, or content
   *  fits under the cap) so the desktop DOM carries no attribute at all — byte-identical to
   *  pre-feature markup. */
  readonly dataCc: "clamped" | "expanded" | undefined;
  /** True only on a coarse pointer whose content actually overflows the cap — gates the toggle. */
  readonly toggleVisible: boolean;
  readonly expanded: boolean;
  toggle(): void;
}

/** Sub-pixel tolerance when comparing content height against the cap. */
const OVERFLOW_TOLERANCE_PX = 1;

export function useCoarseClamp(
  target: () => HTMLElement | null,
  sources: ReadonlyArray<WatchSource<unknown>> = [],
): CoarseClampHandle {
  const coarse = useMedia(window, "(pointer: coarse)").matches;
  const overflows = ref(false);
  const expanded = ref(false);
  /** Cap height in px, cached while the element is capped (see the header note). */
  let capPx: number | null = null;

  function measure(): void {
    const el = target();
    if (el === null || !coarse.value) return;
    const content = el.scrollHeight;
    if (expanded.value) {
      if (capPx !== null) overflows.value = content > capPx + OVERFLOW_TOLERANCE_PX;
      return;
    }
    const cap = el.clientHeight;
    if (content > cap + OVERFLOW_TOLERANCE_PX) {
      capPx = cap;
      overflows.value = true;
    } else {
      overflows.value = false;
    }
  }

  const dataCc = computed<"clamped" | "expanded" | undefined>(() => {
    if (!coarse.value || !overflows.value) return undefined;
    return expanded.value ? "expanded" : "clamped";
  });
  const toggleVisible = computed(() => coarse.value && overflows.value);

  let ro: ResizeObserver | null = null;
  let roTarget: HTMLElement | null = null;

  /** Point the observer at the current target (v-if'd sections come and go) and measure once. */
  function observe(el: HTMLElement | null): void {
    if (ro === null || el === roTarget) return;
    if (roTarget !== null) ro.unobserve(roTarget);
    roTarget = el;
    if (el !== null) {
      ro.observe(el);
      measure();
    }
  }

  onMounted(() => {
    if (typeof ResizeObserver !== "undefined") ro = new ResizeObserver(() => measure());
    observe(target());
    measure();
  });
  watch(target, (el) => observe(el), { flush: "post" });
  // Pointer-class flip: entering coarse measures immediately; leaving coarse drops all state so
  // the region renders exactly like a fine-pointer one.
  watch(coarse, (on) => {
    if (!on) {
      expanded.value = false;
      overflows.value = false;
      return;
    }
    measure();
  });
  if (sources.length > 0) watch(sources, () => measure(), { flush: "post" });
  watch(expanded, () => measure(), { flush: "post" });

  onScopeDispose(() => {
    ro?.disconnect();
    ro = null;
    roTarget = null;
  });

  return {
    get dataCc() {
      return dataCc.value;
    },
    get toggleVisible() {
      return toggleVisible.value;
    },
    get expanded() {
      return expanded.value;
    },
    toggle() {
      expanded.value = !expanded.value;
    },
  };
}
