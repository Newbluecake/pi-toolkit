import { describe, expect, it } from "vitest";
import { AskUserComponent } from "../../src/ask-user/component.js";
import type { Question, Result } from "../../src/ask-user/types.js";
import {
  DOWN,
  ENTER,
  ESC,
  LEFT,
  RIGHT,
  TAB,
  BKSP,
  mockTui,
  multiQ,
  singleQ,
  singleQMulti,
  stubTheme,
} from "./fixtures.js";

function make(questions: Question[], onActivity?: () => void) {
  const calls: Array<Result | null> = [];
  const c = new AskUserComponent(questions, mockTui, stubTheme, (result) => calls.push(result), { onActivity });
  return { c, calls };
}

describe("AskUserComponent", () => {
  it("submits a single selection and has no tab bar", () => {
    const { c, calls } = make([singleQ]);
    expect(c.render(60).join("\n")).not.toContain("Submit");
    c.handleInput(ENTER);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.answers["Which DB?"]).toEqual({ selected: ["Postgres"], other: null });
  });

  it("supports multi-select and auto-confirms answered tabs", () => {
    const { c, calls } = make(multiQ);
    c.handleInput(ENTER);
    c.handleInput(ENTER);
    c.handleInput(ENTER);
    c.handleInput(ENTER);
    c.handleInput(ENTER);
    expect(calls[0]?.cancelled).toBe(false);
    expect(calls[0]?.answers.Q1).toEqual({ selected: ["A"], other: null });
  });

  it("keeps freeDraft separate from the formal answer and blocks submit after discard", () => {
    const { c, calls } = make(multiQ);
    c.handleInput(DOWN);
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput("draft");
    c.handleInput(ESC);
    c.handleInput(RIGHT);
    c.handleInput(RIGHT);
    c.handleInput(RIGHT);
    c.handleInput(ENTER);
    expect(calls).toHaveLength(0);
    const visible = c.render(80).join("\n");
    expect(visible).toContain("Unanswered questions");
  });

  it("Other Enter clears a single selection and submits the freeform answer", () => {
    const { c, calls } = make([singleQ]);
    c.handleInput(DOWN);
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput("custom");
    c.handleInput(ENTER);
    expect(calls[0]?.answers["Which DB?"]).toEqual({ selected: [], other: "custom" });
  });

  it("allows multi-select options and Other to coexist", () => {
    const { c, calls } = make([singleQMulti]);
    c.handleInput(" ");
    c.handleInput(DOWN);
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput("redis");
    c.handleInput(ENTER);
    expect(calls[0]?.answers["Which features?"]).toEqual({ selected: ["Auth"], other: "redis" });
  });

  it("uses an Esc confirmation overlay and resolves only once", () => {
    const { c, calls } = make([singleQ]);
    c.handleInput(ESC);
    expect(calls).toHaveLength(0);
    expect(c.render(60).join("\n")).toContain("Cancel all");
    c.handleInput(ESC);
    c.cancel();
    c.handleInput(ENTER);
    expect(calls).toEqual([null]);
  });

  it("caches render output and invalidates after input", () => {
    const { c } = make([singleQ]);
    const first = c.render(60);
    expect(c.render(60)).toBe(first);
    c.handleInput(DOWN);
    expect(c.render(60)).not.toBe(first);
  });

  it("navigates Submit focus with Tab and enforces a non-empty gate", () => {
    const { c, calls } = make(multiQ);
    c.handleInput(RIGHT);
    c.handleInput(RIGHT);
    c.handleInput(RIGHT);
    c.handleInput(ENTER);
    expect(calls).toHaveLength(0);
    c.handleInput(TAB);
    expect(c.render(80).join("\n")).toContain("Cancel");
    c.handleInput(ENTER);
    expect(calls).toEqual([null]);
  });

  it("emits activity for input and ignores input after resolution", () => {
    const activity = [] as number[];
    const { c } = make([singleQ], () => activity.push(1));
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput(DOWN);
    expect(activity).toHaveLength(2);
  });

  it("deletes emoji safely in freeform", () => {
    const { c } = make([singleQ]);
    c.handleInput(DOWN);
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput("a😀");
    c.handleInput(BKSP);
    expect(c.render(60).join("\n")).toContain("a");
    expect(c.render(60).join("\n")).not.toContain("😀");
  });
});

describe("AskUserComponent — per-question skip (「我可以不回答这个问题」)", () => {
  it("Enter on the Skip row submits a single-question dialog as skipped", () => {
    const { c, calls } = make([singleQ]);
    c.handleInput(DOWN); // SQLite
    c.handleInput(DOWN); // Other
    c.handleInput(DOWN); // Skip
    expect(c.render(60).join("\n")).toContain("Enter skip");
    c.handleInput(ENTER);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cancelled).toBe(false);
    expect(calls[0]?.answers["Which DB?"]).toEqual({ selected: [], other: null, skipped: true });
  });

  it("'s' skips the current question from anywhere on the option list (single ⇒ submits)", () => {
    const { c, calls } = make([singleQ]);
    c.handleInput("s");
    expect(calls[0]?.answers["Which DB?"]).toEqual({ selected: [], other: null, skipped: true });
  });

  it("'s' is ordinary text inside the Other editor, never a skip", () => {
    const { c, calls } = make([singleQ]);
    c.handleInput(DOWN);
    c.handleInput(DOWN); // Other row
    c.handleInput(ENTER); // open editor
    c.handleInput("s");
    c.handleInput(ENTER); // submit the freeform text
    expect(calls[0]?.answers["Which DB?"]).toEqual({ selected: [], other: "s" });
  });

  it("multi-question: skipping advances and the submit view marks the question — skipped", () => {
    const { c, calls } = make(multiQ);
    c.handleInput("s"); // skip Q1 ⇒ advance to Q2
    c.handleInput(ENTER); // Q2 (multiSelect): pick X and confirm ⇒ Q3
    c.handleInput(ENTER); // Q3: select M ⇒ submit tab
    const view = c.render(80).join("\n");
    expect(view).toContain("— skipped");
    expect(view).toContain("Ready to submit");
    c.handleInput(ENTER);
    expect(calls[0]?.answers.Q1).toEqual({ selected: [], other: null, skipped: true });
    expect(calls[0]?.answers.Q2).toEqual({ selected: ["X"], other: null });
    expect(calls[0]?.answers.Q3).toEqual({ selected: ["M"], other: null });
  });

  it("submitting with EVERY question skipped is allowed", () => {
    const { c, calls } = make(multiQ);
    c.handleInput("s"); // Q1 ⇒ Q2
    c.handleInput("s"); // Q2 ⇒ Q3
    c.handleInput("s"); // Q3 ⇒ submit tab
    expect(c.render(80).join("\n")).toContain("Ready to submit");
    c.handleInput(ENTER);
    expect(calls).toHaveLength(1);
    for (const q of ["Q1", "Q2", "Q3"]) {
      expect(calls[0]?.answers[q]).toEqual({ selected: [], other: null, skipped: true });
    }
  });

  it("answering after a skip retracts it (skip is not sticky)", () => {
    const { c, calls } = make(multiQ);
    c.handleInput("s"); // skip Q1 ⇒ Q2
    c.handleInput(LEFT); // back to Q1
    c.handleInput(ENTER); // select A — retracts the skip
    c.handleInput(ENTER); // Q2: pick X
    c.handleInput(ENTER); // Q3: pick M ⇒ submit tab
    c.handleInput(ENTER);
    expect(calls[0]?.answers.Q1).toEqual({ selected: ["A"], other: null });
    expect(calls[0]?.answers.Q2).toEqual({ selected: ["X"], other: null });
    expect(calls[0]?.answers.Q3).toEqual({ selected: ["M"], other: null });
  });

  it("typing an Other answer after a skip retracts it too", () => {
    const { c, calls } = make(multiQ);
    c.handleInput("s"); // skip Q1 ⇒ Q2
    c.handleInput(LEFT); // back to Q1
    c.handleInput(DOWN);
    c.handleInput(DOWN); // Other row
    c.handleInput(ENTER); // open editor
    c.handleInput("custom");
    c.handleInput(ENTER); // confirm ⇒ retracts the skip, advances
    c.handleInput(ENTER); // Q2: pick X
    c.handleInput(ENTER); // Q3: pick M ⇒ submit tab
    c.handleInput(ENTER);
    expect(calls[0]?.answers.Q1).toEqual({ selected: [], other: "custom" });
  });

  it("multiSelect toggle after a skip retracts it", () => {
    const { c, calls } = make(multiQ);
    c.handleInput(RIGHT); // Q2 (multiSelect)
    c.handleInput("s"); // skip Q2 ⇒ Q3
    c.handleInput(LEFT); // back to Q2
    c.handleInput(" "); // toggle X on — retracts the skip (no confirm yet)
    c.handleInput(ENTER); // confirm ⇒ Q3
    c.handleInput(LEFT);
    c.handleInput(LEFT); // Q1
    c.handleInput(ENTER); // select A ⇒ Q2
    c.handleInput(RIGHT); // Q3
    c.handleInput(ENTER); // select M ⇒ submit tab
    c.handleInput(ENTER);
    expect(calls[0]?.answers.Q1).toEqual({ selected: ["A"], other: null });
    expect(calls[0]?.answers.Q2).toEqual({ selected: ["X"], other: null });
    expect(calls[0]?.answers.Q3).toEqual({ selected: ["M"], other: null });
  });

  it("'s' a second time un-skips and the submit gate closes again", () => {
    const { c, calls } = make(multiQ);
    c.handleInput("s"); // skip Q1 ⇒ Q2
    c.handleInput(LEFT); // back to Q1
    c.handleInput("s"); // un-skip Q1 (nothing selected anymore ⇒ unanswered)
    c.handleInput(RIGHT); // Q2
    c.handleInput(ENTER); // pick X ⇒ Q3
    c.handleInput(ENTER); // pick M ⇒ submit tab
    const view = c.render(80).join("\n");
    expect(view).toContain("Unanswered questions");
    expect(view).toContain("Still needed: First");
    c.handleInput(ENTER);
    expect(calls).toHaveLength(0);
  });

  it("persists skipped through draft snapshot/restore (interrupt → re-ask)", () => {
    const { c } = make(multiQ);
    c.handleInput("s"); // skip Q1 ⇒ Q2
    const draft = c.snapshotDraft();
    expect(draft.states[0]?.skipped).toBe(true);
    expect(draft.states[1]?.skipped).toBe(false);

    const calls: Array<Result | null> = [];
    const restored = new AskUserComponent(multiQ, mockTui, stubTheme, (result) => calls.push(result), {
      initialDraft: draft,
    });
    expect(restored.render(80).join("\n")).toContain("resumed");
    restored.handleInput(ENTER); // Q2 (restored activeTab): pick X ⇒ Q3
    restored.handleInput(ENTER); // Q3: pick M ⇒ submit tab
    restored.handleInput(ENTER); // submit
    expect(calls[0]?.answers.Q1).toEqual({ selected: [], other: null, skipped: true });
  });
});
