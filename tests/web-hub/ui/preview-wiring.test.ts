// @vitest-environment happy-dom
/**
 * PV6 wiring (web-hub-preview plan v3 §4.6 + 修订 7, package PV6): the transcript components
 * now render through `PathText` against the App-level `PREVIEW_CTX`.
 *
 * - settled assistant/user text with a cwd path ⇒ `.path-ref` segments; click passes the
 *   `:line[:col]`-stripped path to `handle.open`;
 * - streaming assistant messages stay plain (`PATH_REFERENCES_SUSPENDED`), re-scan once settled;
 * - link text never carries `.path-ref` (the anchor owns the interaction);
 * - scope loss (session switch / deselect) ⇒ previously clickable paths render plain again;
 * - ToolCard: ONLY the Input section's `argsText` goes through `PathText` — the summary row
 *   stays free of interactive elements (details 开合 semantics, 修订 7), Live/Output untouched;
 * - navigate regression (v3-1): mounting the fully-wired `App.vue`, the SP13 navigate callback
 *   still lands on the real hash route (`location.hash` changes) and `PREVIEW_CTX` is provided.
 */
import { mount } from "@vue/test-utils";
import { defineComponent, h, inject, nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../../src/web-hub/ui/src/App.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import ToolCard from "../../../src/web-hub/ui/src/components/transcript/ToolCard.vue";
import TxAssistant from "../../../src/web-hub/ui/src/components/transcript/TxAssistant.vue";
import TxUser from "../../../src/web-hub/ui/src/components/transcript/TxUser.vue";
import type { AssistantView } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import type {
  HubHandle,
  PreviewHandle,
  PreviewPathScope,
  PreviewView,
  ToolView,
} from "../../../src/web-hub/ui/src/types.js";

const SCOPE: PreviewPathScope = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true };

function makeHandle(initialScope: PreviewPathScope | null): {
  handle: PreviewHandle;
  open: ReturnType<typeof vi.fn>;
  scope: Ref<PreviewPathScope | null>;
} {
  const open = vi.fn();
  const scope = ref(initialScope);
  const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;
  return {
    open,
    scope,
    handle: { view, scope, open, close: vi.fn(), retry: vi.fn(), dispose: vi.fn() },
  };
}

function provideOf(handle: PreviewHandle): Record<symbol, unknown> {
  return { [PREVIEW_CTX as symbol]: { handle, plaintext: false } satisfies PreviewContext };
}

function assistant(partial: Partial<AssistantView> & Pick<AssistantView, "blocks">): AssistantView {
  return { model: "", costUsd: undefined, streaming: false, errorText: "", timestamp: undefined, ...partial };
}

describe("PV6 wiring — transcript × PathText (plan v3 §4.6)", () => {
  it("settled assistant text: a cwd path renders as .path-ref and click opens the stripped path", async () => {
    const { handle, open } = makeHandle(SCOPE);
    const wrapper = mount(TxAssistant, {
      props: {
        assistant: assistant({ blocks: [{ kind: "text", text: "opened /p/src/a.ts:12:3 for you" }] }),
        truncated: false,
      },
      global: { provide: provideOf(handle) },
    });
    const refEl = wrapper.get(".path-ref");
    expect(refEl.text()).toBe("/p/src/a.ts:12:3"); // display keeps the suffix (§4.6 rule 3)
    await refEl.trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/p/src/a.ts" });
  });

  it("streaming assistant: no .path-ref while streaming; one re-scan after settling", async () => {
    const { handle } = makeHandle(SCOPE);
    const blocks = [{ kind: "text", text: "reading /p/src/a.ts now" }] as const;
    const wrapper = mount(TxAssistant, {
      props: { assistant: assistant({ blocks, streaming: true }), truncated: false },
      global: { provide: provideOf(handle) },
    });
    expect(wrapper.find(".path-ref").exists()).toBe(false);
    expect(wrapper.text()).toContain("reading /p/src/a.ts now");

    await wrapper.setProps({ assistant: assistant({ blocks, streaming: false }), truncated: false });
    await nextTick();
    expect(wrapper.find(".path-ref").exists()).toBe(true);
  });

  it("link text never carries .path-ref (the anchor owns the interaction)", () => {
    const { handle } = makeHandle(SCOPE);
    const wrapper = mount(TxAssistant, {
      props: {
        assistant: assistant({ blocks: [{ kind: "text", text: "see [docs for /p/src/a.ts](https://example.com)" }] }),
        truncated: false,
      },
      global: { provide: provideOf(handle) },
    });
    const a = wrapper.get("a");
    expect(a.attributes("href")).toBe("https://example.com");
    expect(wrapper.find("a .path-ref").exists()).toBe(false);
    expect(wrapper.find("a [role=button]").exists()).toBe(false);
    expect(a.text()).toContain("/p/src/a.ts"); // text itself is preserved
  });

  it("scope loss (session switch) makes previously clickable paths plain again", async () => {
    const { handle, scope } = makeHandle(SCOPE);
    const wrapper = mount(TxUser, {
      props: { text: "check /p/src/a.ts please", truncated: false, timestamp: undefined },
      global: { provide: provideOf(handle) },
    });
    expect(wrapper.find(".path-ref").exists()).toBe(true);

    // A different session with a different cwd: the old path is no longer in scope.
    scope.value = { agentKey: "A", sessionId: "s2", cwd: "/other", uploads: true };
    await nextTick();
    expect(wrapper.find(".path-ref").exists()).toBe(false);
    expect(wrapper.get(".bubble").text()).toBe("check /p/src/a.ts please");

    scope.value = null; // deselected entirely — same DOM-equivalent plain text
    await nextTick();
    expect(wrapper.find(".path-ref").exists()).toBe(false);
  });

  it("user bubble: paths are clickable with a live scope, DOM-identical without ctx", () => {
    const { handle } = makeHandle(SCOPE);
    const withCtx = mount(TxUser, {
      props: { text: "open /p/src/a.ts", truncated: false, timestamp: undefined },
      global: { provide: provideOf(handle) },
    });
    expect(withCtx.find(".bubble .path-ref").exists()).toBe(true);

    const noCtx = mount(TxUser, { props: { text: "open /p/src/a.ts", truncated: false, timestamp: undefined } });
    expect(noCtx.find(".path-ref").exists()).toBe(false);
    expect(noCtx.get(".bubble").text()).toBe("open /p/src/a.ts");
  });
});

describe("PV6 wiring — ToolCard Input section only (plan v3 修订 7)", () => {
  const toolView = (v: Partial<ToolView> & Pick<ToolView, "toolCallId" | "toolName" | "state">): ToolView => ({
    args: undefined,
    ...v,
  });

  it("Input argsText: paths render as .path-ref and click opens them; pre text is unchanged", async () => {
    const { handle, open } = makeHandle(SCOPE);
    const wrapper = mount(ToolCard, {
      props: {
        view: toolView({
          toolCallId: "t1",
          toolName: "bash",
          state: "done",
          args: "cat /p/src/a.ts | head",
          result: "ok",
        }),
      },
      global: { provide: provideOf(handle) },
    });
    const sections = wrapper.findAll(".tool-section");
    expect(sections.length).toBe(2); // Input + Output
    const inputPre = sections[0]!.get("pre");
    expect(inputPre.text()).toBe("cat /p/src/a.ts | head"); // segmentation preserves the text
    const refEl = inputPre.get(".path-ref");
    await refEl.trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/p/src/a.ts" });

    // Output section (修订 7: 不接) stays plain even with an in-scope path in the result.
    const outPre = sections[1]!.get("pre");
    expect(outPre.find(".path-ref").exists()).toBe(false);
  });

  it("summary row carries no interactive elements even when the args summary shows a path", () => {
    const { handle } = makeHandle(SCOPE);
    const wrapper = mount(ToolCard, {
      props: {
        view: toolView({
          toolCallId: "t2",
          toolName: "read",
          state: "done",
          args: { path: "/p/src/a.ts" },
          result: "x",
        }),
      },
      global: { provide: provideOf(handle) },
    });
    const summary = wrapper.get("summary.tool-head");
    expect(summary.text()).toContain("/p/src/a.ts");
    expect(summary.find(".path-ref").exists()).toBe(false);
    expect(summary.findAll("[role=button]").length).toBe(0);
    expect(summary.findAll("[tabindex]").length).toBe(0); // nothing steals the details toggle
  });
});

describe("PV6 wiring — App.vue navigate regression (plan v3 §2.3 / v3-1)", () => {
  afterEach(() => {
    delete document.documentElement.dataset["authMode"];
    window.localStorage.clear();
    window.location.hash = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readyState = 0;
    private listeners = new Map<string, Set<(ev: { data: string; lastEventId: string }) => void>>();
    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }
    addEventListener(type: string, fn: (ev: { data: string; lastEventId: string }) => void): void {
      const set = this.listeners.get(type) ?? new Set();
      set.add(fn);
      this.listeners.set(type, set);
    }
    removeEventListener(type: string, fn: (ev: { data: string; lastEventId: string }) => void): void {
      this.listeners.get(type)?.delete(fn);
    }
    close(): void {
      this.readyState = 2;
    }
    emit(name: string, data: unknown): void {
      for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data), lastEventId: "" });
    }
  }

  function jsonResponse(status: number, body: unknown): unknown {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("selecting a 「我发起的」 live session still navigates via hashRoute; PREVIEW_CTX is provided", async () => {
    document.documentElement.dataset["authMode"] = "token";
    window.localStorage.setItem("pwh_token", "tok");
    vi.stubGlobal("EventSource", FakeEventSource);
    const headlessBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
        const u = String(url);
        if (u === "/api/login") return jsonResponse(200, {});
        if (u === "/api/headless" && init?.method === "POST") {
          headlessBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse(202, { spawnId: "sp1", state: "starting", cwd: "/proj" });
        }
        return jsonResponse(200, {});
      }),
    );

    const probe: { hub?: HubHandle; preview?: PreviewContext } = {};
    const DashboardProbe = defineComponent({
      name: "DashboardView",
      setup() {
        probe.hub = inject(HUB_CTX) as HubHandle;
        probe.preview = inject(PREVIEW_CTX) as PreviewContext;
        return () => h("div", { class: "dashboard-probe" });
      },
    });

    const wrapper = mount(App, {
      global: {
        stubs: {
          IconSprite: true,
          TopBar: true,
          HubStateBanner: true,
          ControlNotice: true,
          NoticeStack: true,
          LoginView: true,
          TokenGate: true,
          DashboardView: DashboardProbe,
        },
      },
    });
    await flush();

    // PV6: the preview context is provided App-wide; with no agents/caps yet the scope is
    // null (every PathText in the tree renders its DOM-equivalent plain text).
    expect(probe.preview).toBeDefined();
    expect(probe.preview!.handle.scope.value).toBeNull();

    // SSE handshake → conn open.
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("/api/events");
    es.emit("hello", { clientId: "c1" });
    await flush();

    // 「我发起的」 flow: submit → 202 → hub snapshot shows the record live + delivered.
    await probe.hub!.spawn!.newSession.submit({ cwd: "/proj", firstPrompt: { text: "hi", deliver: "steer" } });
    await flush();
    expect(headlessBodies.length).toBe(1);
    const reqId = String(headlessBodies[0]!["id"]);

    es.emit("spawns", {
      items: [
        {
          spawnId: "sp1",
          state: "live",
          agentKey: "agent-9",
          createdAt: 1000,
          updatedAt: 1000,
          cwdLabel: "proj",
          firstPrompt: { state: "delivered" },
          origin: { listener: "loopback", reqId },
        },
      ],
      active: 1,
      max: 4,
    });
    await flush();

    // SP13 navigate wiring survived PV6: the callback reached the real hash route.
    expect(window.location.hash).toBe("#/agent/agent-9");
    wrapper.unmount();
  });
});
