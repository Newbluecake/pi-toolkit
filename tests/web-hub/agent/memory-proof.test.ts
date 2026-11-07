import { describe, expect, it, vi } from "vitest";
import {
  createHumanDispatchProof,
  createHumanDispatchHookOwner,
} from "../../../src/web-hub/agent/human-dispatch-proof.js";
import { createHumanTurnTracker } from "../../../src/memory/scopes/op-cap.js";
import type { MemoryOwner, HumanDispatchTicket, HumanIngressCandidate } from "../../../src/memory/scopes/types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const origin = { listener: "loopback" as const, ip: "127.0.0.1", reqId: "browser" };
function fixture() {
  let owner: MemoryOwner = { incarnation: {}, sid: "own-sid", branchGen: 1, sessionEpoch: 1 };
  const state = { idle: true, pending: false, mode: "tui" as "tui" | "rpc", enabled: true };
  const tracker = createHumanTurnTracker();
  const ctx = {
    get mode() {
      return state.mode;
    },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
  };
  const proof = createHumanDispatchProof({
    owner: () => owner,
    context: () => ctx,
    enabled: () => state.enabled,
    tracker,
  });
  const ticket = (generation = 1): HumanDispatchTicket => ({
    cmdId: "cmd",
    owner,
    nonce: {},
    dispatchGeneration: generation,
    originKind: "loopback",
  });
  const start = () => {
    proof.onBeforeAgentStart({ messageType: "user" });
    return tracker.current();
  };
  return {
    proof,
    tracker,
    state,
    ctx,
    ticket,
    start,
    owner: () => owner,
    change: (delta: Partial<MemoryOwner>) => {
      owner = { ...owner, ...delta };
    },
  };
}

describe("P3b activation-private proof factory", () => {
  it("native interactive needs a user start, not just an input or a custom start", () => {
    const f = fixture();
    f.proof.onInput({ source: "interactive" });
    expect(f.tracker.current()).toBeUndefined();
    f.proof.onBeforeAgentStart({ messageType: "custom" });
    expect(f.tracker.current()).toBeUndefined();
    f.proof.onSettled();
    f.proof.onInput({ source: "interactive" });
    expect(f.start()?.channel).toBe("tui");
    f.proof.dispose();
  });
  it("Web uses the current scope ticket once, regardless of prompt text/XS settings", () => {
    const f = fixture();
    const t = f.ticket();
    f.proof.runDispatch(t, () => {
      f.proof.onInput({ source: "extension" });
      expect(f.tracker.current()).toBeUndefined();
      expect(f.start()?.channel).toBe("web");
    });
    f.proof.onSettled();
    f.proof.runDispatch(t, () => {
      f.proof.onInput({ source: "extension" });
      expect(f.start()).toBeUndefined();
    });
    f.proof.dispose();
  });
  it("a newer dispatch generation supersedes an older delayed same-scope ingress", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.proof.runDispatch(f.ticket(1), async () => {
      await wait;
      f.proof.onInput({ source: "extension" });
      f.start();
    });
    f.proof.runDispatch(f.ticket(2), () => {});
    release!();
    await first;
    expect(f.tracker.current()).toBeUndefined();
    f.proof.dispose();
  });
  it("late rejection of an old dispatch cannot revoke a different new human turn", async () => {
    const f = fixture();
    let reject: ((error: Error) => void) | undefined;
    const pending = f.proof.runDispatch(f.ticket(), () => {
      f.proof.onInput({ source: "extension" });
      f.start();
      return new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    });
    f.proof.onSettled();
    f.proof.onInput({ source: "interactive" });
    const next = f.start();
    expect(next).toBeDefined();
    reject!(new Error("old rejection"));
    await expect(pending).rejects.toThrow("old rejection");
    expect(f.tracker.current()).toBe(next);
    f.proof.dispose();
  });
  it("a candidate cannot be confirmed outside its async dispatch chain", () => {
    const f = fixture();
    let candidate: HumanIngressCandidate | undefined;
    f.proof.runDispatch(f.ticket(), () => {
      candidate = f.proof.claim(f.owner(), { source: "extension" });
    });
    expect(candidate).toBeDefined();
    expect(f.proof.confirmStart(candidate!, f.owner())).toBeUndefined();
    f.proof.dispose();
  });
  it.each(["idle", "pending", "missing", "throw", "running", "disabled"])(
    "%s admission failure never blocks ordinary send or mints memory authority",
    (gate) => {
      const f = fixture();
      if (gate === "idle") f.state.idle = false;
      if (gate === "pending") f.state.pending = true;
      if (gate === "disabled") f.state.enabled = false;
      if (gate === "missing") f.ctx.isIdle = undefined as never;
      if (gate === "throw")
        f.ctx.hasPendingMessages = () => {
          throw new Error("unavailable");
        };
      if (gate === "running") f.proof.onAgentStart();
      const send = vi.fn(() => {
        f.proof.onInput({ source: "extension" });
        f.start();
        return 37;
      });
      expect(f.proof.dispatchWeb("cmd", origin, send)).toBe(37);
      expect(send).toHaveBeenCalledOnce();
      expect(f.tracker.current()).toBeUndefined();
      f.proof.dispose();
    },
  );
  it.each(["steer", "followUp"] as const)("native %s metadata forbids a turn", (behavior) => {
    const f = fixture();
    f.proof.dispatchWeb("cmd", origin, () => {
      f.proof.onInput({ source: "extension", streamingBehavior: behavior });
      expect(f.start()).toBeUndefined();
    });
    f.proof.dispose();
  });
  it.each(["rpc", "extension"] as const)("bare %s is never proof", (source) => {
    const f = fixture();
    f.proof.onInput({ source });
    expect(f.start()).toBeUndefined();
    f.proof.dispose();
  });
  it("RPC interactive is still machine input", () => {
    const f = fixture();
    f.state.mode = "rpc";
    f.proof.onInput({ source: "interactive" });
    expect(f.start()).toBeUndefined();
    f.proof.dispose();
  });
  it.each([
    { sid: "new-sid" },
    { sessionEpoch: 2 },
    { branchGen: 2 },
    { incarnation: {} },
    { sessionFile: "/tmp/new-own-file" },
  ])("owner boundary %j rejects the pending source", (delta) => {
    const f = fixture();
    f.proof.dispatchWeb("cmd", origin, () => {
      f.proof.onInput({ source: "extension" });
      f.change(delta);
      expect(f.start()).toBeUndefined();
    });
    f.proof.dispose();
  });
  it.each(["input", "session", "tree", "abort", "reload", "handled", "dispatch-error", "shutdown"] as const)(
    "%s revokes pending and live turns",
    (reason) => {
      const f = fixture();
      f.proof.onInput({ source: "interactive" });
      expect(f.start()).toBeDefined();
      f.proof.revoke(reason);
      expect(f.tracker.current()).toBeUndefined();
      f.proof.dispose();
    },
  );
  it("nested same-scope machine ingress consumes no second ticket and invalidates the outer candidate", () => {
    const f = fixture();
    f.proof.dispatchWeb("cmd", origin, () => {
      f.proof.onInput({ source: "extension" });
      f.proof.onInput({ source: "extension" });
      expect(f.start()).toBeUndefined();
    });
    f.proof.dispose();
  });
  it("Feishu and unknown origins mask even an inherited browser scope", () => {
    for (const bad of [
      { ...origin, ip: "feishu" },
      { ...origin, listener: "unknown" as never },
    ]) {
      const f = fixture();
      f.proof.dispatchWeb("outer", origin, () => {
        f.proof.dispatchWeb("inner", bad, () => {
          f.proof.onInput({ source: "extension" });
          expect(f.start()).toBeUndefined();
        });
      });
      f.proof.dispose();
    }
  });
  it("dispatch throw and returned Promise rejection revoke without swallowing delivery errors", async () => {
    const f = fixture();
    const failure = new Error("dispatch failed");
    expect(() =>
      f.proof.dispatchWeb("cmd", origin, () => {
        f.proof.onInput({ source: "extension" });
        f.start();
        throw failure;
      }),
    ).toThrow(failure);
    expect(f.tracker.current()).toBeUndefined();
    f.proof.onSettled();
    const result = f.proof.dispatchWeb("next", origin, async () => {
      f.proof.onInput({ source: "extension" });
      f.start();
      throw failure;
    });
    await expect(result).rejects.toBe(failure);
    expect(f.tracker.current()).toBeUndefined();
    f.proof.dispose();
  });
  it("hook owner is instance-local and idempotent (Web does not register a second owner)", () => {
    const f = fixture();
    const on = vi.fn();
    const pi = { on } as unknown as ExtensionAPI;
    const wire = createHumanDispatchHookOwner(f.proof);
    wire(pi);
    const count = on.mock.calls.length;
    wire(pi);
    expect(on.mock.calls).toHaveLength(count);
    expect(on.mock.calls.map((call) => call[0])).toEqual([
      "input",
      "before_agent_start",
      "agent_start",
      "agent_end",
      "agent_settled",
      "session_start",
      "session_tree",
      "session_shutdown",
    ]);
    f.proof.dispose();
  });
});
