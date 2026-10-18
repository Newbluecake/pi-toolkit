# F3 — long-connection connector

Status: implemented, uncommitted (2026-10-18). Factories only; no hub/HTTP/agent-server assembly or F8 service. Authoritative inputs: plan v2 + R2 (especially R2-d/R2-i), probe V1/V6/V7/V10/V11, F1/F2/F4/F6 interfaces, and the main session's stalled-close ruling during this package.

## Owned files (absolute paths)

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/connector.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fixtures/feishu/fake-ws-server.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/connector.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/F3-report.md`

No existing source/fixture/report or frozen assembly file changed. No dependency, commit, stash, checkout or reset. The pre-existing untracked `scripts/exp/keepalive-protocol-probe.mjs` is unrelated and untouched.

## F8 port / composition

```ts
const connector = createFeishuConnector({
  credentials: { appId, appSecret }, // fixed installation; never in snapshot/logs
  api, // Pick<FeishuApi, "bootstrap"> from F2
  state, // Pick<FeishuState, "connectorMayStart" | "commit" | "undecodable">
  handleEvent: (raw, { signal }) => inbound.handle(raw),
  onStatus: (snapshot) => {
    /* synchronous status ownership transfer */
  },
  onUndecodable: () => {
    /* synchronously take ownership of an owner-notice enqueue */
  },
});
connector.start();
// F4 onHealth({persistFailed:true/false}): connector.pause() / connector.resume()
await connector.stop(); // before F8 dispatch/outbox/flush shutdown stages
await connector.dispose(); // final; cannot restart
```

- `start()` is idempotent and inert before called. During a stop it queues one restart after handover; after dispose it is ignored. A later explicit `stop()` or `dispose()` cancels any queued restart. F8 first loads safe credentials/state and adopts the installation as described in F4. `connectorMayStart() === false` prevents bootstrap; F8 owns the more specific corrupt-state/unsafe-credentials status.
- `stop()` immediately stops admitting frames, cancels bootstrap/backoff, allows only **already-admitted** receipts to finish and ACK on their arrival socket for ≤1 s, then fences all ACKs and closes within ≤5 s. Repeated concurrent stops share the same promise. Callers may await stop before starting again, or call start during stop to queue one restart.
- `dispose()` immediately fences ACKs and aborts receive/bootstrap waits, then performs bounded close. It is final and idempotent, including mid-connect/backoff/receipt/close. Zombie close/error cleanup remains installed, but cannot restart disposed/stopped connectors.
- One factory owns one installation's entire connection lifecycle; F8 must never run two factories for the same app concurrently. Credentials are not a live mutable port: stop/dispose the old connector before replacement. Outstanding abandoned transports remain diagnostic-only; don't discard an old connector's zombie accounting to bypass the bounded handover policy.
- Optional seams: `clock: FeishuClock`, `monotonicNow`, `random`, `webSocket(url): FeishuSocket`. Default clock is F2's unref'd `systemFeishuClock`; fragments use `performance.now()` by default. The default client resolves **Node 22's global WebSocket at dial time**, sets `binaryType="arraybuffer"`, and sends F1 binary pbbp2 frames. No `ws` dependency or Undici internals.
- `snapshot()` returns defensive copies: status/reason/code, socket generation, reconnect count, clamped ClientConfig, paused flag, outstanding handlers/zombies, fixed-key counters, static last-close reason/code/time. No URL, body, credential, server close-reason string or arbitrary exception is exposed. F2 owns bootstrap error classification/redaction; numeric auth codes are retained.
- `onStatus` and `onUndecodable` are synchronous ownership transfers, not promises to await. F8 must track/queue their actual network work. The optional receive `signal` is advisory for F8 staging; existing F6 `inbound.handle(raw)` can be plugged in unchanged. On reset/replacement F8 must also deactivate/dispose its F6 factories to fence their deferred effects.

## Single connection and native close ruling

V7 proved un-ACKed events redeliver to a **new connection** (~19.7 s), while two open connections **split** events. The connector has one active receiver, one bootstrap at a time, and no normal old/new socket overlap: it does not even bootstrap the successor until the predecessor closes.

The main session explicitly ruled during F3 that native `WebSocket` has no public `terminate()` and the connector **must not permanently stop reconnecting at the first stalled close**. Implemented policy, also documented in the connector header:

1. Retire the old socket immediately: clear its handshake/ping/liveness/chunk state, remove its open handler, neutralize message handling to a fixed diagnostic counter. Late frames are **never decoded, dispatched or ACKed**. ACKs in flight cannot migrate to a successor.
2. Wait up to **5 s** for close. At the deadline, call an injected `terminate()` when available. Otherwise **abandon** the old native socket and resume normal reconnect/backoff. Only diagnostic message and terminal close/error handling remain; on terminal notification all handlers/references are removed.
3. Bound abandoned sockets to **2**. A third stalled closing socket remains the closing barrier: stop dialing and surface `degraded(close-timeout)` until a zombie actually closes/errors. Then move the stalled socket into the freed zombie slot and automatically resume backoff.
4. Consequently this later ruling supersedes R2-d's former physical cap of two: the bound is now **three outstanding transports** (two abandoned + one active/closing). There is still only one business receiver/ACK path. During exceptional handover Feishu may still consider an abandoned connection alive and send events there; those frames go un-ACKed and depend on V7 redelivery. No claim of zero physical overlap is made in that exceptional case.

The `close-timeout` reason is local to the exported connector view. F8 can pass it through the existing wire's open string-valued degraded reasons; F3 did not edit the frozen protocol union or any assembly file. Cross-machine/same-app hubs remain unsupported as documented in the plan; no lease/global app registry was added.

## ACK/durability and malformed policy

- F1 alone handles protobuf admission, bigint IDs, first-wins control type, last-wins event headers, ACK encoding and bounded fragment replacement/reassembly. Cache is per socket and cleared on retirement; UTF-8 decoding only occurs after complete assembly.
- Complete schema-2 JSON objects go to **F6**. ACK iff the returned result has `ack:true`; resolving a promise is not sufficient. F6 owns durable `received` payload, event/message dedup (72 h/cap), authorization and V10 source-time stale checks. There is no second dedup implementation in F3.
- Every ACK uses the **captured arrival connection object + active phase** and checks its OPEN state/backpressure immediately before send. Old-generation success/failure cannot ACK, pause or reconfigure a successor. A durable first receive lost before ACK is safely redelivered and deduped through F6's commit barrier; coalesced in-flight copies share that barrier.
- No NACK exists. Partial/refused chunks, nonbinary/malformed protobuf, oversize/header-limit frames, unknown control, and non-event data are never ACKed. **R2-i overrides the earlier table:** legacy `type=card` is ignored, not ACKed.
- Unsupported nonempty payload encoding, fatal UTF-8/JSON failure, or missing schema-2 envelope structure: `state.undecodable.record` → bounded `state.commit()` (≤1.5 s) → ACK 200 → `degraded(undecodable-events)` + optional owner-notice handoff. F6 retains its deeper recognized-event schema/identity rules and its own health hook; F8 must wire both health sources.
- Owner-notice rate reservation uses F4 `noticeDue/markNotice` **at the post-ACK ownership handoff**, not on a lost arrival socket. Thus a failed arrival's redelivery can still generate the notice. `markNotice` uses F4's normal group commit. F8 must make the notice a tracked durable outbox operation; this callback itself is not a durable outbound queue. A process crash between outbox handoff and notice-marker commit can repeat a notice, not repeat a prompt dispatch.
- A `persist-failed` refusal pauses further event handling until F4 calls `resume()`. Ping/liveness remain active. Capacity/authorization refusals do not masquerade as persistence failures or force a hot reconnect loop.

## Deadlines / limits / deviations

- Bootstrap ≤8 s (also passes the F2 timeout/signal), handshake ≤10 s, the first ping is sent immediately on open (SDK/probe-compatible), subsequent ping intervals are clamped through F2/protocol, and liveness is ≤30 s after a ping without any inbound frame. Pings more frequent than 30 s **cannot continually extend** an outstanding liveness deadline.
- Server pong JSON ClientConfig is validated, merged with the current config field-by-field, clamped and used to reschedule the next ping. Malformed config is ignored/counted; server ping is ignored. `ReconnectCount` is ignored. `ReconnectInterval` is retained/clamped for status, but the plan's explicit full-jitter exponential policy, not the SDK fixed interval, controls retry timing.
- Start bootstraps immediately. First retry waits full jitter over the latest nonce (default 30 s before any successful bootstrap); following failures use `min(60s, 2^n s)` full jitter, reset only after a socket was stable ≥60 s. Auth codes (including V11 `1000040345`, `10014`) retry no faster than 10 min; connection-limit code retries after 5 min. Refused destination/missing native WebSocket degrades without a retry loop.
- Receive handler ≤3 s, undecodable commit ≤1.5 s, stop drain ≤1 s, close handover ≤5 s. Every owned production timer uses the unref'd clock. Late promise results are consumed and cannot authorize an ACK; abandoned socket frames are diagnostic-only.
- Additional anti-starvation bound: at most 256 outstanding receive handlers / 8 MiB of assembled pending payloads (existing protocol caps reused). Reservations follow the **actual** handler promise lifetime, not the 3 s timeout wrapper. An abort-ignoring/hanging F8 staging handler cannot free its slot and accumulate unlimited background I/O. Capacity refusal means no ACK. F4 separately bounds its own physical writes.
- Accepted platform residual remains R2-d: the native WebSocket allocates the whole incoming message before F1's 1 MiB admission check. Native abandoned transports cannot be forcibly destroyed using the public API; their bounded references live until close/error. These are explicit constraints, not hidden dependencies.

## Tests / evidence

`connector.test.ts`: **77 behavior tests** after the r_6TVFBD44 follow-ups below, including:

- Real F2 endpoint/bootstrap and all error classes, nonce/exponential/cap/reset timing, repeated stop/start, missing platform WS, late bootstrap generation, handshake and dispose races.
- Ping/pong timeout, first-wins control, server ClientConfig/clamps/malformed input, backpressure and send failure.
- Deferred durable ACK with exact F1 bytes/bigint IDs/header echo, explicit ack:false/no NACK, arrival-socket loss, stale generation persistence failure.
- Real F6 + real fsync-backed state: durable receive/dedup, reconnect redelivery without a second command, coalesced receive-before-ACK loss window, V10 stale message handling. Tests await actual fsync/dispatch evidence rather than assuming a fixed number of microtasks.
- Out-of-order fragments split inside a UTF-8 code point, TTL and generation isolation, malformed table including header-count admission, durable undecodable and hourly notice, hung commit/handler deadlines, retained zombie-I/O capacity, graceful/immediate shutdown and unref'd real-clock timers.
- Normal single-socket invariant, 5 s abandon/new dial, no business effect/ACK from abandoned/late-open sockets, injected terminate, third-stall degraded gate, automatic recovery on zombie close/error and disposal.
- **Real Node 22 global WebSocket** against the fixture's independently implemented RFC6455 handshake/binary/close server; exact binary ACK and reconnect with observed peak one normally live peer. Test-only global constructor maps the allowed Feishu URL to a local socket; production allowlists are not widened.

The fixture exports `createFakeWebSockets` (deterministic injectable sockets/clock, delayed open/close stalls/errors/backpressure) and `createFakeWsServer` (real loopback RFC6455, delayed upgrade, binary/text sends, drops, close stalls, connection counts). No real Feishu credentials/network were used.

### Initial command output before review follow-ups (Node v22.22.1)

```text
$ timeout 280 npm run typecheck
> pi-toolkit@0.6.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
TYPECHECK_EXIT=0

$ timeout 280 npm run build
> pi-toolkit@0.6.0 build
> tsc -p tsconfig.build.json
BUILD_EXIT=0

$ timeout 600 npx vitest run tests/web-hub/hub/feishu
Test Files  17 passed (17)
     Tests  1021 passed (1021)
  Duration  5.11s
FEISHU_TEST_EXIT=0

$ timeout 120 npx vitest run tests/web-hub/boundary.test.ts
Test Files  1 passed (1)
     Tests  11 passed (11)
BOUNDARY_TEST_EXIT=0

$ timeout 60 npx prettier --check src/web-hub/hub/feishu/connector.ts tests/fixtures/feishu/fake-ws-server.ts tests/web-hub/hub/feishu/connector.test.ts docs/dev/feishu-bot/F3-report.md
Checking formatting...
All matched files use Prettier code style!
PRETTIER_EXIT=0

$ git diff --check
DIFF_CHECK_EXIT=0
```

The last Feishu/typecheck rerun includes another agent's concurrent additive `state.whenIdle()` work and three additional state tests (the earlier clean snapshot had 1,018 tests). Those state/API-upload/outbox-test changes were not made by F3. An earlier broad run exposed one F3 test race around a real dispatching fsync; it was fixed by waiting for behavioral evidence before asserting dispatch. No production/F6 code was changed to make that test pass. Full repository tests and real-tenant acceptance are downstream integration gates, not claimed by F3.

## Follow-ups after r_6TVFBD44

All six conditional-pass findings were addressed in the same four F3-owned files. No frozen source, dependency or assembly edits; no commit. The initial gate transcript above is retained as historical evidence; the final follow-up gate is below.

| Finding                                                     | Fix                                                                                                                                                                                                                                                                                       | Regression evidence                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — MAJOR: first ping delayed                               | Extracted a shared `ping()` operation. Open now sends one binary ping immediately, arms its 30 s liveness deadline, and schedules the next ping. Periodic pings still cannot postpone an outstanding liveness deadline.                                                                   | Updated the 10 s interval test to assert exact F1 ping bytes at open, fixture `sentAt === [NOW]`, next ping at `NOW + 10_000`, and reconnect at 30 s from open, not 40 s. Real native-WS test now independently observes ping before the data ACK. Existing no-ACK tests distinguish control pings from data responses, so no-NACK assertions remain behavioral.                                                                        |
| 2 — MAJOR: stale open status after remote close             | Retirement publishes `connecting` immediately after clearing the active receiver, before invoking close or the already-CLOSED fast path. It no longer depends on entering the next dial.                                                                                                  | New remote-close test uses readyState CLOSED and a full 60 s nonce backoff: status changes synchronously to connecting, stays there at 59,999 ms with one bootstrap, then becomes open only on the next connection.                                                                                                                                                                                                                     |
| 3 — MINOR: resume masks cooldown status                     | `resume()` changes connection status/schedules an immediate retry only when there is no active/closing socket, bootstrap operation or existing retry timer. Auth/limit codes and their real timer remain visible.                                                                         | Two new parameterized tests call resume repeatedly during auth_failed (600 s) and conn_limit (300 s), assert original status/code and one bootstrap through the last millisecond, then observe the scheduled retry and open state.                                                                                                                                                                                                      |
| 4 — MINOR: partial config resets other fields               | Pong config overlays the current normalized values (converted back to wire seconds) before the existing `clampClientConfig()` call. Malformed supplied fields are still rejected; omitted fields retain their current value.                                                              | Three parameterized tests patch each timer separately with an out-of-range value; supplied values clamp, both omitted non-default values survive. A subsequent PingInterval-only patch also preserves the earlier merged reconnect values.                                                                                                                                                                                              |
| 5 — MINOR: restart behind stalled close / start during stop | Starting with a retained stalled closing barrier now reports degraded(close-timeout), not stopped; its existing zombie cleanup still resumes automatically. Starts during stop coalesce into one queued restart in stop's finalizer. A later explicit stop or dispose cancels that queue. | New third-stall stop/start test asserts immediate degraded status, no extra dial while blocked, then automatic generation-4 recovery with physical peak three. New queued-start test calls start twice during a slow close, proves no early bootstrap and exactly one successor after confirmed close (peak one). A separate dispose test proves queued restart cancellation. Existing repeat stop/start/generation tests remain green. |
| 6 — NIT: inaccurate detached-handler wording                | Header now says open handler removed; diagnostic-only message and terminal close/error cleanup handlers are retained until `gone()`. No claim that all abandoned handlers are detached.                                                                                                   | Extended the abandon regression to assert zero open handlers but one message/error/close handler, no dispatch or ACK from a late abandoned frame, the diagnostic counter increment, and all handler sets empty after terminal close.                                                                                                                                                                                                    |

The fixture adds send-time observations only; it does not auto-pong or suppress the client behavior under test. Initial ping/liveness, real-Wire ACK and negative data-response assertions all exercise the real connector paths.

### Follow-up verification (Node v22.22.1)

```text
$ timeout 280 npm run typecheck
> pi-toolkit@0.6.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
TYPECHECK_EXIT=0

$ timeout 280 npm run build
> pi-toolkit@0.6.0 build
> tsc -p tsconfig.build.json
BUILD_EXIT=0

$ timeout 600 npx vitest run tests/web-hub/hub/feishu
Test Files  17 passed (17)
     Tests  1030 passed (1030)
  Duration  4.96s
FEISHU_TEST_EXIT=0

$ timeout 60 npx prettier --check src/web-hub/hub/feishu/connector.ts tests/web-hub/hub/feishu/connector.test.ts tests/fixtures/feishu/fake-ws-server.ts docs/dev/feishu-bot/F3-report.md
Checking formatting...
All matched files use Prettier code style!
PRETTIER_EXIT=0

$ git diff --check
DIFF_CHECK_EXIT=0
```

Remaining scope is unchanged: F8/FA assembly and real-tenant acceptance. The native-close bounded-abandon residual is unchanged; none of these follow-ups adds overlapping business receivers, migrates ACKs or bypasses the durable receive barrier.
