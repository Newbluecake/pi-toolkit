# #14 P3b activation wiring report

Updated 2026-11-05. Baseline packages supplied by the caller: P2c `e74467bd`, P3 service half `163cb4b6`, P4 UI `08a195ea`. P3b performed no git writes, stash, checkout or reset.

## Verdict

Implementation and directed self-verification pass. `wake_session` is connected in the activationOn main session; token/password manual activation and receipt query use the existing authenticated command path. No new HTTP endpoint, arbitrary empty wake, body resend, human grant, child tool, or scheduling feature was added.

## Wiring and authority

- `activate.ts` creates the activation port with the **same live origin/epoch object as the sender**, the bridge hubPort and current root causal level. The tool registers under activationOn, including wake-off so query survives. `activateEnabled` is frozen as activationOn AND wake.enabled; only that gate declares xs.activate.v1. Missing/off/old capabilities fail closed. `/fabric status` gains a small activation ready/off line under activationOn.
- `XS_ACTIVATION_TOOL_NAMES=["wake_session"]` is an independent opt-in collision set. `XS_MAIN_TOOL_NAMES` is unchanged. The activation owner excludes its own schema when scanning collisions.
- Both real HubTransport adapters serialize `fabric __xs {action,messageId,activationKey?}` through their existing `/api/cmd` command.v1 clients. Existing auth, X-PWH/CSRF, source stamping, command-id dedup and token/password auth-recovery behavior are reused; no endpoint/auth/CSP exception was introduced.
- The host bridge checks current session, fabric allow/confirm/deny policy, Feishu refusal, exact bounded JSON and required activate key before calling the optional host port. Browser text/source/level/status/eligibility fields are rejected. No model prompt or command-history key card is emitted. A confirm policy still requires the existing confirmed command flow; P3b does not bypass it or add a new confirmation dialog.
- Web omits `to`: the existing hub relation pins the ORIGINAL target, and the server repeats source/cap/key/current policy/eligibility/claim/quota checks. The model tool still requires the original target in its unchanged schema. The optional internal `to` field is omitted, not guessed or re-resolved; no wire schema/PROTO change is needed.
- Query goes only to receipt, including misses. It never activates or signs a human input. Activate thenables have a clamped bounded ceiling nested under the frame deadline; timeout, rejection or synchronous post-call throw is cached unknown/query-only, never retryable none. An exhausted pre-call deadline is a proven none. Existing resume/read behavior is unchanged.

## Narrow UI integration correction

Once the previously dormant surface became callable, the shipped P4 gates would have offered activate again after an unknown CONTROL result because the BODY still remained applied/delivered. P3b corrects this without claiming new remote/body evidence:

- Separate action-aware singleflights ensure a query never receives an activate result.
- The existing bounded seed store retains only server xsActivation outcomes and the host's xs:query-only error, scoped to current session and exact message/key. Client/network speculation is not written as a server attempt outcome.
- Unknown/accepted/already_active offer query only; authoritative quota retryAfterAt is displayed, never auto-executed. Body phase/revision/entry identity and the first wake-stop reason are preserved. Wrong session/key/message responses are ignored.
- These hints are non-persistent and **not authorization**. After refresh, the hub's original-key tombstone still prevents another effective wake/charge. No lifecycle/status/SSE event executes an action.
- Comments referring to the deleted status.xs.activate gate were removed. No such closed-schema field or invented producer was added.

## Inherited audit diff

The pending audit.ts union expansion is required: committed P3 router calls already audit receipt/activate. It was retained, its stale future-tense comment corrected, and tests added. Existing whitelist/key order is unchanged; message body, activationKey and controller token are dropped even when smuggled. No new audit fields or sink were added.

## Declared B trace / frozen artifacts

The authorized trace refresh adds exactly registerTool(wake_session) once in `max` and `thread-main`, with count +1 in each. Removing that one call reproduces the HEAD call arrays; phase2 and phase2Count are identical. Child/off/secure profiles are unchanged. Only tests/fixtures/governance/activate-trace.json changed. No A fixture, corpus, protocol pin or boundary allowlist was refreshed; no PROTO bump.

## Changed files (absolute)

```text
/home/bluecake/ai/pi-toolkit/src/fabric/xs/activate.ts
/home/bluecake/ai/pi-toolkit/src/fabric/xs/sender.ts
/home/bluecake/ai/pi-toolkit/src/fabric/xs/session-activation.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/builtin-bridge.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/command-policy.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/commands.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/xs.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/audit.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/messages.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/xs-web-command.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/composables/useControl.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/logic/xsRequestState.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/transport/password.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/transport/token.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/transport/types.ts
/home/bluecake/ai/pi-toolkit/tests/fabric/xs-sender.test.ts
/home/bluecake/ai/pi-toolkit/tests/fixtures/governance/activate-trace.json
/home/bluecake/ai/pi-toolkit/tests/integration/fabric-xs-activate-session.test.ts
/home/bluecake/ai/pi-toolkit/tests/integration/fabric-xs-activation.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/xs-activate-bridge.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/xs-web-command.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/audit.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/transport-contract.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/xs-request-list.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/xs-request-state.test.ts
/home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/README.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/README.md
/home/bluecake/ai/pi-toolkit/docs/dev/fabric-xs-activation/P3b-report.md
```

## Real validation output

### Directed regression

```sh
timeout 600 env PI_TOOLKIT_TEST_WORKERS=2 npx vitest run \
  tests/fabric tests/web-hub/hub/xs*.test.ts tests/web-hub/hub/audit.test.ts tests/web-hub/agent \
  tests/web-hub/ui/*xs*.test.ts tests/web-hub/ui/transport-contract.test.ts \
  tests/web-hub/ui/use-control.test.ts tests/web-hub/ui/resume-use-control.test.ts \
  tests/web-hub/ui/logic-client.test.ts tests/web-hub/ui/logic-client-password.test.ts \
  tests/web-hub/ui/source-scan.test.ts tests/web-hub/boundary.test.ts \
  tests/tools/wake-session-tool.test.ts tests/integration/fabric-xs-activate-session.test.ts \
  tests/integration/fabric-xs-human-default-wake.test.ts tests/integration/fabric-xs-human-child-runtime.test.ts \
  tests/integration/fabric-xs.test.ts tests/integration/fabric-xs-reply.test.ts \
  tests/integration/fabric-xs-mention.test.ts tests/integration/fabric-xs-inbox.test.ts \
  tests/integration/fabric-xs-activation.test.ts tests/integration/fabric-xs-lifecycle.test.ts \
  tests/integration/fabric-wiring.test.ts tests/integration/mention-autocomplete-wiring.test.ts \
  tests/integration/fabric-wake*.test.ts tests/integration/fabric-xs-channel-compat.test.ts \
  tests/integration/fabric-xs-reply-off-golden.test.ts tests/integration/fabric-xs-child-scope.test.ts \
  tests/integration/fabric-xs-off-golden.test.ts tests/integration/stack-teardown-matrix.test.ts \
  tests/secure/off-golden.test.ts tests/governance
```

Full rerun: **221 files / 4027 tests passed**, 294.19s, exit 0. `/tmp/p3b-regression-final.log`.

After the caller's final server-response-only UI clarification, the affected targeted set was rerun: **16 files / 557 tests passed**, 11.49s, exit 0. `/tmp/p3b-focused-final.log`. This includes UI xs/transport/control, command/bridge, real command→xs integration, source-scan, boundary and trace.

The integration exercises real command router + xs router/relation/quota + source/target bridges + actual xs stacks with controlled pi and HTTP-auth admission. Both token/password adapters issue actual command payloads. It proves receipt-only query, two concurrent new cmdIds causing one marker, wrong-key refusal, pair 2/hour quota and accurate retryAfterAt, three fresh test bodies never resent, and no source model input. It is not claimed as a real-browser/live-password-login/provider run.

### G10 / sysload Tier2 triage (caller-approved)

Initial broad run: 220 files / 4026 tests passed, one stack-teardown G10 assertion failed because a residual **unref'd sysload timer** (~4968ms) remained. The notifier retry itself was cancelled and sends stayed 1. `/tmp/p3b-regression.log`.

The standalone file first passed 28/28 (`/tmp/p3b-teardown-standalone.log`), and the complete rerun above was green. Per the caller's explicit instruction, three further independent file runs were performed, all exit 0 / **28 tests passed**:

- `/tmp/p3b-teardown-triage-1.log`: 18.58s.
- `/tmp/p3b-teardown-triage-2.log`: 18.32s.
- `/tmp/p3b-teardown-triage-3.log`: 18.37s.

Recorded as the authorized Tier2 flake, not skipped or hidden. No sysload file was edited.

### Build / static / formatting gates

- `timeout 180 npm run typecheck`: exit 0, both TS7 passes + vue-tsc. `/tmp/p3b-typecheck-final.log`.
- `timeout 180 npm run build`: exit 0; build:bundle ok, 4.63 MB, inputs=670. `/tmp/p3b-build-final.log`.
- `timeout 180 npm run build:web`: exit 0; 2947 modules, 28.58s. `/tmp/p3b-build-web-final.log`.
- `timeout 180 npm run check:web`: exit 0; 85 files, first-screen JS 383877B gz / 524288B, lazy JS 84338B / 131072B, mermaid JS 1421000B / 2097152B, CSS 38841B / 65536B, 57 packages. `/tmp/p3b-check-web-final.log`.
- B trace refresh: `timeout 120 env PI_TOOLKIT_TEST_WORKERS=2 PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance/activate-trace.test.ts`: 4 tests passed. `/tmp/p3b-trace-refresh.log`.
- Exact changed-file Prettier check and git diff --check: final exit 0. `/tmp/p3b-format-final.log`.
- Fixture diff: only declared B trace; A artifacts untouched. No corpus/pin refresh or dependencies/package scripts changed.

## Remaining boundaries

No unresolved P3b build/test failure. The G10 anomaly is retained as the caller-approved Tier2 flake with all three independent reruns green. The inherited untracked docs/dev/jev-reflex directory was untouched. No schedule/sysload/src/index.ts edits, release, commit or push were performed. Policy-confirm UI remains on the existing command-confirm contract, not a new P3b dialog. Local UI hints do not survive refresh or authorize anything; service-level original-key dedup remains the authority.
