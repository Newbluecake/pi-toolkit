/**
 * jev-reflex · shadow agreement (plan R1 step 10; arch §4.8). Structured look-alike types only
 * (pi's branch entries are structurally compatible; importing pi would break R-I10).
 *
 * `collectToolShapes` walks the branch BACKWARD to the most recent user message, verifies its
 * digest (mismatch ⇒ the tools belong to another run ⇒ unknown), then collects the shapes of
 * every assistant tool call after it: bash ⇒ `allShapes(command)` (program [subcommand], never
 * arguments), bash_job ⇒ `bash_job:<action>`, anything else ⇒ the tool name.
 *
 * `judgeAgreement` implements the arch §4.8 rules; `edit`/`write` can never agree.
 */

import { allShapes } from "../../memory/jev/predict/shape.js";
import { requestDigest } from "./digest.js";
import { normalizeInput } from "./normalize.js";
import type { Agreement, RScriptV1 } from "./types.js";

/** Structural stand-in for pi branch entries (role/text/toolCalls). */
export interface BranchEntryLike {
  role: string;
  /** user message text. */
  text?: string;
  /** assistant tool calls. */
  toolCalls?: readonly BranchToolCallLike[];
}

export interface BranchToolCallLike {
  name: string;
  /** pi's parsed tool arguments — only `command` (bash) and `action` (bash_job) are read. */
  arguments?: unknown;
}

export type CollectShapesResult =
  { status: "no-user" } | { status: "digest-mismatch" } | { status: "ok"; shapes: readonly string[] };

function stringArg(args: unknown, key: string): string | undefined {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function collectToolShapes(entries: readonly BranchEntryLike[], sinceUserDigest: string): CollectShapesResult {
  let userIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.role === "user" && typeof entry.text === "string") {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return { status: "no-user" };
  const userText = entries[userIdx]!.text ?? "";
  if (requestDigest(normalizeInput(userText).norm) !== sinceUserDigest) {
    return { status: "digest-mismatch" };
  }
  const shapes: string[] = [];
  const add = (shape: string): void => {
    if (!shapes.includes(shape)) shapes.push(shape);
  };
  for (let i = userIdx + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.role !== "assistant") continue;
    for (const call of entry.toolCalls ?? []) {
      if (typeof call?.name !== "string" || call.name === "") continue;
      if (call.name === "bash") {
        const command = stringArg(call.arguments, "command");
        if (command !== undefined) {
          for (const shape of allShapes(command)) add(shape);
          continue;
        }
      }
      if (call.name === "bash_job") {
        const action = stringArg(call.arguments, "action");
        add(action !== undefined ? `bash_job:${action}` : call.name);
        continue;
      }
      add(call.name);
    }
  }
  return { status: "ok", shapes };
}

/** arch §4.8: agree-shape present and no edit/write ⇒ agree; zero tools ⇒ no-tool; else diverge. */
export function judgeAgreement(script: RScriptV1, shapes: readonly string[]): Agreement {
  if (shapes.length === 0) return "no-tool";
  const hasEditWrite = shapes.some((s) => s === "edit" || s === "write");
  const hasAgreeShape = shapes.some(
    (s) => script.agreement.tools.includes(s) || script.agreement.bashShapes.includes(s),
  );
  return hasAgreeShape && !hasEditWrite ? "agree" : "diverge";
}
