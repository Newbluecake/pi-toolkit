// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import PreviewDir from "../../../src/web-hub/ui/src/components/preview/PreviewDir.vue";
import {
  createPreviewTree,
  PREVIEW_TREE_MAX_ENTRIES,
  PREVIEW_TREE_MAX_EXPANDED,
} from "../../../src/web-hub/ui/src/composables/usePreviewTree.js";
import {
  PREVIEW_PATH_MAX_BYTES,
  type PreviewDirEntry,
  type PreviewDirListing,
} from "../../../src/web-hub/protocol/preview.js";

/**
 * `PreviewDir.vue` (dir-plan v3.1 §0.2 A1/§3.2, package P3): the listing renders
 * keyboard-reachable native `<button>` rows (dir/file/symlink; `other`/lossy stay inert
 * text), names ride `<bdi translate="no">`, dotfiles grey via `.is-dot`, the `limits`
 * flags/vanished/dropped/statPartial pick their notice lines, the protected-entries
 * footnote always renders, `complete:false` shows 「≥ total」, and an empty listing shows
 * its empty state. Clicks only EMIT the entry — no navigation algebra here.
 */

function listing(over: Partial<PreviewDirListing> = {}, entries: PreviewDirEntry[] = []): PreviewDirListing {
  return {
    entries,
    total: entries.length,
    scanned: entries.length,
    complete: true,
    truncated: false,
    limits: { scan: false, entries: false, bytes: false },
    vanished: 0,
    dropped: 0,
    ...over,
  };
}

const ROWS = ".preview-dir-list li";
const BUTTONS = ".preview-dir-list button.preview-dir-row";
const INERT = ".preview-dir-row.is-inert";

function rowOf(w: ReturnType<typeof mount>, name: string): HTMLElement {
  const rows = w.findAll(ROWS);
  for (const li of rows) if (li.find(".preview-dir-name").text() === name) return li.element;
  throw new Error(`row ${name} not found`);
}

describe("PreviewDir.vue — rows (A1/A3)", () => {
  it("renders dir/file/symlink rows as native <button>; click emits the entry", async () => {
    const entries: PreviewDirEntry[] = [
      { name: "sub", type: "dir", mtimeMs: 1_700_000_000_000 },
      { name: "a.ts", type: "file", size: 2048, mtimeMs: 1_700_000_000_000 },
      { name: "ln", type: "symlink", mtimeMs: 1_700_000_000_000 },
    ];
    const w = mount(PreviewDir, { props: { path: "/p/src", listing: listing({}, entries) } });
    const buttons = w.findAll(BUTTONS);
    expect(buttons).toHaveLength(3); // symlink included — the admission chain decides (A3)
    for (const b of buttons) expect(b.element.tagName).toBe("BUTTON");
    await buttons[0]!.trigger("click");
    expect(w.emitted("navigate")).toStrictEqual([[entries[0]]]);
    await buttons[2]!.trigger("click");
    expect(w.emitted("navigate")![1]).toStrictEqual([entries[2]]);
  });

  it("`other` (FIFO/socket/device) and lossy (U+FFFD) rows are inert — never buttons", () => {
    const w = mount(PreviewDir, {
      props: {
        path: "/p/src",
        listing: listing({}, [
          { name: "pipe", type: "other", mtimeMs: 1 },
          { name: "bad", type: "file", size: 1, mtimeMs: 1, lossy: true },
          { name: "ok.ts", type: "file", size: 1, mtimeMs: 1 },
        ]),
      },
    });
    expect(w.findAll(BUTTONS)).toHaveLength(1); // only ok.ts
    expect(w.findAll(INERT)).toHaveLength(2);
  });

  it("names render inside <bdi translate=no>; dotfiles carry .is-dot (greyed, still clickable)", () => {
    const w = mount(PreviewDir, {
      props: {
        path: "/p/src",
        listing: listing({}, [
          { name: ".hidden", type: "dir", mtimeMs: 1 },
          { name: "plain.ts", type: "file", size: 5, mtimeMs: 1 },
        ]),
      },
    });
    const names = w.findAll(".preview-dir-name bdi");
    expect(names).toHaveLength(2);
    for (const b of names) expect(b.attributes("translate")).toBe("no");
    expect(rowOf(w, ".hidden").classList.contains("is-dot")).toBe(true);
    expect(rowOf(w, "plain.ts").classList.contains("is-dot")).toBe(false);
    expect(w.findAll(BUTTONS)).toHaveLength(2); // dotfile still navigates (visibility, not access)
  });

  it("size shows for files only (formatPreviewBytes); mtime renders as a date", () => {
    const w = mount(PreviewDir, {
      props: {
        path: "/p/src",
        listing: listing({}, [
          { name: "sub", type: "dir", mtimeMs: 1_700_000_000_000 },
          { name: "a.ts", type: "file", size: 2048, mtimeMs: 1_700_000_000_000 },
          { name: "b.ts", type: "file", mtimeMs: 1_700_000_000_000 }, // statPartial: no size
        ]),
      },
    });
    const sizes = w.findAll(".preview-dir-size");
    expect(sizes[0]!.text()).toBe(""); // directories carry no size (A1)
    expect(sizes[1]!.text()).toBe("2.0 KiB");
    expect(sizes[2]!.text()).toBe(""); // a missing size degrades to ""
    expect(w.findAll(".preview-dir-mtime")[1]!.text()).not.toBe("");
  });

  it("renders the listing verbatim — the hub's ordering (dir-first) is not re-sorted", () => {
    const w = mount(PreviewDir, {
      props: {
        path: "/p/src",
        listing: listing({}, [
          { name: "zdir", type: "dir", mtimeMs: 1 },
          { name: "afile", type: "file", size: 1, mtimeMs: 1 },
        ]),
      },
    });
    expect(w.findAll(".preview-dir-name").map((n) => n.text())).toEqual(["zdir", "afile"]);
  });
});

describe("PreviewDir.vue — meta / notices (§3.2)", () => {
  it("count line: complete ⇒ 「{n} entries」; !complete ⇒ 「≥ {n} entries」", () => {
    const full = mount(PreviewDir, {
      props: { path: "/p", listing: listing({}, [{ name: "a", type: "dir", mtimeMs: 1 }]) },
    });
    expect(full.get(".preview-dir-meta").text()).toContain("1 entries");
    const partial = mount(PreviewDir, {
      props: {
        path: "/p",
        listing: listing({ complete: false, total: 9000 }, [{ name: "a", type: "dir", mtimeMs: 1 }]),
      },
    });
    expect(partial.get(".preview-dir-meta").text()).toContain("≥ 9,000 entries");
  });

  it("each limits flag picks its own notice line (scan / entries / bytes)", () => {
    const scan = mount(PreviewDir, {
      props: {
        path: "/p",
        listing: listing({ limits: { scan: true, entries: false, bytes: false } }, [
          { name: "a", type: "dir", mtimeMs: 1 },
        ]),
      },
    });
    expect(scan.get(".preview-dir-note").text()).toContain("first 10,000 entries");
    const entries = mount(PreviewDir, {
      props: {
        path: "/p",
        listing: listing({ total: 1200, limits: { scan: false, entries: true, bytes: false } }, [
          { name: "a", type: "dir", mtimeMs: 1 },
        ]),
      },
    });
    expect(entries.get(".preview-dir-note").text()).toContain("first 1 of 1,200 entries");
    const bytes = mount(PreviewDir, {
      props: {
        path: "/p",
        listing: listing({ limits: { scan: false, entries: false, bytes: true } }, [
          { name: "a", type: "dir", mtimeMs: 1 },
        ]),
      },
    });
    expect(bytes.get(".preview-dir-note").text()).toContain("too long");
  });

  it("dropped / vanished / statPartial each surface their line; a healthy listing shows none", () => {
    const w = mount(PreviewDir, {
      props: {
        path: "/p",
        listing: listing({ dropped: 2, vanished: 1, statPartial: true }, [{ name: "a", type: "file", mtimeMs: 1 }]),
      },
    });
    const notes = w.findAll(".preview-dir-note").map((n) => n.text());
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("2 entries with overly long names");
    expect(notes[1]).toContain("1 entries vanished");
    expect(notes[2]).toContain("unknown for some entries");

    const clean = mount(PreviewDir, {
      props: { path: "/p", listing: listing({}, [{ name: "a", type: "file", mtimeMs: 1 }]) },
    });
    expect(clean.findAll(".preview-dir-note")).toHaveLength(0);
  });

  it("the protected-entries footnote always renders (static, count-free — §2.8)", () => {
    const w = mount(PreviewDir, { props: { path: "/p", listing: listing() } });
    expect(w.get(".preview-dir-footnote").text()).toContain("Protected entries are not shown");
  });

  it("an empty listing renders the empty state (no rows, no crash)", () => {
    const w = mount(PreviewDir, { props: { path: "/p", listing: listing() } });
    expect(w.get(".preview-dir-empty").text()).toContain("Empty directory");
    expect(w.findAll(ROWS)).toHaveLength(0);
  });

  it("no click handlers fire without a listener contract breach — inert rows emit nothing", async () => {
    const w = mount(PreviewDir, {
      props: {
        path: "/p",
        listing: listing({}, [{ name: "pipe", type: "other", mtimeMs: 1 }]),
      },
    });
    const emitSpy = vi.fn();
    w.vm.$emit = emitSpy;
    await w.get(INERT).trigger("click");
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe("PreviewDir.vue — path bar (tilde-expansion addendum, part B)", () => {
  const PATHBAR_INPUT = ".preview-dir-pathbar-input";
  const PATHBAR_FORM = ".preview-dir-pathbar";

  it("pre-fills the input with the current directory path", () => {
    const w = mount(PreviewDir, { props: { path: "/home/u/proj", listing: listing() } });
    expect((w.get(PATHBAR_INPUT).element as HTMLInputElement).value).toBe("/home/u/proj");
  });

  it("re-fills when the `path` prop changes (navigating to a fresh listing)", async () => {
    const w = mount(PreviewDir, { props: { path: "/a", listing: listing() } });
    await w.setProps({ path: "/a/b" });
    expect((w.get(PATHBAR_INPUT).element as HTMLInputElement).value).toBe("/a/b");
  });

  it("submitting (Enter or the Go button) emits `go` with the trimmed text", async () => {
    const w = mount(PreviewDir, { props: { path: "/a", listing: listing() } });
    const input = w.get(PATHBAR_INPUT);
    await input.setValue("  ~/snap/x.png  ");
    await w.get(PATHBAR_FORM).trigger("submit");
    expect(w.emitted("go")).toStrictEqual([["~/snap/x.png"]]);
  });

  it("an empty (or whitespace-only) draft never emits `go`", async () => {
    const w = mount(PreviewDir, { props: { path: "/a", listing: listing() } });
    await w.get(PATHBAR_INPUT).setValue("   ");
    await w.get(PATHBAR_FORM).trigger("submit");
    expect(w.emitted("go")).toBeUndefined();
  });

  it("checks UTF-8 bytes (including multibyte paths) without changing the draft", async () => {
    const w = mount(PreviewDir, { props: { path: "/a", listing: listing() } });
    const input = w.get(PATHBAR_INPUT);
    const atLimit = "/" + "界".repeat(1365); // 1 + 1365 * 3 = 4096 bytes
    expect(new TextEncoder().encode(atLimit)).toHaveLength(PREVIEW_PATH_MAX_BYTES);
    await input.setValue(atLimit);
    await w.get(PATHBAR_FORM).trigger("submit");
    expect(w.emitted("go")).toStrictEqual([[atLimit]]);
    for (const text of [atLimit + "a", "/" + "a".repeat(PREVIEW_PATH_MAX_BYTES)]) {
      await input.setValue(text);
      await w.get(PATHBAR_FORM).trigger("submit");
      expect(w.emitted("go")).toHaveLength(1);
      expect(w.get('[role="alert"]').text()).toContain("4096-byte UTF-8 limit");
      expect((input.element as HTMLInputElement).value).toBe(text);
      expect(input.attributes("aria-invalid")).toBe("true");
    }
    await input.setValue("~/snap");
    expect(w.find('[role="alert"]').exists()).toBe(false);
    await w.get(PATHBAR_FORM).trigger("submit");
    expect(w.emitted("go")![1]).toEqual(["~/snap"]);
  });

  it.each(["\0", "\r", "\n"])("rejects forbidden %j locally before trimming", async (char) => {
    const w = mount(PreviewDir, { props: { path: "/a", listing: listing() } });
    const input = w.get(PATHBAR_INPUT);
    const text = char + "~/snap" + char;
    // Native text inputs strip CR/LF themselves; exercise the component's raw draft guard.
    (w.vm as unknown as { pathDraft: string }).pathDraft = text;
    await w.get(PATHBAR_FORM).trigger("submit");
    expect(w.emitted("go")).toBeUndefined();
    expect(w.get('[role="alert"]').text()).toContain("NUL, CR, or LF");
    expect((w.vm as unknown as { pathDraft: string }).pathDraft).toBe(text);
    expect(input.attributes("aria-invalid")).toBe("true");
  });

  it("Esc restores the draft to the current path and does not bubble (dialog stays open)", async () => {
    const w = mount(PreviewDir, { props: { path: "/a/b", listing: listing() } });
    const input = w.get(PATHBAR_INPUT);
    await input.setValue("/something/else");
    const bubbled = vi.fn();
    w.element.addEventListener("keydown", bubbled);
    await input.trigger("keydown", { key: "Escape" });
    expect((input.element as HTMLInputElement).value).toBe("/a/b");
    expect(bubbled).not.toHaveBeenCalled(); // .stop kept it from reaching an ancestor listener
    expect(w.emitted("go")).toBeUndefined();
  });

  it("accepts aria-label/placeholder/button copy (i18n wiring, en default)", () => {
    const w = mount(PreviewDir, { props: { path: "/a", listing: listing() } });
    expect(w.get(PATHBAR_INPUT).attributes("aria-label")).toBeTruthy();
    expect(w.get(PATHBAR_INPUT).attributes("placeholder")).toBeTruthy();
    expect(w.get(".preview-dir-pathbar-go").text().length).toBeGreaterThan(0);
  });
});

/**
 * preview-tree (2026-10 用户需求): inline directory expansion. Chevron = lazy in-place
 * expand/collapse (same dir=1 endpoint via the injected tree store, no server change); the
 * row-name button keeps its drill-down `navigate` emit. Covers: lazy-fetch timing, nesting,
 * inline error+retry, both client budgets, cache hit (collapse keeps the listing), keyboard
 * ops, and expansion surviving a remount (the host's `:key` remount on drill/back).
 */
describe("PreviewDir.vue — inline tree expansion (preview-tree)", () => {
  const CHEVRON = ".preview-dir-chevron";
  const GROUP = "ul.preview-dir-group";
  const STATUS = ".preview-dir-tree-status";
  const REFUSAL = ".preview-dir-tree-refusal";
  const RETRY = ".preview-dir-tree-retry";

  type FetchResult = { ok: true; listing: PreviewDirListing } | { ok: false; error: string };

  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /** A real store over a scripted fetch — the tests exercise store+component together. */
  function treeWith(fn: (path: string) => Promise<FetchResult>) {
    const calls: string[] = [];
    const tree = createPreviewTree((path) => {
      calls.push(path);
      return fn(path);
    });
    return { tree, calls };
  }

  function chevronOf(w: ReturnType<typeof mount>, name: string): HTMLElement {
    const btn = rowOf(w, name).querySelector(CHEVRON);
    if (btn === null) throw new Error(`no chevron on row ${name}`);
    return btn as HTMLElement;
  }

  function mountDir(
    tree: ReturnType<typeof createPreviewTree>,
    entries: PreviewDirEntry[],
    path = "/p/src",
  ): ReturnType<typeof mount> {
    return mount(PreviewDir, { props: { path, listing: listing({}, entries), tree } });
  }

  it("no tree prop ⇒ li > button.preview-dir-row directly (no rowwrap/chevron/spacer, no tree roles)", () => {
    const w = mount(PreviewDir, {
      props: { path: "/p/src", listing: listing({}, [{ name: "sub", type: "dir", mtimeMs: 1 }]) },
    });
    const li = w.findAll(ROWS)[0]!.element;
    // 真实结构断言：li 唯一直接子元素就是行按钮本身（改动前的 DOM 形态）
    expect(li.children).toHaveLength(1);
    const only = li.children[0]!;
    expect(only.tagName).toBe("BUTTON");
    expect(only.classList.contains("preview-dir-row")).toBe(true);
    expect(w.find(".preview-dir-rowwrap").exists()).toBe(false);
    expect(w.find(".preview-dir-chevron").exists()).toBe(false);
    expect(w.find(".preview-dir-chevron-spacer").exists()).toBe(false);
    expect(w.get(".preview-dir-list").attributes("role")).toBeUndefined();
    expect(li.getAttribute("role")).toBeNull();
  });

  it("with a tree store ⇒ the rowwrap wrapper + chevron column wrap the same row button", () => {
    const { tree } = treeWith(() => Promise.resolve({ ok: true, listing: listing() }));
    const w = mountDir(tree, [
      { name: "sub", type: "dir", mtimeMs: 1 },
      { name: "a.ts", type: "file", size: 1, mtimeMs: 1 },
    ]);
    const wraps = w.findAll(".preview-dir-rowwrap");
    expect(wraps).toHaveLength(2);
    // dir row: chevron + row button; file row: spacer + row button — button stays a .preview-dir-row
    const dirRow = rowOf(w, "sub");
    expect(dirRow.querySelector(":scope > .preview-dir-rowwrap > .preview-dir-chevron")).not.toBeNull();
    expect(dirRow.querySelector(":scope > .preview-dir-rowwrap > button.preview-dir-row")).not.toBeNull();
    const fileRow = rowOf(w, "a.ts");
    expect(fileRow.querySelector(":scope > .preview-dir-rowwrap > .preview-dir-chevron-spacer")).not.toBeNull();
    expect(fileRow.querySelector(":scope > .preview-dir-rowwrap > button.preview-dir-row")).not.toBeNull();
  });

  it("first chevron click lazy-fetches that dir only (loading row inline), then renders children indented", async () => {
    const d = deferred<FetchResult>();
    const { tree, calls } = treeWith(() => d.promise);
    const w = mountDir(tree, [
      { name: "sub", type: "dir", mtimeMs: 1 },
      { name: "a.ts", type: "file", size: 1, mtimeMs: 1 },
    ]);
    expect(w.find(GROUP).exists()).toBe(false);
    expect(calls).toHaveLength(0); // nothing fetched before the first expand

    await chevronOf(w, "sub").dispatchEvent(new Event("click"));
    expect(calls).toStrictEqual(["/p/src/sub"]); // childPreviewPath join, dir=1 via the store
    expect(w.get(STATUS).text()).toContain("Loading…"); // 行内 loading, 不弹窗
    expect(w.get(STATUS).attributes("role")).toBe("status");

    d.resolve({
      ok: true,
      listing: listing({}, [
        { name: "x.ts", type: "file", size: 1, mtimeMs: 1 },
        { name: "inner", type: "dir", mtimeMs: 1 },
      ]),
    });
    await flushPromises();
    expect(w.find(STATUS).exists()).toBe(false);
    const group = w.get(GROUP);
    expect(group.attributes("role")).toBe("group");
    expect(group.findAll(".preview-dir-name").map((n) => n.text())).toEqual(["x.ts", "inner"]);
    expect(chevronOf(w, "sub").getAttribute("aria-expanded")).toBe("true");
    // tree roles: root ul=tree, li=treeitem with aria-level (1 at root, 2 inside the group)
    expect(w.get(".preview-dir-list").attributes("role")).toBe("tree");
    expect(rowOf(w, "sub").getAttribute("aria-level")).toBe("1");
    expect(rowOf(w, "x.ts").getAttribute("aria-level")).toBe("2");
  });

  it("row-name click still drills down (emits navigate) WITHOUT triggering an expansion fetch", async () => {
    const { tree, calls } = treeWith(() => Promise.resolve({ ok: true, listing: listing() }));
    const entries: PreviewDirEntry[] = [{ name: "sub", type: "dir", mtimeMs: 1 }];
    const w = mountDir(tree, entries);
    await w.get(`${BUTTONS}`).trigger("click");
    expect(w.emitted("navigate")).toStrictEqual([[entries[0]]]);
    expect(calls).toHaveLength(0);
    expect(w.find(GROUP).exists()).toBe(false);
  });

  it("nested expansion: a dir inside an expanded listing expands in place (multi-level)", async () => {
    const { tree, calls } = treeWith((path) =>
      Promise.resolve({
        ok: true,
        listing:
          path === "/p/src/a"
            ? listing({}, [{ name: "b", type: "dir", mtimeMs: 1 }])
            : listing({}, [{ name: "leaf.ts", type: "file", size: 1, mtimeMs: 1 }]),
      }),
    );
    const w = mountDir(tree, [{ name: "a", type: "dir", mtimeMs: 1 }]);
    await chevronOf(w, "a").dispatchEvent(new Event("click"));
    await flushPromises();
    await chevronOf(w, "b").dispatchEvent(new Event("click"));
    await flushPromises();
    expect(calls).toStrictEqual(["/p/src/a", "/p/src/a/b"]);
    expect(rowOf(w, "leaf.ts").getAttribute("aria-level")).toBe("3");
    expect(w.findAll(GROUP)).toHaveLength(2);
  });

  it("a failed expand shows an inline error + retry (no new dialog); retry refetches and succeeds", async () => {
    let attempt = 0;
    const { tree, calls } = treeWith(() => {
      attempt++;
      return attempt === 1
        ? Promise.resolve({ ok: false, error: "E_DENIED" })
        : Promise.resolve({ ok: true, listing: listing({}, [{ name: "ok.ts", type: "file", size: 1, mtimeMs: 1 }]) });
    });
    const w = mountDir(tree, [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await chevronOf(w, "sub").dispatchEvent(new Event("click"));
    await flushPromises();
    const err = w.get(`${STATUS}.is-error`);
    expect(err.attributes("role")).toBe("alert");
    expect(err.text()).toContain("E_DENIED");
    expect(w.find(GROUP).exists()).toBe(false);

    await w.get(RETRY).trigger("click");
    await flushPromises();
    expect(calls).toStrictEqual(["/p/src/sub", "/p/src/sub"]);
    expect(w.find(STATUS).exists()).toBe(false);
    expect(rowOf(w, "ok.ts")).toBeTruthy();
  });

  it("budget: the (max+1)-th expanded directory is refused with an inline hint; collapse frees the slot", async () => {
    const entries: PreviewDirEntry[] = Array.from({ length: PREVIEW_TREE_MAX_EXPANDED + 1 }, (_, i) => ({
      name: `d${String(i).padStart(2, "0")}`,
      type: "dir" as const,
      mtimeMs: 1,
    }));
    const { tree, calls } = treeWith(() => Promise.resolve({ ok: true, listing: listing() }));
    const w = mountDir(tree, entries);
    for (let i = 0; i < PREVIEW_TREE_MAX_EXPANDED; i++) {
      await chevronOf(w, `d${String(i).padStart(2, "0")}`).dispatchEvent(new Event("click"));
      await flushPromises();
    }
    expect(calls).toHaveLength(PREVIEW_TREE_MAX_EXPANDED);
    expect(w.find(REFUSAL).exists()).toBe(false);

    const last = `d${String(PREVIEW_TREE_MAX_EXPANDED).padStart(2, "0")}`;
    await chevronOf(w, last).dispatchEvent(new Event("click"));
    await flushPromises();
    expect(calls).toHaveLength(PREVIEW_TREE_MAX_EXPANDED); // refused BEFORE any fetch
    expect(w.get(REFUSAL).text()).toContain(String(PREVIEW_TREE_MAX_EXPANDED));
    expect(w.get(REFUSAL).attributes("role")).toBe("status");

    // collapse one → the freed slot admits the previously refused expand
    await chevronOf(w, "d00").dispatchEvent(new Event("click"));
    await chevronOf(w, last).dispatchEvent(new Event("click"));
    await flushPromises();
    expect(w.find(REFUSAL).exists()).toBe(false);
    expect(calls).toHaveLength(PREVIEW_TREE_MAX_EXPANDED + 1);
  });

  it("budget: a child listing overflowing the entry cap is neither cached nor expanded", async () => {
    const big: PreviewDirEntry[] = Array.from({ length: PREVIEW_TREE_MAX_ENTRIES + 1 }, (_, i) => ({
      name: `f${i}`,
      type: "file" as const,
      size: 1,
      mtimeMs: 1,
    }));
    const { tree, calls } = treeWith(() => Promise.resolve({ ok: true, listing: listing({}, big) }));
    const w = mountDir(tree, [{ name: "big", type: "dir", mtimeMs: 1 }]);
    await chevronOf(w, "big").dispatchEvent(new Event("click"));
    await flushPromises();
    expect(calls).toStrictEqual(["/p/src/big"]); // fetched, then refused at cache admission
    expect(w.get(REFUSAL).text()).toContain(PREVIEW_TREE_MAX_ENTRIES.toLocaleString("en-US"));
    expect(w.find(GROUP).exists()).toBe(false);
    expect(chevronOf(w, "big").getAttribute("aria-expanded")).toBe("false");
  });

  it("cache hit: collapse keeps the listing — re-expanding never refetches", async () => {
    const d = () =>
      Promise.resolve({
        ok: true as const,
        listing: listing({}, [{ name: "x", type: "file" as const, size: 1, mtimeMs: 1 }]),
      });
    const { tree, calls } = treeWith(d);
    const w = mountDir(tree, [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await chevronOf(w, "sub").dispatchEvent(new Event("click"));
    await flushPromises();
    expect(w.find(GROUP).exists()).toBe(true);
    await chevronOf(w, "sub").dispatchEvent(new Event("click")); // collapse
    expect(w.find(GROUP).exists()).toBe(false);
    expect(chevronOf(w, "sub").getAttribute("aria-expanded")).toBe("false");
    await chevronOf(w, "sub").dispatchEvent(new Event("click")); // re-expand — cache hit
    expect(w.find(GROUP).exists()).toBe(true);
    expect(calls).toStrictEqual(["/p/src/sub"]); // exactly one fetch
  });

  it("keyboard: Right expands a collapsed dir / steps into first child; Left collapses / steps to parent; Up/Down move", async () => {
    const { tree, calls } = treeWith(() =>
      Promise.resolve({ ok: true, listing: listing({}, [{ name: "child.ts", type: "file", size: 1, mtimeMs: 1 }]) }),
    );
    const w = mount(PreviewDir, {
      attachTo: document.body,
      props: {
        path: "/p/src",
        listing: listing({}, [
          { name: "sub", type: "dir", mtimeMs: 1 },
          { name: "z.ts", type: "file", size: 1, mtimeMs: 1 },
        ]),
        tree,
      },
    });
    const rowBtns = () => w.findAll(BUTTONS).map((b) => b.element as HTMLElement);

    // Down/Up move across visible rows
    await w.findAll(BUTTONS)[0]!.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowBtns()[1]);
    await w.findAll(BUTTONS)[1]!.trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(rowBtns()[0]);

    // Right on a collapsed dir expands (lazy fetch); focus stays on the row
    await w.findAll(BUTTONS)[0]!.trigger("keydown", { key: "ArrowRight" });
    expect(calls).toStrictEqual(["/p/src/sub"]);
    await flushPromises();
    expect(rowBtns().map((el) => el.textContent)).toHaveLength(3); // child row rendered

    // Right again on the expanded dir steps into the first child row
    await w.findAll(BUTTONS)[0]!.trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(rowBtns()[1]);
    expect(rowBtns()[1]!.textContent).toContain("child.ts");

    // Left on the child steps back to the parent row; Left on the expanded dir collapses
    await w.findAll(BUTTONS)[1]!.trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).toBe(rowBtns()[0]);
    await w.findAll(BUTTONS)[0]!.trigger("keydown", { key: "ArrowLeft" });
    expect(chevronOf(w, "sub").getAttribute("aria-expanded")).toBe("false");
    expect(w.find(GROUP).exists()).toBe(false);
    w.unmount();
  });

  it("expansion survives a remount (drill-down/back `:key` remount) — the store outlives the component", async () => {
    const { tree, calls } = treeWith(() =>
      Promise.resolve({ ok: true, listing: listing({}, [{ name: "x", type: "file", size: 1, mtimeMs: 1 }]) }),
    );
    const entries: PreviewDirEntry[] = [{ name: "sub", type: "dir", mtimeMs: 1 }];
    const w1 = mountDir(tree, entries);
    await chevronOf(w1, "sub").dispatchEvent(new Event("click"));
    await flushPromises();
    expect(w1.find(GROUP).exists()).toBe(true);
    w1.unmount(); // what PreviewHost's `:key="view.path"` does on drill/back

    const w2 = mountDir(tree, entries);
    expect(w2.find(GROUP).exists()).toBe(true); // still expanded, no refetch
    expect(chevronOf(w2, "sub").getAttribute("aria-expanded")).toBe("true");
    expect(calls).toStrictEqual(["/p/src/sub"]);
  });

  it("clear() (dialog close / fresh open) drops every node and aborts in-flight fetches", async () => {
    const d = deferred<FetchResult>();
    const { tree } = treeWith(() => d.promise);
    const w = mountDir(tree, [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await chevronOf(w, "sub").dispatchEvent(new Event("click"));
    expect(w.find(STATUS).exists()).toBe(true);
    tree.clear();
    await flushPromises();
    expect(w.find(STATUS).exists()).toBe(false);
    expect(tree.nodes.size).toBe(0);
    // a late resolve after clear() is dropped by the generation guard — no node reappears
    d.resolve({ ok: true, listing: listing({}, [{ name: "x", type: "file", mtimeMs: 1 }]) });
    await flushPromises();
    expect(tree.nodes.size).toBe(0);
    expect(w.find(GROUP).exists()).toBe(false);
  });
});
