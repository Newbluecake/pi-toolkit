import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LEGACY_RESULT_TOOL_NAME as LEGACY, RESULT_TOOL_NAME as NEW } from "../../src/core/tool-names.js";
import {
  createResultToolActivation,
  hasToolSelectionArgs,
  planResultToolActivation,
} from "../../src/tools/result-tool-activation.js";

describe("planResultToolActivation truth table", () => {
  const base = { declared: [LEGACY, "bash"], active: ["bash"], registered: [NEW, "bash"] };
  it("legacy declared + new registered but inactive ⇒ append (keeps order, drops nothing)", () => {
    expect(planResultToolActivation({ ...base, active: ["read", "bash", "Agent"] })).toEqual([
      "read",
      "bash",
      "Agent",
      NEW,
    ]);
  });
  it("transcript never declared the legacy name ⇒ untouched (respects a user who disabled the tool)", () => {
    expect(planResultToolActivation({ ...base, declared: ["bash"] })).toBeUndefined();
    expect(planResultToolActivation({ ...base, declared: [NEW] })).toBeUndefined();
  });
  it("already active ⇒ untouched", () => {
    expect(planResultToolActivation({ ...base, active: ["bash", NEW] })).toBeUndefined();
  });
  it("new name not registered/allowed ⇒ untouched", () => {
    expect(planResultToolActivation({ ...base, registered: ["bash"] })).toBeUndefined();
  });
});

describe("hasToolSelectionArgs", () => {
  it.each([
    [["--tools", "+x"]],
    [["-t", "read"]],
    [["--exclude-tools", "a"]],
    [["-xt", "a"]],
    [["--no-tools"]],
    [["-nt"]],
    [["--no-builtin-tools"]],
    [["-nbt"]],
    [["--tools=-get_run_result"]],
    [["--exclude-tools=get_run_result"]],
  ])("%j ⇒ true", (argv) => {
    expect(hasToolSelectionArgs(argv)).toBe(true);
  });
  it.each([[[]], [["node", "pi", "--model", "x", "-p", "hello"]], [["--tools-ish"]], [["tools"]]])(
    "%j ⇒ false",
    (argv) => {
      expect(hasToolSelectionArgs(argv)).toBe(false);
    },
  );
});

describe("createResultToolActivation wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  function wired(over: { active?: string[]; argv?: string[] | undefined; omit?: string } = {}) {
    const setActiveTools = vi.fn();
    const pi: Record<string, unknown> = {
      getActiveTools: () => over.active ?? ["bash"],
      setActiveTools,
      getAllTools: () => [{ name: NEW }, { name: "bash" }],
    };
    if (over.omit) delete pi[over.omit];
    const ctx = {
      sessionManager: {
        // getCurrentTools reads `role:"system"` messages' toolsAdded / toolsRemoved deltas.
        buildSessionProjection: () => ({
          messages: [{ role: "system", toolsAdded: [{ name: LEGACY }, { name: "bash" }] }],
        }),
      },
    } as unknown as ExtensionContext;
    const run = createResultToolActivation(pi as unknown as ExtensionAPI, {
      argv: () => ("argv" in over ? over.argv : ["node", "pi"]),
    });
    return { run: () => run(ctx), setActiveTools };
  }

  it("applies the append when transcript declares the legacy name", () => {
    const w = wired();
    w.run();
    expect(w.setActiveTools).toHaveBeenCalledWith(["bash", NEW]);
  });
  it("any tool-selection argv ⇒ no-op; unreadable argv ⇒ no-op", () => {
    for (const argv of [["pi", "--tools", `-${NEW}`], ["pi", "-xt", NEW], undefined]) {
      const w = wired({ argv });
      w.run();
      expect(w.setActiveTools).not.toHaveBeenCalled();
    }
  });
  it.each(["getActiveTools", "setActiveTools", "getAllTools"])("missing pi capability %s ⇒ silent no-op", (omit) => {
    const w = wired({ omit });
    expect(() => w.run()).not.toThrow();
    expect(w.setActiveTools).not.toHaveBeenCalled();
  });
  it("a missing sessionManager projection ⇒ no-op", () => {
    const setActiveTools = vi.fn();
    const run = createResultToolActivation(
      { getActiveTools: () => [], setActiveTools, getAllTools: () => [{ name: NEW }] } as unknown as ExtensionAPI,
      { argv: () => [] },
    );
    run({ sessionManager: {} } as unknown as ExtensionContext);
    expect(setActiveTools).not.toHaveBeenCalled();
  });
  it("setActiveTools throwing is swallowed and logged with the [pi-subagent] prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const w = wired();
    w.setActiveTools.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => w.run()).not.toThrow();
    expect(warn.mock.calls[0]?.[0]).toMatch(/^\[pi-subagent\] .*boom/);
  });
});
