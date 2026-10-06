// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import PickerSheet from "../../../src/web-hub/ui/src/components/control/PickerSheet.vue";

/**
 * `control/PickerSheet.vue` (web-model-switch plan v2 §5.1, package M3b — #16/A10): the
 * Teleport'd ≤640px bottom-sheet shell shared by the model chip and the thinking chip,
 * mirroring PreviewHost.vue's interaction contract — scrim `@click.self` close, Esc with
 * preventDefault+stopPropagation, focus enter (`[data-autofocus]` first, panel fallback),
 * Tab cycling, focus return, and a body scroll lock restored on unmount (the sheet only
 * exists while open, so close and unmount are one path).
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function mountSheet(
  slot = `<button type="button" class="first-btn">first</button>
    <button type="button" class="last-btn">last</button>`,
) {
  const wrapper = mount(PickerSheet, {
    attachTo: document.body,
    props: { label: "Picker" },
    slots: { default: slot },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("PickerSheet.vue — Teleport + dialog shell (§5.1 M3b)", () => {
  it("teleports to <body>: scrim + role=dialog aria-modal panel with the label", () => {
    mountSheet();
    const scrim = document.body.querySelector(".picker-scrim");
    expect(scrim).not.toBeNull();
    const panel = document.body.querySelector(".picker-sheet");
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("role")).toBe("dialog");
    expect(panel!.getAttribute("aria-modal")).toBe("true");
    expect(panel!.getAttribute("aria-label")).toBe("Picker");
    expect(panel!.textContent).toContain("first");
  });

  it("focus ENTERS on open: [data-autofocus] wins; without one the panel itself is focused", async () => {
    mountSheet(`<button type="button" class="first-btn" data-autofocus>marked</button>
      <button type="button" class="last-btn">last</button>`);
    await flush();
    expect(document.activeElement).toBe(document.body.querySelector(".first-btn"));

    const plain = mountSheet();
    await flush();
    expect(document.activeElement).toBe(document.body.querySelectorAll(".picker-sheet")[1]);
    plain.unmount();
  });

  it("Tab/Shift+Tab CYCLE inside the panel (PreviewHost trap)", async () => {
    mountSheet();
    await flush();
    const first = document.body.querySelector<HTMLElement>(".first-btn")!;
    const last = document.body.querySelector<HTMLElement>(".last-btn")!;
    const scrim = document.body.querySelector<HTMLElement>(".picker-scrim")!;

    last.focus();
    scrim.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    scrim.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
  });

  it("Esc closes with preventDefault + stopPropagation; scrim @click.self closes; panel clicks don't", async () => {
    const wrapper = mountSheet();
    await flush();
    const scrim = document.body.querySelector<HTMLElement>(".picker-scrim")!;
    const panel = document.body.querySelector<HTMLElement>(".picker-sheet")!;

    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    let propagated = false;
    document.body.addEventListener("keydown", () => {
      propagated = true;
    });
    scrim.dispatchEvent(esc);
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(esc.defaultPrevented).toBe(true);
    expect(propagated).toBe(false);

    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(wrapper.emitted("close")).toHaveLength(1); // inside click never reaches the scrim as .self

    scrim.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(wrapper.emitted("close")).toHaveLength(2);
  });

  it("body scroll is locked while open and restored on unmount (close AND unmount share the path)", async () => {
    document.body.style.overflow = "scroll";
    const wrapper = mountSheet();
    await flush();
    expect(document.body.style.overflow).toBe("hidden");
    wrapper.unmount();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("focus RETURNS to the previously focused element on unmount", async () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    expect(document.activeElement).toBe(before);

    const wrapper = mountSheet();
    await flush();
    expect(document.activeElement).not.toBe(before);
    wrapper.unmount();
    expect(document.activeElement).toBe(before);
  });
});
