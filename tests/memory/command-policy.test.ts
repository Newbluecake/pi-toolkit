import { describe, expect, it } from "vitest";
import { classifyMemoryCommand, needsConfirm, parseMemoryWriteRequest } from "../../src/memory/command-policy.js";

describe("memory command classification", () => {
  it.each([
    "",
    "list",
    "path",
    "doctor",
    "jev",
    "tags",
    "tags list",
    "review --list",
    "migrate --dry-run",
    "migrate --all --dry-run",
    "migrate --report",
    "migrate --status",
    "migrate --dry-run --import-legacy",
    "restore",
    "restore --trash",
    "session list",
    "session status",
    "session path",
    "hub list",
    "hub status",
    "hub path",
    "hub trash",
    "hub show topic.001",
  ])("classifies %s as read", (input) => expect(needsConfirm(input)).toBe(false));
  it.each([
    "migrate",
    "migrate --all",
    "migrate --rollback",
    "migrate --import-legacy",
    "init",
    "import --force all",
    "restore id",
    "restore --trash id",
    "restore --block id",
    "session add hello",
    "hub add hello",
    "hub rm n1",
    "hub adopt",
    "hub restore n1",
    "tags add test",
    "tags rm test",
    "tags disable test",
    "tags enable test",
    "review",
    "review --run",
    "expired",
    "jev probe",
    "jev retag",
    "jev reset-index",
    "not-a-command",
    "session rm n1",
    "migrate --dry-run --rollback",
    "migrate --unknown",
    "doctor --unknown",
  ])("requires confirmation for %s", (input) => expect(needsConfirm(input)).toBe(true));
  it("does not trust a caller-supplied read class", () => {
    expect(classifyMemoryCommand("migrate --rollback --dry-run")).toBe("unknown");
  });
});

describe("closed read syntax", () => {
  it.each([
    "hub show --unknown",
    "hub show",
    "hub show topic.001 extra",
    "hub show n1",
    "hub unknown",
    "hub list extra",
    "session unknown",
    "session list extra",
    "jev report extra",
    "review --list extra",
    "restore --trash extra --unknown",
    "migrate --status --all",
    "migrate --dry-run --dry-run",
    "migrate --report --unknown",
  ])("does not grant read exemption to %s", (input) => {
    expect(needsConfirm(input)).toBe(true);
    expect(classifyMemoryCommand(input)).toBe("unknown");
  });
});

describe("strict Web write parser (package 2)", () => {
  it("accepts exactly `session add <non-empty text>` and preserves the original text", () => {
    const r = parseMemoryWriteRequest("session add hello world");
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.request).toEqual({ kind: "session.add", rawArgs: "session add hello world", text: "hello world" });
    const multi = parseMemoryWriteRequest("  session add  leading\n  body --flag ");
    expect(multi.ok).toBe(true);
    if (multi.ok) expect(multi.request.text).toBe(" leading\n  body --flag");
  });
  it("rejects empty and whitespace-only bodies as usage errors", () => {
    for (const args of ["session add", "session add   ", "session add \t ", "session add\n"]) {
      expect(parseMemoryWriteRequest(args)).toMatchObject({ ok: false, code: "E_MEM_ARGS" });
    }
  });
  it("rejects every other write/read as unsupported for the write seam", () => {
    for (const args of [
      "list",
      "path",
      "doctor",
      "session list",
      "session rm n1",
      "hub add hello",
      "hub rm rule.1",
      "migrate --all",
      "init",
      "import --force",
      "restore --block x",
    ]) {
      expect(parseMemoryWriteRequest(args)).toMatchObject({ ok: false, code: "E_MEM_WEB_UNSUPPORTED" });
    }
  });
});
