// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import TerminalPanelV2 from "../../../src/web-hub/ui/src/components/terminal/v2/TerminalPanelV2.vue";
import { TERMINAL_RENDERER_FACTORY } from "../../../src/web-hub/ui/src/components/terminal/renderer-port.js";
import type { WebglUiState } from "../../../src/web-hub/ui/src/components/terminal/webgl-lifecycle.js";
import { setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import { attachedFrameV2, createTerminalMockV2, rowV2, scopeV2, termV2, turnV2 } from "./terminal-v2-fixtures.js";

const wrappers: VueWrapper[] = [];

function setup(options: { empty?: boolean; rendererFailure?: boolean } = {}) {
  setLangOverride("zh");
  const mock = createTerminalMockV2();
  if (options.empty) {
    mock.rows.splice(0);
    for (const dimension of Object.values(mock.quota)) {
      dimension.used = 0;
      dimension.unknown = 0;
    }
  }
  const data = vi.fn();
  const binary = vi.fn();
  const terminal = {
    cols: 80,
    rows: 24,
    options: {},
    reset: vi.fn(),
    focus: vi.fn(),
    paste: vi.fn((value: string) => data(value)),
    onData: (callback: (value: string) => void) => {
      data.mockImplementation(callback);
      return { dispose: vi.fn() };
    },
    onBinary: (callback: (value: string) => void) => {
      binary.mockImplementation(callback);
      return { dispose: vi.fn() };
    },
  };
  const renderer = {
    terminal,
    focus: terminal.focus,
    fit: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(async () => {}),
    setFontSize: vi.fn(),
  };
  let rendererState: ((state: WebglUiState) => void) | undefined;
  const factory = vi.fn(async (surface: HTMLElement, factoryOptions: { onStateChange?(state: WebglUiState): void }) => {
    rendererState = factoryOptions.onStateChange;
    if (options.rendererFailure) throw new Error("WebGL2 unavailable");
    const textarea = document.createElement("textarea");
    surface.append(textarea);
    terminal.focus.mockImplementation(() => textarea.focus());
    return renderer;
  });
  const wrapper = mount(TerminalPanelV2, {
    props: { transport: mock.transport, scope: scopeV2, storage: sessionStorage },
    global: { provide: { [TERMINAL_RENDERER_FACTORY]: factory } },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  const vm = wrapper.vm as unknown as {
    open(): Promise<boolean>;
    restore(): Promise<boolean>;
    collapse(): void;
  };
  return {
    ...mock,
    wrapper,
    vm,
    factory,
    renderer,
    data,
    binary,
    rendererState: (state: WebglUiState) => rendererState?.(state),
  };
}

async function openPanel(context: ReturnType<typeof setup>, restore = false) {
  const pending = restore ? context.vm.restore() : context.vm.open();
  await flushPromises();
  await turnV2();
  expect(context.views).toHaveLength(1);
  const view = context.views[0]!;
  view.emit(attachedFrameV2(view.body.termId));
  await pending;
  await flushPromises();
}

async function readyPanel(context: ReturnType<typeof setup>, index = 0) {
  const view = context.views[index]!;
  view.emit({ t: "replay-end", offset: 0 });
  await turnV2();
  view.emit({ t: "ready", offset: 0 });
  await turnV2();
  await flushPromises();
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.textContent = "";
  document.head.querySelectorAll("link").forEach((link) => link.remove());
  sessionStorage.clear();
  localStorage.removeItem("pwh_terminal_font_size");
  vi.clearAllMocks();
});

describe("TerminalPanelV2 explicit open and tabs", () => {
  it("mount/hydration does no request, renderer load or create", async () => {
    const context = setup();
    await flushPromises();
    expect(context.request).not.toHaveBeenCalled();
    expect(context.factory).not.toHaveBeenCalled();
    expect(context.wrapper.find("#terminal-v2-panel").exists()).toBe(false);
  });

  it("WebGL failure stops before list/create and displays the real reason", async () => {
    const context = setup({ rendererFailure: true });
    expect(await context.vm.open()).toBe(false);
    await flushPromises();
    expect(context.factory).toHaveBeenCalledOnce();
    expect(context.request).not.toHaveBeenCalled();
    expect(context.wrapper.get('[role="alert"]').text()).toContain("WebGL2");
  });

  it("first open uses ensure-empty and + uses new with one renderer", async () => {
    const context = setup({ empty: true });
    await openPanel(context);
    await readyPanel(context);
    expect(context.request.mock.calls.find(([op]) => op === "create")?.[1]).toMatchObject({ mode: "ensure-empty" });
    expect(context.factory).toHaveBeenCalledOnce();
    await context.wrapper.get(".terminal-v2-new-tab").trigger("click");
    await turnV2();
    await flushPromises();
    expect(context.request.mock.calls.filter(([op]) => op === "create")).toHaveLength(2);
    expect(context.request.mock.calls.filter(([op]) => op === "create").at(-1)?.[1]).toMatchObject({ mode: "new" });
    expect(context.views).toHaveLength(2);
    context.views[1]!.emit(attachedFrameV2(context.views[1]!.body.termId));
    await flushPromises();
    expect(context.wrapper.findAll('[role="tab"]')).toHaveLength(2);
    expect(context.factory).toHaveBeenCalledOnce();
  });

  it("switch/collapse/reopen detach only and preserve tabs without create/close", async () => {
    const context = setup();
    context.rows.push(rowV2("U".repeat(22), 2));
    await openPanel(context);
    await readyPanel(context);
    const tabs = context.wrapper.findAll('[role="tab"]');
    await tabs[1]!.trigger("click");
    await turnV2();
    expect(context.views[0]!.signal.aborted).toBe(true);
    context.views[1]!.emit(attachedFrameV2("U".repeat(22)));
    await flushPromises();
    await context.wrapper.get(".terminal-v2-chrome-actions button:last-child").trigger("click");
    expect(context.wrapper.find("#terminal-v2-panel").exists()).toBe(false);
    expect(context.views[1]!.signal.aborted).toBe(true);
    expect(context.request.mock.calls.some(([op]) => op === "close")).toBe(false);
    const creates = context.request.mock.calls.filter(([op]) => op === "create").length;
    const reopening = context.vm.open();
    await turnV2();
    await flushPromises();
    expect(context.views).toHaveLength(3);
    context.views[2]!.emit(attachedFrameV2(context.views[2]!.body.termId));
    await reopening;
    expect(context.request.mock.calls.filter(([op]) => op === "create")).toHaveLength(creates);
    expect(context.request.mock.calls.some(([op]) => op === "close")).toBe(false);
    expect(context.factory).toHaveBeenCalledTimes(2);
  });

  it("close of a live tab confirms, calls close shell and leaves a non-creating empty state", async () => {
    const context = setup();
    await openPanel(context);
    await readyPanel(context);
    await context.wrapper.get(".terminal-v2-tab-close").trigger("click");
    expect(context.wrapper.get('[aria-modal="true"]').text()).toContain("bash 1");
    expect(context.request.mock.calls.some(([op]) => op === "close")).toBe(false);
    await context.wrapper.get('[aria-modal="true"]').trigger("keydown", { key: "Escape" });
    expect(context.wrapper.find('[aria-modal="true"]').exists()).toBe(false);
    await context.wrapper.get(".terminal-v2-tab-close").trigger("click");
    await context.wrapper.get('[aria-modal="true"] button:last-child').trigger("click");
    await turnV2();
    await flushPromises();
    expect(context.request.mock.calls.filter(([op]) => op === "close")).toHaveLength(1);
    expect(context.wrapper.text()).toContain("没有终端标签");
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
  });

  it("restore shows cold unknown read-only and leaves + available with quota balance", async () => {
    const context = setup({ empty: true });
    context.unknownResources.push({ allocationTag: "A".repeat(22), state: "cleanup-unknown" });
    for (const dimension of Object.values(context.quota)) {
      dimension.used = 1;
      dimension.unknown = 1;
    }
    const restoring = context.vm.restore();
    await turnV2();
    await flushPromises();
    await restoring;
    expect(context.request.mock.calls.map(([op]) => op)).toEqual(["list"]);
    expect(context.wrapper.text()).toContain("Cleanup unknown");
    expect(context.wrapper.text()).toContain("只读");
    expect(context.wrapper.get(".terminal-v2-new-tab").attributes("disabled")).toBeUndefined();
    expect(context.views).toHaveLength(0);
  });
});

describe("TerminalPanelV2 keyboard, rename, paste and renderer recovery", () => {
  it("supports roving tab navigation and normalized text-only rename", async () => {
    const context = setup();
    context.rows.push(rowV2("U".repeat(22), 2));
    await openPanel(context);
    await readyPanel(context);
    const first = context.wrapper.get('[role="tab"]');
    await first.trigger("keydown", { key: "ArrowRight" });
    await turnV2();
    const selected = context.wrapper.get('[role="tab"][aria-selected="true"]');
    expect(selected.text()).toContain("bash 2");
    context.views[1]!.emit(attachedFrameV2("U".repeat(22)));
    await flushPromises();
    await selected.trigger("dblclick");
    const input = context.wrapper.get(".terminal-v2-rename-input");
    await input.setValue("  <img>😀  ");
    await input.trigger("keydown", { key: "Enter" });
    await turnV2();
    await flushPromises();
    expect(context.request.mock.calls.find(([op]) => op === "rename")?.[1]).toMatchObject({ name: "<img>😀" });
    expect(context.wrapper.text()).toContain("<img>😀");
    expect(context.wrapper.find("img").exists()).toBe(false);
  });

  it("TTY Esc reaches input while chrome Esc only restores maximization", async () => {
    const context = setup();
    await openPanel(context);
    await readyPanel(context);
    context.request.mockClear();
    const textarea = context.wrapper.get("[data-terminal-input] textarea");
    const helper = textarea.element;
    helper.addEventListener("keydown", () => context.data("\x1b"));
    helper.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await turnV2();
    const input = context.request.mock.calls.find(([op]) => op === "input")?.[1];
    expect(input && "bytesB64" in input ? atob(input.bytesB64) : "").toBe("\x1b");
    const maximize = context.wrapper.get('[aria-label="最大化终端"]');
    await maximize.trigger("click");
    expect(context.wrapper.get("#terminal-v2-panel").classes()).toContain("is-maximized");
    await context.wrapper.get("[data-terminal-focus]").trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(context.wrapper.get("#terminal-v2-panel").classes()).not.toContain("is-maximized");
  });

  it("confirms multiline paste and sends it as user input only after modal removal", async () => {
    const context = setup();
    await openPanel(context);
    await readyPanel(context);
    context.request.mockClear();
    context.renderer.focus();
    const helper = context.wrapper.get("[data-terminal-input] textarea").element;
    const event = new Event("paste", { bubbles: true, composed: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "echo one\necho two" } });
    helper.dispatchEvent(event);
    await nextTick();
    expect(event.defaultPrevented).toBe(true);
    expect(context.wrapper.find('[aria-modal="true"]').exists()).toBe(true);
    expect(context.request.mock.calls.some(([op]) => op === "input")).toBe(false);
    await context.wrapper.get('[aria-modal="true"] button:last-child').trigger("click");
    await turnV2();
    const input = context.request.mock.calls.find(([op]) => op === "input")?.[1];
    expect(input && "bytesB64" in input ? atob(input.bytesB64) : "").toBe("echo one\necho two");
    expect(input && "kind" in input ? input.kind : "").toBe("user");
  });

  it("WebGL loss reattaches the same term without create or a second panel renderer factory", async () => {
    const context = setup();
    await openPanel(context);
    await readyPanel(context);
    context.rendererState({ phase: "recovering", rebuilds: 1, reason: "lost" });
    expect(context.views[0]!.signal.aborted).toBe(true);
    context.rendererState({ phase: "ready", rebuilds: 1, reason: "ready" });
    await turnV2();
    await flushPromises();
    expect(context.views).toHaveLength(2);
    expect(context.views[1]!.body.termId).toBe(termV2);
    expect(context.factory).toHaveBeenCalledOnce();
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
  });
});
