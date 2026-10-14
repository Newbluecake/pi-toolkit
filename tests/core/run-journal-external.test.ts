import { describe, expect, it } from "vitest";
import { journalSnapshotFromState } from "../../src/core/run-journal.js";
import { createInitialState } from "../../src/core/state-machine.js";
import type { RunDiagnostics, RunState } from "../../src/core/types.js";

/**
 * external-agent plan §2.6 (P1): the journal diag whitelist carries `external`
 * (ExternalRunMeta via the external_meta session event), and `usage.unpriced`
 * persists automatically because `usage` is already whitelisted.
 */
describe("run journal carries external-agent diag (plan §2.6)", () => {
  it("external meta is projected into the journal snapshot", () => {
    const base = createInitialState("r_ext", 1, 1_000);
    const diag: RunDiagnostics = {
      ...base.diag,
      external: {
        provider: "droid",
        sessionId: "abcd1234",
        autonomy: "high",
        credits: 120,
        permissionApprovals: 1,
        degraded: ["protocol_drift"],
        pricing: { status: "priced", source: "anthropic/claude-sonnet-5", basis: "upstream" },
        nativeSessionFile: "/agent/external-agent/droid/sessions/abcd1234.jsonl",
        unknownNotifications: 2,
      },
    };
    const state: RunState = { ...base, diag };
    const snap = journalSnapshotFromState(state, 2_000, { kind: "session_created" });
    expect(snap.diag.external).toEqual(diag.external);
  });

  it("a run without external meta keeps the key absent (pi runs unchanged)", () => {
    const base = createInitialState("r_pi", 1, 1_000);
    const snap = journalSnapshotFromState({ ...base, diag: base.diag }, 2_000, { kind: "session_created" });
    expect("external" in snap.diag).toBe(false);
  });

  it("usage.unpriced rides the already-whitelisted usage field", () => {
    const base = createInitialState("r_unpriced", 1, 1_000);
    const diag: RunDiagnostics = {
      ...base.diag,
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: "all" },
    };
    const snap = journalSnapshotFromState({ ...base, diag }, 2_000, { kind: "session_created" });
    expect(snap.diag.usage).toEqual({
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      unpriced: "all",
    });
  });
});
