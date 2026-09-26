/**
 * Main-session todo staleness nudge (L1 feature) — pure logic only, no pi
 * imports. src/todo/index.ts owns all the pi wiring (event handlers,
 * sendMessage, settings); this module only knows about counters, cooldown
 * backoff and text rendering, so it is table-driven-testable without any
 * fake ExtensionAPI.
 *
 * Model (per the confirmed design):
 *  - Three counters accumulate from the last Task* tool call (any of
 *    TaskCreate/Update/Delete/List/Get zeroes ALL of them): E1 (completion
 *    notifications delivered), E2 (successful git write commands), E3 (turns).
 *  - Evidence trigger: E1+E2 >= 1 AND `graceTurns` turns have passed since the
 *    FIRST unconfirmed evidence since the last touch (age keeps growing even
 *    if more evidence arrives later — it is anchored to the first sighting).
 *  - Fallback trigger: zero evidence AND E3 >= fallbackTurns.
 *  - Cooldown: after firing, `cooldownTurns` turns of silence. Counters are
 *    NOT reset by a fire (only a todo touch resets them) — so if the model
 *    still hasn't touched todo when the cooldown lapses, the same still-true
 *    candidate fires again, backing off exponentially (double the previous
 *    cooldown length, capped at 4x the base) until a touch resets everything.
 */

export interface NudgeConfig {
  readonly graceTurns: number;
  readonly fallbackTurns: number;
  readonly cooldownTurns: number;
}

export const DEFAULT_NUDGE_CONFIG: NudgeConfig = {
  graceTurns: 2,
  fallbackTurns: 20,
  cooldownTurns: 8,
};

/** Cooldown backoff cap, expressed as a multiple of the configured base (spec: 8→16→32 for base 8). */
const COOLDOWN_BACKOFF_CAP_MULTIPLIER = 4;

export type EvidenceKind = "e1" | "e2";

export interface NudgeState {
  readonly e1: number;
  readonly e2: number;
  readonly e3: number;
  /** Turns elapsed since the FIRST unconfirmed E1/E2 evidence since the last touch; null = no evidence yet. */
  readonly evidenceAgeTurns: number | null;
  /** Turns still blocked by cooldown; 0 = eligible to fire again. */
  readonly cooldownTurnsLeft: number;
  /** Current cooldown window length (the backoff state carried across fires). */
  readonly cooldownLength: number;
  /** Consecutive fires with no todo touch in between (0 right after a touch/reset). */
  readonly noTouchStreak: number;
}

/** Fresh counters, no evidence, no active cooldown. Used at wiring time and on every session_start/tree/compact. */
export function initNudgeState(config: NudgeConfig): NudgeState {
  return {
    e1: 0,
    e2: 0,
    e3: 0,
    evidenceAgeTurns: null,
    cooldownTurnsLeft: 0,
    cooldownLength: config.cooldownTurns,
    noTouchStreak: 0,
  };
}

/** Record one E1 (completion notification) or E2 (successful git write) occurrence. */
export function recordEvidence(state: NudgeState, kind: EvidenceKind): NudgeState {
  return {
    ...state,
    [kind]: Math.min(state[kind] + 1, COUNTER_CAP),
    evidenceAgeTurns: state.evidenceAgeTurns ?? 0,
  };
}

/** Any Task* tool call: zero every counter and fully reset the cooldown/backoff state. */
export function recordTodoTouch(_state: NudgeState, config: NudgeConfig): NudgeState {
  return initNudgeState(config);
}

export interface NudgeTickResult {
  readonly state: NudgeState;
  readonly fire: boolean;
}

/**
 * Called once per turn_end. `hasInProgressTask` is the current
 * (pending/in_progress-derived) precondition — with none in_progress, the
 * feature never fires regardless of any accumulated evidence.
 *
 * Cooldown semantics: `cooldownTurnsLeft` counts turns that are STILL
 * silent. Right after a fire it is set to the cooldown length (say 8); the
 * next 8 ticks are silent (decrementing 8→7→…→1→0) and the tick AFTER that
 * (the 9th) is the first one eligible to fire again — i.e. "cooldownTurns
 * 轮内不再提醒" counts turns, not fires.
 */
export function tickTurn(state: NudgeState, config: NudgeConfig, hasInProgressTask: boolean): NudgeTickResult {
  const e3 = Math.min(state.e3 + 1, COUNTER_CAP);
  const evidenceAgeTurns = state.evidenceAgeTurns === null ? null : Math.min(state.evidenceAgeTurns + 1, COUNTER_CAP);
  const wasCoolingDown = state.cooldownTurnsLeft > 0;
  const cooldownTurnsLeft = wasCoolingDown ? state.cooldownTurnsLeft - 1 : 0;
  const hasEvidence = state.e1 + state.e2 >= 1;
  const evidenceTrigger = hasEvidence && evidenceAgeTurns !== null && evidenceAgeTurns >= config.graceTurns;
  const fallbackTrigger = !hasEvidence && e3 >= config.fallbackTurns;
  const candidate = evidenceTrigger || fallbackTrigger;

  const ticked: NudgeState = { ...state, e3, evidenceAgeTurns, cooldownTurnsLeft };
  if (!candidate || !hasInProgressTask || wasCoolingDown) {
    return { state: ticked, fire: false };
  }

  const cap = config.cooldownTurns * COOLDOWN_BACKOFF_CAP_MULTIPLIER;
  const nextLength = state.noTouchStreak === 0 ? config.cooldownTurns : Math.min(ticked.cooldownLength * 2, cap);
  return {
    state: {
      ...ticked,
      cooldownTurnsLeft: nextLength,
      cooldownLength: nextLength,
      noTouchStreak: state.noTouchStreak + 1,
    },
    fire: true,
  };
}

export interface NudgeTaskSummary {
  readonly id: number | string;
  readonly subject: string;
}

export interface NudgeCounts {
  readonly e1: number;
  readonly e2: number;
  readonly e3: number;
}

const MAX_LISTED_TASKS = 5;
/**
 * Saturation cap for the E1/E2/E3 and evidence-age counters: every trigger
 * compares against small thresholds (grace 2, fallback 20, handoff 10), so
 * saturating far above them keeps long sessions bounded without changing any
 * decision.
 */
export const COUNTER_CAP = 10_000;
const MAX_TITLE_LENGTH = 60;

function truncateTitle(subject: string): string {
  // The ellipsis counts toward the cap: the rendered title never exceeds 60 chars.
  return subject.length > MAX_TITLE_LENGTH ? `${subject.slice(0, MAX_TITLE_LENGTH - 1)}…` : subject;
}

/**
 * Render the hidden nudge message body (Chinese prose per the UI-text
 * convention: this addresses the model, not a compact status line). A
 * zero-count evidence item is omitted entirely; at most 5 in_progress tasks
 * are listed, each title truncated to 60 chars.
 */
export function buildNudgeText(counts: NudgeCounts, inProgressTasks: readonly NudgeTaskSummary[]): string {
  const clauses: string[] = [];
  if (counts.e1 > 0) clauses.push(`${counts.e1} 个子 agent/workflow 完成`);
  if (counts.e2 > 0) clauses.push(`${counts.e2} 次 git 提交`);
  if (counts.e3 > 0) clauses.push(`已过 ${counts.e3} 轮`);
  const listed = inProgressTasks
    .slice(0, MAX_LISTED_TASKS)
    .map((task) => `#${task.id} ${truncateTitle(task.subject)}`)
    .join("、");
  return (
    `[todo] 自上次更新任务以来：${clauses.join("、")}。进行中：${listed}。` +
    "如状态或进度有变，请用 TaskUpdate 更新；没有变化可以忽略。"
  );
}

/** Command text matched against `git commit|merge|cherry-pick|rebase|revert` (E2). Heuristic, not a shell parser. */
const GIT_WRITE_COMMAND_RE = /\bgit\b[^\n;|&]*\b(?:commit|merge|cherry-pick|rebase|revert)\b/;

export function isGitWriteCommand(command: string): boolean {
  return GIT_WRITE_COMMAND_RE.test(command);
}

/**
 * Read-only snapshot the switch_context tool consumes (kept deliberately
 * generic — no todo-internal types) to append its own handoff advisory
 * without depending on the todo module's wiring.
 */
export interface TodoTrackerSnapshot {
  readonly openTaskCount: number;
  readonly turnsSinceTouch: number;
  readonly hasEvidence: boolean;
}

/** Turns-since-touch threshold used by the switch_context advisory when there is no E1/E2 evidence. Fixed, not user-configurable. */
export const HANDOFF_ADVISORY_MIN_TURNS = 10;

/**
 * Advisory line appended to switch_context's result when unfinished tasks
 * exist and either evidence fired or enough turns have passed without a
 * todo touch. Returns undefined when neither condition holds (nothing to
 * say) — the caller decides whether/how to append it; this never blocks.
 */
export function buildHandoffAdvisory(snapshot: TodoTrackerSnapshot): string | undefined {
  if (snapshot.openTaskCount <= 0) return undefined;
  if (!snapshot.hasEvidence && snapshot.turnsSinceTouch < HANDOFF_ADVISORY_MIN_TURNS) return undefined;
  return (
    `交接附录会带上 ${snapshot.openTaskCount} 个未完成任务，它们已 ${snapshot.turnsSinceTouch} 轮未更新；` +
    "如有过时，请先 TaskUpdate 再切换。"
  );
}
