# P2 report (plan-lowrisk §2)

Base: 85cf78bb. Three commits, zero behaviour change.

- **D1** `src/core/redact.ts` (new, zero imports) holds the single `redactSecrets(message, readonly (string|undefined)[])`.
  Removed from `web-search/resilience.ts` and `cache-ttl/ping-client.ts`; importers updated
  (web-search/{resilience,providers}, quota/http, cache-ttl/{ping-client,pipeline-ping}, two test files). No re-exports.
  The hub-side and `web-hub/agent` redactors are different implementations and untouched.
- **D2** `ui/fleet-panel.ts` drops its local `TERMINAL`/`isTerminalStatus`; it and `archive/control.ts` import `core/status.js`.
  No narrowing problems at call sites.
- **D3** `deadlineRace` added to `web-hub/hub/req-deadline.ts` (hand-written timer + `then`, not `Promise.race`).
  `hub/http.ts`, `hub/run-routes.ts` and `hub/lifecycle.ts` `withDeadline` now forward to it with their original error shapes.
  `raceDeadline` is untouched. Tests added to `tests/web-hub/hub/req-deadline.test.ts`: microtask-interleaving equivalence against a
  baseline copy for resolve/reject/timeout (sequences recorded on the pre-change implementation), reason/mapReject shape,
  timer cleared and unref'd, and lifecycle's message/wrapping.

Verification: typecheck clean; vitest over the §2.5 directories: 384 files / 8860 tests green; `tests/fixtures` diff vs base empty.
Hub boundary: the only new hub imports are hub-internal (`./req-deadline.js`); `tests/web-hub/boundary.test.ts` green.
Not done (by plan): consult/tool.ts isTerminalStatus (#40), ask-user Clock.

## Follow-up: discriminating D3 interleaving test (acceptance minor)

**Behaviour-zero argument.** The three replaced helpers (`http.ts`, `run-routes.ts`, `lifecycle.ts` `withDeadline`) shared one body:
a `new Promise` whose timer calls `reject(mk())` directly and whose `p.then` clears the timer then settles. `deadlineRace` is that body
verbatim (same timer, same `unref`, same synchronous settle inside the `then` callbacks), so the outer promise settles in the same
microtask turn as before; the wrappers only differ in the error they build, which they still supply via `onTimeout`/`mapReject`.

**Test fix.** The old timeout case relied on a real 5 ms timer firing after both microtasks, so it could not tell a direct reject from a
`Promise.race` (one extra hop). `trace()` now uses fake timers and, inside microtask `q1`, fires the timer (`vi.advanceTimersByTime`)
and only then enqueues `q2`. Sequences measured on the baseline body (`baselineRace`, a verbatim copy of the pre-D3 implementation):
resolve `[q1,q2,resolved]`, reject `[q1,q2,rejected]`, timeout `[q1,rejected,q2]`. The test asserts both the baseline copy and
`deadlineRace` against these.

**Mutation check.** Temporarily replacing `deadlineRace` with a `Promise.race([p.then(...), timeoutPromise]).finally(clearTimeout)`
version made `microtask interleaving matches the baseline (timeout)` fail (`[q1,q2,rejected]` vs expected `[q1,rejected,q2]`);
the other 12 stayed green. The implementation was restored byte-for-byte (`git status` shows no change to `src/`).
