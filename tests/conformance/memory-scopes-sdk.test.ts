/** P0 capability evidence only. No scoped-memory production storage/provider is installed. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
function manager() {
  const root = fs.mkdtempSync(join(tmpdir(), "memory39-sdk-"));
  roots.push(root);
  return SessionManager.create(root, join(root, "sessions"));
}
const user = () => ({ role: "user" as const, content: "own fixture user", timestamp: Date.now() });
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("memory scopes C0: real SDK persistence boundaries", () => {
  it("buffers custom-only entries and flushes at the first user, before assistant", () => {
    const sm = manager();
    const id = sm.appendCustomEntry("subagent:memory-session", { text: "private-memory" });
    const file = sm.getSessionFile()!;
    expect(fs.existsSync(file)).toBe(false);
    expect(sm.getBranch().some((entry) => entry.id === id)).toBe(true);
    sm.appendMessage(user());
    expect(fs.existsSync(file)).toBe(true);
    expect(SessionManager.open(file).getBranch()).toEqual(sm.getBranch());
  });

  it("rolls back only the current memory entry on a definite append error", () => {
    const sm = manager();
    sm.appendMessage(user());
    const file = sm.getSessionFile()!;
    const before = sm.getBranch();
    const leaf = sm.getLeafId();
    fs.renameSync(file, `${file}.saved`);
    fs.mkdirSync(file);
    try {
      expect(() => sm.appendCustomEntry("probe", { n: 1 })).toThrow();
      expect(sm.getBranch()).toEqual(before);
      expect(sm.getLeafId()).toBe(leaf);
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(`${file}.saved`, file);
    }
    expect(SessionManager.open(file).getBranch()).toEqual(before);
  });

  it("first-flush failure leaves a partial file and subsequent retries fail EEXIST", () => {
    const sm = manager();
    const id = sm.appendCustomEntry("probe", { text: "buffered" });
    const file = sm.getSessionFile()!;
    const before = sm.getBranch();
    const write = fs.writeFileSync;
    let calls = 0;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((target, data, ...args) => {
      if (typeof target === "number" && ++calls === 2) {
        write(target, String(data).slice(0, 15));
        throw Object.assign(new Error("own tmp injected first-flush partial"), { code: "EIO" });
      }
      return write(target, data, ...args);
    }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();
    try {
      expect(() => sm.appendMessage(user())).toThrow("own tmp injected");
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(calls).toBe(2);
    expect(sm.getBranch()).toEqual(before);
    expect(sm.getLeafId()).toBe(id);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(false);
    expect(SessionManager.open(file).getBranch()).toEqual([]);
    expect(() => sm.appendMessage(user())).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(sm.getBranch()).toEqual(before);
  });

  it("torn append rolls memory back but loader drops the incomplete last line (no disk transaction)", () => {
    const sm = manager();
    sm.appendMessage(user());
    const file = sm.getSessionFile()!;
    const before = sm.getBranch();
    const append = fs.appendFileSync;
    const spy = vi.spyOn(fs, "appendFileSync").mockImplementation(((target, data) => {
      if (target === file) {
        append(target, String(data).slice(0, 20));
        throw Object.assign(new Error("own tmp injected append partial"), { code: "EIO" });
      }
      throw new Error("unexpected non-fixture append");
    }) as typeof fs.appendFileSync);
    syncBuiltinESMExports();
    try {
      expect(() => sm.appendCustomEntry("probe", { text: "torn" })).toThrow("own tmp injected");
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(sm.getBranch()).toEqual(before);
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(false);
    const later = sm.appendCustomEntry("probe", { text: "later successful append" });
    expect(sm.getBranch().at(-1)?.id).toBe(later);
    // Without reopening first, the successful append concatenates onto the torn JSON and is lost on reload.
    expect(SessionManager.open(file).getBranch()).toEqual(before);
  });
});

// The loader isolates (does not reconstruct) an incomplete tail by adding a newline.
it("C0 reopen isolates the torn tail before the next append", () => {
  const sm = manager();
  sm.appendMessage(user());
  const file = sm.getSessionFile()!;
  fs.appendFileSync(file, '{"type":"custom","broken":');
  const reopened = SessionManager.open(file);
  expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  expect(reopened.getBranch()).toEqual(sm.getBranch());
  const id = reopened.appendCustomEntry("probe", { n: 2 });
  expect(SessionManager.open(file).getLeafId()).toBe(id);
});

import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

it("C1/C5 public compact, fork, tree, resume/new retain branch custom entries, not provider context", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "memory39-lifecycle-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
  const model = {
    id: "memory39-local",
    name: "memory39-local",
    api: "anthropic-messages",
    provider: "memory39-local",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  };
  const requests: unknown[] = [];
  const assistant = () => ({
    role: "assistant",
    content: [{ type: "text", text: "scripted local answer" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const runtime = {
    streamSimple(_model: unknown, context: unknown) {
      requests.push(context);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: assistant() } as never);
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
  };
  const settings = SettingsManager.create(root, agentDir);
  let compactCalls = 0;
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Own local fixture only.",
    extensionFactories: [
      (pi: ExtensionAPI) => {
        pi.on("session_before_compact", (event) => {
          compactCalls++;
          return {
            compaction: {
              summary: "scripted summarizer, not a model API",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
      },
    ],
  });
  await loader.reload();
  const sm = SessionManager.create(root, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model: model as never,
    modelRuntime: runtime as never,
    sessionManager: sm,
    settingsManager: settings,
    resourceLoader: loader,
    tools: [],
  });
  try {
    const marker = "PRIVATE_MEMORY_TOKEN_C1";
    const first = sm.appendCustomEntry("subagent:memory-session", { text: marker });
    await session.prompt("one ".repeat(100));
    const branchPoint = sm.getLeafId()!;
    const last = sm.appendCustomEntry("subagent:memory-session", { text: "second private" });
    await session.prompt("two ".repeat(100));
    await session.compact();
    expect(compactCalls).toBe(1);
    expect(sm.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    expect(
      sm
        .getBranch()
        .filter((entry) => entry.type === "custom")
        .map((entry) => entry.id),
    ).toEqual([first, last]);
    expect(JSON.stringify(sm.buildSessionContext().messages)).not.toContain(marker);
    await session.prompt("after compact");
    expect(JSON.stringify(requests)).not.toContain(marker);
    expect(JSON.stringify(requests)).not.toContain("second private");
    const ids = sm.getBranch().map((entry) => entry.id);
    for (const id of [...ids, sm.getLeafId()!]) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(Buffer.byteLength(id, "utf8")).toBeLessThanOrEqual(64);
    }
    const file = sm.getSessionFile()!;
    expect(SessionManager.open(file).getBranch()).toEqual(sm.getBranch());
    const originalSid = sm.getSessionId();
    const forkFile = sm.createBranchedSession(sm.getLeafId()!)!;
    const forked = SessionManager.open(forkFile);
    expect(forked.getSessionId()).not.toBe(originalSid);
    expect(
      forked
        .getBranch()
        .filter((entry) => entry.type === "custom")
        .map((entry) => entry.id),
    ).toEqual([first, last]);
    expect(forked.getLeafId()).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    // Public branch-local navigation, no synthetic compaction insertion.
    await session.navigateTree(branchPoint, { summarize: false });
    expect(sm.getBranch().some((entry) => entry.id === first)).toBe(true);
    expect(sm.getBranch().some((entry) => entry.id === last)).toBe(false);
    const fresh = SessionManager.create(root, join(root, "new"));
    expect(fresh.getBranch()).toEqual([]);
    const inMemory = SessionManager.inMemory(root);
    inMemory.appendCustomEntry("probe", { text: marker });
    expect(inMemory.getSessionFile()).toBeUndefined();
  } finally {
    session.dispose();
  }
});

it("C0 minimal local poison policy rejects subsequent writes, without SDK rollback or auto-open repair", () => {
  const sm = manager();
  sm.appendMessage(user());
  const file = sm.getSessionFile()!;
  fs.renameSync(file, `${file}.saved`);
  fs.mkdirSync(file);
  let poisoned = false,
    calls = 0;
  // Local capability seam for the Root-approved fail-closed policy. P1 owns the real writer.
  const append = () => {
    if (poisoned) return { code: "E_PERSIST", poisoned: true, recovery: "explicit-reopen-and-verify" };
    try {
      calls++;
      sm.appendCustomEntry("probe", { n: 1 });
      return { ok: true };
    } catch {
      poisoned = true;
      return { code: "E_PERSIST", poisoned: true, recovery: "explicit-reopen-and-verify" };
    }
  };
  try {
    expect(append()).toEqual({ code: "E_PERSIST", poisoned: true, recovery: "explicit-reopen-and-verify" });
    expect(append()).toMatchObject({ poisoned: true });
    expect(calls).toBe(1);
    expect(fs.statSync(file).isDirectory()).toBe(true); // adapter did not replace/repair the failed target
  } finally {
    fs.rmdirSync(file);
    fs.renameSync(`${file}.saved`, file);
  }
});

it("C0 first assistant also flushes custom-only buffer (SDK conversation is user OR assistant)", () => {
  const sm = manager();
  const id = sm.appendCustomEntry("probe", { text: "buffered" });
  const file = sm.getSessionFile()!;
  expect(fs.existsSync(file)).toBe(false);
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "local assistant only" }],
    api: "anthropic-messages",
    provider: "local",
    model: "local",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  expect(fs.existsSync(file)).toBe(true);
  expect(
    SessionManager.open(file)
      .getBranch()
      .some((entry) => entry.id === id),
  ).toBe(true);
});

it("C1 local read-provider seam can check locked before real SDK getBranch; not final section wiring", () => {
  const sm = manager();
  sm.appendCustomEntry("probe", { text: "own text" });
  const branch = vi.spyOn(sm, "getBranch");
  let locked = true;
  // Minimal local capability factory, deliberately NOT pi_session_memory's production provider.
  const provider = () => (locked ? "" : JSON.stringify(sm.getBranch()));
  expect(provider()).toBe("");
  expect(branch).not.toHaveBeenCalled();
  locked = false;
  expect(provider()).toContain("own text");
  expect(branch).toHaveBeenCalledTimes(1);
});
