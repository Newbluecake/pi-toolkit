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
}

export const ASK_FORM: InjectionKey<AskFormCtx> = Symbol("web-hub-ask-form");
