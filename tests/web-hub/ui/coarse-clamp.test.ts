// @vitest-environment happy-dom
/**
 * `useCoarseClamp` + `ClampToggle.vue` (2026-10 transcript scroll-freeze fix, part 2), driven
 * through their two real hosts (`ThinkingBlock.vue`, `ToolCard.vue`). happy-dom does no layout,
 * so geometry is stubbed per element (`scrollHeight`/`clientHeight` getters — same pattern as
 * thinking-block.test.ts) and re-measures are driven by firing the fake ResizeObserver by hand
 * (same pattern as transcript.test.ts's follow-pin tests): the composable measures on mount,
 * on observer ticks, on its reactive sources, and on the expand/collapse flip.
 *
 * Fine-pointer parity: on a non-coarse pointer (and on coarse content that fits under the cap)
 * the DOM must stay byte-identical to pre-feature — no `data-cc` attribute, no toggle button.
 */
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";
import CodeBlock from "../../../src/web-hub/ui/src/components/transcript/CodeBlock.vue";
import ThinkingBlock from "../../../src/web-hub/ui/src/components/transcript/ThinkingBlock.vue";
import ToolCard from "../../../src/web-hub/ui/src/components/transcript/ToolCard.vue";
import type { ToolView } from "../../../src/web-hub/ui/src/types.js";

function stubMatchMedia(coarse: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: coarse && query.includes("coarse"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

type RoCallback = (entries: readonly unknown[], observer: unknown) => void;

/** happy-dom ships a ResizeObserver global that never fires from real layout — replace it with
 *  one that records observe/unobserve/disconnect so tests can fire ticks by hand AND assert the
 *  composable disconnects on unmount (no observer ever leaks past its component). */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  unobserved = 0;
  disconnectCount = 0;
  constructor(private readonly cb: RoCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(el: Element): void {
    this.unobserved += 1;
    const i = this.observed.indexOf(el);
    if (i >= 0) this.observed.splice(i, 1);
  }
  disconnect(): void {
    this.disconnectCount += 1;
    this.observed.length = 0;
  }
  fire(): void {
    this.cb([], this);
  }
}

async function withFakeResizeObserver<T>(fn: () => Promise<T> | T): Promise<T> {
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  FakeResizeObserver.instances = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  try {
    return await fn();
  } finally {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
  }
}

/** Pins scrollHeight/clientHeight on one element (happy-dom has no layout). */
function stubBox(el: Element, box: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
}

/** The FakeResizeObserver currently observing `el` (each clamp owns one instance). */
function observerOf(el: Element): FakeResizeObserver {
  const ro = FakeResizeObserver.instances.find((i) => i.observed.includes(el));
  if (ro === undefined) throw new Error("no observer watching the element");
  return ro;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("i18n labels (en + zh, parity otherwise enforced by i18n-parity.test.ts)", () => {
  it("pins the exact toggle strings from the user report", () => {
    expect(MESSAGES.en.transcript?.showAll).toBe("Show all");
    expect(MESSAGES.en.transcript?.collapse).toBe("Collapse");
    expect(MESSAGES.zh.transcript?.showAll).toBe("展开全部");
    expect(MESSAGES.zh.transcript?.collapse).toBe("收起");
  });
});

describe("useCoarseClamp via ThinkingBlock.vue", () => {
  const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `line ${i} of a long chain of thought`).join("\n");

  it("fine pointer: no data-cc attribute and no toggle, even when the text overflows the cap", async () => {
    stubMatchMedia(false);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(ThinkingBlock, { props: { text: LONG_TEXT, live: true } });
      const el = wrapper.get(".thinking-text").element;
      stubBox(el, { scrollHeight: 2000, clientHeight: 320 });
      observerOf(el).fire(); // re-measure with overflowing geometry
      await nextTick();
      await wrapper.setProps({ text: LONG_TEXT + "\nmore" }); // …and via the reactive source
      expect(wrapper.get(".thinking-text").attributes("data-cc")).toBeUndefined();
      expect(wrapper.find(".cc-toggle").exists()).toBe(false);
      wrapper.unmount();
    });
  });

  it("coarse pointer + overflow: clamps (data-cc=clamped) and shows the Show all toggle", async () => {
    stubMatchMedia(true);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(ThinkingBlock, { props: { text: LONG_TEXT, live: true } });
      const el = wrapper.get(".thinking-text").element;
      stubBox(el, { scrollHeight: 2000, clientHeight: 320 });
      observerOf(el).fire();
      await nextTick();
      expect(wrapper.get(".thinking-text").attributes("data-cc")).toBe("clamped");
      const btn = wrapper.get(".cc-toggle");
      expect(btn.text()).toBe("Show all");
    });
  });

  it("toggling flips clamped → expanded (cap lifted) and back, relabelling Collapse / Show all", async () => {
    stubMatchMedia(true);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(ThinkingBlock, { props: { text: LONG_TEXT, live: false } });
      const el = wrapper.get(".thinking-text").element;
      stubBox(el, { scrollHeight: 2000, clientHeight: 320 });
      observerOf(el).fire();
      await nextTick();
      expect(wrapper.get(".thinking-text").attributes("data-cc")).toBe("clamped");
      expect(wrapper.get(".cc-toggle").attributes("aria-expanded")).toBe("false");

      await wrapper.get(".cc-toggle").trigger("click");
      expect(wrapper.get(".thinking-text").attributes("data-cc")).toBe("expanded");
      expect(wrapper.get(".cc-toggle").text()).toBe("Collapse");
      expect(wrapper.get(".cc-toggle").attributes("aria-expanded")).toBe("true");

      // still overflowing while expanded (cap cached at 320): the Collapse toggle stays
      stubBox(el, { scrollHeight: 2000, clientHeight: 2000 });
      observerOf(el).fire();
      await nextTick();
      expect(wrapper.get(".cc-toggle").text()).toBe("Collapse");

      await wrapper.get(".cc-toggle").trigger("click");
      stubBox(el, { scrollHeight: 2000, clientHeight: 320 });
      observerOf(el).fire();
      await nextTick();
      expect(wrapper.get(".thinking-text").attributes("data-cc")).toBe("clamped");
      expect(wrapper.get(".cc-toggle").text()).toBe("Show all");
    });
  });

  it("coarse pointer but content fits under the cap: no attribute, no toggle (byte-identical DOM)", async () => {
    stubMatchMedia(true);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(ThinkingBlock, { props: { text: "short thought", live: true } });
      const el = wrapper.get(".thinking-text").element;
      stubBox(el, { scrollHeight: 40, clientHeight: 40 });
      observerOf(el).fire();
      await nextTick();
      expect(wrapper.get(".thinking-text").attributes("data-cc")).toBeUndefined();
      expect(wrapper.find(".cc-toggle").exists()).toBe(false);
    });
  });

  it("disconnects its ResizeObserver on unmount (no leaked observers)", async () => {
    stubMatchMedia(true);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(ThinkingBlock, { props: { text: LONG_TEXT, live: true } });
      const el = wrapper.get(".thinking-text").element;
      const ro = observerOf(el);
      wrapper.unmount();
      expect(ro.disconnectCount).toBe(1);
    });
  });
});

describe("useCoarseClamp via CodeBlock.vue (markdown code block — horizontal pan preserved)", () => {
  const CODE = Array.from({ length: 80 }, (_, i) => `// line ${i}`).join("\n");

  it("coarse + vertical overflow: pre AND wrapper carry data-cc=clamped; toggle expands and collapses", async () => {
    stubMatchMedia(true);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(CodeBlock, { props: { lang: "ts", text: CODE } });
      const pre = wrapper.get("pre").element;
      stubBox(pre, { scrollHeight: 1200, clientHeight: 420 });
      observerOf(pre).fire();
      await nextTick();
      expect(wrapper.get("pre").attributes("data-cc")).toBe("clamped");
      expect(wrapper.get(".codeblock").attributes("data-cc")).toBe("clamped"); // the fade anchor
      expect(wrapper.get(".cc-toggle").text()).toBe("Show all");
      await wrapper.get(".cc-toggle").trigger("click");
      expect(wrapper.get("pre").attributes("data-cc")).toBe("expanded");
      expect(wrapper.get(".codeblock").attributes("data-cc")).toBe("expanded");
      expect(wrapper.get(".cc-toggle").text()).toBe("Collapse");
    });
  });

  it("horizontal overflow alone never clamps (long lines keep panning; only vertical overflow clamps)", async () => {
    stubMatchMedia(true);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(CodeBlock, { props: { lang: "ts", text: "const oneVeryLongLine = 1;" } });
      const pre = wrapper.get("pre").element;
      Object.defineProperty(pre, "scrollWidth", { configurable: true, get: () => 5000 }); // wide
      stubBox(pre, { scrollHeight: 100, clientHeight: 100 }); // but short
      observerOf(pre).fire();
      await nextTick();
      expect(wrapper.get("pre").attributes("data-cc")).toBeUndefined();
      expect(wrapper.find(".cc-toggle").exists()).toBe(false);
    });
  });

  it("fine pointer: no data-cc on pre or wrapper and no toggle (parity pin)", async () => {
    stubMatchMedia(false);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(CodeBlock, { props: { lang: "ts", text: CODE } });
      const pre = wrapper.get("pre").element;
      stubBox(pre, { scrollHeight: 1200, clientHeight: 420 });
      observerOf(pre).fire();
      await nextTick();
      expect(wrapper.get("pre").attributes("data-cc")).toBeUndefined();
      expect(wrapper.get(".codeblock").attributes("data-cc")).toBeUndefined();
      expect(wrapper.find(".cc-toggle").exists()).toBe(false);
    });
  });
});

describe("useCoarseClamp via ToolCard.vue (diff box + result pre)", () => {
  function view(v: Partial<ToolView> & Pick<ToolView, "toolCallId" | "toolName" | "state">): ToolView {
    return { args: undefined, ...v };
  }

  it("edit-diff box clamps with its own toggle on a coarse pointer", async () => {
    stubMatchMedia(true);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(ToolCard, {
        props: {
          view: view({
            toolCallId: "d1",
            toolName: "edit",
            state: "done",
            args: { path: "/p/src/a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
            result: "ok",
          }),
        },
      });
      const diff = wrapper.get(".diff").element;
      stubBox(diff, { scrollHeight: 1500, clientHeight: 420 });
      observerOf(diff).fire();
      await nextTick();
      expect(wrapper.get(".diff").attributes("data-cc")).toBe("clamped");
      const toggle = wrapper.get(".tool-section .cc-toggle");
      expect(toggle.text()).toBe("Show all");
      await toggle.trigger("click");
      expect(wrapper.get(".diff").attributes("data-cc")).toBe("expanded");
    });
  });

  it("result pre clamps independently of the diff box", async () => {
    stubMatchMedia(true);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(ToolCard, {
        props: {
          view: view({ toolCallId: "b1", toolName: "bash", state: "done", result: "line1\nline2" }),
        },
      });
      const pre = wrapper.get(".tool-section .pre").element;
      stubBox(pre, { scrollHeight: 900, clientHeight: 280 });
      observerOf(pre).fire();
      await nextTick();
      expect(wrapper.get(".tool-section .pre").attributes("data-cc")).toBe("clamped");
      expect(wrapper.get(".cc-toggle").text()).toBe("Show all");
      await wrapper.get(".cc-toggle").trigger("click");
      expect(wrapper.get(".tool-section .pre").attributes("data-cc")).toBe("expanded");
    });
  });

  it("fine pointer: ToolCard DOM carries no data-cc and no toggle (parity pin)", async () => {
    stubMatchMedia(false);
    await withFakeResizeObserver(async () => {
      const wrapper = mount(ToolCard, {
        props: {
          view: view({
            toolCallId: "d2",
            toolName: "edit",
            state: "done",
            args: { path: "/p/src/a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
            result: "ok",
          }),
        },
      });
      const diff = wrapper.get(".diff").element;
      stubBox(diff, { scrollHeight: 1500, clientHeight: 420 });
      observerOf(diff).fire();
      await nextTick();
      expect(wrapper.get(".diff").attributes("data-cc")).toBeUndefined();
      expect(wrapper.find(".cc-toggle").exists()).toBe(false);
    });
  });
});
