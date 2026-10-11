import { describe, expect, it } from "vitest";
import { auditAvatar } from "../../../../src/web-hub/hub/audit.js";

describe("avatar audit", () => {
  it("keeps the schema allowlist and redacts path-like/invalid errno values", () => {
    const lines: Array<{ msg: string; data?: object }> = [];
    auditAvatar({ info: (msg, data) => lines.push({ msg, data }) }, {
      reqId: "0123456789abcdef",
      op: "put",
      phase: "reject",
      ok: false,
      ms: 1,
      errno: "not-safe",
      reason: "/secret",
      extra: "/state/avatar.png",
    } as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.data).toEqual({
      audit: "avatar",
      reqId: "0123456789abcdef",
      op: "put",
      phase: "reject",
      ok: false,
      ms: 1,
    });
    expect(JSON.stringify(lines[0])).not.toContain("/");
  });
});
