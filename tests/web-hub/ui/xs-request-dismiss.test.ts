// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DetailDock from "../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import XsRequestList from "../../../src/web-hub/ui/src/components/control/XsRequestList.vue";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import {
  acceptXsStatus,
  createXsRequestDismissals,
  forgetXsRemote,
  forgetXsSeeds,
  seedXsMention,
  XS_REQUEST_DISMISSALS,
  xsActivateEligible,
  xsQueryGate,
  xsRemoteRows,
  type XsRowView,
} from "../../../src/web-hub/ui/src/logic/xsRequestState.js";
import type { AgentState, ControlHandle, HubHandle } from "../../../src/web-hub/ui/src/types.js";

const CAPS = ["cmd.v1", "xs.state.v1", "xs.activate.v1"];
const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  forgetXsRemote("dismiss-agent");
  forgetXsSeeds("dismiss-agent");
  vi.restoreAllMocks();
});

function row(messageId: string, revision = 1): XsRowView {
  return {
    messageId,
    revision,
    phase: "delivered",
    deliveryEffect: "applied",
    observation: "live",
    activationKey: `key-${messageId}`,
    wake: { requested: false, decision: "deliver_only" },
  };
}

function dock(
  dismissals = createXsRequestDismissals(),
  xsActivate = vi.fn<NonNullable<ControlHandle["xsActivate"]>>(async () => ({ ok: true })),
  rows: readonly XsRowView[] = [row("m1"), row("m2")],
) {
  const agent = ref({
    key: "dismiss-agent",
    session: { sessionId: "s1" },
    status: { xsRequests: { sessionId: "s1", revision: 1, rows } },
    down: false,
    pendingCtl: [],
    prompts: [],
    queue: [],
    fleet: [],
  } as unknown as AgentState);
  const control = { xsActivate, draft: () => "", setDraft: () => {} } as unknown as ControlHandle;
  const view = {
    agentKey: "dismiss-agent",
    agent: computed(() => agent.value),
    control,
    enabled: computed(() => true),
    busy: computed(() => false),
    queueItems: computed(() => []),
    readonlyReason: computed(() => null),
    commands: computed(() => []),
    commandsEnabled: computed(() => false),
    sending: computed(() => false),
    isWebMessage: () => false,
  } satisfies ControlView;
  const hub = {
    state: ref({ hub: { caps: CAPS }, conn: "open", agents: new Map(), selected: "dismiss-agent" }),
    dispatch: () => {},
  } as unknown as HubHandle;
  const wrapper = mount(DetailDock, {
    props: { following: true, newCount: 0, now: 5_000 },
    global: {
      stubs: { Composer: true, QueueList: true },
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [HUB_CTX as symbol]: hub,
        [XS_REQUEST_DISMISSALS as symbol]: dismissals,
      },
    },
  });
  mounted.push(wrapper);
  const ids = () => wrapper.findAll(".xs-request-id").map((item) => item.text());
  const update = async (rows: readonly XsRowView[], revision: number, sessionId = "s1") => {
    agent.value = {
      ...agent.value,
      session: { sessionId },
      status: { xsRequests: { sessionId, revision, rows } },
    } as AgentState;
    await nextTick();
  };
  return { wrapper, agent, hub, ids, update, xsActivate, dismissals };
}

describe("local cross-session request dismissal", () => {
  it("click hides exactly one row, leaves evidence/actions intact, and all hidden renders no container", async () => {
    const { wrapper, ids, xsActivate } = dock();
    await wrapper.findAll("[data-xs-dismiss]")[0]!.trigger("click");
    expect(ids()).toEqual(["m2"]);
    expect(xsActivate).not.toHaveBeenCalled();
    const retained = xsRemoteRows("dismiss-agent", "s1").get("m1")!;
    expect(retained).toEqual(row("m1"));
    expect(xsActivateEligible(retained, 5_000)).toBe(true);
    expect(xsQueryGate(CAPS, true, { ...retained, deliveryEffect: "unknown" })).toBe(true);
    await wrapper.find("[data-xs-dismiss]").trigger("click");
    expect(wrapper.find(".xs-request-list").exists()).toBe(false);
    expect(wrapper.findComponent(XsRequestList).html()).not.toContain("xs-request");
  });

  it("fresh/stale revisions, missing frames, caps and SSE reconnect cannot revive a row; new IDs still appear", async () => {
    const { wrapper, ids, update, agent, hub } = dock();
    await wrapper.findAll("[data-xs-dismiss]")[0]!.trigger("click");
    await update([{ ...row("m1", 9), phase: "replied" }, row("m2"), row("m3")], 9);
    expect(ids()).toEqual(["m2", "m3"]);
    await update([row("m1", 1), row("m2")], 1);
    expect(ids()).toEqual(["m2", "m3"]);
    agent.value = { ...agent.value, down: true, status: {} } as AgentState;
    hub.state.value = { ...hub.state.value, conn: "reconnecting", hub: { caps: [] } } as never;
    await nextTick();
    expect(wrapper.find(".xs-request-list").exists()).toBe(false);
    hub.state.value = { ...hub.state.value, conn: "open", hub: { caps: CAPS } } as never;
    agent.value = { ...agent.value, down: false };
    await update([row("m1", 10), row("m2", 10)], 10);
    expect(ids()).toEqual(["m2", "m3"]);
  });

  it("App-owned tombstones survive detail unmount/remount but a fresh App starts empty", async () => {
    const first = dock();
    await first.wrapper.findAll("[data-xs-dismiss]")[0]!.trigger("click");
    first.wrapper.unmount();
    expect(dock(first.dismissals).ids()).toEqual(["m2"]);
    expect(dock().ids()).toEqual(["m1", "m2"]);
  });

  it("known session replacement and card removal clear tombstones, not temporary absent sessions", () => {
    const dismissals = createXsRequestDismissals();
    const rows = [row("m1")];
    dismissals.dismiss("a", "s1", "m1");
    dismissals.reconcile(new Map(), new Set());
    expect(dismissals.rows("a", "s1", rows)).toEqual([]);
    expect(dismissals.rows("b", "s1", rows)).toEqual(rows);
    expect(dismissals.rows("a", "s2", rows)).toEqual(rows);
    dismissals.reconcile(new Map([["a", "s2"]]), new Set());
    expect(dismissals.rows("a", "s1", rows)).toEqual(rows);
    dismissals.dismiss("a", "s2", "m1");
    dismissals.reconcile(new Map(), new Set(["a"]));
    expect(dismissals.rows("a", "s2", rows)).toEqual(rows);
  });

  it("session change never inherits a hidden ID, and returning to the old ID does not restore tombstones", async () => {
    const { wrapper, update, ids } = dock();
    await wrapper.findAll("[data-xs-dismiss]")[0]!.trigger("click");
    await update([row("m1")], 1, "s2");
    expect(ids()).toEqual(["m1"]);
    await update([row("m1")], 2, "s1");
    expect(ids()).toContain("m1");
  });

  it.each(["activate", "query"] as const)(
    "dismiss during %s does not cancel work or resurrect on late completion",
    async (action) => {
      let resolve!: (result: { ok: true }) => void;
      const xsActivate = vi.fn<NonNullable<ControlHandle["xsActivate"]>>(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const { wrapper, ids, update } = dock(createXsRequestDismissals(), xsActivate, [
        { ...row("m1"), deliveryEffect: action === "query" ? "unknown" : "applied" },
        row("m2"),
      ]);
      await wrapper.find(`[data-xs-${action}]`).trigger("click");
      expect(wrapper.find(`[data-xs-${action}]`).attributes("disabled")).toBeDefined();
      const close = wrapper.findAll("[data-xs-dismiss]")[0]!;
      expect(close.attributes("disabled")).toBeUndefined();
      await close.trigger("click");
      expect(ids()).toEqual(["m2"]);
      resolve({ ok: true });
      await Promise.resolve();
      seedXsMention("dismiss-agent", "s1", { messageId: "m1", row: row("m1", 5) }, 5_001);
      await update([row("m1", 6), row("m2")], 6);
      expect(ids()).toEqual(["m2"]);
      await wrapper.find("[data-xs-activate]").trigger("click");
      expect(xsActivate).toHaveBeenCalledTimes(2);
      resolve({ ok: true });
      await Promise.resolve();
    },
  );

  it("a dismissed ID remains hidden after remote FIFO eviction and later replay", () => {
    const dismissals = createXsRequestDismissals();
    dismissals.dismiss("dismiss-agent", "s1", "m1");
    acceptXsStatus("dismiss-agent", "s1", {
      sessionId: "s1",
      revision: 2,
      rows: Array.from({ length: 256 }, (_, i) => row(`other-${i}`)),
    });
    acceptXsStatus("dismiss-agent", "s1", { sessionId: "s1", revision: 3, rows: [row("m1", 3)] });
    expect(
      dismissals
        .rows("dismiss-agent", "s1", [...xsRemoteRows("dismiss-agent", "s1").values()])
        .some((item) => item.messageId === "m1"),
    ).toBe(false);
  });

  it("dismiss is a labelled, keyboard-focusable native button, including without query/activate", async () => {
    const { wrapper } = dock();
    const button = wrapper.find<HTMLButtonElement>("[data-xs-dismiss]");
    expect(button.element.tagName).toBe("BUTTON");
    expect(button.attributes("type")).toBe("button");
    expect(button.element.tabIndex).toBe(0);
    expect(button.attributes("aria-label")).toBe("Hide request m1 locally");
    expect(button.attributes("title")).toContain("locally");
    expect(button.find("[aria-hidden='true']").text()).toBe("×");
    // happy-dom does not synthesize native key→click. Real Enter/Space activation is
    // additionally exercised by the DevEye browser probe; no custom key handler is needed.
    await button.trigger("click");
    expect(wrapper.findComponent(XsRequestList).emitted("dismiss")).toEqual([["m1"]]);
  });
});
