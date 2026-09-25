import { describe, expect, it } from "vitest";
import { collectSessionFacts, createSessionFactsProvider } from "../../src/context-switch/session-facts.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { Stack } from "../../src/stack.js";
import { STATE_ENTRY } from "../../src/todo/state.js";

const settings = DEFAULT_SETTINGS as AgentSettings;

function stack(overrides: Record<string, unknown>): Stack {
  return overrides as unknown as Stack;
}

function todoEntry(tasks: { id: number; subject: string; status: string }[]) {
  return {
    type: "custom",
    customType: STATE_ENTRY,
    data: {
      nextId: tasks.length + 1,
      tasks: tasks.map((task) => ({
        ...task,
        description: "desc",
        blocks: [],
        blockedBy: [],
        createdAt: 1,
        updatedAt: 1,
      })),
    },
  };
}

describe("context-switch/session-facts", () => {
  it("returns an empty object without a stack or ctx", () => {
    expect(collectSessionFacts(undefined, undefined, settings)).toEqual({});
  });

  it("collects the session file, live runs (with labels) and live bash jobs", () => {
    const facts = collectSessionFacts(
      stack({
        query: {
          list: () => [
            { runId: "run-aaaaaaaaaa", status: "working", phase: "prompting" },
            { runId: "run-bbbbbbbbbb", status: "completed", phase: "settled" },
          ],
        },
        mention: {
          labels: () => ["dev-1"],
          resolve: (label: string) => (label === "dev-1" ? { runId: "run-aaaaaaaaaa" } : undefined),
        },
        bashJobs: {
          list: () => [
            { jobId: "job-11111111", command: "npm   test", status: "running" },
            { jobId: "job-22222222", command: "echo done", status: "completed" },
          ],
        },
      }),
      { sessionManager: { getSessionFile: () => "/tmp/s.jsonl" } },
      settings,
    );
    expect(facts.sessionFile).toBe("/tmp/s.jsonl");
    expect(facts.runs).toEqual(["dev-1 (run-aaaa) — working/prompting"]);
    expect(facts.bashJobs).toEqual(["job-1111 — npm test"]);
  });

  it("lists running background workflows alongside runs (terminal ones are left out)", () => {
    const facts = collectSessionFacts(
      stack({
        query: { list: () => [] },
        mention: { labels: () => [], resolve: () => undefined },
        workflow: {
          runs: {
            list: () => [
              { workflowId: "wf_live", name: "review-flow", status: "running" },
              { workflowId: "wf_done", name: "old-flow", status: "completed" },
            ],
          },
        },
      }),
      {},
      settings,
    );
    expect(facts.runs).toEqual(['workflow "review-flow" (wf_live) — running']);
  });

  it("omits empty lists rather than emitting empty appendix sections", () => {
    const facts = collectSessionFacts(
      stack({
        query: { list: () => [{ runId: "r", status: "completed", phase: "settled" }] },
        mention: { labels: () => [], resolve: () => undefined },
      }),
      {},
      settings,
    );
    expect(facts).toEqual({});
  });

  it("reports open todos only, and only when the todo feature is on", () => {
    const branch = [
      todoEntry([
        { id: 1, subject: "写测试", status: "in_progress" },
        { id: 2, subject: "改文档", status: "completed" },
      ]),
    ];
    const ctx = { sessionManager: { getBranch: () => branch } };
    const facts = collectSessionFacts(stack({}), ctx, settings);
    expect(facts.todos).toEqual(["#1 写测试 [in_progress]"]);

    const off = collectSessionFacts(stack({}), ctx, {
      ...settings,
      todo: { ...settings.todo, enabled: false },
    } as AgentSettings);
    expect(off.todos).toBeUndefined();
  });

  it("degrades silently when any port throws (a stale ctx must not break the switch)", () => {
    const facts = collectSessionFacts(
      stack({
        query: {
          list: () => {
            throw new Error("gone");
          },
        },
        mention: {
          labels: () => {
            throw new Error("gone");
          },
          resolve: () => undefined,
        },
        bashJobs: {
          list: () => {
            throw new Error("gone");
          },
        },
      }),
      {
        sessionManager: {
          getSessionFile: () => {
            throw new Error("stale");
          },
          getBranch: () => {
            throw new Error("stale");
          },
        },
      },
      settings,
    );
    expect(facts).toEqual({});
  });

  it("createSessionFactsProvider reads the holder's current stack lazily", () => {
    const holder: { current?: Stack } = {};
    const provider = createSessionFactsProvider(holder, settings);
    expect(provider({})).toEqual({});
    holder.current = stack({
      query: { list: () => [{ runId: "run-cccccccc", status: "queued", phase: "queued" }] },
      mention: { labels: () => [], resolve: () => undefined },
    });
    expect(provider({})).toEqual({ runs: ["run-cccc — queued/queued"] });
  });
});
