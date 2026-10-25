// data-encryption P2 §6 「集成（真 stack，用假挂载探测端口）」: with a frozen secure verdict, the REAL
// buildSessionStack writes bash-job records under <state>/bash-jobs and sweeps the consult fork root at
// <state>/cache/consult-sessions — never under the agent dir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sandboxHome } from "../integration/helpers/home-sandbox.js";
import { loadSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { sanitizeSessionDirName } from "../../src/bash/session-dirs.js";
import { freezeDomain, makeFakeVault, type FakeVault } from "./helpers.js";

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
let v: FakeVault | undefined;
beforeEach(() => {
  homeSandbox = sandboxHome();
});
afterEach(() => {
  resetSecureDomainForTests();
  v?.cleanup();
  v = undefined;
  homeSandbox?.restore();
  homeSandbox = undefined;
});

function harness() {
  const pi = {
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    events: { emit: vi.fn(), on: () => () => undefined },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "print",
    hasUI: false,
    cwd: v!.work,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "sess-secure-1",
      getSessionFile: () => undefined,
      getSessionDir: () => "",
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { setWidget: vi.fn(), setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const types = {
    get: () => undefined,
    list: () => [],
    reload: async () => ({ types: [], errors: [] }),
  } as unknown as AgentTypeRegistry;
  return { pi, ctx, types };
}

describe("secure stack roots (real buildSessionStack)", () => {
  it("bash-job records land under <state>/bash-jobs; the consult sweep runs on <state>/cache/consult-sessions", async () => {
    v = makeFakeVault();
    freezeDomain(v);
    const agentConsult = join(homeSandbox!.home, ".pi", "agent", "cache", "consult-sessions");
    const vaultConsult = join(v.state, "cache", "consult-sessions");
    mkdirSync(agentConsult, { recursive: true });
    mkdirSync(vaultConsult, { recursive: true });
    // header-less fragments are deleted by the sweep regardless of mtime — a probe for "which root was swept"
    writeFileSync(join(agentConsult, "frag.jsonl"), "garbage\n");
    writeFileSync(join(vaultConsult, "frag.jsonl"), "garbage\n");

    const settings = loadSettings({});
    expect(settings.bashJobs.dir).toBe(join(v.state, "bash-jobs"));
    const { pi, ctx, types } = harness();
    const { buildSessionStack } = await import("../../src/stack.js");
    const stack = buildSessionStack(pi, ctx, settings, types, []);
    try {
      expect(existsSync(join(vaultConsult, "frag.jsonl"))).toBe(false);
      expect(existsSync(join(agentConsult, "frag.jsonl"))).toBe(true);
      const marker = join(v.state, "bash-jobs", sanitizeSessionDirName("sess-secure-1"), "session-id");
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      expect(readFileSync(marker, "utf8")).toBe("sess-secure-1\n");
      expect(existsSync(join(homeSandbox!.home, ".pi", "agent", "bash-jobs"))).toBe(false);
    } finally {
      stack.schedule?.dispose();
      stack.rpc.close();
      stack.bashJobRecovery?.dispose();
      stack.backgroundCompletions.dispose();
    }
  });
});
