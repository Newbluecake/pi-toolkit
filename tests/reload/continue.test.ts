import { afterEach, describe, expect, it } from "vitest";
import {
  completedReloadTurn,
  snapshotReloadTurn,
  consumeReloadContinue,
  needsReloadContinue,
  RELOAD_CONTINUE_TTL_MS,
  writeReloadContinue,
} from "../../src/reload/continue.js";

const KEY = Symbol.for("pi-subagent:reload-continue");
const g = globalThis as Record<symbol, unknown>;
const ctx = (sessionId = "s1", sessionFile: string | undefined = "/tmp/s1.jsonl") =>
  ({ sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } }) as never;

afterEach(() => delete g[KEY]);

describe("reload continuation marker (capacity 1, TTL 120s)", () => {
  it("writes exact session identity and consumes once within TTL", () => {
    writeReloadContinue(ctx(), 1_000);
    expect(g[KEY]).toEqual({ sessionId: "s1", sessionFile: "/tmp/s1.jsonl", createdAt: 1_000 });
    expect(consumeReloadContinue(ctx(), "reload", 1_001)).toBe(true);
    expect(g[KEY]).toBeUndefined();
    expect(consumeReloadContinue(ctx(), "reload", 1_002)).toBe(false);
  });

  it.each([RELOAD_CONTINUE_TTL_MS, RELOAD_CONTINUE_TTL_MS + 1, -1])("drops expired/future markers (age=%d)", (age) => {
    writeReloadContinue(ctx(), 1_000);
    expect(consumeReloadContinue(ctx(), "reload", 1_000 + age)).toBe(false);
    expect(g[KEY]).toBeUndefined();
  });

  it.each([
    ["s2", "/tmp/s1.jsonl"],
    ["s1", "/tmp/s2.jsonl"],
    ["s1", undefined],
  ])("drops session ID/file mismatches (%s, %s)", (sid, file) => {
    writeReloadContinue(ctx(), 1_000);
    const other = { sessionManager: { getSessionId: () => sid, getSessionFile: () => file } };
    expect(consumeReloadContinue(other as never, "reload", 1_001)).toBe(false);
    expect(consumeReloadContinue(ctx(), "reload", 1_002)).toBe(false);
  });

  it.each(["startup", "new", "resume", "fork"])("discards on non-reload start: %s", (reason) => {
    writeReloadContinue(ctx(), 1_000);
    expect(consumeReloadContinue(ctx(), reason, 1_001)).toBe(false);
    expect(g[KEY]).toBeUndefined();
  });

  it("overwrites the singleton and an old rollback cannot remove a newer handoff", () => {
    const rollback = writeReloadContinue(ctx(), 1_000);
    writeReloadContinue(ctx("s2", "/tmp/s2.jsonl"), 1_001);
    rollback();
    expect(consumeReloadContinue(ctx("s2", "/tmp/s2.jsonl"), "reload", 1_002)).toBe(true);
  });

  it("rollback removes its own failed handoff", () => {
    const rollback = writeReloadContinue(ctx(), 1_000);
    rollback();
    expect(g[KEY]).toBeUndefined();
  });

  it("hosts without a usable session identity do not retain markers", () => {
    writeReloadContinue(ctx(), 1_000);
    writeReloadContinue({} as never, 1_001);
    expect(g[KEY]).toBeUndefined();
    expect(consumeReloadContinue({} as never, "reload", 1_002)).toBe(false);
  });

  it.each([undefined, null, "bad", {}, { createdAt: NaN }])("ignores malformed marker %j", (value) => {
    g[KEY] = value;
    expect(consumeReloadContinue(ctx(), "reload", 1_000)).toBe(false);
    expect(g[KEY]).toBeUndefined();
  });
});

describe("needsContinue", () => {
  it.each([
    [false, true, false, false],
    [true, true, false, true],
    [false, false, false, true],
    [false, true, true, true],
    [true, false, true, true],
  ])("armStreaming=%s idle=%s queued=%s => %s", (armStreaming, idle, queued, expected) => {
    expect(needsReloadContinue(armStreaming, { isIdle: () => idle, hasPendingMessages: () => queued })).toBe(expected);
  });

  it("unavailable probes degrade to the saved first-arm snapshot", () => {
    expect(needsReloadContinue(false, {} as never)).toBe(false);
    expect(needsReloadContinue(true, {} as never)).toBe(true);
  });
});

describe("proof of natural normal completion", () => {
  const assistant = (id: string, stopReason = "stop") => ({
    type: "message",
    id,
    message: { role: "assistant", stopReason },
  });
  it.each([
    { tail: [assistant("new")], completed: true },
    { tail: [assistant("new"), { type: "custom", id: "metadata" }], completed: true },
    { tail: [assistant("new"), { type: "message", id: "notice", message: { role: "custom" } }], completed: true },
    { tail: [assistant("new"), { type: "message", id: "user", message: { role: "user" } }], completed: false },
    { tail: [assistant("new"), { type: "message", id: "tool", message: { role: "toolResult" } }], completed: false },
    { tail: [assistant("new", "toolUse")], completed: false },
    { tail: [assistant("new", "aborted")], completed: false },
    { tail: [assistant("new", "error")], completed: false },
    { tail: [], completed: false },
  ])("new stop proof: %j", ({ tail, completed }) => {
    const branch = [assistant("old")];
    const c = { sessionManager: { getBranch: () => branch } } as never;
    const before = snapshotReloadTurn(c);
    branch.push(...(tail as typeof branch));
    expect(completedReloadTurn(c, before)).toBe(completed);
  });

  it("supports a first-ever assistant response, but not unavailable history", () => {
    const branch: unknown[] = [];
    const c = { sessionManager: { getBranch: () => branch } } as never;
    const before = snapshotReloadTurn(c);
    branch.push(assistant("first"));
    expect(completedReloadTurn(c, before)).toBe(true);
    expect(completedReloadTurn(c, undefined)).toBe(false);
    expect(snapshotReloadTurn({} as never)).toBeUndefined();
    expect(completedReloadTurn({} as never, before)).toBe(false);
  });
});
