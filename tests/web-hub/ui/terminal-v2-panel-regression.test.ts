// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import TerminalPanelV2 from "../../../src/web-hub/ui/src/components/terminal/v2/TerminalPanelV2.vue";
import { TERMINAL_RENDERER_FACTORY } from "../../../src/web-hub/ui/src/components/terminal/renderer-port.js";
import type { WebglUiState } from "../../../src/web-hub/ui/src/components/terminal/webgl-lifecycle.js";
import { setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import { attachedFrameV2, createTerminalMockV2, scopeV2, termV2, turnV2 } from "./terminal-v2-fixtures.js";

const wrappers: VueWrapper[] = [];
const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setup(rendererGate?: Promise<unknown>, styleLoad = true) {
  setLangOverride("zh");
  const mock = createTerminalMockV2();
  const terminal = {
    cols: 80,
    rows: 24,
    options: {},
    reset: vi.fn(),
    focus: vi.fn(),
    paste: vi.fn(),
    onData: () => ({ dispose: vi.fn() }),
    onBinary: () => ({ dispose: vi.fn() }),
  };
  const renderer = {
    terminal,
    focus: terminal.focus,
    fit: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(async () => {}),
    setFontSize: vi.fn(),
  };
  let onState: ((state: WebglUiState) => void) | undefined;
  const factory = vi.fn(async (surface: HTMLElement, options: { onStateChange?(state: WebglUiState): void }) => {
    onState = options.onStateChange;
    if (rendererGate) await rendererGate;
    const textarea = document.createElement("textarea");
    surface.append(textarea);
    return renderer;
  });
  const wrapper = mount(TerminalPanelV2, {
    props: { transport: mock.transport, scope: scopeV2 },
    global: { provide: { [TERMINAL_RENDERER_FACTORY]: factory } },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  if (styleLoad)
    document.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.dispatchEvent(new Event("load"));
  const vm = wrapper.vm as unknown as { open(): Promise<boolean>; collapse(): void };
  return { ...mock, wrapper, vm, factory, renderer, state: (state: WebglUiState) => onState?.(state) };
}

async function open(context: ReturnType<typeof setup>) {
  const opening = context.vm.open();
  await turnV2();
  await flushPromises();
  const view = context.views[0]!;
  view.emit(attachedFrameV2(view.body.termId));
  await opening;
}

async function ready(context: ReturnType<typeof setup>) {
  context.views[0]!.emit({ t: "replay-end", offset: 0 });
  await turnV2();
  context.views[0]!.emit({ t: "ready", offset: 0 });
  await turnV2();
  await flushPromises();
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.useRealTimers();
  sessionStorage.clear();
  document.body.textContent = "";
  document.head.querySelectorAll("link").forEach((link) => link.remove());
  if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
});

describe("P4 panel lifecycle regression", () => {
  it("collapse during lazy renderer loading prevents list/create", async () => {
    const gate = deferred<unknown>();
    const context = setup(gate.promise);
    const opening = context.vm.open();
    await turnV2();
    expect(context.factory).toHaveBeenCalledOnce();
    context.vm.collapse();
    gate.resolve(undefined);
    await opening;
    expect(context.request).not.toHaveBeenCalled();
    expect(context.views).toHaveLength(0);
  });

  it("renderer invalidation while list is pending cancels the unsent ensure", async () => {
    const list = deferred<unknown>();
    const context = setup();
    context.rows.splice(0);
    context.request.mockImplementation((op) => {
      if (op === "list") return list.promise as never;
      return Promise.resolve({ ok: false, code: "E_LIMIT", effect: "none" });
    });
    const opening = context.vm.open();
    await turnV2();
    await flushPromises();
    context.state({ phase: "unavailable", rebuilds: 0, reason: "WebGL lost" });
    list.resolve({
      ok: true,
      hubInstance: "H".repeat(22),
      revision: 1,
      rows: [],
      unknownResources: [],
      quota: {
        session: { used: 0, unknown: 0, limit: 2 },
        principal: { used: 0, unknown: 0, limit: 2 },
        total: { used: 0, unknown: 0, limit: 8 },
      },
    });
    await opening;
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
  });

  it("actual document.hidden/visibilitychange pauses and resumes only the same-term view", async () => {
    vi.useFakeTimers();
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const context = setup();
    await open(context);
    await ready(context);
    context.views[0]!.fail();
    await turnV2();
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(context.views).toHaveLength(1);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await turnV2();
    expect(context.views).toHaveLength(2);
    expect(context.views[1]!.body.termId).toBe(termV2);
  });
});

describe("P4 F7 rename uses code points rather than UTF-16 maxlength", () => {
  it("25 astral code points are rejected without a UTF-16 maxlength attribute", async () => {
    const context = setup();
    await open(context);
    await context.wrapper.get('[role="tab"]').trigger("dblclick");
    const input = context.wrapper.get(".terminal-v2-rename-input");
    expect(input.attributes("maxlength")).toBeUndefined();
    await input.setValue("😀".repeat(25));
    await input.trigger("keydown", { key: "Enter" });
    expect(context.request.mock.calls.some(([op]) => op === "rename")).toBe(false);
    expect(input.attributes("aria-invalid")).toBe("true");
  });

  it("24 astral code points / exactly 96 UTF-8 bytes are accepted intact", async () => {
    const context = setup();
    await open(context);
    await context.wrapper.get('[role="tab"]').trigger("dblclick");
    const input = context.wrapper.get(".terminal-v2-rename-input");
    const name = "😀".repeat(24);
    await input.setValue(name);
    await input.trigger("keydown", { key: "Enter" });
    await turnV2();
    const body = context.request.mock.calls.find(([op]) => op === "rename")?.[1];
    expect(body && "name" in body ? body.name : "").toBe(name);
  });

  it("24 CJK code points remain valid and surrounding whitespace is normalized", async () => {
    const context = setup();
    await open(context);
    await context.wrapper.get('[role="tab"]').trigger("dblclick");
    const input = context.wrapper.get(".terminal-v2-rename-input");
    await input.setValue(`  ${"工".repeat(24)}  `);
    await input.trigger("keydown", { key: "Enter" });
    await turnV2();
    const body = context.request.mock.calls.find(([op]) => op === "rename")?.[1];
    expect(body && "name" in body ? body.name : "").toBe("工".repeat(24));
  });
});

describe("P4 bounded panel stylesheet lifecycle", () => {
  const style = () => document.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!;
  it("no renderer/list/create/input until original panel CSS load; load then permits explicit open", async () => {
    const context = setup(undefined, false),
      pending = context.vm.open();
    await flushPromises();
    expect(context.factory).not.toHaveBeenCalled();
    expect(context.request).not.toHaveBeenCalled();
    expect(context.wrapper.get(".terminal-v2-new-tab").attributes("disabled")).toBeDefined();
    style().dispatchEvent(new Event("load"));
    await flushPromises();
    await turnV2();
    expect(context.factory).toHaveBeenCalledOnce();
    expect(context.views).toHaveLength(1);
    context.views[0]!.emit(attachedFrameV2(context.views[0]!.body.termId));
    expect(await pending).toBe(true);
    expect(context.request.mock.calls.some(([op]) => op === "input")).toBe(false);
  });
  it("CSS error is terminal-only and sticky; a late original load cannot enable create/input", async () => {
    const context = setup(undefined, false),
      link = style(),
      late = link.onload,
      pending = context.vm.open();
    link.dispatchEvent(new Event("error"));
    expect(await pending).toBe(false);
    await flushPromises();
    expect(context.wrapper.get('[role="alert"]').text()).toContain("E_PANEL_CSS_LOAD");
    late?.call(link, new Event("load"));
    expect(await context.vm.open()).toBe(false);
    expect(context.factory).not.toHaveBeenCalled();
    expect(context.request).not.toHaveBeenCalled();
    expect(link.isConnected).toBe(false);
  });
  it("CSS load has a real5s logical bound, removes original link, and ignores late success", async () => {
    vi.useFakeTimers();
    const context = setup(undefined, false),
      link = style(),
      late = link.onload,
      pending = context.vm.open();
    await vi.advanceTimersByTimeAsync(4999);
    expect(context.factory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(false);
    await flushPromises();
    expect(context.wrapper.get('[role="alert"]').text()).toContain("E_PANEL_CSS_DEADLINE");
    late?.call(link, new Event("load"));
    expect(await context.vm.open()).toBe(false);
    expect(context.factory).not.toHaveBeenCalled();
    expect(context.request).not.toHaveBeenCalled();
    expect(link.isConnected).toBe(false);
  });
  it("unmount aborts pending CSS and late old-lifecycle load cannot unlock a replacement panel", async () => {
    const old = setup(undefined, false),
      oldLink = style(),
      late = oldLink.onload,
      pending = old.vm.open();
    old.wrapper.unmount();
    expect(await pending).toBe(false);
    const current = setup(undefined, false),
      newLink = style(),
      opening = current.vm.open();
    late?.call(oldLink, new Event("load"));
    await flushPromises();
    expect(old.factory).not.toHaveBeenCalled();
    expect(current.factory).not.toHaveBeenCalled();
    expect(current.request).not.toHaveBeenCalled();
    newLink.dispatchEvent(new Event("load"));
    await flushPromises();
    await turnV2();
    current.views[0]!.emit(attachedFrameV2(current.views[0]!.body.termId));
    expect(await opening).toBe(true);
    expect(old.request).not.toHaveBeenCalled();
  });
});
