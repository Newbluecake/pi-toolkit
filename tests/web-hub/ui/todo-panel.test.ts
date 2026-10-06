// @vitest-environment happy-dom
/**
 * `TodoPanel.vue` + the status reducer's todo mirror (todo-web plan §4/D4, package T4).
 * Covers: the empty-state ruling (no todo wire / zero tasks ⇒ the whole section doesn't
 * render), the summary line counts, fold/unfold with `aria-expanded`, task rows (status
 * icon semantics, subject, description + truncation ellipsis, open-blocker label), the
 * `omitted` tail line, and `@logic/state.js`'s `AgentState.todo` mirror lifecycle
 * (agents frame → status frame → cleared when the wire omits `todo`).
 */
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import TodoPanel from "../../../src/web-hub/ui/src/components/detail/TodoPanel.vue";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import type { AgentState, TodoWire } from "../../../src/web-hub/ui/src/types.js";

const todoFixture = (over: Partial<TodoWire> = {}): TodoWire => ({
  tasks: [
    { id: 1, subject: "设计数据通道", status: "completed", blockedBy: [] },
    { id: 2, subject: "实现投影", status: "in_progress", blockedBy: [], description: "32 KiB 预算" },
    { id: 3, subject: "agent 接线", status: "pending", blockedBy: [2] },
    { id: 4, subject: "长描述任务", status: "pending", blockedBy: [], description: "abcdef", descTruncated: true },
  ],
  total: 8,
  counts: { open: 3, inProgress: 2, completed: 3, blocked: 1 },
  omitted: 4,
  updatedAt: 1_728_000_000_000,
  ...over,
});

describe("TodoPanel.vue (todo-web plan §4, T4)", () => {
  it("renders nothing when the task list is empty (空态拍板)", () => {
    const wrapper = mount(TodoPanel, { props: { todo: todoFixture({ tasks: [], omitted: undefined }) } });
    expect(wrapper.find(".todo-panel").exists()).toBe(false);
  });

  it("shows the summary line and starts collapsed", () => {
    const wrapper = mount(TodoPanel, { props: { todo: todoFixture() } });
    expect(wrapper.find(".todo-sum-text").text()).toBe("Tasks 8 · 3 done · 2 active");
    expect(wrapper.find(".todo-sum").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".todo-list").exists()).toBe(false);
    expect(wrapper.find(".todo-panel").attributes("aria-readonly")).toBe("true");
  });

  it("flags the blocked count on the summary row", () => {
    const wrapper = mount(TodoPanel, { props: { todo: todoFixture() } });
    expect(wrapper.find(".todo-sum-blocked").text()).toBe("1");
    const none = mount(TodoPanel, {
      props: { todo: todoFixture({ counts: { open: 3, inProgress: 2, completed: 3, blocked: 0 } }) },
    });
    expect(none.find(".todo-sum-blocked").exists()).toBe(false);
  });

  it("expands and collapses via the summary button (keyboard-reachable, aria-expanded)", async () => {
    const wrapper = mount(TodoPanel, { props: { todo: todoFixture() } });
    const button = wrapper.find(".todo-sum");
    await button.trigger("click");
    expect(button.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".todo-panel").attributes("data-open")).toBe("true");
    const items = wrapper.findAll(".todo-item");
    expect(items).toHaveLength(4);
    expect(items[0]?.attributes("data-status")).toBe("completed");
    expect(items[1]?.attributes("data-status")).toBe("in_progress");
    await button.trigger("click");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".todo-list").exists()).toBe(false);
  });

  it("renders subject, description (+truncation ellipsis), blocker label and the omitted tail", async () => {
    const wrapper = mount(TodoPanel, { props: { todo: todoFixture() } });
    await wrapper.find(".todo-sum").trigger("click");
    const items = wrapper.findAll(".todo-item");
    expect(items[0]?.find(".todo-subject").text()).toBe("设计数据通道");
    expect(items[1]?.find(".todo-desc").text()).toBe("32 KiB 预算");
    expect(items[2]?.find(".todo-blocked").text()).toBe("blocked by #2");
    expect(items[3]?.find(".todo-desc").text()).toBe("abcdef…");
    // description-less task renders no desc row at all
    expect(items[2]?.find(".todo-desc").exists()).toBe(false);
    expect(wrapper.find(".todo-more").text()).toBe("(+4 more)");
    // every row carries an sr-only status label (icons are aria-hidden)
    expect(items[1]?.find(".sr-only").text()).toBe("In progress");
  });

  it("omits the tail line when nothing was capped away", async () => {
    const wrapper = mount(TodoPanel, { props: { todo: todoFixture({ omitted: undefined }) } });
    await wrapper.find(".todo-sum").trigger("click");
    expect(wrapper.find(".todo-more").exists()).toBe(false);
  });

  it("renders no write-path controls (v1 read-only 拍板)", async () => {
    const wrapper = mount(TodoPanel, { props: { todo: todoFixture() } });
    await wrapper.find(".todo-sum").trigger("click");
    expect(wrapper.findAll(".todo-list button")).toHaveLength(0);
    expect(wrapper.findAll(".todo-list input")).toHaveLength(0);
  });
});

describe("DetailHeader todo mount (todo-web plan §4, T4)", () => {
  const agent = (todo: TodoWire | undefined): AgentState =>
    ({
      key: "agent-1",
      card: { agentKey: "agent-1", kind: "tui", pid: 1, cwd: "/tmp/p", state: "live" },
      down: false,
      session: { sessionId: "s1", cwd: "/tmp/p", mode: "tui" },
      status: { busy: false, pending: false },
      todo,
      prompts: [],
      fleet: [],
      items: [],
      uid: 0,
      lastSeq: 0,
      streaming: null,
      tools: [],
      history: "loaded",
      hasMore: false,
      paging: false,
      needsResync: false,
      sub: null,
    }) as unknown as AgentState;

  it("mounts the panel at the header bottom when the agent carries a todo wire", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(todoFixture()), narrow: false } });
    const panel = wrapper.find(".todo-panel");
    expect(panel.exists()).toBe(true);
    expect(wrapper.find(".todo-sum-text").text()).toBe("Tasks 8 · 3 done · 2 active");
    // mounted after the metrics block — the header's bottom
    const kids = wrapper.find(".detail-head").element.children;
    expect(kids[kids.length - 1]).toBe(panel.element);
  });

  it("renders no panel when the wire is absent (todo disabled / no tasks)", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(undefined), narrow: false } });
    expect(wrapper.find(".todo-panel").exists()).toBe(false);
  });
});

describe("state.js todo mirror (todo-web plan §4, T4)", () => {
  type Msg = { event: string; data: any; id?: number };
  const run = (msgs: Msg[]) => msgs.reduce((acc, m) => reduce(acc, m), initialState());
  const card = (status?: Record<string, unknown>) => ({
    agentKey: "A",
    kind: "tui",
    pid: 1,
    cwd: "/tmp/p",
    state: "live",
    session: { sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp/p", leafId: null, mode: "tui" },
    prompts: [],
    ...(status ? { status } : {}),
  });

  it("agents frame: card.status.todo lands on the agent", () => {
    const todo = todoFixture();
    const s = run([{ event: "agents", data: [card({ busy: false, pending: false, todo })] }]);
    expect(s.agents.get("A")?.todo).toEqual(todo);
  });

  it("status frame: sets, replaces, and clears (absent-means-cleared) the mirror", () => {
    const todo = todoFixture();
    let s = run([{ event: "agents", data: [card()] }]);
    expect(s.agents.get("A")?.todo).toBeUndefined();
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { busy: true, pending: false, todo } } });
    expect(s.agents.get("A")?.todo).toEqual(todo);
    // the wire omits `todo` once the last task is cleared ⇒ the mirror must clear too
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { busy: false, pending: false } } });
    expect(s.agents.get("A")?.todo).toBeUndefined();
  });

  it("agent_up with a stale card lacking status keeps the mirrored todo (status ?? fallback)", () => {
    const todo = todoFixture();
    let s = run([{ event: "agents", data: [card({ busy: false, pending: false, todo })] }]);
    s = reduce(s, { event: "agent_up", data: { agentKey: "A", kind: "tui", pid: 2, cwd: "/tmp/p", state: "live" } });
    expect(s.agents.get("A")?.todo).toEqual(todo);
  });

  it("ignores a malformed todo value (non-object / task-less)", () => {
    let s = run([{ event: "agents", data: [card({ busy: false, pending: false, todo: "nope" })] }]);
    expect(s.agents.get("A")?.todo).toBeUndefined();
    s = reduce(s, {
      event: "status",
      data: { agentKey: "A", status: { busy: false, pending: false, todo: { total: 3 } } },
    });
    expect(s.agents.get("A")?.todo).toBeUndefined();
  });
});
