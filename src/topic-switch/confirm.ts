import { createDialogRace } from "../ask-user/remote.js";
import type { AskUserRemotePort, AskUserRemoteSession, RemoteOutcome } from "../ask-user/remote.js";
import type { Clock, TimerHandle } from "../core/clock.js";

/**
 * topic-switch confirm dialog (plan.md §P3a / arch.md §7): the gate-5 user confirmation that
 * races the TUI `ui.select` against the optional web-hub dialog. First answer wins; the loser is
 * cancelled/closed. Arbitration is `createDialogRace()` from ask-user's remote.ts — the ONLY
 * ask-user import allowed here (`src/ask-user/**` is frozen for this feature).
 *
 * Zero-hang: the timeout is self-managed through the injected `clock.setTimer` (the system clock
 * unrefs every timer), so the returned promise always settles within `timeoutMs` regardless of
 * what the UI channels do. All state lives in the closure — no module-scope mutable state.
 */

/**
 * Minimal structural shape of the pi ExtensionContext slice confirmSwitch needs
 * (arch.md §7: `{ mode, hasUI, ui: { select } }`). Declared locally because `src/topic-switch/types.ts`
 * (package P1) is written in parallel; P3b reconciles if P1 lands a `ConfirmCtx` of its own.
 */
export interface ConfirmCtx {
  mode: string;
  hasUI: boolean;
  ui?: {
    select?: (
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal; timeout?: number },
    ) => Promise<string | undefined>;
  };
}

export type ConfirmOutcome =
  { kind: "switch" | "stay"; by: "tui" | "web" } | { kind: "timeout" | "cancel" | "unavailable" | "error" | "aborted" };

export interface ConfirmText {
  title: string;
  switchLabel: string;
  stayLabel: string;
  preview: string;
  header: string;
}

/** Preview cap for the held request shown under the question (arch.md §7: first 120 chars). */
export const CONFIRM_PREVIEW_MAX_CODEPOINTS = 120;
/**
 * When `ui.select` auto-dismisses (its own `timeout` option) it may return `undefined` a moment
 * before our self-managed timer fires; that residual skew is classified as timeout (plan §P3a).
 */
const TIMEOUT_CLASSIFY_SLACK_MS = 250;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * P3a finding (b): `clock.now()` is called twice inside the Promise executor (the start
 * timestamp and the timeout-vs-cancel classification). A throw there, unguarded, would make the
 * `new Promise` executor itself throw — which turns into a REJECTED promise (the one thing
 * `confirmSwitch` must never do, per its own doc comment). `Date.now()` never throws, so it is a
 * safe fallback that keeps the classification merely less precise, never broken.
 */
function safeNow(clock: Clock): number {
  try {
    return clock.now();
  } catch {
    return Date.now();
  }
}

/** Chinese confirm copy (arch.md §7). `confidence` 0–1, `estUsd` the priced lower-bound estimate. */
export function buildConfirmText(i: {
  confidence: number;
  estUsd: number;
  request: string;
  imageCount: number;
}): ConfirmText {
  const confidence = clampNumber(i.confidence, 0, 1).toFixed(2);
  const usd = clampNumber(i.estUsd, 0, Number.MAX_SAFE_INTEGER).toFixed(2);
  const images = i.imageCount > 0 ? `这条请求附带 ${i.imageCount} 张图片。` : "";
  return {
    title:
      `这条请求看起来与当前会话无关（置信度 ${confidence}）。` +
      `缓存已过期，在本会话继续预计这一次就要 ≈$${usd}。${images}`,
    switchLabel: "切到新会话处理这条请求",
    stayLabel: "留在当前会话（本会话不再提示）",
    preview: Array.from(i.request).slice(0, CONFIRM_PREVIEW_MAX_CODEPOINTS).join(""),
    header: "新会话?",
  };
}

function webOutcomeToConfirm(outcome: RemoteOutcome, text: ConfirmText): ConfirmOutcome {
  if (outcome.kind === "cancel") return { kind: "cancel" };
  // Answers are keyed by header; any value matching a label decides (plan §P3a:
  // 任一值 === switchLabel ⇒ switch；allowOther:false keeps values ⊆ the two labels).
  const values = Object.values(outcome.answers);
  if (values.includes(text.switchLabel)) return { kind: "switch", by: "web" };
  if (values.includes(text.stayLabel)) return { kind: "stay", by: "web" };
  return { kind: "cancel" };
}

/**
 * Show the switch/stay confirmation and resolve with the first answer.
 *
 * Channels (plan §P3a): `tui` ⇒ select ⟂ remote; `rpc` ⇒ remote only when present, else select
 * only; `!hasUI` or no channel at all ⇒ `unavailable` without prompting. The external `signal`
 * aborts both sides immediately and resolves `aborted`; timeout resolves `timeout` here (D4:
 * stay + cooldown is the caller's decision). Before the promise resolves the remote session has
 * been closed exactly once, the local select has received its abort and every timer is cleared;
 * any callback arriving afterwards is a no-op.
 */
export function confirmSwitch(
  ctx: ConfirmCtx,
  remote: AskUserRemotePort | undefined,
  text: ConfirmText,
  o: { timeoutMs: number; clock: Clock; id: string; signal: AbortSignal },
): Promise<ConfirmOutcome> {
  if (!ctx.hasUI) return Promise.resolve({ kind: "unavailable" });
  if (o.signal.aborted) return Promise.resolve({ kind: "aborted" });

  const select = typeof ctx.ui?.select === "function" ? ctx.ui.select : undefined;

  // Web dialog (best effort): open errors / undefined degrade to local-only (plan §P3a).
  let session: AskUserRemoteSession | undefined;
  if (remote !== undefined) {
    try {
      session = remote.open({
        toolCallId: "topic-switch:" + o.id,
        questions: [
          {
            question: text.title + "\n\n" + text.preview,
            header: text.header,
            options: [{ label: text.switchLabel }, { label: text.stayLabel }],
            allowOther: false,
          },
        ],
        allowCancel: true,
        // P3a finding (a): the local `ctx.ui.select` below is opened with this exact title — passing
        // it lets `src/web-hub/agent/dialogs.ts`'s `attributePrompt` fold the native select's
        // `ui_prompt_start` event into this same dialog record instead of surfacing a second,
        // unattributed "blocked on dialog" banner for it.
        attributionTitle: text.title + "\n\n" + text.preview,
      });
    } catch {
      session = undefined;
    }
  }
  if (session === undefined && select === undefined) return Promise.resolve({ kind: "unavailable" });

  return new Promise<ConfirmOutcome>((resolve) => {
    const race = createDialogRace();
    const localAbort = new AbortController();
    const startedAt = safeNow(o.clock);
    let settled = false;
    let sessionClosed = false;
    let timer: TimerHandle | undefined;

    /** Our one and only close call per invocation; the bridge's own web-win close never passes here. */
    const closeSession = (by: "tui" | "abort" | "error", outcome: "answered" | "cancelled" | "aborted"): void => {
      if (sessionClosed || session === undefined) return;
      sessionClosed = true;
      try {
        session.close(by, outcome);
      } catch {
        /* best-effort: never break settlement */
      }
    };

    const settle = (outcome: ConfirmOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        try {
          o.clock.clearTimer(timer);
        } catch {
          /* best-effort: never break settlement */
        }
        timer = undefined;
      }
      try {
        o.signal.removeEventListener("abort", onAbort);
      } catch {
        /* idempotent */
      }
      // The local select has a single dismiss path; firing it after its own answer is a no-op.
      localAbort.abort();
      resolve(outcome);
    };

    const onAbort = (): void => {
      if (settled || !race.claim("abort")) return;
      closeSession("abort", "aborted");
      settle({ kind: "aborted" });
    };

    const onTimeout = (): void => {
      timer = undefined;
      if (settled) return;
      // Freeze arbitration so a web answer racing the deadline is rejected, not recorded late.
      race.claim("abort");
      closeSession("abort", "aborted");
      settle({ kind: "timeout" });
    };

    const onSelect = (choice: string | undefined): void => {
      if (settled) return; // late: web / abort / timeout already settled
      if (choice !== undefined) {
        if (!race.claim("tui")) return;
        closeSession("tui", "answered");
        settle(
          choice === text.switchLabel
            ? { kind: "switch", by: "tui" }
            : choice === text.stayLabel
              ? { kind: "stay", by: "tui" }
              : { kind: "cancel" },
        );
        return;
      }
      // Dismissed without an answer: external abort, web win and our own timeout have all
      // settled above; what is left is the select's auto-timeout versus a user Esc.
      if (safeNow(o.clock) - startedAt >= o.timeoutMs - TIMEOUT_CLASSIFY_SLACK_MS) {
        race.claim("abort");
        closeSession("abort", "aborted");
        settle({ kind: "timeout" });
      } else {
        race.claim("tui");
        closeSession("tui", "cancelled");
        settle({ kind: "cancel" });
      }
    };

    const onSelectError = (): void => {
      if (settled) return;
      race.claim("error");
      closeSession("error", "aborted");
      settle({ kind: "error" });
    };

    const onWeb = (outcome: RemoteOutcome): boolean => {
      if (settled || !race.claim("web")) return false;
      // The bridge finishes the record itself when we return true (dialogs.ts answer/cancel),
      // so our own close must stay silent on the web-win path.
      sessionClosed = true;
      localAbort.abort();
      settle(webOutcomeToConfirm(outcome, text));
      return true;
    };

    if (session !== undefined) {
      try {
        session.setOnRemote(onWeb);
      } catch {
        // A port that cannot take the callback cannot deliver answers: kill the session and
        // degrade to local-only below (rpc: "有 remote 只用 remote，否则只 select").
        sessionClosed = true;
        try {
          session.close("error", "aborted");
        } catch {
          /* best-effort */
        }
        session = undefined;
      }
    }

    // rpc keeps a single channel (web when attached, else select) to avoid double-rendering.
    const useWeb = session !== undefined;
    const useTui = !(ctx.mode === "rpc" && useWeb) && select !== undefined;
    if (!useTui && !useWeb) {
      settle({ kind: "unavailable" });
      return;
    }

    try {
      o.signal.addEventListener("abort", onAbort, { once: true });
    } catch {
      /* a signal that cannot take listeners cannot abort; the timeout still bounds us */
    }

    // P3a finding (b): an unguarded throw here is the same "executor throws ⇒ rejected promise"
    // hazard as `clock.now()` above. Without a timer we cannot bound this dialog at all, so the
    // safe (never-hang, never-reject) move is to settle immediately as `error` (ui-unavailable,
    // no cooldown, same fail-open family as every other confirm-channel failure) rather than
    // leave either channel waiting with no deadline.
    try {
      timer = o.clock.setTimer(o.timeoutMs, onTimeout);
    } catch {
      closeSession("error", "aborted");
      settle({ kind: "error" });
      return;
    }

    if (useTui) {
      try {
        const pending = select!(text.title + "\n\n" + text.preview, [text.switchLabel, text.stayLabel], {
          timeout: o.timeoutMs,
          signal: localAbort.signal,
        });
        void pending.then(onSelect, onSelectError);
      } catch {
        onSelectError();
      }
    }
  });
}
