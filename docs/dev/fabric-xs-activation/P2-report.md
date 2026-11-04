# #14 P2a / P2b implementation report

Updated 2026-11-05. P2a is committed as `a8d431c3` (including its declared trace refresh). This report describes the P2b delta against that baseline. P2b performed no git writes or fixture refreshes.

## Verdict and scope

**P2b is partial: main-session U5 default wake is operational and tested; real child/nested execution consumption remains blocked by a missing permitted dependency-injection window. Do not mark full U5 accepted.**

The router/host-context changes and directed regressions pass. No `src/runtime/**` production file was edited: the child portion was stopped at the file boundary rather than implemented via an unsafe global closure, metadata grant, or a new child membership/bridge.

Untouched forbidden files/subsystems: web-hub agent/index.ts, assembly-channels.ts, schedule, web UI, audit.ts, jev-reflex, A-tier fixtures. No change to hook/tool registration in P2b; no B-tier trace refresh is needed.

## P2b completed

### Authoritative target state capability

`hub/xs/router.ts` appends `target.xsState:true` only in a successful **resolve** when the hub activation service exists and both the requesting socket and the actual resolved target socket advertise `xs.state.v1`. It reads the registry's hello capabilities, never card/status data or caller fields. Missing hub service/source cap/target cap means the key is absent, not false. Send response shape and unrelated ops are not widened.

The existing P2a bridge consumes that field as `XsPortReply.targetState`; the existing sender combines it with the local/live-hub gate before reserving a precise invocation grant. This closes the target-cap proof gap for the main-session delegated send path.

Tests cover all eight hub/source/target combinations, byte-identical old/off resolve results, and a target reconnecting with legacy capabilities. The actual router, source bridge, sender and two actual xs stacks are used together in the integration test: an omitted-wake expectReply with a verified human grant starts one dispatch; the next call shares the consumed grant and delivers only. Explicit false preserves the grant. Missing caps or missing context proof fail closed. There is no body retry, quota change or extra activation.

### Actual pi context identity risk

The new real-pi conformance probe found that the current extension runner's public `emitContext` path uses `structuredClone(messages)`. The P2a `messages.includes` assumption therefore refused even an unmodified legitimate input on current pi. This was a real functional gap, not a hypothetical flake.

`human-grant.ts` now correlates a context copy only with a unique **already signed input's actual host-observed user-message snapshot**, including the host timestamp. The bounded snapshot digest is local evidence, not a grant/bearer/source claim, and never enters tools, wire, prompt, diagnostics or logs. It is not minted from body semantics, source strings, level0, expectReply or model metadata. No signed input/host message means no authority.

An unchanged pi structured clone is accepted. Changed timestamp/body/additional source field, duplicate context matches, missing timestamp on a copied object, or unsigned extension input fail closed. Ambiguous proof is discarded so removing a duplicate later cannot revive it. The object-identity path remains a conservative fallback for hosts/test doubles without a usable timestamp; copied timestamp-less objects are never authorized. Context scans are limited to the last 2000 messages; pending input/accepted record caps remain 64; snapshots above 65536 JSON characters are not fingerprinted.

Conformance uses a real AgentSession/DefaultResourceLoader and scripted provider. It proves normal public-API cloning, a successful exact host invocation, altered-copy refusal, exactly two provider calls, and absence of host/grant metadata in provider messages. The in-process router/stack/sender integration is complementary, not claimed as child runtime integration.

### mirrorRevision clarification (P2a minor)

There are two revision axes:

- `XsProgress.revision` is the receiver reporter's per-message evidence revision. Source-private wake overlays do **not** increment it or rewrite receiver evidence.
- The bridge's `mirrorRevision` is the local aggregate `xsRequests` projection revision. P2a intentionally increments it for adopted remote mirror writes and for a local sender-result wake overlay before publishing status.

Thus “does not bump receiver revisions” does **not** mean “does not increment mirrorRevision”. Local overlay publication can advance the aggregate status revision while keeping the original row evidence revision unchanged. No P2b mirror state-machine rewrite was made.

## Child/nested runtime blocker — not implemented

`PiSessionDriver` is constructed in **`src/stack.ts:1532`**, not in the allowed `src/runtime/**` files. Its existing constructor receives only rememberAgents and a model resolver; it has no main-session sender, origin/epoch, reply receivability, or current caller-level façade. The child itself intentionally has no main xs membership/bridge.

A runtime-only implementation would need either to invent a new child xs bridge/membership or to store the main sender/ctx closure in a process-global grant registry. Both would violate the existing authority/lifecycle and pure-data grant boundaries. Inferring authority from prompt/model meta/diagnostics is also forbidden. The proposed minimal explicit dependency window was reported; a `message_agent(to:"root")` request returned `message not authorized`, and the caller directed that additional out-of-domain work must be reported, not edited.

Needed follow-up window: the stack's `new PiSessionDriver(...)` construction must pass an optional, per-activation main-session **human-runtime façade** assembled by `fabric/xs/activate.ts` (through the existing xs input/dependency structure). Runtime can then consume the already verified real childRunId/parent InvocationRef edge, register exact child context/toolCallId/driver ownership, and call the shared main sender/reply port. It must retain current child/root causal limits, honor readonly/external/tool-scope exclusions, terminate child references on actual disposal/settlement, and keep normal child xs extensions inert. No metadata or turn-wide human bool can substitute for that port.

P2a's actual spawn-edge recording and exact host Agent-result linking remain available, but without the above dependency they do not make a child tool execution authorized. Pure nested ledger tests are not reported as real runtime consumption. P2b did not add a dormant or fake child-tool stub.

## P2a surface still available to P3

- Sender outcome: `track?: { messageId, activationKey? }`, `progress?`, `wake?`, `wakeDowngraded?`. Tracking can survive an unknown transport result after the hub relation was proven. Never derive the original key from q requestId, text, logs, wakeToken, runId or command id.
- Bridge: `stateCapable()` for local+live hub state, authoritative resolve `targetState`, `requestProgress()` for the local source projection. Internal `wakeView` and `sourceRid` never become model parameters.
- Mention cmd_result: `data.mention.action:"session"` with optional track/progress/wake metadata. Local consumed and remote queued/delivered/started remain separate axes.
- `xs.state.v1` is connected. `xs.activate.v1` and wake_session execution/registration remain P3. Registration requirements must be handed to the activate.ts owner; no competing writer is authorized.
- Remaining non-P2b gaps are unchanged: cap-gated tracked wire intent/receiver-side downgrade continuity, audit and web UI ownership, source-private overlay continuity across reload, and complete source-bearing direct-mention attribution. These are not claimed complete by this package.

## Changed P2b files (absolute)

```text
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/xs/router.ts
/home/bluecake/ai/pi-toolkit/src/fabric/xs/human-grant.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/xs-resolve-state.test.ts
/home/bluecake/ai/pi-toolkit/tests/fabric/xs-human-grant.test.ts
/home/bluecake/ai/pi-toolkit/tests/integration/fabric-xs-human-default-wake.test.ts
/home/bluecake/ai/pi-toolkit/tests/conformance/fabric-human-grant-context.test.ts
/home/bluecake/ai/pi-toolkit/docs/dev/fabric-xs-activation/P2-report.md
```

## Verification

New/focused tests: **4 files / 37 tests passed**. Log: `/tmp/pi-toolkit-p2b-new-tests.log`.

Directed regression (not full repository test):

```sh
timeout 480 env PI_TOOLKIT_TEST_WORKERS=2 npx vitest run \
  tests/fabric tests/runtime tests/web-hub/hub/xs*.test.ts tests/web-hub/agent \
  tests/conformance/fabric-human-grant-context.test.ts \
  tests/integration/fabric-xs-human-default-wake.test.ts \
  tests/integration/fabric-xs.test.ts tests/integration/fabric-xs-reply.test.ts \
  tests/integration/fabric-xs-mention.test.ts tests/integration/fabric-xs-inbox.test.ts \
  tests/integration/fabric-xs-activation.test.ts tests/integration/fabric-wiring.test.ts \
  tests/integration/mention-autocomplete-wiring.test.ts tests/integration/fabric-wake*.test.ts \
  tests/integration/fabric-xs-channel-compat.test.ts \
  tests/integration/fabric-xs-reply-off-golden.test.ts \
  tests/integration/fabric-xs-child-scope.test.ts tests/governance
```

Actual output: **222 files passed / 3547 tests passed**, 280.06s, exit 0. This includes the requested default-on regression subset, runtime tests, xs hub tests, and governance (including activate-trace without refreshing it). Log: `/tmp/pi-toolkit-p2b-regression.log`.

- `timeout 180 npm run typecheck`: latest exit 0, both TS7 passes and vue-tsc succeeded. Log: `/tmp/pi-toolkit-p2b-typecheck-final.log`.
- `timeout 180 npm run build`: latest exit 0, `build:bundle ok`, 4.59 MB, inputs=666. Log: `/tmp/pi-toolkit-p2b-build-final.log`.
- Final focused rerun: 4 files / 37 tests passed. Log: `/tmp/pi-toolkit-p2b-new-tests-final.log`.
- Exact changed-file Prettier write/check and `git diff --check`: exit 0. Worktree fixture diff: exit 0. Against origin/dev only the already committed B-tier governance/activate-trace.json differs; A-tier changes are empty. No full npm test, release, git write, or B-tier regeneration was run.
