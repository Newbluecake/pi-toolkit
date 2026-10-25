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
