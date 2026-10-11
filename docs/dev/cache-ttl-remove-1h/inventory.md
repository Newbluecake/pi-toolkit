# 移除自动 1h 升级 — 影响面盘点（Explore r_50ABYNPZ，deepseek-v4-pro，2026-10-11）

> 只读盘点，行号基于盘点时的 HEAD；施工前按符号重核。主会话裁定：持久化的 `"adaptive"` 迁移为默认 `auto`（不是 `off`），附一次 warn；保留 `auto`/`on`/`off`、保活、ping 账本、子会话保活、warmth 端口（去掉 adaptive 证据）。必须在 keepalive 瞬时失败恢复包（#18）合入之后施工。

# Impact inventory: removing the adaptive prompt-cache 1h upgrade machinery

Scope confirmed: delete adaptive prediction + its settings/status/telemetry/session-readback, and the keepalive one-shot `→1h` upgrade (`keepaliveUpgradeAfterBudget` / `consumeUpgrade` / I-K5). Keep `auto`/`on`/`off`, keepalive pings, ping ledger, child keepalive, and the `warmth.ts` port (with its adaptive evidence inputs re-derived or removed).

---

## (1) File-by-file list — delete vs edit (with line numbers)

### Files to DELETE entirely

| File                                                         | Reason                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/src/cache-ttl/adaptive.ts`     | the pure predictor (1393 lines). Everything here exists only for adaptive.                                          |
| `/home/bluecake/ai/pi-toolkit/src/service/cache-adaptive.ts` | the stack service (`createCacheAdaptiveService`, `computeAdaptiveSignals`, `CacheAdaptiveService`, `AdaptivePort`). |

### `src/config/settings.ts` (edit)

- **L316** `export type CacheTtlMode = "auto" | "on" | "off" | "adaptive"` → drop `"adaptive"`.
- **L332–358** in `CacheTtlSettings`: delete `adaptiveEnabled`, `adaptiveWriteBudgetTokens`, `adaptiveWriteBudgetUsd`, `adaptiveFeeBudgetTokens`, `adaptiveFeeBudgetUsd`, `adaptiveMaxDeltaTokens`, `adaptiveRefreshAfterTokens`, `adaptiveColdUpgrades`, `adaptiveColdCooldownMs`, `adaptiveColdMinHorizonMs`, `adaptiveHistoryGapSignal`. Also delete `keepaliveUpgradeAfterBudget` (L331).
- **L919–930** `DEFAULT_SETTINGS.cacheTtl`: delete the same 11 adaptive keys + `keepaliveUpgradeAfterBudget: true`.
- **L1154–1155** `TIME_SETTING_MS_PATHS`: delete `"cacheTtl.adaptiveColdCooldownMs"` and `"cacheTtl.adaptiveColdMinHorizonMs"` (keep `"cacheTtl.keepaliveIntervalMs"`).
- **L1408–1443** `parseCacheTtlSettings`: remove the `adaptiveEnabled` promotion (L1408–1410 "缺省整块时" branch), the `adaptiveEnabled` local (L1419), and the adaptive-aware `mode:` ternary (L1420–1427). Replace with a plain `mode` that accepts only `"auto"|"on"|"off"` and falls back to `defaults.mode` (`"auto"`).
- **L1443–1474** delete the 11 `adaptive*` parse lines + `keepaliveUpgradeAfterBudget` parse (L1443). Keep `childKeepalive*` parse lines (child keepalive is KEPT).
- **L2547, L2557** `migrateLegacyCacheTtlState`: the `mode !== "auto" && ... && mode !== "adaptive"` validation sets (two occurrences) must drop `"adaptive"` from the accepted set — this is the key "old settings never error" migration (see §2).

### `src/config/setting-specs.ts` (edit)

- **L659–663** `"cacheTtl.mode"` choice: remove `"adaptive"` from the `["auto","on","off","adaptive"]` array and from the description.
- **L681–685** delete `"cacheTtl.keepaliveUpgradeAfterBudget"` spec.
- **L685–750** delete all 11 `"cacheTtl.adaptive*"` spec entries (adaptiveEnabled, adaptiveWriteBudgetTokens/Usd, adaptiveFeeBudgetTokens/Usd, adaptiveMaxDeltaTokens, adaptiveRefreshAfterTokens, adaptiveColdUpgrades, adaptiveColdCooldownS, adaptiveColdMinHorizonS, adaptiveHistoryGapSignal).

### `src/cache-ttl/keepalive-state.ts` (edit — pure module; also has adaptive-adjacent KEPT symbols)

Delete:

- **L15–16** `import type { AdaptiveBreakerReason, AdaptiveSnapshot } from "./adaptive.js";`
- **L428–432** `keepaliveGapHorizonMs` (adaptive-only: only callers are `cache-keepalive.ts` `safeAdaptiveCovers` + `gapHorizonMs`).
- **L~430 (TickSkipReason)** the `"adaptive-1h"` member.
- **L~590–591** `evaluateTick` gate **#11.5** `if (adaptiveCovered === true) return skip("adaptive-1h", true);` plus the `adaptiveCovered` field in `EvaluateTickInput` and its destructuring.
- **L1140–1152** `BREAKER_DISPLAY` (exhaustive over `AdaptiveBreakerReason`).
- **L1154–1226** `adaptiveSegments(...)`.
- **L1272–1347** `renderAdaptiveReportLines(...)`.
- **L203, L227** `WindowState.upgradePending` field + `createInitialWindowState` init; **L503** (#14 `upgradePending: true` arm — the `#14` budget-exhausted branch becomes a plain terminal skip with no `upgradePending`); **L803** (`onRealRequest` reset) and **L976** (`invalidate` reset).
- **L994–1017** `ConsumeUpgradeInput` + `consumeUpgrade` reducer.
- **L500–503** `KeepaliveConfig.upgradeAfterBudget` field.

Edit:

- **L1081** `CacheDisplayMode = "auto" | "on" | "off" | "adaptive"` → drop `"adaptive"`.
- **L~1098 (CacheStatusInput)** `adaptive?: AdaptiveSnapshot | undefined` field → delete.
- **L1111** `CacheSegmentKind = "mode" | "ttl-now" | "ping" | "adaptive"` → drop `"adaptive"`.
- **L~1130 (CacheStatusSnapshot)** `adaptive?: AdaptiveSnapshot` field → delete.
- **L1231–1269 `buildCacheStatusSnapshot`**: remove the `mode === "adaptive"` segment branch and the entire `if (mode === "adaptive") { ... effectiveTtl/effectiveReason ... }` block; `effectiveTtl`/`effectiveReason` fall back to the `mode:auto/on/off` branch only.
- **L~1413–1417 `renderPingSegment`**: remove the `upgradeHint` computation (`mode === "auto" && config.upgradeAfterBudget && report.supportsLongCacheRetention ? " →1h" : ""`) and the `upgradeHint` in the returned `capped` string. Note: `report.supportsLongCacheRetention` **stays** (still used by `renderKeepaliveReportLines` L~1335 "long cache retention (1h) supported").

### `src/service/cache-keepalive.ts` (edit — **collision file**, see §5)

Delete:

- **L58** `import type { AdaptiveSnapshot } from "../cache-ttl/adaptive.js";`
- **L221** `adaptiveSnapshot?: () => AdaptiveSnapshot | undefined;` dep.
- **L227** `adaptiveCoversPrefix?: (horizonMs: Millis) => boolean;` dep.
- **L233** `switchImminent?: () => boolean;` dep (only consumed by `consumeUpgrade`).
- **L360** `upgradeAfterBudget: s.keepaliveUpgradeAfterBudget,` in `config()`.
- **L383–390** `safeAdaptiveCovers()`.
- **L524** `...(this.deps.adaptiveSnapshot?.() ? { adaptive: this.deps.adaptiveSnapshot() } : {}),` in `publishVisibility()`.
- **L721** `adaptiveCovered: this.safeAdaptiveCovers(),` in `onTick()`'s `evaluateTick` call.
- **L1040–1046** `safeSwitchImminent()`.
- **L1052–1065** `consumeUpgrade(sessionId, instance, now?)`.
- **L~1149–1165** `gapHorizonMs(prefixTokens)` (adaptive-only consumer; its only caller is `stack.ts` `keepaliveHorizonMs`).
- **L148** `consumeUpgrade` in `KeepalivePort` interface + **L29** import `consumeUpgrade as consumeUpgradeReducer`.

Keep (reasons in §5):

- **`provenCacheReadAt()`** (L~1124) — still consumed by `cache-ttl.ts`'s warmth port (`proven-recent`).
- `WindowState.lastProvenPingStartedAt` (set in `onProvenHit`) — feeds `provenCacheReadAt`.
- `noteToolStart/End`, `noteUiPromptStart/End`, `noteAgentSettled`, `invalidate`, `syncModeState`, `setEnabled`, `dispose` — untouched.

### `src/cache-ttl/cache-ttl.ts` (edit)

Delete/edit:

- **L12** `renderAdaptiveReportLines` import.
- **L22** `import type { AdaptiveDecision } from "./adaptive.js";`
- **L23** `import type { CacheAdaptiveService } from "../service/cache-adaptive.js";`
- **L41–45** `CacheTtlDeps.adaptive?: () => CacheAdaptiveService | undefined;`
- **L84–86, L128–146** `createWarmthPort`'s `getAdaptive` param + the `adaptiveSvc`/`adaptiveSnapshot`/`adaptive` evidence block (L128–133) and the `adaptive,` spread into `WarmthEvidence` (L145). The `adaptive` evidence key disappears from the evidence (see `warmth.ts` below).
- **L159–163** `MODE_LABEL`: delete `adaptive` entry.
- **L183, L191** `updateStatus`'s `getAdaptive` param and the `adaptive: getAdaptive()?.snapshot()` in `renderCacheStatus` input.
- **L351–419** `wireCacheEvents`: delete every `const ad = getAdaptive(); if (ad) ad.noteToolStart/noteToolEnd/noteUiPromptStart/noteUiPromptEnd/noteAgentSettled(...)` pair (L357, 364, 371, 378, 388), the `ad.reconcile(...)` calls (L397, 404, 411), and the `ad.invalidateAdaptive(...)` in `invalidateBoth` (L418–419). Change `invalidateBoth`'s type from `Parameters<CacheAdaptiveService["invalidateAdaptive"]>[0]` to `Parameters<CacheKeepaliveService["invalidate"]>[0]` / `InvalidateReason`.
- **L449–453** `getAdaptive` closure — delete; keepalive-only path.
- **L459** `updateStatus(ctx, mode, dirty, deps, getAdaptive)` call sites — drop the `getAdaptive` arg (also L513, 638, 655).
- **L491–514** the `adaptiveSvc`/`decision` block and `upgrade` computation: replace
  ```ts
  const upgrade = decision?.upgrade === true || (port !== undefined && mode === "auto" && port.consumeUpgrade(...));
  ```
  with the keepalive-less upgrade gate (i.e. `const action = mode === "on" ? "force-1h" : mode === "off" ? "strip-ttl" : "passthrough";`). Also remove the `const shape = inspectPayload(...)` only if it's no longer needed — **it is still needed** for `lastSent`/`cached` and the keepalive capture, so keep `inspectPayload`, `payloadLineageKey`, `ledger`.
- **L530** comment "auto / adaptive-declined" → reword.
- **L575, 577** `USAGE` string + command description: drop `adaptive`.
- **L592** command completion: drop the `{ value: "adaptive", ... }` entry.
- **L623–626** `status` handler: delete `const adaptiveSvc = getAdaptive();` and `if (adaptiveSvc) lines.push(...renderAdaptiveReportLines(...))`.
- **L635** mode-set branch: drop `|| arg === "adaptive"`.
- **L669** `createWarmthPort` call: drop the `getAdaptive` argument.

### `src/cache-ttl/warmth.ts` (edit)

- **L45** `adaptive?: { covers: boolean; any1hWrites: boolean };` → delete from `WarmthEvidence`.
- **L48** `mode: "auto" | "on" | "off" | "adaptive";` → drop `"adaptive"`.
- **L54** warm reason union `"1h-cover" | "proven-recent"` → drop `"1h-cover"` (and the warm variant's `reason: "1h-cover"` alternative). `"proven-recent"` remains.
- **L108** `if (e.adaptive?.covers === true) return { state: "warm", reason: "1h-cover" };` → delete (the warm path now relies solely on the ledger/keepalive `proven-recent` branch at L109–113).
- **L152** `oneHourPossible` expression: remove `e.adaptive?.any1hWrites === true ||` (the 1h ceiling for the cold proof still works off `mode === "on"`, `lastSent.ttl1h`, `ledger.cacheWrite1h > 0`, and `recent1hWrite !== false`).
- **L6** header comment: remove the "the adaptive predictor" mention (cosmetic).

Degradation without adaptive: `assessWarmth` loses exactly one warm path (`1h-cover`) and one cold-ceiling input (`any1hWrites`). Every other path is intact, and both removed branches were already strictly additive ("only raise the bar / only flip to warm"). `topic-switch` gate 3a already treats `unknown` as "don't ask", so the only behaviour change is: a session previously warmed by an active 1h cover now degrades to `proven-recent` (if the ledger/keepalive has a proven touch) or `unknown`. No other consumer of `CacheWarmth` exists.

### `src/stack.ts` (edit)

- **L120–123** delete the `createCacheAdaptiveService, computeAdaptiveSignals, type CacheAdaptiveService` import.
- **L124** delete `import { readBackAdaptiveSessionState } from "./cache-ttl/adaptive.js";`
- **L217** delete `let previousAdaptive: CacheAdaptiveService | undefined;`
- **L960–961** delete `adaptive?: CacheAdaptiveService;` from `Stack`.
- **L1501–1502** delete `previousAdaptive?.dispose(); previousAdaptive = undefined;`
- **L2341–2347** in the keepalive service deps: delete `adaptiveSnapshot: () => previousAdaptive?.snapshot(),`, `adaptiveCoversPrefix: (horizonMs) => previousAdaptive?.coversPrefix(horizonMs) === true,`, and `switchImminent: () => isSwitchImminentNow(compactHint, ctx),` (all three become unused — see §5 for `isSwitchImminentNow`).
- **L2358–2393** delete the entire `const adaptive = settings.cacheTtl.adaptiveEnabled ? createCacheAdaptiveService({...}) : undefined;` block and `previousAdaptive = adaptive;`.
- **L2780** delete `...(adaptive ? { adaptive } : {}),`.

Dead-code candidates (optional cleanup, no functional impact): `isSwitchImminentNow` (L1046–1064), `isSwitchImminent` (imported from `compact-hint/threshold.ts` at L16), and the `CompactHintState.imminence` field (L878) + its assignment (L1163) / init (L1624) / child.ts (context-switch/child.ts L242) — these become unreferenced once both `switchImminent` consumers (adaptive + keepalive consumeUpgrade) are gone. If left, they are harmless; `tsc --noEmit` will NOT flag them as unused unless `noUnusedLocals` is on (verify; the repo uses strict but I did not see `noUnusedLocals`). Recommend removing `isSwitchImminentNow` + its two call sites at minimum.

### `src/index.ts` (edit)

- **L305–308** `wireCacheTtl(pi, settings, { keepalive: () => holder.current?.keepalive, adaptive: () => holder.current?.adaptive })` → drop the `adaptive:` dep.
- **L795** `holder.current.adaptive?.dispose();` → delete (session_shutdown path).
- **L847** `stack.adaptive?.dispose();` → delete (defensive session_start path).
- **L1049** `warmth: cacheTtl.warmth,` → **keep** (topic-switch still consumes the warmth port).

### HUD / commands / web-hub

- `src/hud/footer.ts`: **no change** — it aggregates `ctx.ui` status lines generically and never names "adaptive". The adaptive status text is produced by `keepalive-state.ts` (`buildCacheStatusSnapshot`), which you are already editing.
- `src/commands/`: no `/cache` command lives here; the `/cache-ttl` command is registered inside `src/cache-ttl/cache-ttl.ts` (already covered). `/agent settings` uses `SETTING_SPECS` (covered).
- `src/web-hub/agent/command-policy.ts` L137–140: `cache-ttl(tokens)` policy is mode-agnostic (treats `status`/`undefined` as allow, everything else confirm). **No change** — the `"adaptive"` subcommand simply disappears from the completions in `cache-ttl.ts` and any web-origin invocation of it becomes an ordinary unknown-arg confirm. No web-hub surface hardcodes adaptive.
- `src/web-hub/ui/*`: no matches (grep for `adaptive|cacheTtl|keepalive` hit only the unrelated `pwh_keepalive` browser pref and `sessionKeepAlive.ts`).

### Telemetry / scripts

- `/home/bluecake/ai/pi-toolkit/scripts/exp/cache-adaptive-field.mjs`: **KEEP** (read-only offline analyzer of `subagent:cache-adaptive` jsonl entries; the user explicitly says it may keep reading old session files). No runtime dependency on adaptive source. Optionally add a deprecation note.
- No other telemetry writer references adaptive (grep of `scripts/` returned only this one file).

---

## (2) Settings migration — what persisted `"adaptive"` / removed leaves must become

Existing sanitize/migration patterns to mirror: `parseCacheTtlSettings` (field-by-field `bool()/num()/usd()` tolerance, never throws) and `migrateLegacyCacheTtlState` (L2535–2561, the cache-TTL legacy file migration that reads a legacy `mode`, validates it, and merges into `raw.cacheTtl`).

What old files must degrade to, with zero errors:

1. **`cacheTtl.mode === "adaptive"`** (explicitly persisted by `/cache-ttl save` or written by the old default-promotion). After removal, `"adaptive"` is no longer a valid `CacheTtlMode`. The `mode:` ternary in `parseCacheTtlSettings` (currently L1420–1427) must change so that any value other than `"auto"|"on"|"off"` (including `"adaptive"`) falls back to `defaults.mode` = `"auto"` **and logs a one-line `console.warn`** (mirror the `migrateLegacyCacheTtlState` L2548 pattern: `console.warn('[pi-subagent] ... invalid cacheTtl mode "adaptive"; using auto')`). Do NOT silently promote and do NOT throw.

2. **`migrateLegacyCacheTtlState`** (two places, L2547 and L2557): the legacy-file `mode` validation currently accepts `"adaptive"` so that a newer version's legacy state round-trips. After removal, a legacy file carrying `"adaptive"` must be treated as **invalid**, warn, and `keep the file for retry` (L2548–2552) rather than adopting it — same as any other unknown mode today. (Or, more simply, treat it as "accepted but dropped" — but the safest is the existing invalid-mode path, since we no longer understand the value.)

3. **Removed `cacheTtl.adaptive*` leaves + `keepaliveUpgradeAfterBudget`**: `parseCacheTtlSettings` simply stops reading them (delete the 11 `adaptive*` parse lines + the `keepaliveUpgradeAfterBudget` line). Because `parseCacheTtlSettings` is field-by-field tolerant and returns a fresh object built only from `DEFAULT_SETTINGS` + recognized keys, unknown/removed keys in the on-disk JSON are **silently ignored** — old settings files load fine with no error. No explicit "delete the key on disk" migration is required (consistent with how `persistSettingOverride` already prunes parents, and how other removed settings in this repo are handled). If you want the file physically cleaned, that is optional and must go through `persistSettingOverride`-style write-back, but it is NOT needed for correctness.

4. **`cacheTtl.adaptiveColdCooldownS` / `cacheTtl.adaptiveColdMinHorizonS`** (the on-disk second-valued names): remove from `TIME_SETTING_MS_PATHS` (L1154–1155). `migrateSettingsFileTimeUnits` will then leave any leftover `*S` keys untouched (they're ignored by the parser). Remove the corresponding `isTimeSettingKey` expectations.

Net: an old settings file with `{ "cacheTtl": { "mode": "adaptive", "adaptiveWriteBudgetTokens": 200000, "keepaliveUpgradeAfterBudget": true, ... } }` loads to `cacheTtl.mode === "auto"` with a warn, and all removed leaves vanish from the in-memory `CacheTtlSettings`.

---

## (3) Persisted session entries (`subagent:cache-adaptive` etc.) — reader tolerance

The only persisted adaptive artifact is the audit customType **`subagent:cache-adaptive`** (constant `ADAPTIVE_AUDIT_CUSTOM_TYPE` in `adaptive.ts`, written by `cache-adaptive.ts`'s `audit()` via `pi.appendEntry`, and emitted on channel `"subagent:cache-adaptive"`). There is also a parallel **`subagent:cache-keepalive`** entry (KEEP — its writer `cache-keepalive.ts` remains; its `kind:"terminal-skip"` child entries continue).

After removal:

- **The writer disappears** (no more `appendEntry("subagent:cache-adaptive", …)`). Nothing needs to tolerate a _new_ write; the risk is _old jsonl files_ being re-read.
- **`readBackAdaptiveSessionState` is deleted** (it lives in `adaptive.ts`, L~465–560). It is the only runtime reader of `subagent:cache-adaptive` entries. Because it is deleted together with its only call site (`stack.ts` L2387), old entries are simply never parsed by the runtime again — no tolerance code is needed for correctness. Old jsonl files load fine (the entries are just inert custom entries).
- **`scripts/exp/cache-adaptive-field.mjs`** keeps reading them (KEEP, per user). No change; it is a standalone analyzer keyed on the literal `"subagent:cache-adaptive"` string and is unaffected by source deletion.
- **session-nav / resume / fork**: `subagent:cache-adaptive` entries are ordinary custom entries; nothing in session-nav or the resume/fork path special-cases them (grep found no reference outside `adaptive.ts`, `cache-adaptive.ts`, `stack.ts`, and the script). No tolerance work.
- **`get_subagent_result` / `RunDiagnostics`**: no reference to adaptive entries.

One subtlety: `cache-ttl.ts`'s `wireCacheEvents` currently forwards `agent_settled`/`message_end`/`turn_end`/`agent_end` to **both** keepalive and adaptive (`ad.reconcile`, `ad.noteAgentSettled`). Removing the `ad` calls is safe because those keepalive calls stay. The `invalidateBoth` helper keeps invalidating keepalive on `model_select`/`session_compact`/etc. — just drop the adaptive half.

---

## (4) Tests to delete vs update; docs

### DELETE (pure-adaptive suites)

- `tests/cache-ttl/adaptive-state.test.ts`
- `tests/cache-ttl/adaptive-economics.test.ts`
- `tests/cache-ttl/adaptive-matrix-fixes.test.ts`
- `tests/cache-ttl/adaptive-verification-fixes.test.ts`
- `tests/cache-ttl/adaptive-readback.test.ts`
- `tests/cache-ttl/adaptive-keepalive-incident.test.ts`
- `tests/service/cache-adaptive-signals.test.ts`

### UPDATE (keep, remove adaptive/consumeUpgrade references)

- `tests/cache-ttl/keepalive-state.test.ts`: delete `consumeUpgrade` import (L13); drop `upgradeAfterBudget: true` from the config literal (L78); delete the `#14 … upgradePending armed` assertions (L373–385) and `upgradePending` reset assertion (L431); drop `upgradePending` from the `invalidate` test (L616–619); delete the whole `describe("consumeUpgrade", …)` (L624–~700); rework the `→1h` hint test (L1034–1043) to assert the hint is gone; delete the `renderCacheStatus — adaptive segments` describe (L1080–~1240) and the `adaptiveSnapshot()` helper (L1085) and the `renderAdaptiveReportLines` tests (L1308–1340).
- `tests/cache-ttl/keepalive-lifecycle.test.ts`: drop `keepaliveUpgradeAfterBudget: true` (L74); delete the "keeps the adaptive segments when a ping-driven publish re-renders" test (L218–227); delete the `F1 arbitration with adaptive` describe (L583–~690) and the `adaptive-1h cover drops the pending exact timer` test (L806–820).
- `tests/cache-ttl/keepalive-child.test.ts` + `tests/cache-ttl/keepalive-ping-retry.test.ts`: remove the `adaptive*` fields + `keepaliveUpgradeAfterBudget` from their `CacheTtlSettings`/config literals (child L108–119, retry L111). Child keepalive itself is KEPT.
- `tests/cache-ttl/warmth.test.ts`: remove `adaptive: { covers, any1hWrites }` from fixtures (L18, 38); delete the `adaptive.covers ⇒ warm/1h-cover` test (L83) and the `adaptive.any1hWrites raises the bar` test (L373).
- `tests/cache-ttl/warmth-port.test.ts`: delete `fakeAdaptive` (L37), the `adaptive` holder in `setup`/`setAdaptive` (L57–79), the `keepalive/adaptive re-fetched` test's adaptive half (L194–206), and the `no cacheTtl.keepalive/adaptive deps wired` test (L247) reword to keepalive-only.
- `tests/cache-ttl/cache-ttl.test.ts`: delete the adaptive-mode parse assertions (L153–157); delete `"adaptive"` from the command-completion expectation (L267–268); drop `"adaptive"` from the `MODE_LABEL`-related mode-switch expectations.
- `tests/config/cache-ttl-migration.test.ts`: change the "invalid explicit mode ⇒ promotes to adaptive" (L31–32), "absent mode ⇒ adaptive" (L40–41, 53), and "accepts a legacy adaptive mode" (L58–63) cases to expect `mode: "auto"` (with warn) instead of `"adaptive"`.
- `tests/config/cache-ttl-settings.test.ts`: rewrite the adaptive settings tests (L5 `PROMOTED_DEFAULT`, L15–26 defaults, L37–100 parse, L109–118 USD parse, L176–282 adaptive spec/parse). Keep the keepalive + child-keepalive assertions.
- `tests/compact-hint/switch-imminent.test.ts`: delete the `cache-ttl adaptive refuses new 1h prefixes while a switch is imminent` describe (L129–~240) and its `adaptive.js` import (L5–11). The `switch-imminent` compact-hint logic itself is unaffected.
- `tests/hud/footer.test.ts`: **cosmetic only** — L31 uses `"cache adaptive · 5m"` as an arbitrary status string; it will still pass. Optionally change to `"cache 5m"` for cleanliness, but not required.

### Golden fixtures

- `tests/fixtures/compact-hint-golden.json`: unrelated (compact-hint). Do not touch.
- `tests/fixtures/memory/current-5/cache-ttl.md` and `current-5-migrated/cache-ttl.md` + `tests/fixtures/memory/tiered-golden/g1_current5.txt`: these are **memory-content fixtures** whose prose documents "保活 × 自适应" facts. They are not byte-pinned cache-TTL goldens, but they feed memory-rendering tests. If you regenerate memory fixtures they must be updated to drop the adaptive paragraphs (§5 risk: the `tiered-golden` file is a pinned output — verify whether it is asserted byte-identical before regenerating; do NOT regenerate it blindly).

### Docs

- `AGENTS.md` `src/cache-ttl/` paragraph: rewrite to remove the adaptive description (adaptive 1h predictor, keepalive⇄adaptive interplay, `adaptiveWriteBudget*`/`adaptiveFeeBudget*`, entry fee, `learned1hLifeMs`, `warmth.ts`'s "adaptive `coversPrefix(0)`" mention), and to remove the `keepaliveUpgradeAfterBudget`/`consumeUpgrade`/`→1h`/I-K5 wording. Keep the `auto`/`on`/`off`, keepalive pings, ping ledger, child keepalive, and `warmth.ts` (minus its adaptive evidence) descriptions.
- `docs/dev/cache-ttl-adaptive/plan.md`: mark **superseded** (add a header note pointing at the removal decision and field data: adaptive 1h nets −$16 over 78 sessions; 1h entries die at ~25 min on cr-anthropic). Same for `review.md`, `field-2026-09-24.md`, `verification-2026-09-25.md`, `verification-2026-09-26.md` (they are historical; leave but flag).
- `docs/dev/cache-ttl-keepalive/plan.md`: amend the `§6.3`/`consumeUpgrade`/`keepaliveUpgradeAfterBudget`/`→1h` sections (L85, 238, 260, 271, 341, 631–635, 868, 988, 1171, 1306) to note the one-shot upgrade was removed; keep the ping/retry/budget core.
- `docs/dev/child-context-switch/plan.md`: L49, L124, L258, L287, L304 reference adaptive (child sessions already disable it); update the "不在范围/惰性" lists to drop the adaptive mentions. Child keepalive stays.
- `docs/dev/quota/*`: `integration-map.md` L232/236/239 and `quota-plan.md` L580–648 reference `previousAdaptive` / `stack.adaptive?.dispose()` as the template for quota's wiring. Update those cross-references (quota code itself is unaffected; only the illustrative "same pattern as adaptive" prose and line anchors shift).

---

## (5) Risks & the concurrent-edit collision

### Out-of-scope silent dependents on adaptive state

- **compact-hint dynamic threshold (`src/compact-hint/dynamic/*`)**: does **NOT** depend on adaptive. It reads pi `Usage` directly via its own `usage-range.ts` (`cacheRead`/`cacheWrite` from `getContextUsage`/entries) and computes its own price model (`pricing.ts`). The `src/cache-ttl/keepalive-state.ts` `cacheReadCostUsd` mirror mentioned in `pricing.ts` L5 is a comment reference, not an import. No code change needed.
- **topic-switch gate 3a**: depends on `warmth.ts`, not on adaptive directly. After removing the `adaptive` evidence, the gate's `warm`/`unknown`/`cold` verdicts shift slightly (documented in §1 `warmth.ts`), and gate 3a's I6 fail-open (`unknown` ⇒ don't ask) absorbs the loss cleanly. `topic-switch/types.ts` `WarmthView` (L32–37) and `gate.ts` need **no** structural change.
- **quota**: no adaptive reference (grep hit only `render.ts`/`gate.ts` comments about `cacheRead` cost semantics). No dependency.
- **compact-hint `switch-imminent` (task #14)**: the _reverse_ direction — adaptive and keepalive's `consumeUpgrade` consume `isSwitchImminentNow`. After removal both consumers vanish, leaving `isSwitchImminentNow` + `isSwitchImminent` + `CompactHintState.imminence` as dead code (see §1 stack.ts). Leave or remove; no live behaviour depends on them.
- **warmth.ts proven-recent path**: still needs `provenCacheReadAt()` and `keepalive.report()` — both KEPT. Do not delete `provenCacheReadAt`/`lastProvenPingStartedAt`/`report()`.

### Concurrent-edit collision (the one hard ordering constraint)

A concurrent package is editing **`src/cache-ttl/keepalive-state.ts`** and **`src/service/cache-keepalive.ts`** for transient-failure recovery (ping retry backoff / onUnproven / breaker / `lastPingDiagnostics`/`attempts`). Your removal edits collide in the **same two files**, specifically:

- `keepalive-state.ts`: your edits touch `evaluateTick` (gate #11.5 removal), `WindowState.upgradePending`, `consumeUpgrade`/`ConsumeUpgradeInput`, `renderPingSegment` (the `→1h` hint), and the status builders. The transient-failure work touches `onUnproven`/`SessionTotals` breaker fields and `renderKeepaliveReportLines`/`KeepaliveReport`. Overlap is in the **status/report and evaluateTick regions** — order the removal edits to land _after_ (or be rebased onto) the transient-failure changes, and re-run `tests/cache-ttl/keepalive-state.test.ts`, `keepalive-ping-retry.test.ts`, `keepalive-lifecycle.test.ts`.
- `cache-keepalive.ts`: your edits touch `onTick` (removing the `adaptiveCovered:` argument), `config()` (removing `upgradeAfterBudget`), `publishVisibility` (removing the `adaptiveSnapshot` spread), and delete `safeAdaptiveCovers`/`consumeUpgrade`/`gapHorizonMs`/`safeSwitchImminent`. The transient-failure work touches `runPing`/`onTick`/retry bookkeeping. The `onTick` edit (dropping `adaptiveCovered`) is the tightest collision point — keep it minimal (remove the argument + `safeAdaptiveCovers`) and do not reflow the retry logic.

### Other risks

- **`CacheDisplayMode` union collapse** ripples into `cache-keepalive.ts` `syncModeState(mode: CacheDisplayMode, …)` and `modeState` default `"auto"` — those keep compiling after the union shrinks (no "adaptive" literal remains in that file).
- **`renderPingSegment` `capped` text** loses the `→1h` suffix, which changes one golden-ish status string asserted in `keepalive-state.test.ts` L1034–1043 and possibly `cache-ttl.test.ts` — update both.
- **`settings.cacheTtl` object literals in tests** (`keepalive-child.test.ts`, `keepalive-ping-retry.test.ts`, `cache-adaptive-signals.test.ts`) will fail type-check once `CacheTtlSettings` loses the `adaptive*`/`keepaliveUpgradeAfterBudget` keys — delete/trim those literals in the same pass.
- **`isTimeSettingKey("cacheTtl.adaptiveColdCooldownS")`** assertions in `cache-ttl-settings.test.ts` L200–204 must go with the `TIME_SETTING_MS_PATHS` removal, or they'll fail.
- **No `dist/` rebuild issue**: pi loads TS source via jiti; `dist/` is CI-only. No runtime config migration beyond `settings.ts` is needed.

---

If you want, I can next produce the exact replacement code fragments for `parseCacheTtlSettings`'s `mode` branch and the `warmth.ts`/`cache-ttl.ts` warmth-port edits, or a precise ordered edit plan that sequences the collision-file changes after the transient-failure work.
