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
    [{ key: "Enter" }, { coarse: true }, "newline", "coarse pointer: Enter = newline, button sends"],
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
