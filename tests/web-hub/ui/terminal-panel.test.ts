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
  mocks.mount.mockImplementation(async (surface: HTMLElement) => {
    if (fails) throw new Error("当前浏览器不支持 WebGL2，终端未启动。");
    const helper = document.createElement("textarea");
    surface.append(helper);
    terminal.focus.mockImplementation(() => helper.focus());
    terminal.paste.mockImplementation((value: string) => mocks.data(value));
    return renderer;
  });
  let sink: (name: string, data: unknown) => void = () => {};
  const request = vi.fn(async (op: string, body?: any) =>
    op === "list"
      ? { ok: true, revision: 1, rows: [fact] }
      : op === "attach"
        ? { ...attachment }
        : op === "input"
          ? { ok: true, acceptedThrough: body.inputSeq }
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
  it.each(["zh", "en"] as const)(
    "%s startup capability failure explains safe manual retry without an automatic shell open",
    async (lang) => {
      const { w, request } = setup();
      setLangOverride(lang);
      await flushPromises();
      const ticket = {
        v: 1,
        bootId: "boot",
        ticketId: "ticket",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        ownerBinding: {
          listener: "loopback",
          principal: "principal",
          sidTag: "sid",
          agentKey: "agent",
          sessionId: "session",
          epoch: "epoch",
          ownerInstance: "owner",
        },
        payloadDigest: "a".repeat(64),
        mac: "b".repeat(64),
      };
      request.mockImplementation(
        async (op) =>
          (op === "prepare"
            ? { ok: true, openId: "ticket", createTicket: ticket }
            : op === "open"
              ? { ok: false, code: "E_BACKEND_CAPABILITY", effect: "unknown" }
              : op === "state"
                ? { ok: true, fact: { state: "unknown", effect: "unknown" } }
                : { ok: true, revision: 2 }) as any,
      );
      w.getComponent(TerminalList).vm.$emit("create");
      await flushPromises();
      const text = w.get('[role="alert"]').text();
      expect(text).toContain(lang === "zh" ? "手动重试" : "manually retrying");
      expect(text).toContain(lang === "zh" ? "确认原请求状态" : "original request");
      expect(text).not.toContain(lang === "zh" ? "未启动 shell" : "No shell was started");
      expect(request.mock.calls.filter(([op]) => op === "open")).toHaveLength(1);
      expect(request.mock.calls.filter(([op]) => op === "prepare")).toHaveLength(1);
      expect(request.mock.calls.filter(([op]) => op === "state")).toHaveLength(1);
    },
  );
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
  it("confirms multiline paste after modal removal/focus restore, and never sends cancelled text", async () => {
    const { w, sink, request, renderer } = setup();
    await flushPromises();
    w.getComponent(TerminalList).vm.$emit("attach", fact);
    await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledOnce());
    await flushPromises();
    const send = (event: any) =>
      sink("terminal", {
        agentKey: "agent",
        attachmentId: "attachment",
        connectionInstance: "instance",
        event: {
          v: 1,
          sessionId: "session",
          epoch: "epoch",
          ownerInstance: "owner",
          termId: "term",
          revision: 2,
          ...event,
        },
      });
    send({
      kind: "replay_begin",
      attemptId: "attempt",
      replayEpoch: "replay",
      S: 0,
      N0: 0,
      deadlineAt: Date.now() + 3000,
    });
    await flushPromises();
    send({
      kind: "cutover",
      attemptId: "attempt",
      newLiveEpoch: "live",
      replayEnd: 0,
      liveFrom: 0,
      gap: { from: 0, to: 0 },
      resetParser: true,
    });
    await nextTick();
    renderer.focus();
    const helper = w.get("[data-terminal-input] textarea").element;
    const paste = () => {
      const e = new Event("paste", { bubbles: true, composed: true, cancelable: true });
      Object.defineProperty(e, "clipboardData", { value: { getData: () => "echo one\necho two" } });
      helper.dispatchEvent(e);
      return e;
    };
    expect(paste().defaultPrevented).toBe(true);
    await nextTick();
    expect(w.find('[aria-modal="true"]').exists()).toBe(true);
    expect(request.mock.calls.some((c) => c[0] === "input")).toBe(false);
    await w.get("[data-terminal-cancel]").trigger("click");
    expect(request.mock.calls.some((c) => c[0] === "input")).toBe(false);
    renderer.focus();
    paste();
    await nextTick();
    const buttons = w.get('[aria-modal="true"]').findAll("button");
    await buttons[1]!.trigger("click");
    await flushPromises();
    const input = request.mock.calls.find((c) => c[0] === "input")?.[1];
    expect(input?.inputKind).toBe("user");
    expect(atob(input?.bytesB64)).toBe("echo one\necho two");
    expect(w.find('[aria-modal="true"]').exists()).toBe(false);
  });
  it("supports keyboard panel-height adjustment without recreating the renderer", async () => {
    const { w } = setup();
    await flushPromises();
    await w.get('[role="separator"]').trigger("keydown", { key: "ArrowUp" });
    expect((w.element as HTMLElement).style.height).toBe("340px");
    expect(mocks.mount).not.toHaveBeenCalled();
  });
  it.each(["zh", "en"])(
    "uses English compact unknown markers in %s and keeps missing-metadata advice in a separate paragraph",
    (lang) => {
      setLangOverride(lang as "zh" | "en");
      const w = mount(TerminalList, { props: { rows: [fact as any], busy: false } });
      wrappers.push(w);
      expect(w.get("li strong").text()).toBe("unknown");
      expect(w.get("li span").text()).toBe("unknown");
      expect(
        w
          .findAll("p")
          .some((p) =>
            lang === "zh" ? p.text().includes("元数据不可用") : p.text().includes("metadata is unavailable"),
          ),
      ).toBe(true);
    },
  );
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
