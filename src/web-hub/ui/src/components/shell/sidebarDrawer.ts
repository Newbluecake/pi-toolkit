/**
 * Mid-breakpoint sidebar drawer injection key (mobile-adaptation package, todo #7;
 * `components/shell/**` exclusive). At 481–1024px the agent sidebar is no longer a fixed
 * split column (that now starts at 1025px, see `styles/shell.css`'s header comment): the
 * detail pane is full-width single-view navigation, and the sidebar opens as an overlay
 * drawer on top of it (scrim click / Escape / picking an agent all close it — the same
 * overlay grammar docs/dev/web-hub-fleet-drawer/plan.md froze for its own 768–1279 drawer).
 *
 * Why inject and not a prop: `contracts.ts` is P0-frozen (`DetailHeaderProps` has only
 * `agent`/`narrow`, `DetailHeaderEmits` only `back`), and `App.vue` is an in-flight file
 * owned by another package — so `DashboardView.vue` (the drawer's owner) provides this
 * context and `DetailHeader.vue` consumes it, exactly the SP12 `HUB_CTX` precedent for
 * adding header affordances without touching the frozen surface.
 */
import type { ComputedRef, InjectionKey } from "vue";

export interface SidebarDrawerCtx {
  /** True while the drawer is available: 481–1024px viewport AND a detail route showing. */
  readonly active: ComputedRef<boolean>;
  /** Opens the drawer (no-op while `active` is false). */
  readonly open: () => void;
}

export const SIDEBAR_DRAWER: InjectionKey<SidebarDrawerCtx> = Symbol("web-hub-sidebar-drawer");
