// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AskUserForm from "../../../src/web-hub/ui/src/components/dialog/AskUserForm.vue";
import {
  CONTROL_ENV,
  CONTROL_VIEW,
  HUB_CTX,
  type ControlEnv,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import type { AgentState, PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";

/**
 * 2026-10-24 ruling (ask 对话框路径可预览): question text / context / option label +
 * description / multi-question header all render through `PathText`, so absolute paths (and
 * proxyable local links) become the usual `span.path-ref` / `span.proxy-ref` affordances that
 * open the App-level preview. Two interaction guards keep the dialog semantics intact:
 * clicking a ref inside an option row must NOT toggle the radio/checkbox (label
 * preventDefault guard in AskUserQuestion), and clicking a ref inside a header tab must NOT
 * switch tabs (target check in AskUserForm). With no PREVIEW_CTX the DOM is byte-identical to
 * the pre-feature rendering (bare text nodes, no spans).
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});

const SCOPE = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true, abs: true } as unknown as PreviewPathScope;

function makePreviewCtx(): { ctx: PreviewContext; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn();
  const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;
  const handle = {
    view,
    scope: ref(SCOPE),
    open,
    close: vi.fn(),
    retry: vi.fn(),
    dispose: vi.fn(),
  } as unknown as PreviewHandle; // no `probe` ⇒ legacy always-clickable rendering
  return { ctx: { handle, plaintext: false }, open };
}

function fakeEnv(): ControlEnv {
  return { authMode: "token", plaintext: false, dialogDrafts: new Map(), noticeExpanded: ref(false) };
}

function fakeView(): ControlView {
  const agent = ref({ dialogs: { epoch: "epoch-1", open: [], closed: [] } } as unknown as AgentState);
  return {
    agentKey: "agent-a",
    control: null,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => true),
    commands: computed(() => []),
    commandsEnabled: computed(() => false),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
}

const PATHY = {
  dialogId: "ask:tc-paths-1",
  source: "ask_user",
  toolCallId: "tc-paths-1",
  questions: [
    {
      question: "Open /tmp/schedule-panel-preview.html for review?",
      context: "Screenshot draft lives at /tmp/schedule-panel-preview.html — check before answering.",
      options: [
        {
          label: "Yes, /tmp/schedule-panel-preview.html looks right",
          description: "The file /tmp/schedule-panel-preview.html was regenerated this morning",
        },
        { label: "No", description: "plain text, no path" },
      ],
    },
  ],
  allowCancel: true,
  openedAt: 1,
};

const PATHY_MULTI = {
  dialogId: "ask:tc-paths-2",
  source: "ask_user",
  toolCallId: "tc-paths-2",
  questions: [
    {
      question: "First?",
      header: "One",
      options: [{ label: "a" }],
    },
    {
      question: "Second?",
      header: "See /tmp/schedule-panel-preview.html",
      options: [{ label: "b" }],
    },
  ],
  allowCancel: true,
  openedAt: 2,
};

function mountForm(
  dialog: unknown,
  opts: { preview?: PreviewContext; env?: ControlEnv; extraProvide?: Record<symbol, unknown> } = {},
) {
  const wrapper = mount(AskUserForm, {
    props: { dialog, suspended: false },
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: fakeView(),
        [CONTROL_ENV as symbol]: opts.env ?? fakeEnv(),
        ...(opts.preview === undefined ? {} : { [PREVIEW_CTX as symbol]: opts.preview }),
        ...opts.extraProvide,
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("AskUser paths — DOM equivalence without PREVIEW_CTX", () => {
  it("renders every text slot as bare text: no path-ref/proxy-ref elements at all", () => {
    const w = mountForm(PATHY);
    expect(w.findAll(".path-ref")).toHaveLength(0);
    expect(w.findAll(".proxy-ref")).toHaveLength(0);
    // byte-identical: legend/context/label/desc contain nothing but the plain text
    expect(w.find(".ask-question-text").text()).toBe("Open /tmp/schedule-panel-preview.html for review?");
    const legend = w.find(".ask-question-text").element;
    expect(Array.from(legend.childNodes).every((n) => n.nodeType === 3)).toBe(true);
    const context = w.find(".ask-context").element;
    expect(Array.from(context.childNodes).every((n) => n.nodeType === 3)).toBe(true);
    const label = w.find(".ask-option-label");
    // the label span also holds the (hidden) recommended-tag v-if anchor — same as before
    // this change; byte-identity here means "no element nodes and the same visible text".
    expect(label.findAll("span")).toHaveLength(0);
    expect(label.text()).toBe("Yes, /tmp/schedule-panel-preview.html looks right");
    const desc = w.find(".ask-option-desc").element;
    expect(Array.from(desc.childNodes).every((n) => n.nodeType === 3)).toBe(true);
    expect(w.findAll(".ask-question-text span, .ask-context span, .ask-option-desc span")).toHaveLength(0);
  });

  it("multi-question headers stay plain text inside the tab buttons", () => {
    const w = mountForm(PATHY_MULTI);
    const tabs = w.findAll("[data-question-tab]");
    expect(tabs[1]!.text()).toBe("See /tmp/schedule-panel-preview.html");
    expect(w.findAll(".path-ref")).toHaveLength(0);
  });
});

describe("AskUser paths — with PREVIEW_CTX", () => {
  it("question / context / option label / description all expose clickable path refs", async () => {
    const { ctx, open } = makePreviewCtx();
    const w = mountForm(PATHY, { preview: ctx });
    const refs = w.findAll(".path-ref");
    // question(1) + context(1) + label(1) + description(1); "No" option has none
    expect(refs).toHaveLength(4);
    expect(w.find(".ask-question-text .path-ref").exists()).toBe(true);
    expect(w.find(".ask-context .path-ref").exists()).toBe(true);
    expect(w.find(".ask-option-label .path-ref").exists()).toBe(true);
    expect(w.find(".ask-option-desc .path-ref").exists()).toBe(true);
    await w.find(".ask-context .path-ref").trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/tmp/schedule-panel-preview.html", origin: "ask" });
  });

  it("clicking a path ref inside an option row does NOT select the option", async () => {
    const { ctx, open } = makePreviewCtx();
    const w = mountForm(PATHY, { preview: ctx });
    const refEl = w.find(".ask-option-label .path-ref");
    expect(refEl.exists()).toBe(true);
    // dispatch a real cancelable bubbling click so the label guard's preventDefault is observable
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    refEl.element.dispatchEvent(ev);
    expect(open).toHaveBeenCalledWith({ path: "/tmp/schedule-panel-preview.html", origin: "ask" });
    expect(ev.defaultPrevented).toBe(true); // label forwarding to the radio was cancelled
    const radio = w.findAll("input[type='radio']")[0]!.element as HTMLInputElement;
    expect(radio.checked).toBe(false);
    // submit stays gated: no answer was recorded
    expect((w.find("[data-submit]").element as HTMLButtonElement).disabled).toBe(true);
  });

  it("clicking a path ref inside a header tab opens the preview but does NOT switch tabs", async () => {
    const { ctx, open } = makePreviewCtx();
    const w = mountForm(PATHY_MULTI, { preview: ctx });
    const tabs = w.findAll("[data-question-tab]");
    const refEl = tabs[1]!.find(".path-ref");
    expect(refEl.exists()).toBe(true);
    await refEl.trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/tmp/schedule-panel-preview.html", origin: "ask" });
    // still on tab 0: question 2 remains hidden
    expect(w.findAll(".ask-question")[1]!.attributes("style") ?? "").toContain("display: none");
    expect(tabs[1]!.attributes("aria-selected")).toBe("false");
    // a plain click on the same tab still switches
    await tabs[1]!.trigger("click");
    expect(w.findAll(".ask-question")[1]!.attributes("style") ?? "").not.toContain("display: none");
  });

  it("keyboard Enter on a ref opens the preview without selecting the option", async () => {
    const { ctx, open } = makePreviewCtx();
    const w = mountForm(PATHY, { preview: ctx });
    const refEl = w.find(".ask-option-label .path-ref");
    await refEl.trigger("keydown", { key: "Enter" });
    expect(open).toHaveBeenCalledWith({ path: "/tmp/schedule-panel-preview.html", origin: "ask" });
    const radio = w.findAll("input[type='radio']")[0]!.element as HTMLInputElement;
    expect(radio.checked).toBe(false);
  });

  it("proxyable local links render as proxy refs and also do not select the option", async () => {
    const { ctx } = makePreviewCtx();
    const proxyTransport = {
      open: vi.fn(async () => ({ ok: false as const, status: 0, error: "E_NETWORK" as const })),
    };
    const hub = { state: ref({ hub: { caps: ["proxy.v1"] } }), transport: { proxy: proxyTransport } };
    const dialog = {
      ...PATHY,
      dialogId: "ask:tc-paths-3",
      questions: [
        {
          question: "dev server up?",
          options: [{ label: "open http://127.0.0.1:8080/panel and check" }],
        },
      ],
    };
    const w = mountForm(dialog, { preview: ctx, extraProvide: { [HUB_CTX as symbol]: hub } });
    const refEl = w.find(".ask-option-label .proxy-ref");
    expect(refEl.exists()).toBe(true);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    refEl.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const radio = w.findAll("input[type='radio']")[0]!.element as HTMLInputElement;
    expect(radio.checked).toBe(false);
  });
});

describe("AskUser paths — fix #3 test completion", () => {
  it("multiSelect checkbox rows get the same click guard (no toggle, no selection)", async () => {
    const { ctx, open } = makePreviewCtx();
    const dialog = {
      ...PATHY,
      dialogId: "ask:tc-paths-multi",
      questions: [
        {
          question: "Which artifacts should ship?",
          multiSelect: true,
          options: [
            { label: "the panel /tmp/schedule-panel-preview.html", description: "fresh" },
            { label: "nothing" },
          ],
        },
      ],
    };
    const w = mountForm(dialog, { preview: ctx });
    const refEl = w.find(".ask-option-label .path-ref");
    expect(refEl.exists()).toBe(true);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    refEl.element.dispatchEvent(ev);
    expect(open).toHaveBeenCalledWith({ path: "/tmp/schedule-panel-preview.html", origin: "ask" });
    expect(ev.defaultPrevented).toBe(true); // label forwarding to the CHECKBOX was cancelled
    const box = w.findAll("input[type='checkbox']")[0]!.element as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect((w.find("[data-submit]").element as HTMLButtonElement).disabled).toBe(true);
  });

  it("no ctx: .ask-option-label childNodes are all text nodes (the reco-tag v-if anchor aside)", () => {
    const w = mountForm(PATHY);
    const label = w.find(".ask-option-label").element;
    // Strict form of the verifier's assertion: the only non-text child allowed is the
    // pre-existing `<span v-if="view.recommended">` comment anchor (nodeType 8) — it sits
    // inside `.ask-option-label` since BEFORE PathText landed here, so a no-ctx DOM that is
    // byte-identical to the original necessarily contains it. The meaningful invariant:
    // ZERO element nodes, every rendered node text.
    const nodes = Array.from(label.childNodes);
    expect(nodes.filter((n) => n.nodeType === 8)).toHaveLength(1); // the v-if anchor, unchanged
    expect(nodes.filter((n) => n.nodeType !== 8).every((n) => n.nodeType === 3)).toBe(true);
    expect(label.querySelectorAll("*")).toHaveLength(0);
  });
});

describe("AskUser paths — fix #2: proxy failure note stays out of interactive elements", () => {
  it("option-label PathText (no-note) renders NO .proxy-ref-note on failure; legend (plain spot) still does", async () => {
    const { flushPromises } = await import("@vue/test-utils");
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    ); // popup-blocked deterministic path
    const { ctx } = makePreviewCtx();
    const proxyTransport = {
      open: vi.fn(async () => ({ ok: false as const, status: 403, error: "E_PROXY_DENIED" as const })),
    };
    const hub = { state: ref({ hub: { caps: ["proxy.v1"] } }), transport: { proxy: proxyTransport } };
    const dialog = {
      ...PATHY,
      dialogId: "ask:tc-paths-note",
      questions: [
        {
          question: "dev server http://127.0.0.1:8080/panel up?",
          options: [{ label: "open http://127.0.0.1:8080/panel and check" }],
        },
      ],
    };
    const w = mountForm(dialog, { preview: ctx, extraProvide: { [HUB_CTX as symbol]: hub } });

    // interactive position (label): the note is suppressed entirely
    const optRef = w.find(".ask-option-label .proxy-ref");
    expect(optRef.exists()).toBe(true);
    await optRef.trigger("click");
    await flushPromises();
    expect(w.find(".ask-option-label .proxy-ref-note").exists()).toBe(false);
    expect(w.find(".ask-option").element.querySelector(".proxy-ref-note")).toBeNull();

    // non-interactive position (legend): the legacy inline note still appears
    const legendRef = w.find(".ask-question-text .proxy-ref");
    expect(legendRef.exists()).toBe(true);
    await legendRef.trigger("click");
    await flushPromises();
    expect(w.find(".ask-question-text .proxy-ref-note").exists()).toBe(true);
    vi.unstubAllGlobals();
  });
});
