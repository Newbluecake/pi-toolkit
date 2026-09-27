import { describe, expect, it } from "vitest";
import { agentVisualState, fleetRowVisualState } from "../../../src/web-hub/ui/src/composables/visual-state.js";

const row = (
  over: Partial<{ status: string; phaseLabel: string; highlight: "none" | "warn" | "crit"; terminal: boolean }> = {},
) => ({
  status: "running",
  phaseLabel: "",
  highlight: "none" as const,
  terminal: false,
  ...over,
});

const agent = (
  over: Partial<{
    down: boolean;
    prompts: unknown[];
    card: Record<string, unknown>;
    status: Record<string, unknown> | undefined;
  }> = {},
) => ({
  down: false,
  prompts: [] as unknown[],
  card: {},
  status: undefined as Record<string, unknown> | undefined,
  ...over,
});

describe("visual-state (ui-design.md §3.2, vue-plan.md v2.1 §5.2 — P1)", () => {
  describe("fleetRowVisualState: subagent/fleet-row column, exhaustive over §3.2's table", () => {
    it("running: status=running, no other signal", () => {
      expect(fleetRowVisualState(row({ status: "running" }))).toBe("running");
    });
    it("thinking: phaseLabel mentions model_turn/thinking while running", () => {
      expect(fleetRowVisualState(row({ status: "running", phaseLabel: "model_turn" }))).toBe("thinking");
      expect(fleetRowVisualState(row({ status: "running", phaseLabel: "Thinking" }))).toBe("thinking");
    });
    it("tool: phaseLabel mentions tool_exec while running", () => {
      expect(fleetRowVisualState(row({ status: "running", phaseLabel: "tool_exec" }))).toBe("tool");
      expect(fleetRowVisualState(row({ status: "running", phaseLabel: "Tool Execution" }))).toBe("tool");
    });
    it("idle: no recognized phase and not running", () => {
      expect(fleetRowVisualState(row({ status: "idle", phaseLabel: "" }))).toBe("idle");
    });
    it("queued: status=queued", () => {
      expect(fleetRowVisualState(row({ status: "queued" }))).toBe("queued");
    });
    it("done: terminal && status=completed", () => {
      expect(fleetRowVisualState(row({ status: "completed", terminal: true }))).toBe("done");
    });
    it("a non-terminal 'completed' status (shouldn't happen, but stay total) falls through to idle/running by phase", () => {
      expect(fleetRowVisualState(row({ status: "completed", terminal: false }))).toBe("idle");
    });
    it("failed / timed_out", () => {
      expect(fleetRowVisualState(row({ status: "failed" }))).toBe("failed");
      expect(fleetRowVisualState(row({ status: "timed_out" }))).toBe("timed_out");
    });
    it("highlight=crit always wins (even over a 'running' status)", () => {
      expect(fleetRowVisualState(row({ status: "running", highlight: "crit" }))).toBe("failed");
    });
    it("aborted: status=aborted", () => {
      expect(fleetRowVisualState(row({ status: "aborted" }))).toBe("aborted");
    });
    it("a terminal row with no other recognized status/phase is done", () => {
      expect(fleetRowVisualState(row({ status: "unknown-status", terminal: true, phaseLabel: "" }))).toBe("done");
    });
  });

  describe("agentVisualState: agent-card column, exhaustive over §3.2's table", () => {
    it("offline: agent_down (down=true) wins over everything else", () => {
      expect(agentVisualState(agent({ down: true, prompts: [{ kind: "x", since: 1 }] }))).toBe("offline");
    });
    it("waiting: a non-empty prompts[] (blocked on a dialog)", () => {
      expect(agentVisualState(agent({ prompts: [{ kind: "custom", since: 1 }] }))).toBe("waiting");
    });
    it("stale: card.state === 'stale'", () => {
      expect(agentVisualState(agent({ card: { state: "stale" } }))).toBe("stale");
    });
    it("running: status.busy === true", () => {
      expect(agentVisualState(agent({ status: { busy: true } }))).toBe("running");
    });
    it("idle: none of the above", () => {
      expect(agentVisualState(agent())).toBe("idle");
      expect(agentVisualState(agent({ status: { busy: false } }))).toBe("idle");
    });
    it("priority order: waiting beats stale, stale beats running", () => {
      expect(
        agentVisualState(
          agent({ prompts: [{ kind: "x", since: 1 }], card: { state: "stale" }, status: { busy: true } }),
        ),
      ).toBe("waiting");
      expect(agentVisualState(agent({ card: { state: "stale" }, status: { busy: true } }))).toBe("stale");
    });
  });
});
