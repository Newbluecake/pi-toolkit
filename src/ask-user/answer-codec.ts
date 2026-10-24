import type { AnswerValue } from "./types.js";

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function put(record: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Encode the internal structured value at the RPC protocol boundary. */
export function encodeAnswer(value: AnswerValue, opts: { key: string; multiSelect: boolean }): Record<string, string> {
  const result: Record<string, string> = {};

  // 2026-10-24 复验 blocker backstop: single-select carries ONE answer. When both a pick and
  // an Other text arrive (pre-fix web drafts, foreign clients), the pick wins and the
  // `__other` key is dropped (TUI parity: component.ts clears freeTextValue on option
  // confirm). The web UI and buildDialogAnswers already enforce this; this is the last gate.
  const suppressOther = !opts.multiSelect && value.selected.length > 0;

  if (value.selected.length > 0) {
    const first = value.selected[0];
    if (first !== undefined) {
      put(result, opts.key, opts.multiSelect ? JSON.stringify(value.selected) : first);
    }
  }

  if (!suppressOther && value.other !== null && value.other !== "") {
    put(result, `${opts.key}__other`, value.other);
  }

  if (value.skipped === true) {
    put(result, `${opts.key}__skipped`, "1");
  }

  return result;
}

/**
 * Decode a value from the RPC answers record.
 *
 * Multi-select values are JSON strings, but malformed or legacy values are
 * preserved as one label rather than escaping the protocol boundary.
 */
export function decodeAnswer(
  answers: Record<string, string>,
  key: string,
  multiSelect: boolean,
): string | string[] | undefined {
  if (!hasOwn(answers, key)) return undefined;

  const raw = answers[key];
  if (!multiSelect || raw === undefined) return raw;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to the lossless single-label fallback below.
  }

  return [raw];
}

export function decodeOther(answers: Record<string, string>, key: string): string | undefined {
  const otherKey = `${key}__other`;
  return hasOwn(answers, otherKey) ? answers[otherKey] : undefined;
}

/** The `<key>__skipped` channel: any own property marks the question as skipped. */
export function decodeSkipped(answers: Record<string, string>, key: string): boolean {
  return hasOwn(answers, `${key}__skipped`);
}
