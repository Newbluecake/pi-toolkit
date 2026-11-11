import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { validateCoverageOutput, validateRevisionOutput } from "../../../src/memory/govern/revision-output.js";

const invalid = { ok: false, reason: "invalid-output" };
describe("shared validateRevisionOutput", () => {
  it("accepts and normalizes one Markdown body with a digest of exact canonical UTF-8", () => {
    const body = "Keep the shared budget.\n第二条：保留有效约束。";
    const result = validateRevisionOutput(`  ${body.replace(/\n/g, "\r\n")}\r\n`);
    expect(result).toEqual({ ok: true, body, outputDigest: createHash("sha256").update(body).digest("hex") });
    expect(Object.isFrozen(result)).toBe(true);
    expect(validateRevisionOutput(body)).toEqual(result);
  });
  it("measures UTF-8 bytes, not JS characters or a token guess (1024/1025 and multibyte boundary)", () => {
    expect(validateRevisionOutput("a".repeat(1024))).toMatchObject({ ok: true });
    expect(validateRevisionOutput("a".repeat(1025))).toEqual(invalid);
    expect(validateRevisionOutput(`${"中".repeat(341)}a`)).toMatchObject({ ok: true });
    expect(validateRevisionOutput(`${"中".repeat(341)}ab`)).toEqual(invalid);
    expect(validateRevisionOutput(`${" ".repeat(1024)}x`)).toEqual(invalid);
  });
  it.each([
    undefined,
    null,
    true,
    4,
    {},
    { body: "valid" },
    { body: "valid", action: "delete" },
    ["valid"],
    "",
    " \n\t",
    "---\nkind: block\n---\nvalid",
    "valid\n---\nmore",
    "...\nvalid",
    '{"body":"valid","suggestions":[]}',
    '["valid"]',
    "```json\n{}\n```",
    "body: valid",
    "action: rewrite",
    "delete: rules.001\nreason: obsolete",
    "remove: rules.001\nreason: obsolete",
    "- delete: rules.001\n  reason: obsolete",
    "'delete': 'rules.001'\nreason: obsolete",
    "Keep valid rules.\ndelete: rules.001\nreason: obsolete\nKeep other constraints.",
    'Keep valid rules. {"delete":"rules.001","reason":"obsolete"}',
    "Keep valid rules. {remove: rules.001, reason: obsolete}",
    "rename: rules.001\nto: rules.002",
    "move: blocks/rules.001.md\nreason: relocation",
    "delete: [rules.001]\nreason: obsolete",
    "*** Begin Patch\n*** Delete File: rules.001\n*** End Patch",
    "Keep valid rules.\n*** Begin Patch\n*** Update File: rules.001\n@@\n-x\n+y\n*** End Patch",
    "- action: delete\n  path: rules.001",
    "Keep rules. {action: delete, path: rules.001}",
    "1. action: delete\n   path: rules.001",
    "- 'action': delete\n  'path': rules.001",
    'Keep rules. {"action":"delete","path":"rules.001"} More prose.',
    'Keep rules.\n{"operations":[{"op":"remove","path":"rules.001"}]}',
    "Keep rules.\ndiff --git a/rules.001 b/rules.001\n@@ -1 +1 @@\n-x\n+y",

    "supersedes: x.001",
    "expires: 2030-01-01",
    "relation: conflict",
    "valid [REDACTED]",
    "valid [EMAIL]",
    "valid [PEM]",
    "<!-- mem user -->\nvalid",
    "<tool_call>write</tool_call>",
    "sk-1234567890123456789012345",
    "valid\u0000bad",
    "\uFEFFvalid",
    "bad\ud800",
    "bad\udfff",
    "bad\rline",
  ])("rejects non-body/envelope/schema/control/placeholder output %j", (raw) => {
    expect(validateRevisionOutput(raw)).toEqual(invalid);
  });
  it.each([
    "# Rules\n\n- Keep tests deterministic.\n- Delete stale caches only after confirmation.",
    "The action and path are examples in prose, not an operation envelope.",
    "Delete: only after explicit confirmation.\nReason: preserve every valid rule.",
    "Do not delete rules.001; reason: it remains valid.",
    "Delete: never.\nKeep every valid constraint.",
    "**Important:** retain all valid constraints.\n\n1. Run tests.\n2. Review the diff.",
    'Use `{"retry":false}` as illustrative configuration, not a write instruction.',
  ])("retains normal Markdown %s", (body) => {
    const result = validateRevisionOutput(body);
    expect(result).toEqual({ ok: true, body, outputDigest: createHash("sha256").update(body).digest("hex") });
  });
  it("never executes a model-supplied getter/toJSON", () => {
    const getter = vi.fn(() => "valid");
    expect(
      validateRevisionOutput({
        get body() {
          return getter();
        },
        toJSON: getter,
      }),
    ).toEqual(invalid);
    expect(getter).not.toHaveBeenCalled();
  });
  it("a changed valid body gets a different digest; later proposal can reuse the same validator", () => {
    const first = validateRevisionOutput("Keep all constraints.");
    const second = validateRevisionOutput("Keep all constraints. Add tests.");
    expect(first.ok && second.ok && first.outputDigest !== second.outputDigest).toBe(true);
    if (!first.ok) throw new Error("expected body");
    expect(validateRevisionOutput(`${first.body}\n[REDACTED]`)).toEqual(invalid);
  });
});
describe("closed coverage output", () => {
  it.each(["complete", "partial", "unknown"] as const)("accepts only the explicit verdict %s", (verdict) => {
    expect(validateCoverageOutput(` { "verdict" : "${verdict}" } `)).toBe(verdict);
  });
  it.each([
    {},
    { verdict: "complete" },
    "complete",
    '{"verdict":"complete","p":1}',
    '{"verdict":"complete","independent":true}',
    '{"verdict":"complete","verdict":"partial"}',
    '{"verdict":"COMPLETE"}',
    '{"verdict":"complete","body":"x"}',
    '{"verdict":"complete"}\nextra',
    " ".repeat(129),
  ])("rejects invalid/extra/duplicate/self-scored coverage %j", (raw) => {
    expect(validateCoverageOutput(raw)).toBeUndefined();
  });
});
