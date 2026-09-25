import { describe, expect, it } from "vitest";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import { createSteerTool } from "../../src/tools/steer-tool.js";
import { createAbortTool } from "../../src/tools/abort-tool.js";
import { createWorkflowTool } from "../../src/tools/workflow-tool.js";
import { createStructuredOutputTool } from "../../src/tools/structured-output-tool.js";
import {
  createBashTool,
  formatAutoBackgroundTextStarting,
  formatDeadlineSuffix,
  formatExplicitBackgroundTextStarting,
} from "../../src/tools/bash-tool.js";
import { createBashJobTool, formatGraceLine } from "../../src/tools/bash-job-tool.js";
import { createSetModelTool } from "../../src/tools/set-model-tool.js";
import { createExtendTimeoutTool } from "../../src/tools/extend-timeout-tool.js";

function collectDescriptions(schema: unknown, out: string[] = []): string[] {
  if (!schema || typeof schema !== "object") return out;
  const value = schema as Record<string, unknown>;
  if (typeof value.description === "string") out.push(value.description);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) collectDescriptions(item, out);
    } else {
      collectDescriptions(child, out);
    }
  }
  return out;
}

function tools() {
  const spawn = {} as NestedSpawnPort;
  return [
    createAgentTool({ spawn }),
    createResultTool({ query: {} as never }),
    createSteerTool({ query: {} as never }),
    createAbortTool({ query: {} as never }),
    createWorkflowTool({} as never),
    createStructuredOutputTool({ schema: { type: "object" }, onSubmit: () => ({ ok: true }) }),
    // bash auto-background surfaces: both are model-facing, so they are held
    // to the same no-internal-vocabulary bar (the threshold paragraph and the
    // job wording are generated, so drift here is easy to miss).
    createBashTool({ manager: () => undefined, autoBackgroundMs: () => 120_000 }),
    createBashJobTool({ manager: () => undefined }),
    createSetModelTool({}),
    createExtendTimeoutTool({ query: {} as never }),
  ];
}

describe("model-facing tool strings", () => {
  it("contain no internal architecture references", () => {
    for (const tool of tools()) {
      const strings = [tool.description, tool.promptSnippet, ...collectDescriptions(tool.parameters)];
      for (const value of strings) expect(value).not.toMatch(/[§]|architecture/);
    }
  });

  it("documents Agent label acceptance for run_id parameters", () => {
    const [agent, result, steer, abort] = tools();
    expect(collectDescriptions(result.parameters).join(" ")).toContain("label");
    expect(collectDescriptions(steer.parameters).join(" ")).toContain("label");
    expect(collectDescriptions(abort.parameters).join(" ")).toContain("label");
    const setModel = tools().find((tool) => tool.name === "set_model")!;
    expect(collectDescriptions(setModel.parameters).join(" ")).toContain("label");
    const extendTimeout = tools().find((tool) => tool.name === "extend_subagent_timeout")!;
    expect(collectDescriptions(extendTimeout.parameters).join(" ")).toContain("label");
    expect(agent.description).toContain("terminal run");
  });

  it("documents terminal-run semantics for resume", () => {
    const agent = tools()[0]!;
    const descriptions = collectDescriptions(agent.parameters);
    const resume = descriptions.find((text) => text.includes("terminal subagent session"));
    expect(resume).toContain("terminal");
    expect(resume).not.toContain("completed subagent session");
  });

  /**
   * A blocking wait (get_subagent_result wait:true, bash_job wait) occupies
   * the agent loop for its whole duration — the user cannot type a new
   * message or command until it returns. The descriptions must state that
   * consequence, or models treat wait as a free default instead of the
   * last-resort fallback it is.
   */
  it("states that a blocking wait prevents new user input", () => {
    const [agent, result] = tools();
    const bashJob = tools().find((tool) => tool.name === "bash_job")!;
    expect(result.description).toMatch(/user cannot send new input/);
    expect(collectDescriptions(result.parameters).join(" ")).toMatch(/user\s+cannot type a new message/);
    expect(agent.description).toMatch(/monopolizes the agent loop/);
    expect(bashJob.description).toMatch(/user cannot send new input/);
  });

  /**
   * The bash pair is generated from pi's own bash definition plus our own
   * wording; these guards cover what the T1 drift test in
   * `tests/tools/bash-tool.test.ts` does not: that the *model-visible*
   * vocabulary stays free of plugin-internal terms (job status enum values,
   * settings paths, file-layout details) and that the shared job/threshold
   * contract is actually stated where the model can read it.
   */
  describe("bash auto-background tools", () => {
    const bash = () => tools().find((tool) => tool.name === "bash")!;
    const bashJob = () => tools().find((tool) => tool.name === "bash_job")!;

    it("uses no internal vocabulary in the bash pair's descriptions", () => {
      for (const tool of [bash(), bashJob()]) {
        const strings = [tool.description, tool.promptSnippet, ...collectDescriptions(tool.parameters)].filter(
          (value): value is string => typeof value === "string",
        );
        for (const value of strings) {
          // Internal identifiers that must never leak into a prompt.
          expect(value).not.toMatch(/exited_unknown|orphaned|BashJobManager|readCursor|bashJobs\./);
          expect(value).not.toMatch(/plan-fable|autoBackgroundMs|maxLogBytes/);
        }
      }
    });

    it("states the job contract the two tools share", () => {
      const description = bash().description;
      expect(description).toContain("job_id");
      expect(description).toContain("NOT killed");
      expect(description).toContain("bash_job");
      expect(description).toContain("run_in_background: true");
      // The threshold is rendered as a duration, never as a raw ms number.
      expect(description).toMatch(/runs longer than ~\d+m/);

      const params = collectDescriptions(bashJob().parameters).join(" ");
      expect(params).toContain("unique prefix is accepted");
      expect(params).toContain("Required for every action except list");
      // Four actions since change C: `output` was merged into `status`.
      for (const action of ["status", "wait", "kill", "list"]) {
        expect(bashJob().description).toContain(action);
        expect(params).toContain(action);
      }
      expect(params).not.toContain("offset");
      expect(bashJob().description).not.toContain('"output"');
    });

    /**
     * Change A: the job log is an ordinary file. Both tools must say so, or the
     * wording alone would confine the model to this tool's parameters when
     * read/tail/grep/awk are strictly more capable.
     */
    it("tells the model the log is a plain file it may read directly", () => {
      for (const tool of [bash(), bashJob()]) {
        expect(tool.description).toMatch(/plain file/);
        expect(tool.description).toMatch(/read tool|tail\/grep\/awk/);
      }
      expect(bashJob().description).toMatch(/grep a large log/);
    });
  });
});

/**
 * bash-timeout-grace T17: every NEW model-facing string the P4 tools add —
 * the deadline suffix on `bash`, the extend schema bits, the grace line, the
 * `pid starting` hand-back texts, and the extend refusals — follows the same
 * rules as the rest: English tokens only (no CJK leaking into compact
 * markers/lines), no internal vocabulary, no plan-section references.
 */
describe("bash deadline strings (bash-timeout-grace T17)", () => {
  const POLICY = { graceMs: 60_000, maxExtensions: 3, maxTimeoutFactor: 3 };

  const newStrings = (): string[] => {
    const bash = createBashTool({
      manager: () => undefined,
      autoBackgroundMs: () => 120_000,
      deadline: () => POLICY,
    });
    const bashOff = createBashTool({ manager: () => undefined, autoBackgroundMs: () => 120_000 });
    const jobOn = createBashJobTool({ manager: () => undefined, deadline: () => POLICY });
    return [
      bash.description,
      formatDeadlineSuffix(POLICY),
      formatDeadlineSuffix({ graceMs: 0, maxExtensions: 3, maxTimeoutFactor: 3 }),
      formatAutoBackgroundTextStarting("b_TEST0001", 5_000, "/tmp/x.log"),
      formatExplicitBackgroundTextStarting("b_TEST0001", "/tmp/x.log"),
      formatGraceLine(
        { ...({} as never), status: "running", jobId: "b_TEST0001", deadline: { graceUntil: 58_000 } } as never,
        0,
      )!,
      JSON.stringify(jobOn.parameters),
      // The deadline suffix must not change the off-baseline surface at all.
      bashOff.description,
    ];
  };

  it("keeps the new deadline/grace/starting strings free of internal vocabulary", () => {
    for (const value of newStrings()) {
      expect(value).not.toMatch(/[§]|architecture/);
      expect(value).not.toMatch(/exited_unknown|orphaned|BashJobManager|readCursor|bashJobs\.|reserve\(|R12|D-6/);
      expect(value).not.toMatch(/pi-subagent|plan\.md|child-registry/);
    }
  });

  it("uses English tokens only — no CJK in any model-facing line", () => {
    for (const value of newStrings()) expect(value).not.toMatch(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/);
  });

  it("the bash deadline suffix spells the extend contract, or disappears when disabled", () => {
    const on = formatDeadlineSuffix(POLICY);
    expect(on).toContain('bash_job(action: "extend"');
    expect(on).toContain("grace");
    expect(on).toContain("3 extensions");
    expect(on).toContain("3x the original timeout");
    // graceMs=0: extend-only phrasing, no grace promise.
    const extendOnly = formatDeadlineSuffix({ graceMs: 0, maxExtensions: 3, maxTimeoutFactor: 3 });
    expect(extendOnly).toContain("killed at once (no grace window)");
    // D-6: disabled entirely when there is no extension headroom.
    expect(formatDeadlineSuffix({ graceMs: 60_000, maxExtensions: 0, maxTimeoutFactor: 3 })).toBe("");
    expect(formatDeadlineSuffix({ graceMs: 60_000, maxExtensions: 3, maxTimeoutFactor: 1 })).toBe("");
    expect(formatDeadlineSuffix(undefined)).toBe("");
  });

  it("the grace line is a single compact line with the exact extend recipe", () => {
    const record = {
      status: "running",
      jobId: "b_GRACE001",
      deadline: { graceUntil: 1_058_000 },
    } as never;
    const line = formatGraceLine(record, 1_000_000)!;
    expect(line).toBe(
      "⏳ timeout reached — killed in 58s unless extended: " +
        'bash_job(action: "extend", job_id: "b_GRACE001", extend_s: 600)',
    );
  });

  it("extend params carry actionable descriptions without internal jargon", () => {
    const on = createBashJobTool({ manager: () => undefined, deadline: () => POLICY });
    const descriptions = collectDescriptions(on.parameters).join(" ");
    expect(descriptions).toContain("push the job's timeout deadline back");
    expect(descriptions).toContain("hard lifetime ceiling");
    expect(descriptions).toContain("max 200 chars");
    expect(descriptions).not.toContain("applyJobExtension");
    expect(descriptions).not.toContain("hardAt");
  });
});
