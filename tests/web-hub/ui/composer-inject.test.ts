// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { AgentState, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `control/Composer.vue` — steer-recall §7 (P-ui): the `injectDraft` backfill. Whenever `rev`
 * bumps, the recalled body joins AHEAD of the current draft (`[recalled, draft].join("\n\n")`),
 * the draft persists, the composer focuses itself and the caret lands at the end.
 */

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  stubMatchMedia(false);
  window.localStorage.clear();
});

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
});

function fakeControl(): ControlHandle & { drafts: Map<string, string> } {
  const drafts = new Map<string, string>();
  const noop = () => Promise.resolve({ ok: true as const });
  return {
    drafts,
    sendPrompt: noop as ControlHandle["sendPrompt"],
    abort: noop as ControlHandle["abort"],
    steerSub: noop as ControlHandle["steerSub"],
    stopSub: noop as ControlHandle["stopSub"],
    answerDialog: noop as ControlHandle["answerDialog"],
    cancelDialog: noop as ControlHandle["cancelDialog"],
    runCommand: noop as ControlHandle["runCommand"],
    query: noop,
    retry: noop,
    discard: () => {},
    draft: (k) => drafts.get(k) ?? "",
    setDraft: (k, t) => void drafts.set(k, t),
  };
}

function mountComposer(injectDraft: { text: string; rev: number }, control: ControlHandle) {
  const agent = ref({ pendingCtl: [] } as unknown as AgentState);
  const view: ControlView = {
    agentKey: "agent-a",
    control,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => false),
    commands: computed(() => []),
    commandsEnabled: computed(() => false),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
  const wrapper = mount(Composer, {
    props: { enabled: true, busy: false, injectDraft },
    attachTo: document.body, // focus assertions need a live document element
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [CONTROL_CTX as symbol]: { agentKey: "agent-a", control, enabled: true },
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("Composer.vue — injectDraft backfill (steer-recall §7)", () => {
  it("a rev bump joins the recalled body AHEAD of the current draft, persists, focuses, caret at end", async () => {
    const control = fakeControl();
    const inject = ref({ text: "", rev: 0 });
    const w = mountComposer(inject.value, control);
    const ta = w.find("textarea");
    await ta.setValue("half-typed draft");
    inject.value = { text: "recalled body", rev: 1 };
    await w.setProps({ injectDraft: inject.value });
    await nextTick();
    await nextTick();
    expect((ta.element as HTMLTextAreaElement).value).toBe("recalled body\n\nhalf-typed draft");
    // persisted (§7.1 drafts) and focused with the caret at the end (ready to keep typing)
    expect(control.drafts.get("agent-a")).toBe("recalled body\n\nhalf-typed draft");
    expect(document.activeElement).toBe(ta.element);
    expect((ta.element as HTMLTextAreaElement).selectionStart).toBe("recalled body\n\nhalf-typed draft".length);
  });

  it("an empty draft yields just the recalled body — no stray blank lines; an unchanged rev never triggers", async () => {
    const control = fakeControl();
    const inject = ref({ text: "", rev: 0 });
    const w = mountComposer(inject.value, control);
    const ta = w.find("textarea");
    inject.value = { text: "recalled body", rev: 1 };
    await w.setProps({ injectDraft: inject.value });
    await nextTick();
    await nextTick();
    expect((ta.element as HTMLTextAreaElement).value).toBe("recalled body");

    // rev unchanged (a re-render with the same value) — the draft the user typed since survives
    await ta.setValue("edited since");
    await w.setProps({ injectDraft: { text: "recalled body", rev: 1 } });
    await nextTick();
    await nextTick();
    expect((ta.element as HTMLTextAreaElement).value).toBe("edited since");
  });

  it("the same body re-recalled bumps rev and re-joins (rev, not text, is the trigger)", async () => {
    const control = fakeControl();
    const inject = ref({ text: "", rev: 0 });
    const w = mountComposer(inject.value, control);
    const ta = w.find("textarea");
    inject.value = { text: "same body", rev: 1 };
    await w.setProps({ injectDraft: inject.value });
    await nextTick();
    await nextTick();
    expect((ta.element as HTMLTextAreaElement).value).toBe("same body");
    inject.value = { text: "same body", rev: 2 };
    await w.setProps({ injectDraft: inject.value });
    await nextTick();
    await nextTick();
    expect((ta.element as HTMLTextAreaElement).value).toBe("same body\n\nsame body");
  });
});
