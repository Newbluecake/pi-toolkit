/**
 * web-hub-preview-windows plan r2 §5.2 (W3): the overlay-root selector convergence.
 *
 * - `MODAL_OVERLAY_ROOTS` is the exact plan §5.2 selector: the desktop modeless
 *   preview-window root is EXCLUDED via `:not(.is-modeless)` (a bare `.preview-overlay`
 *   compound must NOT appear), while everything else that reuses the base class
 *   (AttachmentImagePreview, the phone stack) stays matched.
 * - Source assertion: no second `const OVERLAY_ROOTS =` definition exists anywhere under
 *   `src/web-hub/ui/src` (the four former duplicates now import the shared constant).
 * - The four plan-named dialogs import it (ProxyDialog appends `.proxy-scrim`).
 */
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODAL_OVERLAY_ROOTS } from "../../../src/web-hub/ui/src/logic/overlayRoots.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const UI_SRC = resolve(ROOT, "src/web-hub/ui/src");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

describe("logic/overlayRoots.ts — §5.2 convergence", () => {
  it("is the exact plan selector: modeless preview windows excluded, modal preview overlays kept", () => {
    const selectors = MODAL_OVERLAY_ROOTS.split(",").map((s) => s.trim());
    expect(selectors).toEqual([
      ".spawn-scrim",
      ".picker-scrim",
      ".preview-overlay:not(.is-modeless)",
      ".privacy-scrim",
    ]);
  });

  it("source: no `const OVERLAY_ROOTS =` definition anywhere under ui/src except overlayRoots.ts itself", () => {
    const files = globSync("**/*.{vue,ts,js}", { cwd: UI_SRC }).map((f) => resolve(UI_SRC, f));
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith("overlayRoots.ts")) continue;
      if (/\bconst\s+OVERLAY_ROOTS\s*=/.test(stripComments(readFileSync(f, "utf8")))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("the four plan-named dialogs import the shared constant", () => {
    const files = [
      "components/spawn/DirPicker.vue",
      "components/spawn/SessionHistoryDialog.vue",
      "components/privacy/PrivacyUnmarkDialog.vue",
      "components/proxy/ProxyDialog.vue",
    ] as const;
    for (const rel of files) {
      const src = readFileSync(resolve(UI_SRC, rel), "utf8");
      expect(src, rel).toMatch(/import\s*\{[^}]*MODAL_OVERLAY_ROOTS[^}]*\}\s*from\s*["'][^"']*overlayRoots\.js["']/);
    }
  });

  it("ProxyDialog appends its own .proxy-scrim to the shared selector", () => {
    const src = readFileSync(resolve(UI_SRC, "components/proxy/ProxyDialog.vue"), "utf8");
    expect(src).toMatch(/MODAL_OVERLAY_ROOTS\s*\+\s*",\s*\.proxy-scrim"/);
  });
});
