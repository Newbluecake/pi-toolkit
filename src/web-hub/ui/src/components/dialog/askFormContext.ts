/**
 * Ask-user form context (control-plan.md v2.1 §7.4 — C5 exclusive, `components/dialog/**`).
 *
 * The frozen `contracts.ts` gives `AskUserQuestionProps` exactly one field (`question`) and no
 * emits, so a question component reports its selection through this provided context instead:
 * the form owns a reactive `selections` array (one entry per question, matched by object
 * identity against `questions`) and the question components mutate their slot in place. Draft
 * persistence lives in the form (§3.5's `(agentKey, epoch, dialogId)` key, stored in
 * `CONTROL_ENV.dialogDrafts` so switching agents doesn't lose a half-filled form).
 */
import type { ComputedRef, InjectionKey } from "vue";

export interface AskSelection {
  selected: string[];
  other: string | null;
}

export interface AskFormCtx {
  readonly questions: readonly unknown[];
  readonly selections: AskSelection[];
  readonly suspended: ComputedRef<boolean>;
  /** Persist the current selections into the draft map (called on every change). */
  saveDraft(): void;
  /**
   * Whether question `index` currently counts as answered (a non-empty single/multi
   * selection, or non-blank Other text). Single source of truth shared by the form's
   * auto-advance scan, the per-tab "answered" mark, and `AskUserQuestion`'s pre-mutation
   * `wasAnswered` snapshot.
   */
  isAnswered(index: number): boolean;
  /**
   * A single-select (radio) answer was just picked for question `index` (2026-10 mobile UX:
   * multi-question dialogs auto-advance to the next unanswered tab). Never called for a
   * `multiSelect` toggle or an Other free-text edit — neither has a reliable "done" moment, so
   * forcing a tab switch there would yank focus out from under a user still typing/picking.
   * Optional so isolated `AskUserQuestion` tests (mounted without a form context) stay inert.
   *
   * `wasAnswered` is the caller's pre-mutation snapshot of `isAnswered(index)` (2026-10
   * revision UX): the form only auto-advances on a question's FIRST answer
   * (unanswered → answered). Revising an already-answered question updates the selection in
   * place and stays on that tab — the user deliberately navigated back to it.
   */
  onAnswered?(index: number, wasAnswered: boolean): void;
}

export const ASK_FORM: InjectionKey<AskFormCtx> = Symbol("web-hub-ask-form");
