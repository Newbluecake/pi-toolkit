<!--
  Inline SVG sprite (vue-plan.md v2.1 §1.1, §3.2, §5.2 — P0 frozen). 33 `<symbol>`s copied
  verbatim from `docs/dev/web-hub/ui-mockups/dashboard.html`'s sprite block — same source, same
  `viewBox`/path data, so `AppIcon.vue`'s `<use href="#i-<name>">` renders identically to the
  mockups (plus `monitor`/`moon`/`sun`, added in #26 W3 for the compact theme toggle, and
  `file`/`image`/`paperclip`, added by web-hub-upload U5 for the attachment tray/attach
  button). Rendered once by `App.vue`; every icon everywhere else is `<use>`, never a second
  copy of the paths. `names.ts`'s `ICON_NAMES` must stay in exact sync with the ids below
  (enforced by `tests/web-hub/ui/smoke.test.ts`).

  No `<style>` block (SFC style blocks are banned repo-wide — plan §2.2/§4.3): visibility is
  hidden via the `.sprite` class in `styles/shell.css` (P3). Until P3 lands the sprite renders
  visibly at the top of the placeholder `App.vue` — harmless during P0–P2 (the hub still serves
  the old frontend; this only ever appears under `dev:web`/`vitest`/`visual:web`).
-->
<template>
  <svg class="sprite" aria-hidden="true" focusable="false">
    <symbol id="i-alert" viewBox="0 0 24 24">
      <path d="M12 3.8 2.9 19.5h18.2L12 3.8z" />
      <path d="M12 10v4.2M12 17.1v.1" />
    </symbol>
    <symbol id="i-arrow-down" viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6" /></symbol>
    <symbol id="i-arrow-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" /></symbol>
    <symbol id="i-ban" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </symbol>
    <symbol id="i-branch" viewBox="0 0 24 24">
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="8.5" r="2" />
      <path d="M6.5 7.5v9M17.5 10.5a6 6 0 0 1-6 6h-3" />
    </symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></symbol>
    <symbol id="i-chev-left" viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6" /></symbol>
    <symbol id="i-chev-right" viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6" /></symbol>
    <symbol id="i-chev-down" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6" /></symbol>
    <symbol id="i-clock" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </symbol>
    <symbol id="i-copy" viewBox="0 0 24 24">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5.5 15V6a2 2 0 0 1 2-2H15" />
    </symbol>
    <symbol id="i-cpu" viewBox="0 0 24 24">
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5" />
    </symbol>
    <symbol id="i-eye" viewBox="0 0 24 24">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </symbol>
    <symbol id="i-file" viewBox="0 0 24 24">
      <path d="M6 3.5h7l5 5V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z" />
      <path d="M13 3.5V9h5.5" />
    </symbol>
    <symbol id="i-folder" viewBox="0 0 24 24">
      <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </symbol>
    <symbol id="i-hash" viewBox="0 0 24 24"><path d="M9.5 4 8 20M16 4l-1.5 16M4.5 9h15M4 15h15" /></symbol>
    <symbol id="i-image" viewBox="0 0 24 24">
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9.2" cy="10.2" r="1.6" />
      <path d="M4.5 17.5 10 12.5l3 3 3.3-3.3 3.2 3.1" />
    </symbol>
    <symbol id="i-inbox" viewBox="0 0 24 24">
      <path d="M3.5 13.5 6 5.5h12l2.5 8V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z" />
      <path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5" />
    </symbol>
    <symbol id="i-info" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.8v.1" />
    </symbol>
    <symbol id="i-key" viewBox="0 0 24 24">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.5-8.5M16 7l2.5 2.5" />
    </symbol>
    <symbol id="i-layers" viewBox="0 0 24 24">
      <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8zM3.5 12.5l8.5 4.5 8.5-4.5M3.5 16.5l8.5 4.5 8.5-4.5" />
    </symbol>
    <symbol id="i-loader" viewBox="0 0 24 24"><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" /></symbol>
    <symbol id="i-logo" viewBox="0 0 24 24"><path d="M5 8h14M9.5 8v10M15 8v8a2 2 0 0 0 2 2" /></symbol>
    <symbol id="i-logout" viewBox="0 0 24 24">
      <path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5M10 16l-4-4 4-4M6 12h9.5" />
    </symbol>
    <symbol id="i-message" viewBox="0 0 24 24"><path d="M4.5 5h15v10.5h-9l-4.5 3.5v-3.5H4.5z" /></symbol>
    <symbol id="i-monitor" viewBox="0 0 24 24">
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M8.5 20h7M12 16.5V20" />
    </symbol>
    <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></symbol>
    <symbol id="i-paperclip" viewBox="0 0 24 24">
      <path
        d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57a4 4 0 1 1 5.66 5.66l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
      />
    </symbol>
    <symbol id="i-radio" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="2" />
      <path d="M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
    </symbol>
    <symbol id="i-refresh" viewBox="0 0 24 24">
      <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4" />
    </symbol>
    <symbol id="i-search" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </symbol>
    <symbol id="i-sparkle" viewBox="0 0 24 24">
      <path
        d="M11 3.5l1.8 5.2 5.2 1.8-5.2 1.8L11 17.5l-1.8-5.2L4 10.5l5.2-1.8zM18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"
      />
    </symbol>
    <symbol id="i-sun" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"
      />
    </symbol>
    <symbol id="i-swap" viewBox="0 0 24 24">
      <path d="M5 8h13M15 4.5 18.5 8 15 11.5M19 16H6M9 12.5 5.5 16 9 19.5" />
    </symbol>
    <symbol id="i-terminal" viewBox="0 0 24 24">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7 9.5l3 2.5-3 2.5M13 15h4" />
    </symbol>
    <symbol id="i-unlock" viewBox="0 0 24 24">
      <rect x="4.5" y="11" width="15" height="10" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 7.7-1.5" />
    </symbol>
    <symbol id="i-unplug" viewBox="0 0 24 24">
      <path d="M9 3v4M15 3v4M7 7h10v3.5a5 5 0 0 1-10 0V7zM12 15.5V21M3.5 3.5l17 17" />
    </symbol>
    <symbol id="i-user" viewBox="0 0 24 24">
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </symbol>
    <symbol id="i-wrench" viewBox="0 0 24 24">
      <path
        d="M15 4.5a4.5 4.5 0 0 0-5.4 5.9L4.3 15.7a2 2 0 0 0 2.9 2.9l5.3-5.3a4.5 4.5 0 0 0 5.9-5.4l-2.6 2.6-2.4-.4-.4-2.4z"
      />
    </symbol>
    <symbol id="i-x" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></symbol>
  </svg>
</template>
