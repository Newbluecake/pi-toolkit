// @vitest-environment happy-dom
/**
 * worktree-diff plan v3.1 §5 D5 — `components/diff/WorktreeFileList.vue` (§4.2): every
 * `!isWtRequestableEntry` entry is disabled with a title distinguishing the reason (CR / LF /
 * U+FFFD / too-long / filtered), TAB stays clickable (§2.4 v3.1), control characters are
 * visualized through `displayPath` (`␍`/`␊`), R/C rows show `orig → path`, binary/conflict
 * chips render, the D14/D20 static footnote is present in the 0-entry / entries / loading /
 * error states alike (never a data-conditioned oracle), and the truncation + degrade notes
 * (`untrackedSkipped` / `numstatPartial` / `attrPartial`) surface their own copy.
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import WorktreeFileList from "../../../src/web-hub/ui/src/components/diff/WorktreeFileList.vue";
import type { ListState } from "../../../src/web-hub/ui/src/composables/useWorktreeDiff.js";
import type { WtDiffFileEntry, WtDiffFileList } from "../../../src/web-hub/protocol/worktree-diff.js";

const list = (over: Partial<WtDiffFileList> = {}): WtDiffFileList => ({
  base: "b".repeat(40),
  entries: [],
  total: 0,
  truncated: false,
  limits: { status: false, files: false, bytes: false },
  ...over,
});

const okState = (entries: WtDiffFileEntry[], over: Partial<WtDiffFileList> = {}): ListState => ({
  phase: "ok",
  data: list({ entries, total: entries.length, ...over }),
  sig: "s",
});

const mountList = (state: ListState) => mount(WorktreeFileList, { props: { state } });

describe("WorktreeFileList — disabled entries (#7, title per reason)", () => {
  it("CR / LF / U+FFFD / too-long / filtered entries are all disabled with distinct titles", () => {
    const entries: WtDiffFileEntry[] = [
      { path: "cr\rb.ts", status: "M" }, // CR — displayable, never requestable
      { path: "lf\nb.ts", status: "M" }, // LF
      { path: "bad\uFFFDb.ts", status: "M" }, // undecodable byte
      { path: `${"x".repeat(4100)}.ts`, status: "M" }, // > 4096 UTF-8 bytes
      { path: "lfs/asset.bin", status: "M", filtered: true }, // filter driver (LFS)
      { path: "ok.ts", status: "M", add: 1, del: 2 }, // the control: fully requestable
    ];
    const w = mountList(okState(entries));
    const rows = w.findAll(".wtd-file");

    expect(rows.map((r) => r.attributes("disabled") !== undefined)).toEqual([true, true, true, true, true, false]);

    const titles = rows.map((r) => r.attributes("title"));
    expect(titles[0]).toBe("Filename contains CR/LF — not requestable");
    expect(titles[1]).toBe("Filename contains CR/LF — not requestable");
    expect(titles[2]).toBe("Filename contains undecodable bytes — not requestable");
    expect(titles[3]).toBe("Filename contains special characters — not requestable");
    expect(titles[4]).toBe("Managed by a Git filter driver (e.g. LFS) — not viewable");
    expect(titles[5]).toBeUndefined();

    // the control row emits open; a disabled row cannot
    expect((rows[5]!.element as HTMLButtonElement).disabled).toBe(false);
    expect((rows[0]!.element as HTMLButtonElement).disabled).toBe(true);
  });

  it("a TAB filename stays clickable (§2.4 v3.1) and renders the visible ␉ glyph", async () => {
    const w = mountList(okState([{ path: "a\tb.ts", status: "M" }]));
    const row = w.find(".wtd-file");
    expect(row.attributes("disabled")).toBeUndefined();
    expect(row.find(".wtd-file-path").text()).toBe("a␉b.ts");
    await row.trigger("click");
    expect(w.emitted("open")).toHaveLength(1);
  });

  it("an orig with U+FFFD disables an otherwise-clean R entry (orig is part of the predicate)", () => {
    const w = mountList(okState([{ path: "renamed.ts", orig: "bad\uFFFD.ts", status: "R" }]));
    expect(w.find(".wtd-file").attributes("disabled")).toBeDefined();
    expect(w.find(".wtd-file").attributes("title")).toBe("Filename contains undecodable bytes — not requestable");
  });
});

describe("WorktreeFileList — entries, badges, chips, stats (§4.2)", () => {
  it("R shows `orig → path` with both visualized; binary and U carry chips; stats render +a −d", () => {
    const w = mountList(
      okState([
        { path: "renamed.ts", orig: "old\rname.ts", status: "R", add: 0, del: 0 },
        { path: "logo.png", status: "M", binary: true },
        { path: "merge.ts", status: "U" },
        { path: "new.ts", status: "A", add: 12, del: 0 },
        { path: "brand-new.txt", status: "?" },
      ]),
    );
    const rows = w.findAll(".wtd-file");
    expect(rows[0]!.find(".wtd-file-path").text()).toBe("old␍name.ts → renamed.ts");
    expect(rows[1]!.find(".wtd-chip").text()).toBe("bin");
    expect(rows[2]!.find(".wtd-chip").text()).toBe("conflict");
    expect(rows[3]!.find(".wtd-file-stat").text()).toBe("+12−0");
    expect(rows[4]!.find(".wtd-file-stat").exists()).toBe(false); // untracked: no counts
    const badges = w.findAll(".wtd-badge").map((b) => `${b.attributes("class")}|${b.text()}`);
    expect(badges[0]).toContain("is-r");
    expect(badges[0]).toContain("R");
    expect(badges[3]).toBe("wtd-badge is-a|A");
    expect(badges[4]).toContain("is-q");
  });

  it("the refresh button emits refresh; entries emit open with the raw entry (path never pre-visualized)", async () => {
    const entry: WtDiffFileEntry = { path: "src/a.ts", status: "M", add: 1, del: 2 };
    const w = mountList(okState([entry]));
    await w.find(".wtd-refresh").trigger("click");
    expect(w.emitted("refresh")).toHaveLength(1);
    await w.find(".wtd-file").trigger("click");
    expect(w.emitted("open")![0]![0]).toEqual(entry);
  });

  it("the empty state renders its note (and still the footnote + refresh)", () => {
    const w = mountList(okState([]));
    expect(w.find(".wtd-files-state").text()).toBe("No changes to show.");
    expect(w.find(".wtd-foot").exists()).toBe(true);
    expect(w.find(".wtd-refresh").exists()).toBe(true);
  });
});

describe("WorktreeFileList — standing footnote + degrade notes (D14/D20, §4.2)", () => {
  it("the static footnote renders in the entries, loading AND error states alike", () => {
    const withEntries = mountList(okState([{ path: "a.ts", status: "M" }]));
    const foot = withEntries.find(".wtd-foot");
    const text = "Protected entries are never listed; submodule changes are not shown.";
    // quiet ⓘ in the refresh row: text rides title/aria-label, revealed inline only on click
    expect(foot.attributes("title")).toBe(text);
    expect(foot.attributes("aria-label")).toBe(text);
    expect(withEntries.find(".wtd-foot-text").exists()).toBe(false);
    expect(foot.element.parentElement?.classList.contains("wtd-files-actions")).toBe(true);

    const loading = mountList({ phase: "loading", sig: "" });
    expect(loading.find(".wtd-foot").exists()).toBe(true);
    expect(loading.find(".wtd-files-state").attributes("role")).toBe("status");

    const error = mountList({
      phase: "error",
      sig: "",
      error: { code: "E_WTDIFF_UNSUPPORTED", reason: "git-too-old", retryable: true },
    });
    expect(error.find(".wtd-foot").exists()).toBe(true);
  });

  it("clicking the ⓘ reveals the footnote text inline (touch) and toggles it back", async () => {
    const w = mountList(okState([]));
    await w.find(".wtd-foot").trigger("click");
    expect(w.find(".wtd-foot").attributes("aria-expanded")).toBe("true");
    expect(w.find(".wtd-foot-text").text()).toBe(
      "Protected entries are never listed; submodule changes are not shown.",
    );
    await w.find(".wtd-foot").trigger("click");
    expect(w.find(".wtd-foot-text").exists()).toBe(false);
  });

  it("truncated / untrackedSkipped / numstatPartial / attrPartial each render their own note", () => {
    const w = mountList(
      okState([{ path: "a.ts", status: "M" }], {
        truncated: true,
        untrackedSkipped: true,
        numstatPartial: true,
        attrPartial: true,
      }),
    );
    const notes = w.findAll(".wtd-note").map((n) => n.text());
    expect(notes).toHaveLength(4);
    expect(notes[0]).toContain("truncated");
    expect(notes[1]).toContain("Untracked files were skipped");
    expect(notes[2]).toContain("Line counts unavailable");
    expect(notes[3]).toContain("Filter status unknown");
  });

  it("no notes when the list is complete", () => {
    const w = mountList(okState([{ path: "a.ts", status: "M" }]));
    expect(w.findAll(".wtd-note")).toHaveLength(0);
  });
});

describe("WorktreeFileList — error state (§1.5 mapping)", () => {
  it("maps code+reason through the taxonomy; retryable errors get a retry button", async () => {
    const w = mountList({
      phase: "error",
      sig: "",
      error: { code: "E_WTDIFF_UNSUPPORTED", reason: "git-too-old", retryable: true },
    });
    expect(w.find(".wtd-files-error-title").text()).toBe("Could not load changed files");
    expect(w.find(".wtd-files-error-text").text()).toBe("git is too old for this feature.");
    const retry = w.find(".wtd-files-retry");
    expect(retry.exists()).toBe(true);
    await retry.trigger("click");
    expect(w.emitted("refresh")).toHaveLength(1);
  });

  it("non-retryable errors show no retry button; unknown codes degrade to the generic text", () => {
    const w = mountList({ phase: "error", sig: "", error: { code: "E_WTF", retryable: false } });
    expect(w.find(".wtd-files-retry").exists()).toBe(false);
    expect(w.find(".wtd-files-error-text").text()).toBe("Request failed (E_WTF)");
  });

  it("tall lists (>200 entries) cap the container height", () => {
    const many: WtDiffFileEntry[] = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.ts`, status: "M" }));
    const w = mountList(okState(many, { total: 201 }));
    expect(w.find(".wtd-file-list").attributes("class")).toContain("is-tall");
    expect(w.findAll(".wtd-file")).toHaveLength(201);
  });
});
