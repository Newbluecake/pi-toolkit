# IBW report — inbox unread assembly (channel-plan §12)

## Write exits (verified "only two")

Within the cross-session pipeline (receiver / RootWakeController / NoticeGate) `pi.sendMessage` is reached only via:

1. `buildStackXs`'s shared `host.sendMessage` (src/stack.ts, was :1709) — used by `XsReceiver` (receiver.ts:467, the only `host.sendMessage` call in receiver) and by `RootWakeController` (NoticeGate wakes go through the Controller).
2. `XsReplyNoticeGate`'s `host.sendMessage` (reply-notice.ts:257, the only call; wired at was :1817 as `pi.sendMessage(write,{triggerTurn:false})`).
   `grep sendMessage src/fabric/xs/*.ts` shows only these two call sites. Both lambdas now call `pi.sendMessage` first, then `tapWritten(message)` (sync throw ⇒ propagates, nothing counted). id = `details.xid`; absent ⇒ IB1 synthesizes `n:<seq>`. Tap swallows its own errors.

## Wiring

- `src/stack.ts`: `StackXsInput.unreadChanged`; `StackXs` gains `unread()` (IBP port), `unreadTurnStart/TurnEnd/AgentEnd` (never throw, then notify). Only built inside `buildStackXs` ⇒ xs off / child sessions have no wiring.
- `src/index.ts` (inside `if (xsEnabled)`, main session only): `turn_start`/`turn_end`/`agent_end` forwarders; `refreshXsInbox` sets TUI status `pi-subagent:xs-inbox` = `inbox N` (99+; 0 ⇒ cleared) and calls `webHubRef.xs.notifyUnreadChanged()` only when the count changed; forced re-render at every `session_start` (keeps count across /reload). `/fabric status` gains `inbox unread N`.
- HUD: no footer.ts change needed — `renderExtensionStatusLines` already renders any non-reserved extension status key on the generic status line (sorted by key), so `inbox N` appears there; compact English token.
- `src/fabric/xs/unread.ts`: added `XS_INBOX_STATUS_KEY` constant only.
- Test helper `tests/integration/helpers/fabric-xs-process.ts`: records `setStatus` calls (`statuses`) and the hub records agent `status` frames' `xsInbox` (`statusInbox`). Additive.

## Tests

- Conformance C-X10 (tests/conformance/fabric-xs.test.ts, 5 cases, real pi + stub): turn_end sees persisted assistant (`getEntry(messageEntryId)` role assistant); write before first turn cleared at first turn_end; write during async before_agent_start cleared at first turn_end; busy write survives turn k, cleared at k+1; error (400) turn fires turn_end; mid-stream `session.reload()` keeps count, later turn clears.
- Integration tests/integration/fabric-xs-inbox.test.ts (6): exit-1 deliver (badge, web xsInbox 1→absent, `/fabric status` line), Controller wake, busy ordering, exit-2 timeout notice (no xid), agent_end fallback + /reload retention (+ web retained), rejected message not counted.

## Results

- `vitest run tests/fabric tests/commands tests/hud tests/web-hub/agent tests/integration/fabric-xs*.test.ts tests/integration/fabric-wake-off-golden.test.ts --maxWorkers=3`: 152 files / 2577 tests passed (includes the three off goldens, unchanged).
- `vitest run tests/conformance/fabric-xs.test.ts`: 18/18 passed (C-X1…C-X10).
- `npm run typecheck`: clean. `prettier --check` on all changed files: clean.

## Notes

- Broadcast counting needs no extra work (receiver exit); CHW can add a broadcast case to the integration test.
- Frozen surfaces untouched.
