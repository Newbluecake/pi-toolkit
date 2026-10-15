/**
 * todo-archive plan v2.1 §2/§3（D5 + B1 裁定，wiring）：`wireWebHub` + 假连接 ——
 * `hello_ack.caps ∋ todo.archive.v1` 决定 `completedHidden`/`archived` 是否上
 * `StatusInfo.todo`；换到带 cap 的新 hub ⇒ 指纹里的 cap 位翻转，下一个 1Hz tick 重新
 * 发布；B1：`deps.todo` 未注入（todo.enabled=false）时 status 帧与 snapshot_reply 都正常
 * 生成且不含 todo。纯投影语义（折叠、排除、四不变式）由 todo-projection.test.ts 钉住，
 * 这里只证装配。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import { TODO_ARCHIVE_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { Task, TodoState } from "../../../src/todo/state.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-ta-");
  resetGlobals();
  vi.useFakeTimers();
});
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  tmp.cleanup();
});

function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

function task(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    subject: `task ${id}`,
    description: `desc ${id}`,
    status: "pending",
    blocks: [],
    blockedBy: [],
    createdAt: id,
    updatedAt: id,
    ...over,
  };
}

/** 1 open + 5 completed (3 recent emitted, 2 folded) + 1 archived ⇒ completedHidden 2, archived 1. */
const archiveTodo = (): TodoState => ({
  tasks: [
    task(1, { subject: "open task" }),
    ...Array.from({ length: 5 }, (_, i) =>
      task(2 + i, { status: "completed", completedAt: 100 + i, updatedAt: 100 + i }),
    ),
    task(7, { status: "completed", completedAt: 50, archivedAt: 999, updatedAt: 50 }),
  ],
  nextId: 8,
});

type Sock = ReturnType<typeof fakeNet>["sockets"][number];

async function start(extra: Partial<WebHubDeps>, caps?: string[]): Promise<{ n: ReturnType<typeof fakeNet>; s: Sock }> {
  const n = fakeNet();
  const { pi, fire } = fakePi();
  wireWebHub(pi, deps({ netConnect: n.netConnect, ...extra }));
  const { ctx } = fakeCtx({ mode: "tui" });
  fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await vi.advanceTimersByTimeAsync(0);
  const s = n.sockets[0]!;
  s.emit("connect");
  await vi.advanceTimersByTimeAsync(0);
  s.hub(ackFrame("a1-todoarc", 4242, caps));
  await vi.advanceTimersByTimeAsync(0);
  return { n, s };
}

async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
  }
}

type TodoFrame = { todo?: { total?: number; completedHidden?: number; archived?: number; omitted?: number } };
const statusFrames = (s: Sock) => s.frames().filter((f) => f.t === "status") as TodoFrame[];
const lastTodo = (s: Sock) => statusFrames(s).at(-1)?.todo;

describe("todo.archive.v1 cap gating (todo-archive v2.1 §2, D5)", () => {
  it("hub WITHOUT the cap ⇒ completedHidden/archived never appear on any status frame", async () => {
    const { s } = await start({ todo: archiveTodo }, ["cmd.v1"]); // live, no todo.archive.v1
    await tick(3);
    const todo = lastTodo(s)!;
    expect(todo).toBeDefined();
    expect(todo.total).toBe(6); // archived #7 never counted
    expect(todo.omitted).toBe(2); // the legacy fold still rides `omitted`
    for (const f of statusFrames(s)) {
      expect(JSON.stringify(f.todo)).not.toContain("completedHidden");
      expect(JSON.stringify(f.todo)).not.toContain("archived");
    }
  });

  it("hub WITH the cap ⇒ completedHidden/archived ride the status frame", async () => {
    const { s } = await start({ todo: archiveTodo }, [TODO_ARCHIVE_HUB_CAP]);
    await tick(2);
    const todo = lastTodo(s)!;
    expect(todo.total).toBe(6);
    expect(todo.completedHidden).toBe(2); // 5 completed − 3 emitted recent rows
    expect(todo.archived).toBe(1);
    expect(todo.omitted).toBe(2);
  });

  it("cap appears on reconnect to a NEW hub ⇒ the fingerprint's cap bit flips and the next tick republishes", async () => {
    const { n, s } = await start({ todo: archiveTodo }, ["cmd.v1"]);
    await tick(1);
    expect(lastTodo(s)?.completedHidden).toBeUndefined(); // legacy first

    s.fail("ECONNRESET");
    await vi.advanceTimersByTimeAsync(700); // past connection.ts's 0.5s±20% backoff
    const s2 = n.sockets.at(-1)!;
    expect(s2).not.toBe(s);
    s2.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s2.hub(ackFrame("a1-todoarc", 4242, [TODO_ARCHIVE_HUB_CAP])); // upgraded hub
    await vi.advanceTimersByTimeAsync(0); // live ⇒ slot replay + one onStateChange publish
    const afterLive = statusFrames(s2).length;
    expect(lastTodo(s2)?.completedHidden).toBe(2); // the live publish already carries the cap
    // the fingerprint's cap bit ("|a1") differs from the pre-reconnect "|a0" even though the
    // state is unchanged ⇒ the NEXT 1Hz tick publishes one more frame (this is the flip proof —
    // without the bit in the fingerprint, ticks would stay silent here)
    await tick(1);
    expect(statusFrames(s2).length).toBeGreaterThan(afterLive);
    const todo = lastTodo(s2)!;
    expect(todo.completedHidden).toBe(2);
    expect(todo.archived).toBe(1);
  });

  it("cap disappears on reconnect ⇒ the projection folds back to the legacy shape", async () => {
    const { n, s } = await start({ todo: archiveTodo }, [TODO_ARCHIVE_HUB_CAP]);
    await tick(1);
    expect(lastTodo(s)?.completedHidden).toBe(2);

    s.fail("ECONNRESET");
    await vi.advanceTimersByTimeAsync(700);
    const s2 = n.sockets.at(-1)!;
    s2.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s2.hub(ackFrame("a1-todoarc", 4242, ["cmd.v1"])); // downgraded hub
    await tick(2);
    expect(lastTodo(s2)?.completedHidden).toBeUndefined();
    expect(lastTodo(s2)?.archived).toBeUndefined();
    expect(lastTodo(s2)?.omitted).toBe(2);
  });

  // B1 (v2.1 §8): `deps.todo!()` must never be called unconditionally — todo.enabled=false ⇒
  // the assembly never threads `deps.todo`, and BOTH readStatus call sites (status frame +
  // snapshot_reply) still generate fine without the todo slot.
  it("B1: no deps.todo (todo.enabled=false) ⇒ status frames AND snapshot_reply generate fine, without todo", async () => {
    const { s } = await start({}, [TODO_ARCHIVE_HUB_CAP]);
    await tick(2);
    expect(statusFrames(s).length).toBeGreaterThan(0);
    for (const f of statusFrames(s)) expect("todo" in f).toBe(false);

    const before = s.frames().length;
    s.hub({ t: "snapshot_req", rid: "r-b1" });
    await vi.advanceTimersByTimeAsync(0);
    const reply = s.frames().find((f) => f.t === "snapshot_reply" && f.rid === "r-b1");
    expect(reply).toBeDefined();
    expect(s.frames().length).toBeGreaterThan(before);
    expect("todo" in (reply as unknown as { status: Record<string, unknown> }).status).toBe(false);
  });

  it("with deps.todo: snapshot_reply.status carries the cap-gated todo projection too", async () => {
    const { s } = await start({ todo: archiveTodo }, [TODO_ARCHIVE_HUB_CAP]);
    await vi.advanceTimersByTimeAsync(0);
    s.hub({ t: "snapshot_req", rid: "r-1" });
    await vi.advanceTimersByTimeAsync(0);
    const reply = s
      .frames()
      .find((f) => f.t === "snapshot_reply" && (f as { rid?: string }).rid === "r-1") as unknown as {
      status: { todo?: { completedHidden?: number; archived?: number } };
    };
    expect(reply.status.todo?.completedHidden).toBe(2);
    expect(reply.status.todo?.archived).toBe(1);
  });

  it("no deps.todo ⇒ ticks add no todo-carrying frames (the gate is inert without the getter)", async () => {
    const { s } = await start({}, [TODO_ARCHIVE_HUB_CAP]);
    const afterLive = statusFrames(s).length;
    await tick(3);
    expect(statusFrames(s)).toHaveLength(afterLive);
  });
});
