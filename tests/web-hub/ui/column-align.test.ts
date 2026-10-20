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

describe("ask_user floating window (2026-10-20 user ruling 「非模态浮窗」, mock ~/pwh-preview/askfloat/ask-float.png)", () => {
  const askFloat = read("styles/ask-float.css");
  const dialog = read("styles/dialog.css");
  const agentDetail = read("components/detail/AgentDetail.vue");

  it("AgentDetail mounts ONE AskUserFloat (not per-dialog in-flow slots) just above the dock", () => {
    // The float's root is a height-0 in-flow anchor right before the folded notes /
    // DetailDock, so its default bottom edge always lands just above the composer.
    const floatIdx = agentDetail.indexOf("<AskUserFloat");
    const dockIdx = agentDetail.indexOf("<DetailDock");
    expect(floatIdx).toBeGreaterThan(-1);
    expect(dockIdx).toBeGreaterThan(floatIdx);
    expect(agentDetail).not.toContain('class="ask-user-slot"');
    expect(agentDetail).not.toContain("<AskUserForm"); // stacked INSIDE AskUserFloat now
  });

  it("the desktop window floats above the composer: min(360px, 90vw), max 70vh, anchored bottom-right", () => {
    expect(rule(askFloat, ".ask-anchor")).toMatch(/height:\s*0/); // in-flow marker, no measuring
    const desktop = /@media \(min-width: 768px\)\s*\{\s*\.ask-float\s*\{[^}]*\}/.exec(askFloat)?.[0] ?? "";
    expect(desktop).not.toBe("");
    expect(desktop).toMatch(/width:\s*min\(360px,\s*90vw\)/); // compact ruling 2026-10-20
    expect(desktop).toMatch(/max-height:\s*70vh/);
    expect(desktop).toMatch(/bottom:\s*var\(--sp-2\)/);
    expect(desktop).toMatch(/right:\s*max\(var\(--col-gutter\)/);
  });

  it("position: fixed + z-index tier 45 — above the drawers (40), below every modal-ish layer (50+)", () => {
    // Verifier round 3 (2026-10-20): explicit app-wide tiers, canonical table in ask-float.css.
    // The float may be dragged across the agents tree / fleet drawer, so it stacks ABOVE the
    // drawers (30/40) but BELOW the modal-ish sheets/panels (picker scrim, spawn scrim,
    // settings panel, ctx-ring panels — all 50) and the real modals (preview 60).
    expect(rule(askFloat, ".ask-float")).toMatch(/position:\s*fixed/);
    expect(rule(askFloat, ".ask-float")).toMatch(/z-index:\s*45\b/);
    const drawer = read("styles/drawer.css");
    expect(drawer).toMatch(/z-index:\s*30\b/); // overlay tier we sit above
    expect(drawer).toMatch(/z-index:\s*40\b/); // fullscreen tier we sit above
    expect(rule(read("styles/models.css"), ".picker-scrim")).toMatch(/z-index:\s*50\b/); // above us
    expect(rule(read("styles/models.css"), ".model-panel--fixed")).toMatch(/z-index:\s*55\b/); // above us
    expect(rule(read("styles/spawn.css"), ".spawn-scrim")).toMatch(/z-index:\s*50\b/); // above us
    expect(rule(read("styles/shell.css"), ".settings-panel")).toMatch(/z-index:\s*50\b/); // above us
    expect(rule(read("styles/control.css"), ".ctx-ring-panel")).toMatch(/z-index:\s*50\b/); // above us
    expect(rule(read("styles/preview.css"), ".preview-overlay")).toMatch(/z-index:\s*60\b/); // modal tier
  });

  it("band split: the phone sheet is in-flow anchored (absolute, tier 20) — never viewport-fixed", () => {
    // Verifier round 3: on <768px the sheet must sit ABOVE the composer (anchored to the
    // in-flow .ask-anchor so a growing dock pushes it up) and BELOW the fullscreen drawer
    // (40). Desktop keeps the fixed/viewport behaviour asserted above.
    const phone = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(askFloat)?.[0] ?? "";
    expect(phone).not.toBe("");
    expect(phone).toMatch(/\.ask-anchor\s*\{[^}]*position:\s*relative/);
    expect(phone).toMatch(/\.ask-anchor\s*\{[^}]*z-index:\s*20\b/); // below the drawer tiers (30/40)
    expect(phone).toMatch(/\.ask-float\s*\{[^}]*position:\s*absolute/);
  });

  it("the phone sheet spans the composer gutter and caps at 60vh", () => {
    const phoneBlock = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(askFloat)?.[1] ?? "";
    const phone = /\.ask-float\s*\{[^}]*\}/.exec(phoneBlock)?.[0] ?? "";
    expect(phone).not.toBe("");
    expect(phone).toMatch(/left:\s*max\(var\(--col-gutter\)/);
    expect(phone).toMatch(/right:\s*max\(var\(--col-gutter\)/);
    expect(phone).toMatch(/max-height:\s*60vh/);
  });

  it("dialog.css never declares the form's width — no second geometry source can drift", () => {
    const formRule = rule(dialog, ".ask-user-form");
    expect(formRule).toMatch(/overflow-y:\s*auto/); // still the form's own scrollport standalone
    expect(formRule).not.toMatch(/(^|\s)(width|max-width):/);
    expect(rule(dialog, ".ask-user-slot")).toBe(""); // legacy in-flow slot rule removed with the float
  });

  it("2026-10-09: on desktop the attach button stays in the expanded chips row while typing (no jump)", () => {
    const upload = read("styles/upload.css");
    expect(upload).toMatch(
      /@media \(min-width: 1025px\)\s*\{\s*\.composer-input:has\(\.model-switcher\) \.composer-attach\s*\{[^}]*position:\s*relative/,
    );
  });
});
