// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { AgentState, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/** Composer @mention panel — cross-session (`@session:<ref> `) entries (todo #10). */

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  window.localStorage.clear();
});
const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const w of mounted.splice(0)) w.unmount();
});

const noop = () => Promise.resolve({ ok: true as const });
function fakeControl(): ControlHandle {
  const drafts = new Map<string, string>();
  return {
    sendPrompt: noop,
    abort: noop,
    steerSub: noop,
    stopSub: noop,
    answerDialog: noop,
    cancelDialog: noop,
    runCommand: noop,
    query: noop,
    retry: noop,
    discard: () => {},
    draft: (k: string) => drafts.get(k) ?? "",
    setDraft: (k: string, t: string) => void drafts.set(k, t),
  } as unknown as ControlHandle;
}

function ag(key: string, sid: string, over: Record<string, unknown> = {}): AgentState {
  const { xs, name, down, cwd, fleet, cardState } = {
    xs: { joined: true, receive: "wake" } as unknown,
    name: undefined as string | undefined,
    down: false,
    cwd: `/home/u/${key}`,
    fleet: [] as unknown[],
    cardState: undefined as string | undefined,
    ...over,
  };
  return {
    key,
    card: { cwd, ...(cardState ? { state: cardState } : {}) },
    down,
    prompts: [],
    fleet,
    session: { sessionId: sid, cwd, ...(name ? { name } : {}) },
    status: xs === undefined ? {} : { xs },
  } as unknown as AgentState;
}

function mountWith(agents: AgentState[], opts: { caps?: string[]; self?: string } = {}) {
  const self = opts.self ?? "me";
  const map = new Map(agents.map((a) => [a.key, a]));
  const selfAgent = map.get(self)!;
  const view = {
    agentKey: self,
    control: null,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => selfAgent),
    busy: computed(() => false),
    commands: computed(() => []),
    commandsEnabled: computed(() => false),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  } as unknown as ControlView;
  const hub = { state: ref({ agents: map, hub: { caps: opts.caps ?? ["xs.v1"] } }) };
  const ctx = { agentKey: self, control: fakeControl(), enabled: true };
  const w = mount(Composer, {
    props: { enabled: true, busy: false },
    attachTo: document.body,
    global: { provide: { [CONTROL_VIEW as symbol]: view, [CONTROL_CTX as symbol]: ctx, [HUB_CTX as symbol]: hub } },
  });
  mounted.push(w);
  return w;
}

async function type(w: ReturnType<typeof mount>, v: string) {
  const ta = w.find("textarea");
  await ta.setValue(v);
  (ta.element as HTMLTextAreaElement).setSelectionRange(v.length, v.length);
  await ta.trigger("input");
}
const labels = (w: ReturnType<typeof mount>) => w.findAll(".mention-item").map((i) => i.find(".mention-label").text());

const SID_B = "bbbbbbbbbbbb1111-2222";
const SID_C = "cccccccccccc3333-4444";

describe("Composer @session mention entries", () => {
  it("lists joined peers (name or ref), excludes self/offline/stale/not-joined, shows receive token", async () => {
    const w = mountWith([
      ag("me", "aaaaaaaaaaaa0000", { name: "myself" }),
      ag("b", SID_B, { name: "alpha", xs: { joined: true, receive: "deliver" } }),
      ag("c", SID_C),
      ag("d", "dddddddddddd", { down: true }),
      ag("e", "eeeeeeeeeeee", { cardState: "stale" }),
      ag("f", "ffffffffffff", { xs: { joined: false, receive: "off" } }),
    ]);
    await type(w, "@");
    expect(labels(w)).toEqual(["alpha", "cccccccccccc"]);
    expect(w.findAll(".mention-session .mention-status").map((x) => x.text())).toEqual(["xs deliver", "xs wake"]);
  });

  it("gates: hub caps without xs.v1 or self not joined ⇒ no session entries", async () => {
    const a = [ag("me", "a1a1a1a1a1a1"), ag("b", SID_B, { name: "alpha" })];
    const w1 = mountWith(a, { caps: [] });
    await type(w1, "@");
    expect(w1.find(".mention-panel").exists()).toBe(false);
    const w2 = mountWith([ag("me", "a1a1a1a1a1a1", { xs: { joined: false, receive: "off" } }), ag("b", SID_B)]);
    await type(w2, "@");
    expect(w2.find(".mention-panel").exists()).toBe(false);
  });

  it("Enter/click on a session inserts `@session:<12-char ref> `", async () => {
    const w = mountWith([ag("me", "a1a1a1a1a1a1"), ag("b", SID_B, { name: "alpha" })]);
    await type(w, "@al");
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("@session:bbbbbbbbbbbb ");
    await type(w, "@");
    await w.find(".mention-session").trigger("click");
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("@session:bbbbbbbbbbbb ");
  });

  it("filters by name, ref, cwd basename and explicit `session:` lead", async () => {
    const w = mountWith([
      ag("me", "a1a1a1a1a1a1"),
      ag("b", SID_B, { name: "alpha", cwd: "/home/u/proj-x" }),
      ag("c", SID_C, { name: "beta" }),
    ]);
    await type(w, "@AL");
    expect(labels(w)).toEqual(["alpha"]);
    await type(w, "@cccc");
    expect(labels(w)).toEqual(["beta"]);
    await type(w, "@proj");
    expect(labels(w)).toEqual(["alpha"]);
    await type(w, "@session:be");
    expect(labels(w)).toEqual(["beta"]);
  });

  it("sub-agents come first; keyboard navigation crosses zones; Esc closes", async () => {
    const fleet = [{ runId: "r1", label: "bot", status: "running", terminal: false }];
    const w = mountWith([ag("me", "a1a1a1a1a1a1", { fleet }), ag("b", SID_B, { name: "alpha" })]);
    await type(w, "@");
    expect(labels(w)).toEqual(["@bot", "alpha"]);
    const ta = w.find("textarea");
    await ta.trigger("keydown", { key: "ArrowDown" });
    expect(w.findAll(".mention-item")[1]!.classes()).toContain("active");
    await ta.trigger("keydown", { key: "Escape" });
    expect(w.find(".mention-panel").exists()).toBe(false);
  });
});
