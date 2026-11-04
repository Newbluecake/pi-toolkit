# #14 P2 — staged implementation / blocked acceptance

2026-11-05 00:04 Asia/Shanghai. No commit, stash, checkout, reset, fixture regeneration, or index.ts write.

## Status

**Partial implementation, not a completed U5 end-to-end package.** The permitted sender/activation/mention surfaces and two authorized bridge/stack consumption windows are implemented and the directed regressions are green. Additional frozen-owner windows are still required; the implementation deliberately falls back to agent deliver-only rather than inventing authorization or target capability. Full project typecheck now passes following the parallel schedule package's fix; P2 did not edit that package.

## Implemented

- `human-grant.ts`: host-only opaque refs, invocation registration, shared-call-tree CAS, pre-send commit, same-call/target none release, cap64/30min lazy expiry, pure process park, owner/session/run checks. Real user-message object must be observed in context before a call can resolve. Queued input does not upgrade old calls. Handled mentions discard unbound root proofs rather than exhausting the park or authorizing later same-text input.
- TUI/RPC input signing and policy-admitted web dispatch signing. Web proof cap64/5min, unique session/text/owner, once-only; Feishu/native automatic notifications do not sign. Raw model source/meta/grantId never enters the provenance port. Advisory failures never block the actual host send.
- Exact host toolCallId captured before execute; `message_session` receives only an injected InvocationRef. New/fork/switch revoke; new reload owner cannot take over an old invocation. One qualified omitted-wake expectReply defaults only after full state negotiation and successful grant reserve. Explicit true/false and replyTo win; causal/quota policy remains unchanged.
- Stack `onSpawnEdge` records only an actual admitted edge. The exact host Agent tool result then associates its captured parent call with the returned real childRunId. Pure nested shared-ref propagation is tested; see runtime blocker below.
- Bridge send tracks only live original send rids (cap256), not text/latest row. An initial or subsequent matching xs_state yields messageId/key/progress, including after transport timeout/link loss. Missing correlation/off/old cap never fabricates a track. A tracked off-after-send result is unknown, not provable none.
- Source-private wake marks do not bump receiver revisions. Sender/hub downgrades remain visible in tool JSON/hint, source status, and mention metadata. `woke` remains dispatch acceptance, never started evidence. No body retry/second wake is added.
- `activationEnabled` is wired: effective main agent advertises xs.state.v1 and writes HubConfig.crossSession.activation=true. xs.activate.v1 is intentionally not advertised. `/fabric status` reads receiver progress and the source mirror; B1 precedes context observation through the existing P1 observer port.
- Mention port subscription provides session/owner-unique onSessionRouted reporting through the existing shared dependency (no index change). Synchronous web route consumes its exact cmdId and projects track/progress/wake; local command progress and remote body progress remain independent. Existing onHandled(rawText) is still called once. Enhanced send throws conservatively produce unknown; legacy behavior remains unchanged.

## Frozen-owner blockers / missing behavior

1. **Hub target-capability proof**: current `src/web-hub/hub/xs/router.ts` resolve does not emit authoritative `target.xsState`. The bridge now consumes this optional open-target field only with local+live-hub state support, and sender additionally requires that proof. The real omitted-wake delegation path therefore currently defaults false even for new peers. Needed follow-up: router owner stamps `xsState:true` only for state-capable requester/hub/actual resolved target, omits it for legacy/off, and verifies byte-identical mixed-version resolve frames. No capability inference from a prior send, text, or cached latest status is permitted.
2. **Real child execution context**: only the authorized stack edge window was changed. Child-driver/runner tool/context/lifecycle hooks do not yet consume the shared ref. Pure nested ledger behavior is not proof of real nested runtime propagation. The runtime owner must register actual child-run InvocationRefs and terminate their live references, with exact parent-call provenance and no prompt/meta/diagnostic inheritance or added child xs tools. Early execution before the host Agent result is correlated currently fails closed.
3. **Tracked wire intent / audit / receiver UI**: sender wake intent is an internal bridge argument, not a new serialized field. Protocol/router owners must add the cap-gated requestedWake/senderDowngrade track fields for receiver-side reason continuity. audit.ts was explicitly forbidden and untouched; web UI remains P4's. This package does not claim the complete U3 receiver/audit/UI chain.
4. **Reload source-private marks**: source wake overlays are per bridge activation, not a durable authorization or receiver revision. P1/P3 integration must preserve source-private default facts when rebuilding a source mirror; this report does not claim cross-reload continuity of those overlays.
5. **Direct-mention origin attribution**: the existing mention sender still uses its explicit `wake:true`, `origin:"human"`, `levelOverride:0` convention. This package does not add an event/source-bearing route call through mention.ts; automatic extension-origin mention text therefore does not get a grant, but its old explicit mention wake convention is not reclassified here. A host-source-bearing mention invocation port is required to fully close arch §4.3.A, without trusting raw model options.

## P3 consumption / registration specification

- Sender outcome is `track?: { messageId: string; activationKey?: string }`, plus `progress?: XsProgress` and `wake?: XsWakeView`. Use that original hub xid/key, including an unknown send with a confirmed relation. Never derive them from q requestId, text, logs, wakeToken, runId or command id.
- New internal `XsHubPort` ports: `stateCapable?(): boolean` (local+live hub only), `requestProgress?(): readonly XsProgress[]`; resolve `XsPortReply.targetState?: true` is the authoritative target half. `XsPortReply.progress?` may accompany res/deadline/link_lost/off and is only populated by exact live-send rid correlation.
- `wakeView` on XsPortSendArgs is source-private and never serialized. `sourceRid` remains internal; no tool parameter exposes it. No track means no invented activation key; use the existing read-only receipt query if a real messageId is already known.
- Mention cmd_result remains `data.mention.action:"session"`, with optional `track`, `progress`, `wake`, `wakeDowngraded`, `woke`; the closed ctl states are not extended. The local ledger can be consumed while the remote body remains unknown/queued/none.
- `createMentionSessionPort` exposes cap-gated `enhanced`, `subscribeSessionRouted`/`reportSessionRouted`; commands subscribes through the existing shared dependency and disposes the subscription. Legacy/off output is unchanged.
- P3 owns wake-session-tool/session-activation/Controller/relay implementation. Deliver tool-construction dependencies and collision-name requirements back to P2 owner for `activate.ts` registration. Do not independently edit activate.ts/sender/mention/commands. xs.activate.v1 should only be declared after those execution/ack paths are installed and effective wake is on.
- No receipt/query path signs a grant, reserves a wake, sends a body, or auto-activates on a miss.

## Governance

P2 adds `input`, `message_start`, `tool_call`, `tool_result` hooks before the existing B1 registration in createXsActivation.registerTriggerGuard, only while effective. The existing context/agent_end hooks compose provenance. P5 must refresh the B-tier registration trace once; P2 did not touch `tests/fixtures/governance/activate-trace.json` (the existing worktree difference is schedule's).

Default-on alias-wiring regression originally compared a pre-activation tool description. Its expected tool factory now uses `activation:true` (no settings JSON was pinned off), while still asserting exact description/schema equality and absence of alias cap/config/frames. Frozen schemas and A-tier goldens were not changed.

## Verification

Latest directed command (not the full repository suite):

```sh
timeout 360 env PI_TOOLKIT_TEST_WORKERS=2 npx vitest run \
  tests/fabric tests/mention tests/web-hub/agent tests/tools/message-session-tool.test.ts \
  tests/integration/fabric-xs.test.ts tests/integration/fabric-xs-reply.test.ts \
  tests/integration/fabric-xs-mention.test.ts tests/integration/fabric-xs-inbox.test.ts \
  tests/integration/fabric-xs-activation.test.ts tests/integration/fabric-wiring.test.ts \
  tests/integration/mention-autocomplete-wiring.test.ts \
  tests/integration/fabric-wake.test.ts tests/integration/fabric-wake-level.test.ts \
  tests/integration/fabric-wake-quiet.test.ts tests/integration/fabric-wake-revive.test.ts \
  tests/integration/fabric-wake-subscribers.test.ts tests/integration/fabric-wake-off-golden.test.ts \
  tests/integration/fabric-xs-channel-compat.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts \
  tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-xs-alias-wiring.test.ts \
  tests/integration/fabric-xs-child-scope.test.ts
```

Actual output: **183 files passed, 2947 tests passed; 189.94s; exit 0**. Log: `/tmp/pi-toolkit-p2-regression-final.log`.

The new grant/CAS/source matrix and bridge/web-projection tests are behavior assertions, not no-throw stubs. They cover all grant×expect×wake combinations, parallel CAS, pre-none/post-unknown consumption, explicit false/replyTo, model spoofing, busy queued input, wrong owner/context, live caps, parallel same-body send-rid correlation, transport timeout with tracking, source-private receiver revision hygiene, once-only web proof, handled-input cleanup and metadata/hints. Positive target/nested tests use the injected authoritative port; they do not conceal the integration blockers above.

`timeout 120 npm run typecheck`: **latest rerun exit 0**, both TS7 checks and vue-tsc passed. Earlier runs exited 2 after both TS7 passes succeeded, due only to the parallel package:

```text
src/web-hub/ui/src/components/schedule/SchedulePanel.vue(339,27): TS2339 PanelRun.runId
src/web-hub/ui/src/components/schedule/SchedulePanel.vue(343,66): TS2339 PanelRun.runId
src/web-hub/ui/src/components/schedule/SchedulePanel.vue(344,37): TS2339 PanelRun.runId
```

Latest passing log: `/tmp/pi-toolkit-p2-typecheck-final.log`. Schedule UI is forbidden to this package and was not modified by P2; the parallel owner resolved the above failures before final delivery.

`timeout 180 npm run build`: **exit 0**; `build:bundle ok`, dist bundle 4.59 MB, inputs=666. Log: `/tmp/pi-toolkit-p2-build-final.log`.

Exact changed-file `npx prettier --write` and `npx prettier --check`: exit 0, all matched files use Prettier style. `git diff --check` for P2 paths: exit 0. Final fixture comparison against origin/dev: only the pre-existing schedule B-tier governance/activate-trace.json differs; A-tier changes are empty. No full npm test/build:web/check:web, release, or git write operation was run.
