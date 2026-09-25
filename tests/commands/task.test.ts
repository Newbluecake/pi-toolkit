import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { SpawnRequest } from "../../src/core/types.js";
import {
  TASK_AGENT_TYPE,
  TASK_DESCRIPTION_PREVIEW_CHARS,
  TASK_STARTED_CUSTOM_TYPE,
  buildTaskStartedContent,
  buildTaskStartedDetails,
  createTaskCommand,
  deriveTaskLabel,
  renderTaskStartedMessage,
  truncateTaskDescription,
  type TaskCommandDeps,
} from "../../src/commands/task.js";

type SpawnResult = Awaited<ReturnType<TaskCommandDeps["spawn"]>>;

interface Harness {
  command: Omit<RegisteredCommand, "name" | "sourceInfo">;
  spawn: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  ctx: ExtensionCommandContext;
}

function harness(spawnImpl?: (req: SpawnRequest) => Promise<SpawnResult>): Harness {
  const spawn = vi.fn(spawnImpl ?? (async () => ({ runId: "r_12345678", label: "fix-login-bug" })));
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
  const command = createTaskCommand({ spawn: (req) => spawn(req), sendMessage });
  return { command, spawn, sendMessage, notify, ctx };
}

describe("/task command dispatch", () => {
  it("notifies usage and does not dispatch when the description is empty (or whitespace only)", async () => {
    for (const args of ["", "   ", "\n\t "]) {
      const h = harness();
      await h.command.handler(args, h.ctx);
      expect(h.spawn).not.toHaveBeenCalled();
      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.notify).toHaveBeenCalledOnce();
      expect(h.notify.mock.calls[0]![0]).toContain("/task");
      expect(h.notify.mock.calls[0]![1]).toBe("warning");
    }
  });

  it("spawns a background general-purpose run with exactly the Agent-background field set", async () => {
    const h = harness();
    await h.command.handler("Fix the login timeout bug", h.ctx);
    expect(h.spawn).toHaveBeenCalledOnce();
    const req = h.spawn.mock.calls[0]![0] as SpawnRequest;
    expect(req.type).toBe(TASK_AGENT_TYPE);
    expect(req.prompt).toBe("Fix the login timeout bug");
    expect(req.label).toBe("Fix-the-login-timeout-bug");
    expect(req.detachSignalOnStart).toBe(true);
    // No model / timeout / ack / nesting overrides — default budget (grace +
    // extension), the type's configured model, root-level, notifier-owned
    // delivery: byte-identical field set to spawnInBackground in agent-tool.ts.
    expect(req.modelOverride).toBeUndefined();
    expect(req.modelHintOverride).toBeUndefined();
    expect(req.thinkingOverride).toBeUndefined();
    expect(req.budgetOverride).toBeUndefined();
    expect(req.deadlineAt).toBeUndefined();
    expect(req.expectAck).toBeUndefined();
    expect(req.parentRunId).toBeUndefined();
    expect(req.slotless).toBeUndefined();
    expect(req.resumeFrom).toBeUndefined();
    expect(req.isolation).toBeUndefined();
    expect(req.schema).toBeUndefined();
    expect(req.consultExperts).toBeUndefined();
    expect(req.signal).toBeUndefined();
  });

  it("writes a triggerTurn:false start record whose content carries runId and label", async () => {
    const h = harness();
    await h.command.handler("Investigate flaky test", h.ctx);
    expect(h.sendMessage).toHaveBeenCalledOnce();
    const [message, options] = h.sendMessage.mock.calls[0]! as [
      { customType: string; content: string; display: boolean; details: unknown },
      { triggerTurn: boolean },
    ];
    expect(message.customType).toBe(TASK_STARTED_CUSTOM_TYPE);
    expect(options).toEqual({ triggerTurn: false });
    expect(message.content).toContain("r_12345678");
    expect(message.content).toContain("fix-login-bug");
    expect(message.content).toContain("/task");
    expect(message.content).toContain("get_subagent_result");
    const details = message.details as ReturnType<typeof buildTaskStartedDetails>;
    expect(details).toMatchObject({
      kind: "task-started",
      runId: "r_12345678",
      label: "fix-login-bug",
      agentType: TASK_AGENT_TYPE,
      truncated: false,
    });
    expect(details.task).toBe("Investigate flaky test");
  });

  it("uses the spawn-returned (uniquified) label in the start record", async () => {
    const h = harness(async () => ({ runId: "r_99999999", label: "fix-2" }));
    await h.command.handler("fix", h.ctx);
    const [message] = h.sendMessage.mock.calls[0]! as [{ content: string; details: { label: string } }, unknown];
    expect(message.content).toContain("fix-2");
    expect(message.details.label).toBe("fix-2");
  });

  it("notifies the error and writes no start record when spawn fails", async () => {
    const h = harness(async () => ({
      error: { kind: "config" as const, message: "unknown agent type", retryable: false },
    }));
    await h.command.handler("do the thing", h.ctx);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.notify.mock.calls[0]![0]).toContain("unknown agent type");
    expect(h.notify.mock.calls[0]![1]).toBe("error");
  });

  it("still notifies the user when spawn throws", async () => {
    const h = harness(async () => {
      throw new Error("no active session yet");
    });
    await h.command.handler("do the thing", h.ctx);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.notify.mock.calls[0]![0]).toContain("no active session yet");
    expect(h.notify.mock.calls[0]![1]).toBe("error");
  });
});

describe("/task label derivation and description truncation", () => {
  it("derives the label from the first non-empty line, whitespace-sanitized", () => {
    expect(deriveTaskLabel("fix login\nthen verify\n")).toBe("fix-login");
    expect(deriveTaskLabel("\n\n  --  spaced   out  --  \nrest")).toBe("spaced-out");
    expect(deriveTaskLabel("   ")).toBeUndefined();
  });

  it("caps the label at the shared base length (spawn-service uniquifies beyond that)", () => {
    const label = deriveTaskLabel("x".repeat(200));
    expect(label).toBeDefined();
    expect([...label!]).toHaveLength(36);
  });

  it("truncates over-long descriptions in the start record and flags it in details", async () => {
    const long = "y".repeat(TASK_DESCRIPTION_PREVIEW_CHARS + 100);
    const h = harness();
    await h.command.handler(long, h.ctx);
    const [message] = h.sendMessage.mock.calls[0]! as [
      { content: string; details: { task: string; truncated: boolean } },
      unknown,
    ];
    expect(message.details.truncated).toBe(true);
    expect(message.details.task).toHaveLength(TASK_DESCRIPTION_PREVIEW_CHARS + 1); // budget + ellipsis
    expect(message.details.task.endsWith("…")).toBe(true);
    // Content carries the truncated preview, not the full prompt.
    expect(message.content).not.toContain(long);
  });

  it("keeps short descriptions verbatim", () => {
    const result = truncateTaskDescription("short task");
    expect(result).toEqual({ text: "short task", truncated: false });
  });
});

describe("/task content and details builders", () => {
  it("content names the agent type, the task and the retrieval flow", () => {
    const content = buildTaskStartedContent("r_abc12345", "my-label", "do things");
    expect(content).toContain("run_id: r_abc12345");
    expect(content).toContain("label: my-label");
    expect(content).toContain(`agent type: ${TASK_AGENT_TYPE}`);
    expect(content).toContain("Task: do things");
    expect(content).toContain('get_subagent_result(run_id: "r_abc12345")');
  });

  it("details embed the truncated preview", () => {
    const details = buildTaskStartedDetails("r_abc12345", "lbl", "z".repeat(TASK_DESCRIPTION_PREVIEW_CHARS + 5));
    expect(details.truncated).toBe(true);
    expect(details.task.startsWith("z".repeat(TASK_DESCRIPTION_PREVIEW_CHARS))).toBe(true);
  });
});

describe("renderTaskStartedMessage", () => {
  const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<
    typeof renderTaskStartedMessage
  >[2];
  const message = {
    role: "custom",
    customType: TASK_STARTED_CUSTOM_TYPE,
    content: "",
    display: true,
    details: buildTaskStartedDetails("r_abc12345xyz", "my-task", "do it"),
    timestamp: 0,
  } as unknown as Parameters<typeof renderTaskStartedMessage>[0];

  it("indents the line by pi's outputPad like other chat messages", () => {
    const lines = renderTaskStartedMessage(message, { expanded: false, outputPad: 1 }, theme)!.render(80);
    expect(lines[0]).toMatch(/^ \/task started · my-task \(#r_abc123\) · background/);
    const wide = renderTaskStartedMessage(message, { expanded: false, outputPad: 3 }, theme)!.render(80);
    expect(wide[0]).toMatch(/^ {3}\/task started/);
  });

  it("falls back to a 1-column indent when outputPad is missing", () => {
    const opts = { expanded: false } as unknown as Parameters<typeof renderTaskStartedMessage>[1];
    const lines = renderTaskStartedMessage(message, opts, theme)!.render(80);
    expect(lines[0]).toMatch(/^ \/task started/);
  });
});
