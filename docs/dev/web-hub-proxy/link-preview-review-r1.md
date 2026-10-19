# link-preview-plan review r1 (gpt-6.1-sol, runs r_K1JA2V5Z → r_G8RDWCN2) — pass-with-changes: Blocker 0 / Major 2 / Minor 6

Scope per the plan's appended rulings (no upstream framing-header rewrite, no hostname recognition); old body text
for those is not an implementation basis and was not counted. Browser compatibility/security still needs the real
browser gate — nothing here was browser-verified.

1. **Major — normalization misses the inline-code branch** (plan:186–188,289–300; PathText.vue:110–113,203–210;
   hub/proxy/target.ts:145–149). `codeProxyHref` still returns `props.text` and the template hands it to `openProxy`.
   With wider `isProxyableHref`, inline code `127.0.0.1:3000/ui` becomes clickable but is rejected (scheme-less with
   a path), and `http://127.0.0.1/` is rejected (no explicit port). Fix: inline-code branch returns
   `normalizeProxyHref(props.text)`; preview, new-tab and the no-frame-cap legacy flow all consume the same normalized
   string. Tests for plain text, inline code and markdown anchors asserting the actual POST target.
2. **Major — default preview interaction quickly exhausts sessions** (plan:227–240,324–326; protocol/proxy.ts:172–177;
   hub/proxy/sessions.ts:224–243; hub/proxy/listener.ts:230–235). Every open / reload / new tab redeems a NEW session;
   the browser overwriting the gate cookie doesn't delete the old server record and removing the iframe doesn't revoke
   it. The 17th quick redeem on one instance before sweep/expiry returns `429 reason:sessions`, and reload/new-tab use
   the same path ⇒ no recovery. Instance reuse ≠ session reuse. Fix: define the session lifecycle for repeated opens
   (or a reachable quota-recovery action + copy); don't raise the cap or evict other live sessions to hide it. Tests:
   same target opened/closed >16 times, reload, new tab, coexisting live WS. If the cap stays, show the failure and the
   recovery steps honestly.
3. **Minor — port right-boundary conflicts with the existing corpus** (plan:183–185,214; tests/web-hub/ui/logic-proxy.test.ts:47–50).
   The new "no dot after the port" rule stops matching `http://127.0.0.1:3000.` which line 50 requires. Distinguish
   sentence punctuation from invalid endpoint suffixes: `:3000.` positive; `:80.5`, `:8080:80` negative; same for the
   new scheme-less forms (so F2 can't steal a port-less prefix after F1 fails).
4. **Minor — reusing `hostProxyable` breaks hub agreement** (plan:163,217–218; ui logic/proxy.js:67–72; hub/proxy/target.ts:157–159).
   The UI IPv6 regex accepts `fd12:1`, `fd12::1::2`; the hub rejects via `isIP(...) === 6`. Add deterministic invalid
   IPv6 corpus and a full IPv6 syntax check in the UI; keep the "every output href passes the real parseProxyTarget"
   test with those counter-examples fed explicitly.
5. **Minor — cross-package interface unfrozen / wrong interface cited** (plan:131–132,266,274–276; hub/http.ts:1049–1061,2785;
   hub/ports.ts:664–766; hub/hub.ts:1528–1533). `http.ts:1060`'s `proxy?` belongs to `LanRuntime`; `createHttpFrontend`
   takes `FrontendDeps` from ports.ts, not in LP0/LP1 file domains. Simplest: derive the CSP from the existing
   `deps.config.proxy?.portRange` (no new dep field); otherwise add `FrontendDeps` to LP0 and define the hand-off.
6. **Minor — proxy-generated error pages not fully wired** (plan:92–96,263–264,279–280; hub/proxy/listener.ts:81,174–186;
   hub/proxy/forward.ts:31–37,218–220). The forwarder uses a static `reply: sendProxyResponse` without gate/request;
   setting `frameAncestors` on access won't cover queue 503 / connect 502 / header-timeout 504. Define per-request reply
   binding or a policy param; unverified-Host rejections stay strict. Tests for valid-Host 403/429/502/503/504 and
   invalid-Host 421; keep upstream headers passed through untouched.
7. **Minor — no targeted browser negative matrix** (plan:279–284,302–312,348–351). Deterministic fixtures: proxy-generated
   pages frameable only by the hub/allowed self; other same-site services and other sites refused; upstream restrictions
   apply as-is; the hub is still unframeable; hub API probes from inside the iframe still rejected by existing gates;
   use a valid gate session (exclude "just logged out" false passes); record browser versions, IP/localhost/LAN access,
   minimum Safari; verify cookies, forms and WS with privacy protections on. Note `allow-popups-to-escape-sandbox`
   means popups leave the sandbox — never market this as a malicious-app sandbox.
8. **Minor — compatibility acceptance wording conflicts** (plan:21,226,299–300). D9 lets proxy-cap-only hubs use the new
   recognition, but "no frame cap ⇒ byte-identical DOM" forbids the new spans. Split: no proxy scope ⇒ identical DOM;
   proxy scope without frame cap ⇒ existing inputs unchanged (DOM + new-tab), new inputs may be recognized; frame cap ⇒
   dialog.

Also verified: target fence unchanged by normalizing to explicit `:80`; dns-gate rejects mixed/public answers; widening
`frame-src` doesn't widen who can frame the hub (`X-Frame-Options: DENY` / `frame-ancestors 'none'` stay); `/pv`
opaque-origin sandbox unaffected; `allow-scripts + allow-same-origin` on a different-port origin can't reach the parent
DOM; request/response cookie stripping stays; Origin/Fetch-Metadata/CSRF gates remain the defense for hub API; same-host
different-port is cross-origin but same-site (no CHIPS / SameSite=None needed; still needs real-browser evidence);
`http://*:<port>` is a host wildcard, not a private-network matcher — the server-side target fence is the guard; frame
cap is additive; `http.ts:1781`'s LAN port comes from `config.lan.port`, not a fresh bound-port return.
