/**
 * 2026-10-10 bug 「计费显示被挤出去了」: the card used to print `total (subagents)`, which
 * overflowed the first row and squeezed the cwd title to nothing. The label is now the total
 * only; the breakdown moves to the hover title (only when subagents cost anything).
 */
import { describe, expect, it } from "vitest";
import { agentCostLabel, agentCostTitle } from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

const t = (key: string, vars?: Record<string, string | number>): string =>
  `${key}:${vars?.["own"] ?? ""}/${vars?.["sub"] ?? ""}`;
const agent = (status: unknown): AgentState => ({ status }) as unknown as AgentState;

describe("agent card cost label", () => {
  it("shows the total only, with the breakdown in the tooltip", () => {
    const a = agent({ costUsd: 0.7, subagentCostUsd: 0.25 });
    expect(agentCostLabel(a)).not.toContain("(");
    expect(agentCostLabel(a)).toMatch(/^\$0\.95/);
    expect(agentCostTitle(a, t)).toMatch(/^agents\.costTitle:\$0\.7.*\/\$0\.25/);
  });
  it("no subagent cost ⇒ own cost, no tooltip; unknown ⇒ dash", () => {
    expect(agentCostTitle(agent({ costUsd: 1 }), t)).toBeUndefined();
    expect(agentCostLabel(agent({ costUsd: 1 }))).toMatch(/^\$1/);
    expect(agentCostLabel(agent({}))).toBe("—");
  });
});
