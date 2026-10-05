// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import RunTranscript from "../../../src/web-hub/ui/src/components/drawer/RunTranscript.vue";
import RunHeader from "../../../src/web-hub/ui/src/components/drawer/RunHeader.vue";
import Transcript from "../../../src/web-hub/ui/src/components/transcript/Transcript.vue";
import { CONTROL_VIEW, HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { fleetActivity } from "../../../src/web-hub/ui/src/components/fleet/summary.js";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import type { HubHandle, RunTxState } from "../../../src/web-hub/ui/src/types.js";
import type { FleetRowWire } from "../../../src/web-hub/protocol/messages.js";

/**
 * `RunTranscript.vue` / `RunHeader.vue`(fleet-drawer plan v2 §6.3/§6.6 — F6):U7(两个
 * Transcript 并存且状态隔离)、U10(lastRow 回退 + 「不在列表中」)、U11(watching:false
 * 降级页脚与 FleetTree 行内摘要是同一个 `fleetActivity`),以及错误重试(⇒ selectRun 重选)、
 * 终态 chip、重连角标、CONTROL_VIEW null 覆盖(TxUser 的 web 徽标不出现)。
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// happy-dom 的 matchMedia 恒 false ⇒ AgentDetail 的抽屉模式恒为 overlay —— 正是这些用例要的。
type Msg = { event: string; data: unknown; id?: number };
const reduceAll = (msgs: Msg[], s = initialState()): ReturnType<typeof initialState> =>
  msgs.reduce((acc, m) => reduce(acc, m), s);

function card(agentKey: string): Record<string, unknown> {
  return {
    agentKey,
    kind: "tui",
    pid: 1,
    cwd: "/tmp/p",
    state: "live",
    pluginVersion: "1.0.0",
    outdated: false,
    runTranscript: true,
    prompts: [],
  };
}

const entry = (id: string, role: string, ts: number, text = `m-${id}`) => ({
  id,
  parentId: null,
  type: "message",
  timestamp: new Date(ts).toISOString(),
  message: { role, content: text, timestamp: ts },
});

function fleetRow(runId: string, extra: Record<string, unknown> = {}): FleetRowWire {
  return {
    runId,
    label: `label-${runId}`,
    type: "general",
    status: "running",
    phaseLabel: "working",
    elapsedMs: 1000,
    phaseMs: 0,
    highlight: "none",
    terminal: false,
    ...extra,
  } as FleetRowWire;
}

const RUN = "r_1";

interface AgentOpts {
  runEntries?: unknown[];
  fleet?: FleetRowWire[];
  live?: boolean;
  terminal?: boolean;
  hasMore?: boolean;
  runHasMore?: boolean;
  runError?: { error: string; reason?: string };
}

/** 造一个 agent:主会话 history loaded(一条 user 消息)+ fleet 一行 + 选中的 run 已订阅,
 * 视选项落一个 live/terminal/error 的 runTx 快照。 */
function agentState(opts: AgentOpts = {}) {
  const msgs: Msg[] = [
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("A")] },
    { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
    {
      event: "history",
      data: {
        agentKey: "A",
        entries: [entry("e0", "user", 1, "main-msg")],
        tailMessages: [],
        fromSeq: 1,
        hasMore: opts.hasMore ?? false,
      },
    },
    { event: "fleet", data: { agentKey: "A", runs: opts.fleet ?? [fleetRow(RUN, { streamLine: "reading files…" })] } },
    { event: "run_select", data: { agentKey: "A", runId: RUN } },
    { event: "run_subscribing", data: { agentKey: "A", runId: RUN, at: 100, retries: 0 } },
  ];
  if (opts.runError) {
    msgs.push({
      event: "run_history",
      data: {
        agentKey: "A",
        runId: RUN,
        error: opts.runError.error,
        ...(opts.runError.reason ? { reason: opts.runError.reason } : {}),
      },
    });
  } else {
    msgs.push({
      event: "run_history",
      data: {
        agentKey: "A",
        runId: RUN,
        entries: opts.runEntries ?? [entry("r1", "user", 1000, "run-msg")],
        tailMessages: [],
        tapId: "tap_1",
        fromSeq: 11,
        hasMore: opts.runHasMore ?? false,
        source: "live",
        terminal: opts.terminal ?? false,
        status: opts.terminal ? "completed" : "running",
        live: opts.live ?? true,
      },
    });
  }
  return reduceAll(msgs).agents.get("A")!;
}

function fakeHub(over: Partial<HubHandle> = {}): HubHandle {
  return {
    state: ref({ control: false }) as HubHandle["state"],
    selectRun: vi.fn(),
    pageRun: vi.fn(),
    dispatch: vi.fn(),
    ...over,
  } as HubHandle;
}

function mountDetail(agent: unknown, hub: HubHandle) {
  const wrapper = mount(AgentDetail, {
    props: { agent, now: 1_000, narrow: false },
    attachTo: document.body,
    global: { provide: { [HUB_CTX as symbol]: hub } },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("U7: 两个 Transcript 并存(§6.6/#16)", () => {
  it("DOM id 不重复;load-older 主区走 emit、抽屉走 pageRun;following 各自独立", async () => {
    const hub = fakeHub();
    const agent = agentState({ hasMore: true, runHasMore: true });
    const wrapper = mountDetail(agent, hub);

    // 两份实例、两个不同的锚点 id
    expect(document.querySelectorAll("#transcript").length).toBe(1);
    expect(document.querySelectorAll("#run-transcript").length).toBe(1);
    const transcripts = wrapper.findAllComponents(Transcript);
    expect(transcripts.length).toBe(2);
    expect(transcripts[0]!.props("anchorId")).toBe("transcript");
    expect(transcripts[1]!.props("anchorId")).toBe("run-transcript");
    // 内容各自独立(主区 main-msg,抽屉 run-msg)
    expect(transcripts[0]!.text()).toContain("main-msg");
    expect(transcripts[1]!.text()).toContain("run-msg");

    // 分页路由:主区冒泡成 AgentDetail 的 load-older,抽屉直达 hub.pageRun
    transcripts[0]!.vm.$emit("load-older");
    await nextTick();
    expect(wrapper.emitted("load-older")).toEqual([[]]);
    expect(hub.pageRun).not.toHaveBeenCalled();

    transcripts[1]!.vm.$emit("load-older");
    await nextTick();
    expect(hub.pageRun).toHaveBeenCalledWith("A");
    expect(wrapper.emitted("load-older")!.length).toBe(1); // 主区不再多发

    // following 独立:抽屉取关不影响主区
    transcripts[1]!.vm.$emit("update:following", false);
    await nextTick();
    expect(transcripts[0]!.props("following")).toBe(true);
    expect(document.querySelector("#fleet-drawer .run-tx-latest")).not.toBeNull(); // 抽屉自己的迷你按钮
  });
});

describe("U10: 被选中的 run 移出 rows(§6.3 lastRow 回退)", () => {
  it("头部用 lastRow 继续显示并带「不在列表中」标记,transcript 不中断", async () => {
    const hub = fakeHub();
    // run 先列出(快照捕获 lastRow),再被投影上限淘汰(fleet 帧不再携带)—— reducer 保留 lastRow
    const s1 = reduceAll([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      { event: "history", data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
      { event: "fleet", data: { agentKey: "A", runs: [fleetRow(RUN, { streamLine: "reading files…" })] } },
      { event: "run_select", data: { agentKey: "A", runId: RUN } },
      { event: "run_subscribing", data: { agentKey: "A", runId: RUN, at: 100, retries: 0 } },
      {
        event: "run_history",
        data: {
          agentKey: "A",
          runId: RUN,
          entries: [entry("r1", "user", 1000, "run-msg")],
          tailMessages: [],
          tapId: "tap_1",
          fromSeq: 11,
          hasMore: false,
          source: "live",
          terminal: false,
          status: "running",
          live: true,
        },
      },
      { event: "fleet", data: { agentKey: "A", runs: [] } }, // ← 移出 rows
    ]);
    const agent = s1.agents.get("A")!;
    expect((agent.runTx as RunTxState).lastRow?.runId).toBe(RUN); // reducer 侧已由 F5 钉住

    mountDetail(agent, hub);
    const head = document.querySelector("#fleet-drawer .run-head")!;
    expect(head.textContent).toContain(`label-${RUN}`); // lastRow 的名字
    expect(head.querySelector(".chip-notlisted")!.textContent).toBe("no longer listed");
    expect(document.querySelector("#fleet-drawer .run-tx")!.textContent).toContain("run-msg"); // 不中断
  });
});

describe("U11: watching:false 降级页脚(§6.6)", () => {
  it("live:false 且非终态 ⇒ 页脚显示降级原因 + fleetActivity(lastRow)(与树内摘要同函数)", () => {
    const row = fleetRow(RUN, { streamLine: "reading files…", toolTrail: "read,grep" });
    const agent = agentState({ live: false, fleet: [row] });
    const hub = fakeHub();
    mountDetail(agent, hub);
    const foot = document.querySelector("#fleet-drawer .run-tx-foot")!;
    expect(foot.textContent).toContain("Live update slots are full");
    expect(foot.querySelector(".run-tx-activity")!.textContent).toBe(fleetActivity(row));
  });

  it("live:true ⇒ 没有降级页脚", () => {
    mountDetail(agentState({ live: true }), fakeHub());
    expect(document.querySelector("#fleet-drawer .run-tx-foot")).toBeNull();
  });
});

describe("RunTranscript 页脚其余状态(§6.5/§6.6)", () => {
  it("终态 ⇒ 「Finished · status」chip;已收条目保留(§3.6)", () => {
    mountDetail(agentState({ terminal: true }), fakeHub());
    const foot = document.querySelector("#fleet-drawer .run-tx-foot")!;
    expect(foot.querySelector(".chip-terminal")!.textContent).toContain("Finished · completed");
    expect(document.querySelector("#fleet-drawer .run-tx")!.textContent).toContain("run-msg");
  });

  it("错误态 ⇒ reason 文案 + 重试按钮;重试 = selectRun 重选同一 run", async () => {
    const hub = fakeHub();
    mountDetail(agentState({ runError: { error: "E_NOT_FOUND", reason: "not_persisted" } }), hub);
    const foot = document.querySelector("#fleet-drawer .run-tx-foot")!;
    expect(foot.textContent).toContain("rememberAgents=false");
    foot.querySelector<HTMLElement>(".run-tx-retry")!.click();
    await nextTick();
    expect(hub.selectRun).toHaveBeenCalledWith("A", RUN);
  });

  it("翻页 deny(loaded 态带 reason)⇒ 页脚提示,且「加载更早」已被禁用(hasMore=false)", () => {
    const s = reduceAll([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      { event: "history", data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
      { event: "fleet", data: { agentKey: "A", runs: [fleetRow(RUN)] } },
      { event: "run_select", data: { agentKey: "A", runId: RUN } },
      { event: "run_subscribing", data: { agentKey: "A", runId: RUN, at: 100, retries: 0 } },
      {
        event: "run_history",
        data: {
          agentKey: "A",
          runId: RUN,
          entries: [entry("r1", "user", 1000, "run-msg")],
          tailMessages: [],
          tapId: "tap_1",
          fromSeq: 11,
          hasMore: true,
          source: "file",
          terminal: true,
          status: "completed",
          live: false,
        },
      },
      { event: "run_page_failed", data: { agentKey: "A", runId: RUN, error: "E_NOT_FOUND", reason: "not_persisted" } },
    ]);
    const agent = s.agents.get("A")!;
    expect(agent.runTx!.hasMore).toBe(false); // F5 的 deny 类禁用
    mountDetail(agent, fakeHub());
    const foot = document.querySelector("#fleet-drawer .run-tx-foot")!;
    expect(foot.textContent).toContain("rememberAgents=false");
    expect(document.querySelector("#fleet-drawer .tx-older")).toBeNull();
  });

  it("hello 后重订阅:loaded 内容 + pendingSince ⇒ 「重新连接中」角标(§6.5)", () => {
    const s = reduceAll([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      { event: "history", data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
      { event: "fleet", data: { agentKey: "A", runs: [fleetRow(RUN)] } },
      { event: "run_select", data: { agentKey: "A", runId: RUN } },
      { event: "run_subscribing", data: { agentKey: "A", runId: RUN, at: 100, retries: 0 } },
      {
        event: "run_history",
        data: {
          agentKey: "A",
          runId: RUN,
          entries: [entry("r1", "user", 1000, "run-msg")],
          tailMessages: [],
          tapId: "tap_1",
          fromSeq: 11,
          hasMore: false,
          source: "live",
          terminal: false,
          status: "running",
          live: true,
        },
      },
      // hello 后的重订阅:内容保留 + pendingSince 重新置位
      { event: "run_subscribing", data: { agentKey: "A", runId: RUN, at: 200, retries: 0 } },
    ]);
    mountDetail(s.agents.get("A")!, fakeHub());
    const foot = document.querySelector("#fleet-drawer .run-tx-foot")!;
    expect(foot.querySelector(".run-tx-badge")!.textContent).toBe("Reconnecting…");
    expect(document.querySelector("#fleet-drawer .run-tx")!.textContent).toContain("run-msg");
  });

  it("CONTROL_VIEW 被 null 覆盖:父级 isWebMessage 恒真,抽屉里的 TxUser 也不出 web 徽标(§6.6)", () => {
    const agent = agentState({ runEntries: [entry("r1", "user", 1000, "run-msg")] });
    const wrapper = mount(RunTranscript, {
      props: { agent, now: 0 },
      attachTo: document.body,
      global: {
        provide: {
          [HUB_CTX as symbol]: fakeHub(),
          // 若 RunTranscript 没有覆盖,这个恒真的 isWebMessage 会让气泡带上 web 徽标
          [CONTROL_VIEW as symbol]: { isWebMessage: () => true },
        },
      },
    });
    mounted.push(wrapper);
    expect(wrapper.find(".badge-web").exists()).toBe(false);
    expect(wrapper.text()).toContain("run-msg");
  });
});
