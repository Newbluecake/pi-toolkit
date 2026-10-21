/**
 * web-hub-preview-windows plan r2 §5.2 (W3): the ONE shared selector listing every
 * Teleport'd overlay root that participates in the "who is the TOPMOST overlay" decision
 * (teleported overlays append to `<body>` in mount order, so the last match in document
 * order is on top).
 *
 * Before W3 this selector was duplicated (with drift risk) in `DirPicker.vue`,
 * `SessionHistoryDialog.vue`, `PrivacyUnmarkDialog.vue` and `ProxyDialog.vue` (which appends
 * its own `.proxy-scrim`). Those four files now import this constant — a source assertion in
 * `tests/web-hub/ui/logic-overlay-roots.test.ts` pins that no other `const OVERLAY_ROOTS =`
 * definition exists under `src/web-hub/ui/src`.
 *
 * Semantics (plan §5.2): the DESKTOP modeless preview-window root
 * `.preview-overlay.is-windows.is-modeless` deliberately does NOT participate — it never
 * blocks any dialog's Escape/Tab. Modal dialogs keep their scims above it anyway (tier 50/70
 * vs the windows' tier 25), and a keydown targeted inside the windows is the windows'
 * business. Everything else that reuses the `.preview-overlay` BASE class stays matched:
 * `AttachmentImagePreview` (modal, z60) and the phone full-screen window stack (no
 * `is-modeless` below 768px) keep their original topmost semantics untouched.
 */
export const MODAL_OVERLAY_ROOTS = ".spawn-scrim, .picker-scrim, .preview-overlay:not(.is-modeless), .privacy-scrim";
