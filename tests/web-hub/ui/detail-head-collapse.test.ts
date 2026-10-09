// @vitest-environment happy-dom
/**
 * `pwh_detail_head_collapsed` (`composables/useDetailHeadCollapse.ts`, 2026-10 user request
 * 「红框部分支持收起，点击标题展开」): the detail-header info block (SessionInfo / TodoPanel /
 * WorktreePanel / BashJobsPanel) collapses behind the title, which becomes the disclosure
 * toggle. Pinned here:
 *
 *  - pref absent/invalid ⇒ EXPANDED, byte-identical rows (the pre-feature default, fail-open);
 *  - the title button toggles: click collapses (rows not rendered) + persists "1"; click again
 *    expands + persists "0"; aria-expanded/aria-controls follow;
 *  - pref "1" at mount ⇒ collapsed without any interaction;
 *  - other titlebar controls (back button, drawer toggle, managed stop button) never toggle;
 *  - a drag-select over the title (non-empty window selection) reads as a selection, not a toggle;
 *  - the transient `<p>` notices (stop error / first-prompt refill) stay OUTSIDE the block —
 *    collapsing must never hide an alert;
 *  - a `storage` event from ANOTHER tab flips a mounted header too (cross-tab sync);
 *  - en/zh key parity for the new i18n leaf (the global i18n-parity suite enforces the whole
 *    dictionary; this pins the specific key so a partial edit fails with a pointed message).
 */
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import { SIDEBAR_DRAWER } from "../../../src/web-hub/ui/src/components/shell/sidebarDrawer.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import {
  DETAIL_HEAD_COLLAPSED_STORAGE_KEY,
  loadDetailHeadCollapsed,
  parseDetailHeadCollapsed,
  resetDetailHeadCollapseForTests,
  setDetailHeadCollapsedPref,
  useDetailHeadCollapse,
  type DetailHeadStorageEvent,
  type DetailHeadWindow,
} from "../../../src/web-hub/ui/src/composables/useDetailHeadCollapse.js";
import type { AgentState, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import type { SpawnRecordPublic, SpawnsPayload } from "../../../src/web-hub/protocol/spawn.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDetailHeadCollapseForTests();
  window.localStorage.clear();
});

function agent(over: Partial<AgentState> = {}): AgentState {
  return {
    key: "agent-1",
    card: { agentKey: "agent-1", kind: "tui", pid: 123, cwd: "/home/u/p", state: "live" },
    down: false,
    session: {
      sessionId: "01a0d892-5c1e-7a40-9e2b-4f6d0c8a1b37",
      cwd: "/home/u/p",
      name: "web-hub Vue rewrite",
      model: { provider: "cr-anthropic", id: "claude-opus-5-5" },
      thinkingLevel: "high",
      mode: "tui",
    },
    status: { busy: true, pending: false, costUsd: 1.5 },
    prompts: [],
    fleet: [],
    items: [],
    uid: 0,
    lastSeq: 0,
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
    ...over,
  } as unknown as AgentState;
}

function spawnRec(over: Partial<SpawnRecordPublic> = {}): SpawnRecordPublic {
  return {
    spawnId: "sp9",
    state: "live",
    createdAt: 1000,
    updatedAt: 1000,
    cwdLabel: "proj",
    agentKey: "agent-1",
    origin: { listener: "loopback", reqId: "req-aaaaaaaaaaaaaaaa" },
    ...over,
  };
}

function hubWithSpawn(spawns: SpawnsPayload | null): HubHandle {
  return {
    state: ref({ agents: new Map(), spawns } as unknown as HubState),
    dispatch: () => {},
    spawn: {
      list: async () => ({ ok: true, policy: {} as never, items: spawns?.items ?? [] }),
      dirs: async () => ({ ok: true, recent: [] }),
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      stop: async () => ({ ok: true, state: "stopping" }),
      newSession: {
        flow: ref({ phase: "idle" }),
        submit: async () => true,
        confirm: async () => {},
        cancel: () => {},
        retry: async () => false,
        noteSpawns: () => {},
        dispose: () => {},
        stats: () => ({ retainedTexts: 0 }),
      },
    },
  };
}

const mountHead = (
  over: { props?: Partial<{ agent: AgentState; narrow: boolean }>; provide?: Record<string, unknown> } = {},
) =>
  mount(DetailHeader, {
    props: { agent: agent(over.props?.agent), narrow: over.props?.narrow ?? false },
    global: { provide: over.provide ?? {} },
  });

// --- pure pref read/write ---------------------------------------------------------------------

describe("useDetailHeadCollapse — pure pref read/write", () => {
  it('only the exact token "1" parses as collapsed; everything else fails open to expanded', () => {
    expect(parseDetailHeadCollapsed("1")).toBe(true);
    for (const raw of ["0", "true", "yes", "", " 1", "2", "on"]) expect(parseDetailHeadCollapsed(raw)).toBe(false);
    expect(parseDetailHeadCollapsed(null)).toBe(false);
  });

  it("loadDetailHeadCollapsed: absent ⇒ false; '1' ⇒ true; a throwing storage fails open to false", () => {
    const storage = new Map<string, string>();
    const shim = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    };
    expect(loadDetailHeadCollapsed(shim)).toBe(false);
    storage.set(DETAIL_HEAD_COLLAPSED_STORAGE_KEY, "1");
    expect(loadDetailHeadCollapsed(shim)).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error("locked");
      },
      setItem: () => {
        throw new Error("locked");
      },
    };
    expect(loadDetailHeadCollapsed(throwing)).toBe(false);
  });

  it("setDetailHeadCollapsedPref persists '1'/'0' and ignores write failures", () => {
    const storage = new Map<string, string>();
    const shim = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    };
    setDetailHeadCollapsedPref(shim, true);
    expect(storage.get(DETAIL_HEAD_COLLAPSED_STORAGE_KEY)).toBe("1");
    setDetailHeadCollapsedPref(shim, false);
    expect(storage.get(DETAIL_HEAD_COLLAPSED_STORAGE_KEY)).toBe("0");
    const throwing = {
      getItem: (): string | null => null,
      setItem: () => {
        throw new Error("locked");
      },
    };
    expect(() => setDetailHeadCollapsedPref(throwing, true)).not.toThrow();
  });
});

// --- default expanded + the toggle ------------------------------------------------------------

describe("DetailHeader.vue — title-toggle collapse (2026-10 「红框部分支持收起」)", () => {
  it("pref absent ⇒ EXPANDED: rows render, aria-expanded=true, aria-controls wired, title text intact", () => {
    const wrapper = mountHead();
    const block = wrapper.find("#detail-head-info");
    expect(block.exists()).toBe(true);
    expect(block.classes()).toContain("detail-head-info");
    expect(block.find(".session-sum").exists()).toBe(true);
    // the info block is the header's LAST child — the pre-feature "header bottom" placement
    const kids = wrapper.find(".detail-head").element.children;
    expect(kids[kids.length - 1]).toBe(block.element);

    const btn = wrapper.get(".detail-title-toggle");
    expect(btn.attributes("aria-expanded")).toBe("true");
    expect(btn.attributes("aria-controls")).toBe("detail-head-info");
    expect(btn.attributes("aria-label")).toBe("Expand or collapse session info");
    // the h2 keeps its id (the detail region's aria-labelledby target) and the title text
    const h2 = wrapper.get("h2#detail-title");
    expect(h2.text()).toBe("web-hub Vue rewrite");
    expect(btn.find(".detail-title-text").text()).toBe("web-hub Vue rewrite");
  });

  it("invalid stored values fail open to expanded", () => {
    for (const raw of ["true", "yes", "0", ""]) {
      window.localStorage.setItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY, raw);
      expect(mountHead().find(".detail-head-info").exists(), `raw=${JSON.stringify(raw)}`).toBe(true);
    }
  });

  it("clicking the title collapses (rows NOT rendered) and persists '1'; clicking again expands and persists '0'", async () => {
    const wrapper = mountHead();
    const btn = wrapper.get(".detail-title-toggle");

    await btn.trigger("click");
    expect(wrapper.find(".detail-head-info").exists()).toBe(false);
    expect(wrapper.find(".session-sum").exists()).toBe(false);
    expect(btn.attributes("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY)).toBe("1");
    // the titlebar itself stays fully functional — title, pill, button all still there
    expect(wrapper.find("h2#detail-title").exists()).toBe(true);
    expect(wrapper.find(".pill").exists()).toBe(true);
    expect(wrapper.find(".detail-title-toggle").exists()).toBe(true);

    await btn.trigger("click");
    expect(wrapper.find(".detail-head-info").exists()).toBe(true);
    expect(wrapper.find(".session-sum").exists()).toBe(true);
    expect(btn.attributes("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY)).toBe("0");
  });

  it("a collapsed mount re-expands on toggle without losing the rows' own data", async () => {
    const withPanels = agent({
      status: {
        busy: false,
        pending: false,
        worktrees: {
          rows: [{ label: "~/p", path: "/home/u/p", branch: "master", head: "0123456", current: true, main: true }],
          total: 1,
          probed: 1,
          dirtyCount: 0,
          agentCount: 0,
          sampledAt: 1_700_000_000_000,
        },
      } as never,
    });
    window.localStorage.setItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY, "1");
    const wrapper = mountHead({ props: { agent: withPanels } });
    expect(wrapper.find(".detail-head-info").exists()).toBe(false);
    expect(wrapper.find(".wt-panel").exists()).toBe(false);

    await wrapper.get(".detail-title-toggle").trigger("click");
    expect(wrapper.find(".detail-head-info").exists()).toBe(true);
    expect(wrapper.find(".wt-sum-text").text()).toBe("master@0123456 · worktrees 1");
  });

  it('pref "1" at mount ⇒ collapsed without any interaction', () => {
    window.localStorage.setItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY, "1");
    const wrapper = mountHead();
    expect(wrapper.find(".detail-head-info").exists()).toBe(false);
    expect(wrapper.get(".detail-title-toggle").attributes("aria-expanded")).toBe("false");
  });

  it("other titlebar controls never toggle: back button, drawer toggle, managed stop button", async () => {
    let opened = 0;
    const drawer = { active: computed(() => true), open: () => opened++ };
    const hub = hubWithSpawn({ items: [spawnRec()], active: 1, max: 4 });
    const wrapper = mountHead({
      props: { narrow: true },
      provide: { [SIDEBAR_DRAWER as symbol]: drawer, [HUB_CTX as symbol]: hub },
    });
    expect(wrapper.find(".detail-head-info").exists()).toBe(true);

    await wrapper.get(".detail-back").trigger("click");
    expect(wrapper.emitted("back")).toHaveLength(1);
    expect(wrapper.find(".detail-head-info").exists()).toBe(true);

    await wrapper.get(".detail-drawer-toggle").trigger("click");
    expect(opened).toBe(1);
    expect(wrapper.find(".detail-head-info").exists()).toBe(true);

    const stop = wrapper.get(".spawn-stop-btn");
    await stop.trigger("click"); // arm only — never a toggle
    expect(stop.text()).toContain("Click again");
    expect(wrapper.find(".detail-head-info").exists()).toBe(true);
    expect(wrapper.get(".detail-title-toggle").attributes("aria-expanded")).toBe("true");
  });

  it("a drag-select over the title (non-empty window selection) does NOT toggle", async () => {
    const sel = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "web-hub Vue" } as Selection);
    const wrapper = mountHead();
    await wrapper.get(".detail-title-toggle").trigger("click");
    expect(wrapper.find(".detail-head-info").exists()).toBe(true); // untouched
    expect(window.localStorage.getItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY)).toBe(null);
    expect(sel).toHaveBeenCalled();

    sel.mockReturnValue({ toString: () => "" } as Selection); // a clean click toggles
    await wrapper.get(".detail-title-toggle").trigger("click");
    expect(wrapper.find(".detail-head-info").exists()).toBe(false);
  });

  it("collapsing never hides the transient notices (they live OUTSIDE the block)", async () => {
    const flow = {
      phase: "done",
      spawnId: "sp9",
      agentKey: "agent-1",
      firstPrompt: { state: "failed", refilled: "draft" },
    };
    const hub = hubWithSpawn({ items: [spawnRec()], active: 1, max: 4 });
    const wrapper = mountHead({
      provide: {
        [HUB_CTX as symbol]: {
          ...hub,
          spawn: { ...hub.spawn, newSession: { ...hub.spawn.newSession, flow: ref(flow) } },
        },
      },
    });
    expect(wrapper.find(".spawn-fp-note").exists()).toBe(true);
    await wrapper.get(".detail-title-toggle").trigger("click");
    expect(wrapper.find(".detail-head-info").exists()).toBe(false);
    expect(wrapper.find(".spawn-fp-note").exists()).toBe(true); // alert stays visible
  });
});

// --- cross-tab sync ---------------------------------------------------------------------------

describe("cross-tab sync via the storage event", () => {
  function fakeWin() {
    const listeners: Array<(ev: DetailHeadStorageEvent) => void> = [];
    const win: DetailHeadWindow = {
      addEventListener: (_t, l) => void listeners.push(l),
      removeEventListener: () => {},
    };
    return {
      win,
      fire: (ev: DetailHeadStorageEvent) => {
        for (const l of listeners) l(ev);
      },
    };
  }

  it("another tab writing the pref flips a mounted header here", async () => {
    const { win, fire } = fakeWin();
    useDetailHeadCollapse({ storage: window.localStorage, win }); // register the fake listener first
    const wrapper = mountHead();
    expect(wrapper.find(".detail-head-info").exists()).toBe(true);

    fire({ key: DETAIL_HEAD_COLLAPSED_STORAGE_KEY, newValue: "1" });
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail-head-info").exists()).toBe(false);
    expect(wrapper.get(".detail-title-toggle").attributes("aria-expanded")).toBe("false");

    fire({ key: DETAIL_HEAD_COLLAPSED_STORAGE_KEY, newValue: "0" });
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail-head-info").exists()).toBe(true);
  });

  it("an unrelated key is ignored; a storage.clear() (key null) re-reads the pref", async () => {
    window.localStorage.setItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY, "1");
    const { win, fire } = fakeWin();
    useDetailHeadCollapse({ storage: window.localStorage, win });
    const wrapper = mountHead();
    expect(wrapper.find(".detail-head-info").exists()).toBe(false); // pref "1" from storage

    fire({ key: "pwh_something_else", newValue: "1" });
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail-head-info").exists()).toBe(false); // untouched

    window.localStorage.removeItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY); // the other tab cleared storage
    fire({ key: null, newValue: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail-head-info").exists()).toBe(true);
  });
});

// --- i18n parity pin --------------------------------------------------------------------------

describe("i18n leaf exists in BOTH languages (global parity suite enforces the rest)", () => {
  it("detail.headToggleAria", () => {
    for (const lang of ["en", "zh"] as const) {
      expect(MESSAGES[lang]?.["detail"]?.headToggleAria, `${lang}.detail.headToggleAria`).toBeTruthy();
    }
  });
});
