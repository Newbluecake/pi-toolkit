// @vitest-environment happy-dom
/**
 * web-hub-version plan §5.2/§5.3 (V2, §R1 #11): VersionHost's lazy-chunk DEGRADATIONS.
 *
 * vitest's module-mock factory settles exactly once per file (a rejected factory poisons every
 * later import of the mocked path with a resolved-but-falsy module), so this file keeps the
 * mocked loader PERMANENTLY PENDING and exercises the 8s `defineAsyncComponent` timeout —
 * with a §4-proven-stale handle, so the error component's 「页面已过期」 branch is what renders.
 * The rejection path lives in `version-panel-lazy-reject.test.ts` (its own file/factory).
 *
 * `VersionLoadError` itself is a first-screen component — both branches + the retry emit are
 * pinned here with plain direct mounts (no async machinery involved).
 */
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import VersionHost from "../../../src/web-hub/ui/src/components/shell/VersionHost.vue";
import VersionLoadError from "../../../src/web-hub/ui/src/components/shell/VersionLoadError.vue";
import { VERSION_CTX, type VersionInfoHandle } from "../../../src/web-hub/ui/src/composables/useVersionInfo.js";

vi.mock("../../../src/web-hub/ui/src/components/shell/VersionPanel.vue", () => new Promise(() => {}));

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
function m<T>(wrapper: T): T {
  mounted.push(wrapper as unknown as ReturnType<typeof mount>);
  return wrapper;
}
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

describe("VersionHost lazy chunk: hanging loader + 8s timeout", () => {
  it("shows the errorComponent only after the timeout, in the 已过期 branch when §4 proved tab-stale", async () => {
    vi.useFakeTimers();
    const wrapper = m(
      mount(VersionHost, {
        props: { embedded: true },
        global: { provide: { [VERSION_CTX as symbol]: fakeHandle(true) } },
        attachTo: document.body,
      }),
    );
    await flushPromises(); // loader invoked; the mocked promise never settles
    expect(wrapper.find(".version-load-error").exists()).toBe(false); // not before the timeout
    await vi.advanceTimersByTimeAsync(7999);
    expect(wrapper.find(".version-load-error").exists()).toBe(false); // still inside the budget
    await vi.advanceTimersByTimeAsync(1);
    const err = wrapper.get(".version-load-error");
    expect(err.text()).toContain("outdated");
    expect(err.text()).toContain("Refresh");
    expect(err.text()).not.toContain("Failed to load the version panel.");
  });
});

describe("VersionLoadError (first-screen error component, direct mounts)", () => {
  it("stale=true ⇒ 「页面已过期」+ Refresh (a real reload button), no retry wording", () => {
    const wrapper = m(mount(VersionLoadError, { props: { stale: true } }));
    expect(wrapper.text()).toContain("outdated");
    expect(wrapper.text()).not.toContain("Failed to load the version panel.");
    const buttons = wrapper.findAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.text()).toContain("Refresh");
    expect(wrapper.emitted("retry")).toBeUndefined();
  });

  it("stale=false ⇒ 「面板加载失败」+ Retry — never claims the page is outdated", async () => {
    const wrapper = m(mount(VersionLoadError, { props: { stale: false } }));
    expect(wrapper.text()).toContain("Failed to load the version panel.");
    expect(wrapper.text()).not.toContain("outdated");
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
  });

  it("default stale is falsy (omitted prop) — the safe, non-claiming branch", () => {
    const wrapper = m(mount(VersionLoadError));
    expect(wrapper.text()).toContain("Failed to load the version panel.");
  });
});
