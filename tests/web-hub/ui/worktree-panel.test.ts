// @vitest-environment happy-dom
/**
 * `WorktreePanel.vue` + `worktreesView.ts` (worktree-web plan §5, package W4). Driven by the
 * frozen W2 fixtures (`tests/fixtures/web-hub-worktrees/*.json`, commit 04021a9) — imported,
 * never copied — since the backend sampler (W3) isn't wired yet. Covers: the no-wire/empty-rows
 * non-render ruling, the collapsed summary's on-demand segments (branch@head, ↑/↓, counts,
 * `worktrees N+` when listCapped, `stale Nm`), fold/unfold with `aria-expanded`, expanded rows
 * (current marker + sr-only text, label with the absolute path on `title` + a per-row copy
 * button, branch/detached chip, dirty tokens `*N` / `*N+` / `*N~` / `clean` / `?` with their
 * tooltips, flag chips), the `omitted` tail and the `last sample` footer, the read-only ruling,
 * and forward compat: unknown future row/body fields never reach the DOM and an unknown
 * `unprobed` reason renders as `?` with the generic error tooltip.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import WorktreePanel from "../../../src/web-hub/ui/src/components/detail/WorktreePanel.vue";
import {
  currentRowOf,
  formatSampleTime,
  worktreesOf,
} from "../../../src/web-hub/ui/src/components/detail/worktreesView.js";
import type { WorktreesWire } from "../../../src/web-hub/protocol/messages.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

type JsonObject = Record<string, unknown>;

function fixture(name: string): JsonObject {
  // happy-dom rewrites import.meta.url to a browser-ish URL, so resolve from the repo root
  // (vitest's cwd) instead of `new URL(rel, import.meta.url)`.
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests/fixtures/web-hub-worktrees", `${name}.json`), "utf8"),
  ) as JsonObject;
}

const wireOf = (name: string): WorktreesWire => fixture(name).worktrees as WorktreesWire;

const wire = (over: Partial<WorktreesWire> = {}): WorktreesWire => ({
  rows: [{ label: "~/repo", path: "/home/dev/repo", branch: "master", head: "0123456", current: true, main: true }],
  total: 1,
  probed: 1,
  dirtyCount: 0,
  agentCount: 0,
  sampledAt: 1_700_000_000_000,
  ...over,
});

const mountPanel = (w: WorktreesWire) => mount(WorktreePanel, { props: { worktrees: w } });

describe("worktreesOf (worktree-web plan §5, W4)", () => {
  it("returns undefined when the status slot carries no worktrees wire (legacy agent)", () => {
    // legacy-status.json = a pre-feature status frame (no `worktrees` key at all)
    const agent = { status: fixture("legacy-status") } as unknown as Pick<AgentState, "status">;
    expect(worktreesOf(agent)).toBeUndefined();
  });

  it("returns undefined for malformed or empty-row wires (same空态 ruling as TodoPanel)", () => {
    const bad = { status: { worktrees: "nope" } } as unknown as Pick<AgentState, "status">;
    expect(worktreesOf(bad)).toBeUndefined();
    const empty = { status: { worktrees: wire({ rows: [] }) } } as unknown as Pick<AgentState, "status">;
    expect(worktreesOf(empty)).toBeUndefined();
  });

  it("returns the wire when rows are present; currentRowOf finds the flagged row", () => {
    const w = wireOf("v1-status");
    const agent = { status: { worktrees: w } } as unknown as Pick<AgentState, "status">;
    expect(worktreesOf(agent)).toEqual(w);
    expect(currentRowOf(w)?.label).toBe("~/ai/pi-toolkit");
    expect(currentRowOf(wire({ rows: [{ label: "a" }, { label: "b" }] }))).toBeUndefined();
  });
});

describe("WorktreePanel.vue — collapsed summary (plan §5)", () => {
  it("v1 fixture: full summary grammar, starts collapsed, aria-readonly", () => {
    const wrapper = mountPanel(wireOf("v1-status"));
    expect(wrapper.find(".wt-sum-text").text()).toBe("master@0123456 ↑1 · worktrees 3 · 1 dirty · 1 agent");
    expect(wrapper.find(".wt-sum").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".wt-list").exists()).toBe(false);
    expect(wrapper.find(".wt-panel").attributes("aria-readonly")).toBe("true");
  });

  it("future fixture: stale segment and no current-less clutter; unknown fields stay out of the DOM", () => {
    const wrapper = mountPanel(wireOf("future-row-field"));
    expect(wrapper.find(".wt-sum-text").text()).toBe("master@0123456 · worktrees 1 · stale 2m");
    const html = wrapper.html();
    expect(html).not.toContain("unexpected-future-row-field");
    expect(html).not.toContain("unexpected-future-body-field");
    expect(html).not.toContain("foo");
  });

  it("omits optional segments: no current row ⇒ no branch segment; zero counts/stale dropped", () => {
    const wrapper = mountPanel(
      wire({
        rows: [{ label: "~/repo", path: "/home/dev/repo", branch: "dev", head: "aaaaaaa" }],
        listCapped: true,
        total: 12,
      }),
    );
    expect(wrapper.find(".wt-sum-text").text()).toBe("worktrees 12+");
  });

  it("shows a detached current row as `detached@<head>` and omits ↑/↓ when zero", () => {
    const wrapper = mountPanel(
      wire({
        rows: [{ label: "~/repo", path: "/home/dev/repo", head: "bbbbbbb", current: true, ahead: 0, behind: 0 }],
      }),
    );
    expect(wrapper.find(".wt-sum-text").text()).toBe("detached@bbbbbbb · worktrees 1");
  });

  it("expands and collapses via the summary button (keyboard-reachable, aria-expanded)", async () => {
    const wrapper = mountPanel(wireOf("v1-status"));
    const button = wrapper.find(".wt-sum");
    await button.trigger("click");
    expect(button.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".wt-panel").attributes("data-open")).toBe("true");
    expect(wrapper.findAll(".wt-item")).toHaveLength(3);
    await button.trigger("click");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".wt-list").exists()).toBe(false);
  });
});

describe("WorktreePanel.vue — expanded rows (plan §5)", () => {
  it("v1 fixture: current marker, flag chips, dirty/clean tokens, label titles and copy buttons", async () => {
    const wrapper = mountPanel(wireOf("v1-status"));
    await wrapper.find(".wt-sum").trigger("click");
    const items = wrapper.findAll(".wt-item");

    expect(items[0]?.attributes("data-current")).toBe("true");
    expect(items[0]?.find(".wt-marker").text()).toBe("●");
    expect(items[0]?.find(".sr-only").text()).toBe("current");
    expect(items[1]?.find(".wt-marker").text()).toBe("○");
    expect(items[1]?.attributes("data-current")).toBeUndefined();

    // label shows the ~ abbreviation; the full absolute path rides `title` (可见) and the copy button (可复制)
    expect(items[0]?.find(".wt-label").text()).toBe("~/ai/pi-toolkit");
    expect(items[0]?.find(".wt-label").attributes("title")).toBe("/home/dev/ai/pi-toolkit");
    expect(items[0]?.find(".wt-label").attributes("translate")).toBe("no");
    const copy = items[1]?.find(".wt-copy button");
    expect(copy?.exists()).toBe(true);
    expect(copy?.attributes("aria-label")).toBe("Copy worktree path");

    expect(items[0]?.find(".wt-branch").text()).toBe("master");
    expect(items[0]?.find(".wt-head").text()).toBe("0123456");
    expect(items[0]?.find(".wt-status").text()).toBe("clean");
    expect(items[0]?.find(".wt-ab").text()).toBe("↑1");
    expect(items[0]?.find(".wt-ab").attributes("title")).toContain("remote-tracking");

    expect(items[1]?.find(".wt-status").text()).toBe("*3");
    expect(items[1]?.find(".wt-status").attributes("data-kind")).toBe("dirty");

    const flags = (i: number) => items[i]?.findAll(".wt-flag").map((f) => f.text());
    expect(flags(0)).toContain("main");
    expect(flags(2)).toContain("agent");
    expect(flags(1)).toEqual([]);
  });

  it("renders the capped/skipped dirty tokens `*N+` / `*N~` with their restrained tooltips", async () => {
    const wrapper = mountPanel(
      wire({
        rows: [
          { label: "a", path: "/a", branch: "x", head: "1111111", dirty: 120, dirtyCapped: true },
          { label: "b", path: "/b", branch: "y", head: "2222222", dirty: 2, untrackedSkipped: true },
          { label: "c", path: "/c", branch: "z", head: "3333333", dirty: 5, dirtyCapped: true, untrackedSkipped: true },
        ],
        total: 3,
      }),
    );
    await wrapper.find(".wt-sum").trigger("click");
    const tokens = wrapper.findAll(".wt-status");
    expect(tokens[0]?.text()).toBe("*120+");
    expect(tokens[0]?.attributes("title")).toBe("dirty count is a lower bound (status output was capped)");
    expect(tokens[1]?.text()).toBe("*2~");
    expect(tokens[1]?.attributes("title")).toBe("untracked files not counted");
    expect(tokens[2]?.text()).toBe("*5+~");
    expect(tokens[2]?.attributes("title")).toContain("lower bound");
    expect(tokens[2]?.attributes("title")).toContain("untracked");
  });

  it("unprobed rows show `?` with cap/timeout/error tooltips; unknown future reasons fall back to error", async () => {
    const wrapper = mountPanel(
      wire({
        rows: [
          { label: "a", path: "/a", unprobed: "cap" },
          { label: "b", path: "/b", unprobed: "timeout" },
          { label: "c", path: "/c", unprobed: "error" },
          { label: "d", path: "/d", unprobed: "slow-fs" as never },
        ],
        total: 4,
      }),
    );
    await wrapper.find(".wt-sum").trigger("click");
    const tokens = wrapper.findAll(".wt-status");
    expect(tokens.map((x) => x.text())).toEqual(["?", "?", "?", "?"]);
    expect(tokens[0]?.attributes("title")).toBe("not probed: beyond the probe limit");
    expect(tokens[1]?.attributes("title")).toBe("not probed: timed out");
    expect(tokens[2]?.attributes("title")).toBe("probe failed");
    expect(tokens[3]?.attributes("title")).toBe("probe failed"); // unknown ⇒ error wording
  });

  it("future fixture: the unknown `slow-fs` reason renders as `?` and `foo` never reaches the DOM", async () => {
    const wrapper = mountPanel(wireOf("future-row-field"));
    await wrapper.find(".wt-sum").trigger("click");
    const token = wrapper.find(".wt-status");
    expect(token.text()).toBe("?");
    expect(token.attributes("title")).toBe("probe failed");
    expect(wrapper.html()).not.toContain("unexpected-future-row-field");
  });

  it("bare/detached rows: no branch chip for bare, `detached@<sha>` fallback otherwise; flag chips render", async () => {
    const wrapper = mountPanel(
      wire({
        rows: [
          { label: "a", path: "/a", bare: true, main: true },
          { label: "b", path: "/b", head: "ddddddd", locked: true, prunable: true },
        ],
        total: 2,
      }),
    );
    await wrapper.find(".wt-sum").trigger("click");
    const items = wrapper.findAll(".wt-item");
    expect(items[0]?.find(".wt-branch").exists()).toBe(false); // bare: the flag chip says it
    expect(items[0]?.find(".wt-status").exists()).toBe(false); // never probed, no token
    expect(items[0]?.findAll(".wt-flag").map((f) => f.text())).toEqual(["main", "bare"]);
    expect(items[1]?.find(".wt-branch").text()).toBe("detached@ddddddd");
    expect(items[1]?.findAll(".wt-flag").map((f) => f.text())).toEqual(["locked", "prunable"]);
  });

  it("omitted tail line and the muted `last sample` footer (agent clock)", async () => {
    const w = wire({ omitted: 21, staleMin: 3 });
    const wrapper = mountPanel(w);
    await wrapper.find(".wt-sum").trigger("click");
    expect(wrapper.find(".wt-more").text()).toBe("(+21 more)");
    const foot = wrapper.find(".wt-foot");
    expect(foot.text()).toBe(`last sample ${formatSampleTime(w.sampledAt)}`);
    expect(foot.attributes("title")).toContain("agent");
  });

  it("no omitted tail when nothing was dropped", async () => {
    const wrapper = mountPanel(wire());
    await wrapper.find(".wt-sum").trigger("click");
    expect(wrapper.find(".wt-more").exists()).toBe(false);
  });

  it("renders no write-path controls (v1 read-only ruling)", async () => {
    const wrapper = mountPanel(wireOf("v1-status"));
    await wrapper.find(".wt-sum").trigger("click");
    expect(wrapper.findAll(".wt-list input")).toHaveLength(0);
    // the only buttons inside the list are the per-row copy affordances
    for (const b of wrapper.findAll(".wt-list button")) {
      expect(b.attributes("aria-label")).toBe("Copy worktree path");
    }
  });
});

// ---------------------------------------------------------------------------
// worktree-diff plan v3.1 §4.1/§5 D5: the expandable dirty token, the expanded file list and
// the I8 byte pin (no scope / no path / clean rows keep the exact pre-D5 DOM).
// ---------------------------------------------------------------------------

import { ref } from "vue";
import { afterEach, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { HUB_CTX, CONTROL_ENV } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { WtDiffFileList } from "../../../src/web-hub/protocol/worktree-diff.js";

const wtdList = (over: Partial<WtDiffFileList> = {}): WtDiffFileList => ({
  base: "b".repeat(40),
  entries: [
    { path: "src/a.ts", status: "M", add: 3, del: 1 },
    { path: "src/new.ts", status: "A", add: 9, del: 0 },
  ],
  total: 2,
  truncated: false,
  limits: { status: false, files: false, bytes: false },
  ...over,
});

const wtdTransport = () => ({
  files: vi.fn().mockResolvedValue({ ok: true, value: wtdList() }),
  file: vi.fn().mockResolvedValue({
    ok: true,
    value: { base: "b".repeat(40), path: "src/a.ts", kind: "empty", patch: "", bytes: 0, truncated: false },
  }),
});

const session = { sessionId: "s-1", cwd: "/home/dev/repo" };

/** Mount with the D5 injection surface (HUB_CTX + CONTROL_ENV), caps on, transport present. */
const mountScoped = (w: WorktreesWire, transport: ReturnType<typeof wtdTransport> = wtdTransport()) => {
  const hub = {
    state: ref({
      clientId: null,
      hub: { caps: ["wtdiff.v1"] },
      conn: "connected",
      selected: "a-1",
      agents: new Map(),
      order: [],
    }),
    worktreeDiff: transport,
  };
  const env = { authMode: "token" as const, plaintext: false, dialogDrafts: new Map(), noticeExpanded: ref(false) };
  const wrapper = mount(WorktreePanel, {
    props: { worktrees: w, agentKey: "a-1", session },
    global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_ENV as symbol]: env } },
  });
  return { wrapper, transport };
};

const dirtyWire = (): WorktreesWire =>
  wire({
    rows: [
      {
        label: "~/repo",
        path: "/home/dev/repo",
        branch: "master",
        head: "0123456",
        current: true,
        main: true,
        dirty: 3,
      },
    ],
    total: 1,
    dirtyCount: 1,
  });

describe("WorktreePanel.vue — worktree-diff D5 (§4.1)", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("I8 byte pin — no scope: the dirty row's DOM is byte-identical to pre-D5", async () => {
    const wrapper = mountPanel(dirtyWire()); // NO HUB_CTX provide ⇒ scope null
    await wrapper.find(".wt-sum").trigger("click");
    const token = wrapper.find(".wt-status");
    expect(token.element.tagName).toBe("SPAN");
    expect(token.element.outerHTML).toBe('<span class="wt-status" data-kind="dirty">*3</span>');
    expect(wrapper.findAll(".wtd-toggle")).toHaveLength(0);
    expect(wrapper.find(".wt-files-slot").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("wtd-");
  });

  it("I8 byte pin — no scope: a full dirty row (marker→copy button) renders the pre-D5 literal", async () => {
    const wrapper = mountPanel(dirtyWire());
    await wrapper.find(".wt-sum").trigger("click");
    expect(wrapper.find(".wt-item").element.outerHTML).toBe(
      '<li class="wt-item" data-current="true"><span class="wt-marker" aria-hidden="true">●</span><span class="sr-only">current</span><span class="wt-label" translate="no" title="/home/dev/repo">~/repo</span><span class="wt-chip wt-branch" translate="no">master</span><span class="wt-head" translate="no">0123456</span><span class="wt-status" data-kind="dirty">*3</span><!--v-if--><span class="wt-chip wt-flag">main</span><span class="wt-copy"><button class="btn btn-ghost btn-icon" type="button" aria-label="Copy worktree path"><svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg></button><span class="sr-only" role="status"></span></span></li>',
    );
    // the section itself carries no diff markup either
    const html = wrapper.find(".wt-panel").element.outerHTML;
    expect(html.endsWith("</ul></section>")).toBe(true);
  });

  it("I8 byte pin — no path / clean rows render the pre-D5 span even WITH a scope", async () => {
    const w = wire({
      rows: [
        { label: "~/nop", branch: "x", head: "1111111", dirty: 4 }, // dirty but NO path
        { label: "~/clean", path: "/home/dev/clean", branch: "y", head: "2222222", dirty: 0 }, // clean
      ],
      total: 2,
      dirtyCount: 1,
    });
    const { wrapper } = mountScoped(w);
    await wrapper.find(".wt-sum").trigger("click");
    const tokens = wrapper.findAll(".wt-status");
    expect(tokens).toHaveLength(2);
    for (const tk of tokens) expect(tk.element.tagName).toBe("SPAN");
    expect(tokens[0]!.element.outerHTML).toBe('<span class="wt-status" data-kind="dirty">*4</span>');
    expect(tokens[1]!.element.outerHTML).toBe('<span class="wt-status" data-kind="clean">clean</span>');
    expect(wrapper.findAll(".wtd-toggle")).toHaveLength(0);
  });

  it("a diffable row renders button[aria-expanded] with the toggle affordance", async () => {
    const { wrapper } = mountScoped(dirtyWire());
    await wrapper.find(".wt-sum").trigger("click");
    const btn = wrapper.find(".wtd-toggle");
    expect(btn.element.tagName).toBe("BUTTON");
    expect(btn.attributes("aria-expanded")).toBe("false");
    expect(btn.attributes("data-kind")).toBe("dirty");
    expect(btn.attributes("title")).toBe("Show changed files");
    expect(btn.text()).toBe("*3");
    expect(btn.find(".wtd-chev").exists()).toBe(true);
  });

  it("expanding pulls the list once; collapsing keeps the data and never re-pulls", async () => {
    const { wrapper, transport } = mountScoped(dirtyWire());
    await wrapper.find(".wt-sum").trigger("click");
    const btn = wrapper.find(".wtd-toggle");

    await btn.trigger("click");
    expect(transport.files).toHaveBeenCalledTimes(1); // 展开拉一次
    expect(btn.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".wt-files-slot").exists()).toBe(true);
    await flushPromises();
    expect(wrapper.findAll(".wtd-file").length).toBe(2); // the pulled entries

    await btn.trigger("click"); // 收起
    expect(btn.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".wt-files-slot").exists()).toBe(false);
    expect(transport.files).toHaveBeenCalledTimes(1); // 收起不重拉

    await btn.trigger("click"); // re-expand: the kept data, still no new pull
    expect(transport.files).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".wt-files-slot").exists()).toBe(true);
  });

  it("a row sig change re-pulls the expanded list after the 3 s debounce (not before)", async () => {
    vi.useFakeTimers();
    const { wrapper, transport } = mountScoped(dirtyWire());
    await wrapper.find(".wt-sum").trigger("click");
    await wrapper.find(".wtd-toggle").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.files).toHaveBeenCalledTimes(1);

    const changed = dirtyWire();
    (changed.rows[0] as { dirty: number }).dirty = 9; // the sig moved (head|dirty|…|…)
    await wrapper.setProps({ worktrees: changed });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(transport.files).toHaveBeenCalledTimes(1); // still inside the window
    await vi.advanceTimersByTimeAsync(2);
    expect(transport.files).toHaveBeenCalledTimes(2); // debounced re-pull fired
  });

  it("clicking a file entry opens the teleported diff dialog", async () => {
    const { wrapper, transport } = mountScoped(dirtyWire());
    await wrapper.find(".wt-sum").trigger("click");
    await wrapper.find(".wtd-toggle").trigger("click");
    await flushPromises();
    await wrapper.find(".wtd-file").trigger("click");
    await flushPromises();
    expect(transport.file).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".wtd-panel")).not.toBeNull(); // teleported to <body>
    expect(document.querySelector(".wtd-panel")!.getAttribute("role")).toBe("dialog");
    // closing through the dialog's close button tears it down
    (document.querySelector(".wtd-close") as HTMLElement).click();
    await flushPromises();
    expect(document.querySelector(".wtd-panel")).toBeNull();
  });

  it("without the wtdiff.v1 cap the panel DOM matches the no-scope byte pin", async () => {
    const hub = {
      state: ref({
        clientId: null,
        hub: { caps: [] },
        conn: "connected",
        selected: "a-1",
        agents: new Map(),
        order: [],
      }),
      worktreeDiff: wtdTransport(),
    };
    const env = { authMode: "token" as const, plaintext: false, dialogDrafts: new Map(), noticeExpanded: ref(false) };
    const wrapper = mount(WorktreePanel, {
      props: { worktrees: dirtyWire(), agentKey: "a-1", session },
      global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_ENV as symbol]: env } },
    });
    await wrapper.find(".wt-sum").trigger("click");
    expect(wrapper.find(".wt-status").element.outerHTML).toBe('<span class="wt-status" data-kind="dirty">*3</span>');
    expect(wrapper.findAll(".wtd-toggle")).toHaveLength(0);
  });
});
