import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createReleaseQueue, type ReleaseItem, type ReleaseQueueDeps } from "../../src/topic-switch/release.js";
import type { HeldPayload } from "../../src/topic-switch/types.js";
import type { WebPromptRelease } from "../../src/web-hub/agent/prompt-gate.js";

function payload(text: string): HeldPayload {
  return { text, digest: "d".repeat(64) };
}

/** A deps bundle that records every send, with switchable compacting/barrier behavior. */
function makeDeps(over: Partial<ReleaseQueueDeps> = {}) {
  const sent: Array<{ text: string; deliverAs: "steer" | "followUp" }> = [];
  const drainLog: boolean[] = [];
  const clock = new FakeClock();
  let barrierResolvers: Array<() => void> = [];
  const deps: ReleaseQueueDeps = {
    sendUserMessage: (content, deliverAs) => {
      const text = content.find((b): b is { type: "text"; text: string } => b.type === "text")?.text ?? "";
      sent.push({ text, deliverAs });
    },
    isCompacting: () => false,
    waitCompactSettled: () => Promise.resolve(),
    waitBarrier: (ms) =>
      new Promise((resolve) => {
        barrierResolvers.push(resolve);
        clock.setTimer(ms, resolve);
      }),
    clock,
    onDrainChange: (v) => drainLog.push(v),
    ...over,
  };
  return {
    deps,
    sent,
    drainLog,
    clock,
    resolveBarrier: () => {
      const rs = barrierResolvers;
      barrierResolvers = [];
      for (const r of rs) r();
    },
  };
}

function fakeWebRelease(outcome: "dispatched" | "refused"): { release: WebPromptRelease; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    release: {
      current: () => {
        calls.push("current");
        return outcome;
      },
      elsewhere: () => calls.push("elsewhere"),
    },
  };
}

describe("release queue: ordering", () => {
  it("delivers items strictly in enqueue order (held first, newcomers after)", async () => {
    const { deps, sent, resolveBarrier } = makeDeps();
    const queue = createReleaseQueue(deps);
    queue.enqueue({ kind: "content", payload: payload("held"), deliverAs: "followUp" });
    queue.enqueue({ kind: "content", payload: payload("newcomer-1"), deliverAs: "followUp" });
    queue.enqueue({ kind: "content", payload: payload("newcomer-2"), deliverAs: "steer" });
    await flush();
    resolveBarrier();
    await flush();
    resolveBarrier();
    await flush();
    resolveBarrier();
    await flush();
    expect(sent.map((s) => s.text)).toEqual(["held", "newcomer-1", "newcomer-2"]);
    expect(sent[2]!.deliverAs).toBe("steer");
  });

  it("a barrier timeout (2s) still moves on to the next item — never hangs", async () => {
    const { deps, sent, clock } = makeDeps();
    const queue = createReleaseQueue(deps);
    queue.enqueue({ kind: "content", payload: payload("a"), deliverAs: "followUp" });
    queue.enqueue({ kind: "content", payload: payload("b"), deliverAs: "followUp" });
    await flush();
    clock.advance(2_000); // barrier timeout for item "a"
    await flush();
    clock.advance(2_000); // barrier timeout for item "b"
    await flush();
    expect(sent.map((s) => s.text)).toEqual(["a", "b"]);
  });
});

describe("release queue: web refused ⇒ content fallback exactly once (P4 finding c)", () => {
  it("delivers via sendUserMessage when release.current() returns 'refused'", async () => {
    const { deps, sent, resolveBarrier } = makeDeps();
    const { release, calls } = fakeWebRelease("refused");
    const queue = createReleaseQueue(deps);
    queue.enqueue({ kind: "web", payload: payload("web text"), release });
    await flush();
    resolveBarrier();
    await flush();
    expect(calls).toEqual(["current"]); // release.current() called exactly once
    expect(sent).toEqual([{ text: "web text", deliverAs: "followUp" }]); // fallback, exactly once
  });

  it("does NOT fall back to content when release.current() succeeds", async () => {
    const { deps, sent, resolveBarrier } = makeDeps();
    const { release, calls } = fakeWebRelease("dispatched");
    const queue = createReleaseQueue(deps);
    queue.enqueue({ kind: "web", payload: payload("web text"), release });
    await flush();
    resolveBarrier();
    await flush();
    expect(calls).toEqual(["current"]);
    expect(sent).toEqual([]);
  });

  it("a throwing release.current() is treated the same as 'refused' (fail-open)", async () => {
    const { deps, sent, resolveBarrier } = makeDeps();
    const release: WebPromptRelease = {
      current: () => {
        throw new Error("boom");
      },
      elsewhere: () => {},
    };
    const queue = createReleaseQueue(deps);
    queue.enqueue({ kind: "web", payload: payload("x"), release });
    await flush();
    resolveBarrier();
    await flush();
    expect(sent).toEqual([{ text: "x", deliverAs: "followUp" }]);
  });
});

describe("release queue: compaction wait", () => {
  it("waits for compaction to settle before delivering the next item", async () => {
    const order: string[] = [];
    let compactSettled: (() => void) | undefined;
    const { deps, sent, resolveBarrier } = makeDeps({
      isCompacting: () => true,
      waitCompactSettled: () =>
        new Promise((resolve) => {
          compactSettled = () => {
            order.push("compact-settled");
            resolve();
          };
        }),
    });
    const queue = createReleaseQueue(deps);
    queue.enqueue({ kind: "content", payload: payload("held"), deliverAs: "followUp" });
    await flush();
    expect(sent).toEqual([]); // blocked on compaction
    compactSettled?.();
    await flush();
    resolveBarrier();
    await flush();
    expect(order).toEqual(["compact-settled"]);
    expect(sent).toEqual([{ text: "held", deliverAs: "followUp" }]);
  });

  it("a compaction wait that never resolves is bounded by the 120s timeout (zero-hang)", async () => {
    const { deps, sent, clock, resolveBarrier } = makeDeps({
      isCompacting: () => true,
      waitCompactSettled: (ms) => new Promise((resolve) => clock.setTimer(ms, resolve)), // only the timeout ever fires
    });
    const queue = createReleaseQueue(deps);
    queue.enqueue({ kind: "content", payload: payload("held"), deliverAs: "followUp" });
    await flush();
    clock.advance(120_000);
    await flush();
    resolveBarrier();
    await flush();
    expect(sent).toEqual([{ text: "held", deliverAs: "followUp" }]);
  });
});

describe("release queue: draining gate", () => {
  it("draining flips true on the first enqueue and false once the queue empties", async () => {
    const { deps, drainLog, resolveBarrier } = makeDeps();
    const queue = createReleaseQueue(deps);
    expect(queue.draining).toBe(false);
    queue.enqueue({ kind: "content", payload: payload("a"), deliverAs: "followUp" });
    await flush();
    expect(queue.draining).toBe(true);
    resolveBarrier();
    await flush();
    expect(queue.draining).toBe(false);
    expect(drainLog).toEqual([true, false]);
  });

  it("a newcomer enqueued mid-drain keeps draining true until IT also finishes", async () => {
    const { deps, sent, resolveBarrier } = makeDeps();
    const queue = createReleaseQueue(deps);
    queue.enqueue({ kind: "content", payload: payload("a"), deliverAs: "followUp" });
    await flush();
    expect(queue.draining).toBe(true);
    queue.enqueue({ kind: "content", payload: payload("b"), deliverAs: "followUp" }); // mid-drain newcomer
    resolveBarrier(); // lets "a" finish its barrier
    await flush();
    expect(queue.draining).toBe(true); // "b" still pending
    resolveBarrier();
    await flush();
    expect(queue.draining).toBe(false);
    expect(sent.map((s) => s.text)).toEqual(["a", "b"]);
  });
});

describe("release queue: delivery failures never stall the queue", () => {
  it("a throwing sendUserMessage for item 1 still lets item 2 deliver", async () => {
    let calls = 0;
    const { deps, resolveBarrier } = makeDeps({
      sendUserMessage: () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
    });
    const sentOk: string[] = [];
    deps.sendUserMessage = (content, deliverAs) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      sentOk.push(deliverAs);
    };
    const queue = createReleaseQueue(deps);
    queue.enqueue({ kind: "content", payload: payload("a"), deliverAs: "followUp" });
    queue.enqueue({ kind: "content", payload: payload("b"), deliverAs: "followUp" });
    await flush();
    resolveBarrier();
    await flush();
    resolveBarrier();
    await flush();
    expect(sentOk).toEqual(["followUp"]);
  });
});

/** Let pending microtasks / already-resolved promises settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
