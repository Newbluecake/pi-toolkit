/**
 * #61 decision-wake (plan.md §3, r2): the host-private HUMAN INPUT PROOF for the decision-wake
 * budget. Pure data + pure functions; no pi imports; no module-scope mutable state (I4).
 *
 * Why this exists: the SDK's public `InputEvent` carries only `{text, images?, source,
 * streamingBehavior?}` — `source` is `"interactive"` for BOTH the real TUI submit loop
 * (`interactive-mode.js` calls `session.prompt(text)` with no options) and ANY in-process
 * programmatic `session.prompt()` call, and `"rpc"` for BOTH a human at an RPC terminal and a
 * machine RPC client (`rpc-mode.js` stamps every prompt/steer/follow_up). A model-facing message
 * can therefore never be distinguished from a human submission through those seams — they are
 * `provenance_unavailable` for the decision budget (offline evidence:
 * `tests/conformance/fabric-decision-input.test.ts`).
 *
 * The ONLY provable entry in P0 is the web command prompt: `src/web-hub/agent/commands.ts`
 * settles it through the server-side ledger `begin()` (cmdId dedup + digest check) with a
 * recorded `origin` (Feishu refused), and dispatches exactly one `sendUserMessage` per cmdId.
 * The production PRODUCER that feeds this observer from that seam is P2 wiring; P0 ships the
 * port + the offline capability proof, and "default on" never mints budget by itself.
 *
 * Authority rules (plan §3, verbatim):
 *  - `observeHumanInput` is host-only. Model parameters, message `role`/content, `source`,
 *    `ui_prompt_start`, TaskList state, schedule, fabric/xs and replay NEVER construct a proof.
 *  - One epoch per DISTINCT proven inputId. Replay of a seen inputId never increments, never
 *    re-opens a window (bounded dedup; full ⇒ fail-closed, never evict-and-accept).
 *  - LAZY activation: before the first legal decision request nothing is persisted, no timer
 *    runs and no budget is consumed. The first request checkpoints the CURRENT proof; a reload
 *    that loses an un-activated proof leaves the budget at 0 (conservative).
 *  - The epoch counter is completely independent of `wake-level.ts`'s `resetRoot()` (a Root
 *    already at 0 still opens a new window; two consecutive human inputs open two windows).
 */

/** Host-private provenance DTO — the single source for what may open a decision-wake window. */
export interface DecisionHumanProof {
  /** Custom-entry schema version. */
  v: 1;
  /** The session whose human input this is; mismatched bindings are rejected, never migrated. */
  sessionId: string;
  /** Root owner incarnation this proof was observed for (owner authority is host-owned). */
  owner: string;
  /** Host-assigned unique input id (P0/P2: the web command cmdId; server-side, one-shot). */
  inputId: string;
  /** Wall-clock observation time (audit only; never participates in authority). */
  at: number;
  /** Which trusted ingress produced it. P0 vocabulary: the admitted web prompt path only. */
  provenance: "web_prompt";
}

/** Persisted activation checkpoint (plan §3 "已激活后"): the session high-watermark. */
export interface DecisionInputCheckpoint {
  v: 1;
  sessionId: string;
  owner: string;
  /** Highest proven epoch (0 ⇒ never activated). */
  epoch: number;
  /** The inputId that opened that epoch (dedup anchor). */
  inputId: string;
  /** Bounded seen-inputId digest for the checkpointed window (dedup after reload). */
  seen: ReadonlyArray<string>;
}

/** `observe()` outcome — `fail_closed` is NEVER silently treated as a replay or a new proof. */
export type DecisionObserveOutcome =
  | { status: "new_proof"; epoch: number }
  | { status: "replay" }
  | { status: "fail_closed"; reason: "binding" | "capacity" | "frozen" };

export interface DecisionInputObserver {
  /** Host-only ingress. Same inputId twice ⇒ replay; a full dedup ⇒ fail-closed. */
  observe(inputId: string): DecisionObserveOutcome;
  /** Current proven window anchor, iff at least one proof was observed (`undefined` ⇒ 0 budget). */
  current(): { epoch: number; inputId: string } | undefined;
  /** Has this exact inputId already been proven (used by restore reconciliation)? */
  seen(inputId: string): boolean;
  /** Activation checkpoint — the ONLY thing that ever leaves this module for persistence. */
  checkpoint(): DecisionInputCheckpoint;
  /** Restore an activated checkpoint (reload): keeps the high-watermark, never lowers it. */
  restore(checkpoint: DecisionInputCheckpoint): void;
  /** Owner/session invalidated (switch/new/fork/dispose): freeze — no further proofs count. */
  freeze(): void;
  /** Test/inspection only. */
  readonly epoch: number;
}

/** Bounded dedup capacity (plan §3: "有界 dedup，满则 fail-closed"). */
export const DECISION_INPUT_DEDUP_CAP = 256;

export function createDecisionInputObserver(init: {
  sessionId: string;
  owner: string;
  /** Optional small cap for tests. */
  cap?: number;
}): DecisionInputObserver {
  const cap = init.cap ?? DECISION_INPUT_DEDUP_CAP;
  const seenIds: string[] = [];
  let epoch = 0;
  let currentInput: string | undefined;
  let frozen = false;

  const observer: DecisionInputObserver = {
    observe(inputId) {
      if (frozen) return { status: "fail_closed", reason: "frozen" };
      if (typeof inputId !== "string" || inputId.length === 0) return { status: "fail_closed", reason: "binding" };
      if (seenIds.includes(inputId)) return { status: "replay" };
      if (seenIds.length >= cap) return { status: "fail_closed", reason: "capacity" };
      seenIds.push(inputId);
      epoch += 1;
      currentInput = inputId;
      return { status: "new_proof", epoch };
    },
    current() {
      return currentInput === undefined ? undefined : { epoch, inputId: currentInput };
    },
    seen(inputId) {
      return seenIds.includes(inputId);
    },
    checkpoint() {
      return {
        v: 1,
        sessionId: init.sessionId,
        owner: init.owner,
        epoch,
        inputId: currentInput ?? "",
        seen: [...seenIds],
      };
    },
    restore(checkpoint) {
      // A checkpoint from another session/owner is not this observer's history: ignore it
      // (the caller re-checks bindings; a mismatched restore never grants anything).
      if (checkpoint.v !== 1 || checkpoint.sessionId !== init.sessionId || checkpoint.owner !== init.owner) return;
      for (const id of checkpoint.seen ?? []) if (!seenIds.includes(id)) seenIds.push(id);
      if (seenIds.length > cap) seenIds.length = cap;
      const restored = Math.max(0, Math.floor(checkpoint.epoch));
      if (restored > epoch) {
        epoch = restored;
        currentInput = checkpoint.inputId || currentInput;
      }
    },
    freeze() {
      frozen = true;
    },
    get epoch() {
      return epoch;
    },
  };
  return observer;
}

/**
 * Shape guard for a proof produced by a trusted host ingress (used by the P2 producer contract
 * and by tests): the DTO never carries text, role, source or any model-visible field, so nothing
 * model-authored can satisfy it — not even by ADDING such fields to an otherwise valid proof
 * (exact key set; a forged carrier object fails closed).
 */
const PROOF_KEYS = ["v", "sessionId", "owner", "inputId", "at", "provenance"] as const;

export function isDecisionHumanProof(value: unknown): value is DecisionHumanProof {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== PROOF_KEYS.length || [...PROOF_KEYS].sort().some((k, i) => keys[i] !== k)) return false;
  const v = value as DecisionHumanProof;
  return (
    v.v === 1 &&
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.owner === "string" &&
    v.owner.length > 0 &&
    typeof v.inputId === "string" &&
    v.inputId.length > 0 &&
    typeof v.at === "number" &&
    Number.isFinite(v.at) &&
    v.provenance === "web_prompt"
  );
}
