// @vitest-environment happy-dom
/** Production child collector → synchronous run observer → EventTap → reducer → mounted drawer. */
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, expect, it } from "vitest";
import { setup } from "./message-speed-helpers.js";
import { createRunTranscripts, type RunTranscriptPort } from "../../src/web-hub/agent/run-transcript.js";
import { projectSessionEntry } from "../../src/web-hub/protocol/keys.js";
import { initialState, reduce } from "../../src/web-hub/ui/src/logic/state.js";
import RunTranscript from "../../src/web-hub/ui/src/components/drawer/RunTranscript.vue";
import type { AgentState } from "../../src/web-hub/ui/src/types.js";
import type { AgentFrame } from "../../src/web-hub/protocol/messages.js";

const wrappers: ReturnType<typeof mount>[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  cleanups.splice(0).forEach((fn) => fn());
});
function harness(children: Record<string, ReturnType<typeof setup>> = { one: setup() }) {
  const listeners = new Map<string, Parameters<RunTranscriptPort["observe"]>[1]>();
  const savedListeners: Parameters<RunTranscriptPort["observe"]>[1][] = [];
  const frames: AgentFrame[] = [];
  const rt = createRunTranscripts({
    port: () => ({
      info: () => ({ status: "running", terminal: false }),
      branch: () => [],
      observe: (id, l) => {
        listeners.set(id, l);
        savedListeners.push(l);
        return {
          kind: "attached",
          detach: () => {
            listeners.delete(id);
          },
        };
      },
    }),
    enabled: () => true,
    trySend: (f) => {
      frames.push(f);
      return "written";
    },
    now: () => 1000,
    setTimer: () => ({ cancel() {} }),
  });
  cleanups.push(() => {
    rt.resetForSession();
    Object.values(children).forEach((c) => c.fire("agent_end"));
  });
  const emit = (id: string, type: string, message: unknown) => listeners.get(id)?.onEvent({ type, message });
  const collect = (h = children.one!, tokens = 10) => {
    h.message.usage.output = tokens;
    h.start();
    h.delta(0);
    h.delta(500);
    h.raw(tokens);
  };
  const complete = (id = "one", h = children.one!) => {
    h.fire("message_end", { message: h.message });
    emit(id, "message_end", h.message);
  };
  const ends = () =>
    frames.filter((f): f is Extract<AgentFrame, { t: "run_ev" }> => f.t === "run_ev" && f.e.type === "message_end");
  return { rt, emit, collect, complete, frames, ends, savedListeners, children };
}
function view(entries: unknown[] = []) {
  let state = [
    {
      event: "agents",
      data: [
        {
          agentKey: "A",
          kind: "tui",
          pid: 1,
          cwd: "/tmp",
          state: "live",
          pluginVersion: "1",
          outdated: false,
          prompts: [],
        },
      ],
    },
    { event: "subscribing", data: { agentKey: "A", clientId: "c" } },
    { event: "history", data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
    { event: "run_select", data: { agentKey: "A", runId: "one" } },
    { event: "run_subscribing", data: { agentKey: "A", runId: "one", at: 100, retries: 0 } },
    {
      event: "run_history",
      data: {
        agentKey: "A",
        runId: "one",
        entries,
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        terminal: false,
        live: true,
        status: "running",
      },
    },
  ].reduce((s, e) => reduce(s, e), initialState(null));
  const agent = () => state.agents.get("A") as unknown as AgentState;
  const wrapper = mount(RunTranscript, { props: { agent: agent(), now: 1000 } });
  wrappers.push(wrapper);
  return {
    wrapper,
    async receive(frame: AgentFrame) {
      if (frame.t !== "run_ev") throw new Error("expected run_ev");
      state = reduce(state, { event: "run_ev", data: { ...frame, agentKey: "A" } });
      await wrapper.setProps({ agent: agent() });
      await nextTick();
    },
  };
}
function history(h: ReturnType<typeof setup>) {
  return [
    { id: "assistant-exact-mid", type: "message", parentId: null, timestamp: "2026-01-01", message: h.message },
    ...h.persisted.map(([customType, data], i) => ({
      id: `meta-${i}`,
      type: "custom",
      parentId: "assistant-exact-mid",
      timestamp: "2026-01-01",
      customType,
      data,
    })),
  ]
    .map(projectSessionEntry)
    .filter((e) => e !== undefined);
}
it("already-open drawer displays at message_end tick, and refresh restores exactly the same value", async () => {
  const h = harness();
  const v = view();
  expect(v.wrapper.text()).not.toContain("tokens/s");
  h.rt.onWatch("one", true);
  h.collect();
  h.complete();
  const frame = h.ends()[0]!;
  await v.receive(frame);
  expect(v.wrapper.text()).toContain("20.0 tokens/s");
  expect(h.children.one!.appendEntry).not.toHaveBeenCalled(); // before turn_end, not a history shortcut
  expect(h.children.one!.message).not.toHaveProperty("piToolkitGeneration");
  h.children.one!.finish();
  expect(h.frames.some((f) => f.t === "run_gap")).toBe(false);
  const refreshed = view(history(h.children.one!));
  expect(refreshed.wrapper.text()).toContain("20.0 tokens/s");
  expect(refreshed.wrapper.find(".tx-speed").text()).toBe(v.wrapper.find(".tx-speed").text());
});
it("later-open drawer and never-watched run retain collection/persistence independently of subscriptions", () => {
  const h = harness();
  h.collect();
  h.complete();
  h.children.one!.finish();
  expect(h.frames).toEqual([]);
  expect(h.children.one!.appendEntry).toHaveBeenCalledTimes(1);
  h.rt.onWatch("one", true);
  expect(view(history(h.children.one!)).wrapper.text()).toContain("20.0 tokens/s");
});
it("two concurrent children with identical provider IDs cannot exchange numbers", () => {
  const h = harness({ one: setup(), two: setup() });
  h.rt.onWatch("one", true);
  h.rt.onWatch("two", true);
  h.collect(h.children.one!, 10);
  h.collect(h.children.two!, 25);
  h.complete("two", h.children.two!);
  h.complete();
  expect(h.ends().map((f) => [f.runId, f.e.message?.piToolkitGeneration?.tokens])).toEqual([
    ["two", 25],
    ["one", 10],
  ]);
});
it("unsubscribe invalidates the completion; old observer and revocation never touch the replacement tap", () => {
  const h = harness();
  h.rt.onWatch("one", true);
  h.collect();
  h.complete();
  const old = h.savedListeners[0]!;
  h.rt.onWatch("one", false);
  h.rt.onWatch("one", true);
  const count = h.frames.length;
  old.onEvent({ type: "message_end", message: h.children.one!.message });
  h.emit("one", "message_end", h.children.one!.message);
  expect(h.frames).toHaveLength(count + 1);
  expect(h.ends().at(-1)!.e.message).not.toHaveProperty("piToolkitGeneration");
  h.children.one!.appendEntry.mockImplementation(() => {
    throw new Error("append failed");
  });
  h.children.one!.finish();
  expect(h.frames.some((f) => f.t === "run_gap")).toBe(false);
});
it("resume/new generation invalidates an unread old completion even with the exact same final object", () => {
  const h = harness();
  h.collect();
  h.complete(); // no observer at completion
  h.children.one!.start(); // fresh generation, same SDK object for adversarial replay
  h.rt.onWatch("one", true);
  h.emit("one", "message_end", h.children.one!.message);
  expect(h.ends()[0]!.e.message).not.toHaveProperty("piToolkitGeneration");
  h.children.one!.delta(1000);
  h.children.one!.delta(1500);
  h.children.one!.raw();
  h.complete();
  expect(h.ends()[1]!.e.message?.piToolkitGeneration?.tokens).toBe(10);
});
it.each(["missing", "owner", "no-raw", "usage-conflict", "short"])("bridge %s degrades only to no display", (mode) => {
  const h = harness();
  h.rt.onWatch("one", true);
  const child = h.children.one!;
  if (mode === "no-raw" || mode === "short") {
    child.start();
    child.delta(0);
    child.delta(mode === "short" ? 499 : 500);
    if (mode === "short") child.raw();
  } else h.collect();
  if (mode === "usage-conflict") child.message.usage.output = 11;
  if (mode !== "missing") child.fire("message_end", { message: child.message });
  if (mode === "owner") child.changeId();
  h.emit("one", "message_end", child.message);
  expect(h.ends()[0]!.e.message).not.toHaveProperty("piToolkitGeneration");
});
it("append failure requests revocation via run_gap, and the replacement history has no chip", async () => {
  const h = harness();
  const v = view();
  h.rt.onWatch("one", true);
  h.collect();
  h.complete();
  await v.receive(h.ends()[0]!);
  expect(v.wrapper.text()).toContain("20.0 tokens/s");
  h.children.one!.appendEntry.mockImplementation(() => {
    throw new Error("append failed");
  });
  h.children.one!.finish();
  expect(h.frames.at(-1)).toMatchObject({ t: "run_gap", runId: "one", fromSeq: 1 });
  // pi swallows append failure: emulate the hub's gap → snapshot replacement from the actual branch.
  expect(h.children.one!.persisted).toEqual([]);
  expect(view(history(h.children.one!)).wrapper.text()).not.toContain("tokens/s");
});

it("disconnect invalidates an old completion and its revocation callback without altering retry taps", () => {
  const h = harness();
  h.rt.onWatch("one", true);
  h.collect();
  h.complete();
  h.rt.onLink(false);
  h.rt.onLink(true);
  h.emit("one", "message_end", h.children.one!.message);
  expect(h.ends().at(-1)!.e.message).not.toHaveProperty("piToolkitGeneration");
  h.children.one!.appendEntry.mockImplementation(() => {
    throw new Error("append failed");
  });
  h.children.one!.finish();
  expect(h.frames.some((f) => f.t === "run_gap")).toBe(false);
});
it("tool messages between assistant completion and turn_end do not clear the assistant's completion", () => {
  const h = harness();
  h.rt.onWatch("one", true);
  h.collect();
  h.children.one!.message.stopReason = "toolUse";
  h.complete();
  const tool = { role: "toolResult", content: [] };
  h.children.one!.fire("message_start", { message: tool });
  h.children.one!.fire("message_end", { message: tool });
  h.emit("one", "message_end", tool);
  expect(h.frames.some((f) => f.t === "run_gap")).toBe(false);
  h.children.one!.finish();
  expect(h.children.one!.appendEntry).toHaveBeenCalledTimes(1);
  expect(h.frames.some((f) => f.t === "run_gap")).toBe(false);
});
it("owner replacement prevents an old rollback from reaching the resumed owner's tap", () => {
  const h = harness();
  h.rt.onWatch("one", true);
  h.collect();
  h.complete();
  const oldFrames = h.frames.length;
  h.children.one!.changeId();
  h.children.one!.fire("provider_stream_event");
  h.children.one!.finish();
  expect(h.frames).toHaveLength(oldFrames);
  h.collect();
  h.complete();
  h.children.one!.finish();
  expect(h.ends().at(-1)!.e.message?.piToolkitGeneration?.tokens).toBe(10);
  expect(h.frames.some((f) => f.t === "run_gap")).toBe(false);
});

it("only the exact final object is readable; an untrusted SDK container is stripped even on a lookalike", () => {
  const h = harness();
  h.rt.onWatch("one", true);
  h.collect();
  h.children.one!.fire("message_end", { message: h.children.one!.message });
  h.emit("one", "message_end", {
    ...h.children.one!.message,
    piToolkitGeneration: { v: 1, tokens: 999, genMs: 500, deltaCount: 2 },
  });
  expect(h.ends()[0]!.e.message).not.toHaveProperty("piToolkitGeneration");
  h.emit("one", "message_end", h.children.one!.message);
  expect(h.ends()[1]!.e.message?.piToolkitGeneration?.tokens).toBe(10);
  h.emit("one", "message_end", h.children.one!.message);
  expect(h.ends()[2]!.e.message).not.toHaveProperty("piToolkitGeneration"); // take once
});
