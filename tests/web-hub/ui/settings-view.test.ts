// @vitest-environment happy-dom
/**
 * `shell/SettingsView.vue` (floating panel content, revised 2026-10 field report: settings is
 * no longer the standalone `#/settings` page — it is a panel floated over the session view by
 * `shell/SettingsOverlay.vue`) — theme radio rows (`useTheme`), font-size slider
 * (`useFontScale`), and the composer's default delivery mode (`useDeliverDefault`,
 * `pwh_deliver`). Also covers:
 *
 *  - the `theme-init.js` early-boot font-scale half (moved here from the retired
 *    `font-scale-toggle.test.ts`): a persisted in-range `pwh_fontscale` must reach `<html>`'s
 *    `--fs-scale` before first paint;
 *  - the slider-immunity field report: `.settings-font` pins `--fs-scale: 1` in settings.css
 *    so the slider's own geometry never shifts under the user's finger mid-drag (the DOM
 *    half — computed style in a real browser — is asserted by the playwright screenshot pass;
 *    here we pin the stylesheet declaration itself, same source-pinning precedent as
 *    `hash-route.test.ts`'s App.vue wiring pin);
 *  - the TopBar gear toggle that mounts/unmounts the panel.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount, flushPromises } from "@vue/test-utils";
import { ref, shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "../../../src/web-hub/ui/src/components/shell/SettingsView.vue";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";

// NOTE: resolve via path, not `new URL(...)` — happy-dom replaces the URL global with one
// that rejects file: URLs.
const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/web-hub/ui");
const THEME_INIT = resolve(UI_ROOT, "public/theme-init.js");
const SETTINGS_CSS = resolve(UI_ROOT, "src/styles/settings.css");

function runThemeInit(): void {
  // Execute the real bootstrap script against happy-dom's window/document, exactly as the
  // browser would from index.html's <script src="/theme-init.js">.
  new Function(readFileSync(THEME_INIT, "utf8"))();
}

function fsScale(): string {
  return document.documentElement.style.getPropertyValue("--fs-scale");
}

const mounted: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty("--fs-scale");
  document.documentElement.classList.remove("theme-light", "theme-dark");
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty("--fs-scale");
  document.documentElement.classList.remove("theme-light", "theme-dark");
  for (const w of mounted.splice(0)) w.unmount();
});

function mountSettings() {
  const wrapper = mount(SettingsView, { attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

describe("theme-init.js font-scale early boot (numeric parse)", () => {
  it("applies a persisted in-range value to <html> before paint", () => {
    window.localStorage.setItem("pwh_fontscale", "1.8");
    runThemeInit();
    expect(fsScale()).toBe("1.8");
  });

  it.each(["1", "0.8", "3"])("applies boundary value %s", (v) => {
    window.localStorage.setItem("pwh_fontscale", v);
    runThemeInit();
    expect(fsScale()).toBe(v);
  });

  it.each(["bogus", "0.5", "3.5", "Infinity"])(
    "sets nothing for %s (tokens.css's var(--fs-scale, 1) fallback is already 100%)",
    (v) => {
      window.localStorage.setItem("pwh_fontscale", v);
      runThemeInit();
      expect(fsScale()).toBe("");
    },
  );

  it("sets nothing when no preference was ever stored", () => {
    runThemeInit();
    expect(fsScale()).toBe("");
  });

  it("still applies the theme class alongside the font scale (original behavior intact)", () => {
    window.localStorage.setItem("pwh_theme", "dark");
    window.localStorage.setItem("pwh_fontscale", "1.15");
    runThemeInit();
    expect(document.documentElement.classList.contains("theme-dark")).toBe(true);
    expect(fsScale()).toBe("1.15");
  });
});

describe("SettingsView.vue — theme section", () => {
  it("renders three radio options with the persisted pref checked", () => {
    window.localStorage.setItem("pwh_theme", "dark");
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[0]!.findAll('[role="radio"]');
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.attributes("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(radios.map((r) => r.text())).toEqual(["System", "Light", "Dark"]);
  });

  it("clicking another option applies the class and persists pwh_theme", async () => {
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[0]!.findAll('[role="radio"]');
    await radios[2]!.trigger("click"); // dark
    expect(document.documentElement.classList.contains("theme-dark")).toBe(true);
    expect(window.localStorage.getItem("pwh_theme")).toBe("dark");
    expect(radios[2]!.attributes("aria-checked")).toBe("true");
    await radios[0]!.trigger("click"); // back to system — both classes removed
    expect(document.documentElement.classList.contains("theme-dark")).toBe(false);
    expect(window.localStorage.getItem("pwh_theme")).toBe("system");
  });
});

describe("SettingsView.vue — font-size section", () => {
  it("slider input live-previews without persisting; change persists the final value", async () => {
    const w = mountSettings();
    const range = w.find('input[type="range"]');
    expect(range.attributes("min")).toBe("0.8");
    expect(range.attributes("max")).toBe("3");
    expect(range.attributes("step")).toBe("0.05");
    expect(w.find(".settings-font-readout").text()).toBe("100%");
    const el = range.element as HTMLInputElement;

    el.value = "1.8";
    await range.trigger("input");
    expect(fsScale()).toBe("1.8");
    expect(w.find(".settings-font-readout").text()).toBe("180%");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe(null); // not yet

    await range.trigger("change");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe("1.8"); // persisted on release
  });

  it("reset returns to 100% and persists", async () => {
    window.localStorage.setItem("pwh_fontscale", "1.5");
    const w = mountSettings();
    expect(w.find(".settings-font-readout").text()).toBe("150%");
    await w.find("button.settings-font-reset").trigger("click");
    expect(w.find(".settings-font-readout").text()).toBe("100%");
    expect(fsScale()).toBe("1");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe("1");
  });

  it("slider container is immune to --fs-scale (settings.css re-declares the font tokens on .settings-font)", () => {
    // User field report + acceptance P1: the slider's geometry used to scale with the very
    // value it controls, shifting under the user's finger mid-drag. `--fs-scale: 1` alone is
    // NOT sufficient (custom properties substitute var() at the declaring element — :root's
    // tokens arrive pre-substituted), so the block must also RE-DECLARE the font tokens with
    // values referencing the container's own scale. happy-dom never applies the stylesheet,
    // so the declarations are pinned here; the playwright probe asserts the real browser's
    // computed readout fontSize === "13px" and a stable row rect mid-drag.
    const css = readFileSync(SETTINGS_CSS, "utf8");
    const block = /\.settings-font\s*\{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/--fs-scale:\s*1\s*;/);
    expect(block![1]).toMatch(/--fs-sm:\s*calc\(13px \* var\(--fs-scale/);
    expect(block![1]).toMatch(/--fs-xs:\s*calc\(12px \* var\(--fs-scale/);
    expect(block![1]).toMatch(/--fs-md:\s*calc\(14px \* var\(--fs-scale/);
  });
});

describe("SettingsView.vue — default delivery section", () => {
  it("renders steer/followUp radios; unset or corrupted storage falls back to steer", () => {
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[1]!.findAll('[role="radio"]');
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.attributes("aria-checked"))).toEqual(["true", "false"]);
    w.unmount();

    window.localStorage.setItem("pwh_deliver", "bogus");
    const bad = mountSettings();
    const badRadios = bad.findAll('[role="radiogroup"]')[1]!.findAll('[role="radio"]');
    expect(badRadios.map((r) => r.attributes("aria-checked"))).toEqual(["true", "false"]);
  });

  it("loads a stored followUp and persists changes on click", async () => {
    window.localStorage.setItem("pwh_deliver", "followUp");
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[1]!.findAll('[role="radio"]');
    expect(radios.map((r) => r.attributes("aria-checked"))).toEqual(["false", "true"]);
    await radios[0]!.trigger("click"); // steer
    expect(window.localStorage.getItem("pwh_deliver")).toBe("steer");
    expect(radios[0]!.attributes("aria-checked")).toBe("true");
    await radios[1]!.trigger("click"); // followUp
    expect(window.localStorage.getItem("pwh_deliver")).toBe("followUp");
  });
});

describe("SettingsView.vue — session cache section (D2, pwh_keepalive)", () => {
  it("renders the 1/3/5 radios with the persisted value checked; invalid storage selects 3", () => {
    window.localStorage.setItem("pwh_keepalive", "5");
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[2]!.findAll('[role="radio"]');
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.attributes("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(radios.map((r) => r.text())).toEqual(["Off (reload on every switch)", "3 sessions (default)", "5 sessions"]);
    w.unmount();

    window.localStorage.setItem("pwh_keepalive", "bogus");
    const bad = mountSettings();
    const badRadios = bad.findAll('[role="radiogroup"]')[2]!.findAll('[role="radio"]');
    expect(badRadios.map((r) => r.attributes("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("clicking Off persists pwh_keepalive = 1", async () => {
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[2]!.findAll('[role="radio"]');
    await radios[0]!.trigger("click"); // Off = legacy single-slot
    expect(window.localStorage.getItem("pwh_keepalive")).toBe("1");
    expect(radios[0]!.attributes("aria-checked")).toBe("true");
  });
});

describe("SettingsView.vue — navigation", () => {
  it("close button only emits `close` — the owner (SettingsOverlay/TopBar) decides how to tear the panel down", async () => {
    const w = mountSettings();
    const close = w.find("button.settings-close");
    expect(close.exists()).toBe(true);
    await close.trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });
});

describe("TopBar settings entry (floating panel, revised 2026-10)", () => {
  const baseProps = { conn: "open", hubVersion: null, canSignOut: false } as const;

  it("gear is a toggle button with an i18n aria-label; old href/toggles gone", () => {
    const wrapper = mount(TopBar, { props: baseProps });
    mounted.push(wrapper);
    const gear = wrapper.find("button.settings-link");
    expect(gear.exists()).toBe(true);
    expect(gear.attributes("href")).toBeUndefined();
    expect(gear.attributes("aria-expanded")).toBe("false");
    expect(gear.attributes("aria-controls")).toBe("settings-panel");
    expect(gear.attributes("aria-label")).toBe("Settings");
    expect(gear.find("use").attributes("href")).toBe("#i-gear");
    expect(wrapper.find(".theme-trigger").exists()).toBe(false);
    expect(wrapper.find(".fontscale-toggle").exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// default-model plan F1 — the 「新建会话默认模型」 card (2026-10 select-only rework: the
// free-text input + datalist + 「使用 pi 默认」/保存 buttons are gone, replaced by
// shell/SettingsModelPicker.vue — a switcher-styled chip trigger with a Teleport'd listbox;
// 「跟随 pi 默认」 is the always-present first row; the saved value can ONLY be a listed item).
// ---------------------------------------------------------------------------

describe("SettingsView.vue — default model card (select-only picker, 2026-10 rework)", () => {
  const CAP = "spawn.v1";
  const MODEL_CAP = "spawn.model.v1";

  interface FakeHub {
    hub: unknown;
    prefs: import("vue").ShallowRef<{ defaultModel: string | null } | null>;
    calls: { refresh: number; set: string[] };
  }

  function agentWithModels(items: Array<{ provider: string; id: string; name?: string }>) {
    return {
      down: false,
      session: {
        models: {
          status: "ok",
          items,
          total: items.length,
          policy: { model: "allow", thinking: "allow" },
          sampledAt: 1,
        },
      },
    };
  }

  function fakeHub(opts: {
    caps: string[];
    agents?: Map<string, unknown>;
    prefs?: { defaultModel: string | null } | null;
    listPrefs?: { defaultModel: string | null };
    saveImpl?: (
      v: string,
    ) => Promise<{ ok: true; prefs: { defaultModel: string | null } } | { ok: false; error: string }>;
  }): FakeHub {
    const prefs = shallowRef(opts.prefs ?? null);
    const calls = { refresh: 0, set: [] as string[] };
    const hub = {
      state: ref({ hub: { caps: opts.caps }, agents: opts.agents ?? new Map() }),
      dispatch: () => {},
      spawn: {
        prefs,
        refreshPrefs: async () => {
          calls.refresh++;
          if (opts.listPrefs !== undefined) prefs.value = opts.listPrefs;
          return { ok: true, policy: { allowed: true }, items: [] };
        },
        setDefaultModel: async (v: string) => {
          calls.set.push(v);
          const r =
            opts.saveImpl !== undefined
              ? await opts.saveImpl(v)
              : { ok: true as const, prefs: { defaultModel: v === "" ? null : v } };
          if (r.ok) prefs.value = r.prefs;
          return r;
        },
      },
    };
    return { hub, prefs, calls };
  }

  function mountWithHub(f: FakeHub) {
    const wrapper = mount(SettingsView, {
      attachTo: document.body,
      global: { provide: { [HUB_CTX as symbol]: f.hub } },
    });
    mounted.push(wrapper);
    return wrapper;
  }

  function triggerOf(w: ReturnType<typeof mount>) {
    return w.find(".settings-model-picker button.model-chip");
  }

  /** The desktop panel Teleports to <body> — VTU's wrapper tree never sees it. */
  function desktopPanel(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(".model-panel--fixed");
  }

  function panelRows(scope: ParentNode = document.body): HTMLElement[] {
    return [...scope.querySelectorAll<HTMLElement>(".model-panel--fixed .model-row, .picker-sheet .model-row")];
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  async function openPicker(w: ReturnType<typeof mount>): Promise<HTMLElement | null> {
    await triggerOf(w).trigger("click");
    await flush();
    return desktopPanel();
  }

  it("no spawn.v1 cap ⇒ the card is not rendered at all", () => {
    const w = mountWithHub(fakeHub({ caps: [] }));
    expect(w.find(".settings-model-picker").exists()).toBe(false);
    expect(w.text()).not.toContain("Default model for new sessions");
  });

  it("no hub injected (standalone mount) ⇒ the card is not rendered", () => {
    const w = mountSettings();
    expect(w.find(".settings-model-picker").exists()).toBe(false);
  });

  it("spawn.v1 WITHOUT spawn.model.v1 (old hub) ⇒ disabled trigger + upgrade hint; nothing hits the wire", async () => {
    const f = fakeHub({ caps: [CAP], prefs: { defaultModel: null } });
    const w = mountWithHub(f);
    await flushPromises();
    const trigger = triggerOf(w);
    expect(trigger.exists()).toBe(true);
    expect(trigger.attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("/webhub restart"); // defaultModelUnsupported
    expect(f.calls.refresh).toBe(0); // refreshPrefs gated on the model cap
    await trigger.trigger("click");
    await trigger.trigger("keydown", { key: "Enter" });
    await flush();
    expect(desktopPanel()).toBeNull();
    expect(document.body.querySelector(".picker-sheet")).toBeNull();
    expect(f.calls.set).toEqual([]);
  });

  it("spawn.model.v1 ⇒ refreshPrefs on mount; unset pref ⇒ trigger reads Follow pi default", async () => {
    const f = fakeHub({ caps: [CAP, MODEL_CAP], prefs: { defaultModel: null } });
    const w = mountWithHub(f);
    await flushPromises();
    expect(f.calls.refresh).toBe(1);
    const trigger = triggerOf(w);
    expect(trigger.text()).toContain("Follow pi default");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(trigger.attributes("aria-haspopup")).toBe("listbox");
    expect(trigger.attributes("aria-label")).toBe("Default model for new sessions");
  });

  it("saved pref ⇒ trigger shows the short label with the full ref title; a prefs echo updates it live", async () => {
    const agents = new Map([["A", agentWithModels([{ provider: "anthropic", id: "claude-opus-4-5-20250929" }])]]);
    const f = fakeHub({
      caps: [CAP, MODEL_CAP],
      agents,
      listPrefs: { defaultModel: "anthropic/claude-opus-4-5-20250929" },
    });
    const w = mountWithHub(f);
    await flushPromises();
    const trigger = triggerOf(w);
    expect(trigger.text()).toContain("claude-opus-4-5"); // shortModelLabel strips -YYYYMMDD
    expect(trigger.text()).not.toContain("20250929");
    expect(trigger.attributes("title")).toBe("anthropic/claude-opus-4-5-20250929"); // listed ⇒ no marker
    expect(trigger.find("use").attributes("href")).toBe("#i-cpu");
    // select-only: no free-text surface anywhere in the card
    expect(w.find("input[type='text']").exists()).toBe(false);
    // a later prefs arrival (another tab's save) moves the trigger — no edit latch any more
    f.prefs.value = { defaultModel: "openai/gpt-5" };
    await flushPromises();
    expect(triggerOf(w).text()).toContain("gpt-5");
  });

  it("open panel: Teleport'd to <body>, 「跟随 pi 默认」 first, provider groups, current row checked", async () => {
    const agents = new Map([
      ["A", agentWithModels([{ provider: "openai", id: "gpt-5", name: "GPT-5" }])],
      ["B", agentWithModels([{ provider: "zai", id: "glm-5" }])],
    ]);
    const f = fakeHub({ caps: [CAP, MODEL_CAP], agents, prefs: { defaultModel: "zai/glm-5" } });
    const w = mountWithHub(f);
    await flushPromises();
    const trigger = triggerOf(w);
    await trigger.trigger("click");
    await flush();
    const panel = desktopPanel();
    expect(panel).not.toBeNull();
    expect(panel!.closest(".settings-card")).toBeNull(); // Teleport'd OUT of the settings panel
    expect(panel!.getAttribute("role")).toBe("dialog");
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(trigger.attributes("aria-controls")).toBe(panel!.id);
    const list = panel!.querySelector("ul.model-list");
    expect(list?.getAttribute("role")).toBe("listbox");
    const groups = [...panel!.querySelectorAll(".model-group")].map((g) => g.textContent);
    expect(groups).toEqual(["openai", "zai"]); // groupByProvider, first-seen order
    const rows = panelRows();
    expect(rows).toHaveLength(3); // follow-pi + 2 models
    expect(rows[0]!.textContent).toContain("Follow pi default");
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(rows[2]!.textContent).toContain("glm-5");
    expect(rows[1]!.textContent).toContain("GPT-5"); // display name rides along
    // the current choice is pre-highlighted (aria-activedescendant on the search input)
    const search = panel!.querySelector<HTMLInputElement>(".model-search");
    expect(search?.getAttribute("aria-activedescendant")).toBe(rows[2]!.id);
  });

  it("select a row ⇒ setDefaultModel(provider/id) once, panel closes, focus returns, status Saved.", async () => {
    const agents = new Map([["A", agentWithModels([{ provider: "openai", id: "gpt-5" }])]]);
    const f = fakeHub({ caps: [CAP, MODEL_CAP], agents, prefs: { defaultModel: null } });
    const w = mountWithHub(f);
    await flushPromises();
    const trigger = triggerOf(w);
    await trigger.trigger("click");
    await flush();
    const row = panelRows()[1]!; // gpt-5 (0 = follow pi)
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(f.calls.set).toEqual(["openai/gpt-5"]);
    expect(desktopPanel()).toBeNull(); // closed immediately
    expect(document.activeElement).toBe(trigger.element); // focus back on the trigger
    const status = w.find(".settings-model-status");
    expect(status.attributes("role")).toBe("status");
    expect(status.text()).toBe("Saved.");
    expect(triggerOf(w).text()).toContain("gpt-5"); // prefs echo moved the trigger
  });

  it('the 「跟随 pi 默认」 row saves the "" tri-state (retired onModelUsePi semantics)', async () => {
    const agents = new Map([["A", agentWithModels([{ provider: "openai", id: "gpt-5" }])]]);
    const f = fakeHub({ caps: [CAP, MODEL_CAP], agents, prefs: { defaultModel: "openai/gpt-5" } });
    const w = mountWithHub(f);
    await flushPromises();
    await openPicker(w);
    const pi = panelRows()[0]!;
    expect(pi.getAttribute("aria-selected")).toBe("false");
    pi.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(f.calls.set).toEqual([""]);
    expect(f.prefs.value).toEqual({ defaultModel: null });
    expect(triggerOf(w).text()).toContain("Follow pi default");
  });

  it("picking the CURRENT row just closes — no redundant save", async () => {
    const agents = new Map([["A", agentWithModels([{ provider: "openai", id: "gpt-5" }])]]);
    const f = fakeHub({ caps: [CAP, MODEL_CAP], agents, prefs: { defaultModel: "openai/gpt-5" } });
    const w = mountWithHub(f);
    await flushPromises();
    await openPicker(w);
    const current = panelRows()[1]!;
    expect(current.getAttribute("aria-selected")).toBe("true");
    current.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(f.calls.set).toEqual([]);
    expect(desktopPanel()).toBeNull();
  });

  it("saved value NOT in the list ⇒ trigger keeps it with the muted marker; no row checked; a pick replaces it", async () => {
    const agents = new Map([["A", agentWithModels([{ provider: "openai", id: "gpt-5" }])]]);
    const f = fakeHub({ caps: [CAP, MODEL_CAP], agents, prefs: { defaultModel: "ghost/model-9" } });
    const w = mountWithHub(f);
    await flushPromises();
    const trigger = triggerOf(w);
    expect(trigger.text()).toContain("model-9"); // never silently cleared
    expect(trigger.find(".model-chip-marker").text()).toBe("not in list");
    expect(trigger.attributes("title")).toContain("ghost/model-9");
    await openPicker(w);
    expect(panelRows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false"]);
    panelRows()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(f.calls.set).toEqual(["openai/gpt-5"]);
    expect(triggerOf(w).find(".model-chip-marker").exists()).toBe(false); // marker gone after replace
  });

  it("no options at all ⇒ explanatory empty state; a stray saved value still yields to 「跟随 pi 默认」", async () => {
    const f = fakeHub({ caps: [CAP, MODEL_CAP], prefs: { defaultModel: "ghost/model-9" } });
    const w = mountWithHub(f);
    await flushPromises();
    await openPicker(w);
    const empty = desktopPanel()!.querySelector(".model-empty");
    expect(empty?.textContent).toContain("No model list yet");
    const rows = panelRows();
    expect(rows).toHaveLength(1); // the follow-pi row survives the empty list
    rows[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(f.calls.set).toEqual([""]);
  });

  it("search filters rows (provider/id/name) and is NEVER a save path — bare Enter does nothing", async () => {
    const agents = new Map([
      ["A", agentWithModels([{ provider: "openai", id: "gpt-5", name: "GPT-5" }])],
      ["B", agentWithModels([{ provider: "zai", id: "glm-5" }])],
    ]);
    const f = fakeHub({
      caps: [CAP, MODEL_CAP],
      agents,
      prefs: { defaultModel: "ghost/model-9" }, // not in list ⇒ nothing highlighted on open
    });
    const w = mountWithHub(f);
    await flushPromises();
    await openPicker(w);
    const panel = desktopPanel()!;
    const search = panel.querySelector<HTMLInputElement>(".model-search")!;
    search.value = "gpt";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    expect(panelRows().map((r) => r.querySelector(".row-id, .row-label")?.textContent ?? "")).toEqual([
      "Follow pi default",
      "gpt-5",
    ]); // filtered to one
    // nothing highlighted + Enter ⇒ a strict no-op (Enter must never clear the default)
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushPromises();
    expect(f.calls.set).toEqual([]);
    expect(desktopPanel()).not.toBeNull();
    // typing junk matches nothing ⇒ the no-match note (switcher's key), still no save
    search.value = "nothing-matches";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    expect(desktopPanel()!.querySelector(".model-empty")?.textContent).toBe("No matching model");
    expect(f.calls.set).toEqual([]);
  });

  it("save failure ⇒ failed status; the trigger keeps the previous value (prefs unchanged)", async () => {
    const agents = new Map([["A", agentWithModels([{ provider: "openai", id: "gpt-5" }])]]);
    const f = fakeHub({
      caps: [CAP, MODEL_CAP],
      agents,
      prefs: { defaultModel: "openai/gpt-5" },
      saveImpl: async () => ({ ok: false as const, error: "E_LAUNCHER" }),
    });
    const w = mountWithHub(f);
    await flushPromises();
    await openPicker(w);
    panelRows()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); // follow pi
    await flushPromises();
    expect(w.find(".settings-model-status").text()).toContain("Save failed");
    expect(triggerOf(w).text()).toContain("gpt-5"); // prefs never moved
  });

  it("saving state ⇒ the trigger shows the loader and rows are inert", async () => {
    const agents = new Map([["A", agentWithModels([{ provider: "openai", id: "gpt-5" }])]]);
    let release: (() => void) | undefined;
    const f = fakeHub({
      caps: [CAP, MODEL_CAP],
      agents,
      prefs: { defaultModel: "openai/gpt-5" },
      saveImpl: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true as const, prefs: { defaultModel: null } });
        }),
    });
    const w = mountWithHub(f);
    await flushPromises();
    await openPicker(w);
    panelRows()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(triggerOf(w).find(".model-spin").exists()).toBe(true); // loader replaces the chevron
    // reopen mid-save: every row is aria-disabled and clicks are inert
    await openPicker(w);
    const rows = panelRows();
    expect(rows.every((r) => r.getAttribute("aria-disabled") === "true")).toBe(true);
    rows[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(f.calls.set).toEqual([""]);
    release!();
    await flushPromises();
    expect(w.find(".settings-model-status").text()).toBe("Saved.");
  });

  it("keyboard: Enter opens (focus → search), ↓ moves aria-activedescendant, Enter picks, Esc refocuses the trigger", async () => {
    const agents = new Map([
      ["A", agentWithModels([{ provider: "openai", id: "gpt-5" }])],
      ["B", agentWithModels([{ provider: "zai", id: "glm-5" }])],
    ]);
    const f = fakeHub({ caps: [CAP, MODEL_CAP], agents, prefs: { defaultModel: null } });
    const w = mountWithHub(f);
    await flushPromises();
    const trigger = triggerOf(w);
    (trigger.element as HTMLButtonElement).focus();
    await trigger.trigger("keydown", { key: "Enter" });
    await flush();
    const panel = desktopPanel();
    expect(panel).not.toBeNull();
    const search = panel!.querySelector<HTMLInputElement>(".model-search")!;
    expect(document.activeElement).toBe(search); // focus moved INTO the panel
    // open (value "") pre-highlights the follow-pi row; ↓ lands on gpt-5
    expect(search.getAttribute("aria-activedescendant")).toBe(panelRows()[0]!.id);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flushPromises();
    const gpt = panelRows()[1]!;
    expect(search.getAttribute("aria-activedescendant")).toBe(gpt.id);
    expect(gpt.classList.contains("active")).toBe(true);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushPromises();
    expect(f.calls.set).toEqual(["openai/gpt-5"]);
    expect(desktopPanel()).toBeNull();
    // reopen, then Esc from the search box closes and returns focus to the trigger
    await trigger.trigger("click");
    await flush();
    desktopPanel()!
      .querySelector<HTMLInputElement>(".model-search")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(desktopPanel()).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
  });

  it("outside click closes the desktop panel without touching the wire", async () => {
    const f = fakeHub({ caps: [CAP, MODEL_CAP], prefs: { defaultModel: null } });
    const w = mountWithHub(f);
    await flushPromises();
    await openPicker(w);
    expect(desktopPanel()).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(desktopPanel()).toBeNull();
    expect(f.calls.set).toEqual([]);
  });

  it("datalist-era D7 cache: online agents write pwh_spawn_models_cache; a later no-agent mount falls back to it", async () => {
    const agents = new Map([
      ["A", agentWithModels([{ provider: "openai", id: "gpt-5" }])],
      [
        "B",
        agentWithModels([
          { provider: "openai", id: "gpt-5" },
          { provider: "zai", id: "glm-5" },
        ]),
      ],
    ]);
    const first = mountWithHub(fakeHub({ caps: [CAP, MODEL_CAP], agents, prefs: { defaultModel: null } }));
    await flushPromises();
    const cache = window.localStorage.getItem("pwh_spawn_models_cache");
    expect(cache).not.toBeNull();
    expect(JSON.parse(cache!)).toEqual([
      { provider: "openai", id: "gpt-5" },
      { provider: "zai", id: "glm-5" },
    ]); // deduped union
    first.unmount();

    const second = mountWithHub(fakeHub({ caps: [CAP, MODEL_CAP], prefs: { defaultModel: null } }));
    await flushPromises();
    await openPicker(second);
    expect(panelRows().map((r) => r.querySelector(".row-id, .row-label")?.textContent ?? "")).toEqual([
      "Follow pi default",
      "gpt-5",
      "glm-5",
    ]);
  });

  // --- form factor: ≤640px PickerSheet vs >640px Teleport'd fixed panel (switcher parity) ----

  let origMatchMedia: typeof window.matchMedia | undefined;
  afterEach(() => {
    if (origMatchMedia !== undefined) {
      window.matchMedia = origMatchMedia;
      origMatchMedia = undefined;
    }
  });

  function stubNarrow(matches: boolean): void {
    if (origMatchMedia === undefined) origMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  it("≤640px: opens as a Teleport'd PickerSheet — search NOT autofocused, listbox is; scrim click closes", async () => {
    stubNarrow(true);
    const f = fakeHub({ caps: [CAP, MODEL_CAP], prefs: { defaultModel: null } });
    const w = mountWithHub(f);
    await flushPromises();
    const trigger = triggerOf(w);
    (trigger.element as HTMLButtonElement).focus();
    await trigger.trigger("click");
    await flush();
    const sheet = document.body.querySelector<HTMLElement>(".picker-sheet");
    expect(sheet).not.toBeNull(); // nested Teleport lands in <body> alongside PickerSheet's own
    expect(desktopPanel()).toBeNull(); // no desktop popover
    const search = sheet!.querySelector<HTMLInputElement>(".model-search");
    expect(document.activeElement).not.toBe(search); // keyboard stays down
    expect(document.activeElement).toBe(sheet!.querySelector("ul.model-list")); // [data-autofocus]
    // `data-subpanel` rides PickerSheet's $attrs onto its SCRIM (inheritAttrs: false) — the
    // marker SettingsOverlay's outside-click/Esc guards look for
    expect(document.body.querySelector(".picker-scrim[data-subpanel]")).not.toBeNull();
    document.body
      .querySelector<HTMLElement>(".picker-scrim")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.body.querySelector(".picker-sheet")).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
  });

  it("≤640px: picking a row inside the sheet still saves", async () => {
    stubNarrow(true);
    const agents = new Map([["A", agentWithModels([{ provider: "zai", id: "glm-5" }])]]);
    const f = fakeHub({ caps: [CAP, MODEL_CAP], agents, prefs: { defaultModel: null } });
    const w = mountWithHub(f);
    await flushPromises();
    await triggerOf(w).trigger("click");
    await flush();
    const rows = panelRows();
    expect(rows).toHaveLength(2);
    rows[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(f.calls.set).toEqual(["zai/glm-5"]);
    expect(document.body.querySelector(".picker-sheet")).toBeNull();
  });

  // --- desktop fixed-panel anchoring (Teleport'd + fixed — the switcher's clamp math, ported) -

  function rectOf(left: number, top: number, right: number, bottom: number): DOMRect {
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  it("desktop panel anchors above the trigger, clamped into the viewport; flips below near the top", async () => {
    vi.stubGlobal("innerWidth", 1200);
    vi.stubGlobal("innerHeight", 800);
    let chipR = rectOf(100, 500, 260, 528);
    let panelR = rectOf(100, 20, 660, 500); // 560×480
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("model-chip")) return chipR;
      if (this.classList.contains("model-panel")) return panelR;
      return rectOf(0, 0, 0, 0);
    });
    try {
      const f = fakeHub({ caps: [CAP, MODEL_CAP], prefs: { defaultModel: null } });
      const w = mountWithHub(f);
      await flushPromises();
      // chip low on screen: fits above (486 ≥ 480) ⇒ anchored above, left aligned to the chip
      await openPicker(w);
      const panel = desktopPanel()!;
      expect(panel.style.bottom).toBe("306px"); // 800 - 500 + 6
      expect(panel.style.top).toBe("");
      expect(panel.style.left).toBe("100px");
      expect(panel.style.maxHeight).toBe("480px");
      // near the top of a short page: above (46) < below (698) ⇒ flips below the chip
      await triggerOf(w).trigger("click"); // close
      await flush();
      chipR = rectOf(100, 60, 260, 88);
      panelR = rectOf(100, 94, 660, 574);
      await openPicker(w);
      expect(desktopPanel()!.style.top).toBe("94px"); // 88 + 6
      expect(desktopPanel()!.style.bottom).toBe("");
      await triggerOf(w).trigger("click"); // close
      await flush();
      // chip near the right edge: shifted back inside [margin, innerWidth - margin]
      chipR = rectOf(900, 500, 1060, 528);
      await openPicker(w);
      expect(desktopPanel()!.style.left).toBe("632px"); // 1200 - 8 - 560
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("crossing the 640px boundary while open swaps sheet ⇄ fixed panel (switcher parity)", async () => {
    const mqListeners: Array<() => void> = [];
    const mq = {
      matches: false,
      media: "(max-width: 640px)",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_t: string, fn: () => void) => {
        mqListeners.push(fn);
      },
      removeEventListener: (_t: string, fn: () => void) => {
        const i = mqListeners.indexOf(fn);
        if (i >= 0) mqListeners.splice(i, 1);
      },
      dispatchEvent: () => false,
    };
    const origMq = window.matchMedia;
    window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
    try {
      const f = fakeHub({ caps: [CAP, MODEL_CAP], prefs: { defaultModel: null } });
      const w = mountWithHub(f);
      await flushPromises();
      await openPicker(w);
      expect(desktopPanel()).not.toBeNull();

      mq.matches = true;
      for (const fn of [...mqListeners]) fn();
      await flush();
      expect(desktopPanel()).toBeNull();
      expect(document.body.querySelector(".picker-sheet")).not.toBeNull();

      mq.matches = false;
      for (const fn of [...mqListeners]) fn();
      await flush();
      expect(desktopPanel()).not.toBeNull();
      expect(document.body.querySelector(".picker-sheet")).toBeNull();
    } finally {
      window.matchMedia = origMq;
    }
  });
});
