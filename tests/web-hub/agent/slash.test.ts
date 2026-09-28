/**
 * §4.6 parse/classify + `commands` slot tests (plan control-plan.md §3.2/§4.6, package C11).
 */
import { describe, expect, it } from "vitest";
import {
  buildSlashText,
  classifyCommand,
  listSlashCommands,
  parseSlashCommand,
  type CommandsPort,
} from "../../../src/web-hub/agent/slash.js";

describe("parseSlashCommand / buildSlashText", () => {
  it("splits name and args, defaulting args to empty string", () => {
    expect(parseSlashCommand("/agent status r_abc")).toEqual({ name: "agent", args: "status r_abc" });
    expect(parseSlashCommand("/session")).toEqual({ name: "session", args: "" });
  });
  it("returns undefined for non-slash-shaped text", () => {
    expect(parseSlashCommand("hello world")).toBeUndefined();
    expect(parseSlashCommand("")).toBeUndefined();
  });
  it("buildSlashText is the inverse (round-trips through parseSlashCommand)", () => {
    expect(buildSlashText("agent", "status r_abc")).toBe("/agent status r_abc");
    expect(buildSlashText("session", "")).toBe("/session");
    expect(parseSlashCommand(buildSlashText("mem", "tidy --dry-run"))).toEqual({
      name: "mem",
      args: "tidy --dry-run",
    });
  });
});

function port(
  commands: Array<{ name: string; description?: string; source: "extension" | "prompt" | "skill" }>,
): CommandsPort {
  return { getCommands: () => commands };
}

describe("classifyCommand", () => {
  it("classifies a pi.getCommands() hit by its source (extension/prompt→template/skill)", () => {
    expect(classifyCommand(port([{ name: "agent", source: "extension" }]), "agent")).toEqual({ kind: "extension" });
    expect(classifyCommand(port([{ name: "review", source: "prompt" }]), "review")).toEqual({ kind: "template" });
    expect(classifyCommand(port([{ name: "dev-flow", source: "skill" }]), "dev-flow")).toEqual({ kind: "skill" });
  });
  it("carries the description through when present", () => {
    expect(classifyCommand(port([{ name: "agent", source: "extension", description: "diag" }]), "agent")).toEqual({
      kind: "extension",
      description: "diag",
    });
  });
  it("falls back to the builtin tables when there is no pi.getCommands() hit", () => {
    expect(classifyCommand(port([]), "session")).toEqual({ kind: "builtin" });
    expect(classifyCommand(port([]), "quit")).toEqual({ kind: "builtin" });
  });
  it("is undefined for a name in neither pi.getCommands() nor the builtin tables — never falls back to plain text", () => {
    expect(classifyCommand(port([]), "totally-made-up")).toBeUndefined();
  });
  it("tolerates a missing pi (undefined) and a throwing getCommands()", () => {
    expect(classifyCommand(undefined, "session")).toEqual({ kind: "builtin" });
    expect(classifyCommand(undefined, "made-up")).toBeUndefined();
    const throwing: CommandsPort = {
      getCommands() {
        throw new Error("boom");
      },
    };
    expect(classifyCommand(throwing, "session")).toEqual({ kind: "builtin" });
  });
  it("a pi.getCommands() hit takes priority over an identically-named builtin (e.g. a user prompt template)", () => {
    expect(classifyCommand(port([{ name: "session", source: "prompt" }]), "session")).toEqual({ kind: "template" });
  });
});

describe("listSlashCommands — commands slot (§3.2 CommandsFrame, ≤400 items, deduped by name)", () => {
  it("lists pi.getCommands() entries plus the full builtin table, each with an effective policy", () => {
    const items = listSlashCommands(port([{ name: "agent", source: "extension", description: "diagnostics" }]));
    const agent = items.find((i) => i.name === "agent");
    expect(agent).toMatchObject({ kind: "extension", policy: "allow", description: "diagnostics" });
    const compact = items.find((i) => i.name === "compact");
    expect(compact).toMatchObject({ kind: "builtin", policy: "allow", policyBusy: "confirm" });
    const quit = items.find((i) => i.name === "quit");
    expect(quit).toMatchObject({ kind: "builtin", policy: "deny" });
    // 24 BUILTIN_SLASH_COMMANDS names + the defensive literal "exit" = 25, minus the 7 bridge
    // names the bridge dispatches directly = 18 deny names + 7 bridge-dispatched names = 25...
    // (7 bridge + 19 deny, since "debug" is also denied) = 26 total builtin-kind entries.
    expect(items.filter((i) => i.kind === "builtin").length).toBe(26);
  });
  it("deduplicates by name (a pi.getCommands() entry wins over the builtin table)", () => {
    const items = listSlashCommands(port([{ name: "session", source: "extension" }]));
    expect(items.filter((i) => i.name === "session")).toHaveLength(1);
    expect(items.find((i) => i.name === "session")).toMatchObject({ kind: "extension" });
  });
  it("truncates descriptions to 120 characters", () => {
    const items = listSlashCommands(port([{ name: "agent", source: "extension", description: "x".repeat(200) }]));
    expect(items.find((i) => i.name === "agent")?.description).toHaveLength(120);
  });
  it("threads webCommandPolicy overrides and the output/captured classifier through", () => {
    const items = listSlashCommands(port([{ name: "agent", source: "extension" }]), {
      overrides: { agent: "deny" },
      output: (name) => (name === "agent" ? "captured" : undefined),
    });
    const agent = items.find((i) => i.name === "agent");
    expect(agent).toMatchObject({ policy: "deny", output: "captured" });
    expect(items.find((i) => i.name === "quit")?.output).toBeUndefined();
  });
  it("caps at 400 items", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `ext-${i}`, source: "extension" as const }));
    expect(listSlashCommands(port(many))).toHaveLength(400);
  });
  it("degrades to just the builtin table when pi is undefined", () => {
    const items = listSlashCommands(undefined);
    expect(items.every((i) => i.kind === "builtin")).toBe(true);
    expect(items.length).toBe(26);
  });
});
