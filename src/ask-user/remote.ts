import type { AskUserAnswers, AskUserQuestion } from "./channel-handler.js";
export type RemoteOutcome =
  { kind: "answer"; answers: AskUserAnswers; origin: string } | { kind: "cancel"; origin: string };
export interface DialogRace {
  claim(by: "tui" | "web" | "abort" | "error"): boolean;
  readonly winner: "tui" | "web" | "abort" | "error" | undefined;
}
export interface AskUserRemoteSession {
  setOnRemote(fn: (outcome: RemoteOutcome) => boolean): void;
  close(by: "tui" | "abort" | "error", outcome: "answered" | "cancelled" | "aborted"): void;
}
export interface AskUserRemotePort {
  open(req: {
    toolCallId: string;
    questions: AskUserQuestion[];
    allowCancel: boolean;
  }): AskUserRemoteSession | undefined;
}
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
