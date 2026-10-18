/**
 * PWA install — pure, DOM-free decision half (2026-10-18 「安装为应用」 card).
 *
 * Everything here takes plain values (UA string, booleans, origin) and returns a state token;
 * the browser capture (`beforeinstallprompt` / `appinstalled` listeners) lives in
 * `composables/useInstallPrompt.ts`, and `shell/SettingsView.vue` maps the token to i18n prose.
 *
 * Platform detection is DELIBERATELY UA-sniffing (user rule: sniff only to pick WHICH text to
 * show, never to gate function) — every state renders something useful, and an unrecognized UA
 * falls through to the generic menu hint rather than hiding the entry. Ordering of
 * `deriveInstallState` is the contract the card renders:
 *
 *   1. `standalone`   — already running installed (`display-mode: standalone`, iOS
 *                       `navigator.standalone`, or the `appinstalled` event fired): show
 *                       「已安装」, no button, no steps.
 *   2. `prompt`       — a `beforeinstallprompt` event was captured: show the install button
 *                       (Chromium's in-flow install UI; iOS Safari never fires this event).
 *   3. iOS            — Safari installs via Share → Add to Home Screen on ANY scheme (no
 *                       secure-context requirement), so this outranks the insecure branch.
 *   4. insecure       — `window.isSecureContext === false`: Chromium hides the whole install
 *                       surface on plain HTTP; explain the chrome://flags origin whitelist
 *                       (with the exact current origin to copy) or the HTTPS reverse proxy.
 *   5. desktop-chromium — address-bar install icon / menu → Install.
 *   6. Android menu   — secure-context Android without a captured prompt (usually an
 *                       installability hiccup, not a hard block): ⋮ menu steps.
 *   7. generic        — everything else: look for install/add-to-home-screen in the menu.
 */

/** Coarse UA class — prose selection ONLY, never a functional gate (see header). */
export type InstallUaClass = "ios" | "android" | "desktop-chromium" | "other";

/** Which guidance prose the settings card renders when no direct prompt is available. */
export type InstallGuidance = "ios-safari" | "insecure-origin" | "desktop-chromium" | "android-menu" | "generic";

/** The card's whole render state; `guidance`/`origin` only exist on the `steps` shape. */
export type InstallState =
  | { readonly kind: "standalone" }
  | { readonly kind: "prompt" }
  | { readonly kind: "steps"; readonly guidance: InstallGuidance; readonly origin: string };

/** Structural inputs — the composable fills them from a real (or faked) `window`. */
export interface InstallEnv {
  readonly ua: string;
  /** `matchMedia("(display-mode: standalone)").matches` OR iOS `navigator.standalone`. */
  readonly standalone: boolean;
  /** A `beforeinstallprompt` event is currently captured (not yet consumed/installed). */
  readonly hasPrompt: boolean;
  readonly isSecureContext: boolean;
  readonly origin: string;
}

export function classifyUa(ua: string): InstallUaClass {
  const u = ua.toLowerCase();
  if (/ipad|iphone|ipod/.test(u)) return "ios";
  // iPadOS 13+ reports a desktop-mode "Macintosh" UA that still carries "Touch" (real desktop
  // Safari never does) — treat it as iOS so those users get the Share-sheet prose.
  if (/macintosh/.test(u) && /touch/.test(u)) return "ios";
  if (/android/.test(u)) return "android";
  // Chromium-family desktop (Chrome/Edge/OPR all carry "chrome/"; Firefox/Safari do not).
  if (!/mobi/.test(u) && /windows|macintosh|cros|linux/.test(u) && /chrome\//.test(u)) return "desktop-chromium";
  return "other";
}

export function deriveInstallState(env: InstallEnv): InstallState {
  if (env.standalone) return { kind: "standalone" };
  if (env.hasPrompt) return { kind: "prompt" };
  const ua = classifyUa(env.ua);
  if (ua === "ios") return { kind: "steps", guidance: "ios-safari", origin: env.origin };
  if (!env.isSecureContext) return { kind: "steps", guidance: "insecure-origin", origin: env.origin };
  if (ua === "desktop-chromium") return { kind: "steps", guidance: "desktop-chromium", origin: env.origin };
  if (ua === "android") return { kind: "steps", guidance: "android-menu", origin: env.origin };
  return { kind: "steps", guidance: "generic", origin: env.origin };
}
