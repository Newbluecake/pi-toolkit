import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn() };
});

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";

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
