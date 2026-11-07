import { describe, expect, it } from "vitest";
import factory from "../../src/ask-user/index.js";
import { HEADER_MAX_CHARS, QUESTION_MAX_CHARS } from "../../src/ask-user/types.js";

const EXPECTED_SNIPPET =
  "Ask the user structured clarifying questions with options — only when you cannot resolve the ambiguity yourself";
const EXPECTED_DESCRIPTION = `Ask the user to resolve ambiguity you cannot resolve yourself. Use ONLY when ALL hold: (1) the request has ≥2 reasonable approaches, (2) you have already gathered context (read/grep) and the answer is still genuinely ambiguous, and (3) picking wrong means redoing real work. One question = one decision with mutually exclusive options.

Do NOT use this tool to outsource judgment you should make — if you can form a defensible recommendation from the codebase, proceed and state your choice. Do NOT use for trivia answerable by reading code/docs, or for simple confirmations ("I'll delete X") where plain text suffices. You cannot use this tool to collect free-form requirements, long-form feedback, or multi-paragraph input — it returns short selections only.

If you recommend an option, prefix its label with "(Recommended)" and list it first. For structured multi-option decisions, prefer this tool over plain-text questions; for everything else, reply in plain text.

The user can skip any question. A skipped question comes back as {selected: [], other: null, skipped: true} — treat it as "you decide": proceed with your own judgment and do NOT immediately re-ask it.

If a previous ask_user call was paused by a background-completion interrupt and the background result already settles the question(s), call {"dismissParked":true} (no questions) once to clear the parked entries instead of re-asking.

Examples:
{"questions":[{"question":"Which DB?","context":"Need ACID + JSON columns.","options":[{"label":"(Recommended) Postgres","description":"Mature, strong consistency."},{"label":"SQLite","description":"Zero-ops, embedded."}]}]}

{"questions":[{"header":"DB","question":"Which database?","options":[{"label":"Postgres","description":"..."},{"label":"SQLite","description":"..."}]},{"header":"Region","question":"Which region?","options":[{"label":"us-east-1","description":"..."},{"label":"eu-west-1","description":"..."}]}]}

Don't:
- Flattening question/header/options to the top level — wrap them in questions:[...].`;
const EXPECTED_GUIDELINES = [
  "Models over-ask because asking feels safer than deciding — resist this: if context makes the answer clear, proceed and state your choice.",
  "Gather context first (read/grep) and pass a short summary via the context field — don't ask blind. Batch related decisions into one call (1-4 questions).",
];

function registeredTool(): any {
  let value: any;
  factory({
    registerTool: (tool: any) => {
      value = tool;
    },
  } as never);
  return value;
}

describe("registered prompt quality", () => {
  it("locks the prompt metadata values rather than source spelling", () => {
    const tool = registeredTool();
    expect(tool.promptSnippet).toBe(EXPECTED_SNIPPET);
    expect(tool.promptGuidelines).toEqual(EXPECTED_GUIDELINES);
    expect(tool.description).toBe(EXPECTED_DESCRIPTION);
    expect(tool.description).toContain('"options":[{"label"');
    expect(tool.description).toContain("Don't:");
    expect(tool.description).toContain("Flattening question/header/options to the top level");
    // Contracts stated once, in the parameter descriptions (not repeated in description/guidelines):
    const question = tool.parameters.properties.questions.items;
    expect(question.properties.options.description).toContain("never a bare string");
    expect(question.properties.options.description).toContain("'Other' option");
    expect(question.properties.header.description).toContain(`<=${HEADER_MAX_CHARS} chars`);
    expect(tool.description).toContain("skipped: true");
    expect(tool.description).toContain('{"dismissParked":true}');
    expect(tool.parameters.properties.dismissParked.description).toContain("Cannot be combined with questions");
  });

  it("keeps schema descriptions consistent with runtime validation thresholds", () => {
    const tool = registeredTool();
    const question = tool.parameters.properties.questions.items;
    expect(question.properties.question.description).toContain(`<=${QUESTION_MAX_CHARS} chars`);
    expect(question.properties.header.description).toContain(`<=${HEADER_MAX_CHARS} chars`);
    expect(question.properties.options.minItems).toBe(2);
    expect(question.properties.options.maxItems).toBe(4);
    expect(tool.parameters.properties.questions.minItems).toBeUndefined(); // optional since r4 (dismissParked)
    expect(tool.parameters.properties.questions.maxItems).toBe(4);
  });
});
