// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommandArgPalette from "../../../src/web-hub/ui/src/components/control/CommandArgPalette.vue";

/**
 * `control/CommandArgPalette.vue` (web-hub-slash-args §6.2, P3): render states — static
 * header (usage with ellipsis + full-text title, r1 #3), rows with confirm chip and value
 * title, the delayed loading hint, the empty hint, the error silent degrade (header only),
 * the footer hint, aria wiring (listbox / option ids / aria-busy) and the no-v-html rule.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const w of mounted.splice(0)) w.unmount();
});

const ITEMS = [
  { value: "keepalive", label: "keepalive", description: "cache keepalive" },
  { value: "status", label: "status", policy: "confirm" as const },
];

function mountPanel(props: Record<string, unknown> = {}) {
  const w = mount(CommandArgPalette, {
    props: { name: "cache-ttl", usage: "<subcommand> [args]", items: ITEMS, ...props },
  });
  mounted.push(w);
  return w;
}

describe("CommandArgPalette render states", () => {
  it("renders the static header (`/name` + usage, title carries the full text) and rows", () => {
    const w = mountPanel({ listboxId: "lb" });
    const head = w.find(".arg-head");
    expect(head.exists()).toBe(true);
    expect(head.find(".command-name").text()).toBe("/cache-ttl");
    const usage = head.find(".arg-usage");
    expect(usage.text()).toBe("<subcommand> [args]");
    expect(usage.attributes("title")).toBe("<subcommand> [args]"); // r1 #3: ellipsis + title full
    const rows = w.findAll(".arg-item");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.find(".command-name").text()).toBe("keepalive");
    expect(rows[0]!.find(".command-desc").text()).toBe("cache keepalive");
    expect(rows[0]!.attributes("title")).toBe("keepalive"); // title = raw value (whole-prefix replace)
    expect(rows[1]!.attributes("title")).toBe("status");
  });

  it("confirm items carry the shared confirm chip; allow items carry none", () => {
    const w = mountPanel();
    const chips = w.findAll(".policy-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.attributes("data-policy")).toBe("confirm");
    expect(chips[0]!.text()).not.toBe("");
  });

  it("usage falls back to nothing when absent — header keeps the bare `/name` with rows", () => {
    const w = mountPanel({ usage: undefined });
    expect(w.find(".arg-head").exists()).toBe(true);
    expect(w.find(".arg-usage").exists()).toBe(false);
  });

  it("empty: header + the weak no-completions hint (no rows, no footer)", () => {
    const w = mountPanel({ items: [] });
    expect(w.find(".command-empty").exists()).toBe(true);
    expect(w.find(".command-empty").text()).not.toBe("");
    expect(w.findAll(".arg-item")).toHaveLength(0);
    expect(w.find(".command-hint").exists()).toBe(false);
  });

  it("error: silent degrade — header only, the empty hint is suppressed", () => {
    const w = mountPanel({ items: [], error: true });
    expect(w.find(".arg-head").exists()).toBe(true);
    expect(w.find(".command-empty").exists()).toBe(false);
    expect(w.find(".command-hint").exists()).toBe(false);
  });

  it("loading with no rows shows the delayed hint (250ms) — not before", async () => {
    vi.useFakeTimers();
    try {
      const w = mountPanel({ items: [], loading: true });
      expect(w.find(".command-empty").exists()).toBe(false); // before the delay: nothing flashes
      vi.advanceTimersByTime(249);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.find(".command-empty").exists()).toBe(true); // the "…" hint
      vi.advanceTimersByTime(5_000);
      expect(w.findAll(".command-empty")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loading keeps stale rows visible and clears the delayed hint when rows exist", async () => {
    vi.useFakeTimers();
    try {
      const w = mountPanel({ loading: true }); // items present
      vi.advanceTimersByTime(400);
      expect(w.findAll(".arg-item")).toHaveLength(2); // stale rows kept
      expect(w.find(".command-empty").exists()).toBe(false); // hint never shows with rows
      expect(w.find(".command-palette").attributes("aria-busy")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fast response never flashes the loading hint (timer cleared on settle)", async () => {
    vi.useFakeTimers();
    try {
      const w = mountPanel({ items: [], loading: true });
      await w.setProps({ loading: false, items: ITEMS });
      vi.advanceTimersByTime(1_000);
      expect(w.find(".command-empty").exists()).toBe(false);
      expect(w.findAll(".arg-item")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aria: listbox role/label, option ids `<id>-opt-<i>`, aria-selected follows active", () => {
    const w = mountPanel({ listboxId: "lb", active: 1 });
    const root = w.find(".command-palette");
    expect(root.attributes("role")).toBe("listbox");
    expect(root.attributes("aria-label")).not.toBe("");
    const rows = w.findAll(".arg-item");
    expect(rows[0]!.attributes("id")).toBe("lb-opt-0");
    expect(rows[1]!.attributes("id")).toBe("lb-opt-1");
    expect(rows[0]!.attributes("aria-selected")).toBe("false");
    expect(rows[1]!.attributes("aria-selected")).toBe("true");
  });

  it("pointer: click emits the item; hover emits the index; mousedown is prevented (no textarea blur)", async () => {
    const w = mountPanel();
    await w.findAll(".arg-item")[1]!.trigger("click");
    expect(w.emitted("pick")).toEqual([[ITEMS[1]]]);
    await w.findAll(".arg-item")[0]!.trigger("mousemove");
    expect(w.emitted("hover")).toEqual([[0]]);
    const el = w.findAll(".arg-item")[0]!.element;
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // @mousedown.prevent keeps the textarea focused
  });

  it("never uses v-html: item text with markup renders as TEXT, not nodes", () => {
    const w = mountPanel({
      items: [{ value: "<b>v</b>", label: "<script>x</script>", description: "<i>d</i>" }],
    });
    expect(w.html()).toContain("&lt;script&gt;"); // escaped ⇒ interpolation, never v-html
    expect(w.find(".arg-item script").exists()).toBe(false);
    expect(w.find(".arg-item i").exists()).toBe(false);
  });
});
