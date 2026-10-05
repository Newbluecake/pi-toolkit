// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { hubVersionStamp, shortCommit, uiBuildStamp } from "../../../src/web-hub/ui/src/logic/build-stamp.js";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";

/** Top-bar build stamps (`logic/build-stamp.js` + `TopBar.vue`, user request 2026-09-28). */
describe("build-stamp logic", () => {
  it("shortCommit takes the part after @, strips -dirty, truncates to 7", () => {
    expect(shortCommit("0.2.1@6451c63abc12")).toBe("6451c63");
    expect(shortCommit("0.2.1@6451c63abc12-dirty")).toBe("6451c63");
    expect(shortCommit("31baeb3fb1fe")).toBe("31baeb3");
    expect(shortCommit("unknown")).toBe(null);
    expect(shortCommit(undefined)).toBe(null);
    expect(shortCommit("0.2.1")).toBe(null);
  });

  it("hubVersionStamp appends the short commit, falls back to the bare version", () => {
    expect(hubVersionStamp("0.2.1", "0.2.1@6451c63abc12")).toBe("0.2.1@6451c63");
    expect(hubVersionStamp("0.2.1", "unknown")).toBe("0.2.1");
    expect(hubVersionStamp(null, "0.2.1@6451c63abc12")).toBe(null);
  });

  it("uiBuildStamp renders version@commit · MM-DD HH:mm and drops an unparseable time", () => {
    const stamp = uiBuildStamp({ version: "0.2.1", commit: "31baeb3fb1fe", builtAt: "2026-09-28T06:23:16.000Z" });
    expect(stamp).toMatch(/^0\.2\.1@31baeb3 · \d{2}-\d{2} \d{2}:\d{2}$/);
    expect(uiBuildStamp({ version: "0.2.1", commit: "31baeb3fb1fe", builtAt: "not-a-date" })).toBe("0.2.1@31baeb3");
    expect(uiBuildStamp({ version: "0.2.1", commit: "unknown" })).toBe("0.2.1");
    expect(uiBuildStamp({})).toBe(null);
    expect(uiBuildStamp(null)).toBe(null);
  });
});

describe("TopBar build stamps", () => {
  const baseProps = {
    conn: "open",
    hubVersion: null,
    canSignOut: false,
  } as const;

  it("renders the hub stamp and the baked UI build stamp (vitest define)", () => {
    const wrapper = mount(TopBar, { props: { ...baseProps, hubVersion: "0.2.1@6451c63" } });
    const metas = wrapper.findAll(".topbar-meta").map((m) => m.text());
    expect(metas).toContain("hub 0.2.1@6451c63");
    expect(metas.some((m) => m.startsWith("ui 0.0.0-test@0123456 · 01-02 "))).toBe(true);
  });

  it("hides the hub stamp without a hub version but always shows the UI stamp", () => {
    const wrapper = mount(TopBar, { props: baseProps });
    const metas = wrapper.findAll(".topbar-meta").map((m) => m.text());
    expect(metas.some((m) => m.startsWith("hub "))).toBe(false);
    expect(metas.some((m) => m.startsWith("ui 0.0.0-test@"))).toBe(true);
  });
});
