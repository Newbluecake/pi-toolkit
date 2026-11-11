import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireJev } from "../../../src/memory/jev/wire.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { createFakeRegistry } from "./helpers/fake-registry.js";
import { createGovernanceSignals } from "../../../src/memory/govern/signals.js";

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = { on: (name: string, fn: any) => handlers.set(name, fn), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const owner = createGovernanceSignals();
  const mark = vi.fn();
  const turnEnd = vi.fn();
  const abort = vi.fn();
  let prior = "pending";
  const settings = {
    ...DEFAULT_MEMORY_SETTINGS,
    jev: { ...DEFAULT_MEMORY_SETTINGS.jev, predict: { ...DEFAULT_MEMORY_SETTINGS.jev.predict, enabled: false } },
  };
  wireJev(pi, {
    config: jevConfigOf(settings),
    settings,
    isChildSession: false,
    dirFor: () => undefined,
    getRenderInfo: () => undefined,
    onAfterWriteHook: () => {},
    log: () => {},
    todo: { list: () => [{ id: 1, subject: "task", status: prior }] },
    governance: {
      capture: (_cwd, id, candidate) => owner.captureCandidate(id, candidate),
      take: (_cwd, id, fingerprint) => owner.takeCandidate(id, fingerprint),
      clear: () => owner.clearCandidates(),
      mark,
      abort,
      turnEnd,
    },
  });
  const ctx = {
    cwd: "/tmp",
    modelRegistry: createFakeRegistry({ available: [] }).registry,
    sessionManager: { getBranch: () => [] },
  };
  const emit = (name: string, event: any) => handlers.get(name)?.(event, ctx);
  function command(id: string, command: string, result: Record<string, unknown> = {}) {
    const input = { command };
    emit("tool_call", { toolName: "bash", toolCallId: id, input });
    emit("tool_result", {
      toolName: "bash",
      toolCallId: id,
      input,
      content: [],
      isError: false,
      structuredContent: { exit_code: 0 },
      ...result,
    });
  }
  return {
    emit,
    command,
    mark,
    abort,
    turnEnd,
    setPrior: (s: string) => {
      prior = s;
    },
    pi,
  };
}

it("accepts only proven single-command successful push and release results", () => {
  const h = setup();
  h.command("1", "git push origin dev");
  h.command("2", "gh release create v1.2.3");
  h.command("3", "scripts/release/release.sh 1.2.3");
  expect(h.mark.mock.calls.map((x) => x[1])).toEqual(["push", "release", "release"]);
  for (const [i, command] of [
    "git status",
    "git log",
    "git --version push",
    "command --help scripts/release/release.sh",
    "echo git push",
    "git push --dry-run",
    "git push -n",
    "git push --help",
    "false && git push",
    "git push; true",
    "git push | cat",
    "git push $(pwd)",
    "git push # comment",
    "gh release list",
    "scripts/release/release.sh --changelog",
  ].entries())
    h.command(`bad${i}`, command);
  h.command("fail", "git push", { isError: true });
  h.command("exit", "git push", { structuredContent: { exit_code: 1 } });
  h.command("timeout", "git push", { isError: true, content: [{ type: "text", text: "timed out" }] });
  h.command("abort", "git push", { isError: true });
  h.command("job", "git push", { details: { jobId: "j1" }, structuredContent: undefined });
  h.command("flagged-abort", "git push", { details: { aborted: true } });
  h.command("flagged-timeout", "git push", { details: { timedOut: true } });
  h.command("unknown", "git push", { structuredContent: undefined });
  expect(h.mark).toHaveBeenCalledTimes(3);
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

it("requires a real task status transition and consumes a call id only once", () => {
  const h = setup();
  const input = { taskId: "1", status: "completed" };
  const call = { toolName: "TaskUpdate", toolCallId: "t", input };
  const result = {
    ...call,
    content: [],
    isError: false,
    details: { action: "update", changed: true, task: { id: 1, status: "completed" } },
  };
  h.emit("tool_call", call);
  h.emit("tool_result", result);
  h.emit("tool_result", result);
  expect(h.mark.mock.calls.map((x) => x[1])).toEqual(["task-done"]);
  h.setPrior("completed");
  h.emit("tool_call", call);
  h.emit("tool_result", result);
  h.setPrior("pending");
  const changedTitle = { ...input, subject: "other" };
  h.emit("tool_call", { ...call, input: changedTitle });
  h.emit("tool_result", { ...result, input: changedTitle });
  expect(h.mark).toHaveBeenCalledTimes(1);
  h.emit("turn_end", { message: { stopReason: "aborted" } });
  expect(h.abort).toHaveBeenCalledOnce();
  expect(h.turnEnd).not.toHaveBeenCalled();
});
