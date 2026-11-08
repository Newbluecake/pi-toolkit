import { describe, expect, it, vi } from "vitest";
import { expectHidden } from "./message-speed-test-helpers.js";
import { createMessageSpeed, type MessageSpeedOwner } from "../../../src/web-hub/agent/message-speed.js";
import { messageSpeedBinding } from "../../../src/web-hub/agent/message-speed-binding.js";
import { createEventTap } from "../../../src/web-hub/agent/event-tap.js";

const binding = { responseId: "resp", provider: "openai", api: "openai-responses", model: "fake" };
const completed = (id = "resp") => ({
  provider: binding.provider,
  api: binding.api,
  model: binding.model,
  data: {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      usage: { output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } },
      output: [],
    },
  },
});
function fixture() {
  let time = 0;
  let currentOwner: MessageSpeedOwner | undefined = {
    sessionId: "session",
    sessionGeneration: 1,
    activationGeneration: {},
    ownerToken: {},
  };
  let ctx: object | undefined = {};
  let sid: unknown = "session";
  let guard: (() => unknown) | undefined = () => undefined;
  const append = vi.fn();
  const speed = createMessageSpeed({
    monotonicNow: () => time,
    currentOwner: () => currentOwner,
    getCurrentContext: () => ctx,
    sessionId: () => sid,
    secureRecheckForWrite: () => guard?.(),
    appendEntry: append,
  });
  const message = {
    role: "assistant",
    ...binding,
    stopReason: "stop",
    content: [{ type: "text", text: "ok" }],
    usage: { output: 10 },
  };
  const event = (type: string, extra: Record<string, unknown> = {}) => speed.event({ type, ...extra });
  const start = (index: unknown = 0) => {
    event("agent_start");
    event("turn_start", { turnIndex: index });
    event("message_start", { message });
  };
  const delta = (kind = "text_delta", b: typeof binding | undefined = binding, text = "a") =>
    speed.delta(kind, text, b);
  const generate = () => {
    delta();
    time = 500;
    delta();
    speed.raw(completed());
  };
  const finish = (over: Record<string, unknown> = {}) =>
    event("turn_end", { message, turnIndex: 0, messageEntryId: "mid", ...over });
  return {
    speed,
    event,
    start,
    delta,
    generate,
    finish,
    message,
    append,
    setTime: (n: number) => {
      time = n;
    },
    owner: () => currentOwner!,
    setOwner: (o: MessageSpeedOwner | undefined) => {
      currentOwner = o;
    },
    setCtx: (o: object | undefined) => {
      ctx = o;
    },
    setSid: (s: unknown) => {
      sid = s;
    },
    setGuard: (g: () => unknown) => {
      guard = g;
    },
  };
}
const core = { v: 1, tokens: 10, genMs: 500, deltaCount: 2 };
describe("generation lifecycle and exact-owner persistence", () => {
  it("consumes proof and pending once, nonassistant end does not consume, final object is unmodified", () => {
    const f = fixture();
    f.start();
    f.generate();
    expect(f.speed.end({ role: "toolResult" })).toBeUndefined();
    expect(f.speed.end(f.message)).toEqual(core);
    expect(f.message).not.toHaveProperty("piToolkitGeneration");
    f.finish();
    f.finish();
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledWith("subagent:web-msg-speed", { piToolkitGeneration: { ...core, mid: "mid" } });
  });
  it.each(["agent_end", "agent_settled", "agent_start", "turn_start", "message_start", "reset"])(
    "clears pending on %s",
    (type) => {
      const f = fixture();
      f.start();
      f.generate();
      expect(f.speed.end(f.message)).toEqual(core);
      if (type === "reset") f.speed.reset();
      else f.event(type, { turnIndex: 0, message: f.message });
      f.finish();
      expect(f.append).not.toHaveBeenCalled();
    },
  );
  it.each(["mid", "index", "copy", "missing-ref"])("skips mismatched %s and consumes pending", (failure) => {
    const f = fixture();
    f.start();
    f.generate();
    expect(f.speed.end(f.message)).toEqual(core);
    const over =
      failure === "mid"
        ? { messageEntryId: undefined }
        : failure === "index"
          ? { turnIndex: 1 }
          : { message: failure === "copy" ? { ...f.message } : undefined };
    f.finish(over);
    f.finish();
    expect(f.append).not.toHaveBeenCalled();
  });
  it.each([
    "ctx",
    "session",
    "token",
    "generation",
    "activation",
    "locked",
    "throw",
    "thenable",
    "guard-revoke",
    "guard-ctx",
  ])("write guard %s fails closed", (failure) => {
    const f = fixture();
    f.start();
    f.generate();
    expect(f.speed.end(f.message)).toEqual(core);
    if (failure === "ctx") f.setCtx(undefined);
    if (failure === "session") f.setSid("other");
    if (failure === "token") f.setOwner({ ...f.owner(), ownerToken: {} });
    if (failure === "generation") f.setOwner({ ...f.owner(), sessionGeneration: 2 });
    if (failure === "activation") f.setOwner({ ...f.owner(), activationGeneration: {} });
    if (failure === "locked") f.setGuard(() => "LOCKED");
    if (failure === "throw")
      f.setGuard(() => {
        throw new Error("stale");
      });
    if (failure === "thenable") f.setGuard(() => ({ then() {} }));
    if (failure === "guard-revoke")
      f.setGuard(() => {
        f.setOwner(undefined);
      });
    if (failure === "guard-ctx")
      f.setGuard(() => {
        f.setCtx({});
      });
    f.finish();
    f.finish();
    expect(f.append).not.toHaveBeenCalled();
  });
  it("append throw consumes pending without retry", () => {
    const f = fixture();
    f.append.mockImplementation(() => {
      throw new Error("write");
    });
    f.start();
    f.generate();
    f.speed.end(f.message);
    f.finish();
    f.finish();
    expect(f.append).toHaveBeenCalledTimes(1);
  });
  it("late subscription, invalid public index and next loop reuse of zero never borrow identity", () => {
    const f = fixture();
    f.event("turn_start", { turnIndex: 0 });
    f.event("message_start", { message: f.message });
    f.generate();
    expect(f.speed.end(f.message)).toBeUndefined();
    for (const index of [null, -1, NaN, 0.5]) {
      f.start(index);
      f.generate();
      expect(f.speed.end(f.message)).toBeUndefined();
    }
    f.setTime(0);
    f.start();
    f.generate();
    expect(f.speed.end(f.message)).toEqual(core);
    f.event("agent_start");
    f.event("turn_start", { turnIndex: 0 });
    f.finish();
    expect(f.append).not.toHaveBeenCalled();
    f.setTime(0);
    f.event("turn_start", { turnIndex: 0 });
    f.event("message_start", { message: f.message });
    f.generate();
    expect(f.speed.end(f.message)).toEqual(core);
    f.finish();
    expect(f.append).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete starts, unknown api, mismatched output or final id", () => {
    for (const change of ["api", "id", "tokens", "missing-proof"]) {
      const f = fixture();
      f.start();
      f.generate();
      if (change === "api") f.message.api = "unknown";
      if (change === "id") f.message.responseId = "other";
      if (change === "tokens") f.message.usage.output = 9;
      if (change === "missing-proof") {
        f.event("message_start", { message: f.message });
        f.delta();
        f.setTime(1000);
        f.delta();
      }
      expect(f.speed.end(f.message)).toBeUndefined();
    }
  });
  it.each([0, 1, 2, 3])("count %i crossed with 0/499/500/501ms exact thresholds", (count) => {
    for (const span of [0, 499, 500, 501]) {
      const f = fixture();
      f.start();
      for (let i = 0; i < count; i++) {
        f.setTime(i === 0 ? 0 : span);
        f.delta();
      }
      f.speed.raw(completed());
      expect(f.speed.end(f.message)).toEqual(
        count >= 2 && span >= 500 ? { ...core, genMs: span, deltaCount: count } : undefined,
      );
    }
  });
  it("raw different-id cannot supply proof, duplicate invalidates, each delta needs its own binding", () => {
    for (const kind of ["warmer-only", "duplicate", "missing-binding", "changed-binding", "backwards", "nan"]) {
      const f = fixture();
      f.start();
      f.delta();
      f.setTime(500);
      if (kind === "missing-binding") f.speed.delta("text_delta", "b", undefined);
      else if (kind === "changed-binding") f.delta("text_delta", { ...binding, responseId: "other" });
      else {
        if (kind === "backwards") f.setTime(-1);
        if (kind === "nan") f.setTime(NaN);
        f.delta();
      }
      f.speed.raw(completed(kind === "warmer-only" ? "warmer" : "resp"));
      if (kind === "duplicate") f.speed.raw(completed());
      expect(f.speed.end(f.message)).toBeUndefined();
    }
  });
  it("host own-data adapter rejects getters/inherited/proxy while content and usage stay unread", () => {
    let calls = 0;
    const throwing = () => {
      calls++;
      throw new Error("getter");
    };
    const m = { ...binding };
    for (const key of ["content", "usage"]) Object.defineProperty(m, key, { get: throwing });
    expect(messageSpeedBinding({ message: m })).toEqual(binding);
    expect(messageSpeedBinding({ message: Object.create(m) })).toBeUndefined();
    for (const key of ["responseId", "provider", "api", "model"]) {
      const bad = { ...binding };
      Object.defineProperty(bad, key, { get: throwing });
      expect(messageSpeedBinding({ message: bad })).toBeUndefined();
    }
    expect(
      messageSpeedBinding(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("trap");
            },
          },
        ),
      ),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });
  it("tap timer coalescing does not change original count/span and message_end emits once before turn_end", () => {
    const f = fixture();
    const events: unknown[] = [];
    const tap = createEventTap((e) => events.push(e), {
      speed: f.speed,
      now: () => 0,
      setTimer: () => ({ cancel() {} }),
    });
    tap.handle({ type: "agent_start" });
    tap.handle({ type: "turn_start", turnIndex: 0 });
    tap.handle({ type: "message_start", message: f.message });
    for (const time of [0, 500]) {
      f.setTime(time);
      tap.handle(
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" } },
        binding,
      );
    }
    f.speed.raw(completed());
    tap.handle({ type: "message_end", message: f.message });
    expect(events).toContainEqual({ type: "message_end", message: { ...f.message, piToolkitGeneration: core } });
    expect(tap.recent()[0]?.message.piToolkitGeneration).toEqual(core);
    tap.handle({ type: "turn_end", turnIndex: 0, message: f.message, messageEntryId: "mid" });
    expect(events.filter((e) => (e as { type: string }).type === "message_end")).toHaveLength(1);
    tap.dispose();
  });
});

it("P0 delta-only tap stays positive with hostile snapshot getters and independently supplied own scalar binding", () => {
  const f = fixture();
  const emitted: Array<Record<string, unknown>> = [];
  let getters = 0;
  const throwing = () => {
    getters++;
    throw new Error("snapshot getter");
  };
  const tap = createEventTap((e) => emitted.push(e), {
    speed: f.speed,
    now: () => 0,
    setTimer: () => ({ cancel() {} }),
  });
  tap.handle({ type: "agent_start" });
  tap.handle({ type: "turn_start", turnIndex: 0 });
  tap.handle({ type: "message_start", message: f.message });
  const ame = { type: "text_delta", delta: "a", contentIndex: 0 };
  for (const key of ["partial", "message", "error"]) Object.defineProperty(ame, key, { get: throwing });
  const update = { type: "message_update", assistantMessageEvent: ame };
  Object.defineProperty(update, "message", { get: throwing });
  for (const time of [0, 500]) {
    f.setTime(time);
    tap.handle(update, binding);
  }
  f.speed.raw(completed());
  tap.handle({ type: "message_end", message: f.message });
  expect(getters).toBe(0);
  expect(
    (emitted.findLast((e) => e.type === "message_end")?.message as Record<string, unknown>).piToolkitGeneration,
  ).toEqual(core);
  expect(emitted.find((e) => e.type === "message_update")?.assistantMessageEvent).toEqual({
    type: "text_delta",
    delta: "aa",
    contentIndex: 0,
  });
  tap.dispose();
});

it("raw completed must own response.id and output count with no inherited/getter evidence", () => {
  for (const kind of ["response-id", "output-mismatch", "status", "unknown-api", "error", "aborted"]) {
    const f = fixture();
    f.start();
    f.delta();
    f.setTime(500);
    f.delta();
    const raw = completed() as unknown as {
      api: string;
      data: { response: Record<string, unknown>; response_id?: string };
    };
    const r = raw.data.response;
    let calls = 0;
    if (kind === "response-id") {
      delete r.id;
      raw.data.response_id = "resp";
    }
    if (kind === "output-mismatch") r.usage = { output_tokens: 11, output_tokens_details: { reasoning_tokens: 0 } };
    if (kind === "status") r.status = "failed";
    if (kind === "unknown-api") raw.api = "unknown";
    if (kind === "error" || kind === "aborted") Object.assign(f.message, { stopReason: kind });
    f.speed.raw(raw);
    expect(f.speed.end(f.message)).toBeUndefined();
    expect(calls).toBe(0);
  }
});

it.each(["missing", "inherited", "getter", "nonzero"])(
  "Responses thinking accepts %s reasoning detail without reading it",
  (kind) => {
    const f = fixture();
    f.start();
    f.delta("thinking_delta");
    f.setTime(500);
    f.delta("thinking_delta");
    f.message.content.push({ type: "thinking", text: "summary" }, { type: "redacted_thinking", text: "" });
    const raw = completed();
    let calls = 0;
    const details = kind === "inherited" ? Object.create({ reasoning_tokens: 2 }) : {};
    if (kind === "getter")
      Object.defineProperty(details, "reasoning_tokens", {
        get() {
          calls++;
          return 2;
        },
      });
    if (kind === "nonzero") Object.assign(details, { reasoning_tokens: 2 });
    raw.data.response.usage.output_tokens_details = details;
    raw.data.response.output = [{ type: "reasoning", summary: [] }] as never[];
    f.speed.raw({ ...raw, data: { type: "response.reasoning_summary_text.delta", response_id: "resp" } });
    f.speed.raw(raw);
    expect(f.speed.end(f.message)).toEqual(core);
    f.finish();
    expect(f.append).toHaveBeenCalledWith("subagent:web-msg-speed", { piToolkitGeneration: { ...core, mid: "mid" } });
    expect(calls).toBe(0);
  },
);

describe("P1 completions proof", () => {
  it.each([
    "positive",
    "choice usage",
    "reasoning",
    "thinking",
    "changed id",
    "missing usage",
    "null usage",
    "mismatch",
    "empty",
    "tool round",
    "conflicting usage",
    "tail delta",
    "early changed id",
    "early usage",
    "same chunk conflict",
    "null intermediate",
    "multi choice",
    "unknown finish",
  ])("%s", (mode) => {
    const f = fixture();
    const b = { ...binding, api: "openai-completions" };
    const message = {
      ...f.message,
      ...b,
      stopReason: mode === "tool round" ? "toolUse" : "stop",
      content: mode === "empty" ? [] : mode === "thinking" ? [{ type: "thinking", text: "x" }] : f.message.content,
      usage: { output: mode === "mismatch" ? 9 : 10 },
    };
    const raw = (data: unknown) => f.speed.raw({ provider: b.provider, model: b.model, api: b.api, data });
    const chunk = (id: string, choices: unknown[], usage?: unknown) => ({
      id,
      choices,
      ...(usage === undefined ? {} : { usage }),
    });
    f.start();
    raw(chunk("resp", [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]));
    if (mode === "early changed id") raw(chunk("other", []));
    if (mode === "early usage") raw(chunk("resp", [], { completion_tokens: 10 }));
    if (mode === "multi choice") raw(chunk("resp", [{ index: 0 }, { index: 1 }]));
    if (mode === "null intermediate") raw(chunk("resp", [], null));
    if (mode === "same chunk conflict")
      raw(
        chunk("resp", [{ index: 0, delta: {}, finish_reason: "stop", usage: { completion_tokens: 9 } }], {
          completion_tokens: 10,
        }),
      );
    f.speed.delta(mode === "thinking" ? "thinking_delta" : "text_delta", "x", b);
    f.setTime(500);
    f.speed.delta("text_delta", "y", b);
    if (mode === "changed id") raw(chunk("other", [{ index: 0, delta: { content: "x" } }]));
    raw(
      chunk("resp", [
        {
          index: 0,
          delta: {},
          finish_reason: mode === "tool round" ? "tool_calls" : mode === "unknown finish" ? "content_filter" : "stop",
          ...(mode === "choice usage" ? { usage: { completion_tokens: 10 } } : {}),
        },
      ]),
    );
    if (mode !== "missing usage" && mode !== "choice usage")
      raw(
        chunk(
          "resp",
          [],
          mode === "null usage" ? null : { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 } },
        ),
      );
    if (mode === "conflicting usage") raw(chunk("resp", [], { completion_tokens: 9 }));
    if (mode === "tail delta") raw(chunk("resp", [{ index: 0, delta: { content: "late" } }]));
    const positive = ["positive", "choice usage", "reasoning", "thinking", "null intermediate", "tool round"].includes(
      mode,
    );
    const events: Array<{ type: string; message?: unknown }> = [];
    const end = vi.spyOn(f.speed, "end");
    const tap = createEventTap((e) => events.push(e), { speed: f.speed, setTimer: () => ({ cancel() {} }) });
    tap.handle({ type: "message_end", message });
    f.event("turn_end", { message, turnIndex: 0, messageEntryId: "mid" });
    expect(end).toHaveBeenCalledTimes(1);
    if (positive) {
      expect(end).toHaveReturnedWith(core);
      expect(f.append).toHaveBeenCalledTimes(1);
    } else expectHidden(events, end.mock.results.at(-1)?.value, f.append.mock.calls.length);
    tap.dispose();
  });
});

describe("P1 rework: hostile boundaries and terminal ordering", () => {
  it.each([
    "choices accessor",
    "second start",
    "error delta",
    "abort delta",
    "responses late done",
    "responses anonymous tail",
  ])("%s hides end, live and append", (mode) => {
    const f = fixture();
    const events: Array<Record<string, unknown>> = [];
    const end = vi.spyOn(f.speed, "end");
    const tap = createEventTap((e) => events.push(e as unknown as Record<string, unknown>), {
      speed: f.speed,
      now: () => 0,
      setTimer: () => ({ cancel() {} }),
    });
    const chat = mode === "choices accessor" || mode === "second start";
    const b = chat ? { ...binding, api: "openai-completions" } : binding;
    const message = { ...f.message, ...b, stopReason: "stop" };
    const raw = (data: unknown) => f.speed.raw({ provider: b.provider, api: b.api, model: b.model, data });
    tap.handle({ type: "agent_start" });
    tap.handle({ type: "turn_start", turnIndex: 0 });
    tap.handle({ type: "message_start", message });
    let getterCalls = 0;
    if (chat) {
      const choices = [{ index: 0, delta: {}, finish_reason: "stop" }];
      if (mode === "choices accessor")
        Object.defineProperty(choices, "0", {
          get() {
            getterCalls++;
            return { index: 0, delta: {}, finish_reason: "stop" };
          },
        });
      raw({ id: "resp", choices, usage: { completion_tokens: 10 } });
    }
    if (mode === "second start") tap.handle({ type: "message_start", message });
    const update = (kind: string) =>
      tap.handle({ type: "message_update", assistantMessageEvent: { type: kind, contentIndex: 0, delta: "x" } }, b);
    update("text_delta");
    f.setTime(500);
    update("text_delta");
    if (mode === "error delta") update("error");
    if (mode === "abort delta") update("aborted");
    if (!chat) {
      f.speed.raw(completed());
      if (mode === "responses late done") raw({ type: "response.output_text.done", response_id: "resp", text: "late" });
      if (mode === "responses anonymous tail") raw({ type: "response.output_text.delta", delta: "late" });
    }
    tap.handle({ type: "message_end", message });
    tap.handle({ type: "turn_end", message, turnIndex: 0, messageEntryId: "mid" });
    expect(end).toHaveBeenCalledTimes(1);
    expectHidden(events, end.mock.results.at(-1)?.value, f.append.mock.calls.length);
    expect(getterCalls).toBe(0);
    tap.dispose();
  });
  it("counts normalized deltas queued before raw completion but consumed afterward", () => {
    const f = fixture();
    f.start();
    f.delta();
    // The provider produced this delta before completion; its normalized delivery is queued.
    f.speed.raw({ ...binding, data: { type: "response.output_text.delta", response_id: "resp", delta: "b" } });
    f.speed.raw(completed());
    f.setTime(500);
    f.delta();
    expect(f.speed.end(f.message)).toEqual(core);
    f.finish();
    expect(f.append).toHaveBeenCalledTimes(1);
  });
  it("joins raw-first chat terminal only to its exact binding; independent warmer invalidates", () => {
    for (const warmer of [false, true]) {
      const f = fixture();
      const b = { ...binding, api: "openai-completions" };
      const message = { ...f.message, ...b, stopReason: "stop" };
      f.event("agent_start");
      f.event("turn_start", { turnIndex: 0 });
      const raw = (id: string) =>
        f.speed.raw({
          ...b,
          data: { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 10 } },
        });
      raw("resp");
      if (warmer) raw("warmer");
      f.event("message_start", { message });
      f.speed.delta("text_delta", "a", b);
      f.setTime(500);
      f.speed.delta("text_delta", "b", b);
      const events: Array<{ type: string; message?: unknown }> = [];
      const end = vi.spyOn(f.speed, "end");
      const tap = createEventTap((e) => events.push(e), { speed: f.speed, setTimer: () => ({ cancel() {} }) });
      tap.handle({ type: "message_end", message });
      f.event("turn_end", { message, turnIndex: 0, messageEntryId: "mid" });
      expect(end).toHaveBeenCalledTimes(1);
      if (warmer) expectHidden(events, end.mock.results.at(-1)?.value, f.append.mock.calls.length);
      else {
        expect(end).toHaveReturnedWith(core);
        expect(f.append).toHaveBeenCalledTimes(1);
      }
      tap.dispose();
    }
  });
});

describe("P2 anthropic unique lane", () => {
  it.each([
    "positive",
    "no stop",
    "raw first",
    "thinking",
    "tool",
    "duplicate",
    "other start",
    "bare terminal",
    "bare stop",
    "stop first",
    "late delta",
    "after terminal",
    "missing usage",
    "null usage",
    "mismatch",
    "late binding",
    "id mismatch",
    "external",
    "overlap",
    "getter",
    "owner before start",
  ])("%s", (mode) => {
    const f = fixture();
    const b = { ...binding, api: "anthropic-messages" };
    const message = {
      ...f.message,
      ...b,
      stopReason: mode === "tool" ? "toolUse" : "stop",
      content: [{ type: mode === "tool" ? "toolCall" : "text", text: "x" }],
      usage: { output: mode === "mismatch" ? 9 : 10 },
    };
    const raw = (data: unknown) => f.speed.raw({ ...b, data });
    const start = (id = "resp") => raw({ type: "message_start", message: { id } });
    const terminal = (usage: unknown = { output_tokens: 10 }) =>
      raw({ type: "message_delta", delta: { stop_reason: mode === "tool" ? "tool_use" : "end_turn" }, usage });
    const stop = () => raw({ type: "message_stop" });
    const external = mode === "external" || mode === "overlap";
    f.event("agent_start");
    if (external) {
      start("external");
      terminal();
      if (mode === "external") stop();
    }
    if (mode === "bare terminal") terminal();
    if (mode === "bare stop") stop();
    f.event("turn_start", { turnIndex: 0 });
    if (mode === "raw first") start();
    if (mode === "owner before start") f.setOwner({ ...f.owner(), ownerToken: {} });
    f.event("message_start", { message });
    if (mode !== "raw first") start(mode === "id mismatch" ? "other" : "resp");
    if (mode === "duplicate") start();
    if (mode === "other start") {
      start("other");
      start();
    }
    if (mode === "stop first") stop();
    if (mode === "getter") {
      let calls = 0;
      raw({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: Object.defineProperty({}, "output_tokens", {
          get() {
            calls++;
            return 10;
          },
        }),
      });
      expect(calls).toBe(0);
    }
    f.speed.delta(
      mode === "thinking" ? "thinking_delta" : mode === "tool" ? "toolcall_delta" : "text_delta",
      "a",
      mode === "late binding" ? undefined : b,
    );
    f.setTime(500);
    f.speed.delta(mode === "tool" ? "toolcall_delta" : "text_delta", "b", b);
    if (mode === "missing usage") raw({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    else terminal(mode === "null usage" ? null : undefined);
    if (mode === "after terminal")
      raw({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "late" } });
    if (mode !== "no stop") stop();
    if (mode === "late delta") raw({ type: "content_block_delta", delta: { type: "text_delta", text: "late" } });
    const events: Array<{ type: string; message?: unknown }> = [];
    const end = vi.spyOn(f.speed, "end");
    const tap = createEventTap((e) => events.push(e), { speed: f.speed, setTimer: () => ({ cancel() {} }) });
    tap.handle({ type: "message_end", message });
    f.event("turn_end", { message, turnIndex: 0, messageEntryId: "mid" });
    if (["positive", "no stop", "raw first", "thinking", "tool", "external"].includes(mode)) {
      expect(end).toHaveReturnedWith(core);
      expect(f.append).toHaveBeenCalledTimes(1);
    } else expectHidden(events, end.mock.results.at(-1)?.value, f.append.mock.calls.length);
    tap.dispose();
  });
});

it("P2 external natural close permits B and C; overlap permanently hides subsequent turns", () => {
  for (const overlap of [false, true]) {
    const f = fixture();
    const b = { ...binding, api: "anthropic-messages" };
    const raw = (data: unknown) => f.speed.raw({ ...b, data });
    const start = (id: string) => raw({ type: "message_start", message: { id } });
    const terminal = () =>
      raw({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } });
    const stop = () => raw({ type: "message_stop" });
    f.event("agent_start");
    start("external");
    terminal();
    if (!overlap) stop();
    for (let i = 0; i < 2; i++) {
      const id = `main${i}`;
      const message = { ...f.message, ...b, responseId: id, stopReason: "stop" };
      f.event("turn_start", { turnIndex: i });
      if (overlap && i === 0) stop();
      f.event("message_start", { message });
      start(id);
      f.setTime(i * 1000);
      f.speed.delta("text_delta", "a", { ...b, responseId: id });
      f.setTime(i * 1000 + 500);
      f.speed.delta("text_delta", "b", { ...b, responseId: id });
      terminal();
      stop();
      const events: Array<{ type: string; message?: unknown }> = [];
      const end = vi.spyOn(f.speed, "end");
      const tap = createEventTap((e) => events.push(e), { speed: f.speed, setTimer: () => ({ cancel() {} }) });
      tap.handle({ type: "message_end", message });
      f.event("turn_end", { turnIndex: i, message, messageEntryId: `mid${i}` });
      if (overlap) expectHidden(events, end.mock.results.at(-1)?.value, f.append.mock.calls.length);
      else {
        expect(end).toHaveReturnedWith(core);
        expect(f.append).toHaveBeenCalledTimes(i + 1);
      }
      end.mockRestore();
    }
  }
});

describe("Responses raw-first candidate", () => {
  it.each(["matching", "no binding", "mismatch", "second created"])("%s joins only exact turn candidate", (mode) => {
    const f = fixture();
    f.event("agent_start");
    f.event("turn_start", { turnIndex: 0 });
    const created = (id: string) => ({ ...binding, data: { type: "response.created", response: { id } } });
    f.speed.raw(created("resp"));
    if (mode === "second created") f.speed.raw(created("other"));
    f.speed.raw(completed());
    f.event("message_start", { message: f.message });
    if (mode !== "no binding") {
      const b = mode === "mismatch" ? { ...binding, responseId: "other" } : binding;
      f.delta("text_delta", b);
      f.setTime(500);
      f.delta("text_delta", b);
    }
    const result = f.speed.end(f.message);
    f.finish();
    if (mode === "matching") {
      expect(result).toEqual(core);
      expect(f.append).toHaveBeenCalledWith("subagent:web-msg-speed", { piToolkitGeneration: { ...core, mid: "mid" } });
    } else {
      expect(result).toBeUndefined();
      expect(f.append).not.toHaveBeenCalled();
    }
  });
});

it("Responses accepts matching created after binding without accepting a second created", () => {
  const f = fixture();
  f.start();
  f.delta();
  f.speed.raw({ ...binding, data: { type: "response.created", response: { id: "resp" } } });
  f.setTime(500);
  f.delta();
  f.speed.raw(completed());
  expect(f.speed.end(f.message)).toEqual(core);
  f.finish();
  expect(f.append).toHaveBeenCalledTimes(1);
});

describe("Responses strict terminal and candidate regressions", () => {
  it.each(["missing", "inherited", "accessor"])("raw-first created %s id cannot use response_id fallback", (mode) => {
    const f = fixture();
    const getter = vi.fn(() => "resp");
    const response = mode === "inherited" ? Object.create({ id: "resp" }) : {};
    if (mode === "accessor") Object.defineProperty(response, "id", { get: getter });
    f.event("agent_start");
    f.event("turn_start", { turnIndex: 0 });
    f.speed.raw({ ...binding, data: { type: "response.created", response, response_id: "resp" } });
    f.speed.raw(completed()); // deliberately before public message_start and binding
    f.event("message_start", { message: f.message });
    f.delta();
    f.setTime(500);
    f.delta();
    const events: Array<{ type: string; message?: unknown }> = [];
    const end = vi.spyOn(f.speed, "end");
    const tap = createEventTap((e) => events.push(e), { speed: f.speed, setTimer: () => ({ cancel() {} }) });
    tap.handle({ type: "message_end", message: f.message });
    f.finish();
    expectHidden(events, end.mock.results.at(-1)?.value, f.append.mock.calls.length);
    expect(getter).not.toHaveBeenCalled();
    tap.dispose();
  });
  it.each(["missing", "pending", "unknown", "inherited", "accessor"])(
    "final %s stopReason hides all surfaces",
    (mode) => {
      const f = fixture();
      f.start();
      f.generate();
      const getter = vi.fn(() => "stop");
      const { stopReason: _stop, ...rest } = f.message;
      const message = mode === "inherited" ? Object.assign(Object.create({ stopReason: "stop" }), rest) : rest;
      if (mode === "pending" || mode === "unknown") message.stopReason = mode;
      if (mode === "accessor") Object.defineProperty(message, "stopReason", { get: getter });
      const events: Array<{ type: string; message?: unknown }> = [];
      const end = vi.spyOn(f.speed, "end");
      const tap = createEventTap((e) => events.push(e), { speed: f.speed, setTimer: () => ({ cancel() {} }) });
      tap.handle({ type: "message_end", message });
      f.finish({ message });
      expectHidden(events, end.mock.results.at(-1)?.value, f.append.mock.calls.length);
      expect(getter).not.toHaveBeenCalled();
      tap.dispose();
    },
  );
  it.each(["response.incomplete", "response.failed", "error", "response.error"])(
    "attributed %s cannot be cleansed by completed",
    (type) => {
      const f = fixture();
      f.start();
      f.delta();
      f.speed.raw({ ...binding, data: { type, response_id: "resp" } });
      f.setTime(500);
      f.delta();
      f.speed.raw(completed());
      const events: Array<{ type: string; message?: unknown }> = [];
      const end = vi.spyOn(f.speed, "end");
      const tap = createEventTap((e) => events.push(e), { speed: f.speed, setTimer: () => ({ cancel() {} }) });
      tap.handle({ type: "message_end", message: f.message });
      f.finish();
      expectHidden(events, end.mock.results.at(-1)?.value, f.append.mock.calls.length);
      tap.dispose();
    },
  );
});
