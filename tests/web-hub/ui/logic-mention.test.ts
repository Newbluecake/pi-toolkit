// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyMentionPick,
  filterMentionTargets,
  mentionCompletion,
  mentionSendRoute,
  moveMentionActive,
  parseMentionText,
  resolveMentionTarget,
  runningMentionTargets,
} from "../../../src/web-hub/ui/src/logic/mention.js";

/**
 * Pure @mention helpers (web-hub task #11 — composer `@label` completion + send routing).
 * Semantics mirror the TUI's `src/mention/mention.ts` `parseMention` (leading `@label message`
 * only), minus the registry: the web side resolves against the session's LIVE fleet rows, and
 * only `status === "running"` rows are steerable (the agent answers anything else with
 * E_NOT_RUNNING, so offering it would be a guaranteed failure).
 */

const run = (label, runId, extra = {}) => ({ runId, label, status: "running", terminal: false, ...extra });

describe("parseMentionText (leading `@label message`, same shape as TUI parseMention)", () => {
  it("parses a complete leading mention", () => {
    expect(parseMentionText("@bot fix the flaky test")).toEqual({ label: "bot", message: "fix the flaky test" });
  });

  it("keeps multi-line messages and trailing-space trims like the TUI regex", () => {
    expect(parseMentionText("@bot line1\nline2  ")).toEqual({ label: "bot", message: "line1\nline2" });
    expect(parseMentionText("@bot\tTabbed gap")).toEqual({ label: "bot", message: "Tabbed gap" });
  });

  it("rejects: no message, empty message, mention not at line start, plain text", () => {
    expect(parseMentionText("@bot")).toBeUndefined();
    expect(parseMentionText("@bot   ")).toBeUndefined();
    expect(parseMentionText("hey @bot hi")).toBeUndefined();
    expect(parseMentionText("just text")).toBeUndefined();
    expect(parseMentionText("")).toBeUndefined();
  });

  it("label is the first non-space token (anything but whitespace), message must be non-blank", () => {
    expect(parseMentionText("@bot-x_1.2 go")).toEqual({ label: "bot-x_1.2", message: "go" });
  });
});

describe("runningMentionTargets (fleet rows → steerable targets)", () => {
  it("keeps only status==='running' rows with a non-empty label and runId", () => {
    const rows = [
      run("alpha", "r1"),
      run("done", "r2", { status: "completed", terminal: true }),
      run("queued", "r3", { status: "queued" }),
      run("timed", "r4", { status: "timed_out", terminal: true }),
      { runId: "r5", status: "running", terminal: false }, // no label
      run("", "r6"), // empty label
      { label: "noid", status: "running" }, // no runId
      null,
      "garbage",
    ];
    expect(runningMentionTargets(rows)).toEqual([{ label: "alpha", runId: "r1", status: "running" }]);
  });

  it("duplicate labels: first row wins (mirrors the TUI registry's first-registration-wins)", () => {
    const rows = [run("bot", "r1"), run("bot", "r2")];
    expect(runningMentionTargets(rows).map((t) => t.runId)).toEqual(["r1"]);
  });

  it("input order is preserved; non-array input degrades to []", () => {
    expect(runningMentionTargets([run("b", "r2"), run("a", "r1")]).map((t) => t.label)).toEqual(["b", "a"]);
    expect(runningMentionTargets(undefined)).toEqual([]);
    expect(runningMentionTargets(null)).toEqual([]);
  });
});

describe("filterMentionTargets (completion prefix filter)", () => {
  const targets = [
    { label: "bot", runId: "r1", status: "running" },
    { label: "builder", runId: "r2", status: "running" },
    { label: "reviewer", runId: "r3", status: "running" },
  ];

  it("case-insensitive prefix match on the label; empty query returns everything", () => {
    expect(filterMentionTargets(targets, "").map((t) => t.label)).toEqual(["bot", "builder", "reviewer"]);
    expect(filterMentionTargets(targets, "b").map((t) => t.label)).toEqual(["bot", "builder"]);
    expect(filterMentionTargets(targets, "BU").map((t) => t.label)).toEqual(["builder"]);
    expect(filterMentionTargets(targets, "uild")).toEqual([]); // substring is NOT enough
    expect(filterMentionTargets(targets, "zzz")).toEqual([]);
  });
});

describe("resolveMentionTarget (send-time resolution)", () => {
  it("exact, case-sensitive label match against running rows only", () => {
    const rows = [run("bot", "r1"), run("done", "r2", { status: "completed", terminal: true })];
    expect(resolveMentionTarget(rows, "bot")).toEqual({ label: "bot", runId: "r1", status: "running" });
    expect(resolveMentionTarget(rows, "Bot")).toBeUndefined();
    expect(resolveMentionTarget(rows, "done")).toBeUndefined(); // terminal ⇒ not resolvable
    expect(resolveMentionTarget(rows, "ghost")).toBeUndefined();
  });
});

describe("mentionCompletion (panel open state machine)", () => {
  it("opens on a line-initial `@` token; query is the partial label", () => {
    expect(mentionCompletion("@", 1)).toEqual({ open: true, query: "" });
    expect(mentionCompletion("@bo", 3)).toEqual({ open: true, query: "bo" });
    expect(mentionCompletion("@bo")).toEqual({ open: true, query: "bo" }); // caret defaults to end
  });

  it("mid-token caret completes from the slice before the caret", () => {
    expect(mentionCompletion("@bot", 2)).toEqual({ open: true, query: "b" });
  });

  it("closes once the token is left: space, newline, or text before the @", () => {
    expect(mentionCompletion("@bot hi", 7)).toEqual({ open: false });
    expect(mentionCompletion("@bot ", 5)).toEqual({ open: false });
    expect(mentionCompletion("@bot\nmsg", 8)).toEqual({ open: false });
    expect(mentionCompletion("x@b", 3)).toEqual({ open: false });
    expect(mentionCompletion("", 0)).toEqual({ open: false });
    expect(mentionCompletion("/compact", 8)).toEqual({ open: false });
  });
});

describe("applyMentionPick (replace the `@partial` slice with `@label `)", () => {
  it("caret at end: whole token replaced, caret lands after the trailing space", () => {
    expect(applyMentionPick("@bo", 3, "bot")).toEqual({ text: "@bot ", caret: 5 });
  });

  it("caret mid-text: slice before the caret is replaced, the rest is kept verbatim", () => {
    expect(applyMentionPick("@bo rest", 3, "bot")).toEqual({ text: "@bot  rest", caret: 5 });
  });
});

describe("moveMentionActive (arrow-key navigation, wraps)", () => {
  it("moves with wrap-around; count 0 pins 0", () => {
    expect(moveMentionActive(0, 1, 3)).toBe(1);
    expect(moveMentionActive(2, 1, 3)).toBe(0);
    expect(moveMentionActive(0, -1, 3)).toBe(2);
    expect(moveMentionActive(0, 1, 0)).toBe(0);
  });
});

describe("mentionSendRoute (DetailDock send fork)", () => {
  const rows = [run("bot", "r1"), run("old", "r2", { status: "failed", terminal: true })];

  it("`@running-label msg` ⇒ steer with the STRIPPED message (label never reaches the child)", () => {
    expect(mentionSendRoute("@bot please rebase", rows)).toEqual({
      kind: "steer",
      runId: "r1",
      label: "bot",
      message: "please rebase",
    });
  });

  it("terminal label / unknown label / no message ⇒ plain prompt, raw text untouched", () => {
    expect(mentionSendRoute("@old hi", rows)).toEqual({ kind: "prompt" });
    expect(mentionSendRoute("@ghost hi", rows)).toEqual({ kind: "prompt" });
    expect(mentionSendRoute("@bot", rows)).toEqual({ kind: "prompt" });
    expect(mentionSendRoute("hello", rows)).toEqual({ kind: "prompt" });
  });

  it("empty fleet ⇒ always prompt", () => {
    expect(mentionSendRoute("@bot hi", [])).toEqual({ kind: "prompt" });
    expect(mentionSendRoute("@bot hi", undefined)).toEqual({ kind: "prompt" });
  });
});
