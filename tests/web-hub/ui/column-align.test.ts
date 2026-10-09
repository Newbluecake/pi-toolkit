import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 2026-10-09 「边缘两侧没有对齐」: the control dock's children must share the transcript
 * column's geometry — the same side gutter token (`--col-gutter`, sp-3 on phones, sp-6 from
 * 481px) and the same centre line (the transcript reserves a stable scrollbar gutter, the dock
 * mirrors it with `padding-right: var(--sb-w)`, measured in main.ts).
 */
const read = (f: string): string =>
  readFileSync(resolve(fileURLToPath(import.meta.url), `../../../../src/web-hub/ui/src/${f}`), "utf8");
const rule = (css: string, selector: string): string => {
  const m = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`).exec(css);
  return m?.[0] ?? "";
};

describe("transcript ↔ control dock column alignment", () => {
  const tokens = read("styles/tokens.css");
  const transcript = read("styles/transcript.css");
  const control = read("styles/control.css");

  it("one gutter token drives both columns (phones sp-3, tablet+ sp-6)", () => {
    expect(tokens).toMatch(/--col-gutter:\s*var\(--sp-3\)/);
    expect(tokens).toMatch(/@media \(min-width: 481px\)\s*\{\s*:root\s*\{\s*--col-gutter:\s*var\(--sp-6\)/);
    expect(rule(transcript, ".tx-inner")).toMatch(/padding:\s*var\(--sp-3\) var\(--col-gutter\)/);
    expect(transcript).toMatch(/padding:\s*var\(--sp-4\) var\(--col-gutter\) var\(--sp-8\)/);
    const child = rule(control, ".dock.dock-ctl > *");
    expect(child).toMatch(/padding-left:\s*max\(var\(--col-gutter\)/);
    expect(child).toMatch(/padding-right:\s*max\(var\(--col-gutter\)/);
  });

  it("same centre line: stable scrollbar gutter on the transcript, mirrored by the dock", () => {
    expect(rule(transcript, ".transcript")).toMatch(/scrollbar-gutter:\s*stable/);
    expect(rule(control, ".dock-ctl")).toMatch(/padding-right:\s*var\(--sb-w, 0px\)/);
    expect(read("main.ts")).toMatch(/setProperty\("--sb-w"/);
  });
});

describe("ask_user card rides the composer column (2026-10-09 「ask user 宽度和输入框+发送按钮的整体宽度保持一致」)", () => {
  const control = read("styles/control.css");
  const dialog = read("styles/dialog.css");
  const agentDetail = read("components/detail/AgentDetail.vue");

  it("the form shares ONE geometry rule with the dock's bordered children (control.css, single source)", () => {
    // One rule covers command-result, command-confirm AND the slot-mounted ask_user form —
    // extending the existing selector list, not re-declaring the calc anywhere else.
    const shared =
      /\.dock\.dock-ctl > \.command-result,\s*\.dock\.dock-ctl > \.command-confirm,\s*\.detail-main > \.ask-user-slot > \.ask-user-form\s*\{[^}]*\}/.exec(
        control,
      )?.[0] ?? "";
    expect(shared).not.toBe("");
    expect(shared).toMatch(
      /width:\s*calc\(\s*100% - max\(var\(--col-gutter\), env\(safe-area-inset-left\)\) - max\(var\(--col-gutter\), env\(safe-area-inset-right\)\)\s*\)/,
    );
    expect(shared).toMatch(/max-width:\s*calc\(var\(--transcript-max\) - 2 \* var\(--col-gutter\)\)/);
    // the form is NOT a dock child, so the centring must live in the shared rule itself
    expect(shared).toMatch(/margin-inline:\s*auto/);
  });

  it("the slot (above the dock, outside `.dock-ctl`) mirrors the dock's `--sb-w` compensation", () => {
    // AgentDetail mounts the slot BEFORE DetailDock as a `.detail-main` sibling — that is why
    // the box is reproduced (slot padding + shared rule) instead of inherited from `> *`.
    const slotIdx = agentDetail.indexOf('class="ask-user-slot"');
    const dockIdx = agentDetail.indexOf("<DetailDock");
    expect(slotIdx).toBeGreaterThan(-1);
    expect(dockIdx).toBeGreaterThan(slotIdx);
    expect(rule(dialog, ".ask-user-slot")).toMatch(/padding-right:\s*var\(--sb-w, 0px\)/);
  });

  it("dialog.css never declares the form's width — no second geometry source can drift", () => {
    const formRule = rule(dialog, ".ask-user-form");
    expect(formRule).toMatch(/overflow-y:\s*auto/); // still the form's own scrollport
    expect(formRule).not.toMatch(/(^|\s)(width|max-width):/);
  });

  it("2026-10-09: on desktop the attach button stays in the expanded chips row while typing (no jump)", () => {
    const upload = read("styles/upload.css");
    expect(upload).toMatch(
      /@media \(min-width: 1025px\)\s*\{\s*\.composer-input:has\(\.model-switcher\) \.composer-attach\s*\{[^}]*position:\s*relative/,
    );
  });
});
