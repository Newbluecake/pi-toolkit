/**
 * jev-reflex · #25 B1 backtest origin markers (BA §4.2). The literals that classify how a
 * historical user message reached its session, plus the cache-invalidation version.
 *
 * Sourcing policy (plan B1 step 1): a marker is VALUE-IMPORTED when its defining module's
 * value closure is pi-free (checked by `tests/boundary/pi-free.test.ts`), otherwise MIRRORED
 * and pinned by the survival test (`tests/reflex/core/backtest/markers.test.ts`), which greps
 * `src/**` — excluding `src/reflex/**` — for every literal so an upstream rename fails loudly
 * instead of silently misclassifying the corpus.
 *
 * Pure constants only: no fs, no module-scope mutable state (I4); pi-free (R-I10).
 */

import { WAKE_LEVEL_CUSTOM_TYPE } from "../../../fabric/wake-level.js";
import { LLM_TIME_ENTRY_TYPE } from "../../../hud/timing.js";
import { ENTRY_TYPE as TOPIC_SWITCH_ENTRY_TYPE } from "../../../topic-switch/records.js";

/**
 * Bump whenever marker semantics change (a prefix added/removed, a customType re-sourced, the
 * HUD gate date moved). Part of the corpus cache invalidation key (BA §4.2 缓存失效键).
 */
export const MARKERS_VERSION = "1";

/** Custom-entry markers consulted through the user message's parent entry (BA §4.2 来源表). */
export const ORIGIN_MARKERS = Object.freeze({
  /**
   * Web-hub / Feishu / LAN prompt dispatch marker. MIRRORED from
   * `src/web-hub/agent/origin-entry.ts` (`WEB_ORIGIN_ENTRY_TYPE`) — that module imports pi-tui
   * as a VALUE, so importing it here would break the pi-free closure.
   */
  web: "subagent:web-origin",
  /** Topic-switch held-input re-injection ⇒ origin "replay" (KEPT as a corpus turn). */
  topicSwitch: TOPIC_SWITCH_ENTRY_TYPE,
  /** Fabric wake-level change entry preceding a wake-injected input ⇒ origin "injected". */
  wake: WAKE_LEVEL_CUSTOM_TYPE,
});

/**
 * The HUD timing entry written once per live TUI round (`src/hud/timing.ts`). Presence of a
 * NATIVE one inside a turn's entry interval proves that interval ran under `mode==="tui"`
 * (the HUD S3 live gate) — BA §4.2 sourceMode evidence ①.
 */
export const HUD_TIME_ENTRY_TYPE = LLM_TIME_ENTRY_TYPE;

/**
 * Unix-ms instant from which `pi-hud-llm-time` entries prove a tui session. The HUD tui gate
 * ("非 tui 会话不再产生 HUD 计时条目", the S3 `live` check in `src/hud/index.ts`) was
 * introduced by commit `78d71adcfbd97f4f2c269375196bcb647a623b97` ("feat(hud): merge pi-hud
 * footer HUD as src/hud"), committed 2026-09-18 15:04:27 +0800 = 1789715067 s. HUD entries
 * inside turns that STARTED before this instant prove nothing (the writing session may have
 * been non-tui) and are not admitted (BA §4.2; derivation in B1-report §2).
 */
export const HUD_TUI_GATE_SINCE = 1_789_715_067_000;

/**
 * Text prefixes marking injected (non-typed) user messages ⇒ origin "injected" ⇒ excluded
 * from corpus turns (CorrectionFacts still record them). Longest-meaningful heads; anchors:
 * `src/tools/steer-tool.ts`, `src/context-switch/tool.ts`, `src/web-hub/protocol/upload.ts`,
 * `src/web-hub/protocol/feishu.ts`, `src/mention/mention.ts`, historical goal continuations,
 * `src/stack.ts` (thread events), `src/fabric/format-fence.ts` (wake_result / inbox /
 * dead_letter / mention-resume deliveries).
 */
export const INJECTED_PREFIXES: readonly string[] = Object.freeze([
  "[主会话 steer · ",
  "[switch_context] ",
  "[web-hub attachments] ",
  "[飞书 · ",
  "[用户 @mention] ",
  "[/goal 续跑 · ",
  "[thread 事件 · ",
  "[fabric ",
]);

/** Subagent child-session self-marker (v0.4.0+). MIRRORED from
 *  `src/session-nav/session-head.ts` (`SUBAGENT_CHILD_MARKER_TYPE`) — that module's value
 *  closure is pi-free but heavy (fs/session-head machinery); mirroring matches the precedent
 *  of `session-nav/provenance.ts` mirroring `subagent:run`. Pinned by the survival test. */
export const SUBAGENT_CHILD_MARKER = "subagent:child";

/** Subagent run-log entry naming a child session file (`data.diag.sessionFile`). MIRRORED from
 *  `src/adapters/pi-run-log.ts` (`RUN_CUSTOM_TYPE`) exactly like `session-nav/provenance.ts`
 *  does (which pins it to the adapter "by a source-scan test — no runtime import"). */
export const SUBAGENT_RUN_MARKER = "subagent:run";

/** True when `text` starts with any injected prefix (earliest position wins; pure). */
export function isInjectedText(text: string): boolean {
  return INJECTED_PREFIXES.some((p) => text.startsWith(p));
}
