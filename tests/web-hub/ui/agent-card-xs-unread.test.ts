// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { describe, expect, it } from "vitest";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import {
  toAgentCardView,
  xsUnreadLabel,
  xsUnreadOf,
} from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

const agent = (status: Record<string, unknown> = {}): AgentState =>
  ({
    key: "a",
    card: {},
    session: {},
    status,
    fleet: [],
    prompts: [],
    tools: [],
    streaming: null,
    down: false,
  }) as unknown as AgentState;
const card = toAgentCardView(agent(), (k) => k);
function html(a: AgentState, caps: unknown) {
  const hub = {
    state: ref({ agents: new Map([["a", a]]), hub: { caps } } as unknown as HubState),
    dispatch() {},
  } as HubHandle;
  const w = mount(AgentCard, { props: { card, selected: false }, global: { provide: { [HUB_CTX as symbol]: hub } } });
  const out = w.html();
  w.unmount();
  return out;
}
describe("xsInbox unread badge", () => {
  it("model gating", () => {
    expect(xsUnreadOf(agent({ xsInbox: { unread: 3 } }), ["xs.v1"])).toBe(3);
    expect(xsUnreadOf(agent({ xsInbox: { unread: 3 } }), [])).toBeUndefined();
    expect(xsUnreadOf(agent(), ["xs.v1"])).toBeUndefined();
    for (const u of [0, -1, 1.5, "2", null])
      expect(xsUnreadOf(agent({ xsInbox: { unread: u } }), ["xs.v1"])).toBeUndefined();
    expect(xsUnreadLabel(99)).toBe("99");
    expect(xsUnreadLabel(100)).toBe("99+");
  });
  it("card renders badge only with cap + field; absent ⇒ bytes unchanged", () => {
    const out = html(agent({ xsInbox: { unread: 5 } }), ["xs.v1"]);
    expect(out).toContain("chip-xs-unread");
    expect(out).toContain("5 unread");
    expect(html(agent({ xsInbox: { unread: 150 } }), ["xs.v1"])).toContain("99+");
    expect(html(agent({ xsInbox: { unread: 5 } }), [])).toBe(html(agent(), []));
    expect(html(agent(), ["xs.v1"])).not.toContain("chip-xs-unread");
  });
});
