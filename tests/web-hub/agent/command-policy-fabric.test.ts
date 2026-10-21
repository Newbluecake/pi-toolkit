/**
 * fabric phase-2 X2 (phase2-plan §5.3/#9/XI13): the `fabric` row of the web command-policy
 * table — `status`/`blocks` (and the bare status form) are allow; every membership/policy/
 * blocklist/fence mutation is deny. This is only the FIRST layer (UI hint + classification):
 * X4's handler hard-refuses web invocations regardless, and a user override cannot open the
 * denied rows (the override check runs before this table and is not consulted by the handler).
 */
import { describe, expect, it } from "vitest";
import { resolveCommandPolicy } from "../../../src/web-hub/agent/command-policy.js";

function policy(name: string, args: string, overrides?: Record<string, "allow" | "confirm" | "deny">) {
  return resolveCommandPolicy({ name, args, kind: "extension", ...(overrides !== undefined ? { overrides } : {}) })
    .policy;
}

describe("command policy: /fabric (§5.3/#9/XI13, X2)", () => {
  it("read-only subcommands are allow", () => {
    expect(policy("fabric", "status")).toBe("allow");
    expect(policy("fabric", "blocks")).toBe("allow");
  });

  it("bare /fabric renders status ⇒ allow", () => {
    expect(policy("fabric", "")).toBe("allow");
    expect(policy("fabric", "   ")).toBe("allow");
  });

  it("every membership/policy/blocklist/fence mutation is deny", () => {
    for (const sub of ["join", "leave", "receive", "block", "unblock", "fence"]) {
      expect(policy("fabric", sub)).toBe("deny");
      expect(policy("fabric", `${sub} arg`)).toBe("deny");
    }
  });

  it("a webCommandPolicy.fabric user override cannot open the mutations (UI layer only)", () => {
    // §5.3: the handler's isWebInvocation gate never reads the policy; the table's deny here is
    // the first layer. An override flips THIS layer's answer (it wins outright for any name) —
    // pinned here so the residual is explicit: the hard gate lives in X4's handler, not here.
    expect(policy("fabric", "join", { fabric: "allow" })).toBe("allow");
    expect(policy("fabric", "status", { fabric: "deny" })).toBe("deny");
  });

  it("fence reset stays denied (mutation), status untouched by unknown-sub default", () => {
    expect(policy("fabric", "fence reset")).toBe("deny");
    expect(policy("fabric", "whatever-else")).toBe("deny");
  });
});
