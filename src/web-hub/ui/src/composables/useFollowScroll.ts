/**
 * Scroll-anchor bookkeeping for the transcript (vue-plan.md v2.1 §3.6, §5.2 — P1). Pure state
 * capture/compensation — no DOM watching, no `requestAnimationFrame` — so `Transcript.vue` (P4)
 * only has to call `snapshot()` before patching the DOM (e.g. a `flush:"pre"` watcher) and
 * `restore()` after (`flush:"post"` / `nextTick`), exactly mirroring the legacy vanilla-JS
 * `render()`'s `prevHeight`/`prevTop`/`nearBottom` dance: a prepended older page keeps the same
 * content anchored under the viewport (scroll position adjusted by the height delta); otherwise,
 * being near the bottom while "following" is on keeps the view pinned to the latest message.
 */
import { ref, type Ref } from "vue";

export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface FollowScrollSnapshot {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly nearBottom: boolean;
}

/** Distance-from-bottom (px) under which the view counts as "near bottom". Matches the legacy `64`. */
export const NEAR_BOTTOM_PX = 64;

export function captureScroll(box: ScrollBox, nearBottomPx: number = NEAR_BOTTOM_PX): FollowScrollSnapshot {
  return {
    scrollHeight: box.scrollHeight,
    scrollTop: box.scrollTop,
    nearBottom: box.scrollHeight - box.scrollTop - box.clientHeight < nearBottomPx,
  };
}

/** Apply the post-patch scroll compensation for a snapshot taken just before the DOM changed. */
export function applyScrollCompensation(
  box: ScrollBox,
  before: FollowScrollSnapshot,
  opts: { readonly following: boolean; readonly prepended: boolean },
): void {
  if (opts.prepended) {
    box.scrollTop = before.scrollTop + (box.scrollHeight - before.scrollHeight);
    return;
  }
  if (opts.following && before.nearBottom) box.scrollTop = box.scrollHeight;
}

export interface UseFollowScrollHandle {
  /** Whether new messages should auto-scroll the view to the bottom. */
  readonly following: Ref<boolean>;
  /** Capture the box's geometry immediately before the DOM is patched. `undefined` while no box is mounted. */
  snapshot(box: ScrollBox | null | undefined): FollowScrollSnapshot | undefined;
  /** Apply the compensation immediately after the DOM has been patched. */
  restore(box: ScrollBox | null | undefined, before: FollowScrollSnapshot | undefined, prepended: boolean): void;
}

export function useFollowScroll(initialFollowing: boolean = true): UseFollowScrollHandle {
  const following = ref(initialFollowing) as Ref<boolean>;
  return {
    following,
    snapshot: (box) => (box ? captureScroll(box) : undefined),
    restore: (box, before, prepended) => {
      if (box && before) applyScrollCompensation(box, before, { following: following.value, prepended });
    },
  };
}
