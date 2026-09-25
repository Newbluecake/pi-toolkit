import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKFLOW_BUDGET,
  loadSettings,
  loadSettingsFromFile,
} from "../../src/config/settings.js";
import { SETTING_SPECS } from "../../src/config/setting-specs.js";
import { buildWorkflowRunBudget } from "../../src/workflow/run-budget.js";
import { mergeBudget } from "../../src/tools/workflow-tool.js";

/**
 * workflow-agent-queue plan §0 Major-2 / review v2 #7: BW10 (workflowTotalMs=0
 * ⇒ "no workflow cap") is unsupported in background mode, so the cap must be
 * > 0 at every layer — settings parse, settings spec, run-budget builder and
 * the tool's timeout_s merge — mirroring the subagent D-11 rule for
 * budget.totalS.
 */
describe("workflow.budget.workflowTotalS must be > 0", () => {
  it("loadSettings drops workflowTotalS <= 0 (so the default applies) and keeps a legal value", () => {
    for (const bad of [0, -5]) {
      const s = loadSettings({ workflow: { budget: { workflowTotalS: bad, scriptSliceS: 3 } } });
      expect(s.workflow.budget).toEqual({ scriptSliceMs: 3_000 }); // only the illegal key is dropped
      expect(buildWorkflowRunBudget(s).workflowTotalMs).toBe(DEFAULT_WORKFLOW_BUDGET.workflowTotalMs);
    }
    const ok = loadSettings({ workflow: { budget: { workflowTotalS: 90 } } });
    expect(ok.workflow.budget.workflowTotalMs).toBe(90_000);
    expect(buildWorkflowRunBudget(ok).workflowTotalMs).toBe(90_000);
  });

  it("other workflow budget keys still accept 0 (e.g. phaseTotalS = unlimited)", () => {
    const s = loadSettings({ workflow: { budget: { phaseTotalS: 0 } } });
    expect(s.workflow.budget).toEqual({ phaseTotalMs: 0 });
  });

  it("buildWorkflowRunBudget falls back to the default for a programmatic workflowTotalMs <= 0", () => {
    const s = { ...DEFAULT_SETTINGS, workflow: { ...DEFAULT_SETTINGS.workflow, budget: { workflowTotalMs: 0 } } };
    expect(buildWorkflowRunBudget(s).workflowTotalMs).toBe(DEFAULT_WORKFLOW_BUDGET.workflowTotalMs);
  });

  it("the settings spec for workflowTotalS has min 1 (other workflow keys keep min 0)", () => {
    expect(SETTING_SPECS["workflow.budget.workflowTotalS"]).toMatchObject({
      kind: "number",
      path: "workflow.budget.workflowTotalMs",
      time: true,
      min: 1,
    });
    expect(SETTING_SPECS["workflow.budget.phaseTotalS"]).toMatchObject({ min: 0 });
    expect(SETTING_SPECS["workflow.budget.hostCallS"]).toMatchObject({ min: 0 });
  });

  it("the tool's mergeBudget ignores timeout_s <= 0 / non-finite and applies a positive one", () => {
    const base = buildWorkflowRunBudget(DEFAULT_SETTINGS);
    expect(mergeBudget(base, undefined)).toBe(base);
    expect(mergeBudget(base, 0)).toBe(base);
    expect(mergeBudget(base, -1_000)).toBe(base);
    expect(mergeBudget(base, Number.NaN)).toBe(base);
    expect(mergeBudget(base, 7_000).workflowTotalMs).toBe(7_000);
  });

  it("stage B: an explicit timeout_s is a hard cap (maxTotalFactor forced to 1); the default budget keeps the subagent grace knobs", () => {
    const base = buildWorkflowRunBudget(DEFAULT_SETTINGS);
    expect(base).toMatchObject({
      totalGraceMs: DEFAULT_SETTINGS.budget.totalGraceMs,
      maxExtensions: DEFAULT_SETTINGS.budget.maxExtensions,
      maxTotalFactor: DEFAULT_SETTINGS.budget.maxTotalFactor,
    });
    expect(base.maxTotalFactor).toBeGreaterThan(1);
    const explicit = mergeBudget(base, 7_000);
    expect(explicit.maxTotalFactor).toBe(1);
    expect(explicit.maxExtensions).toBe(base.maxExtensions);
    // extend.enabled=false closes grace and extension alike (D-16).
    const off = buildWorkflowRunBudget({ ...DEFAULT_SETTINGS, extend: { ...DEFAULT_SETTINGS.extend, enabled: false } });
    expect(off.maxExtensions).toBe(0);
  });
});

describe("loadSettingsFromFile: workflow.budget.workflowTotalS WARN", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflow-settings-"));
    path = join(dir, "settings.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns exactly once, does not rewrite the file, and uses the default cap", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const content = JSON.stringify({ workflow: { budget: { workflowTotalS: 0 } } }, null, 2);
      writeFileSync(path, content, "utf8");
      const s = loadSettingsFromFile(path);
      expect(s.workflow.budget.workflowTotalMs).toBeUndefined();
      expect(buildWorkflowRunBudget(s).workflowTotalMs).toBe(3_600_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("workflow.budget.workflowTotalS must be > 0 (got 0)");
      expect(warn.mock.calls[0]?.[0]).toContain("3600s");
      expect(readFileSync(path, "utf8")).toBe(content);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn for a legal workflowTotalS", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(path, JSON.stringify({ workflow: { budget: { workflowTotalS: 120 } } }), "utf8");
      expect(loadSettingsFromFile(path).workflow.budget.workflowTotalMs).toBe(120_000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
