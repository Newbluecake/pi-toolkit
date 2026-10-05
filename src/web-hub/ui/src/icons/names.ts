/**
 * Icon name union (vue-plan.md v2.1 §1.1, §5.2 — P0 frozen). Matches exactly
 * the 39 `<symbol id="i-<name>">` entries `IconSprite.vue` renders (copied
 * verbatim from `docs/dev/web-hub/ui-mockups/dashboard.html`'s sprite block).
 * `AppIcon.vue` accepts only these names — `vue-tsc` catches a typo'd icon
 * name at compile time.
 */
export type IconName =
  | "alert"
  | "arrow-down"
  | "arrow-up"
  | "ban"
  | "branch"
  | "check"
  | "chev-left"
  | "chev-right"
  | "chev-down"
  | "clock"
  | "copy"
  | "cpu"
  | "eye"
  | "file"
  | "folder"
  | "gear"
  | "hash"
  | "image"
  | "inbox"
  | "info"
  | "key"
  | "layers"
  | "loader"
  | "logo"
  | "logout"
  | "message"
  | "monitor"
  | "moon"
  | "paperclip"
  | "radio"
  | "refresh"
  | "search"
  | "sparkle"
  | "sun"
  | "swap"
  | "terminal"
  | "unlock"
  | "unplug"
  | "user"
  | "wrench"
  | "x";

export const ICON_NAMES: readonly IconName[] = [
  "alert",
  "arrow-down",
  "arrow-up",
  "ban",
  "branch",
  "check",
  "chev-left",
  "chev-right",
  "chev-down",
  "clock",
  "copy",
  "cpu",
  "eye",
  "file",
  "folder",
  "gear",
  "hash",
  "image",
  "inbox",
  "info",
  "key",
  "layers",
  "loader",
  "logo",
  "logout",
  "message",
  "monitor",
  "moon",
  "paperclip",
  "radio",
  "refresh",
  "search",
  "sparkle",
  "sun",
  "swap",
  "terminal",
  "unlock",
  "unplug",
  "user",
  "wrench",
  "x",
];
