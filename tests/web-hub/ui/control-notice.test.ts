// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ControlNotice from "../../../src/web-hub/ui/src/components/control/ControlNotice.vue";
import { CONTROL_ENV, type ControlEnv } from "../../../src/web-hub/ui/src/components/control/controlContext.js";

/**
 * `control/ControlNotice.vue` (control-plan.md v2.1 §7.4/§7.6 — C5, 2026 "全部可关" revision):
 * the persistent risk notice is collapsible AND dismissible in every variant. `local`/`https`
 * remember the dismissal across sessions (localStorage); `plainHttp` — the highest-risk variant
 * — only remembers it for the current browser session (sessionStorage), so a fresh session sees
 * it again.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

function mountNotice(props: { plaintext?: boolean; mode?: "token" | "password" } = {}, env?: ControlEnv) {
  const wrapper = mount(ControlNotice, {
    props,
    global: { provide: env ? { [CONTROL_ENV as symbol]: env } : {} },
  });
  mounted.push(wrapper);
  return wrapper;
}

function fakeEnv(over: Partial<ControlEnv> = {}): ControlEnv {
  return { authMode: "token", plaintext: false, dialogDrafts: new Map(), noticeExpanded: ref(false), ...over };
}

describe("ControlNotice.vue (§7.6)", () => {
  it("is collapsible via summary and has a dismiss (×) button in every variant", () => {
    const w = mountNotice();
    expect(w.find(".control-notice summary").exists()).toBe(true);
    expect(w.find(".control-notice .notice-dismiss").exists()).toBe(true);
  });

  it("variant selection: token ⇒ local; password+plaintext ⇒ plainHttp; password+https ⇒ https", () => {
    expect(mountNotice({ mode: "token" }).find(".notice-body").text()).toContain("this computer's");
    expect(mountNotice({ mode: "password", plaintext: true }).find(".notice-body").text()).toContain("plain HTTP");
    expect(mountNotice({ mode: "password", plaintext: false }).find(".notice-body").text()).toContain("host machine");
  });

  it("props win over the injected env; env fills in when props are absent", () => {
    const env = fakeEnv({ authMode: "password", plaintext: true });
    expect(mountNotice({}, env).find(".notice-body").text()).toContain("plain HTTP");
    expect(mountNotice({ plaintext: false }, env).find(".notice-body").text()).toContain("host machine");
  });

  it("expanded state is shared through CONTROL_ENV (the TopBar chip opens the same notice)", async () => {
    const env = fakeEnv();
    const w = mountNotice({}, env);
    expect(w.find(".control-notice").attributes("open")).toBeUndefined();
    env.noticeExpanded.value = true;
    await w.vm.$nextTick();
    expect(w.find(".control-notice").attributes("open")).toBeDefined();
  });

  it("clicking dismiss removes the notice without toggling the details open/closed", async () => {
    const w = mountNotice({ mode: "token" });
    expect(w.find(".control-notice").exists()).toBe(true);
    await w.find(".notice-dismiss").trigger("click");
    expect(w.find(".control-notice").exists()).toBe(false);
  });

  it("local/https dismissal persists across remounts via localStorage, keyed by variant", async () => {
    const w1 = mountNotice({ mode: "token" }); // ⇒ local
    await w1.find(".notice-dismiss").trigger("click");
    expect(localStorage.getItem("webhub.controlNotice.dismissed.local")).toBe("1");

    const w2 = mountNotice({ mode: "token" });
    expect(w2.find(".control-notice").exists()).toBe(false); // stays dismissed on a fresh mount

    // a DIFFERENT variant (https) is unaffected — distinct storage key
    const w3 = mountNotice({ mode: "password", plaintext: false });
    expect(w3.find(".control-notice").exists()).toBe(true);
  });

  it("plainHttp dismissal only persists in sessionStorage, not localStorage", async () => {
    const w1 = mountNotice({ mode: "password", plaintext: true });
    await w1.find(".notice-dismiss").trigger("click");
    expect(sessionStorage.getItem("webhub.controlNotice.dismissed.plainHttp")).toBe("1");
    expect(localStorage.getItem("webhub.controlNotice.dismissed.plainHttp")).toBeNull();

    // within the same (simulated) browser session, the dismissal still holds on remount
    const w2 = mountNotice({ mode: "password", plaintext: true });
    expect(w2.find(".control-notice").exists()).toBe(false);

    // a fresh session (sessionStorage cleared) sees the warning again
    sessionStorage.clear();
    const w3 = mountNotice({ mode: "password", plaintext: true });
    expect(w3.find(".control-notice").exists()).toBe(true);
  });
});
