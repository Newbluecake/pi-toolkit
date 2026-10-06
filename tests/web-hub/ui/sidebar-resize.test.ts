// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampSidebarWidth,
  loadSidebarWidth,
  SIDEBAR_RESIZING_CLASS,
  SIDEBAR_WIDTH_FALLBACK,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  SIDEBAR_WIDTH_STORAGE_KEY,
  sidebarWidthMax,
  useSidebarWidth,
} from "../../../src/web-hub/ui/src/composables/useSidebarWidth.js";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import DashboardView from "../../../src/web-hub/ui/src/components/shell/DashboardView.vue";
import type { HubHandle, HubState, Route } from "../../../src/web-hub/ui/src/types.js";

/**
 * Draggable session-list sidebar (desktop ≥1025px split): pointer drag math + clamping,
 * `pwh_sidebar_w` persistence/restore, keyboard separator pattern (arrows/Home/End),
 * double-click reset, and the band gating (handle + inline override exist ONLY at ≥1025px —
 * the 481–1024 drawer band stays byte-identical).
 */

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const fakeWin = (innerWidth = 1280) => ({
  innerWidth,
  getComputedStyle: () => ({ gridTemplateColumns: "" }),
});

function fakeHandle() {
  const listeners = new Map<string, Array<(ev: { clientX: number }) => void>>();
  return {
    listeners,
    captured: [] as number[],
    addEventListener(type: string, fn: (ev: { clientX: number }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: (ev: { clientX: number }) => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((f) => f !== fn),
      );
    },
    setPointerCapture(id: number) {
      this.captured.push(id);
    },
    fire(type: string, ev: { clientX: number }) {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    },
    down(clientX: number) {
      return {
        button: 0,
        pointerId: 7,
        clientX,
        currentTarget: this,
        preventDefault: () => {},
      };
    },
  };
}

function fakeBody() {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
    },
  };
}

describe("useSidebarWidth — pure math + storage", () => {
  it("sidebarWidthMax: min(560, 50vw); clamp rounds and bounds", () => {
    expect(sidebarWidthMax({ innerWidth: 1280 })).toBe(560);
    expect(sidebarWidthMax({ innerWidth: 1024 })).toBe(512);
    expect(clampSidebarWidth(100, { innerWidth: 1280 })).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(9999, { innerWidth: 1280 })).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(9999, { innerWidth: 1024 })).toBe(512); // 50vw beats the static cap
    expect(clampSidebarWidth(333.6, { innerWidth: 1280 })).toBe(334);
  });

  it("loadSidebarWidth: null when unset; valid values load rounded", () => {
    expect(loadSidebarWidth(fakeStorage())).toBeNull();
    expect(loadSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "480" }))).toBe(480);
    expect(loadSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "240" }))).toBe(240);
    expect(loadSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "560" }))).toBe(560);
  });

  it("loadSidebarWidth: unparseable / out-of-static-bounds values are ignored", () => {
    for (const bad of ["bogus", "", "239", "561", "320px", "Infinity", "NaN"]) {
      expect(loadSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: bad }))).toBeNull();
    }
    const throwing = {
      getItem: () => {
        throw new Error("disabled");
      },
    };
    expect(loadSidebarWidth(throwing as never)).toBeNull();
  });

  it("drag: pointerdown at x, move, up — width delta applied, clamped, persisted on release only", () => {
    const storage = fakeStorage();
    const body = fakeBody();
    const h = useSidebarWidth({ storage, win: fakeWin(), target: ref(null), body });
    const handle = fakeHandle();
    h.onPointerDown(handle.down(500));
    expect(h.dragging.value).toBe(true);
    expect(handle.captured).toEqual([7]);
    expect(body.classes.has(SIDEBAR_RESIZING_CLASS)).toBe(true);
    // start width = fallback 320 (no override, nothing measurable); +120 → 440
    handle.fire("pointermove", { clientX: 620 });
    expect(h.width.value).toBe(SIDEBAR_WIDTH_FALLBACK + 120);
    expect(storage.map.has(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(false); // no persist mid-drag
    handle.fire("pointermove", { clientX: 2000 }); // beyond max → clamp 560
    expect(h.width.value).toBe(560);
    handle.fire("pointermove", { clientX: -2000 }); // below min → clamp 240
    expect(h.width.value).toBe(240);
    handle.fire("pointerup", { clientX: -2000 });
    expect(h.dragging.value).toBe(false);
    expect(storage.map.get(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("240");
    expect(body.classes.has(SIDEBAR_RESIZING_CLASS)).toBe(false);
    // listeners detached after release
    expect(handle.listeners.get("pointermove") ?? []).toHaveLength(0);
    expect(handle.listeners.get("pointerup") ?? []).toHaveLength(0);
  });

  it("drag: right-click is ignored; dispose() mid-drag cleans up without throwing", () => {
    const body = fakeBody();
    const h = useSidebarWidth({ storage: fakeStorage(), win: fakeWin(), target: ref(null), body });
    const handle = fakeHandle();
    h.onPointerDown({ ...handle.down(0), button: 2 });
    expect(h.dragging.value).toBe(false);
    h.onPointerDown(handle.down(0));
    h.dispose();
    expect(h.dragging.value).toBe(false);
    expect(body.classes.has(SIDEBAR_RESIZING_CLASS)).toBe(false);
    expect(handle.listeners.get("pointermove") ?? []).toHaveLength(0);
  });

  it("keyboard: arrows step 16px, Home/End to min/max, clamped, persisted each step", () => {
    const storage = fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "320" });
    const h = useSidebarWidth({ storage, win: fakeWin(), target: ref(null) });
    const key = (k: string) => ({ key: k, preventDefault: () => {} });
    h.onKeyDown(key("ArrowRight"));
    expect(h.width.value).toBe(320 + SIDEBAR_WIDTH_STEP);
    h.onKeyDown(key("ArrowLeft"));
    h.onKeyDown(key("ArrowLeft"));
    expect(h.width.value).toBe(320 - SIDEBAR_WIDTH_STEP);
    expect(storage.map.get(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(320 - SIDEBAR_WIDTH_STEP));
    h.onKeyDown(key("Home"));
    expect(h.width.value).toBe(SIDEBAR_WIDTH_MIN);
    h.onKeyDown(key("End"));
    expect(h.width.value).toBe(SIDEBAR_WIDTH_MAX);
    h.onKeyDown(key("ArrowRight")); // already at max — stays clamped
    expect(h.width.value).toBe(SIDEBAR_WIDTH_MAX);
    h.onKeyDown(key("Enter")); // unhandled key: no-op
    expect(h.width.value).toBe(SIDEBAR_WIDTH_MAX);
  });

  it("reset: clears the override and the stored value", () => {
    const storage = fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "480" });
    const h = useSidebarWidth({ storage, win: fakeWin(), target: ref(null) });
    expect(h.width.value).toBe(480);
    h.reset();
    expect(h.width.value).toBeNull();
    expect(storage.map.has(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// component-level: DashboardView wiring
// ---------------------------------------------------------------------------

const Q_NARROW = "(max-width: 767px)";
const Q_WIDE = "(min-width: 1025px)";
const Q_BAND = "(min-width: 481px) and (max-width: 1024px)";

function stubMatchMediaMap(map: Record<string, boolean>): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: map[query] ?? false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const WIDE = { [Q_NARROW]: false, [Q_WIDE]: true, [Q_BAND]: false };
const MID = { [Q_NARROW]: false, [Q_WIDE]: false, [Q_BAND]: true };

type Msg = { event: string; data: unknown; id?: number };
const run = (msgs: Msg[], s = initialState()): ReturnType<typeof initialState> =>
  msgs.reduce((acc, m) => reduce(acc, m), s);

function hubWithAgents(...keys: string[]): HubHandle {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    {
      event: "agents",
      data: keys.map((agentKey) => ({
        agentKey,
        kind: "tui",
        pid: 1,
        cwd: "/tmp/p",
        state: "live",
        pluginVersion: "1.0.0",
        outdated: false,
        prompts: [],
      })),
    },
    ...keys.map((agentKey) => ({ event: "subscribing", data: { agentKey, clientId: "c1" } })),
    ...keys.map((agentKey) => ({
      event: "history",
      data: { agentKey, entries: [], tailMessages: [], fromSeq: 0, hasMore: false },
    })),
  ]);
  return { state: ref(s as unknown as HubState), dispatch: () => {} };
}

const mounted: Array<ReturnType<typeof mount>> = [];
function mountDashboard(route: Route, hub: HubHandle) {
  const wrapper = mount(DashboardView, { props: { hub, route } });
  mounted.push(wrapper);
  return wrapper;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const w of mounted.splice(0)) w.unmount();
  window.localStorage.clear();
  window.location.hash = "";
});

describe("DashboardView.vue — sidebar resize handle (≥1025px split)", () => {
  it("wide: handle rendered with separator semantics; drag updates the inline --sidebar-w and persists on release", async () => {
    stubMatchMediaMap(WIDE);
    const wrapper = mountDashboard({ name: "list" }, hubWithAgents("agent-a"));
    const handle = wrapper.find(".sidebar-resizer");
    expect(handle.exists()).toBe(true);
    expect(handle.attributes("role")).toBe("separator");
    expect(handle.attributes("aria-orientation")).toBe("vertical");
    expect(handle.attributes("tabindex")).toBe("0");
    const layout = wrapper.find(".layout");
    expect(layout.attributes("style") ?? "").not.toContain("--sidebar-w");

    await handle.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 500 });
    await handle.trigger("pointermove", { clientX: 660 }); // fallback + 160
    const dragged = SIDEBAR_WIDTH_FALLBACK + 160;
    expect(layout.attributes("style")).toContain(`--sidebar-w: ${dragged}px`);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();
    await handle.trigger("pointerup", { clientX: 660 });
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(dragged));
  });

  it("wide: drag clamps at min/max (happy-dom innerWidth 1024 ⇒ max = 512)", async () => {
    stubMatchMediaMap(WIDE);
    const wrapper = mountDashboard({ name: "list" }, hubWithAgents("agent-a"));
    const handle = wrapper.find(".sidebar-resizer");
    const layout = wrapper.find(".layout");
    await handle.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 500 });
    await handle.trigger("pointermove", { clientX: 5000 });
    expect(layout.attributes("style")).toContain(`--sidebar-w: 512px`);
    await handle.trigger("pointermove", { clientX: -5000 });
    expect(layout.attributes("style")).toContain(`--sidebar-w: ${SIDEBAR_WIDTH_MIN}px`);
    await handle.trigger("pointerup", { clientX: -5000 });
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(SIDEBAR_WIDTH_MIN));
  });

  it("wide: a valid stored width restores on mount; an invalid one is ignored", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "480");
    stubMatchMediaMap(WIDE);
    const wrapper = mountDashboard({ name: "list" }, hubWithAgents("agent-a"));
    expect(wrapper.find(".layout").attributes("style")).toContain("--sidebar-w: 480px");
    wrapper.unmount();
    mounted.pop();

    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "bogus");
    const wrapper2 = mountDashboard({ name: "list" }, hubWithAgents("agent-a"));
    expect(wrapper2.find(".layout").attributes("style") ?? "").not.toContain("--sidebar-w");
  });

  it("wide: keyboard arrows step and persist; double-click resets storage + inline style", async () => {
    stubMatchMediaMap(WIDE);
    const wrapper = mountDashboard({ name: "list" }, hubWithAgents("agent-a"));
    const handle = wrapper.find(".sidebar-resizer");
    const layout = wrapper.find(".layout");
    await handle.trigger("keydown", { key: "ArrowRight" }); // fallback + 16
    const stepped = SIDEBAR_WIDTH_FALLBACK + SIDEBAR_WIDTH_STEP;
    expect(layout.attributes("style")).toContain(`--sidebar-w: ${stepped}px`);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(stepped));
    await handle.trigger("keydown", { key: "Home" });
    expect(layout.attributes("style")).toContain(`--sidebar-w: ${SIDEBAR_WIDTH_MIN}px`);
    await handle.trigger("dblclick");
    expect(layout.attributes("style") ?? "").not.toContain("--sidebar-w");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();
  });

  it("mid band (481–1024px): no handle, no inline override, even with a stored width", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "480");
    stubMatchMediaMap(MID);
    const wrapper = mountDashboard({ name: "list" }, hubWithAgents("agent-a"));
    expect(wrapper.find(".sidebar-resizer").exists()).toBe(false);
    expect(wrapper.find(".layout").attributes("style") ?? "").not.toContain("--sidebar-w");
  });
});
