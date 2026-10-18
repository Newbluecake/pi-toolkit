# F5 — transport-neutral managed-session creation

Status: implemented, not committed. Scope: plan §5.7, §14 F5, R1 #20.

## Files

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/spawn/entry.ts` — new exported entry and caller-owned idempotency store.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/spawn/routes.ts` — HTTP adapter for fresh creation; existing session/history and other endpoints retained.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/spawn/entry.test.ts` — direct non-HTTP entry tests.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/spawn/golden.config.ts` — unchanged existing suites with an additional observer.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/spawn/golden.setup.ts` — HTTP/audit capture and immutable-baseline comparison.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/spawn/golden.test.ts` — makes HTTP golden comparison part of the ordinary web-hub test gate.
- `/home/bluecake/ai/pi-toolkit/tests/fixtures/feishu-spawn-http-golden.json` — pre-extraction baseline.
- `/home/bluecake/ai/pi-toolkit/.prettierignore` — append-only exclusion for that JSON fixture.
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/F5-report.md` — this handoff.

No edits to hub/http/main assembly, agent files, supervisor/store/first-prompt implementations, F0 files, or existing tests. Other packages have concurrent changes in the checkout; they are not part of F5.

## API

```ts
startFresh(intent: FreshSpawnIntent, ctx: FreshSpawnContext): Promise<FreshSpawnOutcome>
createSpawnIdempotency(now: () => number): SpawnIdempotency
```

`FreshSpawnIntent` is a **validated**, non-session intent:

- `id`, `cwd`, `confirmed`, `expectCwd`, `model`, `firstPrompt`.
- `session` is prohibited by its type. Session-backed creation still uses the existing history branch.
- Model tri-state is preserved: absent → current hub preference; `""` → pi default; explicit `provider/id` → that model. Effective model is read **after** authorization recheck.
- First-prompt deliver mode is already normalized (`followUp` for the bot). Text goes only to the memory-only forwarder; the supervisor/audit receive UTF-8 length, never text.

`FreshSpawnContext` supplies:

| Member                                       | Contract                                                                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `principal`                                  | Exact caller-chosen dedup identity; bot: `feishu:<installGen>:<openId>`. No identity is inferred from origin.                                                                                        |
| `owner`, `origin`                            | Supervisor ownership and first-prompt/audit attribution, respectively; existing HTTP values remain unchanged.                                                                                        |
| `policy`                                     | Explicit `{scope: "known" \| "roots", confirm: "unknown-dir" \| "always"}`. The entry never calls LAN policy resolution.                                                                             |
| `rate`                                       | Explicit bucket/capacity/refill interval and synchronous rejection-audit callback. No HTTP bucket name or rate clamp is imposed on other callers.                                                    |
| `limit`, `idempotency`                       | Caller-lifecycle services; never construct these per request. HTTP shares one original-size LRU with its session branch.                                                                             |
| `dirs`, `supervisor`, `firstPrompt`, `prefs` | Narrow `Pick` ports, no hub assembly imports.                                                                                                                                                        |
| `deadline`, `now`, `registerTimeoutS`        | Existing 2 s directory-admit cap / 3 s reserve and first-prompt deadline arithmetic.                                                                                                                 |
| `reauthorize()`                              | Required live authorization recheck after asynchronous directory admission and confirmation. Failure returns its original code. `handled:true` means the adapter already sent/audited its rejection. |
| `audit(record)`                              | Caller-selected audit sink. HTTP still calls the unchanged whitelisting `auditSpawn`.                                                                                                                |
| `onResult(outcome)?`                         | Optional synchronous sink. HTTP uses this to send its reply inside the post-auth2 synchronous stretch, **not after awaiting the entry**.                                                             |

Outcomes:

- `kind:"accepted"`: `value` carries spawnId/state/cwd and the original optional model/firstPrompt/dup/session fields. Top-level `agentKey` and `sessionId` are supplied when already known from the record; they are **not added to HTTP bodies**. A new process normally starts without either coordinate.
- `kind:"confirm"`: canonical `resolvedCwd` plus `reason:"unknown-dir"|"always"|"changed"`. No LRU write or start; confirmation binds `expectCwd` to the realpath.
- `kind:"refused"`: unchanged `E_BAD_REQUEST`, `E_DIR`, `E_LIMIT`, `E_LAUNCHER`, `E_SPAWN_DENIED`, or `E_DEADLINE`, preserving reason/limit/count/retry details.
- `kind:"rate-limited"`: `E_RATE` and the unmodified retry delay in milliseconds.
- `kind:"unauthorized"`: authorization callback's exact code and optional `handled` flag.

The HTTP adapter retains CSRF/auth1/policy/body/schema gates and all response serialization, status selection, Retry-After/connection-close behavior and shared 429-audit throttling. It retains its rate clamp `[1,60]`, `${principal}:spawn` bucket, `ceil(60000/capacity)` refill, and the original session branch's gate order. `intentDigest`, `SpawnIntent`, and the idempotency constants remain available from `routes.ts` as re-exports.

The idempotency store retains 256 entries / 600,000 ms, strict `age > TTL` expiry, non-renewing reads, put-refresh insertion order, confirm/expectCwd exclusion from digest, no token spent on dup/conflict/deleted-record replay, and `spawn-gone` refusal instead of refork after deletion. Only accepted creation writes the LRU; confirm/refusal do not.

## Golden provenance and coverage

Capture happened **before any production-source edit**, against original `routes.ts` SHA-256:

```text
fb1356235573ce6531623e828c545e72f5600bcfb58fbe2e6ea3df3e739317a9
```

The capture command ran the original 192 tests unchanged (9 files), all passing. The fixture contains **177 observable scenarios, 402 HTTP replies, 305 audit lines**. Fifteen tests emit no captured response/audit. `F5_CAPTURE_GOLDEN=1` is refused unless the source still has the original hash; the fixture was not regenerated after extraction.

| Existing suite                           | Tests executed | Observable scenarios | Replies | Audit lines | Coverage                                                                                                                                                                             |
| ---------------------------------------- | -------------: | -------------------: | ------: | ----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `http/api-headless.test.ts`              |             60 |                   59 |     149 |         120 | CSRF/auth/policy, body caps, schema, confirm/changed, model tri-state/prefs, dup/conflict/TTL/eviction/deleted record, rates/Retry-After, limits/launcher, dirs/stop, prompt secrecy |
| `hub/hub-spawn.test.ts`                  |             15 |                    5 |       0 |           8 | Real hub assembly lifecycle/audit, first-prompt handoff, shutdown/reconciliation                                                                                                     |
| `http/lan-headless.test.ts`              |             14 |                   14 |      21 |          16 | Principal isolation, owner projection, scopes, trusted-proxy policy, LAN confirmation/lanConfirm                                                                                     |
| `http/headless-matrix.test.ts`           |             13 |                   13 |      38 |          10 | Off/on/denied/not-enabled and LAN-off route matrix                                                                                                                                   |
| `http/api-headless-history.test.ts`      |             30 |                   30 |      39 |          27 | History list, resume/fork, occupancy, snapshots, auth2, session-backed dedup and failures                                                                                            |
| `http/api-headless-relaunch.test.ts`     |             11 |                   11 |      27 |          26 | Restore gate, relaunch rate/idempotency, B-alive and missing/invalid session refusals                                                                                                |
| `http/api-headless-mkdir.test.ts`        |              8 |                    8 |      21 |          19 | Existing mkdir route/body/admission/error/rate behavior                                                                                                                              |
| `http/api-headless-privacy-fork.test.ts` |              5 |                    5 |       5 |           5 | Privacy inheritance before fork; no changed failure semantics                                                                                                                        |
| `integration/web-hub-headless.test.ts`   |             36 |                   32 |     102 |          74 | Real fresh-create responses across H1–H8 and restore/relaunch cases; existing lifecycle assertions also run unchanged                                                                |

Comparison preserves serialized body key order/bytes, status, **all response headers including Content-Length, Retry-After and Connection**, audit line serialization/order/count and repeated opaque-id identity. Only nondeterministic Date headers, opaque generated id values and six-character temporary-directory suffixes are normalized. Fixture JSON is excluded from Prettier.

Integration observation deliberately captures **POST `/api/headless`** responses, not timing-dependent GET polling/SSE snapshots, and captures spawn request/reject audit lines from the **in-process** real assembly. Subprocess hubs' audit modules are not mocked/intercepted. The existing integration assertions still verify subprocess lifecycle, disk state, owner secrecy, limits, restore/relaunch, EOF/reaper escalation and prompt secrecy. The HTTP suites provide golden coverage for every other route path, including relaunch and session-backed paths. This does not claim byte-stable random IDs, wall clocks, SSE scheduling or child-process state-transition timings.

`golden.test.ts` invokes the original HTTP/assembly suites under the observer, preserving independent Vitest file scopes; their source/assertions are unchanged. The full integration golden is run separately using the same config.

## Verification

Final checks:

| Command                                                                                                                   | Result                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `timeout 280 npm run typecheck`                                                                                           | Passed (all three TypeScript/Vue stages).                                                    |
| `timeout 280 npm run build`                                                                                               | Passed.                                                                                      |
| `timeout 900 npx vitest run tests/web-hub`                                                                                | Passed: 490 files, 10,496 tests passed, 3 skipped. Includes the 156-test HTTP golden replay. |
| `timeout 600 npx vitest run tests/integration/web-hub-headless.test.ts`                                                   | Passed: 36/36, real hub/fake-pi hard gates and restore/relaunch.                             |
| `timeout 600 npx vitest run --config tests/web-hub/hub/spawn/golden.config.ts tests/integration/web-hub-headless.test.ts` | Passed: 36/36 including frozen integration response/audit comparison.                        |
| `timeout 60 npx vitest run tests/web-hub/hub/spawn/entry.test.ts tests/web-hub/hub/spawn/source-scan.test.ts`             | Passed: 18 entry tests + 4 zero-`as` source-scan tests.                                      |

The first broad web-hub run overlapped another package's UI edits and failed its static-style source scan in `RunTranscript.vue`; F5 did not edit that file. Isolated rerun and the subsequent complete web-hub rerun passed after the owning package's change. No load flakes needed changes.

Formatting: `timeout 60 npx prettier --check` over all seven F5 TypeScript/Markdown source, test/config/setup and report files passed; `git diff --check` passed. Repository-wide `timeout 280 npm run format:check` was also run and reported only concurrently authored, out-of-domain F1 files `src/web-hub/hub/feishu/chunks.ts` and `frame.ts`. F5 did not edit those files; FA/main should rerun the repository-wide format gate after F1 finishes. The baseline fixture SHA-256 is `e94328646d6ea0cd8a666b2722872e90b07e9918eeab144fbae54cd642731fbb`.

## Handoff to F8 / FA

1. FA owns assembly. F5 exports only; no service, network listener, timer, cap or new hub wiring was added. Construct a bot-lifecycle idempotency store and pass the shared CmdLimit with a **bot-specific** bucket. HTTP's existing store/lifecycle remains intact; deliberate cross-transport store hoisting, if desired, belongs to FA.
2. Use exact entry principal `feishu:<installGen>:<openId>`, owner `{listener:"lan", user:principal, reqId}`, and synthetic origin `{listener:"lan", ip:"feishu", user:principal, reqId}`. The plan author confirmed this seam: existing supervisor limits derive collision-free **`lan:feishu:<installGen>:<openId>`**, while entry dedup/rate use exact **`feishu:<installGen>:<openId>`**. No supervisor/store change is necessary. A real LAN username cannot contain `:`. Persisted records retain that synthetic LAN attribution; web principals do not acquire their owner-only fields (loopback's existing privileged projection remains unchanged).
3. Pass `policy:{scope:feishuBot.spawnScope, confirm:"unknown-dir"}` directly. Do **not** call `supervisor.policy(...,"lan",...)` to determine bot admission: `spawn.lan`/lanConfirm/trusted-proxy rules are HTTP-specific. Deployment/allow-list/tenant/generation gates remain the bot caller's responsibility, including live checks in `reauthorize` immediately before the fork.
4. Validate raw bot input before constructing the intent (same existing spawn schema/byte caps and normalized `firstPrompt.deliver:"followUp"`). No session ref should reach this entry. Text is memory-only here; bot durable-request persistence is a separate F4/F8 concern.
5. On `confirm`, issue the requester's bound one-shot nonce/card and retry the **same intent id**, adding `confirmed:true, expectCwd:resolvedCwd`. A changed realpath returns `reason:"changed"`; do not silently accept it. Confirm attempts still consume creation tokens, as HTTP does.
6. On accepted creation, resolve `spawnId → agentKey → sessionId` from existing spawns/registry events, then bind. Immediate accepted does **not** promise a live process or known sessionId; launch failures still arrive in existing state events. Dup replay can return already-known coordinates without resending the first prompt.
7. Relaunch is deliberately **not reimplemented**: F8 uses existing `supervisor.relaunch(spawnId, deadline)` for terminal managed records with restore on; surface B-alive/missing-session refusals unchanged. Existing HTTP relaunch implementation, rate bucket and tests are unchanged and goldened.
8. Route-level audit remains unchanged, including its sanctioned resolved-cwd forensics field. F8 should choose its bot audit sink according to §4.2 (no message bodies/paths); it must not blindly reuse the HTTP route audit sink for bot-specific logging if that would violate that separate policy.

Remaining scope: F8 bot cards/binding/relaunch orchestration and FA wiring, intentionally not implemented in F5. No unresolved F5 blocker; no commit created.
