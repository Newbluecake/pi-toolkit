// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ControlNotice from "../../../src/web-hub/ui/src/components/control/ControlNotice.vue";
import { CONTROL_ENV, type ControlEnv } from "../../../src/web-hub/ui/src/components/control/controlContext.js";

/**
 * `control/ControlNotice.vue` (control-plan.md v2.1 §7.4/§7.6 — C5): the persistent risk
 * notice — collapsible to one line, NEVER closable; copy variant from auth mode + plaintext.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
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
  it("has NO close/dismiss control (persistent, ui-design §10) — collapsible via summary only", () => {
    const w = mountNotice();
    const buttons = w.findAll(".control-notice button").map((b) => b.text());
    expect(buttons.find((b) => /close|dismiss|关闭/i.test(b))).toBeUndefined();
    expect(w.find(".control-notice summary").exists()).toBe(true);
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
});
