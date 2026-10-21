// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { describe, expect, it } from "vitest";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import { xsBadgeOf, toAgentCardView } from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
const agent = (xs?: unknown): AgentState =>
  ({
    key: "a",
    card: {},
    session: {},
    status: { ...(xs === undefined ? {} : { xs }) },
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
  const result = w.html();
  w.unmount();
  return result;
}
describe("AgentCard xs read-only badge", () => {
  it("cap missing: even joined status leaves rendered bytes unchanged", () => {
    expect(html(agent({ joined: true, receive: "wake" }), [])).toBe(html(agent(), []));
  });
  it.each(["wake", "deliver", "off"])("joined %s badge; no button or mutation affordance", (receive) => {
    expect(xsBadgeOf(agent({ joined: true, receive }), ["xs.v1"])).toBe(`xs ${receive}`);
    expect(html(agent({ joined: true, receive }), ["xs.v1"])).toContain(
      `class="chip chip-xs" translate="no">xs ${receive}</span>`,
    );
  });
  it("unjoined/malformed/absent status renders no badge", () => {
    for (const xs of [undefined, null, {}, { joined: false, receive: "wake" }, { joined: true, receive: "oops" }])
      expect(xsBadgeOf(agent(xs), ["xs.v1"])).toBeUndefined();
  });
});
