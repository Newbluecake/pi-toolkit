// @vitest-environment happy-dom
/**
 * TopBar.vue's phone-only brand-mark connection badge (phone-declutter plan A). The badge is
 * physically absent from the DOM above 480px (mirrors `quotaList`/`loadList`'s 0/1-item `v-for`
 * trick — see the component's own header and `quota-pill.test.ts`'s TopBar golden-HTML pin,
 * which this file does not touch because every test there runs under a stubbed `matchMedia`
 * that never matches `(max-width: 480px)`).
 */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";
import type { ConnState } from "../../../src/web-hub/ui/src/types.js";

const baseProps = { hubVersion: null, canSignOut: false } as const;

function stubMatchMedia(phone: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 480px)" ? phone : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TopBar.vue — connection badge (desktop/tablet, phone=false)", () => {
  it("renders no .conn-badge node at all, and keeps brand-mark aria-hidden", () => {
    stubMatchMedia(false);
    const wrapper = mount(TopBar, { props: { ...baseProps, conn: "open" } });
    expect(wrapper.find(".conn-badge").exists()).toBe(false);
    expect(wrapper.get(".brand-mark").attributes("aria-hidden")).toBe("true");
    wrapper.unmount();
  });

  it("the .pill.conn text pill still exists in the DOM (CSS-only hiding, not removed)", () => {
    stubMatchMedia(false);
    const wrapper = mount(TopBar, { props: { ...baseProps, conn: "open" } });
    expect(wrapper.find(".pill.conn").exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("TopBar.vue — connection badge (phone, \u2264480px)", () => {
  it.each(["open", "connecting", "reconnecting", "auth"] as ConnState[])(
    "conn=%s renders a role=status badge with data-conn + the same aria-label as the hidden pill",
    (conn) => {
      stubMatchMedia(true);
      const wrapper = mount(TopBar, { props: { ...baseProps, conn } });
      const badge = wrapper.get(".conn-badge");
      expect(badge.attributes("role")).toBe("status");
      expect(badge.attributes("data-conn")).toBe(conn);
      const label = badge.attributes("aria-label");
      expect(label).toBeTruthy();
      expect(badge.attributes("title")).toBe(label);
      wrapper.unmount();
    },
  );

  it("brand-mark is no longer aria-hidden so the badge stays reachable by assistive tech", () => {
    stubMatchMedia(true);
    const wrapper = mount(TopBar, { props: { ...baseProps, conn: "open" } });
    expect(wrapper.get(".brand-mark").attributes("aria-hidden")).toBeUndefined();
    wrapper.unmount();
  });

  it("connecting/reconnecting get the dot-live pulse class (primitives.css, reused verbatim); open/auth do not", () => {
    stubMatchMedia(true);
    for (const conn of ["connecting", "reconnecting"] as ConnState[]) {
      const wrapper = mount(TopBar, { props: { ...baseProps, conn } });
      expect(wrapper.get(".conn-badge").classes()).toContain("dot-live");
      wrapper.unmount();
    }
    for (const conn of ["open", "auth"] as ConnState[]) {
      const wrapper = mount(TopBar, { props: { ...baseProps, conn } });
      expect(wrapper.get(".conn-badge").classes()).not.toContain("dot-live");
      wrapper.unmount();
    }
  });

  it("auth renders the desktop pill's unlock glyph (shape cue), the other states a plain dot", () => {
    stubMatchMedia(true);
    const auth = mount(TopBar, { props: { ...baseProps, conn: "auth" } });
    const badge = auth.get(".conn-badge");
    expect(badge.classes()).toContain("conn-badge-icon");
    expect(badge.classes()).not.toContain("dot");
    expect(badge.find("svg").exists()).toBe(true);
    auth.unmount();
    for (const conn of ["open", "connecting", "reconnecting"] as ConnState[]) {
      const wrapper = mount(TopBar, { props: { ...baseProps, conn } });
      const dot = wrapper.get(".conn-badge");
      expect(dot.classes()).toContain("dot");
      expect(dot.find("svg").exists()).toBe(false);
      wrapper.unmount();
    }
  });

  it("exactly one .conn-badge node exists (0/1-item v-for, never a stray v-if comment)", () => {
    stubMatchMedia(true);
    const wrapper = mount(TopBar, { props: { ...baseProps, conn: "open" } });
    expect(wrapper.findAll(".conn-badge")).toHaveLength(1);
    wrapper.unmount();
  });
});

describe("TopBar.vue — phone-declutter plan C: lang menu + sign-out move off the bar", () => {
  it("desktop/tablet (phone=false): both the language menu and sign-out button render in the bar", () => {
    stubMatchMedia(false);
    const wrapper = mount(TopBar, { props: { ...baseProps, conn: "open", canSignOut: true } });
    expect(wrapper.find(".lang-anchor").exists()).toBe(true);
    expect(wrapper.find("[aria-label='Sign out']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("phone (≤480px): neither the language menu nor the sign-out button render in the bar at all", () => {
    stubMatchMedia(true);
    const wrapper = mount(TopBar, { props: { ...baseProps, conn: "open", canSignOut: true } });
    expect(wrapper.find(".lang-anchor").exists()).toBe(false);
    expect(wrapper.find("[aria-label='Sign out']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("phone + canSignOut=false: still no sign-out button (unaffected by the phone gate)", () => {
    stubMatchMedia(true);
    const wrapper = mount(TopBar, { props: { ...baseProps, conn: "open", canSignOut: false } });
    expect(wrapper.find("[aria-label='Sign out']").exists()).toBe(false);
    wrapper.unmount();
  });
});
