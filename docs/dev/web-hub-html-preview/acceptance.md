# web-hub HTML preview — real-browser security gate (plan §9, P3)

Blocking gate for the HTML preview feature (`docs/dev/web-hub-html-preview/plan.md` v2 + §R1/§R2).
Every step below must hold before release. Record results in this file (or the release notes).

The gate page is `docs/dev/web-hub-html-preview/selfcheck/` — a pure-static self-check
(`index.html` + `selfcheck.css` + `selfcheck.js` + `sub/asset.txt` + `popup.html`) that, when
previewed through a minted capability, runs one probe per §9 row and prints a PASS/FAIL table
plus `window.__pvSelfcheck` (the JSON the automated driver reads).

## How to run it manually

1. Start a THROWAWAY hub in an isolated HOME (never the user's real hub/state/port):

   ```sh
   mkdir -p /tmp/pv-gate-home
   HOME=/tmp/pv-gate-home PI_CODING_AGENT_DIR=/tmp/pv-gate-home/.pi/agent pi --mode rpc &   # then connect the web UI, or:
   # simplest: node <pi's bundled jiti-cli.mjs> docs/dev/web-hub-html-preview/selfcheck/chrome-gate.ts
   ```

   `chrome-gate.ts` (the automated half, §"Automated run" below) does exactly this — scratch
   home in `/tmp`, own listeners, minted caps for the selfcheck dir, headless snap chromium
   driven over CDP — and cleans up after itself.

2. In the hub UI, open a preview of `<repo>/docs/dev/web-hub-html-preview/selfcheck/index.html`
   (or drive `/pvw/<cap>` / raw `/pv/<cap>/index.html` directly). The page settles in ~10 s.

## Expected-result table (G1–G17)

| G-row | probe (selfcheck page row)                                                    | dialog iframe + /pvw tab                                                                                              | raw /pv top-level (G17)                                                                | popup (G9)                         |
| ----- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| G1    | `document.cookie` / `localStorage` / `sessionStorage` / `indexedDB`           | THROWS SecurityError (PASS)                                                                                           | THROWS SecurityError (PASS)                                                            | THROWS (that IS the sandbox proof) |
| G2    | `serviceWorker.register`                                                      | rejects / throws (PASS)                                                                                               | rejects / throws (PASS)                                                                | —                                  |
| G3    | `BroadcastChannel("pwh-hub-probe")`                                           | constructed in its own opaque partition, no hub listener ever sees it (PASS; hub-side: SSE count unchanged)           | same                                                                                   | —                                  |
| G1    | `top.location` read / `parent.document` / `opener.document`                   | THROWS cross-origin (PASS); `/pvw` tab `opener === null`                                                              | `top`/`parent` ARE self — "top-is-self/parent-is-self" (PASS: nothing above to hijack) | `opener.document` THROWS           |
| G4    | `fetch('/api/history')` + `fetch('/api/events')`                              | unreadable: `TypeError` (no credential — I2, no ACAO — I3) (PASS)                                                     | same                                                                                   | —                                  |
| G4    | `EventSource('/api/events')`                                                  | errored, stream never opens (PASS)                                                                                    | same                                                                                   | —                                  |
| G5    | `X-PWH` fetch `/api/run/history`                                              | preflight `OPTIONS` 404 ⇒ `TypeError` (PASS)                                                                          | same                                                                                   | —                                  |
| G6    | no-cors `text/plain` POST `/api/cmd`; `<form>` POST into a hidden sink iframe | opaque / posted-intact; hub answers 401/403, cmd ledger UNCHANGED (PASS)                                              | same                                                                                   | —                                  |
| G7    | `<img src="/api/avatar">`                                                     | `onerror` — GET APIs never decode (PASS)                                                                              | same                                                                                   | —                                  |
| G8    | `top.location = 'https://example.com/pv-escape'`                              | THROWS or blocked; the tab URL stays `/pvw/<cap>` (PASS)                                                              | skipped by design (`top === self`; self-navigation harms only the sandboxed page)      | —                                  |
| G9    | popup (`window.open('popup.html')`)                                           | popup inherits the sandbox: its `document.cookie` THROWS, `opener.document` THROWS, results postMessage'd back (PASS) | same                                                                                   | (this IS the probe)                |
| G10   | `parent.postMessage`                                                          | sent, no echo — the wrapper has no listener, nothing granted (PASS)                                                   | n/a (no parent)                                                                        | —                                  |
| G11   | `../x`, `%2e%2e/x`, `sub/../../x`, absolute `/etc/passwd`                     | 400/403/404, body = plain error text, never file bytes (PASS)                                                         | same                                                                                   | —                                  |
| G12   | `.ssh/id_rsa`                                                                 | 403 denylist (PASS)                                                                                                   | same                                                                                   | —                                  |
| F2    | `sub/asset.txt` fetch, stylesheet applied                                     | 200 + exact bytes / computed style applied (PASS)                                                                     | same                                                                                   | —                                  |
| G13   | CDN script (`cdn.jsdelivr.net/npm/dayjs@1`)                                   | loads + executes (PASS; external network allowed)                                                                     | same                                                                                   | —                                  |
| G14   | outgoing `Referer` on the CDN request                                         | devtools Network: **no Referer header** (PASS — `Referrer-Policy: no-referrer` + iframe `referrerpolicy`)             | same                                                                                   | —                                  |
| G15   | logout in another tab ⇒ next `/pv` asset                                      | 404 (capability revoked) — see manual step below                                                                      | same                                                                                   | —                                  |
| G16   | 50-asset page over HTTP/2 proxy                                               | all 200, no 503 (see manual step below)                                                                               | —                                                                                      | —                                  |

Hub-side assertions (all listeners): the `/api/cmd` ledger unchanged, the history service
never reached by the page's `/api/*` attempts (401 before the service), the SSE subscriber
count unchanged, and an authed control `GET /api/preview` still 200 after the page ran.

## Automated run (headless snap chromium, CDP) — recorded 2026-10-17

`node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs
docs/dev/web-hub-html-preview/selfcheck/chrome-gate.ts` — Chromium 154.0.8037.57
(snap, `--headless=new`), scratch user-data-dir under `$HOME` (deleted afterwards), throwaway
hub in `/tmp` (loopback + LAN listeners, real `createPreviewRoutes({ html: {} })`, real
LAN login via async scrypt):

- **pvw-loopback (D3 wrapper tab): PASS** — all 26 probes; wrapper iframe sandbox attr is
  exactly `allow-scripts allow-forms allow-popups`, tab URL unchanged after the G8 attempt.
- **pv-raw-loopback (G17 top-level): PASS** — all 26 probes (top/parent are self: recorded as
  the expected `top-is-self` class, self-navigation skipped by design).
- **pvw-lan (LAN listener): 25/26** — every isolation probe (G1–G12, G4–G7) PASS; the single
  miss is the F2 positive `sub/asset.txt` cors fetch (`TypeError: Failed to fetch`).
  Evidence collected: hub-side curl of the SAME LAN URL with `Origin: null` answers
  `200 + Access-Control-Allow-Origin: null + CORP: cross-origin` byte-identical to loopback,
  and the same probe PASSED on LAN in an earlier driver run (offline-CDN environment), so this
  is a headless-snap-chromium intermittent, NOT a hub response difference. **Flagged for the
  manual LAN step below — if it reproduces in a real desktop Chrome on LAN, it is a real bug.**
- **hub-side: PASS** — `cmdRouterCalls 0`, `historyServiceCalls 0`, `sseSubscribersDelta 0`,
  authed `/api/preview` control 200.
- headless popups are engine-blocked in some runs — the page reports
  `popup-ok (popups blocked — nothing escaped)`, which is a safe outcome; the popup context is
  covered manually below.

## Manual steps still required (real browsers, real network)

### A. Desktop Chrome (loopback + LAN)

1. Real hub (`webHub.enabled`), UI open; preview the selfcheck `index.html` from the dialog
   (context a), via 「新标签页打开」 → `/pvw/<cap>` (context b), and by pasting the raw
   `/pv/<cap>/index.html` URL top-level (context c). Expect the table above per context.
2. **G14**: with the page open, devtools → Network → the dayjs request must show NO `Referer`.
3. **G15**: mint, load the page, then log out in another tab → reload an asset ⇒ 404.
4. **LAN password path**: log in over `http://<lan-host>:<port>`, repeat contexts a–c —
   especially the `sub/asset.txt` row (the automated headless run flagged it).

### B. Firefox (loopback + LAN)

Same steps as A. Firefox must show the same THROWS/unreadable classes (opaque origin).

### C. iOS Safari (LAN over Wi-Fi)

1. `http://<lan-host>:<port>` → password login → open a session → preview an HTML report
   (context a) and 「新标签页打开」 (context b).
2. Expect: same PASS/FAIL table; storage/IndexedDB throw; `/api` fetches fail; no top
   navigation; CDN loads (F3).

### D. LAN behind an HTTPS reverse proxy (`externalOrigins`) — also G16

1. Terminate HTTPS for the hub origin (`webHub.lan.trustProxyFrom` + `externalOrigins`).
2. Preview a 50-asset page (e.g. a coverage HTML report with many siblings) — all subresources
   200, no 503, dialog stays live; the selfcheck page PASS.
3. While G16 runs: an ordinary file preview, an upload POST and (another tab's) LAN login all
   respond normally (T-I1's live-system twin).

### E. Functional spot-checks

- vitest coverage HTML / plotly export / pytest-html report render correctly (inline scripts
  run — `'unsafe-inline' 'unsafe-eval'`).
- `~/x.html` (home root) ⇒ source view + prose note (D2 `dir-too-broad`).
- `webHub.preview: "loopback"` ⇒ LAN keeps source-only; loopback renders.
- idle 15 min ⇒ 「可能需刷新」 hint only, the running iframe keeps working until manual reload;
  hard 60 min ⇒ 「链接已过期」 banner + 「重新加载」 re-mints (never auto-unloads).
