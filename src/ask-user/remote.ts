import type { AskUserAnswers, AskUserQuestion } from "./channel-handler.js";

export type RemoteOutcome =
  { kind: "answer"; answers: AskUserAnswers; origin: string } | { kind: "cancel"; origin: string };

export interface DialogRace {
  claim(by: "tui" | "web" | "abort" | "error"): boolean;
  readonly winner: "tui" | "web" | "abort" | "error" | undefined;
}

export interface AskUserRemoteSession {
  /** Return false when the local/TUI side has already won the race. */
  setOnRemote(fn: (outcome: RemoteOutcome) => boolean): void;
  /** Close the local side of the session. Calling this more than once is safe. */
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
