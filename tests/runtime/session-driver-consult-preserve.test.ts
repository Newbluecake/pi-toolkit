import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn() };
});

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import type { ExpertRequestSnapshot } from "../../src/core/types.js";
import { compareConsultIdentity, PiSessionDriver } from "../../src/runtime/session-driver.js";

const createMock = vi.mocked(createAgentSession);
let directory: string;

function sessionFile(): string {
  const path = join(directory, "expert.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({ type: "session", version: 3, id: "s_expert", timestamp: new Date().toISOString(), cwd: directory })}\n`,
  );
  return path;
}

describe("PiSessionDriver consult preserve resume contract", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "pi-consult-preserve-"));
    createMock.mockReset();
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("disposes a created session once when preflight rejects", async () => {
    const dispose = vi.fn();
    createMock.mockResolvedValue({ session: { sessionId: "s_expert", sessionFile: sessionFile(), dispose } } as never);
    const guard = {
      preflight: vi.fn(() => ({ ok: false as const, code: "identity_mismatch:tool-definition:read" })),
      install: vi.fn(),
      counters: vi.fn(() => ({ calls: 0, batches: 0, terminated: false, identity: 0, nested: 0, costAfterUsd: 0 })),
    };
    await expect(new PiSessionDriver().resume(sessionFile(), { consultGuard: guard })).rejects.toThrow(
      "[consult-preserve:identity_mismatch:tool-definition:read]",
    );
    expect(guard.install).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("compares the record-only identity fields without affecting guard admission", () => {
    const cwd = join(directory, "expert-cwd");
    const file = join(directory, "fork.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "fork", cwd })}\n`);
    const snapshot: ExpertRequestSnapshot = {
      tools: [],
      systemSections: { preamble: "base" },
      model: { provider: "p", id: "m" },
      thinkingLevel: "high",
      sourceSessionId: "expert",
    };
    const systemPrompt = getSystemMessageText({
      role: "system",
      content: "",
      sections: snapshot.systemSections,
      timestamp: 0,
    });
    const session = {
      systemPrompt,
      model: { provider: "p", id: "m" },
      thinkingLevel: "high",
      sessionManager: { getCwd: () => cwd },
    };
    expect(compareConsultIdentity(session, snapshot, file)).toEqual({
      system: true,
      model: true,
      thinking: true,
      cwd: true,
    });

    expect(
      compareConsultIdentity(
        {
          ...session,
          systemPrompt: "changed",
          model: { provider: "other", id: "m" },
          thinkingLevel: "low",
          sessionManager: { getCwd: () => "/other" },
          _runSystemPromptOptions: { forceSystemPrompt: "forced" },
        },
        snapshot,
        file,
      ),
    ).toEqual({ system: false, model: false, thinking: false, cwd: false });
  });

  it("omits comparisons whose snapshot or fork facts are unavailable", () => {
    const session = {
      systemPrompt: "base",
      model: { provider: "p", id: "m" },
      thinkingLevel: "high",
      sessionManager: { getCwd: () => "/cwd" },
    };
    // nothing comparable (no system text, no model/thinking/cwd facts, forced prompt never recorded)
    expect(
      compareConsultIdentity(session, { tools: [], systemSections: {}, sourceSessionId: "expert" }),
    ).toBeUndefined();
    expect(
      compareConsultIdentity(session, { tools: [], systemSections: { preamble: "x" }, sourceSessionId: "expert" }),
    ).toEqual({
      system: false,
    });
  });

  it("returns undefined when a diagnostic getter throws", () => {
    const session = Object.defineProperty({}, "systemPrompt", {
      get: () => {
        throw new Error("unavailable");
      },
    });
    expect(
      compareConsultIdentity(session, { tools: [], systemSections: { preamble: "x" }, sourceSessionId: "expert" }),
    ).toBeUndefined();
  });

  it("attaches the record-only prediction to a C2 consult handle", async () => {
    const session = {
      sessionId: "s_consult",
      sessionFile: sessionFile(),
      agent: { onPayload: undefined as unknown },
      systemPrompt: getSystemMessageText({ role: "system", content: "", sections: { preamble: "base" }, timestamp: 0 }),
      model: { provider: "p", id: "m" },
      thinkingLevel: "high",
      sessionManager: { getCwd: () => directory },
      dispose: vi.fn(),
    };
    createMock.mockResolvedValue({ session } as never);
    const guard = {
      preflight: vi.fn(() => ({ ok: true as const })),
      install: vi.fn(),
      counters: vi.fn(() => ({ calls: 0, batches: 0, terminated: false, identity: 0, nested: 0, costAfterUsd: 0 })),
    };
    const handle = await new PiSessionDriver().resume(sessionFile(), {
      runId: "run-prediction",
      cwd: directory,
      consultGuard: guard,
      consultSnapshot: {
        tools: [],
        systemSections: { preamble: "base" },
        model: { provider: "p", id: "m" },
        thinkingLevel: "high",
        sourceSessionId: "s_expert",
      },
    } as never);
    expect(handle.consultIdentityPrediction).toEqual({
      system: true,
      model: true,
      thinking: true,
      cwd: true,
    });
    handle.dispose();
  });

  it("keeps the original install failure prefix when dispose also throws", async () => {
    const dispose = vi.fn(() => {
      throw new Error("dispose failed");
    });
    createMock.mockResolvedValue({ session: { sessionId: "s_expert", sessionFile: sessionFile(), dispose } } as never);
    const guard = {
      preflight: vi.fn(() => ({ ok: true as const })),
      install: vi.fn(() => {
        throw new Error("nested hook missing");
      }),
      counters: vi.fn(() => ({ calls: 0, batches: 0, terminated: false, identity: 0, nested: 0, costAfterUsd: 0 })),
    };
    await expect(new PiSessionDriver().resume(sessionFile(), { consultGuard: guard })).rejects.toThrow(
      "[consult-preserve:guard_unavailable:install-failed] nested hook missing",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
