// @vitest-environment happy-dom
/**
 * `MermaidBlock.vue` (web-hub-mermaid plan §6.3 + §10.2, P2; r3 主会话裁定 + r3 补充/补充二).
 * The runtime is ALWAYS mocked (§10.2: happy-dom 下绝不加载真 mermaid — the §4 frozen interface
 * is the only contact surface): `requestMermaid` / `peekMermaidCache` are vi.fn()s driven
 * through deferred promises so generation ordering is fully controlled. IntersectionObserver /
 * ResizeObserver are stubbed with capturable fakes (same pattern as `preview-text.test.ts`).
 */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

const requestMermaid = vi.fn();
const peekMermaidCache = vi.fn();
vi.mock("../../../src/web-hub/ui/src/components/shared/mermaid-runtime.js", () => ({
  requestMermaid: (req: unknown) => requestMermaid(req),
  peekMermaidCache: (text: unknown, theme: unknown) => peekMermaidCache(text, theme),
  mermaidEngineState: () => "idle" as const,
  __resetMermaidRuntimeForTests: () => {},
}));

import MermaidBlock from "../../../src/web-hub/ui/src/components/transcript/MermaidBlock.vue";
import CodeBlock from "../../../src/web-hub/ui/src/components/transcript/CodeBlock.vue";
import MarkdownView from "../../../src/web-hub/ui/src/components/transcript/MarkdownView.vue";
import { PATH_REFERENCES_SUSPENDED } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { MermaidOutcome, MermaidRequest } from "../../../src/web-hub/ui/src/components/shared/mermaid-runtime.js";

/* ---------------------------------------------------------------- helpers */
type OkOutcome = Extract<MermaidOutcome, { kind: "ok" }>;
type ErrorOutcome = Extract<MermaidOutcome, { kind: "error" }>;

function okOutcome(over: Partial<OkOutcome> = {}): MermaidOutcome {
  return {
    kind: "ok",
    src: "data:image/svg+xml,%3Csvg%3E",
    width: 640,
    height: 480,
    diagramType: "flowchart-v2",
    title: null,
    ...over,
  };
}
function err(reason: ErrorOutcome["reason"], message = "boom"): MermaidOutcome {
  return { kind: "error", reason, message };
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private res!: (v: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.res = resolve;
    });
  }
  resolve(v: T): void {
    this.res(v);
  }
}

class FakeIO {
  static instances: FakeIO[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(readonly cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    FakeIO.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  fire(isIntersecting: boolean): void {
    this.cb([{ isIntersecting }]);
  }
}

class FakeRO {
  static instances: FakeRO[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(readonly cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
    FakeRO.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {
    /* membership tracked via `observed` */
  }
  disconnect(): void {
    this.disconnected = true;
  }
  fire(width: number): void {
    this.cb([{ contentRect: { width } }]);
  }
}

const TEXT = "flowchart TD\n  A-->B";

/** vi.stubGlobal targets globalThis, but the component reads `window.navigator` through
 *  `useClipboard(window)` — replace the property on the window object itself. */
let originalNavigator: PropertyDescriptor | undefined;
function stubNavigator(clipboard: unknown): void {
  originalNavigator ??= Object.getOwnPropertyDescriptor(window, "navigator");
  Object.defineProperty(window, "navigator", { value: { clipboard }, configurable: true });
}

/** Every wrapper ever mounted, so a FAILED assertion can never leak a live component into the
 *  next test (leaked components still watch the theme and would fire stray runtime requests). */
const mountedWrappers: Array<ReturnType<typeof mount>> = [];
function track<T extends ReturnType<typeof mount>>(w: T): T {
  mountedWrappers.push(w);
  return w;
}

function mountBlock(over: { lang?: string; text?: string; streaming?: boolean } = {}) {
  const streaming = over.streaming;
  return track(
    mount(MermaidBlock, {
      props: { lang: over.lang ?? "mermaid", text: over.text ?? TEXT },
      global: {
        provide: streaming === undefined ? {} : { [PATH_REFERENCES_SUSPENDED as symbol]: ref(streaming) },
      },
    }),
  );
}

/** Mount settled, fire visibility, return the wrapper + the in-flight deferred. */
function mountVisible(text = TEXT): { w: ReturnType<typeof mount>; d: Deferred<MermaidOutcome> } {
  const w = mountBlock({ text });
  const d = new Deferred<MermaidOutcome>();
  requestMermaid.mockReturnValueOnce(d.promise);
  FakeIO.instances.at(-1)!.fire(true);
  return { w, d };
}

/** Queue a never-settling outcome for the NEXT requestMermaid call (keeps generations in flight). */
function queuePending(): Deferred<MermaidOutcome> {
  const d = new Deferred<MermaidOutcome>();
  requestMermaid.mockReturnValueOnce(d.promise);
  return d;
}

beforeEach(() => {
  requestMermaid.mockReset();
  peekMermaidCache.mockReset().mockReturnValue(undefined);
  setLangOverride("zh");
  FakeIO.instances = [];
  FakeRO.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIO);
  vi.stubGlobal("ResizeObserver", FakeRO);
});

afterEach(() => {
  for (const w of mountedWrappers.splice(0)) {
    try {
      w.unmount();
    } catch {
      /* already unmounted inside the test (abort/unmount cases) */
    }
  }
  vi.unstubAllGlobals();
  resetLangForTests();
  if (originalNavigator !== undefined) {
    Object.defineProperty(window, "navigator", originalNavigator);
    originalNavigator = undefined;
  } else {
    delete (window as { navigator?: unknown }).navigator;
  }
});

/* ---------------------------------------------------------------- streaming (r3 补充: DOM byte-identical) */
describe("MermaidBlock — streaming regime", () => {
  it("renders a plain CodeBlock whose DOM is byte-identical to mounting CodeBlock directly", () => {
    const a = mountBlock({ streaming: true, text: TEXT });
    const b = track(mount(CodeBlock, { props: { lang: "mermaid", text: TEXT } }));
    expect(a.html()).toBe(b.html());
    expect(requestMermaid).not.toHaveBeenCalled();
    a.unmount();
    b.unmount();
  });

  it("never requests while suspended; the settle flip + visibility starts the request", async () => {
    const flag = ref(true);
    const w = track(
      mount(MermaidBlock, {
        props: { lang: "mermaid", text: TEXT },
        global: { provide: { [PATH_REFERENCES_SUSPENDED as symbol]: flag } },
      }),
    );
    const d = queuePending();
    FakeIO.instances.at(-1)!.fire(true); // visible while still streaming — must NOT request
    expect(requestMermaid).not.toHaveBeenCalled();
    flag.value = false;
    await nextTick();
    expect(requestMermaid).toHaveBeenCalledTimes(1);
    d.resolve(okOutcome());
    await flushPromises();
    expect(w.find("img").exists()).toBe(true);
    w.unmount();
  });
});

/* ---------------------------------------------------------------- settled state machine */
describe("MermaidBlock — settled regime", () => {
  it("requests immediately when the environment has no IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    queuePending();
    const w = mountBlock();
    expect(requestMermaid).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("waits for visibility: no request until intersecting; loading shows source + 渲染中…", async () => {
    const w = mountBlock();
    expect(requestMermaid).not.toHaveBeenCalled();
    const { d } = (() => {
      const dd = new Deferred<MermaidOutcome>();
      requestMermaid.mockReturnValueOnce(dd.promise);
      FakeIO.instances.at(-1)!.fire(true);
      return { d: dd };
    })();
    const call = requestMermaid.mock.calls[0]![0] as MermaidRequest;
    expect(call.text).toBe(TEXT);
    expect(call.theme).toBe("light");
    expect(call.signal).toBeInstanceOf(AbortSignal);
    await nextTick(); // Vue patches data-mmd-state on the next tick
    expect(w.get(".codeblock.mmd").attributes("data-mmd-state")).toBe("loading");
    expect(w.find("pre").exists()).toBe(true);
    expect(w.get('[role="status"]').text()).toBe("渲染中…");
    expect(w.find("img").exists()).toBe(false);

    d.resolve(okOutcome({ src: "data:image/svg+xml,DARK", width: 800, height: 600, title: "标题" }));
    await flushPromises();
    const img = w.get("img");
    expect(w.get(".codeblock.mmd").attributes("data-mmd-state")).toBe("ok");
    expect(img.attributes("src")).toBe("data:image/svg+xml,DARK");
    expect(img.attributes("width")).toBe("800");
    expect(img.attributes("height")).toBe("600");
    expect(img.attributes("alt")).toBe("标题"); // accTitle (title) wins over the type line
    expect(img.attributes("decoding")).toBe("async");
    expect(w.find("pre").exists()).toBe(false);
    w.unmount();
  });

  it("applies a synchronous cache peek at mount — no source flash, no request", () => {
    peekMermaidCache.mockReturnValue(okOutcome({ src: "data:image/svg+xml,CACHED", width: 10, height: 10 }));
    const w = mountBlock();
    expect(requestMermaid).not.toHaveBeenCalled();
    expect(w.get(".codeblock.mmd").attributes("data-mmd-state")).toBe("ok");
    expect(w.get("img").attributes("src")).toBe("data:image/svg+xml,CACHED");
    w.unmount();
  });

  it("alt falls back to the diagramType line when there is no title", async () => {
    const { w, d } = mountVisible();
    d.resolve(okOutcome({ diagramType: "sequence", title: null }));
    await flushPromises();
    expect(w.get("img").attributes("alt")).toBe("Mermaid sequence 图");
    w.unmount();
  });

  it("「源码 ⇄ 图」 toggle swaps views with aria-pressed", async () => {
    const { w, d } = mountVisible();
    d.resolve(okOutcome());
    await flushPromises();
    const toggle = w.findAll("button").find((b) => b.text() === "源码")!;
    expect(toggle.attributes("aria-pressed")).toBe("false");
    await toggle.trigger("click");
    expect(w.find("pre").exists()).toBe(true);
    expect(w.find("img").exists()).toBe(false);
    expect(toggle.attributes("aria-pressed")).toBe("true"); // same button — its label flipped to 图
    const back = w.findAll("button").find((b) => b.text() === "图")!;
    await back.trigger("click");
    expect(w.find("img").exists()).toBe(true);
    expect(
      w
        .findAll("button")
        .find((b) => b.text() === "源码")!
        .attributes("aria-pressed"),
    ).toBe("false");
    w.unmount();
  });

  it("each error reason falls back to the source view with its mapped i18n line; toggle hidden", async () => {
    const cases: Array<[MermaidOutcome, string]> = [
      [err("parse", "expecting SQE"), "渲染失败：expecting SQE"],
      [err("render", "kaboom"), "渲染失败：kaboom"],
      [err("timeout", "render timeout"), "渲染失败：render timeout"],
      [err("output-invalid", "svg rejected"), "渲染失败：svg rejected"],
      [err("too-large"), "图表过大，已显示源码"],
      [err("unsupported", "nope"), "暂不支持此图内容（图类型或配置），已显示源码"],
      [err("unsupported", "pwh-mermaid: KaTeX math is not bundled"), "图中含数学公式（未支持），已显示源码"],
      [err("load-failed"), "渲染引擎不可用，已显示源码"],
      [err("engine-unavailable"), "渲染引擎不可用，已显示源码"],
      [err("busy"), "渲染队列已满，已显示源码"],
    ];
    for (const [outcome, line] of cases) {
      const { w, d } = mountVisible();
      d.resolve(outcome);
      await flushPromises();
      expect(w.get(".codeblock.mmd").attributes("data-mmd-state"), JSON.stringify(outcome)).toBe("error");
      expect(w.find("pre").exists(), JSON.stringify(outcome)).toBe(true);
      expect(w.find("img").exists(), JSON.stringify(outcome)).toBe(false);
      expect(w.get(".mmd-error").text(), JSON.stringify(outcome)).toBe(line);
      expect(w.findAll("button").some((b) => b.text() === "源码" || b.text() === "图")).toBe(false);
      w.unmount();
    }
  });

  it("img @error is treated as output-invalid", async () => {
    const { w, d } = mountVisible();
    d.resolve(okOutcome());
    await flushPromises();
    await w.get("img").trigger("error");
    expect(w.get(".codeblock.mmd").attributes("data-mmd-state")).toBe("error");
    expect(w.get(".mmd-error").text()).toBe("渲染失败：output-invalid");
    expect(w.find("img").exists()).toBe(false);
    w.unmount();
  });
});

/* ---------------------------------------------------------------- generations (§4.5) */
describe("MermaidBlock — request generations", () => {
  it("a stale generation's late result never lands (text change, 300 ms debounce)", async () => {
    vi.useFakeTimers();
    try {
      const { w, d: d1 } = mountVisible();
      expect(requestMermaid).toHaveBeenCalledTimes(1);
      const d2 = queuePending();
      await w.setProps({ text: "flowchart TD\n  A-->C" });
      await vi.advanceTimersByTimeAsync(299);
      expect(requestMermaid).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestMermaid).toHaveBeenCalledTimes(2);
      d1.resolve(okOutcome({ src: "data:image/svg+xml,OLD" })); // late, stale generation
      await vi.advanceTimersByTimeAsync(0);
      expect(w.find("img").exists()).toBe(false);
      expect(w.get(".codeblock.mmd").attributes("data-mmd-state")).toBe("loading");
      d2.resolve(okOutcome({ src: "data:image/svg+xml,NEW" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(w.get("img").attributes("src")).toBe("data:image/svg+xml,NEW");
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the previous request when a new generation starts", async () => {
    vi.useFakeTimers();
    try {
      const { w } = mountVisible();
      const first = (requestMermaid.mock.calls[0]![0] as MermaidRequest).signal;
      expect(first.aborted).toBe(false);
      queuePending();
      await w.setProps({ text: 'pie\n  "a": 1' });
      await vi.advanceTimersByTimeAsync(300);
      expect(requestMermaid).toHaveBeenCalledTimes(2);
      expect(first.aborted).toBe(true);
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late result after unmount is dropped and the in-flight signal is aborted", async () => {
    const { w, d } = mountVisible();
    const signal = (requestMermaid.mock.calls[0]![0] as MermaidRequest).signal;
    w.unmount();
    expect(signal.aborted).toBe(true);
    d.resolve(okOutcome()); // must not throw, must not touch the unmounted component
    await flushPromises();
  });

  it("theme flip issues a new-key request; the older theme's late result is dropped (round-trip)", async () => {
    const { w, d: dLight } = mountVisible();
    expect((requestMermaid.mock.calls[0]![0] as MermaidRequest).theme).toBe("light");
    const dDark = queuePending();
    document.documentElement.classList.add("theme-dark");
    await vi.waitFor(() => expect(requestMermaid).toHaveBeenCalledTimes(2));
    expect((requestMermaid.mock.calls[1]![0] as MermaidRequest).theme).toBe("dark");
    // 后发先至：dark 先回，light 晚回 —— 旧主题结果必须被丢弃
    dDark.resolve(okOutcome({ src: "data:image/svg+xml,DARK" }));
    await flushPromises();
    dLight.resolve(okOutcome({ src: "data:image/svg+xml,LIGHT" }));
    await flushPromises();
    expect(w.get("img").attributes("src")).toBe("data:image/svg+xml,DARK");
    queuePending();
    document.documentElement.classList.remove("theme-dark");
    await vi.waitFor(() => expect(requestMermaid).toHaveBeenCalledTimes(3));
    expect((requestMermaid.mock.calls[2]![0] as MermaidRequest).theme).toBe("light");
    w.unmount();
  });
});

/* ---------------------------------------------------------------- 「原尺寸」 button + ResizeObserver (r3 补充二) */
describe("MermaidBlock — fit/actual-size button (ResizeObserver on .mmd-figure)", () => {
  async function okMounted(width: number) {
    const { w, d } = mountVisible();
    d.resolve(okOutcome({ width, height: 100 }));
    await flushPromises();
    return w;
  }
  const fitBtn = (w: ReturnType<typeof mount>) =>
    w.findAll("button").find((b) => b.text() === "原尺寸" || b.text() === "适应宽度");
  /** The component creates TWO ResizeObservers (fit + useCoarseClamp's) — the fit one is the
   *  observer watching the `.mmd-figure` element. */
  const fitRO = (): FakeRO =>
    FakeRO.instances
      .filter((i) => !i.disconnected)
      .find((i) => i.observed.some((el) => (el as HTMLElement).className?.includes("mmd-figure")))!;

  it("appears only while the diagram is intrinsically wider than the container (≤8192)", async () => {
    const w = await okMounted(2000);
    fitRO().fire(300); // container content box narrowed to 300px
    await nextTick();
    expect(fitBtn(w)).toBeDefined();
    fitRO().fire(3000); // container widened past the diagram
    await nextTick();
    expect(fitBtn(w)).toBeUndefined();
    fitRO().fire(250); // narrowed again — button returns (r3 补充二)
    await nextTick();
    expect(fitBtn(w)).toBeDefined();
    w.unmount();
  });

  it("never appears for a narrow diagram or one wider than 8192px", async () => {
    const narrow = await okMounted(200);
    fitRO().fire(300);
    await nextTick();
    expect(fitBtn(narrow)).toBeUndefined();
    narrow.unmount();

    const huge = await okMounted(9000);
    fitRO().fire(300);
    await nextTick();
    expect(fitBtn(huge)).toBeUndefined();
    huge.unmount();
  });

  it("toggles actual mode: aria-pressed, figure class, tabindex, button text", async () => {
    const w = await okMounted(2000);
    fitRO().fire(300);
    await nextTick();
    const btn = fitBtn(w)!;
    expect(btn.attributes("aria-pressed")).toBe("false");
    await btn.trigger("click");
    const figure = w.get(".mmd-figure");
    expect(figure.classes()).toContain("actual");
    expect(figure.attributes("tabindex")).toBe("0");
    expect(fitBtn(w)!.text()).toBe("适应宽度");
    expect(fitBtn(w)!.attributes("aria-pressed")).toBe("true");
    await fitBtn(w)!.trigger("click");
    expect(w.get(".mmd-figure").classes()).not.toContain("actual");
    expect(w.get(".mmd-figure").attributes("tabindex")).toBeUndefined();
    w.unmount();
  });
});

/* ---------------------------------------------------------------- copy (#11) */
describe("MermaidBlock — copy", () => {
  function copyBtn(w: ReturnType<typeof mount>) {
    return w.findAll("button").find((b) => b.attributes("aria-label") === "复制代码")!;
  }

  it("clipboard success → 已复制", async () => {
    stubNavigator({ writeText: vi.fn(async () => {}) });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const { w, d } = mountVisible();
    d.resolve(okOutcome());
    await flushPromises();
    await copyBtn(w).trigger("click");
    await flushPromises();
    expect(w.get('[role="status"]').text()).toBe("已复制！");
    w.unmount();
  });

  it("clipboard failure in diagram view → switches to source, selects, 已选中", async () => {
    stubNavigator({}); // no clipboard at all → useClipboard fails
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const { w, d } = mountVisible();
    d.resolve(okOutcome());
    await flushPromises();
    expect(w.find("pre").exists()).toBe(false);
    await copyBtn(w).trigger("click");
    await flushPromises();
    expect(w.find("pre").exists()).toBe(true); // switched to source first (#11)
    expect(w.get('[role="status"]').text()).toBe("已选中 — 按复制");
    expect(window.getSelection()?.toString()).toContain("flowchart TD");
    w.unmount();
  });

  it("createRange missing → 复制失败，请手动选择 (never claims 已选中)", async () => {
    stubNavigator({});
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const { w, d } = mountVisible();
    d.resolve(err("parse")); // already in source view — copy fails, select the pre directly
    await flushPromises();
    Object.defineProperty(document, "createRange", { value: undefined, configurable: true });
    try {
      await copyBtn(w).trigger("click");
      await flushPromises();
      expect(w.get('[role="status"]').text()).toBe("复制失败，请手动选择");
    } finally {
      delete (document as { createRange?: unknown }).createRange;
    }
    w.unmount();
  });
});

/* ---------------------------------------------------------------- MdBlock wiring (§6.2) */
describe("MdBlock wiring — mermaid fence routes to MermaidBlock, others stay CodeBlock", () => {
  it("mermaid fence renders .codeblock.mmd; js/plain fences stay plain .codeblock", async () => {
    const w = track(
      mount(MarkdownView, {
        props: {
          text: "```mermaid\nflowchart TD\n  A-->B\n```\n\n```js\nlet x = 1\n```\n\n```\nplain\n```",
        },
      }),
    );
    await flushPromises();
    const blocks = w.findAll(".codeblock");
    expect(blocks.length).toBe(3);
    expect(blocks[0]!.classes()).toContain("mmd");
    expect(blocks[1]!.classes()).not.toContain("mmd");
    expect(blocks[2]!.classes()).not.toContain("mmd");
    expect(blocks[1]!.find("pre").text()).toContain("let x = 1");
    w.unmount();
  });

  it("a settled mermaid fence requests through the runtime and shows its error line", async () => {
    vi.stubGlobal("IntersectionObserver", undefined); // immediate request path
    requestMermaid.mockReturnValueOnce(
      Promise.resolve({ kind: "error", reason: "engine-unavailable", message: "stub" }),
    );
    const w = track(mount(MarkdownView, { props: { text: "```mermaid\nflowchart TD\n  A-->B\n```" } }));
    await flushPromises();
    expect(requestMermaid).toHaveBeenCalledTimes(1);
    expect(w.get(".codeblock.mmd").attributes("data-mmd-state")).toBe("error");
    expect(w.get(".mmd-error").text()).toBe("渲染引擎不可用，已显示源码");
    expect(w.find("pre").text()).toContain("flowchart TD");
    w.unmount();
  });
});
