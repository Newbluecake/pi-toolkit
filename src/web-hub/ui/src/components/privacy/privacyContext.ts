/**
 * Privacy-lock inject channel (web-hub-privacy plan v2.1, package P2). `DashboardView.vue`
 * creates the one `usePrivacyLock` handle and provides it here; `AgentCard.vue` (lock badge /
 * 标记入口), `DetailHeader.vue` (标记 / 立即锁定 buttons) and `SettingsView.vue` (timeout card
 * gate) inject it. The frozen `contracts.ts` props of those components have no privacy field,
 * so inject is the only channel that doesn't touch the frozen surface — same discipline as
 * `HUB_CTX` (control-plan §7.4). Absent (standalone component mounts, tests without a
 * provider) ⇒ every privacy affordance renders nothing (byte-level zero trace).
 */
import type { InjectionKey } from "vue";
import type { UsePrivacyLockHandle } from "../../composables/usePrivacyLock.js";

export const PRIVACY_LOCK_CTX: InjectionKey<UsePrivacyLockHandle> = Symbol("web-hub-privacy-lock");
