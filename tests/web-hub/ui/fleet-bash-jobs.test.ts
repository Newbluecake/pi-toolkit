// @vitest-environment happy-dom
/**
 * bash→fleet 迁移(2026-10-15 用户拍板 L1 前端包):主会话后台 bash 任务从详情头部的
 * BashJobsPanel 迁到 fleet 抽屉树视图的独立「bash」分组 —— `FleetBashJobs.vue` +
 * `bashJobsView.ts`(view helper 原样沿用,agent 端投影/协议不动)。覆盖:
 * - `bashJobsOf` 的无 wire/空行不渲染裁决(旧 hub/agent 不带字段 ⇒ 与现状一致);
 * - 组标题计数语法 `bash · 2 running · 8 done`(英文紧凑标记)、默认开合(有 running ⇒
 *   展开,全终态 ⇒ 收起)、`aria-expanded`;
 * - 行渲染:terminal 图标只在组标题(行内不再有身份图标)、状态 icon/token(沿用
 *   BashJobsPanel 语义)、short id、redacted cmd(全文在 `title`)、`exit N`/`grace`、
 *   logBytes `+`;
 * - 行展开:完整命令 + 日志尾 PLAIN TEXT(`<script>` payload 保持惰性文本,绝无 v-html);
 * - agent 判定的新鲜度标记(`sampling…` / `tail Ns old` / `unavailable` / `no output yet`);
 * - 未知未来状态值(generic token,原文显示,不丢弃);
 * - elapsed 走时改为共享 `now` prop 驱动(FleetTree 语法)——组件内部不再有 ticker;
 * - FleetDrawer 集成:树视图里 agent 树之后出现分组、无 wire/零行不出现、选中 run 时
 *   不出现;
 * - FleetSummaryBar:agent 计数不混入 bash;无子 agent 但有 bash 任务时入口按钮仍出现,
 *   aria-label 追加 bash 小计。
 */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import FleetBashJobs from "../../../src/web-hub/ui/src/components/fleet/FleetBashJobs.vue";
import FleetDrawer from "../../../src/web-hub/ui/src/components/drawer/FleetDrawer.vue";
import FleetSummaryBar from "../../../src/web-hub/ui/src/components/fleet/FleetSummaryBar.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { HubHandle } from "../../../src/web-hub/ui/src/types.js";
import { ref } from "vue";
import {
  bashJobsOf,
  formatBytes,
  statusToken,
  summaryCounts,
  tailFreshness,
} from "../../../src/web-hub/ui/src/components/detail/bashJobsView.js";
import type { BashJobRowWire, BashJobsWire } from "../../../src/web-hub/protocol/messages.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

const SAMPLED_AT = 1_700_000_000_000;

const row = (over: Partial<BashJobRowWire> = {}): BashJobRowWire => ({
  id: "job-aaaa1111",
  cmd: "sleep 60",
  status: "running",
  exitCode: null,
  createdAt: SAMPLED_AT - 5_000,
  elapsedMs: 5_000,
  logBytes: 0,
  ...over,
});

const wire = (rows: BashJobRowWire[], over: Partial<BashJobsWire> = {}): BashJobsWire => ({
  rows,
  total: rows.length,
  running: rows.filter((r) => r.status === "running" || r.status === "staged").length,
  failed: 0,
  sampledAt: SAMPLED_AT,
  ...over,
});

const mountGroup = (w: BashJobsWire, now = SAMPLED_AT) => mount(FleetBashJobs, { props: { jobs: w, now } });
/** Mount and guarantee the row list is visible (all-terminal groups default to collapsed). */
const mountGroupOpen = async (w: BashJobsWire, now = SAMPLED_AT) => {
  const wrapper = mountGroup(w, now);
  if (!wrapper.find(".bj-list").exists()) await wrapper.find(".bj-sum").trigger("click");
  return wrapper;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("bashJobsOf / summaryCounts (view helper, 沿用 bash-jobs-panel 包 B)", () => {
  it("returns undefined when the status slot carries no bashJobs wire (legacy agent)", () => {
    const agent = { status: { busy: false, pending: false } } as unknown as Pick<AgentState, "status">;
    expect(bashJobsOf(agent)).toBeUndefined();
  });

  it("returns undefined for malformed or empty-row wires (same 空态 ruling as WorktreePanel)", () => {
    const bad = { status: { bashJobs: "nope" } } as unknown as Pick<AgentState, "status">;
    expect(bashJobsOf(bad)).toBeUndefined();
    const empty = { status: { bashJobs: wire([]) } } as unknown as Pick<AgentState, "status">;
    expect(bashJobsOf(empty)).toBeUndefined();
  });

  it("returns the wire when rows are present; summaryCounts derives done = total − running − failed", () => {
    const w = wire([row()], { total: 8, running: 2, failed: 1 });
    const agent = { status: { bashJobs: w } } as unknown as Pick<AgentState, "status">;
    expect(bashJobsOf(agent)).toEqual(w);
    expect(summaryCounts(w)).toEqual({ running: 2, done: 5, failed: 1 });
  });

  it("formatBytes: B / KB / MB and malformed values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(12_902)).toBe("12.6 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes("x")).toBe("—");
  });
});

describe("FleetBashJobs.vue — 组标题与默认开合", () => {
  it("group title count grammar `bash · 2 running · 5 done · 1 failed`; running ⇒ default expanded", () => {
    const w = wire([row()], { total: 8, running: 2, failed: 1 });
    const wrapper = mountGroup(w);
    expect(wrapper.find(".bj-sum-text").text()).toBe("bash · 2 running · 5 done · 1 failed");
    expect(wrapper.find(".bj-sum").attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".bj-list").exists()).toBe(true);
    expect(wrapper.find(".fleet-bash").attributes("aria-readonly")).toBe("true");
  });

  it("omits zero-count segments; all-terminal ⇒ default collapsed", () => {
    const wrapper = mountGroup(wire([row({ status: "completed", exitCode: 0 })], { total: 3, running: 0, failed: 0 }));
    expect(wrapper.find(".bj-sum-text").text()).toBe("bash · 3 done");
    expect(wrapper.find(".bj-sum").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".bj-list").exists()).toBe(false);
  });

  it("expands and collapses via the summary button (aria-expanded, prose aria-label)", async () => {
    const wrapper = mountGroup(wire([row({ status: "completed", exitCode: 0 })]));
    await wrapper.find(".bj-sum").trigger("click");
    expect(wrapper.find(".bj-sum").attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".bj-sum").attributes("aria-label")).toBe("Background bash jobs: 0 running, 1 done, 0 failed");
    expect(wrapper.findAll(".bj-item")).toHaveLength(1);
    await wrapper.find(".bj-sum").trigger("click");
    expect(wrapper.find(".bj-list").exists()).toBe(false);
  });
});

describe("FleetBashJobs.vue — rows (拍板 ③: 状态语义 + 行底色,与 agent 行区分)", () => {
  it("no per-row terminal icon (title only), status icon/token, short id, cmd (full text on title), exit/grace/elapsed/bytes", async () => {
    const long = 'curl -H "Authorization: ***" https://example.com/' + "x".repeat(300);
    const wrapper = await mountGroupOpen(
      wire([
        row({
          id: "job-bbbb2222cccc",
          cmd: long,
          status: "failed",
          exitCode: 17,
          endedAt: SAMPLED_AT - 1_000,
          elapsedMs: 65_000,
          logBytes: 12_902,
          logTruncated: true,
          grace: true,
          tail: "boom",
          tailAt: SAMPLED_AT - 500,
          tailBytes: 12_902,
          tailCurrent: true,
        }),
      ]),
    );
    const item = wrapper.find(".bj-item");
    expect(item.attributes("data-status")).toBe("failed");
    // terminal 图标只留在组标题(2026-10-15 拍板):行内只有状态图标
    expect(item.find(".bj-term").exists()).toBe(false);
    expect(wrapper.find(".bj-sum").findAll("svg").length).toBeGreaterThan(0);
    expect(item.find(".bj-ico").attributes("data-kind")).toBe("failed");
    expect(item.find(".bj-id").text()).toBe("job-bbbb");
    const cmd = item.find(".bj-cmd");
    expect(cmd.text()).toBe(long);
    expect(cmd.attributes("title")).toBe(long);
    expect(cmd.attributes("translate")).toBe("no");
    expect(item.find(".bj-status").text()).toBe("failed");
    expect(item.find(".bj-status").attributes("data-kind")).toBe("failed");
    expect(item.find(".bj-exit").text()).toBe("exit 17");
    expect(item.find(".bj-chip").text()).toBe("grace");
    expect(item.find(".bj-elapsed").text()).toBe("1m05s");
    expect(item.find(".bj-bytes").text()).toBe("12.6 KB+"); // logTruncated ⇒ `+`
  });

  it("a row with a tail expands to a plain-text <pre>; a tail-less row is not expandable", async () => {
    const wrapper = mountGroup(
      wire([
        row({ id: "job-1", tail: "line1\nline2", tailAt: SAMPLED_AT - 100, tailCurrent: true }),
        row({ id: "job-2", status: "completed", exitCode: 0, tailCurrent: true }),
      ]),
    );
    const rows = wrapper.findAll(".bj-row");
    expect(rows[1]?.attributes("disabled")).toBeDefined();

    await rows[0]?.trigger("click");
    const pre = wrapper.find(".bj-tail");
    expect(pre.exists()).toBe(true);
    expect(pre.text()).toBe("line1\nline2");
    expect(rows[0]?.attributes("aria-expanded")).toBe("true");
    // the expansion also carries the full (ellipsized-in-row) command as plain text
    const full = wrapper.find(".bj-cmd-full");
    expect(full.exists()).toBe(true);
    expect(full.text()).toBe(wrapper.find(".bj-cmd").text());

    await rows[0]?.trigger("click");
    expect(wrapper.find(".bj-tail").exists()).toBe(false);
    expect(wrapper.find(".bj-cmd-full").exists()).toBe(false);
    expect(rows[0]?.attributes("aria-expanded")).toBe("false");
  });

  it("a `<script>` payload in the tail renders as inert text (no element, no v-html)", async () => {
    const payload = "<script>alert(1)</script><img src=x onerror=alert(2)>";
    const wrapper = mountGroup(wire([row({ tail: payload })]));
    await wrapper.find(".bj-row").trigger("click");
    const pre = wrapper.find(".bj-tail");
    expect(pre.text()).toBe(payload);
    expect(pre.find("script").exists()).toBe(false);
    expect(pre.find("img").exists()).toBe(false);
    expect(pre.element.innerHTML).not.toContain("<script>");
  });

  it("unknown future status: generic token with the raw text, never dropped, never ticking", async () => {
    const wrapper = await mountGroupOpen(wire([row({ status: "melted" as never, elapsedMs: 3_000 })]));
    const token = statusToken(row({ status: "melted" as never }));
    expect(token.kind).toBe("generic");
    expect(token.text).toBe("melted");
    expect(token.live).toBe(false);
    const item = wrapper.find(".bj-item");
    expect(item.find(".bj-status").text()).toBe("melted");
    expect(item.find(".bj-status").attributes("data-kind")).toBe("generic");
    expect(item.find(".bj-elapsed").text()).toBe("3s");
  });

  it("all known lifecycle statuses map to stable tokens/icons", () => {
    const expectToken = (status: string, text: string, live: boolean) => {
      const tk = statusToken(row({ status }));
      expect(tk.text).toBe(text);
      expect(tk.live).toBe(live);
    };
    expectToken("staged", "staged", true);
    expectToken("running", "running", true);
    expectToken("completed", "done", false);
    expectToken("failed", "failed", false);
    expectToken("timed_out", "timeout", false);
    expectToken("killed", "killed", false);
    expectToken("exited_unknown", "exited?", false);
    expectToken("orphaned", "orphaned", false);
  });

  it("omitted ⇒ `(+N more)`; no logPath/CopyButton anywhere", () => {
    const wrapper = mountGroup(wire([row()], { omitted: 7 }));
    expect(wrapper.find(".bj-more").text()).toBe("(+7 more)");
    expect(wrapper.html()).not.toContain("logPath");
    expect(wrapper.findAll("button").every((b) => !b.classes().includes("copy-btn"))).toBe(true);
    // the only buttons are the summary toggle and the per-row tail toggles
    for (const b of wrapper.findAll(".bj-list button")) expect(b.classes()).toContain("bj-row");
  });
});

describe("FleetBashJobs.vue — freshness markers (D3-3: agent-judged, UI never compares clocks)", () => {
  it("tailCurrent ⇒ no marker", () => {
    const wrapper = mountGroup(wire([row({ tail: "x", tailAt: SAMPLED_AT - 999_999, tailCurrent: true })]));
    expect(wrapper.find(".bj-fresh").exists()).toBe(false);
    expect(tailFreshness(row({ tail: "x", tailAt: SAMPLED_AT - 999_999, tailCurrent: true }), SAMPLED_AT)).toEqual({
      kind: "current",
    });
  });

  it("has tail, not current, fresh sample ⇒ `sampling…`", () => {
    const wrapper = mountGroup(wire([row({ tail: "x", tailAt: SAMPLED_AT - 5_000 })]));
    const marker = wrapper.find(".bj-fresh");
    expect(marker.text()).toBe("sampling…");
    expect(marker.attributes("data-kind")).toBe("sampling");
  });

  it("has tail, sample older than 30s ⇒ `tail Ns old`", () => {
    const wrapper = mountGroup(wire([row({ tail: "x", tailAt: SAMPLED_AT - 45_000 })]));
    const marker = wrapper.find(".bj-fresh");
    expect(marker.text()).toBe("tail 45s old");
    expect(marker.attributes("data-kind")).toBe("stale");
  });

  it("tailUnavailable ⇒ `unavailable` (wins over every other signal)", () => {
    const wrapper = mountGroup(wire([row({ tail: "x", tailAt: SAMPLED_AT - 100, tailUnavailable: true })]));
    expect(wrapper.find(".bj-fresh").text()).toBe("unavailable");
    expect(tailFreshness(row({ tailCurrent: true, tailUnavailable: true }), SAMPLED_AT).kind).toBe("unavailable");
  });

  it("no tail and not sampling ⇒ `no output yet`", () => {
    const wrapper = mountGroup(wire([row()]));
    expect(wrapper.find(".bj-fresh").text()).toBe("no output yet");
    expect(tailFreshness(row(), SAMPLED_AT).kind).toBe("empty");
  });
});

describe("FleetBashJobs.vue — elapsed 走时 (共享 `now` prop 驱动,组件内无 ticker)", () => {
  it("live rows tick off the shared now prop; a new wire frame resets the baseline", async () => {
    const w = wire([row({ id: "job-tick", elapsedMs: 5_000 })]);
    const wrapper = mountGroup(w, SAMPLED_AT);
    const elapsed = () => wrapper.find(".bj-elapsed").text();
    expect(elapsed()).toBe("5s");

    // the parent ticks: same wire, later now ⇒ local display advances
    await wrapper.setProps({ now: SAMPLED_AT + 2_000 });
    expect(elapsed()).toBe("7s"); // 5s wire + 2s local

    // a new wire frame arrives with a fresh elapsedMs ⇒ baseline resets, no double counting
    await wrapper.setProps({ jobs: wire([row({ id: "job-tick", elapsedMs: 8_000 })]) });
    expect(elapsed()).toBe("8s");
    await wrapper.setProps({ now: SAMPLED_AT + 3_000 });
    expect(elapsed()).toBe("9s");
    wrapper.unmount();
  });

  it("terminal rows show the wire's frozen elapsedMs and never tick", async () => {
    const wrapper = await mountGroupOpen(
      wire([row({ status: "completed", exitCode: 0, elapsedMs: 42_000, endedAt: SAMPLED_AT })]),
    );
    expect(wrapper.find(".bj-elapsed").text()).toBe("42s");
    await wrapper.setProps({ now: SAMPLED_AT + 5_000 });
    expect(wrapper.find(".bj-elapsed").text()).toBe("42s");
    wrapper.unmount();
  });

  it("the component arms NO ticker of its own (the parent owns the shared now)", () => {
    vi.useFakeTimers();
    const wrapper = mountGroup(wire([row()]));
    expect(vi.getTimerCount()).toBe(0);
    wrapper.unmount();
  });

  it("an expanded row leaving the wire collapses (baseline + expanded id pruned)", async () => {
    const wrapper = mountGroup(wire([row({ id: "job-gone", tail: "x" })]));
    await wrapper.find(".bj-row").trigger("click");
    expect(wrapper.find(".bj-tail").exists()).toBe(true);

    await wrapper.setProps({
      jobs: wire([row({ id: "job-other", status: "completed", exitCode: 0, elapsedMs: 1_000 })]),
    });
    expect(wrapper.find(".bj-tail").exists()).toBe(false);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------------
// FleetDrawer 集成:树视图里 agent 树之后的独立分组
// ---------------------------------------------------------------------------
function fleetRow(runId: string, extra: Record<string, unknown> = {}) {
  return {
    runId,
    label: runId,
    type: "general",
    status: "running",
    phaseLabel: "working",
    elapsedMs: 1000,
    phaseMs: 0,
    highlight: "none",
    terminal: false,
    ...extra,
  };
}

function drawerAgent(over: Record<string, unknown> = {}) {
  return {
    key: "A",
    card: { control: true, state: "live", runTranscript: true },
    down: false,
    prompts: [],
    fleet: [fleetRow("r_1")],
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
    dialogs: { epoch: "e1", open: [], closed: [] },
    pendingCtl: [],
    runSel: null,
    runTx: null,
    ...over,
  } as never;
}

function fakeHub(): HubHandle {
  return {
    state: ref({ control: true }) as HubHandle["state"],
    selectRun: vi.fn(),
    pageRun: vi.fn(),
    dispatch: vi.fn(),
  } as unknown as HubHandle;
}

const mountedDrawers: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mountedDrawers.splice(0)) w.unmount();
});

function mountDrawer(agent: unknown) {
  const wrapper = mount(FleetDrawer, {
    props: { agent, now: SAMPLED_AT, mode: "docked", open: true },
    global: { provide: { [HUB_CTX as symbol]: fakeHub() } },
  });
  mountedDrawers.push(wrapper);
  return wrapper;
}

describe("FleetDrawer — 「bash」分组(树视图末尾,agent 树之后)", () => {
  it("renders the group after the agent tree when status.bashJobs carries rows", () => {
    const wrapper = mountDrawer(drawerAgent({ status: { busy: false, pending: false, bashJobs: wire([row()]) } }));
    const group = wrapper.find(".fleet-bash");
    expect(group.exists()).toBe(true);
    expect(wrapper.find(".bj-sum-text").text()).toBe("bash · 1 running");
    // 分组在 agent 树(`.tree`)之后
    const kids = [...wrapper.find(".tree-scroll").element.children];
    const treeIdx = kids.findIndex((el) => el.classList.contains("tree"));
    const bashIdx = kids.findIndex((el) => el.classList.contains("fleet-bash"));
    expect(treeIdx).toBeGreaterThanOrEqual(0);
    expect(bashIdx).toBe(treeIdx + 1);
  });

  it("running vs failed rows are visually distinguishable (data-status + status token)", () => {
    const wrapper = mountDrawer(
      drawerAgent({
        status: {
          busy: false,
          pending: false,
          bashJobs: wire([
            row({ id: "job-run" }),
            row({ id: "job-bad", status: "timed_out", exitCode: null, endedAt: SAMPLED_AT }),
          ]),
        },
      }),
    );
    const items = wrapper.findAll(".bj-item");
    expect(items[0]?.attributes("data-status")).toBe("running");
    expect(items[0]?.find(".bj-status").attributes("data-kind")).toBe("running");
    expect(items[1]?.attributes("data-status")).toBe("timeout");
    expect(items[1]?.find(".bj-status").attributes("data-kind")).toBe("failed");
  });

  it("no wire / zero rows / legacy agent without the field ⇒ no group (与现状一致)", () => {
    const legacy = mountDrawer(drawerAgent({ status: { busy: false, pending: false } }));
    expect(legacy.find(".fleet-bash").exists()).toBe(false);
    const noStatus = mountDrawer(drawerAgent());
    expect(noStatus.find(".fleet-bash").exists()).toBe(false);
    const empty = mountDrawer(drawerAgent({ status: { busy: false, pending: false, bashJobs: wire([]) } }));
    expect(empty.find(".fleet-bash").exists()).toBe(false);
  });

  it("the group only lives in the tree view — a selected run hides it", () => {
    const wrapper = mountDrawer(
      drawerAgent({
        runSel: "r_1",
        status: { busy: false, pending: false, bashJobs: wire([row()]) },
      }),
    );
    expect(wrapper.find(".fleet-bash").exists()).toBe(false);
  });

  it("a row expands to the tail inside the drawer (click 展开命令与日志尾)", async () => {
    const wrapper = mountDrawer(
      drawerAgent({
        status: {
          busy: false,
          pending: false,
          bashJobs: wire([row({ tail: "tail-line", tailAt: SAMPLED_AT - 100, tailCurrent: true })]),
        },
      }),
    );
    await wrapper.find(".bj-row").trigger("click");
    expect(wrapper.find(".bj-tail").text()).toBe("tail-line");
  });
});

// ---------------------------------------------------------------------------
// FleetSummaryBar:agent 计数不混入 bash;bash 小计进 aria-label
// ---------------------------------------------------------------------------
describe("FleetSummaryBar — bash 小计 (拍板 ⑤)", () => {
  it("no agents and no bashJobs ⇒ the button stays hidden (legacy 不占位)", () => {
    const wrapper = mount(FleetSummaryBar, { props: { rows: [], open: false } });
    expect(wrapper.find(".fleet-summary-bar").exists()).toBe(false);
  });

  it("no agents but bash jobs present ⇒ the button renders (抽屉里的 bash 分组要可达)", () => {
    const wrapper = mount(FleetSummaryBar, {
      props: { rows: [], open: false, bashJobs: wire([row()], { total: 3, running: 1, failed: 0 }) },
    });
    const btn = wrapper.find(".fleet-summary-bar");
    expect(btn.exists()).toBe(true);
    // 徽标仍只数 agent running —— 没有 agent 行 ⇒ 无徽标
    expect(wrapper.find(".fab-count").exists()).toBe(false);
    expect(btn.attributes("aria-label")).toContain("bash 1 running");
  });

  it("agents + bash: aria-label carries both; the agent badge never counts bash", () => {
    const rows = [fleetRow("r_1"), fleetRow("r_2", { terminal: true })] as never[];
    const wrapper = mount(FleetSummaryBar, {
      props: { rows, open: false, bashJobs: wire([row()], { total: 2, running: 2, failed: 0 }) },
    });
    const btn = wrapper.find(".fleet-summary-bar");
    expect(wrapper.find(".fab-count .num").text()).toBe("1"); // agent running only
    const label = btn.attributes("aria-label") ?? "";
    expect(label).toContain("bash 2 running");
  });

  it("all-terminal bash jobs ⇒ the subtotal falls back to a done/failed total", () => {
    const wrapper = mount(FleetSummaryBar, {
      props: {
        rows: [],
        open: false,
        bashJobs: wire([row({ status: "completed", exitCode: 0 })], { total: 5, running: 0, failed: 1 }),
      },
    });
    expect(wrapper.find(".fleet-summary-bar").attributes("aria-label")).toContain("bash 5 done");
  });

  it("without the bashJobs prop the aria-label is byte-identical to the legacy shape", () => {
    const rows = [fleetRow("r_1")] as never[];
    const wrapper = mount(FleetSummaryBar, { props: { rows, open: false } });
    expect(wrapper.find(".fleet-summary-bar").attributes("aria-label")).not.toContain("bash");
  });
});
