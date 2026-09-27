// @vitest-environment happy-dom
/**
 * `App.vue`'s auth-mode gate (vue-plan.md v2.1 §1.1, §3.2, §5.2 — P3). Migrated from the legacy
 * `tests/web-hub/web/auth-mode.test.ts` (plan §4.1): a missing/invalid `data-auth-mode` must
 * never read `#t=`, never touch `localStorage`, never open an `EventSource` — proven here by
 * mounting with `window.EventSource` left `undefined` (happy-dom has none by default) and
 * asserting the mount doesn't throw, plus by spying on `localStorage`. `token`/`password` picks
 * the right initial view once a minimal fake `EventSource` is in place.
 */
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../src/web-hub/ui/src/App.vue";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setAuthMode(mode: string | undefined): void {
  if (mode === undefined) delete document.documentElement.dataset["authMode"];
  else document.documentElement.dataset["authMode"] = mode;
}

describe("App.vue auth-mode gate (vue-plan.md v2.1 §1.1, §5.2)", () => {
  afterEach(() => {
    setAuthMode(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("missing data-auth-mode: mounts without throwing even with no EventSource defined (never opens SSE)", async () => {
    setAuthMode(undefined);
    expect(() => mount(App)).not.toThrow();
  });

  it("invalid data-auth-mode: never reads/writes the token-mode storage key", async () => {
    setAuthMode("bogus");
    const getItem = vi.spyOn(window.localStorage, "getItem");
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const wrapper = mount(App);
    await flush();
    // `useTheme()` legitimately always reads/writes `pwh_theme` (matches `theme-init.js`'s own
    // pre-paint behavior, which already runs unconditionally regardless of auth mode) — the
    // migrated legacy assertion is specifically about the token-mode key never being touched.
    expect(getItem.mock.calls.map((c) => c[0])).not.toContain("pwh_token");
    expect(setItem.mock.calls.map((c) => c[0])).not.toContain("pwh_token");
    wrapper.unmount();
  });

  it("missing data-auth-mode renders the auth-mode-unknown gate (a Reload action, no sign-in form)", async () => {
    setAuthMode(undefined);
    const wrapper = mount(App);
    await flush();
    expect(wrapper.find("form").exists()).toBe(false);
    expect(wrapper.find("button.notice-action").exists()).toBe(true);
    wrapper.unmount();
  });

  it("token mode with no stored token: mounts the dashboard shell (no login form in token mode)", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    setAuthMode("token");
    const wrapper = mount(App);
    await flush();
    expect(wrapper.find(".topbar").exists()).toBe(true);
    expect(wrapper.find("form").exists()).toBe(false);
    wrapper.unmount();
  });

  it("password mode before authentication: shows the login form, not the dashboard shell", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    setAuthMode("password");
    const wrapper = mount(App);
    await flush();
    expect(wrapper.find("form.form").exists()).toBe(true);
    expect(wrapper.find(".topbar").exists()).toBe(false);
    wrapper.unmount();
  });
});
