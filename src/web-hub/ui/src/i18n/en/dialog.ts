/**
 * `dialog` i18n namespace (control-plan.md v2.1 §5, §7.6 — C5): the ask_user dual-channel form —
 * question tabs, options, Other, submit/cancel, race-lost folding and the hub-restart suspended
 * state.
 */
const dialog = {
  formAria: "Agent question",
  alsoInTerminal: "Also answerable in the terminal — first answer wins.",
  questionTab: "Question {n}",
  questionTabAria: "Question {n}: {header}",
  other: "Other",
  otherAria: "Other — type your own answer",
  otherPlaceholder: "Type your own answer…",
  submit: "Submit",
  submitAria: "Submit answers",
  cancel: "Cancel",
  cancelConfirm: "Confirm cancel",
  cancelAria: "Cancel this dialog",
  cancelArmed: "Armed — click again to confirm cancelling, Esc to go back",
  suspended:
    "The hub is upgrading — please answer in the terminal; if it is still unanswered when the hub is back, this form recovers automatically.",
  epochChanged: "This form was rendered before the terminal reloaded — review and answer again.",
  // race-lost / terminal folding (§7.4: read dialogs.closed[].by)
  closedTui: "Answered in the terminal",
  closedWeb: "Answered in another browser",
  closedHere: "Answered",
  closedAbort: "Agent aborted",
  closedSession: "Session ended",
  closedError: "Dialog closed with an error",
  cancelledTui: "Cancelled in the terminal",
  cancelledWeb: "Cancelled in another browser",
  cancelledHere: "Cancelled",
  closedGeneric: "Dialog closed",
} satisfies Record<string, string>;

export default dialog;
