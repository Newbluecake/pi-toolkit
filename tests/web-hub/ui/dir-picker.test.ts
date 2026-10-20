// @vitest-environment happy-dom
/**
 * `DirPicker.vue` + `SpawnConfirm.vue` (web-hub-spawn plan SP12 / arch §9.1, plan §3.2; 2026-10
 * modal-dialog redesign; 2026-10-12 拍板: first-prompt textarea and the 「本次模型」 field are
 * both GONE — the submit is `{cwd}` only). The picker is driven by a REAL `createNewSession`
 * (SP11) orchestrator over a fake `start`, so these tests pin the component wiring AND the
 * flow phases: recent dirs, the 409 ⇒ SpawnConfirm view (resolvedCwd via textContent, LAN
 * plaintext warning), failures preserving the input, the in-dialog directory browser +
 * 「新建文件夹」 — plus the Teleport'd dialog shell (scrim close, Escape, focus trap/return,
 * scroll lock).
 *
 * The dialog Teleports to `<body>`, so ALL interaction goes through `document.body` queries +
 * native events (the PickerSheet-test pattern — VTU's teleport stub does NOT propagate slot
 * updates correctly for this component, verified 2026-10).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { ref, shallowRef, type ShallowRef } from "vue";
import DirPicker from "../../../src/web-hub/ui/src/components/spawn/DirPicker.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { createNewSession } from "../../../src/web-hub/ui/src/composables/useNewSession.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import type { SpawnOutcome } from "../../../src/web-hub/ui/src/transport/types.js";
import type { DirEntryWire, SpawnPrefsWire, SpawnRequestBody } from "../../../src/web-hub/protocol/spawn.js";

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
  /** F1/F2: the spawn handle's prefs mirror — tests mutate it to simulate an arriving GET. */
  readonly prefs: ShallowRef<SpawnPrefsWire | null>;
  readonly refreshCalls: { n: number };
  /** spawn-dirbrowse: the preview transport's fetch call log (opts.fetch was given). */
  readonly previewCalls: Array<{ agentKey: string; sessionId: string; path: string; dir?: true }>;
  /** spawn-dirmkdir: the spawn handle's mkdir call log. */
  readonly mkdirCalls: Array<{ path: string; name: string }>;
}

/** HUB_CTX with a real §3.2 orchestrator over a scripted `start`; dirs() returns `recent`.
 * `caps` only feeds the ORCHESTRATOR's second cap guard (`modelCap` dep) — the picker itself
 * has no model gate anymore (2026-10-12 拍板: the 「本次模型」 field is gone, submits never
 * carry `model`).
 * spawn-dirbrowse/-dirmkdir: `preview` (a scripted fetch) lands on the hub handle only when
 * `opts.preview` is given, `withSession` seeds ONE online agent with a live session (the
 * preview endpoint's agentKey/sessionId gate), and `opts.mkdir` scripts the mkdir answer. */
function harness(opts: {
  start: (req: SpawnRequestBody) => Promise<SpawnOutcome>;
  recent?: DirEntryWire[];
  caps?: string[];
  prefs?: SpawnPrefsWire | null;
  preview?: (req: { agentKey: string; sessionId: string; path: string; dir?: true }) => Promise<unknown>;
  mkdir?: (path: string, name: string) => Promise<unknown>;
  withSession?: boolean;
}): Harness {
  const starts: SpawnRequestBody[] = [];
  const previewCalls: Harness["previewCalls"] = [];
  const mkdirCalls: Harness["mkdirCalls"] = [];
  const clock = fakeClock();
  const caps = opts.caps ?? [];
  const prefs = shallowRef<SpawnPrefsWire | null>(opts.prefs ?? null);
  const refreshCalls = { n: 0 };
  const newSession = createNewSession({
    start: (req) => {
      starts.push(req);
      return opts.start(req);
    },
    modelCap: () => caps.includes("spawn.model.v1"),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    newId: () => `req-${starts.length}-aaaaaaaaaaaa`,
  });
  const agents = new Map<string, unknown>();
  if (opts.withSession === true) {
    agents.set("a1", { down: false, session: { sessionId: "sess-1", cwd: "/home/u/proj" } });
  }
  const hub: HubHandle = {
    state: ref({ agents, spawns: null, hub: { caps } } as unknown as HubState),
    dispatch: () => {},
    ...(opts.preview === undefined
      ? {}
      : {
          preview: {
            fetch: (req: { agentKey: string; sessionId: string; path: string; dir?: true }) => {
              previewCalls.push(req);
              return opts.preview!(req);
            },
          },
        }),
    spawn: {
      list: async () => ({ ok: false, error: "E_NOT_FOUND", status: 404 }),
      dirs: async () => ({ ok: true, recent: opts.recent ?? [] }),
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      stop: async () => ({ ok: true, state: "stopping" }),
      newSession,
      prefs,
      refreshPrefs: async () => {
        refreshCalls.n += 1;
        return { ok: false, error: "E_NOT_FOUND", status: 404 };
      },
      setDefaultModel: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      mkdir: async (path: string, name: string) => {
        mkdirCalls.push({ path, name });
        return (opts.mkdir?.(path, name) ?? { ok: false, error: "E_UNSUPPORTED", status: 0 }) as never;
      },
    } as unknown as HubHandle["spawn"],
  } as HubHandle;
  return { hub, starts, prefs, refreshCalls, previewCalls, mkdirCalls };
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

  it("submits {cwd} through the orchestrator exactly once per click (no first-prompt field — removed per user 拍板)", async () => {
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
    await click(q(".spawn-picker-actions .btn-primary"));
    expect(call).toBe(2); // §3.2: network error ⇒ the SAME id resent once
    expect(h.starts[0]).toEqual({ id: "req-0-aaaaaaaaaaaa", cwd: "/home/u/proj" });
    expect(h.starts[0]).not.toHaveProperty("firstPrompt");
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
    await click(q(".spawn-picker-actions .btn-primary"));

    expect(q(".spawn-picker-error").textContent).toContain("Process limit reached");
    expect(q(".spawn-picker-error").textContent).toContain("4/4 processes");
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/keepme");

    await click(q(".spawn-picker-actions .btn:not(.btn-primary):not(.btn-ghost)"));
    expect(calls).toBe(2); // retry ⇒ a NEW id (§3.2)
    expect(h.starts[1]!.id).not.toBe(h.starts[0]!.id);
    expect(h.starts[1]!.cwd).toBe("/home/u/keepme");
  });

  it("E_DIR `detail` (created-dirs r2 §4) selects the cause-specific copy; absent/unknown ⇒ the generic errDir", async () => {
    const cases: ReadonlyArray<{ detail: string | undefined; expect: string }> = [
      { detail: "plaintext-lan", expect: "plaintext-HTTP LAN connection can only start in known directories" },
      { detail: "lan-known", expect: "LAN access only allows known directories" },
      { detail: "outside-roots", expect: "neither inside an allowed root nor a known directory" },
      // loopback / pre-feature hub: no detail ⇒ the generic line
      { detail: undefined, expect: "The directory was rejected — pick a recent or allowed directory" },
      // forward-compat: an unknown future value also falls back to the generic line
      { detail: "future-cause", expect: "The directory was rejected — pick a recent or allowed directory" },
    ];
    for (const c of cases) {
      const outcome: SpawnOutcome = {
        ok: false,
        error: "E_DIR",
        reason: "not-allowed",
        retryable: false,
        // (the `as` covers the deliberate forward-compat lie in the last case)
        ...(c.detail === undefined ? {} : { detail: c.detail as "plaintext-lan" }),
      };
      const h = harness({ start: async () => outcome });
      mountPicker(h);
      await flushPromises();
      const idx = qa(".spawn-picker").length - 1;
      await click(qa(".spawn-picker-actions .btn-primary")[idx]!);
      expect(qa(".spawn-picker-error")[idx]!.textContent).toContain(c.expect);
    }
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

  it("202 accepted ⇒ the dialog closes ITSELF immediately (2026-10-13 拍板 ②: waiting lives on the sidebar SpawnRow); the flow keeps running and focus returns", async () => {
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
    // no scrim click needed: the 202's `awaiting` transition emits `close` on its own
    expect(wrapper.emitted("close")).toHaveLength(1);

    wrapper.unmount(); // the parent reacts to `close` with v-if=false
    expect(h.hub.spawn!.newSession.flow.value.phase).toBe("awaiting"); // closing never cancels the flow
    expect(document.activeElement).toBe(opener); // focus returned to the opener
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

  it("spawn.css pins the dialog shell: fixed scrim z-50 (modal-ish tier), top-anchored panel (anti-jitter 2026-10-13), ≤640px bottom sheet, recent grid, browse panel", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/web-hub/ui/src/styles/spawn.css"), "utf8");
    const scrim = css.match(/\.spawn-scrim \{([\s\S]*?)\n\}/);
    expect(scrim).not.toBeNull();
    expect(scrim![1]).toContain("position: fixed");
    expect(scrim![1]).toContain("z-index: 50");
    expect(scrim![1]).toContain("env(safe-area-inset-bottom)");
    // 顶锚定（用户报告「输路径时顶部抖动」）：居中会在内容高度变化时推顶边
    expect(scrim![1]).toContain("align-items: flex-start");
    expect(scrim![1]).toContain("padding-top: max(clamp(var(--sp-6), 8vh, 96px), env(safe-area-inset-top))");
    const panel = css.match(/\.spawn-picker \{([\s\S]*?)\n\}/);
    expect(panel).not.toBeNull();
    expect(panel![1]).toContain("width: min(760px, calc(100vw - 2 * var(--sp-4)))");
    // 高度上限随顶偏移收缩（不再是固定 85dvh；移动端媒体查询里恢复 85dvh）
    expect(panel![1]).toContain("max-height: calc(100dvh - clamp(var(--sp-6), 8vh, 96px)");
    expect(panel![1]).toContain("overflow-y: auto");
    const recent = css.match(/\.spawn-recent \{([\s\S]*?)\n\}/);
    expect(recent).not.toBeNull();
    expect(recent![1]).toContain("grid-template-columns");
    // the first-prompt textarea is gone (user 拍板); the browse panel styles exist instead
    expect(css).not.toContain(".spawn-prompt-input");
    expect(css).toContain(".spawn-browse-list");
    expect(css).toContain(".spawn-browse-row");
    expect(css).toContain(".spawn-mkdir-form");
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

describe("DirPicker.vue — document-level keydown (a11y fix)", () => {
  it("Escape dispatched on document.body after a phase switch still closes (focus fell out of the dialog)", async () => {
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
    await click(q(".spawn-picker-actions .btn-primary")); // phase switch ⇒ SpawnConfirm swaps in
    expect(document.body.querySelector(".spawn-confirm")).not.toBeNull();
    // the focused submit button is gone — focus is now nowhere inside the dialog
    await keydown(document.body, { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(h.hub.spawn!.newSession.flow.value.phase).not.toBe("confirming"); // cancel() ran first
  });

  it("Escape on document.body does NOT close the picker while a sibling overlay is on top (topmost-only)", async () => {
    const h = harness({ start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }) });
    const wrapper = mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    // a later-mounted overlay (e.g. the preview) — appended after the picker's scrim
    const overlay = document.createElement("div");
    overlay.className = "preview-overlay";
    document.body.appendChild(overlay);
    await keydown(document.body, { key: "Escape" });
    expect(wrapper.emitted("close") ?? []).toHaveLength(0);
    overlay.remove();
    await keydown(document.body, { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("Tab on document.body (focus fell out) wraps focus back into the dialog", async () => {
    const h = harness({ start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }) });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    (document.activeElement as HTMLElement | null)?.blur?.();
    await keydown(document.body, { key: "Tab" });
    expect(document.activeElement).toBe(q("#spawn-cwd")); // wrapped to the first focusable
  });
});

describe("DirPicker.vue — 目录浏览器 + 新建文件夹 (spawn-dirbrowse/-dirmkdir)", () => {
  const DIR_CAPS = ["spawn.v1", "preview.dir.v1"];

  /** A minimal PreviewDirListing (the hub sorts dirs-first; the fake keeps the given order). */
  function listing(
    entries: Array<{ name: string; type: "dir" | "file" | "symlink" | "other"; lossy?: true }>,
    over: Record<string, unknown> = {},
  ) {
    return {
      entries,
      total: entries.length,
      scanned: entries.length,
      complete: true,
      truncated: false,
      limits: { scan: false, entries: false, bytes: false },
      vanished: 0,
      dropped: 0,
      ...over,
    };
  }

  function browseHarness(
    preview: (req: { agentKey: string; sessionId: string; path: string; dir?: true }) => Promise<unknown>,
    opts: {
      caps?: string[];
      mkdir?: (path: string, name: string) => Promise<unknown>;
      recent?: DirEntryWire[];
    } = {},
  ) {
    return harness({
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      caps: opts.caps ?? DIR_CAPS,
      withSession: true,
      preview,
      ...(opts.recent === undefined ? {} : { recent: opts.recent }),
      ...(opts.mkdir === undefined ? {} : { mkdir: opts.mkdir }),
    });
  }

  /** created-dirs r2 §4 (#9): a manually-driven mkdir — every call parks until `resolve`. */
  function deferredMkdir() {
    const waiting: Array<{ path: string; name: string; settle: (out: unknown) => void }> = [];
    return {
      mkdir: (path: string, name: string) =>
        new Promise<unknown>((settle) => {
          waiting.push({ path, name, settle });
        }),
      pending: () => waiting.length,
      resolve(out: unknown): void {
        const w = waiting.shift();
        if (w === undefined) throw new Error("no parked mkdir");
        w.settle(out);
      },
    };
  }

  it("no preview.dir.v1 cap ⇒ the 「浏览」 toggle never renders", async () => {
    const h = browseHarness(async () => ({ ok: false, error: "E_NOT_FOUND", status: 404 }), {
      caps: ["spawn.v1"],
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    expect(document.body.querySelector(".spawn-browse-toggle")).toBeNull();
    expect(document.body.querySelector(".spawn-browse")).toBeNull();
  });

  it("open → dirs-only listing (files/symlinks filtered) → drill down → 上一级 → 选择此目录 writes cwd and closes", async () => {
    const h = browseHarness(async (req) => {
      if (req.path === "/home/u/proj") {
        return {
          ok: true,
          kind: "dir",
          listing: listing([
            { name: "sub", type: "dir" },
            { name: "readme.md", type: "file" },
            { name: "link", type: "symlink" },
          ]),
        };
      }
      if (req.path === "/home/u/proj/sub") {
        return { ok: true, kind: "dir", listing: listing([{ name: "deep", type: "dir" }]) };
      }
      return { ok: true, kind: "dir", listing: listing([]) };
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();

    await click(q(".spawn-browse-toggle"));
    // the open load starts from the cwd input's value, with a live session pair + dir opt-in
    expect(h.previewCalls[0]).toEqual({ agentKey: "a1", sessionId: "sess-1", path: "/home/u/proj", dir: true });
    const rows = qa(".spawn-browse-row");
    expect(rows).toHaveLength(1); // dirs only — file/symlink filtered out
    expect(rows[0]!.textContent).toContain("sub");
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/proj");

    await click(rows[0]!); // drill into sub
    expect(h.previewCalls[1]!.path).toBe("/home/u/proj/sub");
    expect(qa(".spawn-browse-row")).toHaveLength(1);
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/proj/sub");

    const upBtn = qa(".spawn-browse-bar .btn")[0]!;
    await click(upBtn); // 上一级 → back to the parent
    expect(h.previewCalls[2]!.path).toBe("/home/u/proj");
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/proj");

    await click(q(".spawn-browse-choose")); // 选择此目录
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/proj");
    expect(document.body.querySelector(".spawn-browse")).toBeNull(); // panel collapsed
  });

  it("「上一级」 greys out at the one-segment floor (/home has no listable parent)", async () => {
    const h = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([]) }));
    mountPicker(h, { prefillCwd: "/home" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    const upBtn = q<HTMLButtonElement>(".spawn-browse-bar .btn");
    expect(upBtn.disabled).toBe(true);
  });

  it("a lossy dir entry renders inert (never a clickable button, protocol A3)", async () => {
    const h = browseHarness(async () => ({
      ok: true,
      kind: "dir",
      listing: listing([
        { name: "good", type: "dir" },
        { name: "badname", type: "dir", lossy: true },
      ]),
    }));
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    expect(qa("button.spawn-browse-row")).toHaveLength(1);
    expect(qa(".spawn-browse-row.is-inert")).toHaveLength(1);
  });

  it("empty directory / truncated listing get their notice lines", async () => {
    const h = browseHarness(async () => ({
      ok: true,
      kind: "dir",
      // 截断形态: entries < total (truncated ≡ entries.length < total || !complete)
      listing: listing([{ name: "only", type: "dir" }], {
        total: 500,
        truncated: true,
        limits: { scan: false, entries: true, bytes: false },
      }),
    }));
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    expect(q(".spawn-browse").textContent).toContain("Showing the first 1 entries only");
    expect(q(".spawn-browse").textContent).not.toContain("No subdirectories");

    // 空目录形态（不带 truncated）
    const h2 = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([]) }));
    mountPicker(h2, { prefillCwd: "/home/u/empty" });
    await flushPromises();
    await click(qa(".spawn-browse-toggle")[1]!);
    expect(qa(".spawn-browse")[1]!.textContent).toContain("No subdirectories here.");
  });

  it("fetch failure shows the classified error line (404 → not found; 403 → denied)", async () => {
    const h = browseHarness(async () => ({ ok: false, error: "E_NOT_FOUND", status: 404 }));
    mountPicker(h, { prefillCwd: "/home/u/gone" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    expect(q(".spawn-browse .spawn-picker-error").textContent).toContain("Directory not found");

    const h2 = browseHarness(async () => ({ ok: false, error: "E_PREVIEW_DENIED", status: 403, reason: "denylist" }));
    mountPicker(h2, { prefillCwd: "/root" });
    await flushPromises();
    await click(qa(".spawn-browse-toggle")[1]!);
    expect(qa(".spawn-browse .spawn-picker-error")[1]!.textContent).toContain("not readable");
  });

  it("no live session anywhere ⇒ the panel degrades to the unsupported line without fetching", async () => {
    const h = harness({
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      caps: DIR_CAPS,
      // withSession deliberately false — zero online agents
      preview: async () => ({ ok: true, kind: "dir", listing: listing([]) }),
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    expect(h.previewCalls).toHaveLength(0);
    expect(q(".spawn-browse .spawn-picker-error").textContent).toContain("does not support directory browsing");
  });

  it("「新建文件夹」 success ⇒ SELECTS the folder: cwd input filled, panel closed, persistent ack (created-dirs r2 §4)", async () => {
    const h = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([]) }), {
      mkdir: async () => ({ ok: true, path: "/home/u/proj/fresh", known: true }),
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    expect(h.previewCalls).toHaveLength(1);

    await click(q(".spawn-mkdir-open"));
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "fresh");
    await click(q(".spawn-mkdir-form .btn-primary"));
    expect(h.mkdirCalls).toEqual([{ path: "/home/u/proj", name: "fresh" }]);
    // select: the input is filled, the panel closed, NO listing refresh (no drill-in anymore)
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/proj/fresh");
    expect(document.body.querySelector(".spawn-browse")).toBeNull();
    expect(h.previewCalls).toHaveLength(1);
    const ack = q(".spawn-mkdir-ack");
    expect(ack.getAttribute("role")).toBe("status");
    expect(ack.textContent).toContain("Created and chosen as the start directory: /home/u/proj/fresh");
    // the ack clears as soon as the cwd diverges from the created path
    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/elsewhere");
    expect(document.body.querySelector(".spawn-mkdir-ack")).toBeNull();
  });

  it("mkdir success WITHOUT `known` on plaintext LAN ⇒ still selected, but the ack warns spawning may be refused", async () => {
    const h = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([]) }), {
      mkdir: async () => ({ ok: true, path: "/home/u/proj/fresh" }), // no `known` — old hub or outside roots
    });
    mountPicker(h, { prefillCwd: "/home/u/proj", plaintext: true });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    await click(q(".spawn-mkdir-open"));
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "fresh");
    await click(q(".spawn-mkdir-form .btn-primary"));
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/proj/fresh");
    expect(document.body.querySelector(".spawn-browse")).toBeNull();
    expect(q(".spawn-mkdir-ack").textContent).toContain("may be refused over this plaintext LAN connection");
  });

  it("mkdir success WITHOUT `known` but NOT plaintext LAN ⇒ the plain selected ack (no warning)", async () => {
    const h = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([]) }), {
      mkdir: async () => ({ ok: true, path: "/home/u/proj/fresh" }),
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" }); // plaintext prop absent
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    await click(q(".spawn-mkdir-open"));
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "fresh");
    await click(q(".spawn-mkdir-form .btn-primary"));
    expect(q(".spawn-mkdir-ack").textContent).toContain("Created and chosen as the start directory");
    expect(q(".spawn-mkdir-ack").textContent).not.toContain("may be refused");
  });

  it("editing the cwd while mkdir is pending ⇒ the late success never overwrites it (「已新建文件夹」 ack only, panel stays open)", async () => {
    const d = deferredMkdir();
    const h = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([{ name: "sub", type: "dir" }]) }), {
      mkdir: d.mkdir,
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    await click(q(".spawn-mkdir-open"));
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "fresh");
    await click(q(".spawn-mkdir-form .btn-primary"));
    expect(d.pending()).toBe(1);

    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/edited"); // user moved on mid-flight
    d.resolve({ ok: true, path: "/home/u/proj/fresh", known: true });
    await flushPromises();
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/edited"); // never overwritten
    expect(document.body.querySelector(".spawn-browse")).not.toBeNull(); // panel NOT closed
    expect(q(".spawn-mkdir-ack").textContent).toContain("Folder created: /home/u/proj/fresh");
  });

  it("picking recent dir B while mkdir is pending ⇒ the late success keeps B (ackCreated only)", async () => {
    const d = deferredMkdir();
    const h = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([]) }), {
      mkdir: d.mkdir,
      recent: [{ cwd: "/home/u/beta", label: "beta", at: 1000 }],
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    await click(q(".spawn-mkdir-open"));
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "fresh");
    await click(q(".spawn-mkdir-form .btn-primary"));
    expect(d.pending()).toBe(1);

    await click(q(".spawn-recent-btn")); // pick B mid-flight
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/beta");
    d.resolve({ ok: true, path: "/home/u/proj/fresh", known: true });
    await flushPromises();
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/beta"); // B survives
    expect(q(".spawn-mkdir-ack").textContent).toContain("Folder created: /home/u/proj/fresh");
  });

  it("closing the panel while mkdir is pending ⇒ the late success never re-opens it (ackCreated only)", async () => {
    const d = deferredMkdir();
    const h = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([]) }), {
      mkdir: d.mkdir,
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    await click(q(".spawn-mkdir-open"));
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "fresh");
    await click(q(".spawn-mkdir-form .btn-primary"));
    expect(d.pending()).toBe(1);

    await click(q(".spawn-browse-toggle")); // close the panel mid-flight
    expect(document.body.querySelector(".spawn-browse")).toBeNull();
    d.resolve({ ok: true, path: "/home/u/proj/fresh", known: true });
    await flushPromises();
    expect(document.body.querySelector(".spawn-browse")).toBeNull(); // stays closed
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/proj"); // untouched
    expect(q(".spawn-mkdir-ack").textContent).toContain("Folder created: /home/u/proj/fresh");
  });

  it("navigating while mkdir is pending supersedes it: the older success is ackCreated-only, a stale ERROR is dropped", async () => {
    const d = deferredMkdir();
    const h = browseHarness(
      async (req) =>
        req.path === "/home/u/proj/sub"
          ? { ok: true, kind: "dir", listing: listing([{ name: "deep", type: "dir" }]) }
          : { ok: true, kind: "dir", listing: listing([{ name: "sub", type: "dir" }]) },
      { mkdir: d.mkdir },
    );
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    await click(q(".spawn-mkdir-open"));
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "fresh");
    await click(q(".spawn-mkdir-form .btn-primary"));
    expect(d.pending()).toBe(1);

    await click(q("button.spawn-browse-row")); // drill into sub — the mkdir's intent is stale now
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/proj/sub");
    d.resolve({ ok: true, path: "/home/u/proj/fresh", known: true });
    await flushPromises();
    // the older request resolving after the newer navigation: selection ignored
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/proj"); // untouched
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/proj/sub"); // panel where the user left it
    expect(q(".spawn-mkdir-ack").textContent).toContain("Folder created: /home/u/proj/fresh");

    // a stale ERROR is dropped silently (no error line, no state damage).
    // (picker 1's mkdir form is still open — the stale success touches nothing — so close
    // it first to keep the per-picker indexes below aligned.)
    await click(q(".spawn-mkdir-form .btn-ghost"));
    const d2 = deferredMkdir();
    const h2 = browseHarness(
      async () => ({ ok: true, kind: "dir", listing: listing([{ name: "sub", type: "dir" }]) }),
      {
        mkdir: d2.mkdir,
      },
    );
    mountPicker(h2, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    const panel2 = qa(".spawn-picker")[1]!;
    await click(panel2.querySelector<HTMLElement>(".spawn-browse-toggle")!);
    await click(panel2.querySelector<HTMLElement>(".spawn-mkdir-open")!);
    await setValue(panel2.querySelector<HTMLInputElement>(".spawn-mkdir-input")!, "taken");
    await click(panel2.querySelector<HTMLElement>(".spawn-mkdir-form .btn-primary")!);
    expect(d2.pending()).toBe(1);
    await click(panel2.querySelector<HTMLElement>("button.spawn-browse-row")!); // supersede via navigation
    d2.resolve({ ok: false, error: "E_CONFLICT", reason: "exists", status: 409 });
    await flushPromises();
    expect(qa(".spawn-mkdir-error")).toHaveLength(0); // dropped, not rendered
    expect(qa(".spawn-mkdir-ack")).toHaveLength(1); // only the FIRST picker's ack
  });

  it("mkdir failure shows the classified line and keeps the form open (exists / invalid name)", async () => {
    const h = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([]) }), {
      mkdir: async () => ({ ok: false, error: "E_CONFLICT", reason: "exists", status: 409 }),
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    await click(q(".spawn-mkdir-open"));
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "taken");
    await click(q(".spawn-mkdir-form .btn-primary"));
    expect(q(".spawn-mkdir-error").textContent).toContain("already exists");
    expect(document.body.querySelector(".spawn-mkdir-form")).not.toBeNull(); // form stays open

    // a locally-invalid name never hits the wire
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "a/b");
    await click(q(".spawn-mkdir-form .btn-primary"));
    expect(h.mkdirCalls).toHaveLength(1);
    expect(q(".spawn-mkdir-error").textContent).toContain("Invalid name");
  });

  it("mkdir cancel closes the inline form without a call", async () => {
    const h = browseHarness(async () => ({ ok: true, kind: "dir", listing: listing([]) }), {
      mkdir: async () => ({ ok: true, path: "/x/y" }),
    });
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    await click(q(".spawn-mkdir-open"));
    await setValue(q<HTMLInputElement>(".spawn-mkdir-input"), "nope");
    await click(q(".spawn-mkdir-form .btn-ghost"));
    expect(h.mkdirCalls).toHaveLength(0);
    expect(document.body.querySelector(".spawn-mkdir-form")).toBeNull();
  });
});

describe("DirPicker.vue — 输入联动 (spawn-browse-follow)", () => {
  const DIR_CAPS = ["spawn.v1", "preview.dir.v1"];

  function listing(entries: Array<{ name: string; type: "dir" | "file"; lossy?: true }>) {
    return {
      entries,
      total: entries.length,
      scanned: entries.length,
      complete: true,
      truncated: false,
      limits: { scan: false, entries: false, bytes: false },
      vanished: 0,
      dropped: 0,
    };
  }

  /** A manually-driven preview fetch: every call parks until `answer` resolves it. */
  function deferredPreview() {
    const calls: Array<{ agentKey: string; sessionId: string; path: string; dir?: true }> = [];
    const waiting: Array<{ resolve: (out: unknown) => void; path: string }> = [];
    return {
      calls,
      fetch: (req: { agentKey: string; sessionId: string; path: string; dir?: true }) => {
        calls.push(req);
        return new Promise((resolve) => waiting.push({ resolve, path: req.path }));
      },
      /** Resolve the OLDEST parked fetch (FIFO); the harness can also resolve by path. */
      answer(out: unknown): void {
        const w = waiting.shift();
        if (w === undefined) throw new Error("no parked fetch");
        w.resolve(out);
      },
      answerPath(path: string, out: unknown): void {
        const i = waiting.findIndex((w) => w.path === path);
        if (i < 0) throw new Error(`no parked fetch for ${path}`);
        const [w] = waiting.splice(i, 1);
        w!.resolve(out);
      },
    };
  }

  function followHarness(p: ReturnType<typeof deferredPreview>) {
    return harness({
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      caps: DIR_CAPS,
      withSession: true,
      preview: p.fetch,
    });
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("editing the cwd input re-navigates the panel after the debounce; a valid directory jumps", async () => {
    const p = deferredPreview();
    const h = followHarness(p);
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    expect(p.calls).toHaveLength(1); // the open load
    p.answer({ ok: true, kind: "dir", listing: listing([{ name: "sub", type: "dir" }]) });
    await flushPromises();
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/proj");

    // no fetch before the debounce elapses
    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/other");
    expect(p.calls).toHaveLength(1);
    await sleep(320);
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]!.path).toBe("/home/u/other");
    p.answer({ ok: true, kind: "dir", listing: listing([{ name: "deep", type: "dir" }]) });
    await flushPromises();
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/other");
    expect(qa(".spawn-browse-row")).toHaveLength(1);
    expect(q(".spawn-browse-row").textContent).toContain("deep");
    expect(document.body.querySelector(".spawn-browse-follow-note")).toBeNull();
  });

  it("an invalid directory leaves the panel in place with the light hint (path bar reverts)", async () => {
    const p = deferredPreview();
    const h = followHarness(p);
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    p.answer({ ok: true, kind: "dir", listing: listing([{ name: "sub", type: "dir" }]) });
    await flushPromises();

    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/gone");
    await sleep(320);
    expect(p.calls).toHaveLength(2);
    p.answer({ ok: false, error: "E_NOT_FOUND", status: 404 });
    await flushPromises();
    // 原地: 列表/路径条都是旧的, 一行轻提示
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/proj");
    expect(q(".spawn-browse-row").textContent).toContain("sub");
    expect(q(".spawn-browse-follow-note").textContent).toContain("Not a valid directory");
    expect(document.body.querySelector(".spawn-browse .spawn-picker-error")).toBeNull(); // no full error phase

    // a follow-up VALID input clears the hint
    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/proj");
    await sleep(320);
    // path === browsePath ⇒ no new fetch, but the hint clears on the next successful follow;
    // jump elsewhere to prove the clear
    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/other");
    await sleep(320);
    p.answer({ ok: true, kind: "dir", listing: listing([]) });
    await flushPromises();
    expect(document.body.querySelector(".spawn-browse-follow-note")).toBeNull();
  });

  it("race: a stale answer (first-sent, late-arriving) is discarded once a newer load landed", async () => {
    const p = deferredPreview();
    const h = followHarness(p);
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    p.answer({ ok: true, kind: "dir", listing: listing([{ name: "base", type: "dir" }]) });
    await flushPromises();

    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/a-first");
    await sleep(320); // fetch A in flight
    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/b-second");
    await sleep(320); // fetch B in flight (A superseded)
    expect(p.calls.map((c) => c.path)).toEqual(["/home/u/proj", "/a-first", "/b-second"]);

    // B lands first and applies
    p.answerPath("/b-second", { ok: true, kind: "dir", listing: listing([{ name: "B", type: "dir" }]) });
    await flushPromises();
    expect(q(".spawn-browse-path").textContent).toBe("/b-second");
    expect(q(".spawn-browse-row").textContent).toContain("B");

    // A arrives late ⇒ discarded (seq guard), the panel stays on B
    p.answerPath("/a-first", { ok: true, kind: "dir", listing: listing([{ name: "A", type: "dir" }]) });
    await flushPromises();
    expect(q(".spawn-browse-path").textContent).toBe("/b-second");
    expect(q(".spawn-browse-row").textContent).toContain("B");
  });

  it("a follow fetch keeps the current listing on screen while in flight — no loading swap (anti-jitter, 2026-10-13)", async () => {
    const p = deferredPreview();
    const h = followHarness(p);
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    p.answer({
      ok: true,
      kind: "dir",
      listing: listing([
        { name: "a", type: "dir" },
        { name: "b", type: "dir" },
        { name: "c", type: "dir" },
      ]),
    });
    await flushPromises();
    expect(qa(".spawn-browse-row")).toHaveLength(3);

    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/other");
    await sleep(320); // follow fetch now in flight
    expect(p.calls).toHaveLength(2);
    // 在途期间：列表/路径条保持原样，loading 行不接管（弹窗高度不变 = 不抖）
    expect(qa(".spawn-browse-row")).toHaveLength(3);
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/proj");
    expect(document.body.querySelector(".spawn-browse .spawn-picker-status")).toBeNull();
    expect(document.body.querySelector(".spawn-browse-follow-busy.is-active")).not.toBeNull(); // bar spinner

    p.answer({ ok: true, kind: "dir", listing: listing([{ name: "deep", type: "dir" }]) });
    await flushPromises();
    expect(qa(".spawn-browse-row")).toHaveLength(1);
    expect(q(".spawn-browse-row").textContent).toContain("deep");
    expect(q(".spawn-browse-path").textContent).toBe("/home/u/other");
    expect(document.body.querySelector(".spawn-browse-follow-busy.is-active")).toBeNull();
  });

  it("a failing follow keeps the hint steady across keystrokes (cleared by success or by re-matching the panel path)", async () => {
    const p = deferredPreview();
    const h = followHarness(p);
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    p.answer({ ok: true, kind: "dir", listing: listing([{ name: "sub", type: "dir" }]) });
    await flushPromises();

    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/g1");
    await sleep(320);
    p.answer({ ok: false, error: "E_NOT_FOUND", status: 404 });
    await flushPromises();
    expect(q(".spawn-browse-follow-note")).not.toBeNull();

    // 继续敲到另一个失败路径：新 fetch 在途期间 hint 不闪（保持显示）
    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/g2");
    await sleep(320);
    expect(p.calls).toHaveLength(3);
    expect(q(".spawn-browse-follow-note")).not.toBeNull(); // 在途仍显示
    p.answer({ ok: false, error: "E_NOT_FOUND", status: 404 });
    await flushPromises();
    expect(q(".spawn-browse-follow-note")).not.toBeNull();

    // 输入回到面板当前路径 ⇒ 提示清除且不发请求
    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/proj");
    await sleep(320);
    expect(p.calls).toHaveLength(3);
    expect(document.body.querySelector(".spawn-browse-follow-note")).toBeNull();
  });

  it("「选择此目录」 writes the input AFTER closing — no follow loop, no extra fetch", async () => {
    const p = deferredPreview();
    const h = followHarness(p);
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    p.answer({ ok: true, kind: "dir", listing: listing([]) });
    await flushPromises();
    await click(q(".spawn-browse-choose")); // writes cwd + closes
    expect(q<HTMLInputElement>("#spawn-cwd").value).toBe("/home/u/proj");
    expect(document.body.querySelector(".spawn-browse")).toBeNull();
    await sleep(400); // longer than the debounce — the programmatic write must not follow
    expect(p.calls).toHaveLength(1);
  });

  it("empty input and NUL-containing input never fire a request", async () => {
    const p = deferredPreview();
    const h = followHarness(p);
    mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    await click(q(".spawn-browse-toggle"));
    p.answer({ ok: true, kind: "dir", listing: listing([]) });
    await flushPromises();
    expect(p.calls).toHaveLength(1);

    await setValue(q<HTMLInputElement>("#spawn-cwd"), "");
    await sleep(320);
    expect(p.calls).toHaveLength(1); // empty ⇒ no fetch

    await setValue(q<HTMLInputElement>("#spawn-cwd"), "/home/u/bad\0nul");
    await sleep(320);
    expect(p.calls).toHaveLength(1); // NUL ⇒ no fetch
  });
});
