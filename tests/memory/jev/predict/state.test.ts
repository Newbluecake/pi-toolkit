// state.ts unit tests (plan.md v3.2 section 3.4).

import { describe, expect, it } from "vitest";
import { detectStateConstraints } from "../../../../src/memory/jev/predict/state.js";

describe("detectStateConstraints", () => {
  it("fires on a running release.sh job", () => {
    const state = detectStateConstraints([{ status: "running", command: "bash scripts/release/release.sh 0.1.0" }]);
    expect(state).toEqual([{ kind: "release-in-progress", evidence: "release.sh" }]);
  });

  it("fires on npm publish / gh release", () => {
    expect(detectStateConstraints([{ status: "running", command: "npm publish" }])).toHaveLength(1);
    expect(detectStateConstraints([{ status: "running", command: "gh release create" }])).toHaveLength(1);
  });

  it("does not fire when the job is not running", () => {
    expect(detectStateConstraints([{ status: "done", command: "bash release.sh" }])).toEqual([]);
  });

  it("does not fire on unrelated running jobs", () => {
    expect(detectStateConstraints([{ status: "running", command: "npm test" }])).toEqual([]);
  });

  it("is never affected by negation wording in the job command itself (S is not an action modifier)", () => {
    // S 只看 shape，不解析自然语言否定——job.command 不是用户 prompt。
    const state = detectStateConstraints([{ status: "running", command: "echo 不要发版 && bash release.sh" }]);
    expect(state).toHaveLength(1);
  });
});
