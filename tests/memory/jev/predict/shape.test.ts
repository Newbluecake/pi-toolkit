// shape.ts unit tests (plan.md v3.2 section 6.1 local shape rules).

import { describe, expect, it } from "vitest";
import { allShapes, SUBCOMMAND_ENUMS, shapeOf, shapeOfCommand } from "../../../../src/memory/jev/predict/shape.js";
import { parseShell } from "../../../../src/memory/jev/shell-parse.js";

describe("shapeOf - known subcommand programs", () => {
  it.each([
    ["git commit -m x", "git commit"],
    ["git push origin main", "git push"],
    ["npm install", "npm install"],
    ["npm i", "npm i"],
    ["gh pr create", "gh pr"],
    ["cargo build --release", "cargo build"],
    ["docker ps -a", "docker ps"],
  ])("%s -> %s", (command, expected) => {
    expect(shapeOf(command)).toBe(expected);
  });

  it("falls back to bare program when the subcommand is not enumerated", () => {
    expect(shapeOf("git blame src/x.ts")).toBe("git");
    expect(shapeOf("npm doctor")).toBe("npm");
  });
});

describe("shapeOf - other programs: only the program, never args/paths/urls", () => {
  it.each([
    ["echo hello", "echo"],
    ["curl https://example.com/x?token=secret", "curl"],
    ["cat /etc/passwd", "cat"],
    ["rg -n foo src/", "rg"],
  ])("%s -> %s", (command, expected) => {
    expect(shapeOf(command)).toBe(expected);
  });

  it("never leaks a URL, path or flag value into the shape", () => {
    const shape = shapeOf("curl -H 'Authorization: Bearer sk-aaaa' https://api.example.com/v1/secret");
    expect(shape).toBe("curl");
    expect(shape).not.toMatch(/https?:|secret|Bearer/);
  });
});

describe("shapeOf - scripts", () => {
  it.each([
    ["bash scripts/release/release.sh 0.10.3", "release.sh"],
    ["./scripts/dev/x-release.sh", "x-release.sh"],
    ["sh build.sh", "build.sh"],
  ])("%s -> %s", (command, expected) => {
    expect(shapeOf(command)).toBe(expected);
  });

  it("unknown/invalid script basenames fall back to other", () => {
    expect(shapeOf("bash 'a b.sh'")).toBe("other");
  });
});

describe("shapeOf - interpreters and heredocs never expose inner content", () => {
  it.each([
    ['python -c "import os"', "python"],
    ['bash -c "git push --force"', "bash"],
  ])("%s -> %s", (command, expected) => {
    expect(shapeOf(command)).toBe(expected);
  });

  it("node -e with inline code never leaks the code into the shape (parseShell quirk: program may degrade to 'other', which is still safe)", () => {
    const shape = shapeOf("node -e \"console.log('git commit')\"");
    expect(shape).not.toContain("commit");
    expect(shape).not.toContain("console");
  });

  it("heredoc body is not parsed into the shape", () => {
    const command = "bash <<'EOF'\ngit push --force\nEOF";
    const shape = shapeOf(command);
    expect(shape).not.toContain("push");
  });
});

describe("shapeOf - unknown/malformed programs", () => {
  it("falls back to other for names outside the allowed charset", () => {
    expect(shapeOf('"weird name" arg')).toBe("other");
  });

  it("falls back to other when parseShell finds nothing", () => {
    expect(shapeOf("   ")).toBe("other");
  });
});

describe("allShapes", () => {
  it("surfaces every top-level command, deduplicated, in order", () => {
    expect(allShapes("sh release.sh && gh release create")).toEqual(["release.sh", "gh release"]);
  });

  it("dedupes repeated shapes", () => {
    expect(allShapes("git status; git status")).toEqual(["git status"]);
  });
});

describe("SUBCOMMAND_ENUMS sanity", () => {
  it("covers the programs named in section 6.1", () => {
    for (const program of ["git", "npm", "pnpm", "yarn", "gh", "cargo", "docker"]) {
      expect(SUBCOMMAND_ENUMS[program]).toBeDefined();
    }
  });
});

describe("shapeOfCommand uses the shell-parsed program directly", () => {
  it("resolves program through timeout/env wrappers the same way parseShell does", () => {
    const parsed = parseShell("timeout 600 bash x-release.sh");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(shapeOfCommand(parsed.commands[parsed.commands.length - 1]!)).toBe("x-release.sh");
  });
});
