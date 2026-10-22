/**
 * fabric row of the web command-policy table (2026-10-22 user ruling, superseding phase-2
 * §5.3/#9/XI13's deny-by-default): every KNOWN subcommand — including the membership/policy/
 * blocklist/fence mutations — is baseline `allow`; the web surface is governed by
 * `webCommandPolicy.fabric` (default allow, settable to confirm/deny; the override wins outright
 * for the whole name). Unknown subcommands stay deny. The Feishu source never reaches this table
 * (hub F6 admission forwards only prompt/dialog ops for Feishu; X4's handler hard-refuses
 * Feishu-marked invocations regardless of policy; the prompt-op text guard refuses Feishu
 * slash-shaped prompt text).
 */
import { describe, expect, it } from "vitest";
import { resolveCommandPolicy } from "../../../src/web-hub/agent/command-policy.js";

function policy(name: string, args: string, overrides?: Record<string, "allow" | "confirm" | "deny">) {
  return resolveCommandPolicy({ name, args, kind: "extension", ...(overrides !== undefined ? { overrides } : {}) })
    .policy;
}

describe("command policy: /fabric (2026-10-22 ruling)", () => {
  it("read-only subcommands are allow", () => {
    expect(policy("fabric", "status")).toBe("allow");
    expect(policy("fabric", "blocks")).toBe("allow");
    expect(policy("fabric", "replies")).toBe("allow");
  });

  it("bare /fabric renders status ⇒ allow", () => {
    expect(policy("fabric", "")).toBe("allow");
    expect(policy("fabric", "   ")).toBe("allow");
  });

  it("every known membership/policy/blocklist/fence mutation is baseline allow (web may execute)", () => {
    for (const sub of ["join", "leave", "receive", "block", "unblock", "fence"]) {
      expect(policy("fabric", sub)).toBe("allow");
      expect(policy("fabric", `${sub} arg`)).toBe("allow");
    }
    expect(policy("fabric", "fence reset")).toBe("allow");
  });

  it("webCommandPolicy.fabric overrides the whole name — deny/confirm gate every subcommand", () => {
    expect(policy("fabric", "join", { fabric: "deny" })).toBe("deny");
    expect(policy("fabric", "status", { fabric: "deny" })).toBe("deny");
    expect(policy("fabric", "fence reset", { fabric: "confirm" })).toBe("confirm");
    expect(policy("fabric", "blocks", { fabric: "confirm" })).toBe("confirm");
    expect(policy("fabric", "replies", { fabric: "deny" })).toBe("deny");
    expect(policy("fabric", "replies", { fabric: "confirm" })).toBe("confirm");
    expect(policy("fabric", "replies", { fabric: "allow" })).toBe("allow");
    // and an explicit allow keeps the (default-allow) baseline explicit
    expect(policy("fabric", "join", { fabric: "allow" })).toBe("allow");
  });

  it("channel-plan §6.3 (CH3): `channels` is a known read-only sub (allow) under the whole-name override; join/leave with #channel args stay allow", () => {
    expect(policy("fabric", "channels")).toBe("allow");
    expect(policy("fabric", "channels", { fabric: "deny" })).toBe("deny");
    expect(policy("fabric", "channels", { fabric: "confirm" })).toBe("confirm");
    expect(policy("fabric", "join #a #b")).toBe("allow");
    expect(policy("fabric", "leave #default")).toBe("allow");
    expect(policy("fabric", "join #a", { fabric: "deny" })).toBe("deny");
    expect(policy("fabric", "channelsx")).toBe("deny");
  });

  it("unknown subcommands stay deny (typo surface — the real ones render usage text anyway)", () => {
    expect(policy("fabric", "whatever-else")).toBe("deny");
    expect(policy("fabric", "joinx")).toBe("deny");
  });
});
