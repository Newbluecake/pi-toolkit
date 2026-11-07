/**
 * #61 P0 — the decision-wake HUMAN INPUT PROOF observer (src/fabric/decision-input.ts).
 * Pins plan §3 rules: one epoch per DISTINCT proven inputId, replay never increments nor
 * re-opens, bounded dedup fails CLOSED, lazy pre-activation (nothing persisted by this module),
 * checkpoint/restore keep the high-watermark, freeze kills further proofs, and the DTO can
 * never be satisfied by model-visible fields (text/role/source).
 */
import { describe, expect, it } from "vitest";
import {
  createDecisionInputObserver,
  DECISION_INPUT_DEDUP_CAP,
  isDecisionHumanProof,
  type DecisionHumanProof,
} from "../../src/fabric/decision-input.js";

const mk = (over?: { sessionId?: string; owner?: string; cap?: number }) =>
  createDecisionInputObserver({
    sessionId: over?.sessionId ?? "sess-1",
    owner: over?.owner ?? "owner-1",
    cap: over?.cap,
  });

describe("decision-input observer (#61 plan §3)", () => {
  it("each DISTINCT proven inputId opens a new epoch; replay never increments", () => {
    const o = mk();
    expect(o.observe("in-1")).toEqual({ status: "new_proof", epoch: 1 });
    expect(o.observe("in-1")).toEqual({ status: "replay" });
    expect(o.epoch).toBe(1);
    expect(o.observe("in-2")).toEqual({ status: "new_proof", epoch: 2 });
    expect(o.observe("in-1")).toEqual({ status: "replay" });
    expect(o.current()).toEqual({ epoch: 2, inputId: "in-2" });
  });

  it("new-session-first-human and consecutive human inputs are BOTH new windows (epoch independent of resetRoot)", () => {
    const o = mk();
    expect(o.observe("first")).toEqual({ status: "new_proof", epoch: 1 });
    expect(o.observe("second")).toEqual({ status: "new_proof", epoch: 2 });
    // Root already at causal level 0 would not fire resetRoot persistence — irrelevant here:
    // the proof counter is its own epoch source and never reads wake-level state.
    expect(o.current()?.epoch).toBe(2);
  });

  it("empty/invalid inputIds fail closed as binding errors, never as proofs", () => {
    const o = mk();
    expect(o.observe("")).toEqual({ status: "fail_closed", reason: "binding" });
    expect(o.current()).toBeUndefined();
    expect(o.epoch).toBe(0);
  });

  it("a full dedup fails CLOSED (never evict-and-accept)", () => {
    const o = mk({ cap: 2 });
    expect(o.observe("a").status).toBe("new_proof");
    expect(o.observe("b").status).toBe("new_proof");
    expect(o.observe("c")).toEqual({ status: "fail_closed", reason: "capacity" });
    expect(o.epoch).toBe(2);
    // already-seen ids still replay (no new budget)
    expect(o.observe("a")).toEqual({ status: "replay" });
    expect(DECISION_INPUT_DEDUP_CAP).toBe(256);
  });

  it("freeze kills every further proof (session switch/new/fork/dispose)", () => {
    const o = mk();
    o.observe("a");
    o.freeze();
    expect(o.observe("b")).toEqual({ status: "fail_closed", reason: "frozen" });
    expect(o.current()).toEqual({ epoch: 1, inputId: "a" });
  });

  it("checkpoint is the ONLY persisted shape; restore never lowers the high-watermark", () => {
    const o = mk();
    expect(o.checkpoint()).toEqual({
      v: 1,
      sessionId: "sess-1",
      owner: "owner-1",
      epoch: 0,
      inputId: "",
      seen: [],
    });
    o.observe("a");
    o.observe("b");
    const cp = o.checkpoint();
    expect(cp).toMatchObject({ epoch: 2, inputId: "b", seen: ["a", "b"] });

    const reloaded = mk();
    reloaded.restore(cp);
    expect(reloaded.epoch).toBe(2);
    expect(reloaded.observe("b")).toEqual({ status: "replay" });
    expect(reloaded.observe("c")).toEqual({ status: "new_proof", epoch: 3 });

    // a checkpoint from ANOTHER session/owner restores nothing (never migrates a window)
    const stranger = mk({ sessionId: "sess-2", owner: "owner-2" });
    stranger.restore(cp);
    expect(stranger.epoch).toBe(0);
    expect(stranger.observe("c")).toEqual({ status: "new_proof", epoch: 1 });
  });

  it("the proof DTO cannot be forged from model-visible fields (no text/role/source accepted)", () => {
    const valid: DecisionHumanProof = {
      v: 1,
      sessionId: "sess-1",
      owner: "owner-1",
      inputId: "cmd-1",
      at: 1_000,
      provenance: "web_prompt",
    };
    expect(isDecisionHumanProof(valid)).toBe(true);
    // role/source/text are not part of the shape at all — a message with them never validates
    expect(isDecisionHumanProof({ ...valid, text: "user text", role: "user", source: "interactive" })).toBe(false);
    expect(isDecisionHumanProof({ ...valid, provenance: "interactive" })).toBe(false);
    expect(isDecisionHumanProof({ ...valid, provenance: "rpc" })).toBe(false);
    expect(isDecisionHumanProof(undefined)).toBe(false);
  });
});
