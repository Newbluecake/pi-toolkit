import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerDispositionSink,
  releaseDispositionSink,
  writeLateWorktreeDisposition,
  type LateWorktreeDisposition,
} from "../../src/adapters/worktree-disposition-sink.js";

const entry = (runId = "r1"): LateWorktreeDisposition => ({ runId, state: "kept", path: "/tmp/x", at: 0 });

// The sink lives on a Symbol.for holder shared across every test in this
// process — clean it up so tests don't leak into each other (mirrors the
// pattern documented for HOST_KEY / worktree-origin in AGENTS.md pitfalls).
afterEach(() => {
  const anyToken = {};
  registerDispositionSink(anyToken, () => undefined);
  releaseDispositionSink(anyToken);
});

describe("worktree-disposition-sink (workflow-worktree plan D13)", () => {
  it("routes a write to the currently registered sink", () => {
    const received: LateWorktreeDisposition[] = [];
    const token = {};
    registerDispositionSink(token, (e) => received.push(e));
    writeLateWorktreeDisposition(entry());
    expect(received).toEqual([entry()]);
  });

  it("warns (never throws) when no sink is registered", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => writeLateWorktreeDisposition(entry())).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("warns (never throws) when the registered write() itself throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const token = {};
    registerDispositionSink(token, () => {
      throw new Error("appendEntry failed");
    });
    expect(() => writeLateWorktreeDisposition(entry())).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("release is identity-checked: a stale token cannot evict a newer sink", () => {
    const received: LateWorktreeDisposition[] = [];
    const oldToken = {};
    const newToken = {};
    registerDispositionSink(oldToken, () => received.push(entry("stale-would-be-wrong")));
    registerDispositionSink(newToken, (e) => received.push(e));
    releaseDispositionSink(oldToken); // must NOT clear newToken's sink
    writeLateWorktreeDisposition(entry("via-new"));
    expect(received).toEqual([entry("via-new")]);
  });

  it("release is idempotent and a no-op once already released", () => {
    const token = {};
    registerDispositionSink(token, () => undefined);
    releaseDispositionSink(token);
    expect(() => releaseDispositionSink(token)).not.toThrow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeLateWorktreeDisposition(entry());
    expect(warn).toHaveBeenCalledTimes(1); // no sink after release
    warn.mockRestore();
  });

  it("shares the Symbol.for holder across module instances (simulates /reload re-registration)", () => {
    const received: LateWorktreeDisposition[] = [];
    const tokenA = {};
    registerDispositionSink(tokenA, () => received.push(entry("a")));
    const tokenB = {}; // a fresh stack's token after /reload, WITHOUT releasing tokenA first
    registerDispositionSink(tokenB, (e) => received.push(e));
    writeLateWorktreeDisposition(entry("via-b"));
    expect(received).toEqual([entry("via-b")]);
  });
});
