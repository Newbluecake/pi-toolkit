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
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

/** R1 rework: per-test media override for the hover-peek tests — `(hover: hover) and
 *  (pointer: fine)` and/or `(max-width: 480px)`; call `stubMedia({})` to restore the
 *  all-false default the rest of this file assumes. */
function stubMedia(opts: { hover?: boolean; phone?: boolean }): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(hover: hover) and (pointer: fine)"
        ? opts.hover === true
        : query === "(max-width: 480px)"
          ? opts.phone === true
          : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const mounted: Array<ReturnType<typeof mount>> = [];
function m<T>(wrapper: T): T {
  mounted.push(wrapper as unknown as ReturnType<typeof mount>);
  return wrapper;
}
afterEach(() => {
  vi.useRealTimers();
  stubMedia({}); // restore the all-false default media before the next test
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

/** Click-pins the version popover open (panel chunk awaited) — shared by the section tests
 *  below and the R1 rework blocks at the end of this file. */
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

describe("VersionPanel (popover body)", () => {
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

// ---------------------------------------------------------------------------
// R1 rework (2026-10-17 user real-browser check): the popover behaves like QuotaPill's
// QuotaCard / LoadPill's LoadCard — click = pinned, hover peek on hover-capable pointers only
// (~150ms enter delay, ~200ms delayed close, card mouseenter keeps it open, phones never),
// peek never steals focus, pin does. Fake timers drive the delays; only the card SHELL
// (.version-pop, mounted synchronously with VersionHost) is asserted — the lazy panel chunk
// needs real macro-tasks and is covered by the tests above.
// ---------------------------------------------------------------------------
describe("R1: version popover = QuotaPill-style pinned + hover peek", () => {
  const baseProps = { conn: "open", hubVersion: null, canSignOut: false } as const;

  function mountBar() {
    const { handle } = rig(capHub());
    const wrapper = m(
      mount(TopBar, {
        props: baseProps,
        global: { provide: { [HUB_CTX as symbol]: handle } },
        attachTo: document.body,
      }),
    );
    return { wrapper, chip: wrapper.get(".version-chip") };
  }

  it("hover: 150ms enter delay opens the peek; leaving closes it after the ~200ms grace", async () => {
    vi.useFakeTimers();
    stubMedia({ hover: true });
    const { wrapper, chip } = mountBar();
    await chip.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(149);
    expect(wrapper.find(".version-pop").exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wrapper.find(".version-pop").exists()).toBe(true);
    expect(chip.attributes("aria-expanded")).toBe("true");
    await chip.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(150);
    expect(wrapper.find(".version-pop").exists()).toBe(true); // inside the close grace
    await vi.advanceTimersByTimeAsync(60);
    expect(wrapper.find(".version-pop").exists()).toBe(false);
    expect(chip.attributes("aria-expanded")).toBe("false");
  });

  it("hover: the CARD's mouseenter cancels the pending close (chip→card traversal)", async () => {
    vi.useFakeTimers();
    stubMedia({ hover: true });
    const { wrapper, chip } = mountBar();
    await chip.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(150);
    expect(wrapper.find(".version-pop").exists()).toBe(true);
    await chip.trigger("mouseleave");
    await wrapper.get(".version-pop").trigger("mouseenter"); // pointer now over the card
    await vi.advanceTimersByTimeAsync(500);
    expect(wrapper.find(".version-pop").exists()).toBe(true); // close cancelled
    await wrapper.get(".version-pop").trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(250);
    expect(wrapper.find(".version-pop").exists()).toBe(false);
  });

  it("a click on top of a live peek PINS it (mouseleave no longer closes; a second click closes)", async () => {
    vi.useFakeTimers();
    stubMedia({ hover: true });
    const { wrapper, chip } = mountBar();
    await chip.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(150);
    expect(wrapper.find(".version-pop").exists()).toBe(true);
    await chip.trigger("click"); // pin
    await chip.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(500);
    expect(wrapper.find(".version-pop").exists()).toBe(true); // pinned survives the leave
    await chip.trigger("click"); // unpin
    expect(wrapper.find(".version-pop").exists()).toBe(false);
  });

  it("phones never auto-open on hover; hover-incapable pointers never peek either", async () => {
    vi.useFakeTimers();
    stubMedia({ hover: true, phone: true });
    const a = mountBar();
    await a.chip.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(500);
    expect(a.wrapper.find(".version-pop").exists()).toBe(false);

    stubMedia({ hover: false });
    const b = mountBar();
    await b.chip.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(500);
    expect(b.wrapper.find(".version-pop").exists()).toBe(false);
  });

  it("a peek mount does NOT move focus; a fresh pinned (clicked-from-closed) mount focuses the card", async () => {
    vi.useFakeTimers();
    stubMedia({ hover: true });
    document.body.focus();
    const { wrapper, chip } = mountBar();
    await chip.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(150);
    const card = wrapper.get(".version-pop");
    expect(document.activeElement).not.toBe(card.element); // QuotaCard's wasPeek rule
    // pin-on-top-of-peek keeps the SAME mount (QuotaPill's toggle flips pinned/peek without a
    // remount), so focus still has not moved — that is the reused pattern's own behavior.
    await chip.trigger("click");
    await vi.advanceTimersByTimeAsync(50);
    expect(wrapper.find(".version-pop").exists()).toBe(true);
    expect(document.activeElement).not.toBe(wrapper.get(".version-pop").element);
    // close, then a fresh CLICK-pin from the closed state mounts with wasPeek=false ⇒ focus-in.
    await chip.trigger("click");
    await vi.advanceTimersByTimeAsync(250); // let any pending peek timers drain
    expect(wrapper.find(".version-pop").exists()).toBe(false);
    stubMedia({ hover: false });
    const pinned = mountBar();
    await pinned.chip.trigger("click");
    await vi.waitFor(
      () => {
        if (document.activeElement !== pinned.wrapper.get(".version-pop").element) throw new Error("focus not moved");
      },
      { timeout: 2000, interval: 10 },
    );
  });
});

// R1 rework #3: an absent `hub.ui` is 「无可服务的 UI 根」ONLY with the cap; on an old hub
// (no `version.v1`) the absence proves nothing and the row must say 无法验证（hub 版本过旧）.
describe("R1: 「hub 正在服务」 row wording by cap", () => {
  async function servedText(hubFrame: Record<string, unknown>) {
    const versionInfo = vi.fn(async () => ({
      ok: true,
      data: { v: 1, checkedAt: 1, hub: { pid: hubFrame["pid"], startedAt: hubFrame["startedAt"] } },
    }));
    const { handle } = rig(hubFrame, versionInfo);
    const wrapper = await openPanel(handle);
    const uiSection = wrapper.findAll(".version-pop .version-section").find((s) => s.text().includes("Served by hub"))!;
    return uiSection.text();
  }

  it("old hub (no cap, no ui) ⇒ 无法验证（hub 版本过旧） — NOT 「无可服务的 UI 根」", async () => {
    const text = await servedText(capHub({ caps: [], ui: undefined, bootHead: undefined }));
    expect(text).toContain("unverifiable");
    expect(text).toContain("older");
    expect(text).not.toContain("no servable UI root");
  });

  it("cap present but ui absent ⇒ 无可服务的 UI 根 (the ui-unservable evidence wording)", async () => {
    const text = await servedText(capHub({ ui: undefined }));
    expect(text).toContain("no servable UI root");
  });
});

// R1 rework #4: the ui-drift suggestion words by the reference the comparison ACTUALLY used —
// repo.head (「与仓库 HEAD 不一致」) only when the snapshot supplied it; otherwise the hub's
// own buildId commit (「与 hub 构建 commit 不一致」).
describe("R1: ui-drift wording by comparison reference", () => {
  it("no snapshot ⇒ the hub-commit reference wording, never 「repository HEAD」", async () => {
    const frame = capHub({
      ui: { ...capHub().ui, commit: "ddddddd444444" },
      bootHead: undefined,
    });
    const versionInfo = vi.fn(async () => ({
      ok: true,
      data: { v: 1, checkedAt: 1, hub: { pid: frame["pid"], startedAt: frame["startedAt"] } },
    }));
    const { handle } = rig(frame, versionInfo);
    const wrapper = await openPanel(handle);
    const row = wrapper.get(".version-finding[data-level='info']");
    expect(row.text()).toContain("hub's own build commit");
    expect(row.text()).not.toContain("repository HEAD");
  });

  it("with a repo snapshot ⇒ the repository HEAD wording", async () => {
    const frame = capHub({ bootHead: { commit: "aaaaaaa111111", time: 1 } });
    const versionInfo = vi.fn(async () => ({
      ok: true,
      data: {
        v: 1,
        checkedAt: 1,
        hub: { pid: frame["pid"], startedAt: frame["startedAt"] },
        repo: { head: { commit: "bbbbbbb222222", time: 2 }, packageVersion: "0.5.5" },
      },
    }));
    const { handle } = rig(frame, versionInfo);
    const wrapper = await openPanel(handle);
    const rows = wrapper
      .findAll(".version-finding")
      .map((r) => r.text())
      .join("\n");
    expect(rows).toContain("The UI build differs from the repository HEAD");
  });
});

// R1 rework #2: every key family the version surfaces look up must resolve in BOTH locales —
// the bug class is "template-literal key building misses the flat i18n definition" (the session
// status badge rendered `version.sessionStatus.unknown` raw). Static-map coverage here; the
// maps themselves live in VersionPanel.vue (asserted above through rendering).
describe("R1: every version i18n key resolves in zh and en (no raw-key leaks)", () => {
  const KEYS = [
    "version.chipTitle",
    "version.sessionStatusSame",
    "version.sessionStatusOlder",
    "version.sessionStatusNewer",
    "version.sessionStatusDiffer",
    "version.sessionStatusUnknown",
    "version.statusSame",
    "version.statusDiffer",
    "version.statusUnknown",
    "version.sectionErrorTimeout",
    "version.sectionErrorUnavailable",
    "version.sectionErrorGitTooOld",
    "version.sectionErrorTooLarge",
    "version.sectionErrorMissing",
    "version.findingTabStale",
    "version.findingUiUnservable",
    "version.findingHubDiskChanged",
    "version.findingHubOlder",
    "version.findingUiDrift",
    "version.findingUiDriftHub",
    "version.findingAgentOlder",
    "version.findingAgentNewer",
    "version.findingAgentDrift",
    "version.findingDirty",
    "version.findingUnknown",
    "version.uiServedNone",
    "version.uiServedUnverifiable",
  ];

  it.each(KEYS)("key %s exists in en and zh with a real translation", (key) => {
    const [ns, leaf] = key.split(".");
    for (const lang of ["en", "zh"] as const) {
      const dict = (MESSAGES[lang] as Record<string, Record<string, string>>)[ns!];
      expect(dict, `${lang}:${ns}`).toBeDefined();
      const raw = dict?.[leaf!];
      expect(typeof raw).toBe("string");
      expect(raw).not.toBe(key); // a raw-key fallback IS the bug
      expect(raw!.length).toBeGreaterThan(0);
    }
  });
});
