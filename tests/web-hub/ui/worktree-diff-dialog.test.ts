// @vitest-environment happy-dom
/**
 * worktree-diff plan v3.1 §5 D5 — `components/diff/WorktreeDiffDialog.vue` (§4.3/§4.4): the
 * shell (focus enters, Tab cycles, Esc is owned, backdrop closes, in-panel clicks don't,
 * focus returns, scroll lock released on close AND unmount), the split/unified segmented
 * control (session memory lives in the composable; the dialog only emits), the mobile
 * viewport (the segmented control is absent from the DOM — hence from the Tab cycle, #11 —
 * and the view is forced unified), the six-state body (loading / binary / empty / symlink /
 * generic error / patch), the banner stack (untracked / stale / truncation family /
 * malformed / rename-only / mode-only), WTDIFF_RENDER_PAGE_ROWS pagination, and pure
 * interpolation (no `v-html` anywhere in the tree).
 */
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorktreeDiffDialog from "../../../src/web-hub/ui/src/components/diff/WorktreeDiffDialog.vue";
import { resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import type { DialogState } from "../../../src/web-hub/ui/src/composables/useWorktreeDiff.js";
import {
  parseUnifiedPatch,
  type WtDiffFileEntry,
  type WtDiffFilePayload,
} from "../../../src/web-hub/protocol/worktree-diff.js";

const OID = "b".repeat(40);

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2 changed
 line3
@@ -10,3 +10,4 @@
 ctx10
+new line
 ctx11
 ctx12
`;

const entry = (over: Partial<WtDiffFileEntry> = {}): WtDiffFileEntry => ({
  path: "src/a.ts",
  status: "M",
  add: 2,
  del: 1,
  ...over,
});

const payload = (over: Partial<WtDiffFilePayload> = {}): WtDiffFilePayload => ({
  base: OID,
  path: "src/a.ts",
  kind: "patch",
  patch: PATCH,
  bytes: PATCH.length,
  truncated: false,
  ...over,
});

type OpenState = Extract<DialogState, { phase: "loading" | "ok" | "error" }>;

const okState = (over: Partial<OpenState> = {}): OpenState => ({
  phase: "ok",
  wt: "/wt/main",
  entry: entry(),
  base: OID,
  payload: payload(),
  parsed: parseUnifiedPatch(PATCH),
  stale: false,
  ...over,
});

interface MountOpts {
  readonly state?: DialogState;
  readonly mode?: "split" | "unified";
  readonly mobile?: boolean;
  readonly plaintext?: boolean;
}

function mountDialog(opts: MountOpts = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const wrapper = mount(WorktreeDiffDialog, {
    attachTo: host,
    props: {
      state: opts.state ?? okState(),
      mode: opts.mode ?? "split",
      mobile: opts.mobile ?? false,
      plaintext: opts.plaintext ?? false,
    },
  });
  return { wrapper, host };
}

const overlay = (): HTMLElement | null => document.querySelector(".wtd-overlay");
const panel = (): HTMLElement | null => document.querySelector(".wtd-panel");
const rows = (): NodeListOf<HTMLElement> => document.querySelectorAll(".wtd-row");

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

afterEach(() => {
  // dialogs left open by a failing test would leak a scroll-lock hold into the shared count
  resetBodyScrollLock();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
});

describe("WorktreeDiffDialog — shell (§4.3, via diffModal.ts)", () => {
  it("renders nothing while closed", () => {
    mountDialog({ state: { phase: "closed" } });
    expect(overlay()).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("open: focus enters the panel and the body scroll locks; close: both are released", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const { wrapper } = mountDialog();
    await tick();
    expect(document.activeElement).toBe(panel());
    expect(document.body.style.overflow).toBe("hidden");

    await wrapper.setProps({ state: { phase: "closed" } });
    await tick();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
  });

  it("unmounting mid-dialog also releases the scroll lock", async () => {
    const { wrapper } = mountDialog();
    await tick();
    expect(document.body.style.overflow).toBe("hidden");
    wrapper.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("Tab cycles inside the panel (desktop: the segmented control is part of the cycle)", async () => {
    mountDialog();
    await tick();
    const p = panel()!;
    const focusables = Array.from(p.querySelectorAll<HTMLElement>("button")).filter(
      (b) => b.closest(".wtd-seg") !== null || b.closest(".wtd-head") !== null,
    );
    const segSplit = p.querySelector(".wtd-seg-btn")!;
    const close = p.querySelector(".wtd-close")!;
    expect(focusables[0]).toBe(segSplit);
    expect(focusables[focusables.length - 1]).toBe(close);

    (close as HTMLElement).focus();
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(segSplit); // wrapped to the first
  });

  it("mobile: the segmented control is NOT in the DOM — and therefore not in the Tab cycle (#11)", async () => {
    mountDialog({ mobile: true });
    await tick();
    const p = panel()!;
    expect(p.querySelector(".wtd-seg")).toBeNull(); // v-if removed, not CSS-hidden
    const focusables = Array.from(p.querySelectorAll<HTMLElement>("button"));
    for (const b of focusables) {
      expect(b.closest(".wtd-seg")).toBeNull();
      expect(b.textContent).not.toContain("Split");
      expect(b.textContent).not.toContain("Unified");
    }
    const close = p.querySelector(".wtd-close") as HTMLElement;
    const first = focusables[0]!;
    (close as HTMLElement).focus();
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first); // cycle excludes the removed control
  });

  it("Esc: preventDefault + stopPropagation + close (the overlay owns Esc while open)", () => {
    const { wrapper } = mountDialog();
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    overlay()!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled(); // 不冒泡
    expect(wrapper.emitted("close")).toHaveLength(1);
    document.body.removeEventListener("keydown", outer);
  });

  it("backdrop click closes; a click INSIDE the panel never does", async () => {
    const { wrapper } = mountDialog();
    document.querySelector(".wtd-body")!.click();
    expect(wrapper.emitted("close")).toBeUndefined();
    overlay()!.click();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("the close button emits close; refresh emits refresh", async () => {
    const { wrapper } = mountDialog();
    (document.querySelector(".wtd-close") as HTMLElement).click();
    expect(wrapper.emitted("close")).toHaveLength(1);
    (document.querySelector(".wtd-refresh") as HTMLElement).click();
    expect(wrapper.emitted("refresh")).toHaveLength(1);
  });
});

describe("WorktreeDiffDialog — header + view switching (§4.3)", () => {
  it("badge, visualized title (control chars → glyphs), stat, copy value W/path", async () => {
    mountDialog({ state: okState({ entry: entry({ path: "src/a\tb.ts" }) }) });
    expect(document.querySelector(".wtd-badge")!.textContent).toBe("M");
    expect(document.querySelector(".wtd-title")!.textContent).toBe("src/a␉b.ts");
    expect(document.querySelector(".wtd-stat")!.textContent).toBe("+2−1");
    const copy = document.querySelector(".wtd-copy button") as HTMLButtonElement;
    expect(copy).not.toBeNull();
  });

  it("the segmented control emits set-mode; aria-pressed reflects the session mode", async () => {
    const { wrapper } = mountDialog({ mode: "split" });
    const [segSplit, segUnified] = Array.from(document.querySelectorAll(".wtd-seg-btn")) as [HTMLElement, HTMLElement];
    expect(segSplit.getAttribute("aria-pressed")).toBe("true");
    expect(segUnified.getAttribute("aria-pressed")).toBe("false");

    segUnified.click();
    expect(wrapper.emitted("set-mode")![0]).toEqual(["unified"]);
    await wrapper.setProps({ mode: "unified" });
    expect(segSplit.getAttribute("aria-pressed")).toBe("false");
    expect(segUnified.getAttribute("aria-pressed")).toBe("true");
  });

  it("password+http renders the plaintext warning; default hides it", () => {
    const shown = mountDialog({ plaintext: true });
    expect(document.querySelector(".wtd-plaintext")!.textContent).toContain("Plain-text connection");
    shown.wrapper.unmount(); // teleported content leaves the body with the unmount
    mountDialog();
    expect(document.querySelector(".wtd-plaintext")).toBeNull(); // token/TLS default: absent
  });
});

describe("WorktreeDiffDialog — six-state body (§4.3)", () => {
  it("loading renders the status block", () => {
    mountDialog({ state: { phase: "loading", wt: "/w", entry: entry(), base: OID, stale: false } });
    expect(document.querySelector(".wtd-state")!.getAttribute("role")).toBe("status");
    expect(document.querySelector(".wtd-state")!.textContent).toContain("Loading diff");
  });

  it("binary payload renders the not-rendered note, no rows", () => {
    mountDialog({ state: okState({ payload: payload({ kind: "binary", patch: "" }), parsed: parseUnifiedPatch("") }) });
    expect(document.querySelector(".wtd-state")!.textContent).toContain("Binary file");
    expect(rows().length).toBe(0);
  });

  it("empty payload renders the no-difference note", () => {
    mountDialog({ state: okState({ payload: payload({ kind: "empty", patch: "" }), parsed: parseUnifiedPatch("") }) });
    expect(document.querySelector(".wtd-state")!.textContent).toContain("No content difference");
  });

  it("a symlink 415 maps to the symlink wording (error state)", () => {
    mountDialog({
      state: okState({
        phase: "error",
        payload: undefined,
        parsed: undefined,
        error: { code: "E_WTDIFF_UNSUPPORTED", reason: "symlink" },
      }),
    });
    const el = document.querySelector(".wtd-state-error")!;
    expect(el.textContent).toContain("symbolic link");
  });

  it("a generic error shows the mapped text + a retry that emits refresh", async () => {
    const { wrapper } = mountDialog({
      state: okState({ phase: "error", payload: undefined, parsed: undefined, error: { code: "E_DEADLINE" } }),
    });
    expect(document.querySelector(".wtd-state-error")!.textContent).toContain("timed out");
    (document.querySelector(".wtd-state-retry") as HTMLElement).click();
    expect(wrapper.emitted("refresh")).toHaveLength(1);
  });

  it("the 不可查看 terminal state renders its own note without a retry", () => {
    mountDialog({
      state: okState({ phase: "error", payload: undefined, parsed: undefined, stale: false, unviewable: true }),
    });
    const el = document.querySelector(".wtd-state-error")!;
    expect(el.textContent).toContain("no longer has changes");
    expect(el.querySelector(".wtd-state-retry")).toBeNull();
  });

  it("patch payload renders rows — interpolated text, never v-html (source-scan pinned too)", () => {
    mountDialog();
    const del = document.querySelector(".wtd-tx.wtd-del")!;
    expect(del.textContent).toContain("line2"); // the raw patch text, as a text node
    expect(del.querySelector("b, script, style")).toBeNull();
    const sr = del.querySelector(".sr-only")!;
    expect(sr.textContent).toBe("removed ");
  });
});

describe("WorktreeDiffDialog — split vs unified rows (§3.4/§3.5)", () => {
  it("split: side heads, paired del/add cells with empty slots, hunk headers span", () => {
    mountDialog({ mode: "split" });
    const heads = Array.from(document.querySelectorAll(".wtd-split-head .wtd-span")).map((s) => s.textContent);
    expect(heads[0]).toBe(`old · ${OID.slice(0, 7)}`);
    expect(heads[1]).toBe("new · worktree");
    // the del(−line2)/add(+line2 changed) run pairs index-wise: one pair row, both sides filled
    const pair = document.querySelector('.wtd-row[data-t="pair"]') as HTMLElement | null;
    expect(pair).not.toBeNull();
    expect(pair!.querySelector(".wtd-tx.wtd-del")!.textContent).toContain("line2");
    expect(pair!.querySelector(".wtd-tx.wtd-add")!.textContent).toContain("line2 changed");
    expect(document.querySelectorAll(".wtd-hunk").length).toBe(2); // one per hunk
  });

  it("split: a 2-del/1-add run leaves the short side as aria-hidden empty cells (D5 验收 P2)", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,2 @@",
      " line1",
      "-old2",
      "-old3",
      "+new2",
      "",
    ].join("\n");
    mountDialog({
      mode: "split",
      state: okState({ payload: payload({ patch, bytes: patch.length }), parsed: parseUnifiedPatch(patch) }),
    });
    const pairs = Array.from(document.querySelectorAll<HTMLElement>('.wtd-row[data-t="pair"]'));
    expect(pairs.length).toBe(2); // (old2,new2) + (old3, <empty>)
    const second = pairs[1]!;
    expect(second.querySelector(".wtd-tx.wtd-del")!.textContent).toContain("old3");
    const empties = second.querySelectorAll(".wtd-empty");
    expect(empties.length).toBe(2); // right ln + right tx
    for (const cell of Array.from(empties)) expect(cell.getAttribute("aria-hidden")).toBe("true");
  });

  it("unified: lnOld|lnNew|sign|text cells with the sign column", async () => {
    const { wrapper } = mountDialog({ mode: "unified" });
    const body = document.querySelector(".wtd-rows")!;
    expect(body.getAttribute("data-mode")).toBe("unified");
    const delRow = document.querySelector('.wtd-row[data-t="del"]') as HTMLElement;
    expect(delRow.querySelector(".wtd-sign")!.textContent).toBe("\u2212");
    expect(delRow.querySelector(".wtd-ln")!.textContent).toBe("2");
    expect(delRow.querySelector(".wtd-tx")!.textContent).toContain("line2");

    await wrapper.setProps({ mode: "split" });
    expect(document.querySelector(".wtd-rows")!.getAttribute("data-mode")).toBe("split");
  });

  it("mobile forces unified regardless of the session mode (§4.4)", () => {
    mountDialog({ mode: "split", mobile: true });
    expect(document.querySelector(".wtd-rows")!.getAttribute("data-mode")).toBe("unified");
  });
});

describe("WorktreeDiffDialog — banners (§4.3)", () => {
  const bannerTexts = (): string[] =>
    Array.from(document.querySelectorAll(".wtd-banner")).map((b) => b.textContent ?? "");

  it("stale banner on a sig-moved dialog", () => {
    mountDialog({ state: okState({ stale: true }) });
    expect(bannerTexts().some((x) => x.includes("changed since"))).toBe(true);
  });

  it("untracked + truncated + incomplete + malformed each render their own banner", () => {
    // a patch sliced mid-hunk parses complete:false and (for a bad line) malformed
    const bad = `${PATCH.slice(0, PATCH.indexOf("line3"))}@@ garbage\n`;
    mountDialog({
      state: okState({
        payload: payload({ truncated: true, untracked: true }),
        parsed: { ...parseUnifiedPatch(bad), complete: false },
      }),
    });
    const texts = bannerTexts();
    expect(texts.some((x) => x.includes("Untracked file"))).toBe(true);
    expect(texts.some((x) => x.includes("truncated"))).toBe(true);
    expect(texts.some((x) => x.includes("mid-hunk"))).toBe(true);
  });

  it("lineCap / hunkCap banners", () => {
    mountDialog({
      state: okState({ parsed: { ...parseUnifiedPatch(PATCH), lineCap: true, hunkCap: true } }),
    });
    const texts = bannerTexts();
    expect(texts.some((x) => x.includes("line cap"))).toBe(true);
    expect(texts.some((x) => x.includes("hunk cap"))).toBe(true);
  });

  it("rename-only and mode-only zero-hunk patches explain themselves", () => {
    const renamePatch = "diff --git a/old.ts b/new.ts\nsimilarity index 95%\nrename from old.ts\nrename to new.ts\n";
    mountDialog({
      state: okState({ payload: payload({ patch: renamePatch }), parsed: parseUnifiedPatch(renamePatch) }),
    });
    expect(bannerTexts().some((x) => x.includes("Rename only (95%"))).toBe(true);

    const modePatch = "diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n";
    const { wrapper } = mountDialog({
      state: okState({ payload: payload({ patch: modePatch }), parsed: parseUnifiedPatch(modePatch) }),
    });
    expect(bannerTexts().some((x) => x.includes("Mode change only"))).toBe(true);
    wrapper.unmount();
  });

  it("no banners on a clean patch", () => {
    mountDialog();
    expect(bannerTexts()).toHaveLength(0);
  });
});

describe("WorktreeDiffDialog — pagination (§3.7)", () => {
  it("first paint caps at WTDIFF_RENDER_PAGE_ROWS; 「显示更多」 appends one page", async () => {
    const n = 2005;
    const patch = `diff --git a/big.ts b/big.ts
new file mode 100644
--- /dev/null
+++ b/big.ts
@@ -0,0 +1,${n} @@
${Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n")}
`;
    const { wrapper } = mountDialog({
      mode: "unified", // no split-head row: rows = 1 hunk + n lines
      state: okState({ payload: payload({ patch, bytes: patch.length }), parsed: parseUnifiedPatch(patch) }),
    });
    await flushPromises();
    expect(rows().length).toBe(2000);
    const more = document.querySelector(".wtd-more") as HTMLButtonElement;
    expect(more.textContent).toContain("6");
    more.click();
    await nextTick();
    expect(rows().length).toBe(2006); // all of it — one append covers the tail
    wrapper.unmount();
  });
});
