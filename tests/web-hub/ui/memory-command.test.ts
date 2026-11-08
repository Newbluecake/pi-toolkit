// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import MemoryCommandFixture from "./fixtures/MemoryCommandFixture.vue";
import { createMemoryCommandFixture } from "./fixtures/memory-command.js";
import { setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import { __resetCmdHistoryStores, useCmdHistory } from "../../../src/web-hub/ui/src/composables/useCmdHistory.js";
import type { CmdOutcome, CmdRequest } from "../../../src/web-hub/ui/src/transport/types.js";

vi.stubGlobal("matchMedia", (media: string) => ({
  matches: false,
  media,
  addEventListener() {},
  removeEventListener() {},
}));
const disposers: Array<() => void> = [];
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
  await nextTick();
};
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const accepted: CmdOutcome = { ok: true, data: { op: "command", completion: "async", captured: true } };
const completed = (text = "completed id=n5; appended; 首次 conversation flush 前可能尚未落盘"): CmdOutcome => ({
  ok: true,
  data: {
    op: "query",
    state: "ok",
    result: {
      ok: true,
      data: { op: "command", completion: "sync", captured: true, output: { entries: [{ kind: "text", text }] } },
    },
  },
});
const refused = (effect = "none", message = "E_MEM_CONFIRM_STALE effect=none 本步未执行"): CmdOutcome => ({
  ok: true,
  data: { op: "query", state: "failed", result: { ok: false, code: "E_STALE_CTX", effect, retryable: false, message } },
});
async function setup(command: (req: CmdRequest) => Promise<CmdOutcome>, history = false) {
  const fixture = createMemoryCommandFixture({ command, history });
  await flush();
  const wrapper = mount(MemoryCommandFixture, { props: { fixture } });
  disposers.push(() => {
    wrapper.unmount();
    fixture.dispose();
  });
  const send = async (text = "/mem session add exact body") => {
    await wrapper.find("textarea").setValue(text);
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    await flush();
    return fixture.calls.filter((req) => req.op === "command" && !req.queryOnly).at(-1)!.id;
  };
  const signal = (id: string, type: "ctl" | "late", ok = true) => {
    fixture.emit(
      type === "ctl" ? "ctl" : "cmd_late",
      type === "ctl"
        ? {
            agentKey: fixture.card.agentKey,
            items: [{ cmdId: id, op: "command", state: ok ? "ok" : "failed", updatedAt: 42 }],
          }
        : { agentKey: fixture.card.agentKey, id, ok },
    );
  };
  return { ...fixture, wrapper, send, signal };
}
beforeEach(() => {
  setLangOverride("zh", null);
  __resetCmdHistoryStores();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  __resetCmdHistoryStores();
  setLangOverride(null, null);
});

describe("#65 mem: production useHub/useControl/reducers + visible DetailDock (NOT the S1 host proof)", () => {
  it.each(
    [false, true].flatMap((history) =>
      ["ctl", "late"].flatMap((first) =>
        [false, true].map((replace) => ({ history, first: first as "ctl" | "late", replace })),
      ),
    ),
  )("history=$history, first=$first, same-name replacement=$replace", async ({ history, first, replace }) => {
    const queryA = barrier<CmdOutcome>();
    let idA = "";
    const h = await setup(
      async (req) =>
        req.queryOnly
          ? req.id === idA
            ? queryA.promise
            : completed("B completed id=n6 persistence=memory-only")
          : accepted,
      history,
    );
    const store = useCmdHistory(h.card.agentKey);
    vi.spyOn(store, "begin").mockImplementation(() => {
      throw new Error("history recorder unavailable");
    });
    idA = await h.send();
    expect(h.wrapper.find(`[data-cmd-id="${idA}"]`).attributes("data-memory-phase")).toBe("running");
    // History never arrives. It is not a prerequisite for results OR the idle stop action.
    expect(h.hub.state.value.agents.get(h.card.agentKey)?.history).not.toBe("loaded");
    expect(h.wrapper.find(".memory-stop").attributes("disabled")).toBeUndefined();
    h.signal(idA, first);
    await flush();
    h.signal(idA, first === "ctl" ? "late" : "ctl");
    h.signal(idA, first);
    let currentId = idA;
    if (replace) {
      currentId = await h.send("/mem session add B");
      h.signal(currentId, first);
      await flush();
    }
    queryA.resolve(completed("A completed id=n5 persistence=appended; 首次 conversation flush 前可能尚未落盘"));
    await flush();
    const card = h.wrapper.find(`[data-cmd-id="${currentId}"]`);
    expect(card.attributes("data-memory-phase")).toBe("completed");
    expect(card.text()).toContain(replace ? "B completed id=n6" : "A completed id=n5");
    expect(card.text()).toContain(replace ? "persistence=memory-only" : "尚未落盘");
    expect(card.text()).toContain("无法撤回");
    expect(h.wrapper.find(".memory-stop").exists()).toBe(false);
    expect(h.calls.filter((req) => req.queryOnly && req.id === idA)).toHaveLength(1);
    h.signal(idA, "late");
    h.signal(currentId, "ctl");
    await flush();
    expect(h.calls.filter((req) => req.queryOnly && req.id === idA)).toHaveLength(1);
    expect(h.calls.filter((req) => !req.queryOnly)).toHaveLength(replace ? 2 : 1);
    expect(store.begin).not.toHaveBeenCalled();
    expect(store.placeholders).toHaveLength(0);
    expect(store.notes).toHaveLength(0);
  });

  it.each(
    [false, true].flatMap((history) =>
      ["list", "path", "restore", "migrate --dry-run"].map((args) => ({ history, args })),
    ),
  )("sync read $args, history=$history uses the SAME reducer result; no stop", async ({ history, args }) => {
    const h = await setup(
      async () => ({
        ok: true,
        data: { completion: "sync", captured: true, output: { entries: [{ kind: "text", text: `read:${args}` }] } },
      }),
      history,
    );
    await h.send(`/mem ${args}`);
    expect(h.wrapper.find(".command-result").text()).toContain(`read:${args}`);
    expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("completed");
    expect(h.wrapper.text()).not.toContain("写入已完成");
    expect(h.wrapper.find(".memory-stop").exists()).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  it.each([false, true])(
    "idle stop sends a distinct session-level abort, ack is NOT cancellation, history=%s",
    async (history) => {
      const abortAck = barrier<CmdOutcome>();
      let result: CmdOutcome = { ok: true, data: { op: "query", state: "running" } };
      const h = await setup(
        async (req) => (req.op === "abort" ? abortAck.promise : req.queryOnly ? result : accepted),
        history,
      );
      const id = await h.send();
      expect(h.wrapper.text()).toContain("这是会话级停止，可能同时中止当前模型任务");
      await h.wrapper.find(".memory-stop").trigger("click");
      await h.wrapper.find(".memory-stop").trigger("click");
      const aborts = h.calls.filter((req) => req.op === "abort");
      expect(aborts).toHaveLength(1);
      expect(aborts[0]!.id).not.toBe(id);
      expect(aborts[0]!.expect).toEqual({ sessionId: h.card.session.sessionId });
      expect(aborts[0]).not.toHaveProperty("memoryUiKey");
      expect(h.wrapper.find(".memory-stop").attributes("disabled")).toBeDefined();
      expect(h.wrapper.text()).toContain("正在请求停止");
      abortAck.resolve({ ok: true, data: { op: "abort", wasBusy: false } });
      await flush();
      expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("running");
      expect(h.wrapper.text()).not.toContain("取消成功");
      result = refused();
      h.signal(id, "late", false);
      await flush();
      expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("rejected");
      expect(h.wrapper.find(".command-result").attributes("data-state")).toBe("failed");
      expect(h.wrapper.text()).toContain("E_MEM_CONFIRM_STALE effect=none 本步未执行");
      expect(h.wrapper.find(".memory-stop").exists()).toBe(false);
      expect(h.calls.filter((req) => req.queryOnly).every((req) => req.id === id)).toBe(true);
    },
  );

  it("click before server cancellation can still produce completed, never a fabricated none", async () => {
    const ack = barrier<CmdOutcome>();
    const h = await setup(async (req) => (req.op === "abort" ? ack.promise : req.queryOnly ? completed() : accepted));
    const id = await h.send();
    await h.wrapper.find(".memory-stop").trigger("click");
    h.signal(id, "ctl");
    await flush();
    ack.resolve({ ok: true, data: { wasBusy: false } });
    await flush();
    expect(h.wrapper.find(".memory-command").attributes("data-memory-effect")).toBe("completed");
    expect(h.wrapper.text()).toContain("id=n5");
    expect(h.wrapper.text()).toContain("无法撤回");
    expect(h.wrapper.text()).not.toContain("本步未执行");
  });

  it.each(["busy", "pending", "compacting", "switchInFlight"])(
    "%s is not idle: no actionable stop, restores when idle",
    async (flag) => {
      const h = await setup(async () => accepted);
      await h.send();
      h.emit("status", { agentKey: h.card.agentKey, status: { ...h.card.status, [flag]: true } });
      await flush();
      expect(h.wrapper.find(".memory-stop").exists()).toBe(false);
      h.emit("status", { agentKey: h.card.agentKey, status: h.card.status });
      await flush();
      expect(h.wrapper.find(".memory-stop").attributes("disabled")).toBeUndefined();
    },
  );

  it.each([false, true])(
    "unknown remains unknown (not done/not-executed) and not reversible, history=%s",
    async (history) => {
      const h = await setup(
        async (req) =>
          req.queryOnly ? refused("unknown", "E_PERSIST_UNKNOWN effect=unknown explicit-reopen-and-verify") : accepted,
        history,
      );
      const id = await h.send();
      h.signal(id, "late", false);
      await flush();
      expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("unknown");
      expect(h.wrapper.find(".command-result").attributes("data-state")).toBe("failed");
      expect(h.wrapper.text()).toContain("结果未知");
      expect(h.wrapper.text()).toContain("explicit-reopen-and-verify");
      expect(h.wrapper.text()).not.toContain("本步未执行");
      expect(h.wrapper.find(".memory-stop").exists()).toBe(false);
    },
  );

  it("terminal signal and query before async HTTP acknowledgement do not regress", async () => {
    const ack = barrier<CmdOutcome>();
    const h = await setup(async (req) => (req.queryOnly ? completed() : ack.promise));
    const textarea = h.wrapper.find("textarea");
    await textarea.setValue("/mem session add A");
    await textarea.trigger("keydown", { key: "Enter" });
    await flush();
    const id = h.calls[0]!.id;
    h.signal(id, "ctl");
    await flush();
    expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("completed");
    ack.resolve(accepted);
    await flush();
    expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("completed");
  });

  it("query failure recovers ONCE per reconnect through queryOnly; no polling/replay", async () => {
    let query: CmdOutcome = { ok: false, error: "E_NETWORK", effect: "unknown", retryable: true };
    const h = await setup(async (req) => (req.queryOnly ? query : accepted));
    const id = await h.send();
    h.signal(id, "late");
    await flush();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(1);
    expect(h.wrapper.text()).toContain("结果未知");
    for (let i = 0; i < 5; i++) h.signal(id, "ctl");
    await flush();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(1);
    query = completed("reconnected id=n9 memory-only");
    h.emit("conn", { state: "reconnecting" });
    h.emit("conn", { state: "open" });
    h.emit("hello", { clientId: "recovered-client" });
    await flush();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(2);
    expect(h.wrapper.text()).toContain("reconnected id=n9");
    expect(h.calls.filter((req) => !req.queryOnly)).toHaveLength(1);
  });

  it("failed recovery queries run once per connection: transport open→hello keeps 1→2, not 1→3", async () => {
    const h = await setup(async (req) =>
      req.queryOnly ? { ok: false, error: "E_NETWORK", effect: "unknown", retryable: true } : accepted,
    );
    const id = await h.send();
    h.signal(id, "late");
    await flush();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(1);

    h.emit("conn", { state: "reconnecting" });
    // transport-core.js's hello handler synchronously calls onConn("open") BEFORE onMessage(hello).
    // Keep this order and no flush between the callbacks, including when queryOnly fails.
    h.emit("conn", { state: "open" });
    h.emit("hello", { clientId: "recovered-client" });
    await flush();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(2);
    expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("unknown");
    h.emit("hello", { clientId: "recovered-client" });
    h.signal(id, "ctl");
    await flush();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(2);

    h.emit("conn", { state: "reconnecting" });
    h.emit("conn", { state: "open" });
    h.emit("hello", { clientId: "next-client" });
    await flush();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(3);
    expect(h.calls.filter((req) => !req.queryOnly)).toHaveLength(1);
    expect(h.calls.filter((req) => req.queryOnly).every((req) => req.id === id)).toBe(true);
  });

  it("expired query is unknown, never generic E_UNKNOWN_ID → notExecuted", async () => {
    const h = await setup(async (req) =>
      req.queryOnly ? { ok: false, error: "E_UNKNOWN_ID", effect: "none", retryable: false } : accepted,
    );
    const id = await h.send();
    h.signal(id, "ctl");
    await flush();
    expect(h.wrapper.find(".memory-command").attributes("data-memory-effect")).toBe("unknown");
    expect(h.wrapper.text()).not.toContain("本步未执行");
    expect(h.wrapper.find(".memory-query").exists()).toBe(true);
  });

  it.each([false, true])(
    "dismiss is hide-only, still-idle task bar survives, no query resurrection; history=%s",
    async (history) => {
      const h = await setup(async (req) => (req.queryOnly ? completed() : accepted), history);
      const id = await h.send();
      await h.wrapper.find(".memory-dismiss").trigger("click");
      expect(h.wrapper.find(".command-result").exists()).toBe(false);
      expect(h.wrapper.find(".memory-stop").exists()).toBe(true);
      expect(h.calls.filter((req) => req.op === "abort")).toHaveLength(0);
      h.signal(id, "ctl");
      await flush();
      expect(h.wrapper.find(".command-result").exists()).toBe(false);
      expect(h.wrapper.find(".memory-command").exists()).toBe(false);
      expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(1);
    },
  );

  it.each(["session", "epoch"])("%s change invalidates old task/query/stop identities", async (boundary) => {
    const query = barrier<CmdOutcome>();
    const h = await setup(async (req) => (req.queryOnly ? query.promise : accepted));
    const id = await h.send();
    h.signal(id, "ctl");
    await flush();
    if (boundary === "session")
      h.emit("session", { agentKey: h.card.agentKey, session: { ...h.card.session, sessionId: "new-session" } });
    else h.emit("agent_up", { ...h.card, epoch: "new-epoch" });
    await flush();
    query.resolve(completed("STALE MUST NOT SHOW"));
    await flush();
    expect(h.wrapper.find(".memory-stop").exists()).toBe(false);
    expect(h.wrapper.text()).not.toContain("STALE MUST NOT SHOW");
    expect(h.calls.filter((req) => req.op === "abort")).toHaveLength(0);
  });

  it("unmount leaves only query bookkeeping; a fresh page cannot resurrect an id or replay the write", async () => {
    const query = barrier<CmdOutcome>();
    const h = await setup(async (req) => (req.queryOnly ? query.promise : accepted));
    const id = await h.send();
    h.signal(id, "ctl");
    await flush();
    h.wrapper.unmount();
    query.resolve(completed());
    await flush();
    const fresh = await setup(async () => {
      throw new Error("refresh must not execute anything");
    });
    fresh.signal(id, "late");
    await flush();
    expect(fresh.wrapper.find(".memory-command").exists()).toBe(false);
    expect(fresh.calls).toHaveLength(0);
  });
  it("same-tick A→B→A scope round trip cannot revive the original stop or response", async () => {
    const query = barrier<CmdOutcome>();
    const h = await setup(async (req) => (req.queryOnly ? query.promise : accepted));
    const id = await h.send();
    h.signal(id, "ctl");
    await flush();
    h.emit("agent_up", { ...h.card, epoch: "intermediate-epoch" });
    h.emit("agent_up", h.card); // no Vue flush between the two boundary frames
    query.resolve(completed("OLD ROUND-TRIP RESULT"));
    await flush();
    expect(h.wrapper.find(".memory-stop").exists()).toBe(false);
    expect(h.wrapper.text()).not.toContain("OLD ROUND-TRIP RESULT");
    expect(h.calls.filter((req) => req.op === "abort")).toHaveLength(0);
  });

  it("old abort acknowledgement does not query or replace a same-name newer operation", async () => {
    const ack = barrier<CmdOutcome>();
    const h = await setup(async (req) =>
      req.op === "abort" ? ack.promise : req.queryOnly ? completed("NEW id=n10") : accepted,
    );
    const a = await h.send();
    await h.wrapper.find(".memory-stop").trigger("click");
    // Composer normally gates new sends during abort's HTTP flight; a stale queued send
    // event must still be identity-safe at the Dock boundary (without modifying Composer).
    h.wrapper.findComponent(Composer).vm.$emit("send", "/mem session add new operation", "steer");
    await flush();
    const b = h.calls.filter((req) => req.op === "command" && !req.queryOnly).at(-1)!.id;
    expect(b).not.toBe(a);
    h.signal(b, "late");
    await flush();
    const queryCount = h.calls.filter((req) => req.queryOnly).length;
    ack.resolve({ ok: true, data: { wasBusy: false } });
    await flush();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(queryCount);
    expect(h.calls.filter((req) => req.queryOnly && req.id === a)).toHaveLength(0);
    expect(h.wrapper.find(".memory-command").attributes("data-cmd-id")).toBe(b);
    expect(h.wrapper.text()).toContain("NEW id=n10");
  });

  it("a stale operation generation cannot inject a result into the real reducer", async () => {
    const h = await setup(async () => accepted);
    const id = await h.send();
    const item = h.hub.state.value.agents
      .get(h.card.agentKey)!
      .pendingCtl!.find((raw) => (raw as { id: string }).id === id) as { memoryUiKey: { operationGeneration: number } };
    h.emit("ctl_result", {
      agentKey: h.card.agentKey,
      id,
      expectedKey: { ...item.memoryUiKey, operationGeneration: item.memoryUiKey.operationGeneration + 1 },
      transition: { type: "query_result", outcome: completed("FORGED OLD GENERATION") },
    });
    await flush();
    expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("running");
    expect(h.wrapper.text()).not.toContain("FORGED OLD GENERATION");
  });

  it("immediate host refusal is rejected, has no stop action and never queries/replays", async () => {
    const h = await setup(async () => ({
      ok: false,
      error: "E_COMMAND_DENIED",
      message: "E_MEM_BUSY effect=none 未执行",
      effect: "none",
      retryable: false,
    }));
    await h.send();
    expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("rejected");
    expect(h.wrapper.text()).toContain("E_MEM_BUSY effect=none");
    expect(h.wrapper.find(".memory-stop").exists()).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  it("oversized result is bounded pure data and displays unknown rather than success", async () => {
    const h = await setup(async (req) => (req.queryOnly ? completed("x".repeat(33 * 1024)) : accepted));
    const id = await h.send();
    h.signal(id, "late");
    await flush();
    const item = h.hub.state.value.agents
      .get(h.card.agentKey)!
      .pendingCtl!.find((raw) => (raw as { id: string }).id === id) as { memoryResult: unknown };
    expect(new TextEncoder().encode(JSON.stringify(item.memoryResult)).length).toBeLessThanOrEqual(32 * 1024);
    expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("unknown");
    expect(h.wrapper.text()).toContain("结果未知");
    expect(h.wrapper.text()).toContain("E_RESULT_TOO_LARGE");
  });

  it("loss of command permission disables the idle action, stale handlers do not abort", async () => {
    const h = await setup(async () => accepted);
    await h.send();
    const button = h.wrapper.find(".memory-stop");
    h.emit("commands", { agentKey: h.card.agentKey, items: [] });
    h.emit("agent_up", { ...h.card, control: false });
    await flush();
    await button.trigger("click");
    expect(h.calls.filter((req) => req.op === "abort")).toHaveLength(0);
  });
  it("an unknown initial completion is queried, not mislabeled as a running success", async () => {
    const h = await setup(async (req) =>
      req.queryOnly
        ? { ok: false, error: "E_UNKNOWN_ID", effect: "none", retryable: false }
        : { ok: true, data: { completion: "unknown", captured: true } },
    );
    await h.send();
    expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("unknown");
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(1);
    expect(h.wrapper.text()).not.toContain("本步未执行");
  });
  it("full 32-slot local admission has a visible refusal and sends nothing new", async () => {
    const h = await setup(async () => accepted);
    for (let n = 0; n < 32; n++) await h.send(`/mem session add ${n}`);
    const before = h.calls.length;
    await h.send("/mem session add overflow");
    expect(h.calls).toHaveLength(before);
    expect(h.wrapper.find(".command-result").attributes("data-state")).toBe("failed");
    expect(h.wrapper.text()).toContain("跟踪已满（32 条），未发送本次操作");
    expect(h.wrapper.find(".memory-stop").exists()).toBe(false);
  });
  it("reconnect recovers an apparently running command whose terminal ctl/late were missed offline", async () => {
    const h = await setup(async (req) => (req.queryOnly ? completed("offline terminal id=n42") : accepted));
    const id = await h.send();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(0);
    h.emit("conn", { state: "reconnecting" });
    // The host finishes here. No terminal SSE frame reaches this tab.
    h.emit("conn", { state: "open" });
    h.emit("hello", { clientId: "new-client" });
    await flush();
    expect(h.calls.filter((req) => req.queryOnly)).toHaveLength(1);
    expect(h.calls.filter((req) => req.queryOnly)[0]!.id).toBe(id);
    expect(h.calls.filter((req) => !req.queryOnly)).toHaveLength(1);
    expect(h.wrapper.find(".memory-command").attributes("data-memory-phase")).toBe("completed");
    expect(h.wrapper.text()).toContain("offline terminal id=n42");
  });
});
