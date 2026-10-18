import { afterEach, describe, expect, it } from "vitest";
import { cleanupF6, f6Rig, OWNER } from "../../../fixtures/feishu/f6.js";
import { createFeishuAdmission } from "../../../../src/web-hub/hub/feishu/admission.js";
import type { CmdArgs } from "../../../../src/web-hub/protocol/messages.js";

afterEach(cleanupF6);
const command = { op: "prompt", deliver: "followUp", text: "text", expect: { sessionId: "session-1" } } as const;
describe("F6 live admission", () => {
  it("builds attribution itself, shares the agent bucket and uses all fresh command buckets", async () => {
    const r = await f6Rig();
    const result = await r.admission.dispatch({
      ...r.identity,
      id: "request",
      sessionId: "session-1",
      cmd: command,
      callback: true,
    });
    expect(result.ok).toBe(true);
    expect(r.admit.mock.calls).toEqual([
      ["agent:agent-1", 30, 1000],
      [`feishu:${OWNER}:cmd`, 10, 300],
      ["feishu:global", 60, 1000],
      ["feishu:cb", 20, 3000],
    ]);
    expect(r.request.mock.calls[0]).toEqual([
      {
        t: "cmd",
        rid: "",
        id: "request",
        deadlineMs: 8000,
        origin: { listener: "lan", ip: "feishu", user: `feishu:${OWNER}`, reqId: "request" },
        cmd: command,
      },
      "agent-1",
    ]);
  });
  it.each(["reset", "stop", "gen", "app", "tenant", "deny", "offline", "ambiguous", "read-only"])(
    "refuses %s with no router effect",
    async (change) => {
      const r = await f6Rig();
      if (change === "reset") r.setInstall(undefined);
      if (change === "stop") r.setInstall({ ...r.install()!, active: false });
      if (change === "gen") r.setInstall({ ...r.install()!, gen: 2 });
      if (change === "app") r.setInstall({ ...r.install()!, appId: "another" });
      if (change === "tenant") r.identity.tenantKey = "other";
      if (change === "deny") r.state.allowList.remove(OWNER);
      if (change === "offline") r.live[0]!.live = false;
      if (change === "ambiguous") r.live.push({ ...r.live[0]!, agentKey: "second" });
      if (change === "read-only") r.live[0]!.state = "read-only";
      const result = await r.admission.dispatch({ ...r.identity, id: "request", sessionId: "session-1", cmd: command });
      expect(result.ok).toBe(false);
      expect(r.request).not.toHaveBeenCalled();
      expect(r.admit).not.toHaveBeenCalled();
    },
  );
  it.each<CmdArgs>([
    { op: "abort" },
    { op: "recall", target: "x" },
    { op: "command", name: "new", args: "" },
    { op: "abort_subagent", runId: "r" },
    { op: "steer_subagent", runId: "r", text: "x" },
    { op: "prompt", deliver: "steer", text: "x" },
  ])("refuses disallowed $op", async (cmd) => {
    const r = await f6Rig();
    expect(await r.admission.dispatch({ ...r.identity, id: "request", sessionId: "session-1", cmd })).toEqual({
      ok: false,
      code: "op-denied",
    });
    expect(r.request).not.toHaveBeenCalled();
  });
  it.each<CmdArgs>([
    { op: "dialog_answer", dialogId: "d", epoch: "e", answers: [] },
    { op: "dialog_cancel", dialogId: "d", epoch: "e" },
  ])("allows $op", async (cmd) => {
    const r = await f6Rig();
    expect((await r.admission.dispatch({ ...r.identity, id: "request", sessionId: "session-1", cmd })).ok).toBe(true);
  });
  it("does not charge an exact hub-ledger hit, but authorization still runs", async () => {
    const r = await f6Rig();
    r.commands.peekIdempotent.mockReturnValue("done");
    await r.admission.dispatch({ ...r.identity, id: "request", sessionId: "session-1", cmd: command });
    expect(r.admit).not.toHaveBeenCalled();
    r.state.allowList.remove(OWNER);
    expect(await r.admission.dispatch({ ...r.identity, id: "request", sessionId: "session-1", cmd: command })).toEqual({
      ok: false,
      code: "sender-denied",
    });
    expect(r.request).toHaveBeenCalledTimes(1);
  });
  it("fails on binding revision changes, process changes and hub saturation", async () => {
    const r = await f6Rig();
    const input = { ...r.identity, id: "req", sessionId: "session-1", cmd: command };
    expect(await r.admission.dispatch({ ...input, bindingKey: "p2p:chat", bindingRev: 0 })).toEqual({
      ok: false,
      code: "binding-changed",
    });
    expect(await r.admission.dispatch({ ...input, expectedAgentKey: "old-process", queryOnly: true })).toEqual({
      ok: false,
      code: "agent-changed",
    });
    r.commands.inflight.mockReturnValue(32);
    expect(await r.admission.dispatch(input)).toEqual({ ok: false, code: "E_RATE" });
    expect(r.request).not.toHaveBeenCalled();
  });
  it.each(["agent:agent-1", `feishu:${OWNER}:cmd`, "feishu:global", "feishu:cb"])(
    "honors %s refusal",
    async (bucket) => {
      const r = await f6Rig();
      const limit = {
        admit: (key: string) => (key === bucket ? { ok: false as const, retryAfterMs: 123 } : { ok: true as const }),
      };
      const admission = createFeishuAdmission({
        installation: r.install,
        state: r.state,
        sessions: r.sessions,
        commands: r.commands,
        limit,
      });
      expect(
        await admission.dispatch({ ...r.identity, id: "req", sessionId: "session-1", cmd: command, callback: true }),
      ).toEqual({ ok: false, code: "E_RATE", retryAfterMs: 123 });
      expect(r.request).not.toHaveBeenCalled();
    },
  );
  it("sees a revocation on the very next dispatch (not a receive-time allow snapshot)", async () => {
    const r = await f6Rig();
    expect(r.admission.authorize(r.identity).ok).toBe(true);
    r.state.allowList.remove(OWNER);
    expect((await r.admission.dispatch({ ...r.identity, id: "req", sessionId: "session-1", cmd: command })).ok).toBe(
      false,
    );
    expect(r.request).not.toHaveBeenCalled();
  });
});
