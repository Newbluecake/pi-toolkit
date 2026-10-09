import { describe, expect, it } from "vitest";
import { digestOfPayload, ENTRY_TYPE } from "../../src/topic-switch/records.js";
import { runRecovery, type RecoveryDeps } from "../../src/topic-switch/recovery.js";
import type { EntryLike, HeldPayload, TransferLike } from "../../src/topic-switch/types.js";

function heldPayload(text: string): HeldPayload {
  return { text, digest: digestOfPayload(text, undefined) };
}

function custom(data: unknown): EntryLike {
  return { type: "custom", customType: ENTRY_TYPE, data };
}

function userMessage(text: string): EntryLike {
  return { type: "message", message: { role: "user", content: text } };
}

function makeDeps(over: Partial<RecoveryDeps> = {}): RecoveryDeps & {
  calls: {
    appendRecord: unknown[];
    notify: Array<{ message: string; level?: string }>;
    setEditorText: string[];
    markDelivering: string[];
    deliver: HeldPayload[];
  };
} {
  const calls = {
    appendRecord: [] as unknown[],
    notify: [] as Array<{ message: string; level?: string }>,
    setEditorText: [] as string[],
    markDelivering: [] as string[],
    deliver: [] as HeldPayload[],
  };
  const deps: RecoveryDeps & { calls: typeof calls } = {
    branch: [],
    transfer: undefined,
    sessionId: "s1",
    reason: "startup",
    now: () => 1_000,
    appendRecord: (data) => calls.appendRecord.push(data),
    notify: (message, level) => calls.notify.push({ message, ...(level === undefined ? {} : { level }) }),
    setEditorText: (text) => calls.setEditorText.push(text),
    markDelivering: (holdId) => {
      calls.markDelivering.push(holdId);
      return true;
    },
    deliver: (payload) => calls.deliver.push(payload),
    calls,
    ...over,
  };
  return deps;
}

describe("runRecovery: six scenarios (plan.md §P3b.7 / I5)", () => {
  it("1. same-session reload with a pending transfer ⇒ deliver, marking delivering FIRST", () => {
    const order: string[] = [];
    const payload = heldPayload("switched request");
    const transfer: TransferLike = {
      holdId: "h1",
      payload,
      fromSessionId: "s1",
      reason: "switch",
      state: "pending",
      at: 500,
    };
    const deps = makeDeps({
      transfer,
      reason: "reload",
      markDelivering: (holdId) => {
        order.push(`markDelivering:${holdId}`);
        return true;
      },
      deliver: (p) => {
        order.push(`deliver:${p.text}`);
      },
    });
    runRecovery(deps);
    expect(order).toEqual(["markDelivering:h1", "deliver:switched request"]);
  });

  it("1b. markDelivering losing the CAS skips the deliver call entirely (something else already moved it on)", () => {
    const payload = heldPayload("x");
    const transfer: TransferLike = {
      holdId: "h1",
      payload,
      fromSessionId: "s1",
      reason: "switch",
      state: "pending",
      at: 500,
    };
    const deps = makeDeps({ transfer, reason: "reload", markDelivering: () => false });
    runRecovery(deps);
    expect(deps.calls.deliver).toEqual([]);
  });

  it("2. cross-session (new/resume/fork) with a pending transfer ⇒ editor + notify, never deliver", () => {
    const payload = heldPayload("never delivered");
    const transfer: TransferLike = {
      holdId: "h2",
      payload,
      fromSessionId: "other-session",
      reason: "switch",
      state: "pending",
      at: 500,
    };
    for (const reason of ["new", "resume", "fork"] as const) {
      const deps = makeDeps({ transfer, reason });
      runRecovery(deps);
      expect(deps.calls.setEditorText).toEqual(["never delivered"]);
      expect(deps.calls.notify).toHaveLength(1);
      expect(deps.calls.deliver).toEqual([]);
      expect(deps.calls.markDelivering).toEqual([]);
    }
  });

  it("3. an unresolved delivering record whose next user message digest matches ⇒ resolve(observed)", () => {
    const payload = heldPayload("delivered text");
    const branch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 100, holdId: "h3", payload }),
      custom({ v: 1, kind: "delivering", at: 200, holdId: "h3" }),
      userMessage("delivered text"),
    ];
    const deps = makeDeps({ branch });
    runRecovery(deps);
    expect(deps.calls.appendRecord).toEqual([{ v: 1, kind: "resolved", at: 1_000, holdId: "h3", how: "observed" }]);
    expect(deps.calls.notify).toEqual([]);
  });

  it("4. an unresolved delivering record with NO matching next user message ⇒ notice only (never auto-redelivers)", () => {
    const payload = heldPayload("maybe lost");
    const branch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 100, holdId: "h4", payload }),
      custom({ v: 1, kind: "delivering", at: 200, holdId: "h4" }),
      userMessage("a completely different message"),
    ];
    const deps = makeDeps({ branch });
    runRecovery(deps);
    expect(deps.calls.deliver).toEqual([]);
    expect(deps.calls.setEditorText).toEqual([]);
    expect(deps.calls.notify).toHaveLength(1);
    expect(deps.calls.notify[0]!.message).toContain("maybe lost");
    expect(deps.calls.appendRecord).toEqual([{ v: 1, kind: "resolved", at: 1_000, holdId: "h4", how: "noticed" }]);
  });

  it("5. a crash-left pending record (no delivering, no transfer) ⇒ notice, never auto-delivered", () => {
    const payload = heldPayload("crashed before switch");
    const branch: EntryLike[] = [custom({ v: 1, kind: "pending", at: 100, holdId: "h5", payload })];
    const deps = makeDeps({ branch });
    runRecovery(deps);
    expect(deps.calls.deliver).toEqual([]);
    expect(deps.calls.notify).toHaveLength(1);
    expect(deps.calls.appendRecord).toEqual([{ v: 1, kind: "resolved", at: 1_000, holdId: "h5", how: "noticed" }]);
  });

  it("6. a handoff record (normal residue of a successful switch) triggers no action at all", () => {
    const payload = heldPayload("switched cleanly");
    const branch: EntryLike[] = [custom({ v: 1, kind: "handoff", at: 100, holdId: "h6", payload })];
    const deps = makeDeps({ branch });
    runRecovery(deps);
    expect(deps.calls.deliver).toEqual([]);
    expect(deps.calls.notify).toEqual([]);
    expect(deps.calls.setEditorText).toEqual([]);
    expect(deps.calls.appendRecord).toEqual([]);
  });
});

describe("runRecovery: each notice/resolve fires exactly once across repeated session_start calls", () => {
  it("a resolved delivering record is never re-noticed on a later run over the same (now-extended) branch", () => {
    const payload = heldPayload("once only");
    const branch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 100, holdId: "h7", payload }),
      custom({ v: 1, kind: "delivering", at: 200, holdId: "h7" }),
    ];
    const deps1 = makeDeps({ branch });
    runRecovery(deps1);
    expect(deps1.calls.notify).toHaveLength(1);

    // Simulate the SAME branch plus the resolved record this run just wrote (what the next
    // session_start would actually observe on disk).
    const extendedBranch: EntryLike[] = [
      ...branch,
      custom({ v: 1, kind: "resolved", at: 1_000, holdId: "h7", how: "noticed" }),
    ];
    const deps2 = makeDeps({ branch: extendedBranch });
    runRecovery(deps2);
    expect(deps2.calls.notify).toEqual([]);
    expect(deps2.calls.appendRecord).toEqual([]);
  });
});

describe("runRecovery: m3 dedupe — a deliver/editor action for a holdId suppresses that SAME holdId's notice", () => {
  it("reload with BOTH a pending transfer (rule 1 ⇒ deliver) and the disk pending record persistPending also wrote (rule 4 ⇒ would-be notice) for the SAME holdId: deliver once, never a false ‘未能送达’ notice", () => {
    const payload = heldPayload("deliver and dedupe");
    // Exactly what `persistPending` writes: a disk `pending` record AND an in-process transfer,
    // same holdId, same payload (verifier M3's exact repro shape).
    const transfer: TransferLike = {
      holdId: "hd1",
      payload,
      fromSessionId: "s1",
      reason: "reload",
      state: "pending",
      at: 500,
    };
    const branch: EntryLike[] = [custom({ v: 1, kind: "pending", at: 500, holdId: "hd1", payload })];
    const deps = makeDeps({ branch, transfer, reason: "reload", sessionId: "s1" });
    runRecovery(deps);
    expect(deps.calls.deliver).toEqual([payload]);
    expect(deps.calls.notify).toEqual([]); // the dedupe: no false "可能未能送达" notice for hd1
    expect(deps.calls.markDelivering).toEqual(["hd1"]);
  });

  it("cross-session (rule 2 ⇒ editor) PLUS the disk pending record for the SAME holdId: editor fill once, never ALSO a notice", () => {
    const payload = heldPayload("editor and dedupe");
    const transfer: TransferLike = {
      holdId: "hd2",
      payload,
      fromSessionId: "other-session",
      reason: "switch",
      state: "pending",
      at: 500,
    };
    const branch: EntryLike[] = [custom({ v: 1, kind: "pending", at: 500, holdId: "hd2", payload })];
    const deps = makeDeps({ branch, transfer, reason: "new" });
    runRecovery(deps);
    expect(deps.calls.setEditorText).toEqual(["editor and dedupe"]);
    // exactly ONE notify (the editor action's own "已放回输入框" notice) — never a SECOND, separate
    // "可能未能送达" notice for the same holdId from rule 4.
    expect(deps.calls.notify).toHaveLength(1);
    expect(deps.calls.appendRecord).toEqual([]); // rule 4's own "resolved/noticed" write never fires either
  });

  it("a DIFFERENT holdId's notice is unaffected by another holdId's deliver/editor in the same run (dedupe is per-holdId)", () => {
    const payloadA = heldPayload("delivered one");
    const payloadB = heldPayload("crashed, unrelated");
    const transfer: TransferLike = {
      holdId: "hA",
      payload: payloadA,
      fromSessionId: "s1",
      reason: "reload",
      state: "pending",
      at: 500,
    };
    const branch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 500, holdId: "hA", payload: payloadA }),
      custom({ v: 1, kind: "pending", at: 600, holdId: "hB", payload: payloadB }),
    ];
    const deps = makeDeps({ branch, transfer, reason: "reload", sessionId: "s1" });
    runRecovery(deps);
    expect(deps.calls.deliver).toEqual([payloadA]);
    expect(deps.calls.notify).toHaveLength(1); // hB's genuine crash-left notice still fires
    expect(deps.calls.notify[0]!.message).toContain("crashed, unrelated");
  });
});

describe("runRecovery: fail-open", () => {
  it("a branch that is not actually an array degrades to no actions, never throws", () => {
    const deps = makeDeps({ branch: undefined as unknown as EntryLike[] });
    expect(() => runRecovery(deps)).not.toThrow();
  });

  it("one action throwing (a broken notify port) does not block the rest of recovery", () => {
    const payload1 = heldPayload("a");
    const payload2 = heldPayload("b");
    const branch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 100, holdId: "ha", payload: payload1 }),
      custom({ v: 1, kind: "delivering", at: 100, holdId: "ha" }),
      custom({ v: 1, kind: "pending", at: 200, holdId: "hb", payload: payload2 }),
    ];
    let notifyCalls = 0;
    const deps = makeDeps({
      branch,
      notify: () => {
        notifyCalls += 1;
        if (notifyCalls === 1) throw new Error("boom");
      },
    });
    expect(() => runRecovery(deps)).not.toThrow();
    // Both the "ha" notice and the "hb" notice were attempted even though the first threw.
    expect(notifyCalls).toBe(2);
  });
});
