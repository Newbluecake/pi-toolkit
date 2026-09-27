import { describe, expect, it } from "vitest";
import { mountApp } from "../../../src/web-hub/web/app.js";
import { byClass, fakeDocument, FakeElement } from "./fake-dom.js";

class FakeES {
  static all: FakeES[] = [];
  readyState = 1;
  listeners = new Map<string, Array<(ev: any) => void>>();
  constructor(readonly url: string) {
    FakeES.all.push(this);
  }
  addEventListener(name: string, fn: (ev: any) => void) {
    const l = this.listeners.get(name) ?? [];
    l.push(fn);
    this.listeners.set(name, l);
  }
  emit(name: string, data: unknown) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data), lastEventId: "" });
  }
  close() {
    this.readyState = 2;
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup() {
  FakeES.all = [];
  const base = fakeDocument();
  const ids = ["app", "conn", "hub", "agents", "banner", "session-head", "fleet", "transcript"];
  const nodes = new Map<string, FakeElement>();
  for (const id of ids) {
    const n = new FakeElement("div") as FakeElement & { scrollTop: number; scrollHeight: number; clientHeight: number };
    n.scrollTop = 0;
    n.scrollHeight = 0;
    n.clientHeight = 0;
    nodes.set(id, n);
  }
  const doc = { ...base, getElementById: (id: string) => nodes.get(id) ?? null };
  const rafs: Array<() => void> = [];
  const posts: Array<{ url: string; body: any }> = [];
  const timeouts: Array<() => void> = [];
  // Real cancellation semantics (not the previous unconditional no-op `clearTimeout`/absent
  // `cancelAnimationFrame`): `timeouts`/`rafs` still hold plain callables at the same
  // indices/order existing tests already rely on (`.shift()`/`.slice()`), but each entry is a
  // thin wrapper that skips the real callback once its id has been cancelled — needed to prove a
  // disposed queueRender() actually left nothing runnable behind, not just that dispose() *called*
  // clearTimeout/cancelAnimationFrame.
  const timeoutCancelled = new Set<number>();
  const rafCancelled = new Set<number>();
  const cancelCalls = { timeout: 0, raf: 0 };
  let timeoutSeq = 0;
  let rafSeq = 0;
  const win = {
    fetch: async (url: string, init: any) => {
      posts.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 200, json: async () => ({}) };
    },
    EventSource: FakeES,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState: () => {} },
    setTimeout: (fn: () => void) => {
      const id = ++timeoutSeq;
      timeouts.push(() => {
        if (!timeoutCancelled.has(id)) fn();
      });
      return id;
    },
    clearTimeout: (id: number) => {
      cancelCalls.timeout++;
      timeoutCancelled.add(id);
    },
    requestAnimationFrame: (fn: () => void) => {
      const id = ++rafSeq;
      rafs.push(() => {
        if (!rafCancelled.has(id)) fn();
      });
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      cancelCalls.raf++;
      rafCancelled.add(id);
    },
    addEventListener: () => {},
  };
  const app = mountApp(win, doc as any);
  const paint = () => {
    while (rafs.length) rafs.shift()!();
  };
  return {
    app,
    nodes,
    posts,
    paint,
    timers: { rafs, timeouts, cancelCalls },
  };
}

const card = (agentKey: string, cwd: string) => ({
  agentKey,
  kind: "tui",
  pid: 1,
  cwd,
  state: "live",
  pluginVersion: "1",
  outdated: false,
  session: { sessionId: `s-${agentKey}`, cwd, reason: "startup", leafId: null, mode: "tui" },
  prompts: [{ kind: "custom", since: 1 }],
});

describe("mountApp wiring", () => {
  it("hello+agents ⇒ subscribe selected; history renders; select switches subscription", async () => {
    const { app, nodes, posts, paint } = setup();
    await flush();
    const es = FakeES.all[0]!;
    es.emit("hello", { clientId: "c1" });
    es.emit("agents", { agents: [card("A", "/p/one"), card("B", "/p/two")] }); // real hub wire form
    await flush();
    expect(posts).toEqual([{ url: "/api/subscribe", body: { clientId: "c1", agentKey: "A" } }]);
    es.emit("history", {
      agentKey: "A",
      entries: [
        {
          id: "e1",
          parentId: null,
          type: "message",
          timestamp: "t",
          message: { role: "user", content: "hello <b>", timestamp: 1 },
        },
      ],
      tailMessages: [],
      fromSeq: 1,
      hasMore: false,
      source: "file",
    });
    paint();
    expect(nodes.get("conn")!.textContent).toBe("open");
    expect(byClass(nodes.get("agents")!, "agent-card")).toHaveLength(2);
    expect(nodes.get("transcript")!.textContent).toContain("hello <b>");
    expect(nodes.get("banner")!.textContent).toBe("blocked on dialog (custom)");

    byClass(nodes.get("agents")!, "agent-card")[1]!.dispatch("click");
    await flush();
    expect(posts.slice(1)).toEqual([
      { url: "/api/unsubscribe", body: { clientId: "c1", agentKey: "A" } },
      { url: "/api/subscribe", body: { clientId: "c1", agentKey: "B" } },
    ]);
    expect(app.getState().selected).toBe("B");
    expect(app.getState().agents.get("A")!.history).toBe("none");
    app.client.close();
  });

  it("gap on the selected agent triggers exactly one re-subscribe (rate-limited)", async () => {
    const { app, posts } = setup();
    await flush();
    const es = FakeES.all[0]!;
    es.emit("hello", { clientId: "c1" });
    es.emit("agents", [card("A", "/p/one")]); // legacy bare-array form stays accepted
    await flush();
    es.emit("history", { agentKey: "A", entries: [], tailMessages: [], fromSeq: 1, hasMore: false, source: "file" });
    es.emit("gap", { agentKey: "A", fromSeq: 3 });
    es.emit("gap", { agentKey: "A", fromSeq: 4 });
    await flush();
    // second subscribe is deferred by the 2s resync rate limit (timer queued, not fired)
    expect(posts.filter((p) => p.url === "/api/subscribe")).toHaveLength(1);
    expect(app.getState().agents.get("A")!.needsResync).toBe(true);
    app.client.close();
  });

  it("render fallback: a click's re-render still lands even if requestAnimationFrame never fires (hidden/backgrounded tab, plan §regression 2026-09-27)", async () => {
    const { app, nodes, posts, timers } = setup();
    await flush();
    const es = FakeES.all[0]!;
    es.emit("hello", { clientId: "c1" });
    es.emit("agents", { agents: [card("A", "/p/one"), card("B", "/p/two")] });
    await flush();
    es.emit("history", { agentKey: "A", entries: [], tailMessages: [], fromSeq: 1, hasMore: false, source: "file" });
    // Settle the initial render the normal way (paint drains requestAnimationFrame) so we start
    // from a known-good state before simulating the hidden-tab condition.
    while (timers.rafs.length) timers.rafs.shift()!();
    await flush();
    expect(nodes.get("session-head")!.textContent).toContain("s-A");

    // Click the second agent card. This dispatches `select` synchronously (network calls fire,
    // same as the real bug report's /api/unsubscribe 200 + /api/subscribe 202), which schedules a
    // re-render via both requestAnimationFrame AND the bounded setTimeout fallback.
    const timeoutsBeforeClick = timers.timeouts.length;
    byClass(nodes.get("agents")!, "agent-card")[1]!.dispatch("click");
    await flush();
    expect(posts.slice(-2)).toEqual([
      { url: "/api/unsubscribe", body: { clientId: "c1", agentKey: "A" } },
      { url: "/api/subscribe", body: { clientId: "c1", agentKey: "B" } },
    ]);
    // The reducer state already flipped (proves the click was handled) ...
    expect(app.getState().selected).toBe("B");
    // ... but the DOM must NOT have caught up yet: rAF was never drained (simulating a
    // hidden/backgrounded tab, where Chromium suspends requestAnimationFrame indefinitely) and
    // the fallback timer hasn't fired yet either.
    expect(nodes.get("session-head")!.textContent).toContain("s-A");

    // Fire every timer newly scheduled since the click (the click's own render fallback, plus
    // each fetch call's REQUEST_TIMEOUT_MS deadline timer — firing an already-settled fetch's
    // deadline is a documented no-op) instead of the never-firing rAF. Which of these is the
    // render fallback is an implementation detail; draining all of them is robust to it.
    const scheduled = timers.timeouts.slice(timeoutsBeforeClick);
    expect(scheduled.length).toBeGreaterThan(0);
    for (const fn of scheduled) fn();
    expect(nodes.get("session-head")!.textContent).toContain("s-B");
    app.client.close();
  });

  it("dispose (client.close(), P1-1): a render queued before close never executes, and neither the rAF nor the fallback timer is left runnable", async () => {
    const { app, nodes, posts, timers } = setup();
    await flush();
    const es = FakeES.all[0]!;
    es.emit("hello", { clientId: "c1" });
    es.emit("agents", { agents: [card("A", "/p/one"), card("B", "/p/two")] });
    await flush();
    es.emit("history", { agentKey: "A", entries: [], tailMessages: [], fromSeq: 1, hasMore: false, source: "file" });
    while (timers.rafs.length) timers.rafs.shift()!();
    await flush();
    expect(nodes.get("session-head")!.textContent).toContain("s-A");

    // Click B: queues a render (both a rAF and the RENDER_FALLBACK_MS setTimeout race for it),
    // exactly like the render-fallback test above, but this time close() fires before either one
    // ever runs — simulating an unload/unmount that lands squarely inside the race window.
    const rafsBeforeClick = timers.rafs.length;
    const timeoutsBeforeClick = timers.timeouts.length;
    byClass(nodes.get("agents")!, "agent-card")[1]!.dispatch("click");
    await flush();
    expect(posts.slice(-2)).toEqual([
      { url: "/api/unsubscribe", body: { clientId: "c1", agentKey: "A" } },
      { url: "/api/subscribe", body: { clientId: "c1", agentKey: "B" } },
    ]);
    expect(app.getState().selected).toBe("B");
    expect(timers.rafs.length).toBeGreaterThan(rafsBeforeClick);
    expect(timers.timeouts.length).toBeGreaterThan(timeoutsBeforeClick);

    app.client.close();

    // Draining every rAF/timeout scheduled since the click (the render's own rAF+fallback pair,
    // plus any fetch deadline timers) must not update the DOM: dispose() cancelled the pending
    // render before either callback could run, and each wrapper independently no-ops once
    // cancelled/disposed even though this harness's clearTimeout/cancelAnimationFrame are now real
    // (§P1-1 defense in depth — `run()` also re-checks `disposed`).
    for (const fn of timers.rafs.slice(rafsBeforeClick)) fn();
    for (const fn of timers.timeouts.slice(timeoutsBeforeClick)) fn();
    expect(nodes.get("session-head")!.textContent).toContain("s-A");

    // "无残留 timer": dispose() actually invoked the real cancellation APIs for both the rAF and
    // the fallback timer (not merely relying on the `run()` guard), so a real browser's task queue
    // would have nothing left to fire either.
    expect(timers.cancelCalls.raf).toBeGreaterThan(0);
    expect(timers.cancelCalls.timeout).toBeGreaterThan(0);
  });
});
