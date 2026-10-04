import type { AskUserAnswers, AskUserQuestion } from "./channel-handler.js";

export type RemoteOutcome =
  { kind: "answer"; answers: AskUserAnswers; origin: string } | { kind: "cancel"; origin: string };

export interface DialogRace {
  claim(by: "tui" | "web" | "abort" | "error" | "background"): boolean;
  readonly winner: "tui" | "web" | "abort" | "error" | "background" | undefined;
}

export interface AskUserRemoteSession {
  /** Return false when the local/TUI side has already won the race. */
  setOnRemote(fn: (outcome: RemoteOutcome) => boolean): void;
  /**
   * Close the local side of the session. Calling this more than once is safe.
   *
   * §5.1 also specifies `by: "background"` for the interrupt close. It is DELIBERATELY not in
   * this signature yet: src/web-hub/agent/dialogs.ts's implementation forwards `by` into
   * `DialogClosedWire["by"]` (src/web-hub/protocol/messages.ts), which only gains
   * `"background"` in P3 — widening here would break that file's typecheck while web-hub is
   * out of P1's file domain. index.ts performs the background close through a local,
   * documented cast (closeSessionAsBackground); P3 widens this union and drops the cast.
   */
  close(by: "tui" | "abort" | "error", outcome: "answered" | "cancelled" | "aborted"): void;
}

export interface AskUserRemotePort {
  open(req: {
    toolCallId: string;
    questions: AskUserQuestion[];
    allowCancel: boolean;
  }): AskUserRemoteSession | undefined;
}

/**
 * The only arbitration primitive used by ask_user's two channels.
 *
 * This deliberately does not involve a Promise (or a queued microtask): both
 * the TUI callback and the remote callback call claim synchronously in the
 * same event loop.  Consequently the first callback to enter this function is
 * the winner, including when the callbacks happen in the same turn.
 */
export function createDialogRace(): DialogRace {
  let winner: DialogRace["winner"];
  return {
    claim(by) {
      if (winner !== undefined) return false;
      winner = by;
      return true;
    },
    get winner() {
      return winner;
    },
  };
}
