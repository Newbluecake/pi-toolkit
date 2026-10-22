// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { describe, expect, it } from "vitest";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import {
  homeFromAgent,
  homeFromAgents,
  shortCwd,
  xsBadgeOf,
  toAgentCardView,
} from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
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
  it.each([
    ["wake", "radio", "can wake this session"],
    ["deliver", "inbox", "delivered but do not wake"],
    ["replies", "swap", "only replies to requests"],
    ["off", "ban", "currently rejecting all messages"],
  ])("joined %s ⇒ icon %s + i18n title/aria; no button", (receive, icon, text) => {
    expect(xsBadgeOf(agent({ joined: true, receive }), ["xs.v1"])).toBe(receive);
    const out = html(agent({ joined: true, receive }), ["xs.v1"]);
    expect(out).toContain(`data-xs="${receive}"`);
    expect(out).toContain(`href="#i-${icon}"`);
    expect(out).toMatch(new RegExp(`title="Cross-session: joined — [^"]*${text}`));
    expect(out).toMatch(new RegExp(`aria-label="Cross-session: joined — [^"]*${text}`));
    expect(out).not.toContain("<button");
  });
  it("no cap / not joined ⇒ no chip-xs", () => {
    expect(html(agent({ joined: true, receive: "wake" }), [])).not.toContain("chip-xs");
    expect(html(agent({ joined: false, receive: "wake" }), ["xs.v1"])).not.toContain("chip-xs");
  });
  it("shortCwd: home → ~, outside home → absolute; home recovered from worktree rows", () => {
    expect(shortCwd("/home/u/ai/pi-toolkit", "/home/u")).toBe("~/ai/pi-toolkit");
    expect(shortCwd("/home/u", "/home/u")).toBe("~");
    expect(shortCwd("/home/user2/x", "/home/u")).toBe("/home/user2/x");
    expect(shortCwd("/srv/x/y/z")).toBe("/srv/x/y/z");
    expect(shortCwd("")).toBe("/");
    const wt = { worktrees: { rows: [{ path: "/home/u/ai/pi-toolkit", label: "~/ai/pi-toolkit" }] } };
    const a = { ...agent(), status: wt } as unknown as AgentState;
    expect(homeFromAgent(a)).toBe("/home/u");
    expect(homeFromAgents([agent(), a])).toBe("/home/u");
    expect(homeFromAgent(agent())).toBeUndefined();
  });
  it("card title carries the full absolute cwd; text is the ~ path", () => {
    const a = { ...agent(), session: { cwd: "/home/u/ai/pi-toolkit" } } as unknown as AgentState;
    const v = toAgentCardView(a, (k) => k, "/home/u");
    expect(v.shortCwd).toBe("~/ai/pi-toolkit");
    expect(v.cwdFull).toBe("/home/u/ai/pi-toolkit");
  });
  it("unjoined/malformed/absent status renders no badge", () => {
    for (const xs of [undefined, null, {}, { joined: false, receive: "wake" }, { joined: true, receive: "oops" }])
      expect(xsBadgeOf(agent(xs), ["xs.v1"])).toBeUndefined();
  });
});
