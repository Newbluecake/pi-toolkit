/**
 * §4.6 policy table tests (plan control-plan.md §4.6, package C11).
 */
import { describe, expect, it } from "vitest";
import { effectivePolicy, resolveCommandPolicy } from "../../../src/web-hub/agent/command-policy.js";

function resolve(name: string, args: string, kind: "extension" | "template" | "skill" | "builtin") {
  return resolveCommandPolicy({ name, args, kind });
}

describe("resolveCommandPolicy — templates/skills always allow", () => {
  it("prompt templates and skills allow regardless of name", () => {
    expect(resolve("my-template", "", "template").policy).toBe("allow");
    expect(resolve("skill:x", "", "skill").policy).toBe("allow");
  });
});

describe("resolveCommandPolicy — builtin table (§4.6 builtin rows)", () => {
  it("/session is a read-only allow", () => {
    expect(resolve("session", "", "builtin")).toEqual({ policy: "allow" });
  });
  it.each(["name", "thinking", "model"])("/%s denies with no argument, allows with one", (name) => {
    expect(resolve(name, "", "builtin").policy).toBe("deny");
    expect(resolve(name, "x", "builtin").policy).toBe("allow");
  });
  it("/compact allows idle, confirms busy (policyBusy)", () => {
    const decision = resolve("compact", "", "builtin");
    expect(decision).toEqual({ policy: "allow", policyBusy: "confirm" });
    expect(effectivePolicy(decision, false)).toBe("allow");
    expect(effectivePolicy(decision, true)).toBe("confirm");
  });
  it.each(["new", "reload"])("/%s always confirms", (name) => {
    expect(resolve(name, "", "builtin").policy).toBe("confirm");
  });
  it.each([
    "settings",
    "tree",
    "scoped-models",
    "export",
    "import",
    "share",
    "bug",
    "copy",
    "changelog",
    "hotkeys",
    "fork",
    "clone",
    "trust",
    "login",
    "logout",
    "resume",
    "quit",
    "debug",
    "exit",
  ])("/%s is denied (TUI-only / host-file / clipboard / exit)", (name) => {
    expect(resolve(name, "", "builtin")).toEqual({ policy: "deny" });
  });
  it("an unrecognized builtin name (should never happen — slash.ts gates classification) still denies", () => {
    expect(resolve("totally-unknown-builtin", "", "builtin")).toEqual({ policy: "deny" });
  });
});

describe("resolveCommandPolicy — pi-toolkit sub-command table (§4.6 pi-toolkit row)", () => {
  it("/agent: status/costs/fleet/no-args/bare-runId allow; settings|budget allow bare, confirm with args; reload confirms", () => {
    expect(resolve("agent", "", "extension").policy).toBe("allow");
    expect(resolve("agent", "status", "extension").policy).toBe("allow");
    expect(resolve("agent", "status r_abc123", "extension").policy).toBe("allow");
    expect(resolve("agent", "costs", "extension").policy).toBe("allow");
    expect(resolve("agent", "fleet", "extension").policy).toBe("allow");
    expect(resolve("agent", "r_abc123", "extension").policy).toBe("allow");
    expect(resolve("agent", "settings", "extension").policy).toBe("allow");
    expect(resolve("agent", "settings list", "extension").policy).toBe("confirm");
    expect(resolve("agent", "settings set foo 1", "extension").policy).toBe("confirm");
    expect(resolve("agent", "budget", "extension").policy).toBe("allow");
    expect(resolve("agent", "budget set foo 1", "extension").policy).toBe("confirm");
    expect(resolve("agent", "reload", "extension").policy).toBe("confirm");
  });

  it("/mem: no-args/list/path/doctor allow; import/tidy/restore/anything else confirm", () => {
    expect(resolve("mem", "", "extension").policy).toBe("allow");
    expect(resolve("mem", "list", "extension").policy).toBe("allow");
    expect(resolve("mem", "path", "extension").policy).toBe("allow");
    expect(resolve("mem", "doctor", "extension").policy).toBe("allow");
    expect(resolve("mem", "import", "extension").policy).toBe("confirm");
    expect(resolve("mem", "tidy", "extension").policy).toBe("confirm");
    expect(resolve("mem", "restore --trash", "extension").policy).toBe("confirm");
  });

  it("/cache-ttl: no-args/status allow; every mode switch confirms", () => {
    expect(resolve("cache-ttl", "", "extension").policy).toBe("allow");
    expect(resolve("cache-ttl", "status", "extension").policy).toBe("allow");
    expect(resolve("cache-ttl", "on", "extension").policy).toBe("confirm");
    expect(resolve("cache-ttl", "keepalive on", "extension").policy).toBe("confirm");
    expect(resolve("cache-ttl", "save", "extension").policy).toBe("confirm");
  });

  it("/tasklist: no-args allow (text fallback), clear confirms", () => {
    expect(resolve("tasklist", "", "extension").policy).toBe("allow");
    expect(resolve("tasklist", "clear", "extension").policy).toBe("confirm");
  });

  it("/goal: no-args/status allow, everything else (pause/resume/clear/free-text objective) confirms", () => {
    expect(resolve("goal", "", "extension").policy).toBe("allow");
    expect(resolve("goal", "status", "extension").policy).toBe("allow");
    expect(resolve("goal", "pause", "extension").policy).toBe("confirm");
    expect(resolve("goal", "resume", "extension").policy).toBe("confirm");
    expect(resolve("goal", "clear", "extension").policy).toBe("confirm");
    expect(resolve("goal", "ship the thing", "extension").policy).toBe("confirm");
  });

  it("/task, /watch, /feishu-test always confirm; /pi-hud-refresh always allows", () => {
    expect(resolve("task", "do it", "extension").policy).toBe("confirm");
    expect(resolve("watch", "", "extension").policy).toBe("confirm");
    expect(resolve("feishu-test", "", "extension").policy).toBe("confirm");
    expect(resolve("pi-hud-refresh", "", "extension").policy).toBe("allow");
  });

  it("/clear always confirms (session-nav alias for /new)", () => {
    expect(resolve("clear", "", "extension").policy).toBe("confirm");
  });

  it("/resume-recent always denies (TUI-only selector, no text fallback)", () => {
    expect(resolve("resume-recent", "", "extension").policy).toBe("deny");
    expect(resolve("resume-recent", "--all", "extension").policy).toBe("deny");
  });

  it("/webhub: status (default or explicit) allows; every other sub-command (incl. __exec) denies", () => {
    expect(resolve("webhub", "", "extension").policy).toBe("allow");
    expect(resolve("webhub", "status", "extension").policy).toBe("allow");
    for (const sub of ["open", "passwd", "unlock", "restart", "__exec new abc123", "bogus"]) {
      expect(resolve("webhub", sub, "extension").policy).toBe("deny");
    }
  });

  it("an unknown (third-party) extension command defaults to confirm", () => {
    expect(resolve("some-third-party-command", "whatever args", "extension").policy).toBe("confirm");
  });
});

describe("resolveCommandPolicy — webHub.webCommandPolicy overrides (§4.6 U8)", () => {
  it("an override wins outright over the builtin/pi-toolkit/third-party defaults", () => {
    expect(resolveCommandPolicy({ name: "quit", args: "", kind: "builtin", overrides: { quit: "allow" } })).toEqual({
      policy: "allow",
    });
    expect(
      resolveCommandPolicy({
        name: "some-third-party-command",
        args: "",
        kind: "extension",
        overrides: { "some-third-party-command": "deny" },
      }),
    ).toEqual({ policy: "deny" });
    // An override on a name with no matching entry in overrides falls through to the default.
    expect(resolveCommandPolicy({ name: "session", args: "", kind: "builtin", overrides: { quit: "allow" } })).toEqual({
      policy: "allow",
    });
  });

  it("an override does not carry a policyBusy — it replaces the decision wholesale", () => {
    const decision = resolveCommandPolicy({
      name: "compact",
      args: "",
      kind: "builtin",
      overrides: { compact: "allow" },
    });
    expect(decision).toEqual({ policy: "allow" });
    expect(effectivePolicy(decision, true)).toBe("allow"); // no policyBusy ⇒ busy split does nothing
  });
});

describe("effectivePolicy", () => {
  it("returns policyBusy only while busy and only when set", () => {
    expect(effectivePolicy({ policy: "allow" }, true)).toBe("allow");
    expect(effectivePolicy({ policy: "allow", policyBusy: "confirm" }, false)).toBe("allow");
    expect(effectivePolicy({ policy: "allow", policyBusy: "confirm" }, true)).toBe("confirm");
  });
});
