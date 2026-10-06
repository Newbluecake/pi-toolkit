// @vitest-environment happy-dom
/**
 * `BashJobsPanel.vue` + `bashJobsView.ts` (bash-jobs-panel plan §3 包 B / D4). The backend
 * (包 A) isn't wired yet, so the panel is driven by handwritten fixtures typed against the
 * frozen 包 A0 wire (`@protocol/messages.js`, commit 384ad91). Covers: the no-wire/empty-rows
 * non-render ruling (`bashJobsOf`), the collapsed summary's count grammar, fold/unfold with
 * `aria-expanded`, expanded rows (status icon/token, short id, redacted cmd with the full
 * text on `title`, `exit N` / `grace`, logBytes `+`), row-expand tail rendering as PLAIN
 * TEXT (a `<script>` payload stays inert text), the agent-judged freshness markers
 * (`sampling…` / `tail Ns old` / `unavailable` / `no output yet` / none when `tailCurrent`),
 * unknown future status values (generic token, raw text, never dropped), the `omitted` tail,
 * the always-visible sensitive-info hint, the absence of any logPath/CopyButton (plan v2
 * #2), and the FleetTree-style elapsed baseline (local ticking only for live rows, baseline
 * reset on a new wire frame, no ticker without live rows, disposal on unmount).
 */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import BashJobsPanel from "../../../src/web-hub/ui/src/components/detail/BashJobsPanel.vue";
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

const mountPanel = (w: BashJobsWire) => mount(BashJobsPanel, { props: { jobs: w } });
const openPanel = async (w: BashJobsWire) => {
  const wrapper = mountPanel(w);
  await wrapper.find(".bj-sum").trigger("click");
  return wrapper;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("bashJobsOf / summaryCounts (bash-jobs-panel 包 B view helper)", () => {
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

describe("BashJobsPanel.vue — collapsed summary (D4)", () => {
  it("full count grammar, starts collapsed, aria-readonly", () => {
    const w = wire([row()], { total: 8, running: 2, failed: 1 });
    const wrapper = mountPanel(w);
    expect(wrapper.find(".bj-sum-text").text()).toBe("bash 2 running · 5 done · 1 failed");
    expect(wrapper.find(".bj-sum").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".bj-list").exists()).toBe(false);
    expect(wrapper.find(".bj-panel").attributes("aria-readonly")).toBe("true");
  });

  it("omits zero-count segments", () => {
    const wrapper = mountPanel(wire([row({ status: "completed", exitCode: 0 })], { total: 3, running: 0, failed: 0 }));
    expect(wrapper.find(".bj-sum-text").text()).toBe("bash 3 done");
  });

  it("expands and collapses via the summary button (aria-expanded, prose aria-label)", async () => {
    const wrapper = await openPanel(wire([row()]));
    expect(wrapper.find(".bj-sum").attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".bj-sum").attributes("aria-label")).toBe("Background bash jobs: 1 running, 0 done, 0 failed");
    expect(wrapper.findAll(".bj-item")).toHaveLength(1);
    await wrapper.find(".bj-sum").trigger("click");
    expect(wrapper.find(".bj-list").exists()).toBe(false);
  });
});

describe("BashJobsPanel.vue — expanded rows (D4)", () => {
  it("status icon/token, short id, redacted cmd (mono, full text on title), exit/grace/elapsed/bytes", async () => {
    const long = 'curl -H "Authorization: ***" https://example.com/' + "x".repeat(300);
    const wrapper = await openPanel(
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
    const wrapper = await openPanel(
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

    await rows[0]?.trigger("click");
    expect(wrapper.find(".bj-tail").exists()).toBe(false);
    expect(rows[0]?.attributes("aria-expanded")).toBe("false");
  });

  it("a `<script>` payload in the tail renders as inert text (no element, no v-html)", async () => {
    const payload = "<script>alert(1)</script><img src=x onerror=alert(2)>";
    const wrapper = await openPanel(wire([row({ tail: payload })]));
    await wrapper.find(".bj-row").trigger("click");
    const pre = wrapper.find(".bj-tail");
    expect(pre.text()).toBe(payload);
    expect(pre.find("script").exists()).toBe(false);
    expect(pre.find("img").exists()).toBe(false);
    expect(pre.element.innerHTML).not.toContain("<script>");
  });

  it("unknown future status: generic token with the raw text, never dropped, never ticking", async () => {
    const wrapper = await openPanel(wire([row({ status: "melted" as never, elapsedMs: 3_000 })]));
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

  it("omitted ⇒ `(+N more)`; sensitive hint always visible while open; no logPath/CopyButton", async () => {
    const wrapper = await openPanel(wire([row()], { omitted: 7 }));
    expect(wrapper.find(".bj-more").text()).toBe("(+7 more)");
    expect(wrapper.find(".bj-sensitive").text()).toContain("redaction is best-effort");
    expect(wrapper.html()).not.toContain("logPath");
    expect(wrapper.findAll("button").every((b) => !b.classes().includes("copy-btn"))).toBe(true);
    // the only buttons are the summary toggle and the per-row tail toggles
    for (const b of wrapper.findAll(".bj-list button")) expect(b.classes()).toContain("bj-row");
  });
});

describe("BashJobsPanel.vue — freshness markers (D3-3: agent-judged, UI never compares clocks)", () => {
  it("tailCurrent ⇒ no marker", async () => {
    const wrapper = await openPanel(wire([row({ tail: "x", tailAt: SAMPLED_AT - 999_999, tailCurrent: true })]));
    expect(wrapper.find(".bj-fresh").exists()).toBe(false);
    expect(tailFreshness(row({ tail: "x", tailAt: SAMPLED_AT - 999_999, tailCurrent: true }), SAMPLED_AT)).toEqual({
      kind: "current",
    });
  });

  it("has tail, not current, fresh sample ⇒ `sampling…`", async () => {
    const wrapper = await openPanel(wire([row({ tail: "x", tailAt: SAMPLED_AT - 5_000 })]));
    const marker = wrapper.find(".bj-fresh");
    expect(marker.text()).toBe("sampling…");
    expect(marker.attributes("data-kind")).toBe("sampling");
  });

  it("has tail, sample older than 30s ⇒ `tail Ns old`", async () => {
    const wrapper = await openPanel(wire([row({ tail: "x", tailAt: SAMPLED_AT - 45_000 })]));
    const marker = wrapper.find(".bj-fresh");
    expect(marker.text()).toBe("tail 45s old");
    expect(marker.attributes("data-kind")).toBe("stale");
  });

  it("tailUnavailable ⇒ `unavailable` (wins over every other signal)", async () => {
    const wrapper = await openPanel(wire([row({ tail: "x", tailAt: SAMPLED_AT - 100, tailUnavailable: true })]));
    expect(wrapper.find(".bj-fresh").text()).toBe("unavailable");
    expect(tailFreshness(row({ tailCurrent: true, tailUnavailable: true }), SAMPLED_AT).kind).toBe("unavailable");
  });

  it("no tail and not sampling ⇒ `no output yet`", async () => {
    const wrapper = await openPanel(wire([row()]));
    expect(wrapper.find(".bj-fresh").text()).toBe("no output yet");
    expect(tailFreshness(row(), SAMPLED_AT).kind).toBe("empty");
  });
});

describe("BashJobsPanel.vue — elapsed 走时 baseline (D4, FleetTree grammar)", () => {
  it("live rows tick locally from the wire baseline; a new frame resets the baseline", async () => {
    vi.useFakeTimers();
    const w = wire([row({ id: "job-tick", elapsedMs: 5_000 })]);
    const wrapper = await openPanel(w);
    const elapsed = () => wrapper.find(".bj-elapsed").text();
    expect(elapsed()).toBe("5s");

    vi.advanceTimersByTime(2_000);
    await wrapper.vm.$nextTick();
    expect(elapsed()).toBe("7s"); // 5s wire + 2s local

    // a new wire frame arrives with a fresh elapsedMs ⇒ baseline resets, no double counting
    await wrapper.setProps({ jobs: wire([row({ id: "job-tick", elapsedMs: 8_000 })]) });
    expect(elapsed()).toBe("8s");
    vi.advanceTimersByTime(1_000);
    await wrapper.vm.$nextTick();
    expect(elapsed()).toBe("9s");
    wrapper.unmount();
  });

  it("terminal rows show the wire's frozen elapsedMs and never tick", async () => {
    vi.useFakeTimers();
    const wrapper = await openPanel(
      wire([row({ status: "completed", exitCode: 0, elapsedMs: 42_000, endedAt: SAMPLED_AT })]),
    );
    expect(wrapper.find(".bj-elapsed").text()).toBe("42s");
    vi.advanceTimersByTime(5_000);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".bj-elapsed").text()).toBe("42s");
    wrapper.unmount();
  });

  it("no live rows ⇒ no ticker is armed; unmount disposes a live ticker", async () => {
    vi.useFakeTimers();
    const terminalOnly = await openPanel(
      wire([row({ status: "failed", exitCode: 1, elapsedMs: 1_000, endedAt: SAMPLED_AT })]),
    );
    expect(vi.getTimerCount()).toBe(0);
    terminalOnly.unmount();

    const live = await openPanel(wire([row()]));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    live.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the ticker stops when the last live row leaves the wire (row set shrinks ⇒ prune)", async () => {
    vi.useFakeTimers();
    const wrapper = await openPanel(wire([row({ id: "job-gone", tail: "x" })]));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await wrapper.find(".bj-row").trigger("click");
    expect(wrapper.find(".bj-tail").exists()).toBe(true);

    // the row leaves the selection (retention / job discarded): baseline + expanded row pruned
    await wrapper.setProps({
      jobs: wire([row({ id: "job-other", status: "completed", exitCode: 0, elapsedMs: 1_000 })]),
    });
    expect(wrapper.find(".bj-tail").exists()).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // no live rows left ⇒ ticker stopped
    wrapper.unmount();
  });
});
