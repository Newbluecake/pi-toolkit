import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn() };
});

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { getPrefixProbeRegistry } from "../../src/consult/prefix-probe.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";

const createMock = vi.mocked(createAgentSession);
let directory: string;

function sessionFile(): string {
  const path = join(directory, "child.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({ type: "session", version: 3, id: "s_child", timestamp: new Date().toISOString(), cwd: directory })}\n`,
  );
  return path;
}

function fakeSession() {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    sessionId: "s_child",
    sessionFile: sessionFile(),
    agent: { onPayload: undefined as unknown },
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit(event: unknown) {
      for (const listener of [...listeners]) listener(event);
    },
    dispose: vi.fn(),
  };
}

describe("PiSessionDriver prefix probe wiring", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "pi-prefix-driver-"));
    createMock.mockReset();
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("wires every created child after createAgentSession and pairs request usage", async () => {
    const session = fakeSession();
    createMock.mockResolvedValue({ session } as never);
    const handle = await new PiSessionDriver().create({
      runId: "run-prefix-create",
      cwd: directory,
      persist: false,
    } as never);
    const payload = { model: "m", messages: [{ role: "user", content: "child" }] };
    const result = await (session.agent.onPayload as (payload: unknown, model: unknown) => Promise<unknown>)(payload, {
      api: "anthropic-messages",
      provider: "provider",
      id: "m",
    });
    expect(result).toBeUndefined();
    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.1 } } },
    });
    const record = getPrefixProbeRegistry().get("run-prefix-create");
    expect(record?.first?.usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.1 });
    expect(record?.api).toBe("anthropic-messages");
    expect(record?.provider).toBe("provider");
    handle.dispose();
  });

  it("marks a consult session from consultGuard and keeps all its requests", async () => {
    const session = fakeSession();
    createMock.mockResolvedValue({ session } as never);
    const guard = {
      preflight: vi.fn(() => ({ ok: true as const })),
      install: vi.fn(),
      counters: vi.fn(() => ({ calls: 0, batches: 0, terminated: false, identity: 0, nested: 0, costAfterUsd: 0 })),
    };
    const handle = await new PiSessionDriver().resume(sessionFile(), {
      runId: "run-prefix-consult",
      cwd: directory,
      consultGuard: guard,
    } as never);
    const payload = { model: "m", messages: [{ role: "user", content: "consult" }] };
    const onPayload = session.agent.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;
    await onPayload(payload, { api: "a", provider: "p", id: "m" });
    await onPayload({ ...payload, max_tokens: 10 }, { api: "a", provider: "p", id: "m" });
    session.emit({ type: "agent_settled" });
    expect(
      getPrefixProbeRegistry()
        .get("run-prefix-consult")
        ?.requests?.map((request) => request.seq),
    ).toEqual([0, 1]);
    expect(guard.preflight).toHaveBeenCalledTimes(1);
    expect(guard.install).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("uses main as the run id when the SessionSpec has no runId", async () => {
    const session = fakeSession();
    createMock.mockResolvedValue({ session } as never);
    const handle = await new PiSessionDriver().create({ cwd: directory, persist: false } as never);
    await (session.agent.onPayload as Function)({ model: "m", messages: [] }, { id: "m" });
    session.emit({ type: "agent_settled" });
    expect(getPrefixProbeRegistry().get("main")?.latest?.seq).toBe(0);
    handle.dispose();
  });
});
