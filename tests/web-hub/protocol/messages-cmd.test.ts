/**
 * P2 control-plane frame schema tests (plan §3.2/§3.1, package C0 frozen surface).
 *
 * Round-trips every new frame type through `decodeAgentFrame`/`decodeHubFrame`
 * (strict `additionalProperties:false` schemas) and pins the version/cap
 * constants (`P2_AGENT_CAPS`/`P2_HUB_CAPS`/`SLOT_REQUIRED_CAP`,
 * `RESERVED_FRAME_TYPES` shrunk to the still-reserved D1/D2 names).
 */
import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  P1_CAPS,
  P2_AGENT_CAPS,
  P2_HUB_CAPS,
  PROTO,
  RESERVED_FRAME_TYPES,
  SLOT_REQUIRED_CAP,
} from "../../../src/web-hub/protocol/version.js";

const origin = { listener: "loopback", ip: "127.0.0.1", reqId: "0123456789abcdef" } as const;

describe("version.ts P2 constants", () => {
  it("PROTO is 1.2 (major-only compat, minor is documentation)", () => {
    // fleet-drawer F0 raised minor 1.1 → 1.2 (first new agent↔hub frames since 1.0).
    expect(PROTO).toEqual({ major: 1, minor: 2 });
  });
  it("P2_AGENT_CAPS / P2_HUB_CAPS are the frozen cap names", () => {
    expect([...P2_AGENT_CAPS]).toEqual(["cmd.v1", "dialog.v1", "command.v1"]);
    expect([...P2_HUB_CAPS]).toEqual(["cmd.v1", "dialog.v1", "command.v1", "ctl.v2"]);
  });
  it("SLOT_REQUIRED_CAP maps exactly the three gated slots", () => {
    expect(SLOT_REQUIRED_CAP).toEqual({ dialogs: "dialog.v1", ctl: "cmd.v1", commands: "command.v1" });
  });
  it("RESERVED_FRAME_TYPES is now only the D1/D2 permanently-retired names", () => {
    expect([...RESERVED_FRAME_TYPES]).toEqual(["dialog_open", "dialog_closed", "dialog_answer"]);
  });
  it("P1_CAPS unchanged", () => {
    expect([...P1_CAPS]).toEqual(["ev.v1", "fleet.v1", "snapshot.v1", "branch.v1"]);
  });
});

describe("cmd (hub\u2192agent)", () => {
  it("accepts a well-formed prompt cmd", () => {
    const raw = {
      t: "cmd",
      rid: "r1",
      id: "AAAAAAAAAAAAAAAA",
      deadlineMs: 5000,
      origin,
      cmd: { op: "prompt", text: "hi", deliver: "steer" },
    };
    expect(decodeHubFrame(raw)).toEqual(raw);
  });

  it("accepts every CmdArgs op variant", () => {
    const variants: Record<string, unknown>[] = [
      { op: "prompt", text: "hi", deliver: "followUp" },
      { op: "abort" },
      { op: "steer_subagent", runId: "run_1", text: "steer" },
      { op: "abort_subagent", runId: "run_1" },
      { op: "dialog_answer", dialogId: "ask:1", epoch: "e1", answers: [{ selected: ["a"], other: null }] },
      { op: "dialog_cancel", dialogId: "ask:1", epoch: "e1" },
      { op: "command", name: "compact", args: "" },
    ];
    for (const cmd of variants) {
      const raw = { t: "cmd", rid: "r1", id: "AAAAAAAAAAAAAAAA", deadlineMs: 1000, origin, cmd };
      expect(decodeHubFrame(raw), JSON.stringify(cmd)).toEqual(raw);
    }
  });

  it("rejects an unknown extra property (additionalProperties:false)", () => {
    const raw = {
      t: "cmd",
      rid: "r1",
      id: "AAAAAAAAAAAAAAAA",
      deadlineMs: 1000,
      origin,
      cmd: { op: "abort" },
      extra: true,
    };
    expect(decodeHubFrame(raw)).toBeUndefined();
  });

  it("rejects a command name that fails the pattern", () => {
    const raw = {
      t: "cmd",
      rid: "r1",
      id: "AAAAAAAAAAAAAAAA",
      deadlineMs: 1000,
      origin,
      cmd: { op: "command", name: "bad name!", args: "" },
    };
    expect(decodeHubFrame(raw)).toBeUndefined();
  });

  it("rejects an id shorter than 16 chars", () => {
    const raw = { t: "cmd", rid: "r1", id: "short", deadlineMs: 1000, origin, cmd: { op: "abort" } };
    expect(decodeHubFrame(raw)).toBeUndefined();
  });
});

describe("cmd_result / cmd_late (agent\u2192hub)", () => {
  it("accepts an ok cmd_result", () => {
    const raw = { t: "cmd_result", rid: "r1", id: "x", ok: true, data: { op: "abort", wasBusy: false } };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("accepts a failed cmd_result with every CmdErrorCode-shaped code", () => {
    const raw = {
      t: "cmd_result",
      rid: "r1",
      id: "x",
      ok: false,
      code: "E_HUB_RESTARTING",
      retryable: true,
      effect: "none",
    };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("accepts a late frame with no rid", () => {
    const raw = { t: "cmd_late", id: "x", op: "steer_subagent", at: 123, ok: true, data: { op: "steer_subagent" } };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("rejects effect outside none|unknown", () => {
    const raw = { t: "cmd_result", rid: "r1", id: "x", ok: false, code: "E_DEADLINE", retryable: true, effect: "?" };
    expect(decodeAgentFrame(raw)).toBeUndefined();
  });
});

describe("dialogs / ctl / commands slots (agent\u2192hub)", () => {
  it("accepts an empty dialogs frame", () => {
    const raw = { t: "dialogs", epoch: "e1", open: [], closed: [] };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("accepts a dialogs frame with one open dialog", () => {
    const raw = {
      t: "dialogs",
      epoch: "e1",
      open: [
        {
          dialogId: "ask:1",
          source: "ask_user",
          toolCallId: "tc1",
          questions: [{ question: "q?", options: [{ label: "yes" }] }],
          allowCancel: true,
          openedAt: 1,
        },
      ],
      closed: [{ dialogId: "ask:2", by: "tui", outcome: "answered", at: 2 }],
    };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("accepts an empty ctl frame", () => {
    const raw = { t: "ctl", epoch: "e1", sessionId: "s1", items: [] };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("accepts a ctl frame with one item covering every optional field", () => {
    const raw = {
      t: "ctl",
      epoch: "e1",
      sessionId: "s1",
      items: [
        {
          cmdId: "c1",
          op: "command",
          state: "failed",
          behavior: "steer",
          reason: "timeout",
          code: "E_DEADLINE",
          at: 1,
          updatedAt: 2,
        },
      ],
    };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("accepts an empty commands frame", () => {
    const raw = { t: "commands", epoch: "e1", items: [] };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("accepts a commands frame with one item", () => {
    const raw = {
      t: "commands",
      epoch: "e1",
      items: [{ name: "compact", kind: "builtin", policy: "confirm", output: "captured" }],
    };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
});

describe("superseded (hub\u2192agent)", () => {
  it("accepts a plain superseded frame", () => {
    const raw = { t: "superseded", nextVersion: "1.2.3", yieldMs: 5000 };
    expect(decodeHubFrame(raw)).toEqual(raw);
  });
  it("accepts a forced superseded frame with openDialogs", () => {
    const raw = { t: "superseded", nextVersion: "1.2.3", yieldMs: 5000, forced: true, openDialogs: 2 };
    expect(decodeHubFrame(raw)).toEqual(raw);
  });
});

describe("hub_ctl union (agent\u2192hub)", () => {
  it("accepts shutdown reason:restart (legacy P1 shape)", () => {
    const raw = { t: "hub_ctl", rid: "r1", op: "shutdown", reason: "restart" };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("accepts shutdown reason:stop (v2.1)", () => {
    const raw = { t: "hub_ctl", rid: "r1", op: "shutdown", reason: "stop" };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("accepts rotate_token (v2.1, no reason field)", () => {
    const raw = { t: "hub_ctl", rid: "r1", op: "rotate_token" };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("rejects rotate_token carrying a reason field", () => {
    const raw = { t: "hub_ctl", rid: "r1", op: "rotate_token", reason: "restart" };
    expect(decodeAgentFrame(raw)).toBeUndefined();
  });
  it("hub_ctl_ack accepts an optional revoked breakdown", () => {
    const raw = { t: "hub_ctl_ack", rid: "r1", revoked: { loopback: 1, lan: 2 } };
    expect(decodeHubFrame(raw)).toEqual(raw);
  });
});
