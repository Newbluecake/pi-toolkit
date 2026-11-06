# #47 current-turn hold stop — final implementation notes

Status: source candidate frozen for root's delta verification. User approval, second-round GLM
PASS 7/7 and root's implementation authorization are complete. README #47 is merged after
root released the #51 README/build ownership; existing #40/#41/#46/#48/#51 sections are retained.

## Runtime invariants

- `Composer.onStopInline` is the only dispatch owner. It checks busy, permissions, connected
  hub, nonempty agent/session/epoch scope and same-scope singleflight before the unchanged abort
  API. The already-published hub snapshot is read directly, avoiding parent-props render batching.
  Missing required host scope/connection fails closed; `view.sending` is not abort pending.
- Composer provides the feature-local typed `HOLD_STOP_HOST` read-only `abortPending`. Its lock
  survives Ring/Fallback remounts. A scope change permits a new intent, while an old Promise
  finalizer cannot clear a newer scope/token's lock. No frozen contract or wire changes.
- `useHoldStop` has one 700ms deadline and pointerId/generation/fired latch. Second fingers are
  ignored. Short pointer clicks never arm. Touch contextmenu only prevents default; mouse/pen
  contextmenu cancels. Current-pointer cancel/move beyond8px/out/scroll/blur/hidden/unmount and
  observed busy/permission/connection/scope changes cancel without resuming old progress.
- Enter/Space keyup and independent semantic detail-zero click open explicit confirmation;
  pointer-derived clicks are swallowed. Repeat/IME/modifiers cannot confirm. `StopConfirm`
  initially focuses Cancel after insertion, supports native Tab/buttons/Esc and safely restores
  focus. A separate focus-visible no-hold button remains available to AT.
- Short taps show a neutral hold hint, not “Stop cancelled”. Actual cancellation says
  “Hold cancelled — not stopped” / “长按已取消，未停止”. The local feedback timer clears after
  1500ms; blur/scope/unmount clear it immediately. This is not an armed second-click window.
- Usage remains separate from CSS-only hold progress; reduced motion uses a static dashed cue.
  The displayed queue warning says queued messages will still be sent. Abort does not clear queue
  or invoke managed-session/subagent stop. `useArmedConfirm` keeps its logic/signature; header only.

## Accepted observability boundary

Root explicitly accepted native EventSource frames arriving as separate browser tasks: an
already-published scope/connection/permission A→B→A must cancel, even if the parent has not yet
rendered intermediate props. Existing `useHub`/`renderGate`/transport/contracts remain frozen.
An artificial synchronous series of events coalesced before the existing render gate publishes
any intermediate state is not observable to this consumer and is not claimed to be detected.
This boundary is not a new production setting or transport hook.

## Actual verification

- `PI_TOOLKIT_TEST_WORKERS=2` targeted hold-stop/stop-button/context-ring/composer/use-control:
  **5 files / 145 tests passed**, including **38** new gesture/host/feedback cases.
- `npm run typecheck`: passed, including vue-tsc. Exact owned-path Prettier and whitespace/conflict
  checks are final gates; no full UI directory, tier1 or secure run was started by this package.
- Real compiled App + `createDevHub`, cached Chromium153.0.8010.12:
  `/tmp/pi-previews/hold-stop/implemented-compiled-results.json` has **150 passing checks**:
  **128 geometry cases + 22 interaction/result checks**, no console/page errors.
- Geometry spans zh/en × dark/light × 390/767/768/1025 × scale1/3 × text empty/typed × chips
  present/absent. Computed textarea font is actually16px/48px. Button rects and their viewport
  intersections are fully visible, width44px, height44–212px; none is partially offscreen.
  Every case includes an explicit effective44×44 box, **1936/1936** pixel-address hit checks,
  four edges/corners and neighbour bounds. No rounded corner or offscreen point is silently
  excluded. A212px-high target is reported as212px visible, not reduced to a claimed43px box.
- CSSOM-only restoration of legacy32px target layout proves zero displacement of the visible
  ring,32px slot, attachment target and send target in every geometry case. The graphic anchors
  to the old slot while only the transparent rectangular hit area expands; no other button moves.
- Interaction checks use real CDP touch/mouse/key actions plus explicitly labelled event/state
  injection. They cover touch +500ms contextmenu continuing to700ms once, short tap/double click,
  semantic/derived click, repeat/IME/Tab/Esc/focus, observable ABA, pending HTTP and old finalizer,
  queue warning and retention, reduced motion and simulated soft-keyboard viewport/focus stability.
- Exactly **5 fake abort HTTP requests**, unique IDs, target `hold-chips`; expect.sessionId is
  `hold-session-chips` or the deliberately switched `hold-session-B` as appropriate. Three
  responses are held/released in controlled order to prove same-scope singleflight and old ACK
  isolation. No real hub, model, user session or ctx.abort is involved.
- The queue is genuinely seeded via a status frame, not inferred from initial card metadata.
  Both holding and confirmation assert **“1 queued message(s) will still be sent”**; after abort,
  the synthetic queue row is still displayed. These assertions remain in the browser script.
- Since most interactive frame tests use the real client's public EventSource listeners with
  separate-task injection, one additional **actual loopback-network SSE** check was performed:
  `/tmp/pi-previews/hold-stop/implemented-native-sse.json`. `createDevHub.fixture.script` sends B
  and A in distinct timed SSE messages; both `MessageEvent.isTrusted` values are true and both
  arrive after native CDP hold starts. **Zero abort requests**, no console errors. This is network
  evidence, not public dispatch relabelled as network.
- Same real Composer provider + actual Ring/Fallback component remount is covered in component
  tests. Main App always provides metrics, so its provider-absent branch is not fabricated for
  browser coverage.

The complete-source/hash and final-bundle/hash ledger is
`/tmp/pi-previews/hold-stop/implemented-freeze.json`. Probe, result/log and key screenshot paths
are recorded there. All isolated browsers/contexts/dev-hub instances were closed in `finally`;
no background probe/server remains. Source files were not newer than the completed matrix.

## Remaining manual limits

Physical iOS/Android and VoiceOver/TalkBack are **not verified**. CDP emulation and viewport560px
simulation do not prove OS software-keyboard/callout behavior. Manual acceptance:

1. With the real keyboard open, start a hold: no keyboard collapse or target movement. Release
   early, pan, move out, interrupt touch or switch tabs: no stop, feedback clears promptly.
2. Hold through native callout timing and700ms: no menu and exactly one current-turn abort.
   Keep holding/release: no repeat; a second finger neither takes over nor cancels unless the
   platform emits a genuine current-pointer cancellation.
3. Navigate both main stop and no-hold alternative with AT/keyboard. Confirmation starts at
   Cancel; cancel/Esc never stops, explicit Confirm stops once; no timed key hold is required.
4. Check phone/landscape/large-font layout and all edges against attach/send/hint/transcript.

No additional product decisions remain; root performs delta verification and commit. This
package does not commit, install dependencies, alter frozen shared files or start another task.
