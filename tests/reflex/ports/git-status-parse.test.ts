import { describe, expect, it } from "vitest";
import { parsePorcelainV2Z } from "../../../src/reflex/core/git-status-parse.js";
import { head, oid, tracked } from "./helpers.js";

describe("porcelain v2 -z", () => {
  it("parses clean and initial repositories", () => {
    expect(parsePorcelainV2Z(head)).toEqual({
      branch: "dev",
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      unmerged: 0,
      paths: [],
    });
    expect(parsePorcelainV2Z("# branch.oid (initial)\0# branch.head main\0").branch).toBe("main");
  });
  it("parses upstream, ahead/behind and detached HEAD", () => {
    expect(parsePorcelainV2Z(head + "# branch.upstream origin/dev\0# branch.ab +3 -2\0")).toMatchObject({
      upstream: "origin/dev",
      ahead: 3,
      behind: 2,
    });
    expect(parsePorcelainV2Z(head.replace("branch.head dev", "branch.head (detached)")).branch).toBe("(detached)");
  });
  it("counts staged/worktree changes independently and preserves whitespace", () => {
    expect(parsePorcelainV2Z(head + tracked("MM", "with space\nand tab\t.txt") + "? new file\0")).toMatchObject({
      staged: 1,
      modified: 1,
      untracked: 1,
      paths: ["with space\nand tab\t.txt", "new file"],
    });
  });
  it("consumes rename's second path even when it resembles a record/header", () => {
    const rename = `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new name\0# branch.head old name\0`;
    expect(parsePorcelainV2Z(head + rename + tracked(".M", "last"))).toMatchObject({
      staged: 1,
      modified: 1,
      paths: ["new name", "# branch.head old name", "last"],
    });
  });
  it("parses unmerged records without double-counting staged/modified", () => {
    expect(
      parsePorcelainV2Z(head + `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict file\0`),
    ).toMatchObject({ staged: 0, modified: 0, unmerged: 1, paths: ["conflict file"] });
  });
  it("parses sha256, submodules, ignored paths", () => {
    expect(
      parsePorcelainV2Z(
        head.replace(oid, "b".repeat(64)) + tracked(".M", "sub").replace("N...", "SCMU") + "! ignored\0",
      ),
    ).toMatchObject({ modified: 1, paths: ["sub"] });
  });
  it.each([
    "",
    "# branch.head dev\0",
    head.slice(0, -1),
    head + "garbage\0",
    head + "? \0",
    head + tracked("XX", "bad"),
    head + `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new\0`,
    head + "# branch.ab +NaN -0\0",
    head + "# branch.ab +99999999999999999999 -0\0",
    head + "# branch.head duplicate\0",
    head + "u UU nonsense\0",
  ])("rejects malformed output %j", (input) => {
    expect(() => parsePorcelainV2Z(input)).toThrow();
  });
});
