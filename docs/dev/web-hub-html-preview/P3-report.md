# web-hub HTML preview — P3 (integration) implementation report

Package P3 of `docs/dev/web-hub-html-preview/plan.md` (v2 + §R1/§R2). Prior packages: P0 1cebe4e,
P1a f02dc9e, P2 cd4fcab, P1b f1a4e43. `src/` untouched (another agent concurrently edits
`src/web-hub/hub/{auth,lan-auth,http}.ts` + `hub/auth-identity.ts`).

## Changed files (this package only — all NEW)

| File                                                                                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/web-hub-pv-starvation.test.ts`                                                                        | T-I1 wrapper: spawns `fixtures/pv-starvation-child.ts` under pi's bundled jiti with `UV_THREADPOOL_SIZE=4` (history-starvation pattern — verdict line on stdout, SIGKILL afterwards, hard fields re-asserted in the parent, child-never-exits guard)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tests/integration/fixtures/pv-starvation-child.ts`                                                                      | T-I1 child: a REAL `createHttpFrontend` (loopback + LAN) whose `createPreviewRoutes({ html })` carries two never-settling PV fs seams — a real FIFO whose `open` has `O_NONBLOCK` stripped (genuine threadpool zombie + PV slot) and a `closecall.js` handle whose `close` fires the real close but never settles (priority-lane slot zombie, no fd leak). Asserts `/pv` degrades to bounded 503s while `GET /api/preview`, upload begin→chunk→commit and LAN login (REAL async scrypt via `hub/kdf.ts`) stay within budget; phase 3 (2 further DIRECT pool wedges, 3/4 threads stuck) is record-only, mirroring `history-starvation-child.ts` §6.5                                                                                                      |
| `docs/dev/web-hub-html-preview/selfcheck/index.html` + `selfcheck.css` + `selfcheck.js` + `popup.html` + `sub/asset.txt` | the §9 gate page: pure static, loads its relative css/js/sub assets, runs 26 probes (G1–G13, F2/F3 positives, G9 via a popup that postMessages its own cookie/opener results back) and renders a PASS/FAIL table + `window.__pvSelfcheck` for the CDP driver. `top`/`parent`/top-nav probes handle the raw-top-level case (`top === self`: nothing above to hijack — recorded as the expected class, self-navigation skipped so the report survives)                                                                                                                                                                                                                                                                                                     |
| `docs/dev/web-hub-html-preview/selfcheck/chrome-gate.ts`                                                                 | the automated half of the gate (reproducible driver): throwaway hub in `/tmp` (loopback + LAN, real preview routes, real async-scrypt LAN login), three mints (pvw-loopback, pv-raw-loopback, pvw-lan), headless snap chromium (scratch user-data-dir under `$HOME` — snap AppArmor denies dot-dirs — deleted afterwards) driven over CDP flat sessions (OOPIF auto-attach; `Page.bringToFront` — a background tab is frozen in headless); asserts each context's report, the wrapper's sandbox attr === `PV_SANDBOX`, and the hub-side §9 facts (cmd router 0 calls, history service never reached, SSE subscribers unchanged, authed preview control 200). CDN failure is excluded from the verdict iff the driver's own fetch fails too (offline env) |
| `docs/dev/web-hub-html-preview/acceptance.md`                                                                            | the blocking real-browser gate: G1–G17 expected-result matrix per context (dialog iframe / `/pvw` tab / raw `/pv` / popup), the recorded automated run, and the manual steps still owed (desktop Chrome loopback+LAN incl. G14 Referer + G15 logout-revoke, Firefox, iOS Safari, HTTPS-reverse-proxy G16, functional spot-checks)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AGENTS.md`                                                                                                              | one web-hub paragraph for the HTML preview (after the chunked-preview paragraph): cap `preview.html.v1`, mint endpoint, `/pv`+`/pvw`, `PV_SANDBOX` tokens, TTL/limits/queue/2-slot IO, I1–I4, fd-anchored admission, D2 roots, revocation hooks, log redaction, accepted residual, design-doc + acceptance pointers                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Automated browser gate — results (recorded 2026-10-17, Chromium 154.0.8037.57 snap headless)

`node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs
docs/dev/web-hub-html-preview/selfcheck/chrome-gate.ts`:

- **pvw-loopback (D3 wrapper tab): PASS — 26/26 probes**; wrapper iframe sandbox attr exactly
  `allow-scripts allow-forms allow-popups | src=/pv/…`; tab URL unchanged after the G8 attempt.
- **pv-raw-loopback (G17 top-level): PASS — 26/26** (top/parent `=== self` recorded as the
  expected raw-document class; self-navigation skipped by design).
- **pvw-lan (LAN listener): 25/26** — all isolation probes (G1–G12, G4–G7) PASS; the single miss
  is the F2 positive `sub/asset.txt` cors fetch: `TypeError: Failed to fetch`. Adjudication
  evidence: hub-side curl of the same LAN URL with `Origin: null` answers
  `200 + ACAO: null + Vary: Origin + CORP: cross-origin` byte-identical to loopback
  (repro: `/tmp/pv-lan-repro.ts` run, recorded in acceptance.md), and the same probe PASSED on
  LAN in an earlier driver run — headless-snap-chromium intermittent, NOT a hub response
  difference. Flagged as the ONE thing the manual LAN step must re-check (real desktop Chrome);
  if it reproduces there it is a real bug.
- **hub-side: PASS** — `cmdRouterCalls: 0`, `historyServiceCalls: 0`, `sseSubscribersDelta: 0`,
  authed `/api/preview` control `200`.
- Headless popups are engine-blocked in some runs — the page records
  `popup-ok (popups blocked — nothing escaped)` (a safe outcome); the popup context is also
  covered manually.
- Environment notes: external network is intermittent on this machine (some runs: CDN loaded;
  others: unreachable from driver AND page ⇒ G13 excluded as env, recorded in `env.cdn`).
  Snap constraints found: chromium needs a VISIBLE scratch dir under `$HOME` (AppArmor denies
  dot-dirs); a background headless tab is frozen (needs `Page.bringToFront`); the sandboxed
  iframe is an OOPIF (needs CDP flat sessions).

## Verification (real output)

```
$ npm run format:check
All matched files use Prettier code style!

$ timeout 280 npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && \
  vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
(clean exit)

$ timeout 600 npx vitest run tests/integration/web-hub-pv-starvation.test.ts \
    tests/web-hub/http/api-preview-html.test.ts tests/web-hub/http/lan-preview-html.test.ts
 Test Files  3 passed (3)
      Tests  45 passed (45)
```

T-I1 child report (last standalone run, `UV_THREADPOOL_SIZE=4`):

```json
{
  "pvSanity": { "status": 200, "ms": 6 },
  "fifoWedge": { "status": 503, "ms": 2003 },
  "closeWedge": { "status": 200, "ms": 4 },
  "closeStarted": 1,
  "pvDegraded": { "status": 503, "ms": 4003 },
  "previewRead": { "status": 200, "ms": 5 },
  "uploadBegin": { "status": 200, "ms": 4 },
  "uploadChunk": { "status": 200, "ms": 5 },
  "uploadCommit": { "status": 200, "ms": 6 },
  "lanLogin": { "status": 200, "ms": 51 },
  "scryptWithPoolWedged": { "ms": 45 },
  "verdict": "pass"
}
```

(the 2003/4003 ms are exactly the 2 s per-op race and the 4 s admit deadline; scrypt 51 ms with
one thread wedged; the record-only phase-3 scrypt with 3/4 threads wedged: 45 ms.)

## Deviations / disclosures

1. The self-check page lives under `docs/dev/web-hub-html-preview/selfcheck/` per the P3 task
   brief (the plan's §9 named `tests/fixtures/pv-site/security-probe.html`; the pv-site fixture
   tree stays P1b's). The page's own directory passes admission cleanly (abs class, no denylist
   rule, non-root bound dir).
2. `chrome-gate.ts` lives with the selfcheck assets (my file domain) and is NOT part of any test
   suite — it is the reproducible record of how the automated gate ran; `tests/integration/**`
   is outside every tsconfig include, so it type-checks only at runtime (jiti), same as the
   history-starvation fixture precedent.
3. The driver's LAN pvw context is order-sensitive in headless (frozen background tabs) — the
   final order is loopback-pvw, lan-pvw, raw-pv with `Page.bringToFront` after each navigate.
4. Not run (P3's full gate per plan §6 also lists `test → build → build:web → check:web` on the
   whole repo): out of my time box and the tree is concurrently edited by another agent; the
   three commanded gates + format/typecheck above are green. The full four-gate release run
   remains for the release flow.
5. Raw `/pv` top-level nuance recorded in acceptance.md: `top === self`, so G8's assignment is
   skipped there by design (self-navigation gains no hub authority; it only destroys the probe
   page itself); G8 is asserted in the two embedded contexts and manually.

## Unfinished / explicitly out of scope

- The manual acceptance steps (real desktop Chrome + Firefox + iOS Safari + HTTPS-proxy G16 +
  G14/G15 + functional spot-checks) — user-run; `acceptance.md` §Manual steps.
- The pvw-lan `sub/asset.txt` intermittent — flagged for the manual LAN run (see above).
- Full-repo `npm test` / `build` / `build:web` / `check:web` — deferred to the release gate.
