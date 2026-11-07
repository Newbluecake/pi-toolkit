// @vitest-environment happy-dom
/** #47 current-turn gesture and real Composer-host tests. Every abort is a fake promise;
 * no hub/session APIs or process aborts. No sleeping: fake timers pin the 699/700ms boundary. */
import { mount } from "@vue/test-utils";
import { computed, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StopButton from "../../../src/web-hub/ui/src/components/control/StopButton.vue";
import ContextRing from "../../../src/web-hub/ui/src/components/control/ContextRing.vue";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import {
  CONTROL_VIEW,
  HUB_CTX,
  DETAIL_METRICS,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { HOLD_STOP_HOST, type HoldStopHost } from "../../../src/web-hub/ui/src/composables/useHoldStop.js";
import type { AgentState, ControlHandle, HubHandle, CmdOutcome } from "../../../src/web-hub/ui/src/types.js";

const mounted: Array<{ unmount(): void }> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function rect(target: Element) {
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 144,
    bottom: 144,
    width: 44,
    height: 44,
    toJSON() {},
  });
}
const down = { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: 120, clientY: 120 };
function standalone(host?: HoldStopHost) {
  const w = mount(StopButton, {
    props: { busy: true },
    attachTo: document.body,
    global: { provide: host ? { [HOLD_STOP_HOST as symbol]: host } : {} },
  });
  mounted.push(w);
  rect(w.get(".stop-btn").element);
  return w;
}
function event(type: string, values: Partial<PointerEventInit> = {}) {
  window.dispatchEvent(new PointerEvent(type, { ...down, ...values }));
}

describe("useHoldStop / StopButton", () => {
  it("699ms never emits, 700ms emits once; continued hold/up/derived click never emits again", async () => {
    const w = standalone();
    await w.get(".stop-btn").trigger("pointerdown", down);
    vi.advanceTimersByTime(699);
    expect(w.emitted("stop")).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(w.emitted("stop")).toHaveLength(1);
    vi.advanceTimersByTime(10000);
    event("pointerup");
    w.get(".stop-btn").element.dispatchEvent(
      new PointerEvent("click", { pointerType: "touch", pointerId: 1, detail: 0 }),
    );
    await nextTick();
    expect(w.emitted("stop")).toHaveLength(1);
    expect(w.find(".stop-confirm").exists()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    "pointerup",
    "pointercancel",
    "lostpointercapture",
    "pointerleave",
    "move-out",
    "move8",
    "scroll",
    "blur",
    "button-blur",
    "hidden",
    "unmount",
    "busy",
  ])("%s cancels before threshold and never resumes", async (kind) => {
    const w = standalone();
    await w.get(".stop-btn").trigger("pointerdown", down);
    vi.advanceTimersByTime(300);
    if (kind === "move-out") event("pointermove", { clientX: 145 });
    else if (kind === "move8") event("pointermove", { clientX: 129 });
    else if (kind === "scroll") document.dispatchEvent(new Event("scroll"));
    else if (kind === "blur") window.dispatchEvent(new Event("blur"));
    else if (kind === "button-blur") await w.get(".stop-btn").trigger("blur");
    else if (kind === "hidden") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    } else if (kind === "unmount") {
      w.unmount();
      mounted.splice(mounted.indexOf(w), 1);
    } else if (kind === "busy") await w.setProps({ busy: false });
    else if (kind === "lostpointercapture" || kind === "pointerleave") await w.get(".stop-btn").trigger(kind, down);
    else event(kind);
    event("pointermove", { clientX: 120 });
    vi.advanceTimersByTime(10000);
    expect(w.emitted("stop")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
  });
  it("short tap gives a hold hint, never a permanent cancelled message; feedback expires at 1500ms", async () => {
    const w = standalone();
    await w.get(".stop-btn").trigger("pointerdown", down);
    event("pointerup");
    await nextTick();
    expect(w.get(".stop-hold-note").text()).toContain("Hold for 0.7 seconds");
    expect(w.get(".stop-hold-note").text()).not.toContain("cancelled");
    vi.advanceTimersByTime(1499);
    await nextTick();
    expect(w.find(".stop-hold-note").exists()).toBe(true);
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(w.find(".stop-hold-note").exists()).toBe(false);
    expect(w.emitted("stop")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("real cancellation says not stopped, expires, and blur/unmount clears the feedback timer", async () => {
    const w = standalone();
    await w.get(".stop-btn").trigger("pointerdown", down);
    event("pointercancel");
    await nextTick();
    expect(w.get(".stop-hold-note").text()).toContain("Hold cancelled — not stopped");
    window.dispatchEvent(new Event("blur"));
    await nextTick();
    expect(w.find(".stop-hold-note").exists()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await w.get(".stop-btn").trigger("pointerdown", down);
    event("pointercancel");
    await nextTick();
    vi.advanceTimersByTime(1500);
    await nextTick();
    expect(w.find(".stop-hold-note").exists()).toBe(false);
    await w.get(".stop-btn").trigger("pointerdown", down);
    event("pointercancel");
    w.unmount();
    mounted.splice(mounted.indexOf(w), 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(w.emitted("stop")).toBeUndefined();
  });
  it.each(["mouse", "pen", "touch"])("%s contextmenu at 500ms: only touch continues to 700ms", async (pointerType) => {
    const w = standalone();
    await w.get(".stop-btn").trigger("pointerdown", { ...down, pointerType });
    vi.advanceTimersByTime(500);
    const menu = new MouseEvent("contextmenu", { cancelable: true });
    w.get(".stop-btn").element.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(200);
    expect(w.emitted("stop")?.length ?? 0).toBe(pointerType === "touch" ? 1 : 0);
  });
  it("ignores second finger down/move/up/cancel/leave without taking over or cancelling", async () => {
    const w = standalone();
    await w.get(".stop-btn").trigger("pointerdown", down);
    await w.get(".stop-btn").trigger("pointerdown", { ...down, pointerId: 2, isPrimary: false });
    event("pointermove", { pointerId: 2, clientX: 0 });
    event("pointerup", { pointerId: 2 });
    event("pointercancel", { pointerId: 2 });
    await w.get(".stop-btn").trigger("pointerleave", { ...down, pointerId: 2 });
    vi.advanceTimersByTime(700);
    expect(w.emitted("stop")).toHaveLength(1);
  });
  it("short click/double click do not arm; semantic click and independent alternative explicitly confirm", async () => {
    const w = standalone();
    await w.get(".stop-btn").trigger("click", { detail: 1 });
    await w.get(".stop-btn").trigger("click", { detail: 2 });
    expect(w.find(".stop-confirm").exists()).toBe(false);
    await w.get(".stop-btn").trigger("click", { detail: 0 });
    expect(document.activeElement).toBe(w.get(".stop-confirm .btn-ghost").element);
    await w.get(".stop-confirm").trigger("keydown", { key: "Escape" });
    await w.get(".stop-alternative").trigger("click", { detail: 1 });
    await w.get(".stop-confirm .btn-danger").trigger("click");
    expect(w.emitted("stop")).toHaveLength(1);
  });
  it.each(["Enter", " "])("%s keyup opens once, following semantic click and repeat do not confirm", async (key) => {
    const w = standalone();
    w.get(".stop-btn").element.focus();
    await w.get(".stop-btn").trigger("keydown", { key });
    await w.get(".stop-btn").trigger("keydown", { key, repeat: true });
    vi.advanceTimersByTime(1000);
    expect(w.find(".stop-confirm").exists()).toBe(false);
    await w.get(".stop-btn").trigger("keyup", { key });
    await w.get(".stop-btn").trigger("click", { detail: 0 });
    expect(w.findAll(".stop-confirm")).toHaveLength(1);
    await w.get(".stop-confirm .btn-danger").trigger("keydown", { key: "Enter", repeat: true });
    expect(w.emitted("stop")).toBeUndefined();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(w.find(".stop-confirm").exists()).toBe(false);
  });
  it("IME/modifiers and keydown focus loss cannot activate confirmation", async () => {
    const w = standalone();
    for (const extra of [
      { isComposing: true },
      { keyCode: 229 },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      await w.get(".stop-btn").trigger("keydown", { key: "Enter", ...extra });
      await w.get(".stop-btn").trigger("keyup", { key: "Enter", ...extra });
      expect(w.find(".stop-confirm").exists()).toBe(false);
    }
    await w.get(".stop-btn").trigger("keydown", { key: "Enter" });
    await w.get(".stop-btn").trigger("blur");
    await w.get(".stop-btn").trigger("keyup", { key: "Enter" });
    expect(w.find(".stop-confirm").exists()).toBe(false);
  });
  it.each(["eligible", "scope", "pending"])("host %s ABA cancels synchronously", async (change) => {
    const scope = ref<string | null>("A"),
      eligible = ref(true),
      pending = ref(false);
    const w = standalone({
      scope: computed(() => scope.value),
      eligible: computed(() => eligible.value),
      abortPending: computed(() => pending.value),
    });
    await w.get(".stop-btn").trigger("pointerdown", down);
    if (change === "scope") {
      scope.value = "B";
      scope.value = "A";
    }
    if (change === "eligible") {
      eligible.value = false;
      eligible.value = true;
    }
    if (change === "pending") {
      pending.value = true;
      pending.value = false;
    }
    vi.advanceTimersByTime(700);
    expect(w.emitted("stop")).toBeUndefined();
  });
});

function hostHarness() {
  const calls: string[] = [],
    settle: Array<(outcome: CmdOutcome) => void> = [];
  const agent = ref({
    card: { epoch: "e1", state: "live", control: true },
    status: { busy: true },
    session: { sessionId: "s1" },
    pendingCtl: [],
  } as unknown as AgentState);
  const rawAgent = ref<AgentState | undefined>();
  const conn = ref("open"),
    allowed = ref(true),
    busy = ref(true),
    surface = ref("ring"),
    agentKey = ref("A");
  const control = {
    abort: (key: string) => {
      calls.push(key);
      return new Promise<CmdOutcome>((resolve) => settle.push(resolve));
    },
    draft: () => "",
    setDraft: () => {},
  } as unknown as ControlHandle;
  const view: ControlView = {
    get agentKey() {
      return agentKey.value;
    },
    control,
    agent: computed(() => agent.value),
    enabled: computed(() => allowed.value),
    readonlyReason: computed(() => null),
    busy: computed(() => busy.value),
    commands: computed(() => []),
    commandsEnabled: computed(() => false),
    sending: computed(() => true),
    queueItems: computed(() => ["retained queue"]),
    isWebMessage: () => false,
  };
  const ActualRing = { ...ContextRing, name: "ActualStopRing", __name: "ActualStopRing" };
  // A genuine surface remount under the SAME Composer provider, never a parallel fake host.
  const Surface = defineComponent({
    props: ["busy", "queueCount"],
    emits: ["stop"],
    setup(props, { emit }) {
      return () =>
        h(surface.value === "ring" ? ActualRing : StopButton, {
          busy: props.busy,
          queueCount: props.queueCount,
          onStop: () => emit("stop"),
        });
    },
  });
  const w = mount(Composer, {
    props: { busy: true, enabled: true },
    attachTo: document.body,
    global: {
      stubs: { ContextRing: Surface },
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [HUB_CTX as symbol]: {
          state: computed(() => ({
            conn: conn.value,
            hub: null,
            control: true,
            selected: agentKey.value,
            agents: new Map([[agentKey.value, rawAgent.value ?? agent.value]]),
          })),
        } as unknown as HubHandle,
        [DETAIL_METRICS as symbol]: {
          contextUsage: computed(() => ({ percent: 60, tokens: 60, contextWindow: 100 })),
          costUsd: computed(() => 0),
          subagentCostUsd: computed(() => 0),
        },
      },
    },
  });
  mounted.push(w);
  async function hold() {
    const btn = w.get(".stop-hold-target");
    rect(btn.element);
    await btn.trigger("pointerdown", down);
    vi.advanceTimersByTime(700);
    await nextTick();
    event("pointerup");
  }
  return { w, calls, settle, agent, rawAgent, conn, allowed, busy, surface, agentKey, hold };
}

describe("Composer host final gate / singleflight", () => {
  it("ignores unrelated view.sending; host lock survives ring/fallback remount", async () => {
    const t = hostHarness();
    await t.hold();
    expect(t.calls).toEqual(["A"]);
    t.surface.value = "fallback";
    await nextTick();
    expect(t.w.get(".stop-btn").attributes("disabled")).toBeDefined();
    await t.hold();
    expect(t.calls).toHaveLength(1);
    t.settle[0]!({ ok: false, effect: "unknown" });
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
    expect(t.calls).toHaveLength(1); // no automatic retry
    await t.hold();
    expect(t.calls).toHaveLength(2);
  });
  it("scope change allows a new intent; old finally cannot clear the new flight", async () => {
    const t = hostHarness();
    await t.hold();
    t.agent.value = { ...t.agent.value, session: { sessionId: "s2" } };
    await nextTick();
    await t.hold();
    expect(t.calls).toHaveLength(2);
    t.settle[0]!({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
    await t.hold();
    expect(t.calls).toHaveLength(2);
    t.settle[1]!({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
    await t.hold();
    expect(t.calls).toHaveLength(3);
  });
  it.each(["session", "permission", "busy"])(
    "raw reducer %s ABA cancels even when parent view props never change",
    async (kind) => {
      const t = hostHarness();
      const old = t.agent.value;
      const btn = t.w.get(".stop-hold-target");
      rect(btn.element);
      await btn.trigger("pointerdown", down);
      t.rawAgent.value =
        kind === "session"
          ? { ...old, session: { sessionId: "raw-B" } }
          : kind === "permission"
            ? { ...old, card: { ...old.card, control: false } }
            : { ...old, status: { busy: false } };
      t.rawAgent.value = old;
      vi.advanceTimersByTime(700);
      expect(t.calls).toHaveLength(0);
    },
  );
  it.each(["conn", "permission", "busy", "session", "epoch", "agent", "missing-scope"])(
    "%s change/ABA during hold never dispatches",
    async (kind) => {
      const t = hostHarness();
      const btn = t.w.get(".stop-hold-target");
      rect(btn.element);
      await btn.trigger("pointerdown", down);
      if (kind === "conn") {
        t.conn.value = "reconnecting";
        t.conn.value = "open";
      }
      if (kind === "permission") {
        t.allowed.value = false;
        t.allowed.value = true;
      }
      if (kind === "busy") {
        t.busy.value = false;
        t.busy.value = true;
      }
      if (kind === "agent") {
        t.agentKey.value = "B";
        t.agentKey.value = "A";
      }
      if (kind === "session") {
        const old = t.agent.value;
        t.agent.value = { ...old, session: { sessionId: "s2" } };
        t.agent.value = old;
      }
      if (kind === "epoch") {
        const old = t.agent.value;
        t.agent.value = { ...old, card: { epoch: "e2" } };
        t.agent.value = old;
      }
      if (kind === "missing-scope") t.agent.value = { ...t.agent.value, session: {} };
      vi.advanceTimersByTime(700);
      expect(t.calls).toHaveLength(0);
    },
  );
});
