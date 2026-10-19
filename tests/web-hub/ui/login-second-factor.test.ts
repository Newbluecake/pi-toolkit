// @vitest-environment happy-dom
/**
 * `LoginSecondFactor.vue` (LAN security r2 §5.9, package G — approved preview variant B,
 * `~/pwh-preview/lan-security.html` §2B): one primary method + 「其他方式」 links, only the
 * challenge's own methods offered, Feishu only when its card was actually sent. Terminal
 * states (expired / attempts-exhausted) derive from the frozen props (`challenge.expiresAt`
 * vs the `now` prop, `attemptsLeft === 0`); method lock rides `lockedUntil`. i18n parity for
 * the new `login.2fa.*` keys is asserted against `MESSAGES` directly (the global
 * `i18n-parity.test.ts` covers every namespace mechanically; this pins G's own keys).
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import LoginSecondFactor from "../../../src/web-hub/ui/src/components/shell/LoginSecondFactor.vue";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";
import type { Lan2faChallenge } from "../../../src/web-hub/protocol/lan-2fa.js";

const T0 = 1_700_000_000_000;

function challenge(over: Partial<Lan2faChallenge> = {}): Lan2faChallenge {
  return { error: "E_2FA", methods: ["totp", "feishu", "recovery"], feishu: "sent", expiresAt: T0 + 300_000, ...over };
}

function baseProps(over: Record<string, unknown> = {}) {
  return { challenge: challenge(), busy: false, now: T0, ...over };
}

function linkButtons(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll(".tfa-links .tfa-link-btn").map((b) => b.text());
}

describe("LoginSecondFactor.vue (lan-security r2 §5.9, variant B)", () => {
  it("defaults to the authenticator-app panel with a 6-digit one-time-code input and the other-method links", () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps() });
    const input = wrapper.find("input#tfa-code");
    expect(input.exists()).toBe(true);
    expect(input.attributes("inputmode")).toBe("numeric");
    expect(input.attributes("autocomplete")).toBe("one-time-code");
    expect(input.attributes("maxlength")).toBe("6");
    const links = linkButtons(wrapper);
    expect(links.some((txt) => txt.includes("Use Feishu approval instead"))).toBe(true);
    expect(links.some((txt) => txt.includes("Use a recovery code"))).toBe(true);
    expect(links.some((txt) => txt.includes("Cancel sign-in"))).toBe(true);
    expect(links.some((txt) => txt.includes("authenticator app instead"))).toBe(false); // current method is not linked
    expect(wrapper.emitted("wait")).toBeUndefined();
  });

  it("offers only the methods the challenge lists", () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps({ challenge: challenge({ methods: ["totp"] }) }) });
    const links = linkButtons(wrapper);
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("Cancel sign-in");
  });

  it("hides Feishu when the challenge says the card was not sent (feishu: unavailable)", () => {
    const wrapper = mount(LoginSecondFactor, {
      props: baseProps({ challenge: challenge({ methods: ["totp", "feishu"], feishu: "unavailable" }) }),
    });
    const links = linkButtons(wrapper);
    expect(links.some((txt) => txt.includes("Feishu"))).toBe(false);
  });

  it("uses the Feishu wait view as primary when TOTP is absent, emitting wait once on mount, with the approval countdown", async () => {
    const wrapper = mount(LoginSecondFactor, {
      props: baseProps({ challenge: challenge({ methods: ["feishu", "recovery"] }) }),
    });
    expect(wrapper.emitted("wait")).toHaveLength(1);
    expect(wrapper.text()).toContain("An approval request was sent to Feishu");
    expect(wrapper.text()).toContain("120s left to approve");
    await wrapper.setProps({ now: T0 + 30_000 });
    expect(wrapper.text()).toContain("90s left to approve");
    await wrapper.setProps({ now: T0 + 121_000 });
    expect(wrapper.text()).toContain("Approval timed out — the other methods still work");
  });

  it("switching to Feishu via the alt link emits wait; switching back shows the TOTP panel again", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps() });
    const feishuLink = wrapper.findAll(".tfa-links .tfa-link-btn").find((b) => b.text().includes("Feishu"));
    await feishuLink!.trigger("click");
    expect(wrapper.emitted("wait")).toHaveLength(1);
    expect(wrapper.text()).toContain("Waiting for Feishu approval");
    const back = wrapper.findAll(".tfa-links .tfa-link-btn").find((b) => b.text().includes("authenticator app"));
    await back!.trigger("click");
    expect(wrapper.find("input#tfa-code").exists()).toBe(true);
  });

  it("emits submit with a valid 6-digit TOTP code and clears the field", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps() });
    await wrapper.find("input#tfa-code").setValue("481027");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")).toEqual([[{ method: "totp", code: "481027" }]]);
    expect((wrapper.find("input#tfa-code").element as HTMLInputElement).value).toBe("");
  });

  it("rejects a malformed TOTP code locally — no submit emit, inline error shown", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps() });
    await wrapper.find("input#tfa-code").setValue("48x027");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();
    expect(wrapper.find(".form-error").text()).toContain("6-digit");
  });

  it("normalizes recovery codes before emitting (case, separators, Crockford aliases)", async () => {
    const wrapper = mount(LoginSecondFactor, {
      props: baseProps({ challenge: challenge({ methods: ["totp", "recovery"] }) }),
    });
    const recoveryLink = wrapper.findAll(".tfa-links .tfa-link-btn").find((b) => b.text().includes("recovery"));
    await recoveryLink!.trigger("click");
    await wrapper.find("input#tfa-code").setValue("k7m9-q2fd 4hjr");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")).toEqual([[{ method: "recovery", code: "K7M9Q2FD4HJR" }]]);
  });

  it("rejects a malformed recovery code locally", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps({ challenge: challenge({ methods: ["recovery"] }) }) });
    await wrapper.find("input#tfa-code").setValue("nope");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();
    expect(wrapper.find(".form-error").text()).toContain("12 characters");
  });

  it("shows the attempts-left error after a failed submit, gated to the method that submitted", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps() });
    await wrapper.find("input#tfa-code").setValue("481027");
    await wrapper.find("form").trigger("submit");
    await wrapper.setProps({ attemptsLeft: 3 });
    expect(wrapper.find(".form-error").text()).toContain("(3 attempts left for this sign-in)");
    // switching to another method hides the stale error; the alt row stays available
    const feishuLink = wrapper.findAll(".tfa-links .tfa-link-btn").find((b) => b.text().includes("Feishu"));
    await feishuLink!.trigger("click");
    expect(wrapper.find(".form-error").exists()).toBe(false);
  });

  it("busy disables inputs, links and shows the verifying label", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps({ busy: true }) });
    expect((wrapper.find("input#tfa-code").element as HTMLInputElement).disabled).toBe(true);
    const submit = wrapper.find('button[type="submit"]');
    expect((submit.element as HTMLButtonElement).disabled).toBe(true);
    expect(submit.text()).toContain("Verifying…");
    for (const b of wrapper.findAll(".tfa-links .tfa-link-btn")) {
      const txt = b.text();
      if (!txt.includes("Cancel")) expect((b.element as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("lockedUntil pins a per-method lock notice with a live countdown and disables that method's submit", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps() });
    await wrapper.find("input#tfa-code").setValue("481027");
    await wrapper.find("form").trigger("submit");
    await wrapper.setProps({ lockedUntil: T0 + 90_000 });
    expect(wrapper.text()).toContain("retry in 90s, or use another method");
    expect((wrapper.find('button[type="submit"]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.setProps({ now: T0 + 89_000 });
    expect(wrapper.text()).toContain("retry in 1s");
    await wrapper.setProps({ now: T0 + 90_000 });
    expect((wrapper.find('button[type="submit"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  it("now reaching challenge.expiresAt shows the expired state; 返回登录 emits cancel", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps() });
    await wrapper.setProps({ now: T0 + 300_000 });
    expect(wrapper.text()).toContain("This verification expired (over 5 minutes)");
    const back = wrapper.find('button[type="button"].btn-primary');
    await back.trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("attemptsLeft 0 shows the exhausted state instead of the form", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps({ attemptsLeft: 0 }) });
    expect(wrapper.text()).toContain("No attempts left for this sign-in");
    expect(wrapper.find("input#tfa-code").exists()).toBe(false);
  });

  it("the cancel link emits cancel", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps() });
    const cancel = wrapper.findAll(".tfa-links .tfa-link-btn").find((b) => b.text().includes("Cancel"));
    await cancel!.trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("a new challenge prop resets method, inputs and errors (parent restarted login without remounting)", async () => {
    const wrapper = mount(LoginSecondFactor, { props: baseProps({ attemptsLeft: 2 }) });
    await wrapper.find("input#tfa-code").setValue("481027");
    await wrapper.find("form").trigger("submit");
    await wrapper.setProps({ attemptsLeft: 2 });
    expect(wrapper.find(".form-error").text()).toContain("2 attempts");
    await wrapper.setProps({ challenge: challenge({ methods: ["recovery"] }), attemptsLeft: undefined });
    expect(wrapper.find(".form-error").text()).toBe("");
    expect(wrapper.text()).toContain("recovery code");
  });

  it('a challenge with no usable method (["feishu"] + card unsent) shows an honest dead-end, never a recovery panel', async () => {
    const wrapper = mount(LoginSecondFactor, {
      props: baseProps({ challenge: challenge({ methods: ["feishu"], feishu: "unavailable" }) }),
    });
    expect(wrapper.emitted("wait")).toBeUndefined(); // no card was sent — never start waiting
    expect(wrapper.find("input#tfa-code").exists()).toBe(false); // no recovery panel was offered
    expect(wrapper.find(".tfa-links").exists()).toBe(false);
    expect(wrapper.text()).toContain("No usable verification method is available for this sign-in");
    const back = wrapper.find('button[type="button"].btn-primary');
    await back.trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("the no-usable-method state renders in Chinese too (zh parity)", () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "languages");
    Object.defineProperty(window.navigator, "languages", { value: ["zh-CN"], configurable: true });
    try {
      const wrapper = mount(LoginSecondFactor, {
        props: baseProps({ challenge: challenge({ methods: ["feishu"], feishu: "unavailable" }) }),
      });
      expect(wrapper.text()).toContain("本次登录没有可用的验证方式");
      expect(wrapper.text()).toContain("返回登录");
    } finally {
      if (original) Object.defineProperty(window.navigator, "languages", original);
    }
  });

  it("renders Chinese copy when navigator.languages starts with zh-CN", () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "languages");
    Object.defineProperty(window.navigator, "languages", { value: ["zh-CN"], configurable: true });
    try {
      const wrapper = mount(LoginSecondFactor, { props: baseProps() });
      expect(wrapper.text()).toContain("验证器 App 中的 6 位验证码");
      expect(wrapper.text()).toContain("其他方式");
      expect(wrapper.text()).toContain("取消登录");
    } finally {
      if (original) Object.defineProperty(window.navigator, "languages", original);
    }
  });
});

describe("login.2fa.* i18n parity (lan-security r2 §5.9)", () => {
  it("every 2fa key exists in zh and en with identical placeholder sets", () => {
    const en = MESSAGES.en["login"]!;
    const zh = MESSAGES.zh["login"]!;
    const enKeys = Object.keys(en).filter((k) => k.startsWith("2fa."));
    expect(enKeys.length).toBeGreaterThan(20);
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of enKeys) {
      expect(zh[key], `${key} missing in zh`).toBeTypeOf("string");
      expect(params(zh[key]!)).toEqual(params(en[key]!));
    }
    for (const key of Object.keys(zh).filter((k) => k.startsWith("2fa."))) {
      expect(en[key], `${key} missing in en`).toBeTypeOf("string");
    }
  });
});
