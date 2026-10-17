# web-hub-html-preview — P2 (frontend) implementation report

Package P2 of `docs/dev/web-hub-html-preview/plan.md` (v2 + §R1/§R2). Developed against the
P0 frozen surface (`protocol/preview-html.ts`, `PreviewTransport.htmlCap?`,
`PreviewHtmlCapOutcome`, `PreviewPathScope.html?`, `API.previewHtmlCap` — all untouched) and
fake transports; the hub side (P1a/P1b) is other agents' work in the same tree.

## Changed files (this package only)

| File                                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/logic/preview.js`                      | `isHtmlPath` (re-export of the protocol's `isHtmlEntryPath`); `previewScopeOf` adds `scope.html` iff caps carry `preview.html.v1`; `scopeKeyOf` appends `\|html` (only-when-present); PathScope typedef + header docs                                                                                                                                                                                                                                                                                                                                                                               |
| `src/web-hub/ui/src/logic/token-client.js`                 | NEW `htmlCapPost` — POST `/api/preview/html-cap?agentKey=&sessionId=`, body `{path}`, `X-PWH:1`, 8 s deadline (`PREVIEW_ADMIT_TOTAL_MS`), **no POST replay** (mint is not idempotent ⇒ deliberately NOT `withRelogin`); 200 body structurally validated (`/pv/`+`/pvw/` prefixes, finite TTLs) else `E_BAD_RESPONSE`; non-200 via shared `previewOutcomeFromResponse` (keeps `reason`/`retryAfterS`)                                                                                                                                                                                                |
| `src/web-hub/ui/src/logic/password-client.js`              | Same `htmlCapPost` (one-shot like the rest of this client; the password transport's fetch wrapper reports 401 via `isRestAuthEndpoint`'s `/api/preview` prefix)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/web-hub/ui/src/transport/token.ts`                    | `preview.htmlCap` thin cast wrapped in `withAuthNotice` (the single 401 observation point — no replay to fold in)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/web-hub/ui/src/transport/password.ts`                 | `preview.htmlCap` thin cast (401 reported by the fetch wrapper)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/web-hub/ui/src/components/preview/PreviewText.vue`    | `isHtml && scope.html && htmlCap` ⇒ render/source toggle (`.preview-toggle`, `preview.viewRendered/viewSource`, label `preview.htmlToggleLabel`), default rendered, per-open reset via Host `:key`; rendered = lazy `defineAsyncComponent(PreviewHtml)`; mint-error ⇒ source + one-line note (403 dir-too-broad/upload ⇒ prose; else `htmlMintFailed{code}`) + retry (429/5xx/net/deadline); source view unchanged; cap absent ⇒ zero DOM change                                                                                                                                                    |
| `src/web-hub/ui/src/components/preview/PreviewHtml.vue`    | **NEW** — `minting → ready \| error`; iframe `:sandbox="PV_SANDBOX"` (imported from `@protocol/preview-html.js`), `referrerpolicy="no-referrer"`, `credentialless`, `allow=""`, `:src` = minted cap URL, `:title`; 「新标签页打开」 = `<a :href="openUrl" target="_blank" rel="noopener noreferrer">`; §R1-8 TTL (idle ⇒ 「可能需刷新」 hint + reload, hard ⇒ 「链接已过期」 banner + reload, iframe src NEVER auto-changes — `:key` bump only on user re-mint); `@load` hides spinner, >10 s ⇒ 「仍在加载…」; standing sandbox note; no `window` message listener; timers/abort cleaned on unmount |
| `src/web-hub/ui/src/components/preview/PreviewHost.vue`    | `is-hold-tall` for html text phases (dir-phase mechanism; gated on `scope.html` + transport `htmlCap`, so absent cap ⇒ no class flip; only ever SET — reset on `closed` like the dir rule)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/web-hub/ui/src/i18n/en/preview.ts`, `…/zh/preview.ts` | `htmlToggleLabel`, `htmlOpenTab`, `htmlMaybeStale`, `htmlExpired`, `htmlReload`, `htmlLoadingSlow`, `htmlNote`, `htmlMintFailed{code}`, `htmlDenied.dirTooBroad`, `htmlDenied.upload` (en/zh parity + `{code}` placeholder parity)                                                                                                                                                                                                                                                                                                                                                                  |
| `src/web-hub/ui/src/styles/preview.css`                    | `.preview-html*` block: frame `clamp(320px,72vh,1400px)`, `<768px` ⇒ `calc(100dvh - var(--preview-header-h,96px))`, action bar / hint / banner / overlay spinner / note                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/web-hub/ui/preview-html.test.ts`                    | **NEW** — T-U1 (sandbox === `PV_SANDBOX` w/o `allow-same-origin`, referrerpolicy, src, credentialless/allow, anchor attrs, idle hint + hard banner with iframe src UNCHANGED until 重新加载, reload re-mints to a new URL, @load/10 s slow note, 403 ⇒ mint-error, 429 ⇒ retry, defensive E_UNSUPPORTED, no `message` listener) + T-U2 (cap ⇒ toggle + default rendered iframe; no cap ⇒ pre-feature DOM; transport-without-method degradation; 403 ⇒ source + prose note + toggle-back re-mint; 429 ⇒ note + retry; standing note)                                                                 |
| `tests/web-hub/ui/preview-text.test.ts`                    | `.html` without cap keeps the exact pre-change DOM (no toggle / no mint / one button)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/web-hub/ui/logic-preview.test.ts`                   | T-U3 scope half: `previewScopeOf` html only-add-when-present; `scopeKeyOf \|html`; `isHtmlPath` table (`.html`/`.htm` case-insensitive, `.xhtml` false)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/web-hub/ui/preview-host.test.ts`                    | holdTall matrix: cap present ⇒ tall from the first html text phase; cap absent (scope or transport) ⇒ no flip; non-html text never triggers (after a close/reset)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/web-hub/ui/transport-contract.test.ts`              | T-U3 transport half (shared `describe.each` both modes): wire (POST + `X-PWH:1` + verbatim `{path}` body), 200 rides as the ok half, malformed body ⇒ `E_BAD_RESPONSE`, 403 keeps `reason`, 429 folds `Retry-After`, 8 s deadline `E_DEADLINE` one attempt, pre-aborted signal ⇒ no fetch, **401 NEVER replayed** (exactly one fetch + exactly one `onConn("auth")`)                                                                                                                                                                                                                                |

Not touched: `src/web-hub/hub/**`, `src/web-hub/protocol/**`, `ui/src/types.ts`,
`ui/src/transport/types.ts`, `ui/src/logic/contract.js` (P0 frozen), `composables/usePreview.ts`
(out of P2's file domain — the html flag flows through the existing `previewScopeOf` call it
already makes).

## Deviations from the plan (all additive, none blocking)

1. **`htmlMintFailed{code}` i18n key added** — the plan's §5 i18n list has no generic
   mint-failure line, but its behavior row ("mint errors ⇒ fall back to source with a
   one-line reason" / the task brief) needs one for non-403 errors. zh/en parity maintained.
2. **`scopeKeyOf` appends `|html`** — not spelled out in §5, but it is the exact rule
   `|dir`/`|file` already follow (a cap change invalidates the scope / closes an open
   preview). Only-when-present ⇒ every existing key pin stays green.
3. **`htmlDenied.{dirTooBroad,upload}` as flat dotted keys** — the i18n namespaces are a
   frozen flat `Record<string, string>` (`i18n/index.ts`), so the plan's nested notation is
   realized as `"htmlDenied.dirTooBroad"` / `"htmlDenied.upload"` literal keys.
4. **PreviewHtml emits `mint-error` and keeps an internal error view** — the plan assigns the
   source-switch to the parent (PreviewText does it); the internal view is the defensive
   standalone fallback (pinned by the component-level tests) for when it stays mounted.
5. **holdTall for html only ever SETS** (resets on `closed`), inheriting the dir rule verbatim
   rather than inventing a html-specific reset — the dir test suite pins that semantic.

## Verification (real output)

```
$ npx prettier --write <all 16 changed files>
all files unchanged after write (2 files reformatted on first pass, stable on re-run)

$ timeout 280 npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && \
  vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
(clean exit; no errors — an earlier transient error in shell/VersionPanel.vue, another
package's in-flight file, was gone by the final run)

$ timeout 600 npx vitest run tests/web-hub/ui
 Test Files  181 passed (181)
      Tests  4297 passed (4297)

$ timeout 300 npm run build:web && timeout 120 npm run check:web
✓ built in 5.20s
✓ check:web — dist/web-hub-ui/ OK (16 files, first-screen JS 270269B gz/524288B,
  lazy JS 41619B gz/131072B, CSS 29246B gz/65536B)
```

Budget notes: `PreviewHtml-*.js` lazy chunk = **3.88 kB** (plan estimated ≈3 KiB); lazy JS
**total** 41,619 B gz of the 128 KiB budget (plan predicted ≈40 KiB from the 36,727 B
baseline) — the "lazy budget is ONE total" rule (§R1 note) is respected.

New-test contribution: 15 (preview-html) + 1 (preview-text) + 3 (logic-preview) + 3
(preview-host) + 9×2 (transport-contract, shared both modes) = 32 new tests.

## Unfinished / out of scope (explicit)

- **P3** (`tests/integration/web-hub-pv-starvation.test.ts`, `acceptance.md` + the real-browser
  G1–G17 gate, AGENTS.md web-hub paragraph, full 4-gate release run) — main-session package,
  needs P1b + a real hub.
- **P1a/P1b hub side** — other agents' files are visible mid-edit in the tree
  (`hub/preview/{pv-*,html-cap}.ts` etc.); P2 was developed against fakes per the plan.
- **`docs/dev/web-hub-html-preview/P1a-report.md` fails `prettier --check`** — P1a's file, out
  of P2's exclusive domain; left untouched (noted for whoever owns it).
- The real-hub mint TTL (`hardRemainingMs` measured at send, consumed at response arrival)
  is approximate by design (「可能需刷新」 is a hint, never a claim) — §R1-8's accepted
  semantics; nothing further pending.
