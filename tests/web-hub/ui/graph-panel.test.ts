// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../../src/web-hub/ui/src/components/detail/GraphPanel.vue";
import WorktreePanel from "../../../src/web-hub/ui/src/components/detail/WorktreePanel.vue";
import { useI18n, resetLangForTests } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { WorktreesWire } from "../../../src/web-hub/protocol/messages.js";
import { CONTROL_ENV, HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { ref } from "vue";

const wire = (
  rows = [{ label: "~/repo", path: "/home/dev/repo", branch: "master", head: "0123456", current: true, main: true }],
): WorktreesWire => ({
  rows,
  total: rows.length,
  probed: rows.length,
  dirtyCount: 0,
  agentCount: 0,
  sampledAt: 1_700_000_000_000,
});
const payload = {
  v: 1,
  n: 200,
  format: "sha1",
  head: { h: "c".repeat(40), b: "master" },
  commits: [{ h: "c".repeat(40), p: [], a: "Dev", t: 1_700_000_000, s: "root" }],
  refs: [],
  wtHeads: [],
  degrade: {},
  complete: true,
};
function mountPanel(
  w = wire(),
  loader?: () => Promise<typeof import("../../../src/web-hub/ui/src/components/graph/WorktreeGraph.vue")>,
) {
  const graph = { graph: vi.fn().mockResolvedValue({ ok: true, value: payload }) };
  const hub = { state: ref({ hub: { caps: ["wtgraph.v1"] } }), worktreeGraph: graph };
  const env = { authMode: "token" as const };
  const wrapper = mount(GraphPanel, {
    props: {
      worktrees: w,
      agentKey: "a-1",
      session: { sessionId: "s-1" } as never,
      ...(loader ? { graphLoader: loader } : {}),
    },
    global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_ENV as symbol]: env } },
  });
  return { wrapper, graph };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("GraphPanel", () => {
  afterEach(() => resetLangForTests());

  it("uses the branch glyph, running tint, and locale labels; WorktreePanel uses layers", () => {
    const { wrapper } = mountPanel();
    expect(wrapper.find(".wt-sum .icon-sm use").attributes("href")).toBe("#i-branch");
    const css = readFileSync(resolve("src/web-hub/ui/src/styles/worktrees.css"), "utf8");
    expect(css).toContain(".graph-panel .gg-sum-icon");
    expect(css).toContain("color: var(--st-running)");
    expect(useI18n(["en"]).t("graph.headLabel", { n: 200 })).toBe("git graph · last 200 commits");
    expect(useI18n(["zh"]).t("graph.headLabel", { n: 200 })).toBe("git graph · 最近 200 条提交");
    const wt = mount(WorktreePanel, { props: { worktrees: wire() } });
    expect(wt.find(".wt-sum .icon-sm use").attributes("href")).toBe("#i-layers");
  });

  it("keeps gitGraph out of the main-chunk panel and header", () => {
    for (const file of [
      "src/web-hub/ui/src/components/detail/GraphPanel.vue",
      "src/web-hub/ui/src/components/detail/WorktreePanel.vue",
      "src/web-hub/ui/src/components/detail/DetailHeader.vue",
    ]) {
      const source = readFileSync(resolve(file), "utf8");
      expect(source).not.toMatch(/from [\"'][^\"']*@logic\/gitGraph(?:Merged)?(?:\.ts|\.js)[\"']/);
      expect(source).not.toMatch(/import\([^)]*gitGraph(?:Merged)?(?:\.ts|\.js)/);
    }
  });

  it("mounts only with a valid graph scope and picked worktree", () => {
    expect(mountPanel().wrapper.find(".gg-section").exists()).toBe(true);
    expect(mountPanel(wire([])).wrapper.find(".gg-section").exists()).toBe(false);
  });
  it("has one sibling summary toggle and stays collapsed without loading or requesting", async () => {
    const { wrapper, graph } = mountPanel();
    expect(wrapper.findAll("button")).toHaveLength(1);
    expect(wrapper.find(".wt-sum").attributes("aria-expanded")).toBe("false");
    expect(graph.graph).not.toHaveBeenCalled();
    // Pre-warm the lazy SFC chunk: its first vitest transform can outlast settle()'s
    // fixed microtask/macrotask budget when run in isolation or under load (#20).
    await import("../../../src/web-hub/ui/src/components/graph/WorktreeGraph.vue");
    await wrapper.find(".wt-sum").trigger("click");
    await wrapper.vm.$nextTick();
    await settle();
    await vi.waitFor(() => expect(graph.graph).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(wrapper.find(".gg-sum").exists()).toBe(false);
  });
  it("retries a failed lazy import", async () => {
    const chunk = await import("../../../src/web-hub/ui/src/components/graph/WorktreeGraph.vue");
    const loader = vi
      .fn<() => Promise<typeof chunk>>()
      .mockRejectedValueOnce(new Error("chunk"))
      .mockResolvedValue(chunk);
    const { wrapper } = mountPanel(wire(), loader);
    wrapper.vm.$.appContext.config.errorHandler = () => undefined;
    await wrapper.find(".wt-sum").trigger("click");
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
    await wrapper.find(".wt-sum").trigger("click");
    await wrapper.find(".wt-sum").trigger("click");
    await settle();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
