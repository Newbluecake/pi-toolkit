import { describe, expect, it } from "vitest";
import { formatAliasStatusLines } from "../../../src/web-hub/agent/alias-status.js";

describe("formatAliasStatusLines (alias-plan §3.3, AL6)", () => {
  it("absent (healthy / off / old hub) ⇒ no lines", () => {
    expect(formatAliasStatusLines(undefined)).toEqual([]);
  });
  it("degraded ⇒ warning with reason + path and the repair hint", () => {
    const lines = formatAliasStatusLines({ degraded: true, reason: "corrupt", path: "/h/state/xs-aliases.json" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("warning：alias store degraded (corrupt) · /h/state/xs-aliases.json");
    expect(lines[1]).toContain("/webhub restart");
  });
  it("strips control characters from hub.json-sourced text (no forged lines)", () => {
    const [l] = formatAliasStatusLines({ degraded: true, reason: "a\nb", path: "/x\u0007y" });
    expect(l).not.toMatch(/[\n\u0007]/);
  });
});
