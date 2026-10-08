// @vitest-environment happy-dom
/**
 * worktree-diff plan v3.1 §5 D5 — `components/diff/diffModal.ts` (§4.3, D12): the diff
 * dialog's LOCAL shell, semantically aligned with `preview-host.test.ts`'s shell cases but an
 * independent implementation. Covers: focus enters the panel on open, focus RETURNS to the
 * trigger on close, Tab/Shift+Tab cycle inside the panel, Esc owns the event
 * (preventDefault + stopPropagation) and closes, the body scroll lock is acquired on open and
 * released on BOTH the close and the unmount paths, and `dispose()` never throws.
 */
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiffModal } from "../../../src/web-hub/ui/src/components/diff/diffModal.js";
import { resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

afterEach(() => {
  resetBodyScrollLock();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
});

/** Mount the shell the way `WorktreeDiffDialog` wires it: `isOpen`/`panelEl` refs plus the
 * `onKeydown` handler bound to the overlay root's keydown (focus sits inside the panel, the
 * event bubbles up to the root). */
function wire(opts: { isOpen?: boolean } = {}) {
  const isOpen = ref(opts.isOpen ?? false);
  const panelEl = ref<HTMLElement | null>(null);
  const onClose = vi.fn();
  const modal = useDiffModal({ isOpen, panelEl, onClose });
  const bind = (panel: HTMLElement): HTMLElement => {
    panel.addEventListener("keydown", modal.onKeydown as EventListener);
    panelEl.value = panel;
    return panel;
  };
  return { isOpen, panelEl, onClose, modal, bind };
}

function makePanel(withButtons = true): HTMLElement {
  const panel = document.createElement("div");
  panel.setAttribute("tabindex", "-1");
  if (withButtons) {
    for (const label of ["first", "second", "last"]) {
      const b = document.createElement("button");
      b.setAttribute("type", "button");
      b.textContent = label;
      panel.appendChild(b);
    }
  }
  document.body.appendChild(panel);
  return panel;
}
function keydown(target: EventTarget, key: string, opts: { shiftKey?: boolean } = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: opts.shiftKey === true });
  target.dispatchEvent(ev);
  return ev;
}

describe("diffModal — shell semantics (§4.3, aligned with preview-host)", () => {
  it("open: locks body scroll and focuses the panel; close: releases the lock and returns focus", async () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("type", "button");
    document.body.appendChild(trigger);
    trigger.focus();

    const { isOpen, panelEl, onClose, modal, bind } = wire();
    bind(makePanel());
    isOpen.value = true;
    await tick();
    expect(document.activeElement).toBe(panelEl.value);
    expect(document.body.style.overflow).toBe("hidden");

    isOpen.value = false;
    await tick();
    expect(document.body.style.overflow).toBe(""); // the saved value restored
    expect(document.activeElement).toBe(trigger); // focus returned to the opener
    expect(onClose).not.toHaveBeenCalled(); // the flip itself never calls onClose
    modal.dispose();
  });

  it("dispose while open releases the scroll lock (the unmount path)", async () => {
    const { isOpen, modal, bind } = wire();
    bind(makePanel());
    isOpen.value = true;
    await tick();
    expect(document.body.style.overflow).toBe("hidden");
    modal.dispose(); // e.g. the host component unmounts mid-dialog
    expect(document.body.style.overflow).toBe("");
  });

  it("dispose is idempotent and safe when never opened", () => {
    const modal = useDiffModal({ isOpen: ref(false), panelEl: ref(null), onClose: () => {} });
    expect(() => {
      modal.dispose();
      modal.dispose();
    }).not.toThrow();
  });

  it("Tab cycles inside the panel (last → first, shift first → last); outside focus is pulled in", async () => {
    const { isOpen, panelEl, modal, bind } = wire({ isOpen: true });
    const panel = bind(makePanel());
    await tick(); // immediate: true → the panel got focused

    const buttons = Array.from(panel.querySelectorAll("button"));
    const [first, , last] = buttons as [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement];

    (last as HTMLButtonElement).focus();
    keydown(last, "Tab");
    expect(document.activeElement).toBe(first); // wrapped forward

    keydown(first, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last); // wrapped backward

    document.body.focus(); // focus escaped the panel (e.g. after a DOM swap)
    keydown(panel, "Tab"); // the handler sits on the overlay ROOT — the event it receives
    expect(document.activeElement).toBe(first); // pulled back inside
    expect(panelEl.value).toBe(panel);
    modal.dispose();
  });

  it("Tab with no focusable items stays put (preventDefault only)", () => {
    const { modal, bind } = wire({ isOpen: true });
    const panel = bind(makePanel(false));
    const ev = keydown(panel, "Tab");
    expect(ev.defaultPrevented).toBe(true);
    modal.dispose();
  });

  it("Esc: preventDefault + stopPropagation + onClose", () => {
    const { onClose, modal, bind } = wire({ isOpen: true });
    const panel = bind(makePanel());
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);

    const ev = keydown(panel, "Escape");
    expect(ev.defaultPrevented).toBe(true);
    // stopPropagation: a global Esc handler underneath must not also fire
    expect(outer).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    document.body.removeEventListener("keydown", outer);
    modal.dispose();
  });

  it("other keys pass through untouched", () => {
    const { onClose, modal, bind } = wire({ isOpen: true });
    const panel = bind(makePanel());
    const ev = keydown(panel, "a");
    expect(ev.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    modal.dispose();
  });
});
