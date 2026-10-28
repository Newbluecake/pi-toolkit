// @vitest-environment happy-dom
/**
 * wtgraph.files.v1 — commit-row expansion in `WorktreeGraph.vue` + `useCommitFiles`:
 * - cap absent ⇒ rows stay inert (no tabindex/aria-expanded, click does nothing, no request);
 * - click / Enter / Space open a row (one detail row right below, aria-expanded), a second click
 *   closes it, clicking another row switches (aborting the in-flight fetch); the hash copy button
 *   never toggles;
 * - loading (spinner) / error (+ retry; 409 stale ⇒ "Refresh graph" re-pulls the graph, then
 *   the files fetch re-runs) / empty / ready (badge, +add −del, path title, merge/root notes,
 *   truncation note);
 * - lane alignment: the detail row has no `data-row`, the measured centers are the COMMIT rows'
 *   centers (SVG dots sit on them), the lane cell's rowspan grows by one, and the pitch (lane
 *   gap / dot radius) is unchanged by the open row — at 100 / 200 / 300 % font scale.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorktreeGraph from "../../../src/web-hub/ui/src/components/graph/WorktreeGraph.vue";
import GraphLanes from "../../../src/web-hub/ui/src/components/graph/GraphLanes.vue";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { WorktreeGraphTransport, WtDiffOutcome } from "../../../src/web-hub/ui/src/transport/types.js";
import {
  parseWtGraphCommitFiles,
  parseWtGraphPayload,
  type WtGraphCommitFiles,
  type WtGraphPayload,
} from "../../../src/web-hub/protocol/worktree-graph.js";
import { wtgraphScopeOf } from "../../../src/web-hub/ui/src/logic/gitGraphScope.js";
import { WTGRAPH_FILES_HUB_CAP, WTGRAPH_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { WorktreeRowWire } from "../../../src/web-hub/protocol/messages.js";

const oid = (c: string): string => (c + "0".repeat(40)).slice(0, 40);
const commit = (id: string, parents: string[], s = `c ${id}`) => ({
  h: oid(id),
  p: parents.map(oid),
  a: "Dev",
  t: 1_700_000_000,
  s,
});

function payloadOf(commits: ReturnType<typeof commit>[]): WtGraphPayload {
  const p = parseWtGraphPayload({
    v: 1,
    n: 200,
    format: "sha1",
    commits,
    refs: [],
    wtHeads: [],
    degrade: {},
    complete: true,
  });
  if (p === null) throw new Error("fixture rejected");
  return p;
}

/** merge (c1) → c2 → c4 (root); c3 = the merge's second parent (root) */
const GRAPH = payloadOf([
  commit("c1", ["c2", "c3"], "Merge branch 'feat'"),
  commit("c2", ["c4"], "base work"),
  commit("c3", [], "feat root"),
  commit("c4", [], "root"),
]);

function filesOf(h: string, entries: WtGraphCommitFiles["entries"], over: Partial<WtGraphCommitFiles> = {}) {
  const raw = {
    v: 1,
    h,
    entries,
    total: entries.length,
    truncated: false,
    limits: { files: false, bytes: false, output: false },
    ...over,
  };
  const p = parseWtGraphCommitFiles(raw, JSON.stringify(raw).length);
  if (p === null) throw new Error("files fixture rejected");
  return p;
}

const rows: WorktreeRowWire[] = [
  { label: "~/repo", path: "/home/dev/repo", branch: "master", head: "aaaaaaa", current: true, main: true },
];

type FilesOutcome = WtDiffOutcome<WtGraphCommitFiles>;

interface Fake {
  transport: WorktreeGraphTransport;
  graph: ReturnType<typeof vi.fn>;
  commitFiles: ReturnType<typeof vi.fn>;
  signals: AbortSignal[];
  /** pending resolvers in call order (when `manual`) */
  pending: Array<(o: FilesOutcome) => void>;
}

function fake(opts: { manual?: boolean; files?: (h: string) => FilesOutcome } = {}): Fake {
  const signals: AbortSignal[] = [];
  const pending: Array<(o: FilesOutcome) => void> = [];
  const graph = vi.fn(async () => ({ ok: true as const, value: GRAPH }));
  const commitFiles = vi.fn((req: { h: string }, o?: { signal?: AbortSignal }): Promise<FilesOutcome> => {
    if (o?.signal !== undefined) signals.push(o.signal);
    if (opts.manual === true) return new Promise((res) => pending.push(res));
    return Promise.resolve(
      opts.files?.(req.h) ?? {
        ok: true,
        value: filesOf(req.h, [
          { path: "src/deep/dir/a.ts", status: "M", add: 3, del: 1 },
          { path: "new name.txt", orig: "old name.txt", status: "R", add: 0, del: 0 },
          { path: "logo.png", status: "A", binary: true },
          { path: "gone.md", status: "D", add: 0, del: 9 },
        ]),
      },
    );
  });
  return {
    transport: { graph, commitFiles } as unknown as WorktreeGraphTransport,
    graph,
    commitFiles,
    signals,
    pending,
  };
}

const SCOPE_FILES = { agentKey: "a-1", sessionId: "s-1", merged: false, files: true as const };

async function mountGraph(f: Fake, props: Record<string, unknown> = {}) {
  const w = mount(WorktreeGraph, {
    attachTo: document.body,
    props: { scope: SCOPE_FILES, wt: "/home/dev/repo", transport: f.transport, rows, mobile: false, ...props },
  });
  (w.vm as unknown as { toggle: () => void }).toggle();
  await flushPromises();
  return w;
}

const dataRows = (w: ReturnType<typeof mount>) => w.findAll("tr[data-row]");

afterEach(() => {
  resetLangForTests();
  document.body.innerHTML = "";
});

describe("gitGraphScope — files flag", () => {
  it("files:true only when the hub declared wtgraph.files.v1 (absent key otherwise — legacy shape)", () => {
    const base = { mode: "token", hasTransport: true, agentKey: "a", session: { sessionId: "s" } };
    expect(wtgraphScopeOf({ ...base, hubCaps: [WTGRAPH_HUB_CAP] })).toEqual({
      agentKey: "a",
      sessionId: "s",
      merged: false,
    });
    expect(wtgraphScopeOf({ ...base, hubCaps: [WTGRAPH_HUB_CAP, WTGRAPH_FILES_HUB_CAP] })).toEqual({
      agentKey: "a",
      sessionId: "s",
      merged: false,
      files: true,
    });
  });
});

describe("WorktreeGraph — commit rows inert without the cap", () => {
  it("no files flag ⇒ no tabindex/aria-expanded/data-toggle, click does nothing, no request", async () => {
    const f = fake();
    const w = await mountGraph(f, { scope: { agentKey: "a-1", sessionId: "s-1", merged: false } });
    const r = dataRows(w)[1]!;
    expect(r.attributes("tabindex")).toBeUndefined();
    expect(r.attributes("aria-expanded")).toBeUndefined();
    expect(r.attributes("data-toggle")).toBeUndefined();
    await r.trigger("click");
    await r.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(f.commitFiles).not.toHaveBeenCalled();
    expect(w.find(".gg-files-row").exists()).toBe(false);
    w.unmount();
  });

  it("a transport without commitFiles keeps rows inert even with the flag", async () => {
    const graph = vi.fn(async () => ({ ok: true as const, value: GRAPH }));
    const w = await mountGraph({ transport: { graph } } as unknown as Fake);
    expect(dataRows(w)[0]!.attributes("tabindex")).toBeUndefined();
    w.unmount();
  });
});

describe("WorktreeGraph — expand / collapse / switch", () => {
  it("click opens one detail row below the commit with aria-expanded; second click closes; another row switches", async () => {
    const f = fake();
    const w = await mountGraph(f);
    const [r0, r1] = dataRows(w);
    expect(r1!.attributes("tabindex")).toBe("0");
    expect(r1!.attributes("aria-expanded")).toBe("false");

    await r1!.trigger("click");
    await flushPromises();
    expect(f.commitFiles).toHaveBeenCalledTimes(1);
    expect(f.commitFiles.mock.calls[0]![0]).toEqual({
      agentKey: "a-1",
      sessionId: "s-1",
      wt: "/home/dev/repo",
      h: oid("c2"),
    });
    expect(r1!.attributes("aria-expanded")).toBe("true");
    expect(r1!.attributes("aria-controls")).toBe(`gg-files-${oid("c2")}`);
    const trs = w.findAll("tbody > tr");
    expect(trs[2]!.classes()).toContain("gg-files-row"); // directly below row 1
    expect(trs[2]!.attributes("data-row")).toBeUndefined();
    expect(w.findAll(".gg-files-row")).toHaveLength(1);

    await r1!.trigger("click");
    expect(w.find(".gg-files-row").exists()).toBe(false);
    expect(r1!.attributes("aria-expanded")).toBe("false");

    // re-open: the loaded list is memoized (commit content is immutable) — no refetch
    await r1!.trigger("click");
    await flushPromises();
    expect(f.commitFiles).toHaveBeenCalledTimes(1);

    // switch to row 0: row 1 closes, row 0 opens
    await r0!.trigger("click");
    await flushPromises();
    expect(r1!.attributes("aria-expanded")).toBe("false");
    expect(r0!.attributes("aria-expanded")).toBe("true");
    expect(w.findAll(".gg-files-row")).toHaveLength(1);
    expect(w.findAll("tbody > tr")[1]!.classes()).toContain("gg-files-row");
    w.unmount();
  });

  it("Enter and Space toggle; keys bubbling from the hash button do not; the hash click never toggles", async () => {
    const f = fake();
    const w = await mountGraph(f);
    const r2 = dataRows(w)[2]!;
    await r2.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(r2.attributes("aria-expanded")).toBe("true");
    await r2.trigger("keydown", { key: " " });
    expect(r2.attributes("aria-expanded")).toBe("false");

    const hash = r2.find("button.gg-hash");
    await hash.trigger("keydown", { key: "Enter" });
    await hash.trigger("click");
    await flushPromises();
    expect(r2.attributes("aria-expanded")).toBe("false");
    expect(f.commitFiles).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("switching rows aborts the in-flight fetch; a late answer for the old row is ignored", async () => {
    const f = fake({ manual: true });
    const w = await mountGraph(f);
    await dataRows(w)[1]!.trigger("click");
    await dataRows(w)[2]!.trigger("click");
    expect(f.signals[0]!.aborted).toBe(true);
    expect(f.signals[1]!.aborted).toBe(false);
    f.pending[0]!({ ok: true, value: filesOf(oid("c2"), [{ path: "late.ts", status: "M", add: 1, del: 1 }]) });
    await flushPromises();
    expect(w.text()).not.toContain("late.ts");
    expect(w.find(".gg-files-row .gg-spinner").exists()).toBe(true);
    w.unmount();
  });
});

describe("useCommitFiles — invalidation", () => {
  it("a wt or scope change closes the open row and forgets loaded lists", async () => {
    const f = fake();
    const w = await mountGraph(f);
    await dataRows(w)[1]!.trigger("click");
    await flushPromises();
    expect(w.find(".gg-files-row").exists()).toBe(true);
    await w.setProps({ wt: "/home/dev/other" });
    await flushPromises();
    expect(w.find(".gg-files-row").exists()).toBe(false);
    // the graph re-pulled for the new wt; re-opening refetches (memo was cleared)
    await dataRows(w)[1]!.trigger("click");
    await flushPromises();
    expect(f.commitFiles).toHaveBeenCalledTimes(2);
    await w.setProps({ scope: { ...SCOPE_FILES, sessionId: "s-2" } });
    await flushPromises();
    expect(w.find(".gg-files-row").exists()).toBe(false);
    w.unmount();
  });
});

describe("WorktreeGraph — detail row states", () => {
  it("loading shows a spinner + status text, then the ready list (badge, +add −del, bin, path title)", async () => {
    const f = fake({ manual: true });
    const w = await mountGraph(f);
    await dataRows(w)[1]!.trigger("click");
    const row = () => w.get(".gg-files-row");
    expect(row().find(".gg-spinner").exists()).toBe(true);
    expect(row().find('[role="status"]').text()).toBe("Loading changed files…");

    f.pending[0]!({
      ok: true,
      value: filesOf(oid("c2"), [
        { path: "src/deep/dir/a.ts", status: "M", add: 3, del: 1 },
        { path: "new name.txt", orig: "old name.txt", status: "R", add: 0, del: 0 },
        { path: "logo.png", status: "A", binary: true },
        { path: "gone.md", status: "D", add: 0, del: 9 },
      ]),
    });
    await flushPromises();
    const items = row().findAll("li.gg-file");
    expect(items).toHaveLength(4);
    expect(items.map((li) => li.get(".gg-fst").text())).toEqual(["M", "R", "A", "D"]);
    expect(items[0]!.get(".gg-fadd").text()).toBe("+3");
    expect(items[0]!.get(".gg-fdel").text()).toBe("−1");
    expect(items[0]!.get(".gg-fpath").attributes("title")).toBe("src/deep/dir/a.ts");
    expect(items[1]!.get(".gg-fpath").attributes("title")).toBe("old name.txt → new name.txt");
    expect(items[1]!.get(".gg-fst").attributes("title")).toBe("renamed from old name.txt");
    expect(items[2]!.get(".gg-fnum").text()).toBe("bin");
    expect(row().get(".gg-files-meta").text()).toBe("4 files");
    w.unmount();
  });

  it("merge rows note the first-parent rule; root rows note 'every file is new'", async () => {
    const f = fake({ files: (h) => ({ ok: true, value: filesOf(h, [{ path: "x", status: "A", add: 1, del: 0 }]) }) });
    const w = await mountGraph(f);
    await dataRows(w)[0]!.trigger("click");
    await flushPromises();
    expect(w.get(".gg-files-meta").text()).toContain("merge commit: changes against the first parent");
    await dataRows(w)[3]!.trigger("click");
    await flushPromises();
    expect(w.get(".gg-files-meta").text()).toContain("root commit: every file is new");
    w.unmount();
  });

  it("empty list ⇒「无文件变更」(zh); truncated list ⇒ shown/total note", async () => {
    setLangOverride("zh");
    const f = fake({
      files: (h) =>
        h === oid("c2")
          ? { ok: true, value: filesOf(h, []) }
          : {
              ok: true,
              value: filesOf(h, [{ path: "a", status: "M", add: 1, del: 1 }], {
                total: 1200,
                truncated: true,
                limits: { files: true, bytes: false, output: false },
              }),
            },
    });
    const w = await mountGraph(f);
    await dataRows(w)[1]!.trigger("click");
    await flushPromises();
    expect(w.get(".gg-files-row .gg-files-state").text()).toBe("无文件变更。");
    await dataRows(w)[2]!.trigger("click");
    await flushPromises();
    expect(w.get(".gg-files-row").text()).toContain("显示 1200 个文件中的 1 个");
    w.unmount();
  });

  it("error ⇒ alert + retry refetches; 409 stale ⇒ 'Refresh graph' re-pulls the graph, then the files fetch re-runs", async () => {
    const outcomes: FilesOutcome[] = [
      { ok: false, status: 503, error: "E_BUSY", reason: "attr-changed" },
      { ok: false, status: 409, error: "E_STALE_CTX", reason: "commit" },
    ];
    const f = fake({
      files: (h) =>
        outcomes.shift() ?? { ok: true, value: filesOf(h, [{ path: "ok.ts", status: "M", add: 1, del: 0 }]) },
    });
    const w = await mountGraph(f);
    await dataRows(w)[1]!.trigger("click");
    await flushPromises();
    const alert = w.get(".gg-files-row [role='alert']");
    expect(alert.text()).toContain("The hub is busy");
    await alert.get("button").trigger("click");
    await flushPromises();
    // second answer: stale
    const stale = w.get(".gg-files-row [role='alert']");
    expect(stale.text()).toContain("refresh the graph");
    expect(stale.get("button").text()).toBe("Refresh graph");
    expect(f.graph).toHaveBeenCalledTimes(1);
    await stale.get("button").trigger("click");
    await flushPromises();
    expect(f.graph).toHaveBeenCalledTimes(2);
    expect(f.commitFiles).toHaveBeenCalledTimes(3);
    expect(w.get(".gg-files-row").text()).toContain("ok.ts");
    w.unmount();
  });
});

describe("WorktreeGraph — lane alignment with an open row", () => {
  function installLayout(scale: number): { restore(): void } {
    const H = 22 * scale;
    const ro = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    const heightOf = (el: Element): number =>
      el.matches("tr[data-row]") ? H : el.matches("tr.gg-files-row") ? 4 * H : 0;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.matches("tr")) return { top: 0, height: 0 } as DOMRect;
      let top = 0;
      for (let s = this.previousElementSibling; s !== null; s = s.previousElementSibling) top += heightOf(s);
      return { top, height: heightOf(this) } as DOMRect;
    });
    return {
      restore() {
        rect.mockRestore();
        globalThis.ResizeObserver = ro;
      },
    };
  }

  for (const scale of [1, 2, 3]) {
    it(`${scale * 100}% font scale: dots sit on the commit rows' centers, rowspan +1, pitch unchanged`, async () => {
      const layout = installLayout(scale);
      try {
        const H = 22 * scale;
        const f = fake();
        const w = await mountGraph(f);
        await nextTick();
        const lanes = w.findComponent(GraphLanes);
        const before = { pitch: lanes.props("pitch"), r: lanes.props("dotRadius"), centers: lanes.props("centers") };
        expect(before.centers).toEqual([0.5, 1.5, 2.5, 3.5].map((k) => k * H));
        expect(before.pitch).toBe(H);

        for (const open of [0, 1, 3]) {
          await dataRows(w)[open]!.trigger("click");
          await flushPromises();
          await nextTick();
          const centers = lanes.props("centers") as number[];
          // rows after the open one shift down by the detail row's height (4H)
          expect(centers).toEqual([0, 1, 2, 3].map((k) => (k + 0.5) * H + (k > open ? 4 * H : 0)));
          expect(lanes.props("pitch")).toBe(before.pitch);
          expect(lanes.props("dotRadius")).toBe(before.r);
          expect(w.get(".gg-lanes").attributes("rowspan")).toBe("5");
          const cys = w.findAll(".gg-dot").map((d) => Number(d.attributes("cy")));
          expect(cys).toEqual(centers);
          // detail text starts right of the lane SVG
          const svgW = Number(w.get(".gg-svg").attributes("width"));
          expect(w.get(".gg-files-cell").attributes("style")).toContain(`padding-left: ${svgW - 4}px`);
        }
        // closing restores the original geometry
        await dataRows(w)[3]!.trigger("click");
        await nextTick();
        await nextTick();
        expect(lanes.props("centers")).toEqual(before.centers);
        expect(w.get(".gg-lanes").attributes("rowspan")).toBe("4");
        w.unmount();
      } finally {
        layout.restore();
      }
    });
  }

  it("injectedCenters seam: an open row keeps the injected pitch (the straddling pair is skipped)", async () => {
    const f = fake();
    const w = await mountGraph(f, { injectedCenters: [11, 33 + 88, 55 + 88, 77 + 88] });
    await dataRows(w)[0]!.trigger("click");
    await flushPromises();
    expect(w.findComponent(GraphLanes).props("pitch")).toBe(22);
    w.unmount();
  });
});
