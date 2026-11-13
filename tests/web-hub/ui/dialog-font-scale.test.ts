// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AskUserFloat from "../../../src/web-hub/ui/src/components/dialog/AskUserFloat.vue";
import PrivacyUnmarkDialog from "../../../src/web-hub/ui/src/components/privacy/PrivacyUnmarkDialog.vue";
import PreviewWindowMenu from "../../../src/web-hub/ui/src/components/preview/PreviewWindowMenu.vue";
import FleetTree from "../../../src/web-hub/ui/src/components/fleet/FleetTree.vue";
import FleetArchived from "../../../src/web-hub/ui/src/components/fleet/FleetArchived.vue";
import { buildFleetTree } from "../../../src/web-hub/ui/src/components/fleet/summary.js";
import { useFontScale } from "../../../src/web-hub/ui/src/composables/useFontScale.js";
import type { FleetRowWire } from "../../../src/web-hub/protocol/messages.js";

const mounted: Array<ReturnType<typeof mount>> = [];
const css = (name: string): string =>
  readFileSync(resolve(fileURLToPath(import.meta.url), `../../../../src/web-hub/ui/src/styles/${name}.css`), "utf8");
let styles: HTMLStyleElement;

beforeEach(() => {
  styles = document.createElement("style");
  styles.textContent = ["tokens", "base", "primitives", "dialog", "ask-float", "preview", "fleet", "privacy"]
    .map(css)
    .join("\n");
  document.head.appendChild(styles);
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.restoreAllMocks();
  styles.remove();
  document.documentElement.style.removeProperty("--fs-scale");
  document.body.innerHTML = "";
});

/** Happy DOM resolves cascading/inherited vars, but does not perform CSS calc arithmetic or
 * layout. Evaluate ONLY the simple length * scale expressions used here; do not pretend
 * these assertions are browser layout measurements. Bare px/rem are accepted so a regression
 * to an unscaled declaration fails at 200%, rather than failing just on source spelling. */
function pixels(el: Element, property = "font-size"): number {
  const value = getComputedStyle(el).getPropertyValue(property).trim();
  const match = /^(?:calc\()?([\d.]+)(px|rem)(?:\s*\*\s*([\d.]+)\))?$/.exec(value);
  expect(match, `${property}: ${value}`).not.toBeNull();
  return Number(match![1]) * (match![2] === "rem" ? 16 : 1) * Number(match![3] ?? 1);
}

function checkScales(assertAt: (scale: number) => void): void {
  const stored = new Map<string, string>();
  const scale = useFontScale({
    doc: document,
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value) },
  });
  assertAt(1);
  scale.setScale(2);
  expect(stored.get("pwh_fontscale")).toBe("2");
  assertAt(2);
  scale.reset();
  expect(stored.get("pwh_fontscale")).toBe("1");
  assertAt(1);
}

function expectSizes(selectors: Record<string, number>, scale: number): void {
  for (const [selector, baseline] of Object.entries(selectors)) {
    const elements = document.querySelectorAll(selector);
    expect(elements.length, selector).toBeGreaterThan(0);
    for (const el of elements) expect(pixels(el), selector).toBeCloseTo(baseline * scale);
  }
}

describe("dialog font scale — html preference reaches compact and Teleported surfaces", () => {
  it("scales AskUserFloat and its real AskUserForm without changing compact 100% sizes", async () => {
    // Happy DOM has no layout; expose the long-context control through its overflow seam.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(20);
    const question = {
      question: "Which plan?",
      context: "Context\n".repeat(4),
      options: [{ label: "(Recommended) Patch", description: "Small change" }, { label: "Rewrite" }],
    };
    mounted.push(
      mount(AskUserFloat, {
        attachTo: document.body,
        props: {
          epoch: "e1",
          dialogs: [
            {
              dialogId: "d1",
              source: "ask_user",
              toolCallId: "tc1",
              openedAt: 1,
              allowCancel: true,
              questions: [question, question],
            },
          ],
        },
      }),
    );
    await nextTick();
    await nextTick();
    checkScales((scale) => {
      expectSizes(
        {
          ".ask-float": 13,
          ".ask-float-bar": 13,
          ".ask-tabs button": 12,
          ".ask-question-text": 13,
          ".ask-option-label": 13,
          ".ask-context": 12,
          ".ask-option-desc": 12,
          ".ask-context-toggle": 12,
          ".ask-reco-tag": 11,
          ".ask-other-link": 12,
          ".ask-actions .btn": 12.5,
        },
        scale,
      );
      expect(pixels(document.querySelector(".ask-reco-tag")!, "line-height")).toBe(16 * scale);
    });
  });

  it("inherits html tokens outside the app root in the Teleported privacy confirmation", () => {
    const host = document.createElement("div");
    host.id = "app";
    document.body.appendChild(host);
    mounted.push(mount(PrivacyUnmarkDialog, { attachTo: host, props: { mode: "token", busy: false, error: null } }));
    expect(host.querySelector(".privacy-unmark")).toBeNull();
    expect(document.body.querySelector(".privacy-unmark")).not.toBeNull();
    checkScales((scale) =>
      expectSizes({ ".privacy-unmark-title": 14, ".privacy-unmark-body": 13, ".privacy-unmark .btn": 13 }, scale),
    );
  });

  it("scales the preview window menu's rem exceptions exactly once", async () => {
    const w = mount(PreviewWindowMenu, {
      attachTo: document.body,
      props: {
        items: [{ id: 1, name: "notes.md", path: "/project/notes.md", current: true }],
        showReset: true,
        showMaximize: true,
        maximized: false,
      },
    });
    mounted.push(w);
    await w.get("button").trigger("click");
    // Host/window-only notices use the same stylesheet, without needing preview transport.
    const notices = document.createElement("div");
    notices.innerHTML = '<span class="preview-window-limit">Window limit</span><span class="pw-count">1/2</span>';
    document.body.appendChild(notices);
    checkScales((scale) =>
      expectSizes(
        { ".pw-menu-dots": 16.8, ".pw-menu-path": 13.12, ".preview-window-limit": 13.76, ".pw-count": 12.48 },
        scale,
      ),
    );
  });

  it("scales active and archived Fleet badges, their tracks and nested alignment", async () => {
    const row = (runId: string, parentRunId?: string): FleetRowWire => ({
      runId,
      label: runId,
      type: "general",
      status: "done",
      phaseLabel: "done",
      elapsedMs: 0,
      phaseMs: 0,
      highlight: "none",
      terminal: true,
      ...(parentRunId === undefined ? {} : { parentRunId }),
    });
    const rows = [row("parent"), row("child", "parent")];
    mounted.push(mount(FleetTree, { attachTo: document.body, props: { nodes: buildFleetTree(rows), now: 0 } }));
    const archived = mount(FleetArchived, { attachTo: document.body, props: { rows, set: new Map() } });
    mounted.push(archived);
    await archived.get(".fleet-archived-fold").trigger("click");
    checkScales((scale) => {
      expectSizes({ ".tree .run-type": 10, ".fleet-archived .run-type": 10 }, scale);
      for (const badge of document.querySelectorAll(".run-type")) {
        expect(pixels(badge, "width")).toBe(16 * scale);
        expect(pixels(badge, "height")).toBe(16 * scale);
      }
    });
    // Happy DOM has no grid layout: pin both responsive grid tracks and the exact alignment
    // equation (child icon centre = parent badge centre); 100% is 18px + gap, 200% 26px + gap.
    const fleet = css("fleet");
    expect(fleet.match(/grid-template-columns: 20px var\(--tree-badge-size\)/g)).toHaveLength(2);
    expect(fleet).toContain(
      "padding-left: calc(10px + var(--tree-badge-size) / 2 + var(--tree-gap) - var(--tree-pad) - 9px - 1px)",
    );
  });
});
