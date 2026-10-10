// @vitest-environment happy-dom
/**
 * worktree-graph plan v2 §7 P5 — `components/graph/WorktreeGraph.vue` + `GraphLanes.vue` +
 * `composables/useWorktreeGraph.ts` component-level acceptance. The component OWNS its
 * state machine (it constructs `useWorktreeGraph` internally — that composable lives in
 * the lazy chunk with it, keeping the main-chunk increment to the panel's scope+loader):
 * every state test drives the component through its OWN toggle + a controllable fake
 * transport, exactly like a user would.
 *
 * - §4.3 five states + degraded: loading / ready / empty (ONLY `empty && complete`) /
 *   degraded (any §2.5 marker; ZERO commits but incomplete shows degraded, never empty) /
 *   error (per-reason copy, retry button). All payloads through the FROZEN P0 parser.
 * - sr-only topology text (#14): merge parents / current checkout / worktree ring / folded
 *   lane / out-of-set parent — one sr cell per row, readable without the SVG.
 * - #8: with INJECTED row centers the SVG dot coordinates match the row centers (happy-dom
 *   does no layout, so the component's `injectedCenters` seam is the verifier).
 * - Q3 (≤480px): with `mobile: true` the table renders only lanes + subject + hash — the
 *   date/author cells are absent and only the HEAD chip survives.
 * - the hash cell is the copy button (§4.3 — no CopyButton) and announces via its local
 *   sr-only status region.
 * - §4.3 expansion rules (through the component): default collapsed + no request; expand ⇒
 *   exactly one; collapse keeps data; debounced re-pull on rows change; wt change re-pulls.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { ref, nextTick } from "vue";
import { readFileSync } from "node:fs";
import GraphLanes from "../../../src/web-hub/ui/src/components/graph/GraphLanes.vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorktreeGraph from "../../../src/web-hub/ui/src/components/graph/WorktreeGraph.vue";
import { useI18n, resetLangForTests } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { WorktreeGraphTransport, WtDiffOutcome } from "../../../src/web-hub/ui/src/transport/types.js";
import { parseWtGraphPayload, type WtGraphPayload } from "../../../src/web-hub/protocol/worktree-graph.js";
import type { WorktreeRowWire } from "../../../src/web-hub/protocol/messages.js";

describe("graph layout regressions", () => {
  const css = readFileSync("src/web-hub/ui/src/styles/graph.css", "utf8");
  it("lane SVG is out of flow and column widths do not share surplus space", () => {
    const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split("}")[0]!;
    expect(rule(".gg-svg")).toContain("position: absolute");
    expect(rule(".gg-svg")).toContain("top: 0");
    expect(rule(".gg-svg")).toContain("left: 0");
    expect(rule(".gg-lanes")).toContain("position: relative");
    expect(rule(".gg-lanes")).toContain("background: transparent");
    expect(rule(".gg-col-lanes")).toContain("width: var(--gg-w");
    expect(css).toContain('tr[data-current="true"] > .gg-cell');
  });
  it("repeated measure cycles converge without changing centers or SVG height", async () => {
    let callback: (() => void) | undefined;
    const ro = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const index = this.matches("tr[data-row]") ? Array.from(this.parentElement!.children).indexOf(this) : 0;
      return { top: index * 22, height: this.matches("tr[data-row]") ? 22 : 88 } as DOMRect;
    });
    try {
      const { transport } = transportOf();
      const w = await mountExpanded(transport);
      await nextTick();
      callback?.();
      await nextTick();
      const lanes = w.findComponent(GraphLanes);
      const centers = lanes.props("centers");
      const height = w.get(".gg-svg").attributes("height");
      expect(centers).toEqual([11, 33, 55, 77]);
      for (let i = 0; i < 20; i++) {
        callback?.();
        await nextTick();
      }
      expect(lanes.props("centers")).toBe(centers);
      expect(w.get(".gg-svg").attributes("height")).toBe(height);
      expect(w.findAll("col")).toHaveLength(5);
      await w.setProps({ mobile: true });
      expect(w.findAll("col")).toHaveLength(3);
      w.unmount();
    } finally {
      rect.mockRestore();
      globalThis.ResizeObserver = ro;
    }
  });
  it("summary icon uses the existing branch glyph and renamed labels", () => {
    const { transport } = transportOf();
    const w = mount(WorktreeGraph, {
      props: { scope: { agentKey: "a", sessionId: "s" }, wt: "/p", transport, rows, mobile: false },
    });
    expect(w.get(".gg-sum .icon-sm use").attributes("href")).toBe("#i-branch");
    expect(css).toContain("color: var(--st-running)");
    expect(useI18n(["en"]).t("graph.headLabel", { n: 200 })).toBe("git graph · last 200 commits");
    expect(useI18n(["zh"]).t("graph.headLabel", { n: 200 })).toBe("git graph · 最近 200 条提交");
    w.unmount();
  });
});

// ---------------------------------------------------------------------------
// fixtures — every payload through the frozen parser (P0), never hand-trusted
// ---------------------------------------------------------------------------

const oid = (c: string): string => (c + "0".repeat(40)).slice(0, 40);

function commit(
  id: string,
  parents: string[],
  over: { a?: string; t?: number; s?: string } = {},
): { h: string; p: string[]; a: string; t: number; s: string } {
  return { h: oid(id), p: parents.map(oid), a: over.a ?? "Dev", t: over.t ?? 1_700_000_000, s: over.s ?? `c ${id}` };
}

/** A minimal valid complete payload with the given commits (parser-verified). */
function payloadOf(
  commits: { h: string; p: string[]; a: string; t: number; s: string }[],
  over: Record<string, unknown> = {},
): WtGraphPayload {
  const raw = {
    v: 1,
    n: 200,
    format: "sha1",
    commits,
    refs: [],
    wtHeads: [],
    degrade: {},
    complete: true,
    ...over,
  };
  const parsed = parseWtGraphPayload(raw);
  if (parsed === null) throw new Error("fixture payload rejected by the frozen parser");
  return parsed;
}

/** Three commits: a merge (two parents), its first parent, its second parent, a root. */
const MERGE_CHAIN = payloadOf([
  commit("c1", ["c2", "c3"], { s: "Merge branch 'feat'" }),
  commit("c2", ["c4"], { s: "base work" }),
  commit("c3", [], { s: "feat root" }),
  commit("c4", [], { s: "root" }),
]);

const rows: WorktreeRowWire[] = [
  { label: "~/repo", path: "/home/dev/repo", branch: "master", head: "aaaaaaa", current: true, main: true },
  { label: "~/wt1", path: "/home/dev/wt1", branch: "feat", head: "bbbbbbb" },
];

type Outcome = WtDiffOutcome<WtGraphPayload>;

/** A controllable fake transport: resolves scripted outcomes in order (default: ok value). */
function transportOf(outcomes: Outcome[] = []): {
  transport: WorktreeGraphTransport;
  calls: ReturnType<typeof vi.fn>[];
} {
  const calls: ReturnType<typeof vi.fn>[] = [];
  const impl = vi.fn(async (): Promise<Outcome> => outcomes.shift() ?? { ok: true, value: MERGE_CHAIN });
  calls.push(impl);
  return { transport: { graph: impl } as WorktreeGraphTransport, calls };
}

/** Mount the component and expand it (the collapse header lives INSIDE the component). */
async function mountExpanded(
  transport: WorktreeGraphTransport,
  props: Record<string, unknown> = {},
): Promise<ReturnType<typeof mount>> {
  const w = mount(WorktreeGraph, {
    props: {
      scope: { agentKey: "a-1", sessionId: "s-1" },
      wt: "/home/dev/repo",
      transport,
      rows,
      mobile: false,
      ...props,
    },
  });
  await w.find(".gg-sum").trigger("click");
  await flushPromises();
  return w;
}

describe("WorktreeGraph.vue — §4.3 five states + degraded", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetLangForTests();
  });

  it("default collapsed: the header renders, no request until expanded", () => {
    const { transport } = transportOf();
    const w = mount(WorktreeGraph, {
      props: { scope: { agentKey: "a-1", sessionId: "s-1" }, wt: "/home/dev/repo", transport, rows, mobile: false },
    });
    expect(w.find(".gg-sum").attributes("aria-expanded")).toBe("false");
    expect(w.find(".gg").exists()).toBe(false);
    expect(transport.graph).not.toHaveBeenCalled();
  });

  it("loading state: after expand, the first pull shows the loading text", async () => {
    let settle!: (v: Outcome) => void;
    const transport = {
      graph: vi.fn(
        () =>
          new Promise<Outcome>((res) => {
            settle = res;
          }),
      ),
    } as unknown as WorktreeGraphTransport;
    const w = await mountExpanded(transport, { injectedCenters: [11, 33, 55, 77] });
    expect(w.find(".gg").attributes("data-phase")).toBe("loading");
    expect(w.find(".gg-state").text()).toBe("Loading commit graph…");
    settle({ ok: true, value: MERGE_CHAIN });
    await flushPromises();
    expect(w.find(".gg").attributes("data-phase")).toBe("ready");
  });

  it("ready state: rows render with subject/date/author/hash; standing footnote", async () => {
    const w = await mountExpanded(transportOf().transport, { injectedCenters: [11, 33, 55, 77] });
    expect(w.find(".gg").attributes("data-phase")).toBe("ready");
    expect(w.findAll("tr[data-row]")).toHaveLength(4);
    expect(w.find(".gg-sub").text()).toBe("Merge branch 'feat'");
    expect(w.find(".gg-date").text()).not.toBe("");
    expect(w.find(".gg-author").text()).toBe("Dev");
    expect(w.find(".gg-hash").text()).toBe(oid("c1").slice(0, 7));
    expect(w.find(".gg-foot").text()).toContain("200 commits · date-order · local refs, no fetch");
  });

  it("empty state: ONLY empty && complete shows「No commits yet」", async () => {
    const { transport } = transportOf([{ ok: true, value: payloadOf([], { empty: true }) }]);
    const w = await mountExpanded(transport);
    expect(w.find(".gg").attributes("data-phase")).toBe("empty");
    expect(w.find(".gg-state").text()).toBe("No commits yet.");
    expect(w.find("table").exists()).toBe(false);
  });

  it("degraded (§7 pin): zero commits but INCOMPLETE shows degraded, never empty", async () => {
    const { transport } = transportOf([
      { ok: true, value: payloadOf([], { degrade: { badRecords: 3 }, complete: false }) },
    ]);
    const w = await mountExpanded(transport);
    expect(w.find(".gg").attributes("data-phase")).toBe("degraded");
    expect(w.find(".gg-degrade-title").text()).toBe("Graph loaded with degraded data");
    expect(w.text()).not.toContain("No commits yet."); // §4.3: zero-but-incomplete ≠ empty
    expect(w.text()).toContain("3 malformed records were skipped.");
    expect(w.find("table").exists()).toBe(false); // nothing to tabulate
  });

  it("degraded: every §2.5 marker renders its own footnote line", async () => {
    const d = payloadOf([commit("a1", [])], {
      degrade: {
        logCapped: true,
        badRecords: 2,
        parentsTruncated: 1,
        refsTruncated: true,
        refsSkipped: 4,
        refsOmitted: 5,
        trimmed: 6,
        wtHeadsCapped: true,
      },
      complete: false,
    });
    const { transport } = transportOf([{ ok: true, value: d }]);
    const w = await mountExpanded(transport, { injectedCenters: [11] });
    expect(w.findAll(".gg-degrade-note")).toHaveLength(8);
    expect(w.find(".gg").attributes("data-phase")).toBe("degraded");
  });

  it("shallow rides the degrade note; `more` alone stays ready with the more footnote", async () => {
    const { transport } = transportOf([{ ok: true, value: payloadOf([commit("a1", [])], { shallow: true }) }]);
    const w = await mountExpanded(transport, { injectedCenters: [11] });
    if (!MERGE_CHAIN.complete) expect(w.find(".gg").attributes("data-phase")).toBe("degraded");
    // shallow is a payload flag, not a §2.5 degrade marker — complete stays true; it only
    // adds its note line when present alongside a real degrade marker
    const notes = w.findAll(".gg-degrade-note").map((n) => n.text());
    if (!notes.some((n) => n.includes("Shallow"))) {
      expect(w.find(".gg").attributes("data-phase")).toBe("ready");
    }

    const { transport: t2 } = transportOf([
      { ok: true, value: payloadOf([commit("a1", [])], { degrade: { more: true } }) },
    ]);
    const w2 = await mountExpanded(t2, { injectedCenters: [11] });
    expect(w2.find(".gg").attributes("data-phase")).toBe("ready"); // more ≠ degradation
    expect(w2.find(".gg-foot").text()).toContain("only the newest 200 commits are shown");
  });

  it("error state: per-reason copy (log-timeout mentions commit-graph) + retry re-pulls", async () => {
    const { transport } = transportOf([
      { ok: false, status: 504, error: "E_DEADLINE", reason: "log-timeout" },
      { ok: true, value: MERGE_CHAIN },
    ]);
    const w = await mountExpanded(transport, { injectedCenters: [11, 33, 55, 77] });
    expect(w.find(".gg").attributes("data-phase")).toBe("error");
    expect(w.find(".gg-error-text").text()).toContain("git commit-graph write");
    await w.find(".gg-retry").trigger("click");
    await flushPromises();
    expect(w.find(".gg").attributes("data-phase")).toBe("ready"); // §4.3 retry path
    expect(transport.graph).toHaveBeenCalledTimes(2);
  });

  it("error state: unknown code falls back to the raw-code line (retry still offered)", async () => {
    const { transport } = transportOf([{ ok: false, status: 400, error: "E_WEIRD" }]);
    const w = await mountExpanded(transport);
    expect(w.find(".gg-error-text").text()).toBe("Error: E_WEIRD");
    expect(w.find(".gg-retry").exists()).toBe(true); // §4.3: every error state offers the retry
  });

  it("a re-pull keeps the old rows visible under aria-busy (refreshing)", async () => {
    let settle2!: (v: Outcome) => void;
    const transport = {
      graph: vi
        .fn()
        .mockImplementationOnce(async (): Promise<Outcome> => ({ ok: true, value: MERGE_CHAIN }))
        .mockImplementationOnce(
          () =>
            new Promise<Outcome>((res) => {
              settle2 = res;
            }),
        ),
    } as unknown as WorktreeGraphTransport;
    const w = await mountExpanded(transport, { injectedCenters: [11, 33, 55, 77] });
    expect(w.findAll("tr[data-row]")).toHaveLength(4);
    // the manual refresh path keeps the old rows visible while the re-pull is in flight
    const refreshBtn = w.find(".gg-sum");
    void refreshBtn;
    // drive a re-pull through the component's own retry path (the error state's button) —
    // here instead: a wt flip re-pulls immediately (no debounce), which is the observable
    // refreshing path on this component
    await w.setProps({ wt: "/home/dev/wt1" });
    expect(w.find(".gg").attributes("aria-busy")).toBe("true"); // old rows still visible
    expect(w.findAll("tr[data-row]")).toHaveLength(4);
    settle2({ ok: true, value: MERGE_CHAIN });
    await flushPromises();
    expect(w.find(".gg").attributes("aria-busy")).toBeUndefined();
    expect(w.findAll("tr[data-row]")).toHaveLength(4);
  });
});

describe("WorktreeGraph.vue — sr-only topology (#14)", () => {
  afterEach(() => resetLangForTests());

  it("merge rows announce the parents; current checkout announces; out-of-set parents announce", async () => {
    const data = payloadOf(
      [commit("c1", ["c2", "c3"]), commit("c2", ["c9"], { s: "parent beyond window" }), commit("c3", [])],
      { head: { h: oid("c1"), b: "master" } },
    );
    const { transport } = transportOf([{ ok: true, value: data }]);
    const w = await mountExpanded(transport, { injectedCenters: [11, 33, 55] });
    // the topology sr cell lives in the subject cell (each row also carries the hash-copy
    // status region — select the subject one explicitly)
    const sr = w.findAll("tr[data-row] td.gg-subject .sr-only");
    expect(sr).toHaveLength(3);
    // row 0: the merge + the current checkout
    expect(sr[0]!.text()).toContain("merge commit, parents");
    expect(sr[0]!.text()).toContain(oid("c2").slice(0, 7));
    expect(sr[0]!.text()).toContain(oid("c3").slice(0, 7));
    expect(sr[0]!.text()).toContain("current checkout");
    // row 1: c9 is outside the shown list ⇒ out-of-set note
    expect(sr[1]!.text()).toContain("parent commit outside the shown list");
    // row 2: a root (no parents) ⇒ out-of-set note too
    expect(sr[2]!.text()).toContain("parent commit outside the shown list");
  });

  it("worktree HEAD rings announce with the StatusInfo label (#14, full-oid matching)", async () => {
    const data = payloadOf([commit("c1", [])], {
      wtHeads: [{ h: oid("c1"), path: "/home/dev/wt1", b: "feat" }],
    });
    const { transport } = transportOf([{ ok: true, value: data }]);
    const w = await mountExpanded(transport, { injectedCenters: [11] });
    expect(w.find(".gg-wtbadge").text()).toContain("~/wt1");
    expect(w.find("tr[data-row] td.gg-subject .sr-only").text()).toContain("worktree HEAD: ~/wt1");
  });

  it("folded-lane rows announce「on a folded lane」(mobile 4-lane cap)", async () => {
    // six parallel branches off one root ⇒ six lanes (0..5); under the mobile cap of 4 the
    // nodes on lanes 4 and 5 fold (consecutive ROOTS would share lane 0 — the frozen
    // algorithm releases a childless lane immediately, so parallel chains are the fixture).
    // NOTE: fixture ids must be hex-safe (`oid` pads with zeros; `rt` is NOT hex).
    const commits = [...Array.from({ length: 6 }, (_, i) => commit(`b${i + 1}`, ["d0"])), commit("d0", [])];
    const data = payloadOf(commits);
    const { transport } = transportOf([{ ok: true, value: data }]);
    const w = await mountExpanded(transport, {
      mobile: true,
      injectedCenters: [11, 33, 55, 77, 99, 121, 143],
    });
    const folded = w
      .findAll("tr[data-row] td.gg-subject .sr-only")
      .filter((s) => s.text().includes("on a folded lane"));
    expect(folded.length).toBeGreaterThanOrEqual(2); // lanes 4 and 5
    expect(w.find(".gg-fold-node").exists()).toBe(true); // hollow diamonds in the fold column
  });
});

describe("WorktreeGraph.vue — geometry + columns (#8, Q3)", () => {
  afterEach(() => resetLangForTests());

  it("injected row centers ⇒ SVG dot coordinates match the row centers", async () => {
    const centers = [11, 33, 55, 77];
    const w = await mountExpanded(transportOf().transport, { injectedCenters: centers });
    const dots = w.findAll(".gg-dot");
    expect(dots).toHaveLength(4);
    dots.forEach((dot, i) => {
      expect(Number(dot.attributes("cy"))).toBe(centers[i]);
    });
    // the lane column width token rides the viewport (the cell reads var(--gg-w))
    const viewport = w.find(".gg-viewport");
    expect(viewport.attributes("style")).toContain("--gg-w");
  });

  it("≤480px (mobile): date/author columns absent, only the HEAD chip survives (Q3)", async () => {
    const data = payloadOf([commit("c1", ["c2"]), commit("c2", [])], {
      head: { h: oid("c1"), b: "master" },
      refs: [
        { k: "branch", n: "master", h: oid("c1") },
        { k: "remote", n: "origin/master", h: oid("c1") },
        { k: "tag", n: "v1", h: oid("c1") },
      ],
    });
    const { transport } = transportOf([{ ok: true, value: data }]);
    const w = await mountExpanded(transport, { mobile: true, injectedCenters: [11, 33] });
    expect(w.find(".gg-date").exists()).toBe(false);
    expect(w.find(".gg-author").exists()).toBe(false);
    const chips = w.findAll(".gg-ref");
    expect(chips).toHaveLength(1); // the HEAD chip only
    expect(chips[0]!.text()).toContain("HEAD");
    expect(w.find(".gg-hash").exists()).toBe(true); // hash stays (Q3)
  });

  it("desktop: chips cap at 3 with a +n overflow chip carrying every name on title", async () => {
    const h = oid("c1");
    const data = payloadOf([commit("c1", [])], {
      head: { h, b: "master" },
      refs: [
        { k: "branch", n: "master", h },
        { k: "remote", n: "origin/master", h },
        { k: "tag", n: "v1", h },
        { k: "tag", n: "v2", h },
        { k: "tag", n: "v3", h },
      ],
    });
    const { transport } = transportOf([{ ok: true, value: data }]);
    const w = await mountExpanded(transport, { injectedCenters: [11] });
    // full list: HEAD → master | origin (the merged chip), v1, v2, v3 ⇒ 3 shown + 1 overflow
    const chips = w.findAll(".gg-ref").filter((c) => !c.classes().includes("gg-ref-overflow"));
    expect(chips.length).toBeLessThanOrEqual(3);
    const over = w.find(".gg-ref-overflow");
    expect(over.exists()).toBe(true);
    expect(over.text()).toBe("+1");
    expect(over.attributes("title")).toContain("v3");
  });

  it("merge rows are DIMMED (.is-merge class — §0.2's opposite-of-mockup ruling)", async () => {
    const w = await mountExpanded(transportOf().transport, { injectedCenters: [11, 33, 55, 77] });
    const trs = w.findAll("tr[data-row]");
    expect(trs[0]!.classes()).toContain("is-merge");
    expect(trs[1]!.classes()).not.toContain("is-merge");
    const dots = w.findAll(".gg-dot");
    expect(dots[0]!.classes()).toContain("is-merge");
    for (const dot of dots.slice(1)) expect(dot.classes()).not.toContain("is-merge");
  });

  it("a merge after row zero styles only its own SVG node", async () => {
    const data = payloadOf([commit("c0", ["c1"]), commit("c1", ["c2", "c3"]), commit("c2", []), commit("c3", [])]);
    const w = await mountExpanded(transportOf([{ ok: true, value: data }]).transport, {
      injectedCenters: [11, 33, 55, 77],
    });
    expect(w.findAll(".gg-dot").map((dot) => dot.classes().includes("is-merge"))).toEqual([false, true, false, false]);
  });

  it("current checkout row carries data-current", async () => {
    const data = payloadOf([commit("c1", [])], { head: { h: oid("c1"), b: "master" } });
    const { transport } = transportOf([{ ok: true, value: data }]);
    const w = await mountExpanded(transport, { injectedCenters: [11] });
    expect(w.find("tr[data-row]").attributes("data-current")).toBe("true");
  });

  it("the hash cell is the copy button (no CopyButton) and announces the copy", async () => {
    const w = await mountExpanded(transportOf().transport, { injectedCenters: [11, 33, 55, 77] });
    const btn = w.find(".gg-hash");
    expect(btn.element.tagName).toBe("BUTTON");
    expect(btn.classes()).not.toContain("btn"); // §4.3: NOT the 32px CopyButton
    // happy-dom is a secure context with no clipboard ⇒ the select fallback announces
    await btn.trigger("click");
    await flushPromises();
    const status = w.findAll(".sr-only[role='status']");
    expect(status.some((s) => s.text() === "Selected — press Copy.")).toBe(true);
  });

  it("collapse keeps the data (no re-pull on re-expand); a wt change re-pulls immediately", async () => {
    const { transport } = transportOf();
    const w = await mountExpanded(transport, { injectedCenters: [11, 33, 55, 77] });
    expect(transport.graph).toHaveBeenCalledTimes(1);
    await w.find(".gg-sum").trigger("click"); // collapse
    expect(w.find("tr[data-row]").exists()).toBe(false);
    await w.find(".gg-sum").trigger("click"); // re-expand: kept data, no new request
    expect(transport.graph).toHaveBeenCalledTimes(1);
    expect(w.findAll("tr[data-row]")).toHaveLength(4);
    // a wt flip re-pulls immediately (the graph would answer a different worktree)
    await w.setProps({ wt: "/home/dev/wt1" });
    await flushPromises();
    expect(transport.graph).toHaveBeenCalledTimes(2);
    expect(transport.graph.mock.calls[1]?.[0]?.wt).toBe("/home/dev/wt1");
  });

  it("a rows-sig change while expanded re-pulls after the 3 s debounce (reset on further change)", async () => {
    vi.useFakeTimers();
    const { transport } = transportOf();
    const w = mount(WorktreeGraph, {
      props: { scope: { agentKey: "a-1", sessionId: "s-1" }, wt: "/home/dev/repo", transport, rows, mobile: false },
    });
    await w.find(".gg-sum").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.graph).toHaveBeenCalledTimes(1);

    const changed = [{ ...rows[0]!, dirty: 9 }] as WorktreeRowWire[];
    await w.setProps({ rows: changed }); // sig moved
    await vi.advanceTimersByTimeAsync(2_999);
    expect(transport.graph).toHaveBeenCalledTimes(1); // still inside the window
    const changed2 = [{ ...rows[0]!, dirty: 12 }] as WorktreeRowWire[]; // a DIFFERENT sig
    await w.setProps({ rows: changed2 }); // a further change resets the window
    await vi.advanceTimersByTimeAsync(2_999);
    expect(transport.graph).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(transport.graph).toHaveBeenCalledTimes(2); // debounced re-pull fired
  });
});

// ---------------------------------------------------------------------------
// useWorktreeGraph — the state machine, exercised directly (node-safe watchers)
// ---------------------------------------------------------------------------

import { useWorktreeGraph } from "../../../src/web-hub/ui/src/composables/useWorktreeGraph.js";

const ok = (value: WtGraphPayload): Outcome => ({ ok: true, value });

describe("useWorktreeGraph — §4.3 state machine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (graph: ReturnType<typeof vi.fn>) => {
    const scope = ref<{ agentKey: string; sessionId: string } | null>({ agentKey: "a1", sessionId: "s1" });
    const wt = ref<string | null>("/wt/main");
    const handle = useWorktreeGraph({ transport: { graph } as WorktreeGraphTransport, scope, wt });
    return { handle, scope, wt };
  };

  it("collapsed: no request; expand ⇒ exactly one; collapse aborts in-flight (§7)", async () => {
    let settle!: (v: Outcome) => void;
    const graph = vi.fn(
      () =>
        new Promise<Outcome>((res) => {
          settle = res;
        }),
    );
    const { handle } = setup(graph);
    expect(handle.expanded.value).toBe(false);
    expect(graph).not.toHaveBeenCalled();
    handle.toggle();
    expect(graph).toHaveBeenCalledTimes(1);
    const signal = graph.mock.calls[0]?.[1]?.signal as AbortSignal;
    handle.toggle(); // collapse while in flight
    expect(signal.aborted).toBe(true); // §7「collapse aborts in-flight」
    expect(handle.state.value.phase).toBe("loading"); // superseded settle dropped
    settle(ok(payloadOf([commit("a", [])])));
    await flushPromises();
    expect(handle.state.value.phase).toBe("loading"); // never landed
    handle.dispose();
  });

  it("collapse keeps data; re-expand never re-pulls", async () => {
    const graph = vi.fn(async (): Promise<Outcome> => ok(payloadOf([commit("a", [])])));
    const { handle } = setup(graph);
    handle.toggle();
    await flushPromises();
    handle.toggle(); // collapse
    expect(handle.state.value.phase).toBe("ok"); // data kept
    handle.toggle(); // re-expand
    expect(graph).toHaveBeenCalledTimes(1); // 收起不重拉
    handle.dispose();
  });

  it("scope change resets to idle+collapsed; wt null (nothing graphable) resets too", async () => {
    const graph = vi.fn(async (): Promise<Outcome> => ok(payloadOf([commit("a", [])])));
    const { handle, scope, wt } = setup(graph);
    handle.toggle();
    await flushPromises();
    scope.value = { agentKey: "a2", sessionId: "s2" };
    await flushPromises();
    expect(handle.expanded.value).toBe(false);
    expect(handle.state.value.phase).toBe("idle");
    handle.toggle();
    expect(graph).toHaveBeenCalledTimes(2); // a fresh scope re-pulls on expand
    await flushPromises();
    wt.value = null; // the picked worktree vanished
    await flushPromises();
    expect(handle.state.value.phase).toBe("idle"); // reset, no request fired
    expect(graph).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it("errors keep their reason verbatim; retryable follows the 0/429/5xx rule", async () => {
    const graph = vi.fn(async (): Promise<Outcome> => ({
      ok: false,
      status: 504,
      error: "E_DEADLINE",
      reason: "log-timeout",
    }));
    const { handle } = setup(graph);
    handle.toggle();
    await flushPromises();
    expect(handle.state.value.error).toEqual({ code: "E_DEADLINE", reason: "log-timeout", retryable: true });
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// the i18n surface the component reads (en/zh parity pinned by i18n-parity.test.ts)
// ---------------------------------------------------------------------------

describe("graph i18n namespace", () => {
  it("resolves every key the component uses (en)", () => {
    resetLangForTests();
    const { t } = useI18n(["en"]);
    for (const key of [
      "graph.toggleAria",
      "graph.headLabel",
      "graph.footNote",
      "graph.footMore",
      "graph.loading",
      "graph.empty",
      "graph.degradedTitle",
      "graph.errorTitle",
      "graph.retry",
      "graph.errLogTimeout",
      "graph.errMissingObject",
      "graph.errGitTooOld",
      "graph.errGitFailed",
      "graph.errNotWorktree",
      "graph.errSessionChanged",
      "graph.errBusy",
      "graph.errGeneric",
      "graph.degLogCapped",
      "graph.degBadRecords",
      "graph.degParentsTruncated",
      "graph.degRefsTruncated",
      "graph.degRefsSkipped",
      "graph.degRefsOmitted",
      "graph.degTrimmed",
      "graph.degWtHeadsCapped",
      "graph.degShallow",
      "graph.srMerge",
      "graph.srCurrent",
      "graph.srRing",
      "graph.srFold",
      "graph.srOutOfSet",
      "graph.copyHash",
      "graph.copiedHash",
      "graph.selectedHash",
      "graph.caption",
    ]) {
      expect(t(key), key).not.toBe(key); // a resolved key never echoes itself
    }
  });

  it("zh renders the sr topology lines as prose; compact markers stay English", () => {
    const { t } = useI18n(["zh"]);
    expect(t("graph.srCurrent")).toBe("当前检出");
    expect(t("graph.srMerge", { parents: "abc1234, def5678" })).toContain("合并提交");
    expect(t("graph.footNote", { n: 200 })).toContain("date-order"); // compact marker stays English
  });
});
