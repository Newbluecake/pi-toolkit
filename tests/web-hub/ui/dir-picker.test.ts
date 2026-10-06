// @vitest-environment happy-dom
/**
 * `DirPicker.vue` + `SpawnConfirm.vue` (web-hub-spawn plan SP12 / arch §9.1, plan §3.2; 2026-10
 * modal-dialog redesign). The picker is driven by a REAL `createNewSession` (SP11)
 * orchestrator over a fake `start`, so these tests pin the component wiring AND the flow
 * phases: recent dirs, the 409 ⇒ SpawnConfirm view (resolvedCwd via textContent, LAN
 * plaintext warning), failures preserving the input, and the 48 KiB client-side precheck —
 * plus the Teleport'd dialog shell (scrim close, Escape, focus trap/return, scroll lock).
 *
 * The dialog Teleports to `<body>`, so ALL interaction goes through `document.body` queries +
 * native events (the PickerSheet-test pattern — VTU's teleport stub does NOT propagate slot
 * updates correctly for this component, verified 2026-10).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { ref } from "vue";
import DirPicker from "../../../src/web-hub/ui/src/components/spawn/DirPicker.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { createNewSession } from "../../../src/web-hub/ui/src/composables/useNewSession.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import type { SpawnOutcome } from "../../../src/web-hub/ui/src/transport/types.js";
import type { DirEntryWire, SpawnRequestBody } from "../../../src/web-hub/protocol/spawn.js";

function fakeClock() {
  let now = 1_700_000_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number): void => void timers.delete(id),
  };
}

interface Harness {
  readonly hub: HubHandle;
  readonly starts: SpawnRequestBody[];
}

/** HUB_CTX with a real §3.2 orchestrator over a scripted `start`; dirs() returns `recent`. */
function harness(opts: { start: (req: SpawnRequestBody) => Promise<SpawnOutcome>; recent?: DirEntryWire[] }): Harness {
  const starts: SpawnRequestBody[] = [];
  const clock = fakeClock();
  const newSession = createNewSession({
    start: (req) => {
      starts.push(req);
      return opts.start(req);
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    newId: () => `req-${starts.length}-aaaaaaaaaaaa`,
  });
  const hub: HubHandle = {
    state: ref({ agents: new Map(), spawns: null } as unknown as HubState),
    dispatch: () => {},
    spawn: {
      list: async () => ({ ok: false, error: "E_NOT_FOUND", status: 404 }),
      dirs: async () => ({ ok: true, recent: opts.recent ?? [] }),
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      stop: async () => ({ ok: true, state: "stopping" }),
      newSession,
    },
  };
  return { hub, starts };
}

// --- Teleport'd-DOM helpers (the dialog lives at document.body) ------------------------------

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  // every open dialog holds a ref-counted body scroll lock — unmount everything and reset
  for (const w of mounted.splice(0)) w.unmount();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
});

function q<T extends Element = HTMLElement>(sel: string): T {
  const el = document.body.querySelector<T>(sel);
  if (el === null) throw new Error(`not found in document.body: ${sel}`);
  return el;
}
function qa(sel: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(sel));
}
async function click(el: HTMLElement): Promise<void> {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
}
async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await flushPromises();
}
async function keydown(el: HTMLElement, init: KeyboardEventInit): Promise<void> {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  await flushPromises();
}

function mountPicker(h: Harness, props: { prefillCwd?: string; focusSubmit?: boolean; plaintext?: boolean } = {}) {
  const wrapper = mount(DirPicker, {
    props,
    attachTo: document.body,
    global: { provide: { [HUB_CTX as symbol]: h.hub } },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("DirPicker.vue (SP12)", () => {
  it("focusSubmit (NewSessionMenu main-button open) focuses 「Start」 on mount; the default open focuses the cwd input", async () => {
    const h = harness({ start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }) });
    mountPicker(h, { prefillCwd: "/home/u/proj", focusSubmit: true });
    await flushPromises();
    expect(document.activeElement).toBe(q(".spawn-picker-actions .btn-primary"));

    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    const panels = qa(".spawn-picker");
    expect(panels).toHaveLength(2);
    expect(document.activeElement).toBe(panels[1]!.querySelector("#spawn-cwd"));
  });

  it("prefills the cwd input and lists recent directories as cards (label + full path); clicking one fills the input and highlights it", async () => {
    const h = harness({
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      recent: [
        { cwd: "/home/u/alpha", label: "alpha", at: 2000 },
        { cwd: "/home/u/beta", label: "beta", at: 1000 },
      ],
    });
    mountPicker(h, { prefillCwd: "/home/u/selected" });
    await flushPromises();
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/selected");
    const recent = qa(".spawn-recent-btn");
    expect(recent).toHaveLength(2);
    expect(recent[0]!.textContent).toContain("alpha");
    // card layout: label + full path (ellipsized in CSS, `title` carries the full path)
    expect(recent[0]!.querySelector(".spawn-recent-label")!.textContent).toBe("alpha");
    expect(recent[0]!.querySelector(".spawn-recent-path")!.textContent).toBe("/home/u/alpha");
    expect(recent[0]!.getAttribute("title")).toBe("/home/u/alpha");
    expect(qa(".spawn-recent-btn.is-current")).toHaveLength(0); // typed cwd matches no entry

    await click(recent[1]!);
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/beta");
    // the entry matching the typed cwd is highlighted
    expect(qa(".spawn-recent-btn")[1]!.classList.contains("is-current")).toBe(true);
    expect(qa(".spawn-recent-btn")[0]!.classList.contains("is-current")).toBe(false);
  });

  it("submits {cwd, firstPrompt} through the orchestrator exactly once per click", async () => {
    let call = 0;
    const h = harness({
      start: async () => {
        call += 1;
        return { ok: false, error: "E_NETWORK", retryable: true }; // one same-id resend, then failed
      },
    });
    mountPicker(h, { prefillCwd: "~/work" });
    await flushPromises();
    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/proj");
    await setValue(q<HTMLTextAreaElement>("#spawn-first-prompt"), "hello session");
    await click(q(".spawn-picker-actions .btn-primary"));
    expect(call).toBe(2); // §3.2: network error ⇒ the SAME id resent once
    expect(h.starts[0]).toEqual({
      id: "req-0-aaaaaaaaaaaa",
      cwd: "/home/u/proj",
      firstPrompt: { text: "hello session" },
    });
    expect(h.starts[1]).toEqual(h.starts[0]);
  });

  it("409 E_CONFIRM_REQUIRED ⇒ the SpawnConfirm view shows resolvedCwd and the LAN warning; confirm resends with confirm+expectCwd", async () => {
    let confirmed = false;
    const h = harness({
      start: async (req) => {
        if (req.confirm === true) {
          confirmed = true;
          return { ok: true, data: { spawnId: "sp9", state: "starting", cwd: "/real/path" } };
        }
        return {
          ok: false,
          error: "E_CONFIRM_REQUIRED",
          resolvedCwd: "/real/path",
          reason: "unknown-dir",
          retryable: false,
        };
      },
    });
    mountPicker(h, { prefillCwd: "/home/u/proj", plaintext: true });
    await flushPromises();
    await click(q(".spawn-picker-actions .btn-primary"));

    expect(q(".spawn-confirm-cwd").textContent).toBe("/real/path");
    expect(q(".spawn-confirm").textContent).toContain("not in the known list");
    expect(q(".spawn-plain-warning").textContent).toContain("Plain HTTP");

    await click(q(".spawn-confirm .btn-primary"));
    expect(confirmed).toBe(true);
    expect(h.starts[1]).toMatchObject({ id: "req-0-aaaaaaaaaaaa", confirm: true, expectCwd: "/real/path" });
    expect(q(".spawn-picker-status").textContent).toContain("Waiting for the session");
  });

  it("no LAN plaintext warning when plaintext is false", async () => {
    const h = harness({
      start: async () => ({
        ok: false,
        error: "E_CONFIRM_REQUIRED",
        resolvedCwd: "/real/path",
        reason: "unknown-dir",
        retryable: false,
      }),
    });
    mountPicker(h, { plaintext: false });
    await flushPromises();
    await click(q(".spawn-picker-actions .btn-primary"));
    expect(document.body.querySelector(".spawn-confirm")).not.toBeNull();
    expect(document.body.querySelector(".spawn-plain-warning")).toBeNull();
  });

  it("E_LIMIT failure keeps the typed input and shows the taxonomy line; retry resubmits", async () => {
    let calls = 0;
    const h = harness({
      start: async () => {
        calls += 1;
        return { ok: false, error: "E_LIMIT", message: "4/4 processes", retryable: false };
      },
    });
    mountPicker(h);
    await flushPromises();
    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/keepme");
    await setValue(q<HTMLTextAreaElement>("#spawn-first-prompt"), "draft body");
    await click(q(".spawn-picker-actions .btn-primary"));

    expect(q(".spawn-picker-error").textContent).toContain("Process limit reached");
    expect(q(".spawn-picker-error").textContent).toContain("4/4 processes");
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/keepme");
    expect(q<HTMLTextAreaElement>("#spawn-first-prompt").value).toBe("draft body");

    await click(q(".spawn-picker-actions .btn:not(.btn-primary):not(.btn-ghost)"));
    expect(calls).toBe(2); // retry ⇒ a NEW id (§3.2)
    expect(h.starts[1]!.id).not.toBe(h.starts[0]!.id);
    expect(h.starts[1]!.cwd).toBe("/home/u/keepme");
  });

  it("first prompt over 48 KiB ⇒ submit disabled with the byte precheck line (never hits the wire)", async () => {
    const h = harness({ start: async () => ({ ok: false, error: "E_NETWORK", retryable: true }) });
    mountPicker(h);
    await flushPromises();
    await setValue(q<HTMLTextAreaElement>("#spawn-first-prompt"), "x".repeat(48 * 1024 + 1));
    const submit = q<HTMLButtonElement>(".spawn-picker-actions .btn-primary");
    expect(submit.disabled).toBe(true);
    expect(q(".spawn-picker-error").textContent).toContain("48 KiB");
    await click(submit);
    expect(h.starts).toHaveLength(0);
  });
});

describe("DirPicker.vue — modal dialog shell (2026-10 Teleport redesign)", () => {
  it("teleports to <body>: .spawn-scrim overlay with a role=dialog aria-modal panel; scroll locked while open", async () => {
    const h = harness({ start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }) });
    const wrapper = mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    const scrim = document.body.querySelector(".spawn-scrim");
    expect(scrim).not.toBeNull();
    const panel = document.body.querySelector(".spawn-picker");
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("role")).toBe("dialog");
    expect(panel!.getAttribute("aria-modal")).toBe("true");
    expect(panel!.getAttribute("aria-label")).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
    wrapper.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("scrim click closes mid-awaiting WITHOUT cancelling the flow (SpawnRow keeps progress); focus returns to the opener", async () => {
    const h = harness({
      start: async () => ({ ok: true, data: { spawnId: "sp1", state: "starting", cwd: "/home/u/proj" } }),
    });
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const wrapper = mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    expect(document.activeElement).not.toBe(opener); // focus entered the dialog

    await click(q(".spawn-picker-actions .btn-primary"));
    expect(h.hub.spawn!.newSession.flow.value.phase).toBe("awaiting");

    await click(q(".spawn-scrim")); // @click.self on the scrim itself
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(h.hub.spawn!.newSession.flow.value.phase).toBe("awaiting"); // NOT cancelled

    wrapper.unmount(); // the parent reacts to `close` with v-if=false
    expect(document.activeElement).toBe(opener);
  });

  it("Escape during `confirming` cancels the pending confirm AND emits close", async () => {
    const h = harness({
      start: async () => ({
        ok: false,
        error: "E_CONFIRM_REQUIRED",
        resolvedCwd: "/real/path",
        reason: "unknown-dir",
        retryable: false,
      }),
    });
    const wrapper = mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-picker-actions .btn-primary"));
    expect(document.body.querySelector(".spawn-confirm")).not.toBeNull();
    expect(h.hub.spawn!.newSession.flow.value.phase).toBe("confirming");

    await keydown(q(".spawn-scrim"), { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(h.hub.spawn!.newSession.flow.value.phase).not.toBe("confirming"); // cancel() ran first
  });

  it("Tab cycles focus inside the dialog (last → first, first → last on Shift+Tab)", async () => {
    const h = harness({ start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }) });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    const scrim = q(".spawn-scrim");
    const submit = q<HTMLElement>(".spawn-picker-actions .btn-primary");
    const cwdInput = q<HTMLElement>("#spawn-cwd");

    submit.focus();
    await keydown(scrim, { key: "Tab" });
    expect(document.activeElement).toBe(cwdInput); // wrapped to the first focusable

    cwdInput.focus();
    await keydown(scrim, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(submit); // wrapped back to the last
  });

  it("spawn.css pins the dialog shell: fixed scrim z-40, min(760px) panel at 85dvh, ≤640px bottom sheet, recent grid, 140px prompt", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/web-hub/ui/src/styles/spawn.css"), "utf8");
    const scrim = css.match(/\.spawn-scrim \{([\s\S]*?)\n\}/);
    expect(scrim).not.toBeNull();
    expect(scrim![1]).toContain("position: fixed");
    expect(scrim![1]).toContain("z-index: 40");
    expect(scrim![1]).toContain("env(safe-area-inset-bottom)");
    const panel = css.match(/\.spawn-picker \{([\s\S]*?)\n\}/);
    expect(panel).not.toBeNull();
    expect(panel![1]).toContain("width: min(760px, calc(100vw - 2 * var(--sp-4)))");
    expect(panel![1]).toContain("max-height: 85dvh");
    expect(panel![1]).toContain("overflow-y: auto");
    const recent = css.match(/\.spawn-recent \{([\s\S]*?)\n\}/);
    expect(recent).not.toBeNull();
    expect(recent![1]).toContain("grid-template-columns");
    expect(css).toContain("min-height: 140px");
    const narrow = css.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/);
    expect(narrow).not.toBeNull();
    expect(narrow![1]).toContain(".spawn-scrim");
    expect(narrow![1]).toContain(".spawn-picker");
    // the coarse-pointer ≥44px rule still covers the dialog's targets
    const coarse = css.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/);
    expect(coarse).not.toBeNull();
    expect(coarse![1]).toContain(".spawn-recent-btn");
    expect(coarse![1]).toContain(".spawn-picker-actions .btn");
    expect(css).not.toContain("v-html");
  });
});
