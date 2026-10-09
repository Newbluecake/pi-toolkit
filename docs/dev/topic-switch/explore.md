# topic-switch — exploration facts (2026-10-09)

Read-only survey for the topic-switch feature (docs/dev/topic-switch/requirements.md). Coordinates: repo files relative to `/home/bluecake/ai/pi-toolkit`; pi host files under `/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/` (peer pin `>=1.0.0 <1.1.0`).

## 1. Cache state (warm/expired, TTL mode, keepalive, adaptive)

**State holders** (per session, rebuilt on every `session_start`, disposed at top of next build — stack.ts:742-753 in index.ts):

- `CacheKeepaliveService` — `src/service/cache-keepalive.ts` (impl :285, ctor :321). Stack field `keepalive?` (stack.ts:925-926), built at stack.ts:2205-2228 when `settings.cacheTtl.keepalive` (default true, settings.ts:819).
- `CacheAdaptiveService` — `src/service/cache-adaptive.ts` (impl :208). Stack field `adaptive?` (stack.ts:927-928), built at stack.ts:2234-2265 when `settings.cacheTtl.adaptiveEnabled` (default true, settings.ts:824).

**Window state** — `WindowState` (`src/cache-ttl/keepalive-state.ts:174-215`): `aliveUntil`, `lastReadStartedAt` (set optimistically at request start), `lastProvenPingStartedAt`, `nextPingAt`, `pings`, `upgradePending`, `lastStopReason`. `onRealRequest` (keepalive-state.ts:772-800) resets it per real request:

```ts
lastReadStartedAt: now, aliveUntil: now + assumedTtlMs,  // assumedTtlMs default ASSUMED_TTL_MS = 300_000 (5m), keepalive-state.ts:24
```

- Constants: `ASSUMED_TTL_MS = 300_000`, `TTL_SAFETY_MARGIN_MS = 45_000`, `TICK_INTERVAL_MS = 15_000` (keepalive-state.ts:24-27). Expired-check precedent (gate #13): `now >= window.aliveUntil - TTL_SAFETY_MARGIN_MS` (keepalive-state.ts:485-486).

**Query ports** (how another module reads it):

- `KeepalivePort.report(): KeepaliveReport` (cache-keepalive.ts:135-192, impl :1068-1084; `KeepaliveReport` at keepalive-state.ts:1007-1046) — exposes `enabled/armed/window/session/config/costUsd/lastStopReason/supportsLongCacheRetention`. Note `armed()` is private (:479) but surfaced as `report().armed`.
- `provenCacheReadAt(): Millis | undefined` (cache-keepalive.ts:161-172, impl :1086) — start of last PROVEN cache read (`lastProvenPingStartedAt`); a window kept alive by pings must not be judged cold.
- `gapHorizonMs(prefixTokens)` (cache-keepalive.ts:174-192) — longest gap the pinger can bridge for the next request's window.
- Adaptive: `snapshot(): AdaptiveSnapshot` (cache-adaptive.ts:485; shape at `src/cache-ttl/adaptive.ts:1312-1345`) — `coverRemainingMs`, `learned1hLifeMs` (F-A: learned 1h-lifetime upper bound, cover capped at 0.8×), `breaker`, budgets. `coversPrefix(horizonMs)` (cache-adaptive.ts:515-519) → `isPrefix1hCovered` (adaptive.ts:621).
- **No existing function answers "would the next request read the cache?"** — it must be composed from: `report().window.aliveUntil` (+margin), `provenCacheReadAt()`, adaptive `coverRemainingMs`/`coversPrefix`, and TTL mode. TTL mode lives in the `wireCacheTtl` closure (`src/cache-ttl/cache-ttl.ts:321-329` `let mode = settings.cacheTtl.mode`; mode ∈ `auto|on|off|adaptive`, settings.ts:285-287, default `auto` :818) and is mirrored into the service via `syncModeState` (cache-ttl.ts:76-90). Uncertainty: under `on`/adaptive-1h writes the window's `aliveUntil` still uses the 5m `assumedTtlMs`; the real 1h lifetime is tracked only by the adaptive cover — the "expired" predicate must combine both.
- **Wiring precedent for cross-module reads**: `CacheTtlDeps.keepalive/adaptive` holder read-throughs (cache-ttl.ts:22-47) passed at index.ts:300ff; adaptive↔keepalive lazy closures at stack.ts:2219-2253. A topic-switch module can read `holder.current?.keepalive?.report()` etc. from `src/index.ts` wiring (holder at index.ts:232; rebuild at index.ts:737-771).
- Measured prefix/cost: `readLatestAssistantUsage(ctx)` (`src/cache-ttl/usage-ledger.ts:75-108`) — last assistant entry with usage from `ctx.sessionManager.getEntries()`: `cacheRead/cacheWrite/cacheWrite1h/costTotalUsd/cacheWriteUsd/entrySeq/modelId`; `prefixFromLedger` = cacheRead+cacheWrite (:110-112).

## 2. Cost estimate

- **Pricing source**: `ctx.model.cost` (pi `ModelCost`: `{input, output, cacheRead, cacheWrite}` USD/1M + `tiers[]` request-wide). Registry lookup: `ctx.modelRegistry.find(provider, id)?.cost` — `priceOf` closure stack.ts:2150-2165 (tier = highest `inputTokensAbove` < tokens, applies to FULL request). Same algorithm reimplemented pi-free: `tidyRatesFromModelCost` (`src/memory/tidy/cost.ts:53-63`).
- **Closest existing helper for "cold next request" cost**: `estimateFirstRequestUsd(tokens, {input, cacheWrite})` (`src/consult/tool.ts:403-405`):

```ts
return (tokens * Math.max(price.input, price.cacheWrite)) / 1e6; // "full prefix rewrite at write price (§4.1)"
```

Used by consult's context preflight (tool.ts:615). Combine with `priceOf`-style rates + `ctx.getContextUsage().tokens`. Also: tiered `cacheReadCostUsd`/`cacheWriteCostUsd` (keepalive-state.ts:982-1000); compact-hint dynamic pricing `buildPriceModel/rateAt/readRateAt/writeRateAt` (`src/compact-hint/dynamic/pricing.ts:49-77`, wire reads `ctx.model.cost` at dynamic/wire.ts:543); `estimateTidyUsd` (memory/tidy/cost.ts:24-33, 2 B/token + output upper bound).

- **Token count**: `ctx.getContextUsage(): {tokens: number|null, contextWindow, percent}` — types.d.ts:197-202, on ExtensionContext :248. Precedents: `mainSessionFactsFrom` (stack.ts:591, 600-620 — `usage.tokens`, degrades to `{}`), compact-hint hook (stack.ts:1075). `tokens` is null right after compaction. Alternative: ledger prefix (`prefixFromLedger`) — measured, excludes the pending new message.
- No existing main-session "next request cost" function — assemble from the above. Quota (`src/quota/`) is provider-quota, not cost estimation.

## 3. Input interception

- `InputEvent` types.d.ts:873-885: `{text, images?: ImageContent[], source: InputSource, streamingBehavior?: "steer"|"followUp"}`; `InputSource = "interactive" | "rpc" | "extension"` (:872). Result (:886-897): `{action:"continue"} | {action:"transform", text, images?} | {action:"handled"}`.
- **pi awaits the handler, no timeout, errors fail-open**: `agent-session.js:1440-1455` `_runInputHandlers` → `await emitInput(...)`; `runner.js:1202-1240` iterates extensions then handlers sequentially, `await handler(event, ctx)` per handler, `catch` → `emitError` and continue. `"handled"` drops the prompt entirely (agent-session.js:1503-1506 → `preflightResult?.("handled")`, return). An async/slow handler (cheap-model call + dialog) blocks delivery of that input but nothing else — precedent: web-hub notes `sendUserMessage` fires input synchronously same-tick (web-hub/agent/commands.ts:249-255).
- **Ordering inside `prompt()`** (agent-session.js:1486-1520): (1) extension-command dispatch when `expandPromptTemplates && text.startsWith("/")` — a registered slash command NEVER reaches input handlers; (2) input handlers; (3) `/skill:` + template expansion; (4) if streaming, queue as steer/followUp. `streamingBehavior` is only set when `this.isStreaming` (agent-session.js:1502) ⇒ **"idle new-round request" ⇔ `event.streamingBehavior === undefined`**. Uncertainty: TUI built-in (non-extension) commands are handled in interactive-mode before `prompt()` (interactive-mode.js:3853-3860 `isExtensionCommand`) — not fully traced whether unregistered `/foo` reaches the event.
- **Sources**: TUI typing → `"interactive"` (default, agent-session.js:1502); `pi.sendUserMessage` → `"extension"` (agent-session.js:1826-1839); RPC transport → `"rpc"` (modes/rpc/rpc-mode.js:306,320,324). **Web-hub prompts arrive as `"extension"`** — commands.ts:256 `deps.pi.sendUserMessage(cmd.text, {deliverAs: cmd.deliver, expandPromptTemplates: false})` (hold-branch dispatch :338 same). Our internal follow-ups (reload) also `"extension"`.
- **Existing `input` handlers in repo**: session-nav/index.ts:164-172 (sync; `source === "interactive"` only; bare `exit` → `ctx.shutdown()` + handled); mention/mention.ts:108-124 (async; `@label` → handled); feishu-notify/index.ts:494-502 (async; `@notify` keyword transform). Ordering: extension load order, then registration order within the extension — a topic-switch handler registered after these sees transformed text; register early + tolerate transforms. Session-nav's editor rewrite happens pre-submit (editor wrapper, not the input event).

## 4. Switching sessions

- `ExtensionCommandContext.newSession({parentSession?, setup?, withSession?})` — types.d.ts:292-303; `switchSession(sessionPath, {withSession})` :313-318. Only on command-handler contexts. `withSession(ctx: ReplacedSessionContext)` — ReplacedSessionContext (types.d.ts:325-340) **does accept images**: `sendUserMessage(content: string | (TextContent | ImageContent)[], {deliverAs?, expandPromptTemplates?})` (:333-338).
- **Precedent for triggering a command from non-command code** (event-context never has `newSession` — builtin-bridge.ts:205-210 comment §4.6 K22): web-hub `/new` → `pi.sendUserMessage("/webhub __exec new <nonce>", {expandPromptTemplates: true, deliverAs: "followUp"})` (builtin-bridge.ts:303-313); nonce armed by `armExec` (web-hub/agent/index.ts:322-341, 5 s TTL) and consumed in the registered `/webhub` command handler (src/commands/webhub.ts:358-370) → `internalExec` → `await ctx.newSession()` (web-hub/agent/index.ts:1381-1395). Same pattern for `/agent reload fire` (src/reload/index.ts:13-17, 44-47 — header documents `expandPromptTemplates: true` is load-bearing: without it the text lands in the LLM context instead of executing).
- **Yes — `sendUserMessage` of a slash command executes the command** when `expandPromptTemplates: true` (dispatch runs before input handlers, even mid-stream; agent-session.js:1486-1501 + reload header note).
- **Web-hub following a session change**: the agent client re-attaches on every `session_start` — web-hub/agent/index.ts:1033-1085 (generation++, fresh `session` frame via `connectWith`; `agentKey` recorded at connection.ts:545). There is **no dedicated `switch_session` op in the cmd protocol** — `protocol/messages.ts:439` lists `prompt|abort|steer_subagent|abort_subagent|dialog_answer|dialog_cancel|command|recall`; web `/new` rides the `command` op → builtin bridge (AGENTS.md's "switch_session" is plan-level vocabulary; code reality is command-op + `__exec`).
- Topic-switch shape that falls out: input handler returns `handled`, stashes {text, images}; arms a nonce; `sendUserMessage("/topic-switch __go <nonce>", {expandPromptTemplates:true})`; command handler calls `ctx.newSession({withSession: async (rc) => rc.sendUserMessage([{type:"text",text},...images])})`. Fail-open: on any error, `sendUserMessage(text)` back into the current session (source "extension") or re-prompt via transform… note a `handled` message must be re-sent explicitly — never lost.

## 5. Confirm UI (TUI + web-hub)

- TUI native: `ctx.ui.confirm/select/input/notify` (types.d.ts:526; ExtensionUIContext :120-195). ask_user uses `ctx.ui.custom(...)` with a serialization queue (`src/ask-user/index.ts:247`, `src/ask-user/queue.ts`).
- **ask_user wiring**: default export `wireAskUser(pi, opts)` (ask-user/index.ts:496-…); `AskUserWireOptions.remote?: () => AskUserRemotePort | undefined` (:481-494) — wired from src/index.ts:291-292 via `askUserRemoteRef` (index.ts:146), filled at index.ts:945 (`webHubRef.current?.askUserRemote()`).
- The TUI-vs-web race lives in `runTuiInteraction` (ask-user/index.ts:140-…) — **module-internal, not exported; there is NO programmatic ask API outside the ask_user tool today.** Two options: (a) export a programmatic entry from ask-user (refactor); (b) replicate the pattern directly — it is small: `AskUserRemotePort.open({toolCallId, questions, allowCancel})` is generic (`src/web-hub/agent/dialogs.ts:271-322`, keys records `ask:${toolCallId}`, no coupling to the tool; web answers via `dialog_answer`/`dialog_cancel` ops :325-333) + own `ctx.ui.custom` component + `createDialogRace()` (`src/ask-user/remote.ts:43-58`, synchronous claim arbitration). `toProtoQuestions`/answer codecs are in ask-user (channel-handler.ts, answer-codec.ts) — reuse would need an export.
- **Does the web see ctx.ui prompts?** `ui_prompt_start/end` events (types.d.ts:771-783) ARE forwarded to the browser by the event tap (web-hub/agent/event-tap.ts:345-380, kind/title/dialogId), but native `select`/`confirm` prompts are **not answerable from the web** — only dialogs opened through the DialogBridge are (its `attributePrompt` links a `kind:"custom"` prompt to the open record, dialogs.ts:340-352). Caveat: attribution picks the first unattributed custom prompt — a second concurrent custom component could mis-attribute.
- RPC-mode marker detail: ask_user in RPC surfaces as a `select` with `ASK_USER_MARKER` title (event-tap.ts:341-343). Requirements say don't prompt in RPC/print — guard on `ctx.mode === "tui"` (plus web dialog presence).

## 6. Cheap model call (direct LLM vs subagent)

- **Direct one-shot completion precedent — session titles** (`src/title/`): `complete: async (model, request) => await ctx.modelRegistry.complete(model, {systemPrompt, messages: [{role:"user", content, timestamp}]}, {signal, maxTokens})` (title/index.ts:186-201); model resolved via `ctx.modelRegistry.find(provider,id)` (:184) from a settings `modelRef`. Registry API: `complete<TApi>(model, context, options?): Promise<AssistantMessage>` (pi dist/core/model-registry.d.ts:40) — internally streams to done; title/index.ts:24-27 explicitly rules out a subagent spawn for a ≤512-token one-shot ("不值得起会话"). `TITLE_MAX_TOKENS` cap in title.ts. This is the recommended shape for the relevance judge: one HTTP roundtrip (~1-3 s), cost = few hundred tokens on a cheap model, `AbortSignal.timeout(ms)` for the short timeout (title uses `timeoutSignal`, title/index.ts:166).
- Raw-fetch precedent (only if a custom endpoint were needed): keepalive ping uses `ctx.modelRegistry.getApiKeyAndHeaders(model)` (cache-keepalive.ts:797-800) + global fetch (`src/cache-ttl/ping-client.ts`).
- No other direct piAi usage: grep shows only types + `getSupportedThinkingLevels` (web-hub/agent/models.ts:36-44) and sysprompt/compat.ts helpers.
- **Subagent route**: `SpawnService.spawnAndWait(req)` (spawn-service.ts:79, impl :840) — /goal verifier precedent: `withTimeout(spawn.spawnAndWait({type, prompt, modelHintOverride, ...}), settings.evalTimeoutMs)` (goal/hook.ts:217-260), cost folded into `RunOutcome.usage`. Heavier: child session create + sysprompt + tools; latency seconds-to-tens. Fuzzy model hints: `resolveModelHint` (config/model-hint.ts:58-84, tiers strict→exact→prefix→substring→name).

## 7. Guards

- **Child session**: `const isChildSession = Boolean(g[HOST_KEY])` (index.ts:145; `HOST_KEY = Symbol.for("pi-subagent:host")` :136, claimed at :225-227). Everything after `if (g[HOST_KEY]) return;` (index.ts:225) is main-session-only by construction — topic-switch should register post-guard.
- **Running subagents/workflows**: `holder.current?.query.list().filter(s => !["completed","failed","timed_out","aborted"].includes(s.status)).length + workflow.activity.list().length` — `activeSubagentRunCount` index.ts:632-635; live-status shape `["queued","starting","running","stopping"]` stack.ts:2212-2213.
- **Background bash**: `holder.current?.bashJobs?.backgroundJobCount()` (stack.ts:2213; publishBackgroundStatus index.ts:244-256).
- **Streaming/idle**: `ctx.isIdle(): boolean` (types.d.ts:244-245); degrade pattern stack.ts:1465-1468; `hasPendingMessages()` :249; `agent_settled` event :766-768. In the input handler itself, `event.streamingBehavior === undefined` already encodes "idle round".
- **Print/rpc/no-UI**: `ctx.mode ∈ "tui"|"rpc"|"json"|"print"` (types.d.ts:206), `ctx.hasUI` true in TUI+RPC (:211). Precedents: web-hub attach gate `mode !== "tui" && mode !== "rpc"` return (web-hub/agent/index.ts:1034); compact-hint skips print/json (stack.ts:1073).

## 8. Settings

- Declare a settings group interface + field on `AgentSettings` (settings.ts:548-621) + default in `DEFAULT_SETTINGS` (settings.ts:746; e.g. cacheTtl defaults :818-824). Normalization/migration in `loadSettingsFromFile` (settings.ts:2119-2160; `readSettingsNoMigrate` :2220); time-valued settings are stored as integer seconds under `*S` keys (`TIME_SETTING_MS_PATHS` :1005; migration :2262, `src/config/time-units.ts`).
- `/agent settings` TUI editor: add an entry to `SETTING_SPECS` (`src/config/setting-specs.ts:165`; helpers `bool/choice/count/csvString` :81-91) — consumed by `src/ui/settings-editor.ts:6,170,197`.
- Settings are loaded once per `activate()` (index.ts:231) — for live edits use `() => settings.x` closure re-reads where the object is shared, or `persistSettingOverride` (cache-ttl.ts:326) for persisted overrides; full refresh needs `/reload`.
- Web settings panel: none exists (web-hub has no settings surface). Threshold default 0.5 USD fits the existing pattern of plain numeric settings.

## Uncertainties / notes

1. `aliveUntil` is 5m-anchored even for 1h-written prefixes; the true 1h liveness signal is the adaptive cover (`coverRemainingMs`/`coversPrefix`) + `learned1hLifeMs`. The exact "cache expired" predicate needs an architect decision combining `report().window.aliveUntil`, `provenCacheReadAt()`, and cover state.
2. Whether TUI built-in slash commands (non-extension) reach the `input` event was not traced; extension-registered commands definitively do not (dispatched earlier in `prompt()`).
3. No exported programmatic ask-user API; DialogBridge.open is generic but `attributePrompt` matches any unattributed `custom` prompt — concurrent custom dialogs can cross-attribute.
4. pi `.d.ts` line numbers are from the installed v22.22.1 copy; they move between pi versions.
5. "别再问" cooldown state must live per-stack (rebuilt on session_start) or in a session entry — no existing cooldown primitive found; `compactHint.imminence` (stack.ts:1489-1505) is the closest per-session latch precedent.
