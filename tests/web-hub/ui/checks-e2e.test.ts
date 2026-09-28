import { describe, expect, it } from "vitest";
import {
  AGENT_ALPHA_ROUTE,
  AXE_SCENARIOS,
  formatAxeViolations,
  historyLandmark,
  isAxeCell,
  isFocusWalkWidth,
  isListDetailFlowCell,
  isLoadOlderCell,
  isMissingAgentProbeWidth,
  isNarrowDeepLinkWidth,
  isNotConnectedEmptyState,
  isThemeConsistencyWidth,
  NOT_CONNECTED_TITLE,
  olderExpectation,
  rectsIntersect,
} from "../../../scripts/web-hub/visual/checks-e2e.js";

/**
 * P6's own assertion module (`checks-e2e.ts`, vue-plan.md v2.1 §4.4.2/§5.2/§5.3) needs a real
 * browser for its DOM-touching checks (covered end-to-end by `npm run visual:web` itself, per
 * `checks-body.test.ts`'s precedent of only unit-testing the pure gating/geometry helpers a
 * `checks-*.ts` module exports). These tests pin: the scenario/width/theme gates that decide
 * which of the six representative matrix cells each mutating check actually runs against (never
 * every cell — see the module's own header comment on why), the "not connected" empty-state
 * title match, and the sub-pixel-tolerant rectangle intersection test the keyboard-focus-order
 * check uses to tell a real dock/content overlap apart from browser layout rounding noise.
 */

describe("AGENT_ALPHA_ROUTE / NOT_CONNECTED_TITLE constants", () => {
  it("AGENT_ALPHA_ROUTE is the deep-link hash the detail scenario itself uses", () => {
    expect(AGENT_ALPHA_ROUTE).toBe("#/agent/agent-alpha");
  });

  it("NOT_CONNECTED_TITLE matches src/web-hub/ui/src/i18n/en/detail.ts's notConnectedTitle", () => {
    expect(NOT_CONNECTED_TITLE).toBe("This agent is not connected");
  });
});

describe("isNotConnectedEmptyState", () => {
  it("matches only the exact expected title", () => {
    expect(isNotConnectedEmptyState("This agent is not connected")).toBe(true);
  });

  it("rejects a different empty-state title (e.g. the desktop-split 'Select an agent' state)", () => {
    expect(isNotConnectedEmptyState("Select an agent")).toBe(false);
  });

  it("rejects null/undefined (no .empty h2 found at all)", () => {
    expect(isNotConnectedEmptyState(null)).toBe(false);
    expect(isNotConnectedEmptyState(undefined)).toBe(false);
  });
});

describe("isListDetailFlowCell", () => {
  it("only runs for the dashboard scenario, below the 768px split breakpoint, in the light cell", () => {
    expect(isListDetailFlowCell("dashboard", 375, "light")).toBe(true);
    expect(isListDetailFlowCell("dashboard", 767, "light")).toBe(true);
  });

  it("does not run at or above 768px (split view — a click never swaps the visible pane)", () => {
    expect(isListDetailFlowCell("dashboard", 768, "light")).toBe(false);
    expect(isListDetailFlowCell("dashboard", 1024, "light")).toBe(false);
  });

  it("does not run for other scenarios or the dark theme cell (theme-independent behavior)", () => {
    expect(isListDetailFlowCell("detail", 375, "light")).toBe(false);
    expect(isListDetailFlowCell("dashboard", 375, "dark")).toBe(false);
  });
});

describe("isLoadOlderCell", () => {
  it("runs only for the detail scenario at exactly width 1024, mouse (non-touch), light theme", () => {
    expect(isLoadOlderCell("detail", 1024, false, "light")).toBe(true);
  });

  it("excludes the 1024-touch pointer:coarse pass (would just re-test the same network path)", () => {
    expect(isLoadOlderCell("detail", 1024, true, "light")).toBe(false);
  });

  it("excludes other widths, scenarios, and the dark cell", () => {
    expect(isLoadOlderCell("detail", 768, false, "light")).toBe(false);
    expect(isLoadOlderCell("dashboard", 1024, false, "light")).toBe(false);
    expect(isLoadOlderCell("detail", 1024, false, "dark")).toBe(false);
  });
});

describe("isThemeConsistencyWidth", () => {
  it("is true at 375 (narrow, no sidebar) and 768 (split, sidebar mounted)", () => {
    expect(isThemeConsistencyWidth(375)).toBe(true);
    expect(isThemeConsistencyWidth(768)).toBe(true);
  });

  it("is false at every other matrix breakpoint", () => {
    for (const w of [481, 767, 1024, 1025, 1440]) expect(isThemeConsistencyWidth(w)).toBe(false);
  });
});

describe("isNarrowDeepLinkWidth", () => {
  it("is true only at 375", () => {
    expect(isNarrowDeepLinkWidth(375)).toBe(true);
    expect(isNarrowDeepLinkWidth(767)).toBe(false);
    expect(isNarrowDeepLinkWidth(768)).toBe(false);
  });
});

describe("isMissingAgentProbeWidth", () => {
  it("runs at 375 regardless of pointer type", () => {
    expect(isMissingAgentProbeWidth(375, true)).toBe(true);
    expect(isMissingAgentProbeWidth(375, false)).toBe(true);
  });

  it("runs at 1024 only for the mouse (non-touch) pass — probes the desktop split layout once", () => {
    expect(isMissingAgentProbeWidth(1024, false)).toBe(true);
    expect(isMissingAgentProbeWidth(1024, true)).toBe(false);
  });

  it("excludes every other width", () => {
    expect(isMissingAgentProbeWidth(768, false)).toBe(false);
    expect(isMissingAgentProbeWidth(1440, false)).toBe(false);
  });
});

describe("isFocusWalkWidth", () => {
  it("matches the same two representative widths as the missing-agent probe", () => {
    expect(isFocusWalkWidth(375, true)).toBe(true);
    expect(isFocusWalkWidth(1024, false)).toBe(true);
    expect(isFocusWalkWidth(1024, true)).toBe(false);
    expect(isFocusWalkWidth(1025, false)).toBe(false);
  });
});

describe("isAxeCell", () => {
  it("covers dashboard/detail/login/states at 375 and mouse-1024, in both themes' cells (theme-independent gate)", () => {
    for (const scenario of AXE_SCENARIOS) {
      expect(isAxeCell(scenario, 375, true)).toBe(true);
      expect(isAxeCell(scenario, 1024, false)).toBe(true);
    }
    expect(AXE_SCENARIOS).toEqual(["dashboard", "detail", "login", "states"]);
  });

  it("excludes long, the 1024 pointer:coarse pass, and every other width", () => {
    expect(isAxeCell("long", 375, true)).toBe(false);
    expect(isAxeCell("detail", 1024, true)).toBe(false);
    for (const w of [481, 767, 768, 1025, 1440]) expect(isAxeCell("detail", w, false)).toBe(false);
  });
});

describe("olderExpectation", () => {
  it("is expected=false when the fixture declares no historyOlder for the agent", () => {
    expect(olderExpectation({}, "agent-alpha")).toEqual({ expected: false, before: null, text: null });
    expect(olderExpectation({ historyOlder: {} }, "agent-alpha").expected).toBe(false);
    expect(olderExpectation({ historyOlder: { "agent-beta": {} } }, "agent-alpha").expected).toBe(false);
  });

  it("extracts the first string-content message text and the before cursor", () => {
    const fixture = {
      historyOlder: {
        "agent-alpha": {
          "e-alpha-1": {
            entries: [
              {
                id: "e-alpha-0",
                type: "message",
                message: { role: "user", content: "(session start) opened pi-toolkit." },
              },
            ],
          },
        },
      },
    };
    expect(olderExpectation(fixture, "agent-alpha")).toEqual({
      expected: true,
      before: "e-alpha-1",
      text: "(session start) opened pi-toolkit.",
    });
  });

  it("extracts text from array-content messages (skipping non-text parts and non-message entries)", () => {
    const fixture = {
      historyOlder: {
        a: {
          b: {
            entries: [
              { id: "x", type: "model_change" },
              {
                id: "y",
                type: "message",
                message: {
                  role: "assistant",
                  content: [
                    { type: "toolCall", id: "c" },
                    { type: "text", text: "older answer" },
                  ],
                },
              },
            ],
          },
        },
      },
    };
    expect(olderExpectation(fixture, "a").text).toBe("older answer");
  });

  it("degrades to text=null when the older page carries no textual message (count-only assertion)", () => {
    const fixture = { historyOlder: { a: { b: { entries: [{ id: "x", type: "model_change" }] } } } };
    const e = olderExpectation(fixture, "a");
    expect(e.expected).toBe(true);
    expect(e.text).toBeNull();
  });
});

describe("historyLandmark", () => {
  it("returns the last textual message of the initial history page", () => {
    const fixture = {
      history: {
        a: {
          entries: [
            { id: "e1", type: "message", message: { role: "user", content: "first question" } },
            { id: "e2", type: "model_change" },
            {
              id: "e3",
              type: "message",
              message: { role: "assistant", content: [{ type: "text", text: "last answer" }] },
            },
          ],
        },
      },
    };
    expect(historyLandmark(fixture, "a")).toBe("last answer");
  });

  it("is null when the agent has no history or no textual message", () => {
    expect(historyLandmark({}, "a")).toBeNull();
    expect(historyLandmark({ history: { a: { entries: [{ id: "e1", type: "model_change" }] } } }, "a")).toBeNull();
  });
});

describe("formatAxeViolations", () => {
  it("renders rule id, impact, and up to three target selectors per rule", () => {
    const out = formatAxeViolations([
      {
        id: "color-contrast",
        impact: "serious",
        nodes: [
          { target: [".topbar .brand"] },
          { target: [".dock input"] },
          { target: [".sidebar a"] },
          { target: [".fleet summary"] },
        ],
      },
    ]);
    expect(out).toBe("color-contrast(serious)@.topbar .brand | .dock input | .sidebar a (+1 more)");
  });

  it("joins shadow-DOM selector arrays and tolerates missing impact/targets", () => {
    const out = formatAxeViolations([
      { id: "region", impact: null, nodes: [{ target: ["html", "body", "div.app"] }, {}] },
    ]);
    expect(out).toBe("region(?)@html body div.app | ?");
  });

  it("bounds the output at maxLen with an ellipsis", () => {
    const violations = Array.from({ length: 50 }, (_, i) => ({
      id: `rule-${i}`,
      impact: "minor",
      nodes: [{ target: [`selector-${i}`] }],
    }));
    const out = formatAxeViolations(violations, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("rectsIntersect", () => {
  it("detects a clear, unambiguous overlap", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    const b = { x: 50, y: 50, width: 100, height: 100 };
    expect(rectsIntersect(a, b)).toBe(true);
  });

  it("does not flag two rects that are clearly apart", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 100, y: 100, width: 10, height: 10 };
    expect(rectsIntersect(a, b)).toBe(false);
  });

  it("treats an edge-touching pair (0px real overlap) as not intersecting", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 10, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, b)).toBe(false);
  });

  it("absorbs sub-pixel layout noise within the default 1px tolerance (verifier finding: a real .tx-item's computed bottom edge landed 0.28px past the dock's top edge)", () => {
    const a = { x: 13, y: 803.28125, width: 349, height: 44 }; // bottom = 847.28125
    const b = { x: 0, y: 847, width: 375, height: 53 };
    expect(rectsIntersect(a, b)).toBe(false);
  });

  it("still flags a real, visually-significant overlap past the tolerance", () => {
    const a = { x: 13, y: 810, width: 349, height: 44 }; // bottom = 854, 7px into b
    const b = { x: 0, y: 847, width: 375, height: 53 };
    expect(rectsIntersect(a, b)).toBe(true);
  });

  it("respects a custom epsilonPx override", () => {
    const a = { x: 0, y: 0, width: 10, height: 12 }; // 2px overlap on the y axis
    const b = { x: 0, y: 10, width: 10, height: 10 };
    expect(rectsIntersect(a, b, 1)).toBe(true);
    expect(rectsIntersect(a, b, 5)).toBe(false);
  });
});
