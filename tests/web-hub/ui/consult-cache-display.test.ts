// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { resetLangForTests } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import FleetTree from "../../../src/web-hub/ui/src/components/fleet/FleetTree.vue";
import RunTranscript from "../../../src/web-hub/ui/src/components/drawer/RunTranscript.vue";
import type { FleetRowWire } from "../../../src/web-hub/protocol/messages.js";
import type { RunTranscriptProps } from "../../../src/web-hub/ui/src/contracts.js";
import type { AgentCard } from "../../../src/web-hub/ui/src/types.js";

/**
 * cache-thread plan §5.3 (U): the web consult display — the FleetTree consult
 * row renders the fleet frame's `cacheMark` as a translate="no" English token
 * in the line-2 slot, and the consult record page (RunTranscript) shows the
 * marker from the consult-fallback entry's `consultMark` or the fleet row's
 * `cacheMark`. Rows/pages without the fields render nothing new.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  resetLangForTests();
  document.body.innerHTML = "";
});

function fleetRow(runId: string, extra: Record<string, unknown> = {}): FleetRowWire {
  return {
    runId,
    label: `label-${runId}`,
    type: "general",
    status: "running",
    phaseLabel: "working",
    elapsedMs: 1000,
    phaseMs: 0,
    highlight: "none",
    terminal: false,
    ...extra,
  } as FleetRowWire;
}

describe("FleetTree consult cache mark (§5.3 U)", () => {
  function mountTree(rows: readonly FleetRowWire[]) {
    const nodes = rows.map((row) => ({ row: row as unknown as Record<string, unknown>, depth: 0, children: [] }));
    const wrapper = mount(FleetTree, { props: { nodes, now: 10_000 } });
    mounted.push(wrapper);
    return wrapper;
  }

  it("renders the compact marker in the consult row's line-2 slot", () => {
    const wrapper = mountTree([fleetRow("run-consult", { consult: true, cacheMark: "t#2 warm·hit 96%" })]);
    const mark = wrapper.get(".run-cachemark");
    expect(mark.text()).toContain("warm·hit 96%");
    expect(mark.attributes("translate")).toBe("no");
    expect(wrapper.text()).toContain("t#2 warm·hit 96%");
  });

  it("renders the marker also when the row carries live activity", () => {
    const wrapper = mountTree([
      fleetRow("run-consult", { consult: true, toolTrail: "▸read", cacheMark: "cold·miss 3%" }),
    ]);
    expect(wrapper.get(".run-cachemark").text()).toContain("cold·miss 3%");
  });

  it("rows without cacheMark render no marker node (byte-identical DOM)", () => {
    const wrapper = mountTree([fleetRow("run-plain"), fleetRow("run-consult", { consult: true })]);
    expect(wrapper.findAll(".run-cachemark")).toHaveLength(0);
  });

  it.each([
    ["pending prediction", "warm·…"],
    ["degraded partial", "?·partial 41%·degraded"],
    ["unusable metric", "?·n/a"],
  ])("renders %s verbatim", (_name, mark) => {
    const wrapper = mountTree([fleetRow("run-consult", { consult: true, cacheMark: mark })]);
    expect(wrapper.get(".run-cachemark").text()).toContain(mark);
  });
});

describe("RunTranscript consult cache mark (§5.3 U)", () => {
  function card(): AgentCard {
    return {
      agentKey: "a:b",
      kind: "tui",
      pid: 1,
      cwd: "/tmp/p",
      state: "live",
      pluginVersion: "1.0.0",
      outdated: false,
      runTranscript: true,
      prompts: [],
    } as unknown as AgentCard;
  }

  function mountTx(props: Partial<RunTranscriptProps> & { agent: RunTranscriptProps["agent"] }) {
    const wrapper = mount(RunTranscript, { props: props as RunTranscriptProps });
    mounted.push(wrapper);
    return wrapper;
  }

  it("shows the marker from the consult-fallback question entry", () => {
    const wrapper = mountTx({
      agent: {
        ...card(),
        runTx: {
          runId: "run-consult",
          items: [
            {
              id: "consult-question",
              parentId: null,
              type: "message",
              timestamp: new Date(0).toISOString(),
              message: {
                role: "user",
                content: "q",
                consultSummary: true,
                consultMark: "t#2 warm·hit 96%",
              },
            },
          ],
          streaming: false,
          tools: [],
          history: "loaded",
          hasMore: false,
          paging: false,
          live: true,
          terminal: false,
        },
      } as never,
    });
    const mark = wrapper.get(".run-tx-cachemark");
    expect(mark.text()).toBe("t#2 warm·hit 96%");
    expect(mark.attributes("translate")).toBe("no");
  });

  it("falls back to the fleet row's cacheMark when the transcript is file-backed", () => {
    const wrapper = mountTx({
      agent: {
        ...card(),
        runTx: {
          runId: "run-consult",
          items: [],
          streaming: false,
          tools: [],
          history: "loaded",
          hasMore: false,
          paging: false,
          live: true,
          terminal: false,
          lastRow: fleetRow("run-consult", { consult: true, cacheMark: "cold·miss 3%" }),
        },
      } as never,
    });
    expect(wrapper.get(".run-tx-cachemark").text()).toBe("cold·miss 3%");
  });

  it("no marker node without facts (byte-identical page)", () => {
    const wrapper = mountTx({
      agent: {
        ...card(),
        runTx: {
          runId: "run-plain",
          items: [],
          streaming: false,
          tools: [],
          history: "loaded",
          hasMore: false,
          paging: false,
          live: true,
          terminal: false,
          lastRow: fleetRow("run-plain"),
        },
      } as never,
    });
    expect(wrapper.find(".run-tx-cachemark").exists()).toBe(false);
    expect(wrapper.find(".run-tx-consult").exists()).toBe(false);
  });
});
