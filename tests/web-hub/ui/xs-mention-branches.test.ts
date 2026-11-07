// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DetailDock from "../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import {
  CONTROL_ENV,
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import { forgetXsRemote, forgetXsSeeds } from "../../../src/web-hub/ui/src/logic/xsRequestState.js";
import type { AgentState, ControlHandle, HubHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * fabric-xs-activation plan §3 P4 — the mention TWO-BRANCH consumption (arch §4.9; the backend
 * halves live in P2's `src/web-hub/agent/commands.ts` + `onSessionRouted` port, which P4 does
 * NOT touch — these assertions run against P2's FROZEN `cmd_result.data.mention` port shape):
 *
 *  branch 1 — the SYNC web path: `routeMention` settles the prompt with
 *    `{op:"prompt", delivery:"observed", behavior:<deliver>, mention:{action:"session", …}}`.
 *  branch 2 — the `onSessionRouted` port: the same mention shape settles a pending frame with
 *    `{op:"prompt", delivery:"observed", behavior:"idle", mention:{action:"session", …}}`.
 *
 * The UI narrowing is branch-agnostic (narrowMentionSession ignores delivery/behavior): both
 * branches seed the request area identically and show the phase-distinguishing note. Also
 * pinned: a legacy outcome (steer/resume/error) never seeds a row, and NOTHING auto-fires the
 * action surface — status frames / SSE reconnects / seeds never call `xsActivate`.
 */

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  for (const w of mounted.splice(0)) w.unmount();
  forgetXsSeeds("agent-a"); // the seed + remote stores are module-global — isolate branches
  forgetXsRemote("agent-a");
});

interface Call {
  method: string;
  args: readonly unknown[];
}

function fakeControl(): { control: ControlHandle; calls: Call[] } {
  const calls: Call[] = [];
  const invoke =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve({ ok: true as const });
    };
  const xsActivate = vi.fn(
    (agentKey: string, args: { action: "activate" | "query"; messageId: string; activationKey?: string }) => {
      calls.push({ method: "xsActivate", args: [agentKey, args] });
      return new Promise<() => void>(() => {}); // never settles — in-flight forever
    },
  );
  return {
    calls,
    control: {
      sendPrompt: ((agentKey: string, text: string) => {
        calls.push({ method: "sendPrompt", args: [agentKey, text] });
        return Promise.resolve(promptOutcome.value);
      }) as ControlHandle["sendPrompt"],
      abort: invoke("abort") as ControlHandle["abort"],
      steerSub: invoke("steerSub") as ControlHandle["steerSub"],
      stopSub: invoke("stopSub") as ControlHandle["stopSub"],
      answerDialog: invoke("answerDialog") as ControlHandle["answerDialog"],
      cancelDialog: invoke("cancelDialog") as ControlHandle["cancelDialog"],
      runCommand: invoke("runCommand") as ControlHandle["runCommand"],
      query: invoke("query"),
      retry: invoke("retry"),
      discard: invoke("discard") as unknown as (agentKey: string, id: string) => void,
      draft: () => "",
      setDraft: () => {},
      xsActivate: xsActivate as ControlHandle["xsActivate"],
    },
  };
}

type PromptOutcome =
  | Extract<Awaited<ReturnType<ControlHandle["sendPrompt"]>>, { ok: true }>
  | { ok: false; error: "E_X"; retryable: false };

/** What the fake `sendPrompt` resolves with next (swapped per test). */
const promptOutcome = ref<PromptOutcome>({ ok: false, error: "E_X", retryable: false });

function mentionOutcome(mention: Record<string, unknown>, behavior: string): PromptOutcome {
  return { ok: true, data: { op: "prompt", delivery: "observed", behavior, mention } };
}

function mountDock(status: Record<string, unknown>, hubCaps: readonly string[]) {
  const { control, calls } = fakeControl();
  const agent = ref({
    key: "agent-a",
    pendingCtl: [],
    queue: [],
    prompts: [],
    fleet: [],
    down: false,
    session: { sessionId: "s1", cwd: "/tmp/p" },
    status,
  } as unknown as AgentState);
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
  const hub: HubHandle = {
    state: ref({
      hub: { caps: hubCaps },
      selected: "agent-a",
      agents: new Map(),
      conn: "open",
    }) as never,
    dispatch: () => {},
  };
  const wrapper = mount(DetailDock, {
    props: { following: true, newCount: 0, now: 5_000 },
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [CONTROL_CTX as symbol]: { agentKey: "agent-a", control, enabled: true },
        [HUB_CTX as symbol]: hub,
        [CONTROL_ENV as symbol]: {
          authMode: "token",
          plaintext: false,
          dialogDrafts: new Map(),
          noticeExpanded: ref(false),
        },
      },
    },
  });
  mounted.push(wrapper);
  return { wrapper, calls, agent };
}

async function send(wrapper: ReturnType<typeof mount>): Promise<void> {
  wrapper.findComponent({ name: "Composer" }).vm.$emit("send", "@beta hi there", "steer");
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const TRACK = { messageId: "m7", activationKey: "k7" };
const progress = (phase: string, wake: Record<string, unknown> = { requested: true, decision: "unknown" }) => ({
  messageId: "m7",
  revision: 0,
  deliveryEffect: "unknown",
  observation: "live",
  phase,
  wake,
});

describe("DetailDock mention two-branch consumption", () => {
  it("branch 1 (sync web, behavior steer) seeds the request row + queued note", async () => {
    promptOutcome.value = mentionOutcome(
      { action: "session", label: "beta", effect: "unknown", track: TRACK, progress: progress("queued") },
      "steer",
    );
    const { wrapper } = mountDock({}, ["cmd.v1", "xs.v1", "xs.state.v1"]);
    await send(wrapper);
    const rows = wrapper.findAll(".xs-request-item");
    expect(rows.length).toBe(1);
    expect(rows[0]!.attributes("data-phase")).toBe("queued");
    const note = wrapper.find(".fleet-actions-note");
    expect(note.text()).toContain("beta");
    expect(note.text()).toContain("queued at the target");
  });

  it("branch 2 (onSessionRouted settle, behavior idle) narrows to the SAME row shape", async () => {
    promptOutcome.value = mentionOutcome(
      { action: "session", label: "beta", effect: "applied", track: TRACK, progress: progress("delivered") },
      "idle",
    );
    const { wrapper } = mountDock({}, ["cmd.v1", "xs.v1", "xs.state.v1"]);
    await send(wrapper);
    const rows = wrapper.findAll(".xs-request-item");
    expect(rows.length).toBe(1);
    expect(rows[0]!.attributes("data-phase")).toBe("delivered");
    expect(wrapper.find(".fleet-actions-note").text()).toContain("Delivered to beta");
  });

  it("a started progress reads as started; a wake-pending delivered reads as dispatch pending", async () => {
    promptOutcome.value = mentionOutcome(
      { action: "session", label: "beta", effect: "unknown", track: TRACK, progress: progress("started") },
      "steer",
    );
    const w1 = mountDock({}, ["cmd.v1", "xs.v1", "xs.state.v1"]);
    await send(w1.wrapper);
    expect(w1.wrapper.find(".fleet-actions-note").text()).toContain("has started");

    promptOutcome.value = mentionOutcome(
      {
        action: "session",
        label: "beta",
        effect: "unknown",
        track: TRACK,
        progress: progress("delivered", { requested: true, decision: "dispatch_accepted" }),
      },
      "idle",
    );
    const w2 = mountDock({}, ["cmd.v1", "xs.v1", "xs.state.v1"]);
    await send(w2.wrapper);
    expect(w2.wrapper.find(".fleet-actions-note").text()).toContain("wake pending");
  });

  it("legacy outcomes (steer/resume/error) never seed a request row", async () => {
    promptOutcome.value = mentionOutcome({ action: "steer", label: "run-1" }, "steer");
    const { wrapper } = mountDock({}, ["cmd.v1", "xs.v1", "xs.state.v1"]);
    await send(wrapper);
    expect(wrapper.find(".xs-request-list").exists()).toBe(false);
    promptOutcome.value = mentionOutcome({ action: "error", label: "beta", error: "nope" }, "steer");
    await send(wrapper);
    expect(wrapper.find(".xs-request-list").exists()).toBe(false);
  });

  it("NO auto-execution: a status frame with rows / a cap-less hub never calls xsActivate", async () => {
    promptOutcome.value = mentionOutcome(
      { action: "session", label: "beta", effect: "unknown", track: TRACK, progress: progress("delivered") },
      "steer",
    );
    const status = {
      xs: { joined: true, receive: "wake", blocked: 0 },
      xsRequests: {
        sessionId: "s1",
        revision: 1,
        rows: [
          {
            messageId: "m7",
            revision: 2,
            deliveryEffect: "applied",
            phase: "delivered",
            observation: "live",
            activationKey: "k7",
            activationUntil: 10_000,
            wake: { requested: true, decision: "downgraded", reason: "pair_wake_rate" },
          },
        ],
      },
    };
    const { wrapper, calls, agent } = mountDock(status, ["cmd.v1", "xs.v1", "xs.state.v1", "xs.activate.v1"]);
    await send(wrapper);
    // an SSE-ish status refresh lands (same shape) — still no auto action
    agent.value = {
      ...agent.value,
      status: { ...status, xsRequests: { ...status.xsRequests, revision: 2 } },
    } as AgentState;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.method === "xsActivate")).toEqual([]);
    // the delivered+downgraded row renders its wake token, and the activate button DID render
    // under the full fake gate (caps + announcement + surface + eligible + online)…
    const btn = wrapper.find("[data-xs-activate]");
    expect(btn.exists()).toBe(true);
    // …but only a USER click fires it — exactly once per business key
    await btn.trigger("click");
    await btn.trigger("click");
    const fired = calls.filter((c) => c.method === "xsActivate");
    expect(fired.length).toBe(1);
    expect(fired[0]!.args).toEqual(["agent-a", { action: "activate", messageId: "m7", activationKey: "k7" }]);
  });

  it("a hub WITHOUT xs.activate.v1 shows no button (the caps half of the gate)", async () => {
    promptOutcome.value = mentionOutcome(
      { action: "session", label: "beta", effect: "unknown", track: TRACK, progress: progress("delivered") },
      "steer",
    );
    const status = {
      xsRequests: {
        sessionId: "s1",
        revision: 1,
        rows: [
          {
            messageId: "m7",
            revision: 2,
            deliveryEffect: "applied",
            phase: "delivered",
            observation: "live",
            activationKey: "k7",
            wake: { requested: true, decision: "downgraded", reason: "pair_wake_rate" },
          },
        ],
      },
    };
    const noCap = mountDock(status, ["cmd.v1", "xs.v1", "xs.state.v1"]); // no xs.activate.v1
    await send(noCap.wrapper);
    expect(noCap.wrapper.find("[data-xs-activate]").exists()).toBe(false);
  });

  it("root fix #6: a hub WITHOUT xs.state.v1 never seeds — legacy/off renders no row and no note", async () => {
    promptOutcome.value = mentionOutcome(
      { action: "session", label: "beta", effect: "unknown", track: TRACK, progress: progress("queued") },
      "steer",
    );
    const { wrapper } = mountDock({}, ["cmd.v1", "xs.v1"]); // no xs.state.v1
    await send(wrapper);
    expect(wrapper.find(".xs-request-list").exists()).toBe(false);
    const note = wrapper.find(".fleet-actions-note");
    expect(note.exists() ? note.text() : "").not.toContain("beta"); // no session note
    expect(wrapper.text()).not.toContain("beta"); // byte-identical legacy fall-through
  });

  it("root fix #8: the session-mention early return clears a previous steer toast", async () => {
    // first a steer outcome leaves its toast…
    promptOutcome.value = mentionOutcome({ action: "steer", label: "run-1" }, "steer");
    const { wrapper } = mountDock({}, ["cmd.v1", "xs.v1", "xs.state.v1"]);
    await send(wrapper);
    expect(wrapper.find(".fleet-actions-note").text()).toContain("run-1");
    // …then a session mention replaces it (no dead-timer toast lingers)
    promptOutcome.value = mentionOutcome(
      { action: "session", label: "beta", effect: "unknown", track: TRACK, progress: progress("queued") },
      "steer",
    );
    await send(wrapper);
    const notes = wrapper.findAll(".fleet-actions-note");
    expect(notes.length).toBe(1);
    expect(notes[0]!.text()).toContain("beta");
    expect(notes[0]!.text()).not.toContain("run-1");
  });

  it("a wrong-session status slot is dropped wholesale (错 session 丢弃)", async () => {
    promptOutcome.value = mentionOutcome(
      { action: "session", label: "beta", effect: "unknown", track: TRACK, progress: progress("delivered") },
      "steer",
    );
    const { wrapper } = mountDock(
      {
        xsRequests: {
          sessionId: "OTHER-SESSION",
          revision: 1,
          rows: [
            {
              messageId: "mX",
              revision: 1,
              deliveryEffect: "applied",
              phase: "replied",
              observation: "live",
              wake: { requested: false, decision: "deliver_only" },
            },
          ],
        },
      },
      ["cmd.v1", "xs.v1", "xs.state.v1"],
    );
    await send(wrapper);
    const rows = wrapper.findAll(".xs-request-item");
    expect(rows.length).toBe(1);
    expect(rows[0]!.find(".xs-request-id").text()).toBe("m7"); // the seed — the foreign mX row never lands
  });
});
