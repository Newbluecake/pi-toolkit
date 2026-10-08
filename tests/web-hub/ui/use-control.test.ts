// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createControl, CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { Attachment } from "../../../src/web-hub/ui/src/types.js";
import type {
  CmdOutcome,
  CmdRequest,
  DialogRequest,
  HubTransport,
  UploadBeginOk,
  UploadOutcome,
  UploadTransport,
} from "../../../src/web-hub/ui/src/transport/types.js";

/**
 * `createControl` (control-plan v2.1 §7.1/§7.3/§7.7, package C4): optimistic `ctl_send` before
 * the wire call, `ctl_result` with a pendingTransition event after; query/retry resend the
 * retained original payload; D21 `expect.sessionId` on prompt/abort/command.
 */

type Call = { method: string; req: CmdRequest | DialogRequest };
type Dispatched = { event: string; data: any };

function harness(
  opts: {
    commandResult?: CmdOutcome;
    dialogResult?: CmdOutcome;
    getSessionId?: (agentKey: string) => string | undefined;
    now?: () => number;
  } = {},
) {
  const calls: Call[] = [];
  const dispatched: Dispatched[] = [];
  const transport: HubTransport = {
    mode: "token",
    start: async () => {},
    close: () => {},
    subscribe: async () => ({ ok: true }),
    unsubscribe: async () => {},
    page: async () => ({ ok: true, data: {} }),
    command: async (req) => {
      calls.push({ method: "command", req });
      return opts.commandResult ?? { ok: true, data: {} };
    },
    dialog: async (req) => {
      calls.push({ method: "dialog", req });
      return opts.dialogResult ?? { ok: true, data: {} };
    },
  };
  const control = createControl(transport, (msg) => dispatched.push({ event: msg.event, data: msg.data }), {
    ...(opts.getSessionId ? { getSessionId: opts.getSessionId } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { calls, dispatched, control };
}

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("createControl (§7.3)", () => {
  it("sendPrompt: ctl_send (optimistic, sending) BEFORE the transport resolves; ctl_result after; D21 expect.sessionId", async () => {
    let resolveCmd: ((o: CmdOutcome) => void) | undefined;
    // a manually-gated transport so we can observe the dispatch order
    const calls: Call[] = [];
    const dispatched: Dispatched[] = [];
    const transport: HubTransport = {
      mode: "token",
      start: async () => {},
      close: () => {},
      subscribe: async () => ({ ok: true }),
      unsubscribe: async () => {},
      page: async () => ({ ok: true, data: {} }),
      command: (req) => {
        calls.push({ method: "command", req });
        return new Promise<CmdOutcome>((r) => (resolveCmd = r));
      },
      dialog: async () => ({ ok: true, data: {} }),
    };
    const control = createControl(transport, (m) => dispatched.push({ event: m.event, data: m.data }), {
      getSessionId: () => "sess-1",
      now: () => 42,
    });
    const p = control.sendPrompt("A", "hello", "steer");
    await flush();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ event: "ctl_send" });
    const item = dispatched[0]!.data.item;
    expect(item).toMatchObject({ kind: "prompt", text: "hello", deliver: "steer", state: "sending", at: 42 });
    expect(item.id).toMatch(ID_RE);
    expect(calls[0]!.req).toMatchObject({
      agentKey: "A",
      id: item.id,
      op: "prompt",
      text: "hello",
      deliver: "steer",
      expect: { sessionId: "sess-1" },
    });

    resolveCmd!({ ok: true, data: { delivery: "observed", behavior: "steer" } });
    const outcome = await p;
    expect(outcome).toEqual({ ok: true, data: { delivery: "observed", behavior: "steer" } });
    expect(dispatched[1]).toMatchObject({ event: "ctl_result", data: { agentKey: "A", id: item.id } });
    expect(dispatched[1]!.data.transition).toEqual({ type: "result", outcome });
  });

  it("abort / steerSub / stopSub / runCommand / answerDialog / cancelDialog build the right wire shapes", async () => {
    const h = harness({ getSessionId: () => "sess-9" });
    await h.control.abort("A");
    expect(h.calls[0]!.req).toMatchObject({ op: "abort", expect: { sessionId: "sess-9" } });

    await h.control.steerSub("A", "r_1", "focus");
    expect(h.calls[1]!.req).toMatchObject({ op: "steer_subagent", runId: "r_1", text: "focus" });
    expect((h.calls[1]!.req as CmdRequest).expect).toBeUndefined(); // sub ops never carry expect (§3.2)

    await h.control.stopSub("A", "r_1");
    expect(h.calls[2]!.req).toMatchObject({ op: "abort_subagent", runId: "r_1" });

    await h.control.runCommand("A", "compact", "keep it short", { confirm: true });
    expect(h.calls[3]!.req).toMatchObject({
      op: "command",
      name: "compact",
      args: "keep it short",
      confirm: true,
      expect: { sessionId: "sess-9" },
    });
    expect(h.dispatched.at(-2)).toMatchObject({
      event: "ctl_send",
      data: { item: { kind: "command", name: "compact" } },
    });

    const answers = [{ selected: ["A"], other: null }];
    await h.control.answerDialog("A", "ask:t1", "epoch-1", answers);
    expect(h.calls[4]!.req).toMatchObject({
      dialogId: "ask:t1",
      epoch: "epoch-1",
      action: "answer",
      answers,
    });
    expect(h.calls[4]!.method).toBe("dialog");

    await h.control.cancelDialog("A", "ask:t1", "epoch-1");
    expect(h.calls[5]!.req).toMatchObject({ dialogId: "ask:t1", action: "cancel" });
  });

  it("runCommand: E_CONFIRM_REQUIRED discards the queue item (DetailDock's CommandConfirm re-issues with a NEW id + confirm:true; a zombie failed card's retry could never pass)", async () => {
    const h = harness({
      commandResult: {
        ok: false,
        error: "E_CONFIRM_REQUIRED",
        retryable: false,
        effect: "none",
        message: "/new requires confirmation — this changes the session. Resend with confirm:true to proceed.",
      },
    });
    const outcome = await h.control.runCommand("A", "new", "");
    expect(outcome.ok).toBe(false);
    const id = (h.calls[0]!.req as CmdRequest).id;
    const events = h.dispatched.map((d) => d.event);
    expect(events).toEqual(["ctl_send", "ctl_result", "ctl_discard"]);
    expect(h.dispatched[2]).toMatchObject({ event: "ctl_discard", data: { agentKey: "A", id } });
    // a subsequent query for the discarded id is a local miss (retention entry also dropped)
    const q = await h.control.query("A", id);
    expect(q.ok).toBe(false);
    expect(q.error).toBe("E_UNKNOWN_ID");
  });

  it("every user action mints a fresh id (§3.4: 修改后再提交是新动作)", async () => {
    const h = harness();
    await h.control.sendPrompt("A", "same text", "steer");
    await h.control.sendPrompt("A", "same text", "steer");
    const [a, b] = h.calls.map((c) => (c.req as CmdRequest).id);
    expect(a).not.toBe(b);
  });

  it("query(): dispatches query_start then query_result, and resends the SAME frame with queryOnly:true", async () => {
    const h = harness();
    await h.control.steerSub("A", "r_1", "focus");
    const id = (h.calls[0]!.req as CmdRequest).id;
    h.calls.length = 0;
    h.dispatched.length = 0;

    const outcome = await h.control.query("A", id);
    expect(outcome).toEqual({ ok: true, data: {} });
    expect(h.calls[0]!.req).toMatchObject({ id, op: "steer_subagent", runId: "r_1", text: "focus", queryOnly: true });
    expect(h.dispatched.map((d) => d.event)).toEqual(["ctl_result", "ctl_result"]);
    expect(h.dispatched[0]!.data.transition).toEqual({ type: "query_start" });
    expect(h.dispatched[1]!.data.transition).toEqual({ type: "query_result", outcome });
  });

  it("query() on a dialog request goes back out through /api/dialog with queryOnly:true", async () => {
    const h = harness();
    await h.control.answerDialog("A", "ask:t1", "e1", [{ selected: ["A"], other: null }]);
    const id = (h.calls[0]!.req as DialogRequest).id;
    h.calls.length = 0;
    await h.control.query("A", id);
    expect(h.calls[0]!.method).toBe("dialog");
    expect(h.calls[0]!.req).toMatchObject({ id, action: "answer", queryOnly: true });
  });

  it("query()/retry() of an unknown id fail locally without touching the wire", async () => {
    const h = harness();
    const q = await h.control.query("A", "never-seen");
    expect(q).toMatchObject({ ok: false, error: "E_UNKNOWN_ID", retryable: false });
    const r = await h.control.retry("A", "never-seen");
    expect(r).toMatchObject({ ok: false, error: "E_UNKNOWN_ID" });
    expect(h.calls).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  });

  it("retry(): ctl_retry then re-executes the SAME id through the same channel", async () => {
    const h = harness({ commandResult: { ok: false, error: "E_BUSY_COMPACTING", retryable: true, effect: "none" } });
    await h.control.sendPrompt("A", "hi", "steer");
    const id = (h.calls[0]!.req as CmdRequest).id;
    h.calls.length = 0;
    h.dispatched.length = 0;

    await h.control.retry("A", id);
    expect(h.dispatched[0]).toMatchObject({ event: "ctl_retry", data: { agentKey: "A", id } });
    expect(h.calls[0]!.req).toMatchObject({ id, op: "prompt", text: "hi" });
    expect((h.calls[0]!.req as CmdRequest).queryOnly).toBeUndefined(); // a retry re-executes (deduped server-side)
    expect(h.dispatched[1]!.data.transition.type).toBe("result");
  });

  it("discard(): ctl_discard and forgets the payload (later query misses locally)", async () => {
    const h = harness();
    await h.control.abort("A");
    const id = (h.calls[0]!.req as CmdRequest).id;
    h.control.discard("A", id);
    expect(h.dispatched.at(-1)).toMatchObject({ event: "ctl_discard", data: { agentKey: "A", id } });
    const q = await h.control.query("A", id);
    expect(q).toMatchObject({ ok: false, error: "E_UNKNOWN_ID" });
  });

  it("drafts are per-agentKey and survive across agents (§7.1: memory only, no localStorage)", () => {
    const h = harness();
    h.control.setDraft("A", "draft for A");
    h.control.setDraft("B", "draft for B");
    expect(h.control.draft("A")).toBe("draft for A");
    expect(h.control.draft("B")).toBe("draft for B");
    expect(h.control.draft("C")).toBe("");
  });

  it("CONTROL_CTX is the provide/inject key for sub-agent actions (§7.4)", () => {
    expect(typeof CONTROL_CTX).toBe("symbol");
  });
});

describe("createControl: steer recall (web-hub-steer-recall plan §7, P-ui)", () => {
  it("recall(): optimistic kind:recall item + wire {op:recall, target} WITHOUT expect; the full body is cached under the TARGET on success", async () => {
    const h = harness({ getSessionId: () => "sess-1" });
    const p = h.control.recall?.("A", "cmd-target-1");
    await p;
    expect(h.calls[0]!.req).toEqual({
      agentKey: "A",
      id: (h.calls[0]!.req as CmdRequest).id,
      op: "recall",
      target: "cmd-target-1",
    });
    expect((h.calls[0]!.req as CmdRequest).expect).toBeUndefined(); // identify-only (S5)
    expect(h.dispatched[0]).toMatchObject({
      event: "ctl_send",
      data: { agentKey: "A", item: { kind: "recall", target: "cmd-target-1", state: "sending" } },
    });
    // the recall result text becomes the target's cached original:
    expect(h.control.originalText?.("A", "sess-1", "cmd-target-1")).toBeUndefined(); // not yet — harness returns {ok:true,data:{}}
  });

  it("recall(): a recalled outcome's FULL text is cached under the target (copy never degrades to the 200-char clip)", async () => {
    const calls: Call[] = [];
    const transport: HubTransport = {
      mode: "token",
      start: async () => {},
      close: () => {},
      subscribe: async () => ({ ok: true }),
      unsubscribe: async () => {},
      page: async () => ({ ok: true, data: {} }),
      command: async (req) => {
        calls.push({ method: "command", req });
        return {
          ok: true,
          data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: "the FULL typed body" },
        };
      },
      dialog: async () => ({ ok: true }),
    };
    const control = createControl(transport, () => {}, { getSessionId: () => "sess-1" });
    await control.recall?.("A", "cmd-target-2");
    expect(control.originalText?.("A", "sess-1", "cmd-target-2")).toBe("the FULL typed body");
  });

  it("sendPrompt caches the full text under the minted cmdId; the 4th arg overrides it (onSend 传原文)", async () => {
    const h = harness({ getSessionId: () => "sess-1" });
    await h.control.sendPrompt("A", "expanded body", "steer");
    const id1 = (h.calls[0]!.req as CmdRequest).id;
    expect(h.control.originalText?.("A", "sess-1", id1)).toBe("expanded body");
    // omitted 4th param is fine; an explicit original (raw pre-expansion text) wins:
    await h.control.sendPrompt("A", "expanded body 2", "followUp", "@raw typed text");
    const id2 = (h.calls[1]!.req as CmdRequest).id;
    expect(h.control.originalText?.("A", "sess-1", id2)).toBe("@raw typed text");
  });

  it("originals are session-partitioned: a /new switch never leaks the previous session's texts", async () => {
    let sid = "sess-1";
    const h = harness({ getSessionId: () => sid });
    await h.control.sendPrompt("A", "for session one", "steer");
    const id = (h.calls[0]!.req as CmdRequest).id;
    expect(h.control.originalText?.("A", "sess-1", id)).toBe("for session one");
    sid = "sess-2";
    expect(h.control.originalText?.("A", "sess-2", id)).toBeUndefined();
    expect(h.control.originalText?.("A", "sess-1", id)).toBe("for session one");
  });

  it("the per-agent originals cache is FIFO-capped at 128 across sessions", async () => {
    const h = harness({ getSessionId: () => "sess-1" });
    for (let i = 0; i < 130; i++) await h.control.sendPrompt("A", `body ${i}`, "steer");
    const ids = h.calls.map((c) => (c.req as CmdRequest).id);
    expect(h.control.originalText?.("A", "sess-1", ids[0]!)).toBeUndefined(); // evicted
    expect(h.control.originalText?.("A", "sess-1", ids[2]!)).toBe("body 2"); // the oldest survivor
    expect(h.control.originalText?.("A", "sess-1", ids[129]!)).toBe("body 129");
  });

  it("forgetAgent drops the agent's whole originals partition", async () => {
    const h = harness({ getSessionId: () => "sess-1" });
    await h.control.sendPrompt("A", "keep me", "steer");
    const id = (h.calls[0]!.req as CmdRequest).id;
    h.control.forgetAgent?.("A");
    expect(h.control.originalText?.("A", "sess-1", id)).toBeUndefined();
  });
});

describe("createControl: uploads mount (web-hub-upload plan §6 U4b)", () => {
  const fakeUpload: UploadTransport = {
    begin: async (p) =>
      ({
        ok: true,
        data: { id: p.id, chunkBytes: 4, maxBytes: 104857600, received: 0 },
      }) as UploadOutcome<UploadBeginOk>,
    chunk: async (p) => ({ ok: true, data: { received: p.offset + p.bytes.length } }),
    commit: async (p) => ({ ok: true, data: { id: p.id, path: "/uploads/x/f.png", size: 1, mime: null } }),
    abort: async () => ({ ok: true, data: { ok: true } }),
  };

  function transportWithUpload(withUpload: boolean): HubTransport {
    const base: HubTransport = {
      mode: "token",
      start: async () => {},
      close: () => {},
      subscribe: async () => ({ ok: true }),
      unsubscribe: async () => {},
      page: async () => ({ ok: true, data: {} }),
      command: async () => ({ ok: true, data: {} }) as CmdOutcome,
      dialog: async () => ({ ok: true }) as unknown as CmdOutcome,
    };
    return withUpload ? { ...base, upload: fakeUpload } : base;
  }

  it("transport.upload present ⇒ ControlHandle.uploads is mounted and drives the tray end-to-end", async () => {
    const dispatched: Array<{ event: string; data: any }> = [];
    const control = createControl(transportWithUpload(true), (m) => dispatched.push({ event: m.event, data: m.data }));
    expect(control.uploads).toBeDefined();
    const file = {
      name: "a.png",
      size: 4,
      type: "image/png",
      lastModified: 1,
      slice: () => ({ arrayBuffer: async () => new Uint8Array(4).buffer }),
    };
    const r = control.uploads!.add("A", [file]);
    expect(r.added).toHaveLength(1);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    const tray: readonly Attachment[] = control.uploads!.tray("A").value;
    expect(tray).toHaveLength(1);
    expect(tray[0]!.state).toBe("ready");
    expect(tray[0]!.path).toBe("/uploads/x/f.png");
  });

  it("transport without upload ⇒ ControlHandle.uploads stays undefined (optional mount)", () => {
    const control = createControl(transportWithUpload(false), () => {});
    expect(control.uploads).toBeUndefined();
  });
});

describe("createControl: caller-generated cmdId + command args (web-model-switch §5.2 #6, M3a)", () => {
  it("runCommand: a caller-passed id is used verbatim on the wire AND the optimistic item; the item carries args", async () => {
    const h = harness({ getSessionId: () => "sess-1", now: () => 7 });
    await h.control.runCommand("A", "model", "zai/glm-5", { id: "caller-id-1" });
    expect((h.calls[0]!.req as CmdRequest).id).toBe("caller-id-1");
    expect(h.calls[0]!.req).toMatchObject({ op: "command", name: "model", args: "zai/glm-5" });
    const item = h.dispatched[0]!.data.item;
    expect(item).toMatchObject({
      id: "caller-id-1",
      kind: "command",
      name: "model",
      args: "zai/glm-5",
      state: "sending",
      at: 7,
    });
    // the retained payload is queryable under the caller id (exact tracking, §5.2)
    const q = await h.control.query("A", "caller-id-1");
    expect(q.ok).toBe(true);
    expect((h.calls[1]!.req as CmdRequest).queryOnly).toBe(true);
  });

  it("runCommand: caller id + confirm:true compose; no id ⇒ fresh id (behavior unchanged)", async () => {
    const h = harness();
    await h.control.runCommand("A", "model", "zai/glm-5", { id: "caller-id-2", confirm: true });
    expect(h.calls[0]!.req).toMatchObject({ id: "caller-id-2", confirm: true });

    await h.control.runCommand("A", "compact", "keep it short");
    const req = h.calls[1]!.req as CmdRequest;
    expect(req.id).toMatch(ID_RE);
    expect(req.id).not.toBe("caller-id-2");
    // the optimistic item now always carries args (QueueList's notExecuted retry re-sends them)
    const item = h.dispatched.find((d) => d.event === "ctl_send" && d.data.item.name === "compact")!.data.item;
    expect(item.args).toBe("keep it short");
  });
});
