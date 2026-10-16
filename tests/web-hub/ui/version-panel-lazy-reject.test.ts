// @vitest-environment happy-dom
/**
 * web-hub-version plan §5.3 (V2): the REJECTED-loader branch of `VersionHost`'s lazy chunk —
 * stale NOT proven ⇒ 「面板加载失败」+ retry, never 「页面已过期」(§8.9's 断网 case).
 *
 * Its own file (separate from `version-panel-lazy.test.ts`): the vi.mock factory settles once
 * per file and a rejection poisons every later import of the mocked path, so exactly one
 * settlement — one rejecting test — lives here.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import VersionHost from "../../../src/web-hub/ui/src/components/shell/VersionHost.vue";
import { VERSION_CTX, type VersionInfoHandle } from "../../../src/web-hub/ui/src/composables/useVersionInfo.js";

const ctl = vi.hoisted(() => ({
  reject: null as null | ((e: unknown) => void),
}));

vi.mock("../../../src/web-hub/ui/src/components/shell/VersionPanel.vue", () => {
  return new Promise((_res, rej) => {
    ctl.reject = rej;
  });
});

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

function fakeHandle(tabStale: boolean): VersionInfoHandle {
  return {
    phase: ref("idle"),
    snapshot: ref(undefined),
    match: ref({ tabStale, findings: [], dot: null, dirty: false }) as never,
    refresh: vi.fn(),
    dispose: () => {},
  };
}

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});

describe("VersionHost lazy chunk: rejected loader, stale unproven", () => {
  it("shows 「面板加载失败」+ Retry — NOT 「页面已过期」(no staleness claim without §4 proof); retry click keeps the host alive", async () => {
    const wrapper = mount(VersionHost, {
      props: { embedded: true },
      global: { provide: { [VERSION_CTX as symbol]: fakeHandle(false) } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    ctl.reject?.(new Error("Failed to fetch dynamically imported module"));
    await flushPromises();
    const err = wrapper.get(".version-load-error");
    expect(err.text()).toContain("Failed to load the version panel.");
    expect(err.text()).not.toContain("outdated");
    expect(err.text()).toContain("Retry");
    // the retry path: key bump + a fresh loader attempt (the already-poisoned mock resolves
    // falsy, so the error view goes blank rather than claiming anything) — the point here is
    // that the click is wired, emits, and never throws.
    await err.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.find(".version-embedded").exists()).toBe(true);
  });
});
