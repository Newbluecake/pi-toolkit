// data-encryption P2: the remaining guard points — child-session placement and cross-domain resume
// (session-driver), the legacy consult fork root (legacy-consult-forks), D2 worktree refusal (H2), D8 schedule refusal.
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn() };
});

import { createAgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import {
  LEGACY_FORK_TTL_MS,
  legacyConsultForkDir,
  sweepLegacyConsultForks,
} from "../../src/runtime/legacy-consult-forks.js";
import { createWorktreeExtension } from "../../src/extensions/worktree.js";
import { wireSchedule } from "../../src/schedule/agent/wire.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { freezeDomain, makeFakeVault, type FakeVault } from "./helpers.js";

const createMock = vi.mocked(createAgentSession);
let v: FakeVault | undefined;
let tempAgentDir: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (tempAgentDir !== undefined) rmSync(tempAgentDir, { recursive: true, force: true });
  tempAgentDir = undefined;
  resetSecureDomainForTests();
  createMock.mockReset();
  v?.cleanup();
  v = undefined;
});

/** Point pi's agent dir at a throwaway dir for this test (restored by afterEach) — never touch the real ~/.pi/agent. */
function useTempAgentDir(): string {
  tempAgentDir = mkdtempSync(join(tmpdir(), "guard-points-agent-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", tempAgentDir);
  expect(getAgentDir()).toBe(tempAgentDir);
  return tempAgentDir;
}

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
    useTempAgentDir(); // SessionManager.create() mkdirs the session dir under the agent dir
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

describe("legacy consult fork root (runtime/legacy-consult-forks.ts, stack.ts sweep)", () => {
  it("plain ⇒ <agentDir>/cache/consult-sessions; secure ⇒ the in-vault <state>/cache/consult-sessions", () => {
    v = makeFakeVault();
    expect(legacyConsultForkDir()).toBe(join(getAgentDir(), "cache", "consult-sessions"));
    freezeDomain(v);
    expect(legacyConsultForkDir()).toBe(join(v.state, "cache", "consult-sessions"));
  });

  it("secure ⇒ the default sweep cleans only the vault root: files outside it and in the plain agentDir dir are untouched", () => {
    v = makeFakeVault();
    const header = (id: string, cwd: string) =>
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: "t", cwd })}\n`;
    const now = Date.now();
    const old = new Date(now - LEGACY_FORK_TTL_MS - 60_000);
    // the plain-domain dir lives under a throwaway agent dir (never the developer's real ~/.pi/agent);
    // same-named files there must survive a secure sweep.
    useTempAgentDir();
    const plainDir = join(getAgentDir(), "cache", "consult-sessions");
    mkdirSync(plainDir, { recursive: true });
    const plainExpired = join(plainDir, "expired.jsonl");
    const plainFragment = join(plainDir, "fragment.jsonl");
    writeFileSync(plainExpired, header("p", plainDir));
    utimesSync(plainExpired, old, old);
    writeFileSync(plainFragment, "not a session\n");
    const outsideExpired = join(v.outside, "expired.jsonl");
    writeFileSync(outsideExpired, header("o", v.outside));
    utimesSync(outsideExpired, old, old);
    freezeDomain(v);
    const root = legacyConsultForkDir();
    mkdirSync(root, { recursive: true });
    const vaultExpired = join(root, "expired.jsonl");
    const vaultFragment = join(root, "fragment.jsonl");
    const vaultFresh = join(root, "fresh.jsonl");
    writeFileSync(vaultExpired, header("e", root));
    utimesSync(vaultExpired, old, old);
    writeFileSync(vaultFragment, "not a session\n");
    writeFileSync(vaultFresh, header("f", root));
    expect(sweepLegacyConsultForks(undefined, undefined, now)).toEqual({
      removedExpired: 1,
      removedFragments: 1,
      kept: 1,
      errors: 0,
    });
    expect(existsSync(vaultExpired)).toBe(false);
    expect(existsSync(vaultFragment)).toBe(false);
    expect(existsSync(vaultFresh)).toBe(true);
    expect(existsSync(plainExpired)).toBe(true);
    expect(existsSync(plainFragment)).toBe(true);
    expect(existsSync(outsideExpired)).toBe(true);
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

describe("D8: scheduled tasks refused outside the plain domain (A0 retired the old cron engine)", () => {
  const ctxOf = (file: string | undefined) =>
    ({
      mode: "tui",
      sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => file, getEntries: () => [] },
    }) as never;
  it("secure ⇒ mode secure: no store, no clock, every execution gate E_SECURE, nothing created", async () => {
    v = makeFakeVault();
    const { domain } = freezeDomain(v);
    const dir = join(v.home, "sched-store");
    const pi = { on: vi.fn() };
    const wiring = wireSchedule(pi as never, {
      settings: { enabled: true, dir, defaultTimeoutMs: 1_800_000, maxTimeoutMs: 14_400_000 },
      agentDir: v.home,
      secure: domain,
      webHub: true,
      current: () => undefined,
      flockProbe: () => true,
    });
    expect(wiring.webHubPort).toBeUndefined(); // no sched.v1 cap / HubConfig.schedule from a secure process
    const agent = wiring.createAgent({ ctx: ctxOf(join(v.work, "s.jsonl")) });
    expect(agent.mode.kind).toBe("secure");
    expect(agent.clock).toBeUndefined();
    expect(agent.store()).toBeUndefined();
    expect(agent.self).toBeUndefined(); // no identity is even read in a secure process
    expect(agent.gate()?.code).toBe("E_SECURE");
    expect(await agent.runNow({ taskId: "s_abcdefgh", reqId: "req-0123456789abcdef" })).toMatchObject({
      kind: "refused",
      code: "E_SECURE",
    });
    await agent.start();
    await agent.shutdown();
    expect(existsSync(dir)).toBe(false);
  });
  it("no verdict (plain) ⇒ interactive TUI session arms", () => {
    const pi = { on: vi.fn() };
    const wiring = wireSchedule(pi as never, {
      settings: { enabled: true, dir: "/nonexistent/sched", defaultTimeoutMs: 1_800_000, maxTimeoutMs: 14_400_000 },
      agentDir: "/nonexistent",
      secure: { kind: "plain", vaults: [], config: {} } as never,
      webHub: false,
      current: () => undefined,
      flockProbe: () => true,
    });
    const agent = wiring.createAgent({ ctx: ctxOf("/tmp/x.jsonl") });
    expect(agent.mode.kind).toBe("interactive");
    expect(agent.clock).toBeDefined();
    agent.dispose();
  });
});

describe("§4 session-nav provenance cache follows the vault sessionDir", () => {
  it("sessionDir <state>/sessions/default ⇒ cache under <state>/cache", async () => {
    const { provenanceCachePath } = await import("../../src/session-nav/provenance.js");
    const state = "/v/acme/mnt/state";
    expect(provenanceCachePath(`${state}/sessions/default`).startsWith(`${state}/cache/session-nav/`)).toBe(true);
  });
});
