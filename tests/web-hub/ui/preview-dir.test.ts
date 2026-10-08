// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import PreviewDir from "../../../src/web-hub/ui/src/components/preview/PreviewDir.vue";
import type { PreviewDirEntry, PreviewDirListing } from "../../../src/web-hub/protocol/preview.js";

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
