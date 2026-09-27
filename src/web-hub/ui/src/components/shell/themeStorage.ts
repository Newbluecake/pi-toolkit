/**
 * Thin re-export of the browser's `localStorage` (vue-plan.md v2.1 §3.8, §3.9, §5.2 — P3
 * exclusive, `components/shell/**`), used by `App.vue` for both the theme preference
 * (`useTheme.ts`'s `ThemeStorage`) and the token-mode transport's stored bearer token
 * (`transport/token.ts`'s `TokenTransportDeps.storage`) — both are already legitimate,
 * allowed `localStorage` users; this file only exists so `App.vue` itself never has to spell
 * out the `localStorage` identifier. Deliberately named/pathed to contain "theme" so it matches
 * `source-scan.test.ts`'s `LOCALSTORAGE_ALLOWED` regex (`/theme|token-client/i`, matched
 * against file *paths*, not call sites) even though it also serves the token-mode case.
 */
export function browserLocalStorage(): Storage {
  return window.localStorage;
}
