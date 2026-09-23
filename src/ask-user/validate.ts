import { type InputQuestion, QUESTION_MAX_CHARS } from "./types.js";

const ERROR_PREVIEW_CHARS = 20;

/**
 * Validate semantic constraints that are intentionally left outside TypeBox.
 * The input schema keeps string options permissive so this layer can provide a
 * useful correction instead of exposing a generic "must be object" error.
 *
 * Presentation-layer constraints (control characters in question text, missing
 * or over-long tab headers) are repaired beforehand by normalizeQuestions in
 * normalize.ts; this layer only rejects what normalization cannot fix.
 * Duplicate headers remain an error because they collide as RPC answer keys.
 */
export function validateInput(questions: InputQuestion[]): string | null {
  const seenQuestions = new Set<string>();

  // Steps 1-5 are question-local and deliberately run before all header checks.
  for (const q of questions) {
    const question = q.question;

    if (question.length > QUESTION_MAX_CHARS) {
      return `Question text exceeds ${QUESTION_MAX_CHARS} chars: "${question.slice(0, ERROR_PREVIEW_CHARS)}...". Shorten it to a single concise decision; move extra context into the context field.`;
    }

    if (seenQuestions.has(question)) {
      return `Duplicate question: "${question}". Each question text must be unique; merge duplicates or rephrase one to differ.`;
    }
    seenQuestions.add(question);

    const seenLabels = new Set<string>();
    for (const option of q.options) {
      if (typeof option === "string") {
        return `Options for question "${question}" must be an array of {label, description} objects, not strings. Correct: "options":[{"label":"A","description":"..."},{"label":"B","description":"..."}]`;
      }

      if (option.label.trim().toLowerCase() === "other") {
        return `Do not include an "Other" option — it is added automatically. Remove it from "options".`;
      }

      if (option.label.trim() === "") {
        return `Option label must not be empty in question "${question}". Give every option a distinct, descriptive label.`;
      }

      if (seenLabels.has(option.label)) {
        return `Duplicate option label "${option.label}" in question "${question}". Options must be mutually exclusive — reword one so each label maps to a distinct choice.`;
      }
      seenLabels.add(option.label);
    }
  }

  // Step 6: headers must be unique across questions — duplicates collide as
  // RPC answer keys (one question's Other overwrites another's).
  if (questions.length > 1) {
    const seenHeaders = new Set<string>();
    for (const q of questions) {
      const header = q.header === undefined ? "" : q.header.trim();
      if (seenHeaders.has(header)) {
        return `Duplicate header "${header}" in questions. Headers must be unique in multi-question mode — shared headers cause answer key collisions (one question's Other overwrites another's). Rephrase one header to differ.`;
      }
      seenHeaders.add(header);
    }
  }

  return null;
}
