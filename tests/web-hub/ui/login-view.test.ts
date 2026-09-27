// @vitest-environment happy-dom
/**
 * `LoginView.vue` (ui-design.md §6.7, §8, vue-plan.md v2.1 §3.2, §5.2 — P3). Migrated intent
 * from the legacy `tests/web-hub/web/login.test.ts` (plan §4.1): error text rendering via
 * `LoginErrorView`, and clearing the password field right after submit.
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import LoginView from "../../../src/web-hub/ui/src/components/shell/LoginView.vue";

function baseProps() {
  return { plaintext: false, busy: false, error: null, initialPasswordHint: false };
}

describe("LoginView.vue (vue-plan.md v2.1 §3.2, §5.2)", () => {
  it("renders the sign-in form with username/password fields and a submit button", () => {
    const wrapper = mount(LoginView, { props: baseProps() });
    expect(wrapper.find("input#login-username").exists()).toBe(true);
    expect(wrapper.find("input#login-password").exists()).toBe(true);
    expect(wrapper.find('button[type="submit"]').text()).toBe("Sign In");
  });

  it("emits submit with the entered credentials and clears the password field afterwards", async () => {
    const wrapper = mount(LoginView, { props: baseProps() });
    await wrapper.find("input#login-username").setValue("bluecake");
    await wrapper.find("input#login-password").setValue("hunter2");
    await wrapper.find("form").trigger("submit");

    const emitted = wrapper.emitted("submit");
    expect(emitted).toHaveLength(1);
    expect(emitted![0]![0]).toEqual({ username: "bluecake", password: "hunter2" });
    expect((wrapper.find("input#login-password").element as HTMLInputElement).value).toBe("");
  });

  it("show/hide password toggles the input type and aria-pressed", async () => {
    const wrapper = mount(LoginView, { props: baseProps() });
    const input = wrapper.find("input#login-password");
    const toggle = wrapper.find('button[aria-label="Show password"]');
    expect(input.attributes("type")).toBe("password");
    expect(toggle.attributes("aria-pressed")).toBe("false");
    await toggle.trigger("click");
    expect(wrapper.find("input#login-password").attributes("type")).toBe("text");
    expect(wrapper.find('button[aria-pressed="true"]').exists()).toBe(true);
  });

  it("renders a LoginErrorView's message via the errors i18n namespace, including {param} interpolation", () => {
    const wrapper = mount(LoginView, {
      props: { ...baseProps(), error: { key: "errors.throttled", countdownS: 27 } },
    });
    expect(wrapper.find(".form-error").text()).toContain("27s");
  });

  it("disables the form fields and submit button while busy", () => {
    const wrapper = mount(LoginView, { props: { ...baseProps(), busy: true } });
    expect((wrapper.find("input#login-username").element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find('button[type="submit"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the plaintext-HTTP notice only when plaintext is true", () => {
    const off = mount(LoginView, { props: baseProps() });
    expect(off.text()).not.toContain("Plain HTTP");
    const on = mount(LoginView, { props: { ...baseProps(), plaintext: true } });
    expect(on.text()).toContain("Plain HTTP");
  });

  it("shows the initial-password hint only when initialPasswordHint is true", () => {
    const off = mount(LoginView, { props: baseProps() });
    expect(off.text()).not.toContain("Change the initial password");
    const on = mount(LoginView, { props: { ...baseProps(), initialPasswordHint: true } });
    expect(on.text()).toContain("Change the initial password");
  });

  it("renders Chinese copy when navigator.languages starts with zh-CN (submit label + a login error, matching the English case above)", () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "languages");
    Object.defineProperty(window.navigator, "languages", { value: ["zh-CN"], configurable: true });
    try {
      const wrapper = mount(LoginView, {
        props: { ...baseProps(), error: { key: "errors.invalid" } },
      });
      expect(wrapper.find('button[type="submit"]').text()).toBe("\u767b\u5f55");
      expect(wrapper.find(".form-error").text()).toContain("\u7528\u6237\u540d\u6216\u5bc6\u7801\u9519\u8bef");
    } finally {
      if (original) Object.defineProperty(window.navigator, "languages", original);
    }
  });
});
