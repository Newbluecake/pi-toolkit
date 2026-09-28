// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createControl, CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type {
  CmdOutcome,
  CmdRequest,
  DialogRequest,
  HubTransport,
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
