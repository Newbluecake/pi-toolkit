// @vitest-environment happy-dom
/**
 * Boot-failure splash (2026-10-13 hung-handshake incident fix): in password mode, if the very
 * first connection never reaches "open" within BOOT_FAIL_MS (15s), the boot splash must become
 * an actionable error state (message + retry button) instead of spinning forever — and the
 * retry button must truly rebuild the transport-level connection (a fresh EventSource), not
 * just hide the error. The hung handshake itself is modelled by a FakeEventSource that never
 * delivers any frame; the client's own 10s CONNECT_TIMEOUT also fires along the way, which is
 * exactly the real incident's timeline.
 */
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import App from "../../../src/web-hub/ui/src/App.vue";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  listeners = new Map<string, Array<(ev: any) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (ev: any) => void): void {
    const l = this.listeners.get(name) ?? [];
    l.push(fn);
    this.listeners.set(name, l);
  }
  removeEventListener(): void {}
  emit(name: string, data: unknown, lastEventId = ""): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data), lastEventId });
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

function setAuthMode(mode: string | undefined): void {
  if (mode === undefined) delete document.documentElement.dataset["authMode"];
  else document.documentElement.dataset["authMode"] = mode;
}

describe("App.vue boot-failure splash (password mode, hung /api/events handshake)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    // Password-mode start() probes /api/session for the initial-password hint — answer it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) })),
    );
    setAuthMode("password");
  });

  afterEach(() => {
    setAuthMode(undefined);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("no hello within 15s ⇒ actionable error splash (message + retry), no dashboard, no login form", async () => {
    const wrapper = mount(App);
    await nextTick();
    // t=0: the neutral spinner splash, not the error.
    expect(wrapper.find(".boot-splash").exists()).toBe(true);
    expect(wrapper.find(".boot-splash.boot-failed").exists()).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(14_999);
    await nextTick();
    expect(wrapper.find(".boot-splash.boot-failed").exists()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(wrapper.find(".boot-splash.boot-failed").exists()).toBe(true);
    expect(wrapper.find(".boot-error-text").text().length).toBeGreaterThan(0);
    expect(wrapper.find("button.boot-retry").exists()).toBe(true);
    // The error splash owns the page: no dashboard chrome, no premature login form.
    expect(wrapper.find(".topbar").exists()).toBe(false);
    expect(wrapper.find("form.form").exists()).toBe(false);
    wrapper.unmount();
  });

  it("retry rebuilds the transport (fresh EventSource, spinner again) and the error returns if it hangs again", async () => {
    const wrapper = mount(App);
    await nextTick();
    await vi.advanceTimersByTimeAsync(15_000);
    await nextTick();
    expect(wrapper.find(".boot-splash.boot-failed").exists()).toBe(true);
    // The client's own 10s connect timeout already closed instance #1 and reopened #2.
    const beforeRetry = FakeEventSource.instances.length;
    expect(beforeRetry).toBeGreaterThanOrEqual(2);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);

    await wrapper.find("button.boot-retry").trigger("click");
    await nextTick();
    // Error hidden, spinner splash back, and a genuinely NEW stream at the transport layer.
    expect(wrapper.find(".boot-splash.boot-failed").exists()).toBe(false);
    expect(wrapper.find(".boot-splash").exists()).toBe(true);
    expect(wrapper.find(".boot-spinner").exists()).toBe(true);
    expect(FakeEventSource.instances.length).toBe(beforeRetry + 1);

    // The retried connection hangs too ⇒ the error state comes back after another 15s.
    await vi.advanceTimersByTimeAsync(15_000);
    await nextTick();
    expect(wrapper.find(".boot-splash.boot-failed").exists()).toBe(true);
    wrapper.unmount();
  });

  it("a hello before the deadline boots into the dashboard and the error never appears", async () => {
    const wrapper = mount(App);
    await nextTick();
    FakeEventSource.instances[0]!.emit("hello", { clientId: "c1" });
    await nextTick();
    await nextTick();
    expect(wrapper.find(".topbar").exists()).toBe(true);
    expect(wrapper.find(".boot-splash").exists()).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    await nextTick();
    expect(wrapper.find(".boot-splash.boot-failed").exists()).toBe(false);
    expect(wrapper.find(".topbar").exists()).toBe(true);
    wrapper.unmount();
  });
});
