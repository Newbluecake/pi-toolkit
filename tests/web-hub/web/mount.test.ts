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
  const timers: Array<() => void> = [];
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
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    requestAnimationFrame: (fn: () => void) => rafs.push(fn),
    addEventListener: () => {},
  };
  const app = mountApp(win, doc as any);
  const paint = () => {
    while (rafs.length) rafs.shift()!();
  };
  return { app, nodes, posts, paint };
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
});
