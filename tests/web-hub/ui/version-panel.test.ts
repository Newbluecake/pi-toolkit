// @vitest-environment happy-dom
/**
 * web-hub-version plan §5.2/§5.3 (V2): the mounted surfaces — TopBar's version chip (button,
 * aria wiring, 0/1 dots on chip AND gear), the desktop popover's open/close lifecycle
 * (Esc/outside-click/focus-return, mirroring SettingsOverlay), the embedded settings-card
 * form, the cap-missing degradation (never a request, no repo/changelog hints), the rendered
 * sections incl. `<details>` collapse and the 建议 rows (refresh BUTTON for tab-stale,
 * CopyButtons otherwise), and the MarkdownView-only changelog.
 *
 * The lazy-chunk failure modes (8s timeout / rejected loader / 已过期 vs 加载失败) live in
 * `version-panel-lazy.test.ts` — they need the loader mocked, which is file-scoped in vitest.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";
import VersionHost from "../../../src/web-hub/ui/src/components/shell/VersionHost.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { VERSION_CTX } from "../../../src/web-hub/ui/src/composables/useVersionInfo.js";
import { useVersionInfo } from "../../../src/web-hub/ui/src/composables/useVersionInfo.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const mounted: Array<ReturnType<typeof mount>> = [];
function m<T>(wrapper: T): T {
  mounted.push(wrapper as unknown as ReturnType<typeof mount>);
  return wrapper;
}
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});

const ASSETS = ["/assets/index-aaaa1111.js", "/assets/style-aaaa2222.css"];

/** The lazy `import("./VersionPanel.vue")` needs several macro-tasks under vitest's
 *  transform pipeline — a single `flushPromises` is not enough. */
async function panelReady(wrapper: { find: (s: string) => { exists: () => boolean } }, sel = ".version-panel") {
  await vi.waitFor(
    () => {
      if (!wrapper.find(sel).exists()) throw new Error("panel chunk not resolved yet");
    },
    { timeout: 4000, interval: 10 },
  );
  await flushPromises();
}

function capHub(over: Record<string, unknown> = {}) {
  return {
    version: "0.5.5",
    buildId: "0.5.5@aaaaaaa111111",
    pid: 4242,
    startedAt: Date.now() - 3 * 3600 * 1000 - 12 * 60 * 1000, // "up 3h12m" band
    proto: { major: 1 },
    caps: ["version.v1"],
    ui: { source: "package", version: "0.5.5", commit: "aaaaaaa111111", builtAt: "t", assets: ASSETS },
    ...over,
  };
}

/** A snapshot whose `hub` generation MATCHES the given frame (§4's filter drops anything else). */
function wire(frame: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    v: 1,
    checkedAt: 1,
    hub: { pid: frame["pid"], startedAt: frame["startedAt"] },
    repo: {
      head: { commit: "aaaaaaa111111", time: 1 },
      packageVersion: "0.5.5",
      lastTag: "v0.5.4",
      commits: [{ commit: "aaaaaaa111111", time: 1, subject: "feat: x" }],
      commitsTotal: 1,
    },
    changelog: { sections: [{ title: "0.5.5", date: "2026-10-16", markdown: "* one entry" }] },
    ...over,
  };
}

/** A real useVersionInfo over a fake hub handle — exercises the actual wiring (cap gate,
 *  generation filter) rather than a stubbed handle. */
function rig(hubFrame: Record<string, unknown> | null, versionInfo?: (signal?: AbortSignal) => Promise<unknown>) {
  const state = ref({
    hub: hubFrame,
    conn: "open",
    selected: null,
    agents: new Map(),
  }) as unknown as { value: HubState };
  const handle = { state } as unknown as HubHandle;
  if (versionInfo !== undefined) (handle as { transport?: unknown }).transport = { versionInfo };
  const info = useVersionInfo({ hub: handle, doc: null as unknown as Document, win: null });
  return { state, handle, info };
}

describe("TopBar: version chip + dots", () => {
  const baseProps = { conn: "open", hubVersion: null, canSignOut: false } as const;

  it("the meta is a BUTTON now: aria-haspopup/expanded/controls + the ui stamp text", () => {
    const wrapper = m(mount(TopBar, { props: baseProps }));
    const chip = wrapper.get(".topbar-meta");
    expect(chip.element.tagName).toBe("BUTTON");
    expect(chip.classes()).toContain("version-chip");
    expect(chip.attributes("aria-haspopup")).toBe("dialog");
    expect(chip.attributes("aria-expanded")).toBe("false");
    expect(chip.attributes("aria-controls")).toBe("version-panel");
    expect(chip.text()).toMatch(/^ui 0\.0\.0-test@0123456 · /);
  });

  it("clean state ⇒ ZERO .version-dot nodes anywhere (chip and gear)", () => {
    const wrapper = m(mount(TopBar, { props: baseProps }));
    expect(wrapper.findAll(".version-dot")).toEqual([]);
  });

  it("ui-unservable (cap, no hub.ui) ⇒ exactly one warn dot on the chip AND one on the gear", () => {
    const { handle } = rig(capHub({ ui: undefined }));
    const wrapper = m(mount(TopBar, { props: baseProps, global: { provide: { [HUB_CTX as symbol]: handle } } }));
    const dots = wrapper.findAll(".version-dot");
    expect(dots).toHaveLength(2);
    expect(dots.every((d) => d.attributes("data-level") === "warn")).toBe(true);
    expect(wrapper.get(".version-chip .version-dot").exists()).toBe(true);
    expect(wrapper.get(".version-dot-gear").exists()).toBe(true);
  });

  it("clicking the chip opens the popover (role=dialog, aria-expanded=true); clicking again closes", async () => {
    const { handle } = rig(capHub());
    const wrapper = m(
      mount(TopBar, {
        props: baseProps,
        global: { provide: { [HUB_CTX as symbol]: handle } },
        attachTo: document.body,
      }),
    );
    const chip = wrapper.get(".version-chip");
    await chip.trigger("click");
    await panelReady(wrapper);
    expect(wrapper.get('[role="dialog"][aria-labelledby="version-panel-title"]').exists()).toBe(true);
    expect(chip.attributes("aria-expanded")).toBe("true");
    await chip.trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(chip.attributes("aria-expanded")).toBe("false");
  });

  it("Esc closes with preventDefault and returns focus to the chip (SettingsOverlay desktop contract)", async () => {
    const { handle } = rig(capHub());
    const wrapper = m(
      mount(TopBar, {
        props: baseProps,
        global: { provide: { [HUB_CTX as symbol]: handle } },
        attachTo: document.body,
      }),
    );
    const chip = wrapper.get(".version-chip");
    await chip.trigger("click");
    await panelReady(wrapper);
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    await flushPromises();
    expect(ev.defaultPrevented).toBe(true);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(chip.element);
  });

  it("outside pointerdown closes (preventDefault'd); inside the popover does NOT", async () => {
    const { handle } = rig(capHub());
    const wrapper = m(
      mount(TopBar, {
        props: baseProps,
        global: { provide: { [HUB_CTX as symbol]: handle } },
        attachTo: document.body,
      }),
    );
    await wrapper.get(".version-chip").trigger("click");
    await panelReady(wrapper);
    // inside: a section heading
    wrapper.get(".version-pop .version-h").element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    // outside
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const ev = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);
    await flushPromises();
    expect(ev.defaultPrevented).toBe(true);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    outside.remove();
  });
});

describe("VersionPanel (popover body)", () => {
  async function openPanel(handle: HubHandle) {
    const wrapper = m(
      mount(TopBar, {
        props: { conn: "open", hubVersion: null, canSignOut: false },
        global: { provide: { [HUB_CTX as symbol]: handle } },
        attachTo: document.body,
      }),
    );
    await wrapper.get(".version-chip").trigger("click");
    await panelReady(wrapper);
    return wrapper;
  }

  it("renders all six sections in order; repo/changelog are collapsed <details>; changelog rides MarkdownView", async () => {
    const frame = capHub();
    const versionInfo = vi.fn(async () => ({ ok: true, data: wire(frame) }));
    const { handle } = rig(frame, versionInfo);
    const wrapper = await openPanel(handle);
    const headings = wrapper.findAll(".version-pop .version-h").map((h) => h.text());
    for (const key of ["Suggestions", "UI", "Hub", "Current session", "Repository", "Changelog"]) {
      expect(headings.some((h) => h.includes(key))).toBe(true);
    }
    const details = wrapper.findAll(".version-pop details");
    expect(details).toHaveLength(2);
    expect(details.every((d) => (d.element as HTMLDetailsElement).open === false)).toBe(true);
    expect(wrapper.get(".version-pop .md").exists()).toBe(true); // MarkdownView root
    expect(versionInfo).toHaveBeenCalledTimes(1); // panel-open fetch (§4)
  });

  it("建议 rows: a Refresh BUTTON exists for tab-stale; other findings carry CopyButtons with the §4 commands", async () => {
    // tab-stale needs a tab fingerprint, which happy-dom's DOM cannot provide — assert the
    // copy-command path (ui-unservable ⇒ /webhub restart) and the clean state instead; the
    // refresh-button branch is pinned by VersionLoadError + lazy tests and §8.3's real-device
    // acceptance.
    const frame = capHub({ ui: undefined });
    const versionInfo = vi.fn(async () => ({ ok: true, data: wire(frame) }));
    const { handle } = rig(frame, versionInfo);
    const wrapper = await openPanel(handle);
    const row = wrapper.get(".version-finding[data-level='warn']");
    expect(row.text()).toContain("no servable UI root");
    expect(row.find("button").exists()).toBe(true); // the CopyButton affordance
    expect(row.text()).not.toContain("A refresh always loads"); // refresh advice is NOT offered

    const cleanFrame = capHub();
    const cleanInfo = vi.fn(async () => ({ ok: true, data: wire(cleanFrame) }));
    const clean = await openPanel(rig(cleanFrame, cleanInfo).handle);
    expect(clean.get(".version-ok").text()).toContain("No suggestions");
    expect(clean.find(".version-finding").exists()).toBe(false);
  });

  it("cap missing ⇒ no request EVER, sections 5/6 replaced by the one-line upgrade hint", async () => {
    const versionInfo = vi.fn();
    const { handle } = rig(capHub({ caps: [], ui: undefined, bootHead: undefined }), versionInfo);
    const wrapper = await openPanel(handle);
    expect(versionInfo).toHaveBeenCalledTimes(0);
    expect(wrapper.get(".version-pop").text()).toContain("too old");
    expect(wrapper.findAll(".version-pop details")).toHaveLength(0); // no repo/changelog UI at all
  });

  it("hub section shows version/buildId/bootHead/pid and a computed-once uptime marker (up …, English token)", async () => {
    const startedAt = Date.now() - (3 * 3600 + 12 * 60) * 1000;
    const frame = capHub({ startedAt, bootHead: { commit: "aaaaaaa111111", time: 1 } });
    const versionInfo = vi.fn(async () => ({ ok: true, data: wire(frame) }));
    const { handle } = rig(frame, versionInfo);
    const wrapper = await openPanel(handle);
    const hubSection = wrapper
      .findAll(".version-pop .version-section")
      .find((s) => s.text().includes("Hub"))!
      .text();
    expect(hubSection).toContain("0.5.5");
    expect(hubSection).toContain("0.5.5@aaaaaaa111111");
    expect(hubSection).toContain("aaaaaaa111111");
    expect(hubSection).toMatch(/up 3h 12m/);
  });

  it("dirty same-HEAD ⇒ the info row renders but no dot lights", async () => {
    const frame = capHub({ buildId: "0.5.5@aaaaaaa111111*", bootHead: undefined });
    const versionInfo = vi.fn(async () => ({ ok: true, data: wire(frame) }));
    const { handle } = rig(frame, versionInfo);
    const wrapper = await openPanel(handle);
    const rows = wrapper.findAll(".version-finding");
    expect(rows.some((r) => r.text().includes("uncommitted"))).toBe(true);
    expect(wrapper.findAll(".version-pop .version-dot")).toEqual([]);
    expect(wrapper.findAll(".version-chip .version-dot")).toEqual([]);
  });

  it("embedded mode (settings card): no dialog shell, same panel content, fetch on mount", async () => {
    const versionInfo = vi.fn(async () => ({ ok: true, data: WIRE }));
    const { info } = rig(capHub(), versionInfo);
    const wrapper = m(
      mount(VersionHost, { props: { embedded: true }, global: { provide: { [VERSION_CTX as symbol]: info } } }),
    );
    await panelReady(wrapper, ".version-embedded .version-panel");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.get(".version-embedded .version-panel").exists()).toBe(true);
    expect(versionInfo).toHaveBeenCalledTimes(1);
  });

  it("snapshot sections surface repo data (HEAD/package/tag) as plain text", async () => {
    const frame = capHub();
    const versionInfo = vi.fn(async () => ({ ok: true, data: wire(frame) }));
    const { handle } = rig(frame, versionInfo);
    const wrapper = await openPanel(handle);
    const text = wrapper.get(".version-pop").text();
    expect(text).toContain("aaaaaaa111111");
    expect(text).toContain("v0.5.4");
    // commits ride a collapsed details, plain-text rows
    const commits = wrapper.findAll(".version-pop details")[0]!;
    expect(commits.text()).toContain("feat: x");
    expect(commits.find(".md").exists()).toBe(false); // commits are NOT markdown
  });
});
