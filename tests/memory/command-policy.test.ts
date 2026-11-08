import { describe, expect, it } from "vitest";
import { classifyMemoryCommand, needsConfirm } from "../../src/memory/command-policy.js";

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
    "tidy --dry-run --frontmatter",
    "tidy --batch --dry-run",
    "tidy --batch --status",
    "restore",
    "restore --trash",
    "restore --legacy",
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
    "tidy",
    "tidy --batch",
    "tidy --frontmatter",
    "tidy --break-lock",
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
    "tidy --batch --triage",
    "migrate --unknown",
    "doctor --unknown",
  ])("requires confirmation for %s", (input) => expect(needsConfirm(input)).toBe(true));
  it("does not trust a caller-supplied read class", () => {
    expect(classifyMemoryCommand("migrate --rollback --dry-run")).toBe("unknown");
  });
});

describe("closed read syntax", () => {
  it.each([
    "tidy --dry-run --status",
    "tidy --dry-run --dry-run",
    "tidy --batch --status --frontmatter",
    "tidy --dry-run --unknown",
    "tidy --dry-run file.md",
    "tidy --status",
    "tidy --batch --dry-run --frontmatter",
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
