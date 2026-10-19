// `/topic-switch` argument completions: single-token surface (status|last) — values must
// reproduce the full editor text under pi-tui applyCompletion's replace-the-whole-prefix
// semantics (regression guard for the `/webhub feishu setup` → `/webhub setup` bug class).

import { describe, expect, it, vi } from "vitest";
import { createTopicSwitchCommand, type TopicSwitchCommandDeps } from "../../src/topic-switch/command.js";

function deps(): TopicSwitchCommandDeps {
  return {
    now: () => 0,
    appendEntryRaw: vi.fn(),
    sendUserMessage: vi.fn(),
    consumeHopNonce: () => undefined,
    onPreflightFailed: vi.fn(),
    onPonr: vi.fn(),
    onSwitchEntered: vi.fn(),
    onSwitchCancelled: vi.fn(),
    clearInFlight: vi.fn(),
    recordSwitched: vi.fn(),
    setTransfer: vi.fn(),
    casTransfer: () => false,
    pickTransfer: () => undefined,
    markShutdownSeq: () => 0,
    shutdownHappenedSince: () => false,
    statusText: () => "status",
  };
}

describe("/topic-switch getArgumentCompletions", () => {
  it("offers single-token subcommands whose values are the full argument text", () => {
    const cmd = createTopicSwitchCommand(deps());
    expect(cmd.getArgumentCompletions!("")!.map((i) => i.value)).toEqual(["status", "last"]);
    const [last] = cmd.getArgumentCompletions!("la")!;
    expect(last).toEqual({ value: "last", label: "last", description: expect.any(String) });
    // applyCompletion: newArgs = value → `/topic-switch last` byte-for-byte.
    expect(`/topic-switch ${last!.value}`).toBe("/topic-switch last");
  });
});
