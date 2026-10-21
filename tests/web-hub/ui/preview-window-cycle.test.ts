// @vitest-environment happy-dom
/**
 * `usePreviewWindowCycle` (preview-windows plan r2 §5.6, W3): the conversation ⇄ window
 * `Ctrl+`` / `Ctrl+Shift+`` switcher, driven through a harness that mimics EXACTLY the two
 * contracts the composable relies on (and W2 must implement):
 *
 * - DOM (§5.3/§7.2): `.preview-overlay.is-windows.is-modeless` > `.preview-window` sections,
 *   each holding a `.preview-panel[role=dialog][aria-labelledby="pw-title-<id>"]` — that
 *   `aria-labelledby` id is the only window-identity channel in the DOM;
 * - host landing (§5.4): `focusWindow(id, {moveFocus:true})` emits a `focusRequest`, which
 *   the host lands by focusing that window's panel after nextTick.
 *
 * The face here is a minimal fake; the pure ring math is covered by
 * `logic-preview-window-cycle.test.ts`.
 */
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, shallowRef, watch, type PropType } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { usePreviewWindowCycle } from "../../../src/web-hub/ui/src/composables/usePreviewWindowCycle.js";
import type { PreviewWindowsFace, PreviewWindow } from "../../../src/web-hub/ui/src/composables/usePreviewWindows.js";

/** A minimal §4.3 windows face: focusWindow reorders + emits focusRequest; `drop` mimics
 *  the manager's closeWindow (removes from windows/order) for the stale-ring test. */
function makeFace(ids: number[]): { face: PreviewWindowsFace; drop: (id: number) => void } {
  const windows = shallowRef<readonly PreviewWindow[]>(ids.map((id) => ({ id, handle: {} as never })));
  const order = ref<readonly number[]>([...ids]);
  const activeId = ref<number | null>(ids.length > 0 ? ids[ids.length - 1]! : null);
  const focusRequest = ref<{ id: number; seq: number } | null>(null);
  const limitNotice = ref<{ id: number; seq: number } | null>(null);
  let seq = 0;
  const face: PreviewWindowsFace = {
    windows,
    order,
    activeId,
    focusRequest,
    limitNotice,
    openWindow: () => "ignored",
    closeWindow: () => {},
    focusWindow(id, opts) {
      order.value = [...order.value.filter((x) => x !== id), id];
      activeId.value = id;
      if (opts?.moveFocus === true) focusRequest.value = { id, seq: ++seq };
    },
    closeAll: () => {},
  };
  const drop = (id: number): void => {
    windows.value = windows.value.filter((w) => w.id !== id);
    order.value = order.value.filter((x) => x !== id);
    if (activeId.value === id) activeId.value = order.value.at(-1) ?? null;
  };
  return { face, drop };
}

const Harness = defineComponent({
  props: {
    ids: { type: Array as PropType<number[]>, required: true },
    pageTarget: { type: Object as PropType<Element | null>, default: null },
  },
  setup(props, { expose }) {
    const { face, drop } = makeFace(props.ids);
    const panels = new Map<number, HTMLElement>();
    const panelRef = (id: number) => (el: unknown) => {
      if (el instanceof HTMLElement) panels.set(id, el);
    };
    watch(face.focusRequest, async (req) => {
      if (req === null) return;
      await nextTick();
      panels.get(req.id)?.focus();
    });
    usePreviewWindowCycle({ face, pageFocus: () => props.pageTarget });
    expose({ drop });
    return () =>
      h("div", [
        h("div", { class: "composer" }, [h("textarea")]),
        h(
          "div",
          { class: "preview-overlay is-windows is-modeless" },
          props.ids.map((id) =>
            h("section", { class: "preview-window", key: id }, [
              h(
                "div",
                {
                  class: "preview-panel",
                  role: "dialog",
                  "aria-modal": "false",
                  tabindex: "-1",
                  "aria-labelledby": `pw-title-${id}`,
                  ref: panelRef(id),
                },
                [h("h3", { id: `pw-title-${id}` }, `w${id}`)],
              ),
            ]),
          ),
        ),
      ]);
  },
});

function keyEvent(
  key: string,
  opts: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; code?: string; composing?: boolean } = {},
): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
    metaKey: opts.meta ?? false,
  });
  Object.defineProperty(ev, "code", { value: opts.code ?? key });
  if (opts.composing === true) Object.defineProperty(ev, "isComposing", { get: () => true });
  return ev;
}

/** Ctrl+` (forward) unless `shift` — returns whether the default was prevented. */
function press(shift = false): boolean {
  return window.dispatchEvent(keyEvent("`", { ctrl: true, shift, code: "Backquote", composing: false }));
}

async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

const mounted: Array<{ unmount: () => void }> = [];

function mountHarness(ids: number[], pageTarget: Element | null = null) {
  const w = mount(Harness, { props: { ids, pageTarget }, attachTo: document.body });
  mounted.push(w);
  return w;
}

/** Which window (if any) holds focus — mirrors `previewCycleWindowIdOf`'s DOM contract. */
function focusedWindow(): number | null {
  const el = document.activeElement;
  if (el === null) return null;
  const panel = el instanceof Element ? el.closest(".preview-window")?.querySelector(".preview-panel") : null;
  const m =
    panel === null || panel === undefined ? null : /^pw-title-(\d+)$/.exec(panel.getAttribute("aria-labelledby") ?? "");
  return m === null ? null : Number(m[1]);
}

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

describe("usePreviewWindowCycle — Ctrl+` MRU ring (§5.6)", () => {
  it("from the composer textarea: active window → older → oldest → back to the textarea (full wrap)", async () => {
    const w = mountHarness([1, 2, 3]);
    const textarea = w.element.querySelector(".composer textarea") as HTMLTextAreaElement;
    textarea.focus();
    expect(press()).toBe(false); // acting ⇒ preventDefault
    await settle();
    expect(focusedWindow()).toBe(3); // the ACTIVE window (order tail)
    expect(document.activeElement?.getAttribute("aria-labelledby")).toBe("pw-title-3");
    expect(press()).toBe(false);
    await settle();
    expect(focusedWindow()).toBe(2); // the frozen ring walks to the OLDER window
    expect(press()).toBe(false);
    await settle();
    expect(focusedWindow()).toBe(1); // …then the OLDEST…
    expect(press()).toBe(false);
    await settle();
    expect(focusedWindow()).toBeNull(); // …and wraps to the page (composer textarea fallback)
    expect(document.activeElement).toBe(textarea);
  });

  it("reverse (Ctrl+Shift+`) wraps to the OLDEST window from the page", async () => {
    mountHarness([1, 2, 3]);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    press(true);
    await settle();
    expect(focusedWindow()).toBe(1);
  });

  it("never ping-pongs: the frozen ring keeps walking past a raised window", async () => {
    mountHarness([1, 2, 3]);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    press(); // → 3 (raising 3: order [1,2,3] → unchanged, it was active)
    await settle();
    press(); // → 2 (order becomes [1,3,2] — a REBUILT ring would next bounce back to 3)
    await settle();
    press(); // frozen ring: 2 → 1. Rebuilt: 2 → 3 (the bug this pins).
    await settle();
    expect(focusedWindow()).toBe(1);
  });

  it("focus that moved off the last landing takes a FRESH snapshot from where it now sits", async () => {
    mountHarness([1, 2, 3]);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    press(); // → 3
    await settle();
    // the user clicks into window 1 (any focus move the cycle did not author)
    (document.querySelector('.preview-panel[aria-labelledby="pw-title-1"]') as HTMLElement).focus();
    press(); // fresh ring [page,3,2,1] at position 1 ⇒ forward lands on the page
    await settle();
    expect(focusedWindow()).toBeNull();
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
  });

  it("pageFocus() wins over the composer fallback when still connected", async () => {
    const target = document.createElement("button");
    document.body.appendChild(target);
    mountHarness([1], target);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    press(); // → the only window
    await settle();
    press(); // → page: the provided target, not the textarea
    await settle();
    expect(document.activeElement).toBe(target);
    target.remove();
  });

  it("inert when no windows exist", async () => {
    mountHarness([]);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    expect(press()).toBe(true); // no preventDefault — the guard rejected the key
    await settle();
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
  });

  it("inert while ANY [aria-modal=true] exists in the document (modals, phone stack)", async () => {
    mountHarness([1, 2]);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    expect(press()).toBe(true);
    await settle();
    expect(focusedWindow()).toBeNull();
    modal.remove();
    expect(press()).toBe(false); // the modal is gone ⇒ the cycle acts again
    await settle();
    expect(focusedWindow()).toBe(2);
  });

  it("inert during IME composition (isComposing)", async () => {
    mountHarness([1]);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    expect(window.dispatchEvent(keyEvent("`", { ctrl: true, code: "Backquote", composing: true }))).toBe(true);
    await settle();
    expect(focusedWindow()).toBeNull();
  });

  it("composer keys are untouched: the cycle ignores Enter and never prevents it", async () => {
    mountHarness([1, 2]);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    expect(window.dispatchEvent(keyEvent("Enter", { code: "Enter" }))).toBe(true);
    expect(window.dispatchEvent(keyEvent("`", { ctrl: false, code: "Backquote" }))).toBe(true); // no Ctrl ⇒ passthrough
    expect(window.dispatchEvent(keyEvent("Tab", { code: "Tab", shift: true }))).toBe(true);
    await settle();
    expect(focusedWindow()).toBeNull();
  });

  it("only Ctrl (never Alt/⌘ variants) and only Backquote trigger the cycle", async () => {
    mountHarness([1]);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    expect(window.dispatchEvent(keyEvent("`", { ctrl: true, alt: true, code: "Backquote" }))).toBe(true);
    expect(window.dispatchEvent(keyEvent("`", { ctrl: true, meta: true, code: "Backquote" }))).toBe(true);
    // physical key decides (§5.6): a layout where Backquote types something else still cycles,
    // and a key that TYPES a backtick without the Backquote code does not.
    expect(window.dispatchEvent(keyEvent("e", { ctrl: true, code: "Backquote" }))).toBe(false);
    await settle();
    expect(focusedWindow()).toBe(1);
    expect(window.dispatchEvent(keyEvent("`", { ctrl: true, code: "KeyE" }))).toBe(true);
  });

  it("a stale ring never lands on a closed window: it re-snapshots and steps once", async () => {
    const w = mountHarness([1, 2, 3]);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement).focus();
    press(); // → 3, ring frozen [page,3,2,1]
    await settle();
    expect(focusedWindow()).toBe(3);
    // window 2 closes while the ring is frozen: its next step would land on a GONE id.
    (w.vm as unknown as { drop: (id: number) => void }).drop(2);
    press(); // frozen step says "2" ⇒ rejected ⇒ fresh ring [page,3,1] from focus-at 3 ⇒ → 1
    await settle();
    expect(focusedWindow()).toBe(1);
  });
});
