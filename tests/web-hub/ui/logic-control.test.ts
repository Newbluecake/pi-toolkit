// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildDialogAnswers,
  commandPolicyFor,
  composerKeyAction,
  dialogComplete,
  mergeQueue,
  newCmdId,
  outcomeFromError,
  outcomeFromHttp,
  outcomeFromResponse,
  parseSlash,
  pendingTransition,
} from "../../../src/web-hub/ui/src/logic/control.js";

/**
 * Pure control-plane helpers (control-plan v2.1 §7.2/§7.7, package C4). `pendingTransition`
 * is covered table-driven, one row per (event × state) rule in §7.7's state machine:
 * `sending → (ok: observed|unobserved|done) | (failed{retryable}) | (unknown → querying →
 * done|failed|notExecuted)`.
 */

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/; // §3.2 id format (hub-side schema)

describe("newCmdId (§3.4: 16 bytes getRandomValues → base64url; K18: never randomUUID)", () => {
  it("produces 22-char base64url ids matching the hub's id schema, unique per call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCmdId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toHaveLength(22);
      expect(id).toMatch(ID_RE);
    }
  });

  it("uses the injected getRandomValues (deterministic in tests) and base64url-escapes +//=", () => {
    // 0xfb 0xff 0xbe … → standard base64 would contain '+' and '/'; base64url must not.
    const id = newCmdId((buf) => {
      buf.fill(0xfb);
      return buf;
    });
    expect(id).toMatch(ID_RE);
    expect(id).not.toMatch(/[+/=]/);
    expect(id).toBe("-_v7-_v7-_v7-_v7-_v7-w");
  });

  it("falls back to a fixed placeholder when getRandomValues is unavailable (LAN plaintext K18)", () => {
    // (an explicit non-function value: `undefined` would just re-trigger the default lookup)
    expect(newCmdId(null)).toBe("AAAAAAAAAAAAAAAAAAAAAA");
  });
});

describe("parseSlash (§7.7)", () => {
  it.each([
    ["/compact", { name: "compact", args: "" }],
    ["/model cr-x/y --flag", { name: "model", args: "cr-x/y --flag" }],
    ["/agent settings  list  ", { name: "agent", args: "settings  list  " }],
    ["/skill:x do thing", { name: "skill:x", args: "do thing" }],
  ])("parses %s", (text, expected) => {
    expect(parseSlash(text)).toEqual(expected);
  });

  it.each([
    ["//literal slash text", "the // escape means send-as-text"],
    ["plain text", "no leading slash"],
    ["", "empty"],
    ["/", "no name"],
    [" /compact", "leading space"],
    [42, "non-string"],
  ])("returns undefined for %s (%s)", (text) => {
    expect(parseSlash(text)).toBeUndefined();
  });
});

describe("mergeQueue (§7.2: optimistic first, server mirror authoritative, dropped filtered)", () => {
  const server = [
    { id: "q1", text: "tui typed", deliver: "steer", source: "tui", at: 1 },
    { id: "q2", text: "web confirmed", deliver: "followUp", source: "web", cmdId: "cmd-web-1", at: 2 },
  ];

  it("orders optimistic before server items", () => {
    const optimistic = [{ id: "cmd-new", state: "sending", text: "fresh", at: 3 }];
    expect(mergeQueue(server, optimistic, []).map((q) => q.id)).toEqual(["cmd-new", "q1", "q2"]);
  });

  it("drops an optimistic item whose cmdId the server queue already tracks", () => {
    const optimistic = [{ id: "cmd-web-1", state: "queued", text: "web confirmed", at: 2 }];
    expect(mergeQueue(server, optimistic, []).map((q) => q.id)).toEqual(["q1", "q2"]);
  });

  it("filters both server and optimistic items named by queueDropped", () => {
    const optimistic = [{ id: "cmd-old", state: "dropped", text: "x", at: 0 }];
    expect(mergeQueue(server, optimistic, ["cmd-web-1", "cmd-old"]).map((q) => q.id)).toEqual(["q1"]);
  });

  it("tolerates empty/garbage inputs", () => {
    expect(mergeQueue()).toEqual([]);
    expect(mergeQueue([null], [undefined, { noId: true }], [])).toEqual([null]);
  });
});

describe("composerKeyAction (§7.4 key map)", () => {
  it.each([
    [{ key: "Enter" }, {}, "prompt", "desktop Enter, idle ⇒ new turn"],
    [{ key: "Enter" }, { busy: true }, "steer", "desktop Enter, busy ⇒ steer"],
    [{ key: "Enter", altKey: true }, { busy: true }, "followUp", "Alt+Enter ⇒ followUp (TUI 同键)"],
    [{ key: "Enter", shiftKey: true }, {}, "newline", "Shift+Enter ⇒ newline"],
    [{ key: "Enter", isComposing: true }, {}, "newline", "IME composition never sends"],
    [{ key: "Enter", keyCode: 229 }, {}, "newline", "keyCode 229 (IME) never sends"],
    [
      { key: "Enter" },
      { coarse: true },
      "prompt",
      'coarse pointer: Enter also sends (enterkeyhint="send" promise; coarse=newline retired 2026-10-05)',
    ],
    [{ key: "a" }, {}, "newline", "any other key"],
  ])("%j %j ⇒ %s (%s)", (event, ctx, expected) => {
    expect(composerKeyAction(event, ctx)).toBe(expected);
  });
});

describe("commandPolicyFor (§4.6/§7.7)", () => {
  const commands = [
    { name: "session", policy: "allow" },
    { name: "compact", policy: "allow", policyBusy: "confirm" },
    { name: "quit", policy: "deny" },
  ];

  it("reads policy / policyBusy from the commands slot; unknown name ⇒ deny", () => {
    expect(commandPolicyFor(commands, "session", false)).toBe("allow");
    expect(commandPolicyFor(commands, "compact", false)).toBe("allow");
    expect(commandPolicyFor(commands, "compact", true)).toBe("confirm"); // busy override
    expect(commandPolicyFor(commands, "session", true)).toBe("allow"); // no policyBusy ⇒ unchanged
    expect(commandPolicyFor(commands, "quit", false)).toBe("deny");
    expect(commandPolicyFor(commands, "unknown", false)).toBe("deny");
    expect(commandPolicyFor([], "session", false)).toBe("deny");
  });
});

describe("buildDialogAnswers / dialogComplete (§7.2/§7.4)", () => {
  const questions = [
    { question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
    { question: "Pick many", options: [{ label: "X" }, { label: "Y" }], multiSelect: true },
  ];

  it("builds DialogAnswerWire[]; filters unknown labels; trims/empties Other to null", () => {
    const answers = buildDialogAnswers(questions, [
      { selected: ["A", "not-an-option", "A"], other: "  " },
      { selected: [], other: " free text " },
    ]);
    expect(answers).toEqual([
      { selected: ["A"], other: null },
      { selected: [], other: " free text " },
    ]);
  });

  it("returns undefined on a shape mismatch (form stays open)", () => {
    expect(buildDialogAnswers(questions, [{}])).toBeUndefined();
    expect(buildDialogAnswers(questions, "nope")).toBeUndefined();
  });

  it("dialogComplete: every question needs a selection or a non-empty Other", () => {
    expect(dialogComplete(questions, buildDialogAnswers(questions, [{ selected: ["A"] }, { other: "x" }]))).toBe(true);
    expect(dialogComplete(questions, buildDialogAnswers(questions, [{ selected: ["A"] }, { selected: [] }]))).toBe(
      false,
    );
    expect(dialogComplete(questions, [{ selected: ["A"] }, { other: null }])).toBe(false);
    expect(dialogComplete(questions, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pendingTransition — §7.7 state machine, one row per rule
// ---------------------------------------------------------------------------

const item = (extra = {}) => ({ id: "cmd-1", kind: "prompt", state: "sending", at: 1, ...extra });
const ok = (data) => ({ ok: true, data });
const err = (error, extra = {}) => ({ ok: false, error, retryable: false, effect: "none", ...extra });

describe("pendingTransition (§7.7)", () => {
  describe('event "result" (HTTP response of the initial send)', () => {
    it("prompt ok observed ⇒ observed (+behavior); unobserved otherwise", () => {
      expect(
        pendingTransition(item(), { type: "result", outcome: ok({ delivery: "observed", behavior: "steer" }) }),
      ).toMatchObject({ state: "observed", behavior: "steer" });
      expect(pendingTransition(item(), { type: "result", outcome: ok({ delivery: "unobserved" }) })).toMatchObject({
        state: "unobserved",
      });
      expect(pendingTransition(item(), { type: "result", outcome: ok({}) })).toMatchObject({
        state: "unobserved",
      });
    });

    it.each(["abort", "steer_subagent", "abort_subagent", "dialog_answer", "dialog_cancel"])(
      "%s ok ⇒ removed",
      (kind) => {
        expect(pendingTransition(item({ kind }), { type: "result", outcome: ok({}) })).toBeNull();
      },
    );

    it("command ok: sync/timeout ⇒ removed; async/unknown ⇒ running (cmd_late terminates)", () => {
      expect(
        pendingTransition(item({ kind: "command" }), { type: "result", outcome: ok({ completion: "sync" }) }),
      ).toBeNull();
      expect(
        pendingTransition(item({ kind: "command" }), { type: "result", outcome: ok({ completion: "timeout" }) }),
      ).toBeNull();
      expect(
        pendingTransition(item({ kind: "command" }), { type: "result", outcome: ok({ completion: "async" }) }),
      ).toMatchObject({ state: "running" });
      expect(
        pendingTransition(item({ kind: "command" }), { type: "result", outcome: ok({ completion: "unknown" }) }),
      ).toMatchObject({ state: "running" });
    });

    it("failure with effect unknown ⇒ unknown (never auto re-executed, D7)", () => {
      const next = pendingTransition(item(), {
        type: "result",
        outcome: err("E_DEADLINE", { retryable: true, effect: "unknown" }),
      });
      expect(next).toMatchObject({ state: "unknown", error: "E_DEADLINE", retryable: true, effect: "unknown" });
    });

    it("failure with effect none ⇒ failed{error, retryable} (E_HUB_RESTARTING included, v2.1)", () => {
      const next = pendingTransition(item(), {
        type: "result",
        outcome: err("E_HUB_RESTARTING", { retryable: true, effect: "none", message: "draining" }),
      });
      expect(next).toMatchObject({
        state: "failed",
        error: "E_HUB_RESTARTING",
        retryable: true,
        effect: "none",
        message: "draining",
      });
    });
  });

  describe('event "retry" (§7.3: failed ⇒ sending, same id)', () => {
    it("failed ⇒ sending with the error fields cleared", () => {
      const failed = pendingTransition(item(), { type: "result", outcome: err("E_RATE", { retryable: true }) });
      const next = pendingTransition(failed, { type: "retry" });
      expect(next).toMatchObject({ id: "cmd-1", state: "sending" });
      expect(next.error).toBeUndefined();
      expect(next.retryable).toBeUndefined();
    });

    it.each(["sending", "unknown", "querying", "notExecuted", "observed"])("%s ⇒ no-op", (state) => {
      const it0 = item({ state });
      expect(pendingTransition(it0, { type: "retry" })).toBe(it0);
    });
  });

  describe('events "query_start" / "query_result" (unknown → querying → done|failed|notExecuted)', () => {
    it("query_start: unknown ⇒ querying (offline flag cleared); terminal states unaffected", () => {
      const next = pendingTransition(item({ state: "unknown", offline: true }), { type: "query_start" });
      expect(next).toMatchObject({ state: "querying" });
      expect(next.offline).toBeUndefined();
      const failed = item({ state: "failed" });
      expect(pendingTransition(failed, { type: "query_start" })).toBe(failed);
    });

    it("query_result ok+ok ⇒ removed (dup semantics: exactly one execution)", () => {
      expect(
        pendingTransition(item({ state: "querying" }), {
          type: "query_result",
          outcome: ok({ op: "query", state: "ok", result: { ok: true, data: {} } }),
        }),
      ).toBeNull();
    });

    it("query_result ok+running ⇒ back to unknown (still in flight agent-side)", () => {
      expect(
        pendingTransition(item({ state: "querying" }), {
          type: "query_result",
          outcome: ok({ op: "query", state: "running" }),
        }),
      ).toMatchObject({ state: "unknown" });
    });

    it("query_result ok+failed ⇒ failed with the ledger's code", () => {
      expect(
        pendingTransition(item({ state: "querying" }), {
          type: "query_result",
          outcome: ok({ op: "query", state: "failed", result: { ok: false, code: "E_SUBAGENT_REJECTED" } }),
        }),
      ).toMatchObject({ state: "failed", error: "E_SUBAGENT_REJECTED", retryable: false });
    });

    it("query_result E_UNKNOWN_ID ⇒ notExecuted (§3.4 assertion: agent never received it)", () => {
      expect(
        pendingTransition(item({ state: "querying" }), {
          type: "query_result",
          outcome: err("E_UNKNOWN_ID"),
        }),
      ).toMatchObject({ state: "notExecuted", error: "E_UNKNOWN_ID", retryable: false });
    });

    it("query_result retryable transport error ⇒ back to unknown; non-retryable ⇒ failed", () => {
      expect(
        pendingTransition(item({ state: "querying" }), {
          type: "query_result",
          outcome: err("E_DEADLINE", { retryable: true, effect: "unknown" }),
        }),
      ).toMatchObject({ state: "unknown" });
      expect(
        pendingTransition(item({ state: "querying" }), {
          type: "query_result",
          outcome: err("E_CSRF"),
        }),
      ).toMatchObject({ state: "failed", error: "E_CSRF" });
    });

    it("query_result outside unknown/querying is a no-op", () => {
      const sending = item();
      expect(pendingTransition(sending, { type: "query_result", outcome: ok({ state: "ok" }) })).toBe(sending);
    });
  });

  describe('events "dropped" / "offline" / "discard"', () => {
    it("dropped: queueDropped hit ⇒ dropped; closed states not resurrected", () => {
      expect(pendingTransition(item({ state: "queued" }), { type: "dropped" })).toMatchObject({ state: "dropped" });
      const failed = item({ state: "failed" });
      expect(pendingTransition(failed, { type: "dropped" })).toBe(failed);
    });

    it("offline (agent_down, §3.5): in-flight ⇒ unknown+offline; settled items untouched", () => {
      for (const state of ["sending", "unknown", "querying"]) {
        expect(pendingTransition(item({ state }), { type: "offline" })).toMatchObject({
          state: "unknown",
          offline: true,
        });
      }
      const observed = item({ state: "observed" });
      expect(pendingTransition(observed, { type: "offline" })).toBe(observed);
    });

    it("discard ⇒ removed", () => {
      expect(pendingTransition(item({ state: "failed" }), { type: "discard" })).toBeNull();
    });
  });

  describe('event "late" (cmd_late, D15)', () => {
    it("ok ⇒ removed for non-command kinds", () => {
      expect(
        pendingTransition(item({ kind: "steer_subagent", state: "unknown" }), { type: "late", ok: true }),
      ).toBeNull();
    });

    it("ok on a command item ⇒ querying + lateQuery (v2.1: fetch the output via queryOnly)", () => {
      const next = pendingTransition(item({ kind: "command", state: "running" }), { type: "late", ok: true });
      expect(next).toMatchObject({ state: "querying", lateQuery: true });
      // …and the query_start that follows disarms the one-shot flag
      const started = pendingTransition(next, { type: "query_start" });
      expect(started).toMatchObject({ state: "querying" });
      expect(started.lateQuery).toBeUndefined();
    });

    it("failure ⇒ failed with the late code; closed items not resurrected", () => {
      expect(
        pendingTransition(item({ state: "unknown" }), { type: "late", ok: false, code: "E_SUBAGENT_REJECTED" }),
      ).toMatchObject({ state: "failed", error: "E_SUBAGENT_REJECTED", retryable: false });
      const failed = item({ state: "failed" });
      expect(pendingTransition(failed, { type: "late", ok: true })).toBe(failed);
    });
  });

  describe('event "ctl" (ledger slot merge by cmdId, §4.3/§7.7)', () => {
    const ctl = (state, extra = {}) => ({ type: "ctl", entry: { cmdId: "cmd-1", state, ...extra } });

    it.each([
      ["observed", { state: "observed" }],
      ["started", { state: "started" }],
      ["queued", { state: "queued" }],
      ["running", { state: "running" }],
      ["dropped", { state: "dropped" }],
      ["unconfirmed", { state: "unconfirmed" }],
    ])("ctl %s ⇒ %j", (state, expected) => {
      expect(pendingTransition(item({ state: "observed" }), ctl(state))).toMatchObject(expected);
    });

    it.each(["consumed", "ok", "late_ok"])("ctl %s ⇒ removed", (state) => {
      expect(pendingTransition(item({ state: "queued" }), ctl(state))).toBeNull();
    });

    it("ctl failed/late_failed ⇒ failed with code; dispatched ⇒ no-op; closed items stay", () => {
      expect(pendingTransition(item({ state: "sending" }), ctl("failed", { code: "E_X" }))).toMatchObject({
        state: "failed",
        error: "E_X",
      });
      expect(pendingTransition(item({ state: "sending" }), ctl("late_failed"))).toMatchObject({ state: "failed" });
      const sending = item();
      expect(pendingTransition(sending, ctl("dispatched"))).toBe(sending);
      const failed = item({ state: "failed" });
      expect(pendingTransition(failed, ctl("started"))).toBe(failed);
    });

    it("ctl observed carries the behavior; unconfirmed carries the reason", () => {
      expect(pendingTransition(item(), ctl("observed", { behavior: "idle" }))).toMatchObject({ behavior: "idle" });
      expect(pendingTransition(item(), ctl("unconfirmed", { reason: "not-started" }))).toMatchObject({
        reason: "not-started",
      });
    });
  });

  describe('event "dialog_closed" (§3.5: closed[].cmdId decides the race)', () => {
    const dlg = (state = "sending") => item({ kind: "dialog_answer", dialogId: "ask:t1", state });

    it("by web with this cmdId ⇒ this tab won ⇒ removed", () => {
      expect(pendingTransition(dlg(), { type: "dialog_closed", by: "web", cmdId: "cmd-1" })).toBeNull();
    });

    it.each([
      [{ by: "tui" }, "answered in the terminal"],
      [{ by: "web", cmdId: "other-tab" }, "another browser won"],
      [{ by: "abort" }, "agent aborted"],
    ])("%j ⇒ failed E_DIALOG_CLOSED (%s)", (event) => {
      expect(pendingTransition(dlg(), { type: "dialog_closed", ...event })).toMatchObject({
        state: "failed",
        error: "E_DIALOG_CLOSED",
        retryable: false,
      });
    });

    it("non-dialog kinds are untouched", () => {
      const it0 = item();
      expect(pendingTransition(it0, { type: "dialog_closed", by: "tui" })).toBe(it0);
    });
  });

  it("ignores malformed events", () => {
    const it0 = item();
    expect(pendingTransition(it0, null)).toBe(it0);
    expect(pendingTransition(it0, { type: "mystery" })).toBe(it0);
  });
});

// ---------------------------------------------------------------------------
// steer-recall hold rows (web-hub-steer-recall plan §7 / v4.3 Y2 — P-ui)
// ---------------------------------------------------------------------------

import {
  acceptHeld,
  holdAvailable,
  heldRowMode,
  mergeRecalledDraft,
  validRecallText,
} from "../../../src/web-hub/ui/src/logic/control.js";

describe("holdAvailable / heldRowMode (§7 truth tables)", () => {
  const card = { agentKey: "A", hold: true };
  const caps = ["cmd.v1", "hold.v1"];

  it("holdAvailable: card.hold AND hub cap; strict false on unknown/missing caps", () => {
    expect(holdAvailable(card, caps)).toBe(true);
    expect(holdAvailable({ ...card, hold: undefined }, caps)).toBe(false);
    expect(holdAvailable(card, ["cmd.v1"])).toBe(false); // old hub — recall would 409
    expect(holdAvailable(card, undefined)).toBe(false); // hub frame not seen yet
    expect(holdAvailable(card, "not-an-array")).toBe(false);
    expect(holdAvailable(null, caps)).toBe(false);
  });

  it("heldRowMode: 4-cell (hubLive × cardLive) with the rest true; every input alone forces unavailable", () => {
    const base = { holdAvailable: true, scopeOk: true };
    expect(heldRowMode({ ...base, hubLive: true, cardLive: true })).toBe("recallable");
    expect(heldRowMode({ ...base, hubLive: false, cardLive: true })).toBe("unavailable");
    expect(heldRowMode({ ...base, hubLive: true, cardLive: false })).toBe("unavailable");
    expect(heldRowMode({ ...base, hubLive: false, cardLive: false })).toBe("unavailable");
    expect(heldRowMode({ hubLive: true, cardLive: true, holdAvailable: false, scopeOk: true })).toBe("unavailable");
    // Y2: a scope-stale snapshot (card epoch flipped) is copy-only even while fully live.
    expect(heldRowMode({ hubLive: true, cardLive: true, holdAvailable: true, scopeOk: false })).toBe("unavailable");
    expect(heldRowMode(undefined)).toBe("unavailable");
  });
});

describe("mergeQueue — held block (§7)", () => {
  const heldRow = (over = {}) => ({
    cmdId: "cmd-h1",
    text: "clip",
    deliver: "steer",
    state: "held",
    sessionId: "s1",
    at: 1,
    ...over,
  });

  it("legacy 3-arg signature is unchanged (no hold opts ⇒ no held block)", () => {
    const server = [{ id: "q1", text: "t", deliver: "steer", source: "tui", at: 1 }];
    expect(mergeQueue(server, [], [])).toEqual(server);
    // explicit opts with holdEnabled:false drops held rows even when passed
    expect(mergeQueue(server, [], [], [heldRow()], { holdEnabled: false })).toEqual(server);
  });

  it("hold rows render after the server queue carrying their mode; `gone` rows are forced unavailable (Y2)", () => {
    const out = mergeQueue([], [], [], [heldRow(), heldRow({ cmdId: "cmd-h2", gone: true })], {
      holdEnabled: true,
      rowMode: "recallable",
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      held: true,
      id: "cmd-h1",
      cmdId: "cmd-h1",
      state: "held",
      mode: "recallable",
      holdBase: "held",
    });
    expect(out[1]).toMatchObject({ cmdId: "cmd-h2", mode: "unavailable", gone: true });
  });

  it("dedupes by held cmdId against the optimistic item (this tab's row keeps the full text)", () => {
    const optimistic = [{ id: "cmd-h1", kind: "prompt", text: "the full typed body", state: "held", at: 2 }];
    const out = mergeQueue([], optimistic, [], [heldRow()], { holdEnabled: true, rowMode: "recallable" });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("the full typed body");
    expect(out[0].state).toBe("held");
  });

  it("a recall request never renders as its own row — it joins its target (recalling / tooLate)", () => {
    const optimistic = [{ id: "cmd-r1", kind: "recall", target: "cmd-h1", state: "sending", at: 3 }];
    let out = mergeQueue([], optimistic, [], [heldRow()], { holdEnabled: true, rowMode: "recallable" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cmdId: "cmd-h1", state: "recalling", holdBase: "held" });

    const too = [{ id: "cmd-r1", kind: "recall", target: "cmd-h1", state: "tooLate", at: 3 }];
    out = mergeQueue([], too, [], [heldRow()], { holdEnabled: true, rowMode: "recallable" });
    expect(out[0].state).toBe("tooLate");

    // a FAILED recall leaves the row exactly as it was (buttons re-enable)
    const failed = [{ id: "cmd-r1", kind: "recall", target: "cmd-h1", state: "failed", at: 3 }];
    out = mergeQueue([], failed, [], [heldRow()], { holdEnabled: true, rowMode: "recallable" });
    expect(out[0].state).toBe("held");
  });

  it("dismissed (U-MERGE tombstones + local hides) suppress held rows; returned rows keep reason + prevSession", () => {
    const out = mergeQueue(
      [],
      [],
      [],
      [
        heldRow(),
        heldRow({ cmdId: "cmd-gone" }),
        heldRow({ cmdId: "cmd-ret", state: "returned", reason: "reload", sessionId: "s0" }),
      ],
      { holdEnabled: true, rowMode: "recallable", dismissed: new Set(["cmd-gone"]), sessionId: "s1" },
    );
    expect(out.map((r) => r.cmdId)).toEqual(["cmd-h1", "cmd-ret"]);
    expect(out[1]).toMatchObject({ state: "returned", reason: "reload", holdBase: "returned", prevSession: true });
  });
});

describe("pendingTransition — hold-family states (§7)", () => {
  it("prompt ok delivery:held ⇒ state held (+behavior); never regresses afterwards", () => {
    const held = pendingTransition(item(), { type: "result", outcome: ok({ delivery: "held", behavior: "steer" }) });
    expect(held).toMatchObject({ state: "held", behavior: "steer" });
    // Y8.1: a degraded NATIVE delivery answers observed — never a held row.
    expect(pendingTransition(item(), { type: "result", outcome: ok({ delivery: "observed" }) })).toMatchObject({
      state: "observed",
    });
    // 不倒退: a stale ok result must not move held/handed/tooLate back to observed/unobserved.
    for (const state of ["held", "handed", "tooLate"]) {
      expect(
        pendingTransition(item({ state }), { type: "result", outcome: ok({ delivery: "observed" }) }),
      ).toMatchObject({
        state,
      });
    }
  });

  it("recall item: ok recalled ⇒ removed; too_late ⇒ sticky tooLate; errors fall to the shared failed path", () => {
    const r = item({ kind: "recall", target: "cmd-h1" });
    expect(
      pendingTransition(r, {
        type: "result",
        outcome: ok({ op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: "hi" }),
      }),
    ).toBeNull();
    expect(pendingTransition(r, { type: "result", outcome: ok({ op: "recall", outcome: "too_late" }) })).toMatchObject({
      state: "tooLate",
    });
    expect(pendingTransition(r, { type: "result", outcome: err("E_NOT_FOUND") })).toMatchObject({
      state: "failed",
      error: "E_NOT_FOUND",
    });
  });

  it("ctl dispatched/observed/started/queued on a held item ⇒ handed; recalled ⇒ removed; returned ⇒ returned{reason}", () => {
    const held = item({ state: "held" });
    for (const state of ["dispatched", "observed", "started", "queued"]) {
      expect(pendingTransition(held, { type: "ctl", entry: { cmdId: "cmd-1", state, updatedAt: 5 } })).toMatchObject({
        state: "handed",
        ctlAt: 5,
      });
    }
    expect(
      pendingTransition(held, { type: "ctl", entry: { cmdId: "cmd-1", state: "recalled", updatedAt: 6 } }),
    ).toBeNull();
    expect(
      pendingTransition(held, {
        type: "ctl",
        entry: { cmdId: "cmd-1", state: "returned", reason: "session", updatedAt: 7 },
      }),
    ).toMatchObject({ state: "returned", reason: "session" });
    // non-held items keep the legacy behavior: dispatched stays a no-op.
    const sending = item();
    expect(
      pendingTransition(sending, { type: "ctl", entry: { cmdId: "cmd-1", state: "dispatched", updatedAt: 5 } }),
    ).toBe(sending);
  });

  it("ctl entries older than the last applied updatedAt are dropped (乱序丢弃)", () => {
    const handed = pendingTransition(item({ state: "held" }), {
      type: "ctl",
      entry: { cmdId: "cmd-1", state: "dispatched", updatedAt: 9 },
    });
    expect(handed).toMatchObject({ state: "handed" });
    expect(
      pendingTransition(handed, {
        type: "ctl",
        entry: { cmdId: "cmd-1", state: "returned", reason: "stale", updatedAt: 4 },
      }),
    ).toBe(handed);
  });
});

describe("acceptHeld (U-MERGE / Y2)", () => {
  const snap = (rows, rev, epoch = "e1") => ({ held: rows, heldRev: rev, heldEpoch: epoch });
  const row = (cmdId, over = {}) => ({
    cmdId,
    text: "t",
    deliver: "steer",
    state: "held",
    sessionId: "s1",
    at: 1,
    ...over,
  });

  it("writes rows/rev/epoch; malformed or empty frames keep the previous state", () => {
    const acc = acceptHeld(undefined, snap([row("c1")], 3), { epoch: "e1", sessionId: "s1" }, undefined);
    expect(acc).toEqual({ rows: [row("c1")], rev: 3, epoch: "e1" });
    expect(acceptHeld(undefined, { held: [row("c1")] }, undefined, undefined)).toBeUndefined(); // no rev/epoch
    expect(acceptHeld(undefined, { queue: [] }, undefined, undefined)).toBeUndefined(); // no held at all
  });

  it("same scope: an older rev is dropped (旧 rev 丢弃); an equal/newer rev accepts", () => {
    const prev = { rows: [row("c1")], rev: 5, epoch: "e1" };
    expect(
      acceptHeld(prev, snap([row("c1"), row("c2")], 4), { epoch: "e1", sessionId: "s1" }, undefined),
    ).toBeUndefined();
    expect(
      acceptHeld(prev, snap([row("c1"), row("c2")], 5), { epoch: "e1", sessionId: "s1" }, undefined),
    ).toMatchObject({
      rev: 5,
    });
  });

  it("Y2 scope gate: a snapshot from another epoch is dropped WITHOUT comparing revs; a new-epoch snapshot replaces wholesale", () => {
    const prev = { rows: [row("c1")], rev: 1, epoch: "e1" };
    // an OLD-epoch frame arriving after the card flipped to e2 — even with a higher rev:
    expect(acceptHeld(prev, snap([row("c1")], 99, "e1"), { epoch: "e2", sessionId: "s1" }, undefined)).toBeUndefined();
    // the card flips and the FIRST e2 frame lands — replace, no union with e1 rows:
    expect(acceptHeld(prev, snap([row("c9")], 1, "e2"), { epoch: "e2", sessionId: "s1" }, undefined)).toEqual({
      rows: [row("c9")],
      rev: 1,
      epoch: "e2",
    });
    // scope unknown (old peers/tests) ⇒ accepted as before
    expect(acceptHeld(prev, snap([row("c2")], 2), undefined, undefined)).toMatchObject({ rev: 2 });
  });

  it("held rows from a foreign session are dropped; returned rows pass (previous session is visible by design)", () => {
    const acc = acceptHeld(
      undefined,
      snap([row("c1", { sessionId: "s0" }), row("c2", { state: "returned", reason: "session", sessionId: "s0" })], 1),
      { epoch: "e1", sessionId: "s1" },
      undefined,
    );
    expect(acc.rows.map((r) => r.cmdId)).toEqual(["c2"]);
  });

  it("same-scope snapshots only ADD/UPDATE: an absent non-tombstoned row stays as gone (Y2 ctl-truncation), a tombstoned row never re-enters", () => {
    const prev = { rows: [row("c1"), row("c2", { state: "returned" })], rev: 5, epoch: "e1" };
    const tombs = new Set(["c2"]);
    const acc = acceptHeld(prev, snap([row("c1")], 6), { epoch: "e1", sessionId: "s1" }, tombs);
    // c2 tombstoned ⇒ gone entirely; c1 present ⇒ updated; nothing else
    expect(acc.rows).toHaveLength(1);
    expect(acc.rows[0]).toMatchObject({ cmdId: "c1" });
    // now drop c1 from the snapshot WITHOUT a tombstone — it stays, marked gone (copy-only):
    const acc2 = acceptHeld(acc, snap([], 7), { epoch: "e1", sessionId: "s1" }, tombs);
    expect(acc2.rows).toHaveLength(1);
    expect(acc2.rows[0]).toMatchObject({ cmdId: "c1", gone: true });
    // and a tombstone beats a later snapshot that tries to resurrect it:
    const tombs2 = new Set([...tombs, "c1"]);
    expect(acceptHeld(acc2, snap([row("c1"), row("c2")], 8), { epoch: "e1", sessionId: "s1" }, tombs2).rows).toEqual(
      [],
    );
  });

  it("absent held on a live frame clears the rows but KEEPS rev+epoch (缺省时清空，rev 单调)", () => {
    const prev = { rows: [row("c1")], rev: 5, epoch: "e1" };
    expect(acceptHeld(prev, { queue: [] }, undefined, undefined)).toEqual({ rows: [], rev: 5, epoch: "e1" });
    // …so a late in-flight frame with a SMALLER rev cannot resurrect the cleared rows:
    expect(
      acceptHeld({ rows: [], rev: 5, epoch: "e1" }, snap([row("c1")], 4), { epoch: "e1", sessionId: "s1" }, undefined),
    ).toBeUndefined();
  });
});

describe("mergeRecalledDraft / validRecallText (§7)", () => {
  it("joins recalled ahead of the draft, dropping blanks (空草稿无多余空行)", () => {
    expect(mergeRecalledDraft("recalled body", "current draft")).toBe("recalled body\n\ncurrent draft");
    expect(mergeRecalledDraft("recalled body", "")).toBe("recalled body");
    expect(mergeRecalledDraft("", "draft")).toBe("draft");
    expect(mergeRecalledDraft("  ", undefined)).toBe("");
    expect(mergeRecalledDraft(undefined, undefined)).toBe("");
  });

  it("validRecallText: non-empty string within the 48 KiB byte cap", () => {
    expect(validRecallText("hi")).toBe(true);
    expect(validRecallText("")).toBe(false);
    expect(validRecallText(null)).toBe(false);
    expect(validRecallText("x".repeat(48 * 1024))).toBe(true); // 1 byte per char
    expect(validRecallText("€".repeat(48 * 1024))).toBe(false); // 3 bytes per char > cap
  });
});

// ---------------------------------------------------------------------------
// HTTP/exception → CmdOutcome (§6.2 table)
// ---------------------------------------------------------------------------

describe("outcomeFromHttp / outcomeFromResponse / outcomeFromError (§6.2)", () => {
  it("200 {ok:true, data, dup} ⇒ ok with data and dup flag", () => {
    expect(outcomeFromHttp(200, { ok: true, id: "x", data: { delivery: "observed" }, dup: true })).toEqual({
      ok: true,
      data: { delivery: "observed" },
      dup: true,
    });
    expect(outcomeFromHttp(200, { ok: true, data: {} })).toEqual({ ok: true, data: {}, dup: false });
  });

  it("error body fields pass through: error/message/retryable/effect/retryAfterS", () => {
    expect(
      outcomeFromHttp(409, { error: "E_BUSY_STEER", message: "steer pending", retryable: true, effect: "none" }),
    ).toEqual({ ok: false, error: "E_BUSY_STEER", message: "steer pending", retryable: true, effect: "none" });
    expect(outcomeFromHttp(504, { error: "E_DEADLINE", retryable: true, effect: "unknown" })).toEqual({
      ok: false,
      error: "E_DEADLINE",
      retryable: true,
      effect: "unknown",
    });
  });

  it("status-derived fallbacks without a body: 401/403/404/429/504", () => {
    expect(outcomeFromHttp(401, undefined)).toMatchObject({ error: "E_AUTH", retryable: false, effect: "none" });
    expect(outcomeFromHttp(403, undefined)).toMatchObject({ error: "E_CSRF" });
    expect(outcomeFromHttp(404, undefined)).toMatchObject({ error: "E_NOT_FOUND" });
    expect(outcomeFromHttp(429, undefined, 3)).toMatchObject({ error: "E_RATE", retryable: true, retryAfterS: 3 });
    expect(outcomeFromHttp(504, undefined)).toMatchObject({ error: "E_DEADLINE", retryable: true });
    expect(outcomeFromHttp(418, undefined)).toMatchObject({ error: "HTTP 418", retryable: false });
  });

  it("a 2xx with an ok:false body is still a failure", () => {
    expect(outcomeFromHttp(200, { ok: false, code: "E_SESSION_CHANGED", retryable: false })).toMatchObject({
      ok: false,
      error: "E_SESSION_CHANGED",
      retryable: false,
    });
  });

  it("outcomeFromResponse parses the body and the Retry-After header", async () => {
    const r = {
      status: 429,
      headers: { get: (n) => (n === "Retry-After" ? "5" : null) },
      json: async () => ({ error: "E_RATE" }),
    };
    expect(await outcomeFromResponse(r)).toMatchObject({ error: "E_RATE", retryable: true, retryAfterS: 5 });
    const bad = { status: 500, json: async () => Promise.reject(new Error("not json")) };
    expect(await outcomeFromResponse(bad)).toMatchObject({ error: "HTTP 500", retryable: true });
  });

  it("outcomeFromError: timeout ⇒ E_DEADLINE effect unknown; network ⇒ E_NETWORK effect unknown (§3.3/§3.4)", () => {
    expect(outcomeFromError(new Error("E_DEADLINE"))).toEqual({
      ok: false,
      error: "E_DEADLINE",
      retryable: true,
      effect: "unknown",
    });
    expect(outcomeFromError(new TypeError("fetch failed"))).toMatchObject({
      error: "E_NETWORK",
      retryable: true,
      effect: "unknown",
    });
  });
});

// ---------------------------------------------------------------------------
// web-hub-rename plan: `renameEnabled` (the AgentCard pencil's visibility gate) and
// `sanitizeRenameInput` (trim/cap/no-op detection before a `command` op is ever sent).
// ---------------------------------------------------------------------------

import { renameEnabled, sanitizeRenameInput, RENAME_MAX_CHARS } from "../../../src/web-hub/ui/src/logic/control.js";

describe("renameEnabled (web-hub-rename plan)", () => {
  const allOn = {
    hubControl: true,
    controlPresent: true,
    cardControl: true,
    agentLive: true,
    restoring: false,
    hasCommandsSlot: true,
  };

  it("true only when every gate passes", () => {
    expect(renameEnabled(allOn)).toBe(true);
  });

  it.each([
    ["hubControl", { ...allOn, hubControl: false }],
    ["controlPresent", { ...allOn, controlPresent: false }],
    ["cardControl", { ...allOn, cardControl: false }],
    ["agentLive", { ...allOn, agentLive: false }],
    ["hasCommandsSlot (no command.v1)", { ...allOn, hasCommandsSlot: false }],
  ])("false when %s is unmet", (_label, input) => {
    expect(renameEnabled(input)).toBe(false);
  });

  it("false while mid-restore even if every other gate is true", () => {
    expect(renameEnabled({ ...allOn, restoring: true })).toBe(false);
  });
});

describe("sanitizeRenameInput (web-hub-rename plan)", () => {
  it("trims whitespace", () => {
    expect(sanitizeRenameInput("  hello world  ", "")).toBe("hello world");
  });

  it("empty or whitespace-only ⇒ null (no wire call — pi's own /name rejects empty args)", () => {
    expect(sanitizeRenameInput("", "old")).toBeNull();
    expect(sanitizeRenameInput("   ", "old")).toBeNull();
  });

  it("unchanged (after trim) ⇒ null (no pointless round trip)", () => {
    expect(sanitizeRenameInput("same name", "same name")).toBeNull();
    expect(sanitizeRenameInput("  same name  ", "same name")).toBeNull();
  });

  it(`caps at RENAME_MAX_CHARS (${RENAME_MAX_CHARS})`, () => {
    const long = "x".repeat(RENAME_MAX_CHARS + 50);
    const got = sanitizeRenameInput(long, "");
    expect(got).toHaveLength(RENAME_MAX_CHARS);
    expect(got).toBe("x".repeat(RENAME_MAX_CHARS));
  });

  it("non-string draft (defensive) ⇒ null", () => {
    expect(sanitizeRenameInput(undefined, "old")).toBeNull();
    expect(sanitizeRenameInput(null, "old")).toBeNull();
    expect(sanitizeRenameInput(42, "old")).toBeNull();
  });
});

import { isWebSentMessage } from "../../../src/web-hub/ui/src/logic/control.js";

describe("isWebSentMessage (§7.7 transcript web badge)", () => {
  const at = 1_000_000;
  it("started/consumed within [at, at+120s] ⇒ web", () => {
    expect(isWebSentMessage([{ state: "started", at }], at + 500)).toBe(true);
    expect(isWebSentMessage([{ state: "consumed", at, updatedAt: at + 10 }], at + 119_000)).toBe(true);
  });
  it("other states, before `at`, missing data ⇒ not web", () => {
    expect(isWebSentMessage([{ state: "queued", at }], at + 10)).toBe(false);
    expect(isWebSentMessage([{ state: "started", at }], at - 1)).toBe(false);
    expect(isWebSentMessage([{ state: "started" }], at)).toBe(false);
    expect(isWebSentMessage(undefined, at)).toBe(false);
    expect(isWebSentMessage([{ state: "started", at }], undefined)).toBe(false);
    expect(isWebSentMessage([null, 3], at)).toBe(false);
  });
  it("2026-10-09: a prompt queued while busy and dequeued minutes later matches via updatedAt", () => {
    const deq = at + 600_000; // consumed 10 min after dispatch
    const ctl = [{ state: "consumed", at, updatedAt: deq }];
    expect(isWebSentMessage(ctl, deq + 2_000)).toBe(true);
    expect(isWebSentMessage(ctl, deq - 2_000)).toBe(true);
    expect(isWebSentMessage(ctl, deq + 60_000)).toBe(false); // far from both windows
    // a still-`started` entry gets no updatedAt slack (only the dequeue stamps it)
    expect(isWebSentMessage([{ state: "started", at, updatedAt: deq }], deq)).toBe(false);
  });
});
