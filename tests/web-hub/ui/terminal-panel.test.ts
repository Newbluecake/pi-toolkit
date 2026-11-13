// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import TerminalPanel from "../../../src/web-hub/ui/src/components/terminal/TerminalPanel.vue";
import TerminalList from "../../../src/web-hub/ui/src/components/terminal/TerminalList.vue";
import TerminalChrome from "../../../src/web-hub/ui/src/components/terminal/TerminalChrome.vue";
import IconSprite from "../../../src/web-hub/ui/src/icons/IconSprite.vue";
import { terminalOwnsKey } from "../../../src/web-hub/ui/src/logic/terminalFocus.js";
import { setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
const mocks = vi.hoisted(() => ({ mount: vi.fn(), data: vi.fn(), binary: vi.fn() }));
vi.mock("../../../src/web-hub/ui/src/components/terminal/renderer.js", () => ({
  mountTerminal: mocks.mount,
  TERMINAL_RENDERER_FACTORY: Symbol("factory"),
}));
const fact = {
  termId: "term",
  reservationId: "reservation",
  revision: 1,
  state: "live",
  nextInputSeq: 0,
  baseOffset: 0,
  nextOffset: 0,
  deadlines: { inputIdleAt: Date.now() + 10000, lifetimeAt: Date.now() + 20000, parentExpiresAt: Date.now() + 30000 },
};
const attachment = {
  ok: true,
  ...fact,
  attachmentId: "attachment",
  writerLease: "lease",
  replayMode: "cold",
  sessionOrdinal: 7,
  userLabel: "<admin>",
  hostLabel: "host",
  cwd: "/trusted",
  shellName: "bash",
  ownerLabel: "This login",
};
const wrappers: Array<{ unmount(): void }> = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  vi.useRealTimers();
  document.body.textContent = "";
  document.head.querySelectorAll("link").forEach((l) => l.remove());
  vi.clearAllMocks();
});
function setup(fails = false) {
  setLangOverride("zh");
  const terminal = {
    cols: 80,
    rows: 24,
    options: {},
    reset: vi.fn(),
    focus: vi.fn(),
    paste: vi.fn(),
    onData: (fn: any) => {
      mocks.data.mockImplementation(fn);
      return { dispose: vi.fn() };
    },
    onBinary: (fn: any) => {
      mocks.binary.mockImplementation(fn);
      return { dispose: vi.fn() };
    },
  };
  const renderer = {
    terminal,
    focus: terminal.focus,
    fit: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(async () => {}),
    state: { phase: "ready", rebuilds: 0 },
  };
  mocks.mount.mockImplementation(async () => {
    if (fails) throw new Error("当前浏览器不支持 WebGL2，终端未启动。");
    return renderer;
  });
  let sink: (name: string, data: unknown) => void = () => {};
  const request = vi.fn(async (op: string) =>
    op === "list"
      ? { ok: true, revision: 1, rows: [fact] }
      : op === "attach"
        ? { ...attachment }
        : { ok: true, revision: 2 },
  );
  const hub = {
    state: ref({ clientId: "client" }),
    terminal: { request },
    terminalEvents(fn: any) {
      sink = fn;
      fn("terminal_connection", {
        connectionInstance: "instance",
        connectionToken: "token",
        expiresAt: Date.now() + 60000,
      });
      return vi.fn();
    },
  };
  const w = mount(TerminalPanel, {
    props: { hub: hub as any, scope: { agentKey: "agent", expect: { sessionId: "session", epoch: "epoch" } } },
    attachTo: document.body,
  });
  wrappers.push(w);
  return { w, request, renderer, sink: (name: string, data: unknown) => sink(name, data) };
}
describe("TerminalPanel / Chrome / List (§7.1–7.4)", () => {
  it("opens the server list after a fresh mount without loading WebGL or creating a shell", async () => {
    const { w, request } = setup();
    await flushPromises();
    expect(request.mock.calls.map((c) => c[0])).toEqual(["list"]);
    expect(mocks.mount).not.toHaveBeenCalled();
    expect(w.findComponent(TerminalList).exists()).toBe(true);
    expect(w.text()).toContain("非沙盒");
    expect(w.text()).toContain("Ctrl+Shift+F6");
  });
  it("attaches the listed terminal; maximize/restore/Esc preserve the same renderer and shell", async () => {
    const { w, request, renderer } = setup();
    await flushPromises();
    await w.getComponent(TerminalList).vm.$emit("attach", fact);
    await flushPromises();
    await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledTimes(1));
    expect(request.mock.calls.filter((c) => c[0] === "attach")).toHaveLength(1);
    expect(w.text()).toContain("#7");
    expect(w.text()).toContain("<admin>");
    expect(w.find("admin").exists()).toBe(false);
    expect(w.text()).toContain("/trusted");
    w.getComponent(TerminalChrome).vm.$emit("maximize");
    await nextTick();
    expect(w.classes()).toContain("is-maximized");
    await w.trigger("keydown", { key: "Escape" });
    expect(w.classes()).toContain("is-maximized");
    w.getComponent(TerminalChrome).vm.$emit("maximize");
    await nextTick();
    expect(w.classes()).not.toContain("is-maximized");
    expect(renderer.dispose).not.toHaveBeenCalled();
    expect(mocks.mount).toHaveBeenCalledTimes(1);
  });
  it("background releases a lease but never terminates the shell", async () => {
    const { w, request } = setup();
    await flushPromises();
    w.getComponent(TerminalList).vm.$emit("attach", fact);
    await flushPromises();
    w.getComponent(TerminalChrome).vm.$emit("background");
    await flushPromises();
    expect(w.emitted("background")).toHaveLength(1);
    expect(request.mock.calls.some((c) => c[0] === "detach")).toBe(true);
    expect(request.mock.calls.some((c) => c[0] === "close")).toBe(false);
  });
  it("WebGL unavailable gives the actual reason before any prepare/open/attach", async () => {
    const { w, request } = setup(true);
    await flushPromises();
    w.getComponent(TerminalList).vm.$emit("attach", fact);
    await flushPromises();
    expect(w.get('[role="alert"]').text()).toContain("WebGL2");
    expect(request.mock.calls.map((c) => c[0])).toEqual(["list"]);
  });
  it("requires explicit terminate confirmation; Escape cancels only that modal", async () => {
    const { w, request } = setup();
    await flushPromises();
    w.getComponent(TerminalList).vm.$emit("terminate", fact);
    await nextTick();
    expect(w.find('[aria-modal="true"]').exists()).toBe(true);
    await w.get('[aria-modal="true"]').trigger("keydown", { key: "Escape" });
    expect(w.find('[aria-modal="true"]').exists()).toBe(false);
    expect(request.mock.calls.some((c) => c[0] === "close")).toBe(false);
  });
  it("disconnect disposes WebGL and clears panel/list metadata immediately", async () => {
    const { w, renderer, sink } = setup();
    await flushPromises();
    w.getComponent(TerminalList).vm.$emit("attach", fact);
    await flushPromises();
    sink("disconnected", null);
    await nextTick();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(w.text()).not.toContain("/trusted");
    expect(w.text()).not.toContain("<admin>");
  });
  it("does not turn missing metadata into a synthetic ordinal/time/writer value", () => {
    const w = mount(TerminalList, { props: { rows: [fact as any], busy: false } });
    wrappers.push(w);
    expect(w.text()).toContain("元数据不可用");
    expect(w.text()).not.toContain("#term");
    expect(w.text()).not.toContain("background");
    expect(w.find("time").exists()).toBe(false);
  });
  it("adds the jobs symbol only with the hub feature prop; off markup is byte-identical after toggling", async () => {
    const w = mount(IconSprite);
    wrappers.push(w);
    const off = w.html();
    expect(w.find("#i-jobs-list").exists()).toBe(false);
    await w.setProps({ terminalEnabled: true });
    expect(w.find("#i-jobs-list").exists()).toBe(true);
    await w.setProps({ terminalEnabled: false });
    expect(w.html()).toBe(off);
  });
  it("keyboard ownership includes the xterm helper textarea but never chrome/higher modal focus", () => {
    const surface = document.createElement("div");
    surface.setAttribute("data-terminal-input", "");
    const textarea = document.createElement("textarea");
    surface.append(textarea);
    const button = document.createElement("button");
    document.body.append(surface, button);
    textarea.focus();
    let owned = false;
    surface.addEventListener("keydown", (e) => {
      owned = terminalOwnsKey(e);
    });
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(owned).toBe(true);
    button.focus();
    owned = true;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(owned).toBe(false);
  });
});
