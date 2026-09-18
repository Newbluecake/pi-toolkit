// Ported behavior tests for src/session-nav/index.ts — pure input-rewrite
// predicates plus the SessionNavEditor submit-time rewrite, constructed
// headless with inline fakes (no TUI rendering, no real SessionManager).

import { describe, expect, test } from "vitest";
import { isClearInput, isExitInput, rewriteResumeInput, SessionNavEditor } from "../../src/session-nav/index.js";

describe("rewriteResumeInput", () => {
  test("rewrites the four resume forms", () => {
    expect(rewriteResumeInput("/resume")).toBe("/resume-recent");
    expect(rewriteResumeInput("resume")).toBe("/resume-recent");
    expect(rewriteResumeInput("/resume --all")).toBe("/resume-recent --all");
    expect(rewriteResumeInput("resume --all")).toBe("/resume-recent --all");
  });

  test("passes other input through unchanged", () => {
    expect(rewriteResumeInput("resume please")).toBe("resume please");
    expect(rewriteResumeInput("/resume-extra")).toBe("/resume-extra");
    expect(rewriteResumeInput("clear")).toBe("clear");
    expect(rewriteResumeInput("hello world")).toBe("hello world");
  });
});

describe("isExitInput / isClearInput", () => {
  test("match the bare word with surrounding whitespace tolerated", () => {
    expect(isExitInput("exit")).toBe(true);
    expect(isExitInput("  exit \n")).toBe(true);
    expect(isExitInput("exit now")).toBe(false);
    expect(isExitInput("/exit")).toBe(false);

    expect(isClearInput("clear")).toBe(true);
    expect(isClearInput(" clear ")).toBe(true);
    expect(isClearInput("clear cache")).toBe(false);
    expect(isClearInput("/clear")).toBe(false);
  });
});

describe("SessionNavEditor", () => {
  type Ctor = ConstructorParameters<typeof SessionNavEditor>;

  function createEditor(): { editor: SessionNavEditor; submitted: () => string | undefined } {
    let submittedText: string | undefined;
    // Inline fakes: the editor only stores tui, reads theme.borderColor in the
    // constructor, and calls keybindings.matches — none of the TUI surface is
    // exercised by handleInput in this test.
    const editor = new SessionNavEditor(
      {} as unknown as Ctor[0],
      { borderColor: (text: string) => text } as unknown as Ctor[1],
      { matches: () => false } as unknown as Ctor[2],
    );
    editor.onSubmit = (text: string) => {
      submittedText = text;
    };
    return { editor, submitted: () => submittedText };
  }

  test("bare `clear` + Enter is rewritten to /clear before submit", () => {
    const { editor, submitted } = createEditor();
    editor.setText("clear");
    editor.handleInput("\r");
    expect(submitted()).toBe("/clear");
  });

  test("bare `resume` + Enter is rewritten to /resume-recent before submit", () => {
    const { editor, submitted } = createEditor();
    editor.setText("resume");
    editor.handleInput("\r");
    expect(submitted()).toBe("/resume-recent");
  });

  test("`/resume --all` + Enter is rewritten to /resume-recent --all before submit", () => {
    const { editor, submitted } = createEditor();
    editor.setText("/resume --all");
    editor.handleInput("\r");
    expect(submitted()).toBe("/resume-recent --all");
  });

  test("plain text passes through untouched", () => {
    const { editor, submitted } = createEditor();
    editor.setText("hello world");
    editor.handleInput("\r");
    expect(submitted()).toBe("hello world");
  });

  test("Shift+Enter combo inserts a newline without rewriting", () => {
    const { editor, submitted } = createEditor();
    editor.setText("clear");
    editor.handleInput("\x1b[13;2~"); // kitty Shift+Enter
    expect(editor.getText()).toBe("clear\n");
    expect(submitted()).toBeUndefined();
  });
});
