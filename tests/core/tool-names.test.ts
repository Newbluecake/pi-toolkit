import { describe, expect, it } from "vitest";
import { LEGACY_RESULT_TOOL_NAME, RESULT_TOOL_NAME, migrateToolNames } from "../../src/core/tool-names.js";

describe("core/tool-names", () => {
  it("pins both names", () => {
    expect(RESULT_TOOL_NAME).toBe("get_run_result");
    expect(LEGACY_RESULT_TOOL_NAME).toBe("get_subagent_result");
  });
  it("maps the legacy name, keeps order, de-duplicates (legacy + new together collapse to one)", () => {
    expect(migrateToolNames(["ask_user", LEGACY_RESULT_TOOL_NAME, "x"])).toEqual(["ask_user", RESULT_TOOL_NAME, "x"]);
    expect(migrateToolNames([RESULT_TOOL_NAME, "a", LEGACY_RESULT_TOOL_NAME])).toEqual([RESULT_TOOL_NAME, "a"]);
    expect(migrateToolNames(["a", "a"])).toEqual(["a"]);
    expect(migrateToolNames([])).toEqual([]);
  });
  it("does not trip over Object.prototype names", () => {
    expect(migrateToolNames(["constructor", "toString", "__proto__"])).toEqual([
      "constructor",
      "toString",
      "__proto__",
    ]);
  });
});
