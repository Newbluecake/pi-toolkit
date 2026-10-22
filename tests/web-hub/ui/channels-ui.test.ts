// @vitest-environment happy-dom
/** channel-plan §7 (CHU): card chip, sidebar filter, @ panel filter, channel management dialog. */
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import AgentList from "../../../src/web-hub/ui/src/components/agents/AgentList.vue";
import ChannelsDialog from "../../../src/web-hub/ui/src/components/detail/ChannelsDialog.vue";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import {
  toAgentCardView,
  xsChannelChipOf,
  xsChannelsOf,
} from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
import { channelDirectory, checkNewChannel } from "../../../src/web-hub/ui/src/components/agents/channelModel.js";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { sessionMentionTargets } from "../../../src/web-hub/ui/src/components/control/sessionMention.js";
import { CHANNELS_EXTRA } from "../../../src/web-hub/ui/src/i18n/channels-extra.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

const CAPS = ["xs.v1", "xs.channel.v1"];
const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

const ag = (key: string, xs: Record<string, unknown> | undefined, sid = key + "-0123456789abcdef"): AgentState =>
  ({
    key,
    card: { agentKey: key, kind: "tui", state: "live", cwd: "/w/" + key },
    session: { sessionId: sid, name: key },
    status: xs === undefined ? {} : { xs: { receive: "wake", blocked: 0, ...xs } },
    fleet: [],
    prompts: [],
    tools: [],
    streaming: null,
    down: false,
  }) as unknown as AgentState;
const hubOf = (agents: AgentState[], caps: unknown = CAPS): HubHandle =>
  ({
    state: ref({ agents: new Map(agents.map((a) => [a.key, a])), hub: { caps } } as unknown as HubState),
    dispatch() {},
  }) as unknown as HubHandle;

describe("model", () => {
  it("xsChannelsOf / chip gating", () => {
    expect(xsChannelsOf(ag("a", { joined: true }), CAPS)).toEqual(["default"]);
    expect(xsChannelsOf(ag("a", { joined: true }), ["xs.v1"])).toBeUndefined();
    expect(xsChannelsOf(ag("a", { joined: false }), CAPS)).toBeUndefined();
    expect(xsChannelsOf(ag("a", { joined: false, channels: ["x"] }), CAPS)).toEqual(["x"]);
    expect(xsChannelChipOf(ag("a", { joined: true }), CAPS)).toBeUndefined();
    expect(xsChannelChipOf(ag("a", { joined: true, channels: ["default", "x"] }), CAPS)).toEqual(["default", "x"]);
  });
  it("directory + name check", () => {
    const d = channelDirectory(
      new Map([
        ["a", ag("a", { joined: true })],
        ["b", ag("b", { joined: true, channels: ["default", "x"] })],
        ["c", ag("c", { joined: false, channels: ["x"] })],
      ]),
      CAPS,
    );
    expect(d).toEqual([
      { name: "default", members: 2 },
      { name: "x", members: 2 },
    ]);
    expect(checkNewChannel("#Dev", [])).toEqual({ ok: true, name: "dev" });
    expect(checkNewChannel("é", [])).toMatchObject({ reason: "invalid" });
    expect(checkNewChannel("pi-x", [])).toMatchObject({ reason: "reserved" });
    expect(checkNewChannel("all", [])).toMatchObject({ reason: "reserved" });
    expect(checkNewChannel("x", ["x"])).toMatchObject({ reason: "joined" });
    expect(checkNewChannel("e", ["a", "b", "c", "d"])).toMatchObject({ reason: "full" });
  });
  it("i18n parity", () => {
    const k = (o: Record<string, string>) => Object.keys(o).sort();
    expect(k(CHANNELS_EXTRA.zh)).toEqual(k(CHANNELS_EXTRA.en));
  });
});

describe("card chip", () => {
  const html = (a: AgentState, caps: unknown) => {
    const w = mount(AgentCard, {
      props: { card: toAgentCardView(a, (k) => k), selected: false },
      global: { provide: { [HUB_CTX as symbol]: hubOf([a], caps) } },
    });
    const out = w.html();
    w.unmount();
    return out;
  };
  it("only for ≠ [default] with cap", () => {
    expect(html(ag("a", { joined: true, channels: ["default", "x"] }), CAPS)).toContain("#default #x");
    expect(html(ag("a", { joined: true }), CAPS)).not.toContain("chip-xs-channels");
    expect(html(ag("a", { joined: true, channels: ["x"] }), ["xs.v1"])).not.toContain("chip-xs-channels");
  });
});

describe("sidebar filter", () => {
  const agents = [
    ag("a", { joined: true }),
    ag("b", { joined: true, channels: ["default", "x"] }),
    ag("c", { joined: false, channels: ["y"] }),
  ];
  const mountList = (list: AgentState[], caps: unknown = CAPS) => {
    const w = mount(AgentList, {
      props: { cards: list.map((a) => toAgentCardView(a, (k) => k)), selectedKey: null, filter: "" } as never,
      global: { provide: { [HUB_CTX as symbol]: hubOf(list, caps) } },
    });
    mounted.push(w);
    return w;
  };
  it("chip row appears only with a non-default channel; picking filters; no persistence", async () => {
    const w = mountList(agents);
    const chips = w.findAll(".channel-filter .chip");
    expect(chips.map((c) => c.text().replace(/\s+/g, " "))).toEqual(["All", "#default 2", "#x 1", "#y 1"]);
    await chips[2]!.trigger("click");
    expect(w.findAll(".agent-card")).toHaveLength(1);
    await chips[0]!.trigger("click");
    expect(w.findAll(".agent-card")).toHaveLength(3);
    expect(window.localStorage.length).toBe(0);
    expect(mountList([agents[0]!]).find(".channel-filter").exists()).toBe(false);
    expect(mountList(agents, ["xs.v1"]).find(".channel-filter").exists()).toBe(false);
  });
});

describe("@ panel", () => {
  it("lists only sessions sharing a channel when cap present", () => {
    const self = ag("s", { joined: true, channels: ["default", "x"] });
    const m = new Map(
      [
        self,
        ag("a", { joined: true }),
        ag("b", { joined: false, channels: ["x"] }),
        ag("c", { joined: false, channels: ["y"] }),
      ].map((a) => [a.key, a]),
    );
    const keys = (caps: unknown) => sessionMentionTargets(m, caps, "s", (k) => k).map((t) => t.key);
    expect(keys(CAPS)).toEqual(["a", "b"]);
    expect(keys(["xs.v1"])).toEqual(["a"]); // no channel cap ⇒ legacy, unfiltered
  });
});

describe("channels dialog", () => {
  function setup(self: AgentState, others: AgentState[], outcome: () => Promise<CmdOutcome>) {
    const runs: string[][] = [];
    const control = {
      runCommand: (k: string, n: string, a: string) => {
        runs.push([k, n, a]);
        return outcome();
      },
    } as unknown as ControlHandle;
    const hub = hubOf([self, ...others]);
    const view: ControlView = {
      agentKey: self.key,
      control,
      enabled: computed(() => true),
      readonlyReason: computed(() => null),
      agent: computed(() => hub.state.value.agents.get(self.key)!),
      busy: computed(() => false),
      commands: computed(() => []),
      commandsEnabled: computed(() => true),
      sending: computed(() => false),
      queueItems: computed(() => []),
      isWebMessage: () => false,
    };
    const w = mount(ChannelsDialog, {
      global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
      attachTo: document.body,
    });
    mounted.push(w);
    return { w: new DOMWrapper(document.body), runs, hub };
  }
  const ok = () => Promise.resolve({ ok: true } as CmdOutcome);

  it("lists channels with counts, ticks joined, toggles via /fabric join|leave, no optimistic update", async () => {
    const self = ag("s", { joined: true });
    const { w, runs } = setup(self, [ag("b", { joined: true, channels: ["default", "x"] })], ok);
    const rows = w.findAll(".channels-row");
    expect(rows.map((r) => r.find(".channels-name").text())).toEqual(["#default", "#x"]);
    expect((rows[0]!.find("input").element as HTMLInputElement).checked).toBe(true);
    expect((rows[1]!.find("input").element as HTMLInputElement).checked).toBe(false);
    expect(rows[0]!.text()).toContain("Leaving #default");
    await rows[1]!.find("input").trigger("change");
    await flushPromises();
    expect(runs).toEqual([["s", "fabric", "join #x"]]);
    expect((w.findAll(".channels-row")[1]!.find("input").element as HTMLInputElement).checked).toBe(false);
    await rows[0]!.find("input").trigger("change");
    expect(runs[1]).toEqual(["s", "fabric", "leave #default"]);
  });
  it("in-flight state, failure message, serialised", async () => {
    let release: (o: CmdOutcome) => void = () => {};
    const { w, runs } = setup(
      ag("s", { joined: true }),
      [ag("b", { joined: true, channels: ["x"] })],
      () => new Promise<CmdOutcome>((r) => (release = r)),
    );
    await w.findAll(".channels-row")[1]!.find("input").trigger("change");
    expect(w.text()).toContain("Applying");
    expect(w.findAll(".channels-row input").every((i) => (i.element as HTMLInputElement).disabled)).toBe(true);
    release({ ok: false, error: "E_DENIED", message: "policy denies" });
    await flushPromises();
    expect(w.text()).toContain("Failed: policy denies");
    expect(runs).toHaveLength(1);
  });
  it("create: pre-validation, reserved, submit, full", async () => {
    const { w, runs } = setup(ag("s", { joined: true }), [], ok);
    const input = w.get("input[name=channel-name]");
    const submit = w.get("button[type=submit]");
    expect(submit.attributes("disabled")).toBeDefined();
    await input.setValue("all");
    expect(w.get(".channels-new .channels-hint").text()).toContain("reserved");
    expect(submit.attributes("disabled")).toBeDefined();
    await input.setValue("Bad Name");
    expect(w.get(".channels-new .channels-hint").text()).toContain("lowercase");
    await input.setValue("#Dev");
    expect(submit.attributes("disabled")).toBeUndefined();
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(runs).toEqual([["s", "fabric", "join #dev"]]);
  });
});

describe("channels dialog — full", () => {
  it("4 joined ⇒ input disabled + hint", () => {
    const ok = () => Promise.resolve({ ok: true } as CmdOutcome);
    const self = ag("f", { joined: false, channels: ["a", "b", "c", "d"] });
    const control = { runCommand: ok } as unknown as ControlHandle;
    const hub = hubOf([self]);
    const view = {
      agentKey: "f",
      control,
      agent: computed(() => self),
    } as unknown as ControlView;
    const w = mount(ChannelsDialog, {
      global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
      attachTo: document.body,
    });
    mounted.push(w);
    const body = new DOMWrapper(document.body);
    expect(body.text()).toContain("Up to 4 channels");
    expect(body.get("input[name=channel-name]").attributes("disabled")).toBeDefined();
  });
});

describe("header button", () => {
  it("appears only with cap + status.xs + control", () => {
    const mountHeader = (a: AgentState, caps: unknown) => {
      const hub = hubOf([a], caps);
      const view = {
        agentKey: a.key,
        control: {} as ControlHandle,
        enabled: computed(() => true),
        readonlyReason: computed(() => null),
        agent: computed(() => a),
        busy: computed(() => false),
        commands: computed(() => []),
        commandsEnabled: computed(() => true),
        sending: computed(() => false),
        queueItems: computed(() => []),
        isWebMessage: () => false,
      } as ControlView;
      const w = mount(DetailHeader, {
        props: { agent: a, narrow: false },
        global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
      });
      mounted.push(w);
      return w;
    };
    expect(
      mountHeader(ag("a", { joined: false }), CAPS)
        .find(".detail-channels-btn")
        .exists(),
    ).toBe(true);
    expect(
      mountHeader(ag("a", { joined: false }), ["xs.v1"])
        .find(".detail-channels-btn")
        .exists(),
    ).toBe(false);
    expect(mountHeader(ag("a", undefined), CAPS).find(".detail-channels-btn").exists()).toBe(false);
  });
});
