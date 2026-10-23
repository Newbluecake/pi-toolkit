// data-encryption P2: the remaining guard points — child-session placement and cross-domain resume
// (session-driver), the consult fork root (fork-store), D2 worktree refusal (H2), D8 cron refusal.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn() };
});

import { createAgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import { consultSessionDir, removeForkFile } from "../../src/consult/fork-store.js";
import { createWorktreeExtension } from "../../src/extensions/worktree.js";
import { createScheduler } from "../../src/schedule/scheduler.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { freezeDomain, makeFakeVault, type FakeVault } from "./helpers.js";

const createMock = vi.mocked(createAgentSession);
let v: FakeVault | undefined;
afterEach(() => {
  resetSecureDomainForTests();
  createMock.mockReset();
  v?.cleanup();
  v = undefined;
});

function fakeSession() {
  return {
    sessionId: "s",
    sessionFile: undefined,
    agent: { onPayload: undefined as unknown },
    subscribe: () => () => undefined,
    dispose: vi.fn(),
  };
}

function sessionManagerOf(): { getSessionDir(): string; getSessionFile(): string | undefined } {
  const call = createMock.mock.calls[0]?.[0] as {
    sessionManager: { getSessionDir(): string; getSessionFile(): string | undefined };
  };
  return call.sessionManager;
}

describe("session-driver child placement (plan §2.5 「子会话落盘」)", () => {
  it("secure ⇒ persisted child sessions live in <state>/sessions/default", async () => {
    v = makeFakeVault();
    freezeDomain(v);
    createMock.mockResolvedValue({ session: fakeSession() } as never);
    const handle = await new PiSessionDriver().create({ runId: "r1", cwd: v.work, persist: true } as never);
    expect(sessionManagerOf().getSessionDir()).toBe(v.sessions);
    expect(
      sessionManagerOf()
        .getSessionFile()
        ?.startsWith(v.sessions + "/"),
    ).toBe(true);
    handle.dispose();
  });

  it("no verdict ⇒ pi's default session dir (legacy create(cwd))", async () => {
    v = makeFakeVault();
    createMock.mockResolvedValue({ session: fakeSession() } as never);
    const handle = await new PiSessionDriver().create({ runId: "r2", cwd: v.outside, persist: true } as never);
    expect(sessionManagerOf().getSessionDir().startsWith(getAgentDir())).toBe(true);
    handle.dispose();
  });

  it("locked ⇒ create is rejected before any session is built", async () => {
    v = makeFakeVault();
    freezeDomain(v, { mountinfo: v.unmounted });
    await expect(new PiSessionDriver().create({ runId: "r3", cwd: v.work, persist: true } as never)).rejects.toThrow(
      /锁定/,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("cross-domain resume is rejected before pi opens the file", async () => {
    v = makeFakeVault();
    const outsideFile = join(v.outside, "o.jsonl");
    writeFileSync(
      outsideFile,
      `${JSON.stringify({ type: "session", version: 3, id: "o", timestamp: "t", cwd: v.outside })}\n`,
    );
    freezeDomain(v);
    await expect(new PiSessionDriver().resume(outsideFile, { runId: "r4" } as never)).rejects.toThrow(/保险库外/);
    resetSecureDomainForTests();
    const vaultFile = join(v.sessions, "i.jsonl");
    writeFileSync(
      vaultFile,
      `${JSON.stringify({ type: "session", version: 3, id: "i", timestamp: "t", cwd: v.work })}\n`,
    );
    freezeDomain(v, { cwd: v.outside });
    await expect(new PiSessionDriver().resume(vaultFile, { runId: "r5" } as never)).rejects.toThrow(/acme/);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("consult fork root (fork-store.ts:78/808, stack.ts consult wiring)", () => {
  it("secure ⇒ consultSessionDir and removeForkFile's default root are the in-vault dir", () => {
    v = makeFakeVault();
    const legacy = consultSessionDir();
    expect(legacy).toBe(join(getAgentDir(), "cache", "consult-sessions"));
    freezeDomain(v);
    const root = consultSessionDir();
    expect(root).toBe(join(v.state, "cache", "consult-sessions"));
    mkdirSync(root, { recursive: true });
    const inside = join(root, "f.jsonl");
    writeFileSync(inside, "x\n");
    expect(removeForkFile(inside)).toBe(true);
    expect(existsSync(inside)).toBe(false);
    const legacyFile = join(v.outside, "g.jsonl");
    writeFileSync(legacyFile, "x\n");
    expect(removeForkFile(legacyFile)).toBe(false); // outside the (secure) root ⇒ refused
  });
});

describe("D2: worktree isolation refused outside the plain domain (H2)", () => {
  const exec = vi.fn(async () => ({ code: 0, stdout: "/repo\n", stderr: "" }));
  const ext = () =>
    createWorktreeExtension({ exec: exec as never, settings: { enabled: true, gitTimeoutMs: 1000, linkPaths: [] } });
  it("secure ⇒ resolveSessionSpec throws before any git call", async () => {
    v = makeFakeVault();
    freezeDomain(v);
    await expect(
      ext().resolveSessionSpec!({ cwd: v.work } as never, { isolation: "worktree", runId: "w1" } as never),
    ).rejects.toThrow(/加密会话不支持 worktree/);
    expect(exec).not.toHaveBeenCalled();
  });
  it("plain domain ⇒ the request reaches git as before", async () => {
    v = makeFakeVault();
    freezeDomain(v, { cwd: v.outside });
    exec.mockClear();
    exec.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not a repo" });
    await expect(
      ext().resolveSessionSpec!({ cwd: v.outside } as never, { isolation: "worktree", runId: "w0" } as never),
    ).rejects.toThrow(/rev-parse/);
    expect(exec).toHaveBeenCalled();
  });
  it("non-worktree requests are untouched", async () => {
    v = makeFakeVault();
    freezeDomain(v);
    const spec = { cwd: v.work };
    expect(await ext().resolveSessionSpec!(spec as never, { runId: "w2" } as never)).toBe(spec);
  });
});

describe("D8: cron refused outside the plain domain", () => {
  const task = () => ({
    id: "t",
    schedule: { kind: "interval" as const, intervalMs: 60_000 },
    request: { prompt: "x" },
  });
  it("secure ⇒ register throws, start never loads the store", async () => {
    v = makeFakeVault();
    freezeDomain(v);
    const store = { load: vi.fn(async () => [task()]), save: vi.fn(async () => undefined) };
    const s = createScheduler({ spawn: { spawn: vi.fn() } as never, store });
    await s.start();
    expect(store.load).not.toHaveBeenCalled();
    await expect(s.register(task() as never)).rejects.toThrow(/cron/);
    expect(s.list()).toEqual([]);
    s.stop();
  });
  it("no verdict ⇒ legacy scheduler (loads the store)", async () => {
    const store = { load: vi.fn(async () => []), save: vi.fn(async () => undefined) };
    const s = createScheduler({ spawn: { spawn: vi.fn() } as never, store });
    await s.start();
    expect(store.load).toHaveBeenCalledTimes(1);
    s.stop();
  });
});

describe("§4 session-nav provenance cache follows the vault sessionDir", () => {
  it("sessionDir <state>/sessions/default ⇒ cache under <state>/cache", async () => {
    const { provenanceCachePath } = await import("../../src/session-nav/provenance.js");
    const state = "/v/acme/mnt/state";
    expect(provenanceCachePath(`${state}/sessions/default`).startsWith(`${state}/cache/session-nav/`)).toBe(true);
  });
});
