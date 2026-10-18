import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type ToolDeclaration } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExpertRequestSnapshot } from "../../src/core/types.js";
import { comparePayloadPrefix, preflight, PROVIDER_PREFIX_FIELDS } from "../../src/consult/preserve-identity.js";
import {
  blockedToolReason,
  createConsultGuard,
  getConsultGuard,
  installNestedCallBlock,
  NESTED_TOOL_CALL_REASON,
} from "../../src/consult/preserve-guard.js";
import { buildConsultPrompt } from "../../src/consult/prompt.js";
import { compareRecordedPrefix, getPrefixProbeRegistry, installPrefixProbe } from "../../src/consult/prefix-probe.js";
import { createPermissiveGuard } from "./fixtures/permissive-guard.js";
import { AnthropicStub, type StubReply, type StubRequest } from "./fixtures/anthropic-stub.js";

import activate from "../../src/index.js";
import type { SessionHandle } from "../../src/runtime/session-driver.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import type { Stack } from "../../src/stack.js";
import { isLiveSessionFile } from "../../src/core/live-session-files.js";
import { consultCacheMarkerOfDiag } from "../../src/core/consult-cache-marker.js";
import { scanExpertSnapshot } from "../../src/consult/fork-store.js";
import {
  productionConsultHost,
  lastUserText,
  wireMessages,
  messageMarkers,
  allMarkerCount,
  stripMessageMarkers,
} from "./fixtures/consult-production.js";

// Observe the real assembly's result. No hand-built wiring or mock driver is
// involved in the E1 gates; every wrapped function runs its production body.
const production = vi.hoisted(() => ({ stacks: [] as Stack[] }));
vi.mock("../../src/stack.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stack.js")>();
  return {
    ...actual,
    buildSessionStack: (...args: Parameters<typeof actual.buildSessionStack>) => {
      const stack = actual.buildSessionStack(...args);
      production.stacks.push(stack);
      return stack;
    },
  };
});

const productionCleanups: Array<() => Promise<void>> = [];
const scratchDirs: string[] = [];
const stubs: AnthropicStub[] = [];

afterEach(async () => {
  for (const cleanup of productionCleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  production.stacks.length = 0;
  for (const stub of stubs.splice(0)) await stub.close();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function model(baseUrl: string) {
  return {
    id: "claude-conformance",
    name: "Claude conformance stub",
    api: "anthropic-messages" as const,
    provider: "anthropic-stub",
    baseUrl: `${baseUrl}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 256,
  };
}

type ConformanceModel = ReturnType<typeof model>;

function runtime(selectedModel: ConformanceModel) {
  return {
    streamSimple: (
      m: ConformanceModel,
      context: Parameters<typeof streamSimple>[1],
      options: Parameters<typeof streamSimple>[2],
    ) => streamSimple(m, context, { ...options, apiKey: "stub-key" }),
    getModel: () => selectedModel,
    hasConfiguredAuth: () => true,
    getAuth: async () => ({ apiKey: "stub-key" }),
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [selectedModel],
  };
}

interface SessionOptions {
  manager?: SessionManager;
  tools?: string[];
  customTools?: ToolDefinition[];
  extensions?: ((pi: ExtensionAPI) => void)[];
}

async function createRealSession(stub: AnthropicStub, options: SessionOptions = {}) {
  const cwd = scratchDirs[0] ?? mkdtempSync(join(tmpdir(), "consult-preserve-conformance-"));
  if (!scratchDirs.includes(cwd)) scratchDirs.push(cwd);
  const agentDir = join(cwd, ".pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const selectedModel = model(stub.baseUrl);
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "anthropic-stub": {
          baseUrl: selectedModel.baseUrl,
          api: "anthropic-messages",
          apiKey: "stub-key",
          models: [selectedModel],
        },
      },
    }),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: options.extensions,
  });
  await resourceLoader.reload();
  const manager = options.manager ?? SessionManager.inMemory(cwd);
  const created = await createAgentSession({
    cwd,
    model: selectedModel as never,
    modelRuntime: runtime(selectedModel) as never,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    tools: options.tools ?? ["read", "grep", "find", "ls", "write", "edit", "bash"],
    customTools: options.customTools as never,
  } as never);
  return { session: created.session, model: selectedModel, manager };
}

function snapshotFrom(request: StubRequest, sourceSessionId: string): ExpertRequestSnapshot {
  const tools = Array.isArray(request.json.tools) ? (request.json.tools as ToolDeclaration[]) : [];
  return { tools, systemSections: {}, sourceSessionId };
}

function bodies(stub: AnthropicStub): Record<string, unknown>[] {
  return stub.requests.map((request) => request.json);
}

function assertDocumentedFields(body: Record<string, unknown>): void {
  const documented = new Set<string>(PROVIDER_PREFIX_FIELDS);
  expect(Object.keys(body).filter((field) => !documented.has(field))).toEqual([]);
}

async function seedConsult(
  stub: AnthropicStub,
  tools: string[] = ["read", "write", "edit", "bash"],
  extensions?: ((pi: ExtensionAPI) => void)[],
) {
  const expert = await createRealSession(stub, { tools, extensions });
  await expert.session.prompt("expert seed context");
  const expertRequest = stub.requests.at(-1)!;
  const snapshot = snapshotFrom(expertRequest, expert.session.sessionId);
  const manager = SessionManager.inMemory(expert.manager.getCwd(), undefined, expert.manager.getEntries() as never);
  const consult = await createRealSession(stub, { manager, tools, extensions });
  const guard = createConsultGuard(snapshot);
  expect(preflight(consult.session, snapshot)).toEqual({ ok: true });
  guard.install(consult.session);
  return { expert, consult, guard, snapshot, manager };
}

describe("consult preserve conformance — real pi + Anthropic Messages boundary (supplementary guard checks)", () => {
  it("C1 supplementary: compares the hand-forked raw expert-last and consult-first provider prefixes", async () => {
    const stub = await AnthropicStub.start({
      reply: (_request, index): StubReply => ({ kind: "text", text: `reply-${index}` }),
    });
    stubs.push(stub);
    const expert = await createRealSession(stub);
    const expertProbeCleanup = installPrefixProbe(expert.session, { runId: "conformance-c1-expert" });
    await expert.session.prompt("expert context one");
    await expert.session.prompt("expert context two");
    const expertLast = stub.requests.at(-1)!.json;
    const sourceEntries = expert.manager.getEntries();
    const consultManager = SessionManager.inMemory(expert.manager.getCwd(), undefined, sourceEntries as never);
    const consult = await createRealSession(stub, { manager: consultManager });
    const snapshot = snapshotFrom(stub.requests.at(-1)!, expert.session.sessionId);
    const guard = createConsultGuard(snapshot);
    expect(preflight(consult.session, snapshot)).toEqual({ ok: true });
    guard.install(consult.session);
    const consultProbeCleanup = installPrefixProbe(consult.session, {
      runId: "conformance-c1-consult",
      consultGuard: guard,
    });
    await consult.session.prompt("consult question");
    expect(stub.requests).toHaveLength(3);
    const consultFirst = stub.requests[2]!.json;
    const comparison = comparePayloadPrefix(expertLast, consultFirst);
    expect(comparison).toMatchObject({ model: true, messages: true, tools: true, system: true, thinking: true });
    const expertRecord = getPrefixProbeRegistry().get("conformance-c1-expert");
    const consultRecord = getPrefixProbeRegistry().get("conformance-c1-consult");
    expect(expertRecord?.probeErrors ?? 0).toBe(0);
    expect(consultRecord?.probeErrors ?? 0).toBe(0);
    expect(expertRecord?.latest).toBeDefined();
    expect(consultRecord?.requests?.[0]).toBeDefined();
    expect(compareRecordedPrefix(expertRecord!.latest!, consultRecord!.requests![0]!)).toEqual(comparison);
    consultProbeCleanup();
    expertProbeCleanup();
    for (const body of bodies(stub)) assertDocumentedFields(body);
    expect(stub.requests[2]!.headers["anthropic-beta"]).toBe(stub.requests[1]!.headers["anthropic-beta"]);
    expect(JSON.stringify(consultFirst.system)).not.toContain("consult question");
    expect(
      consultManager
        .getEntries()
        .find((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("consult question")),
    ).toMatchObject({ message: { role: "user", content: [{ type: "text", text: "consult question" }] } });
    expert.session.dispose();
    consult.session.dispose();
  });

  it("C2: observes every blocked call but executes no disabled tool or extension handler", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "consult-c2-"));
    scratchDirs.push(cwd);
    const marker = join(cwd, "blocked-events.log");
    const writes = join(cwd, "blocked-write.txt");
    const bashMarker = join(cwd, "blocked-bash.txt");
    const editTarget = join(cwd, "blocked-edit.txt");
    writeFileSync(editTarget, "before");
    let toolCallHandlers = 0;
    const extensionSpy = (pi: ExtensionAPI) => {
      pi.on("tool_execution_start", () => appendFileSync(marker, "attempted\n"));
      pi.on("tool_call", () => {
        toolCallHandlers += 1;
      });
    };
    const calls = [
      { name: "write", input: { path: writes, content: "must not write" } },
      { name: "edit", input: { path: editTarget, edits: [{ oldText: "before", newText: "after" }] } },
      { name: "bash", input: { command: `touch ${bashMarker}` } },
    ];
    const stub = await AnthropicStub.start({
      reply: (_request, index): StubReply =>
        index < 1
          ? { kind: "text", text: "seed" }
          : index < 3
            ? { kind: "tool", calls }
            : { kind: "text", text: "done" },
    });
    stubs.push(stub);
    const { consult, guard } = await seedConsult(stub, ["read", "write", "edit", "bash"], [extensionSpy]);
    await consult.session.prompt("attempt all disabled tools");
    expect(stub.requests.length).toBeLessThanOrEqual(4);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(6);
    expect(existsSync(writes)).toBe(false);
    expect(existsSync(bashMarker)).toBe(false);
    expect(readFileSync(editTarget, "utf8")).toBe("before");
    expect(guard.counters()).toMatchObject({ calls: 6, batches: 2, terminated: true });
    expect(toolCallHandlers).toBe(0);
    const toolResults = consult.manager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
    expect(toolResults).toHaveLength(6);
    for (const entry of toolResults) {
      expect(entry.message).toMatchObject({ isError: true, details: {} });
      expect((entry.message.content as Array<{ text?: string }>)[0]?.text).toContain(
        "is disabled in this read-only consult",
      );
    }
  });

  it("C3: terminates after the second consecutive all-blocked batch with at most one extra request", async () => {
    const calls = [{ name: "bash", input: { command: "touch should-not-exist" } }];
    const stub = await AnthropicStub.start({
      reply: (_request, index): StubReply =>
        index === 0
          ? { kind: "text", text: "seed" }
          : index < 3
            ? { kind: "tool", calls }
            : { kind: "text", text: "fallback" },
    });
    stubs.push(stub);
    const { consult, guard } = await seedConsult(stub);
    await consult.session.prompt("blocked twice");
    expect(stub.requests.length).toBeLessThanOrEqual(4);
    expect(guard.counters().terminated).toBe(true);
  });

  it("C4: blocks nested ctx.executeTool calls and pins allowed-tool identity", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "consult-c4-"));
    scratchDirs.push(cwd);
    const nestedWrites = join(cwd, "nested-write.txt");
    const nestedBash = join(cwd, "nested-bash.txt");
    let nestedOutcomes: unknown[] = [];
    const nestedProbe: ToolDefinition = {
      name: "nested_probe",
      label: "nested probe",
      description: "test-only nested call probe",
      parameters: { type: "object", properties: {}, additionalProperties: false } as never,
      async execute(_id, _params, _signal, _update, ctx) {
        nestedOutcomes = await Promise.all([
          ctx.executeTool("write", { path: nestedWrites, content: "nested" }),
          ctx.executeTool("bash", { command: `touch ${nestedBash}` }),
        ]);
        return { content: [{ type: "text", text: "nested probe complete" }] };
      },
    };
    const stub = await AnthropicStub.start({
      reply: (_request, index): StubReply =>
        index === 0
          ? { kind: "text", text: "seed" }
          : index === 1
            ? { kind: "tool", calls: [{ name: "nested_probe" }] }
            : index === 2
              ? {
                  kind: "tool",
                  calls: [
                    { name: "read", input: { path: "." } },
                    { name: "grep", input: { pattern: "nothing", path: "." } },
                    { name: "find", input: { pattern: "*", path: "." } },
                    { name: "ls", input: { path: "." } },
                  ],
                }
              : { kind: "text", text: "done" },
    });
    stubs.push(stub);
    const expert = await createRealSession(stub, {
      tools: ["read", "write", "bash", "nested_probe"],
      customTools: [nestedProbe],
    });
    await expert.session.prompt("expert seed context");
    const snapshot = snapshotFrom(stub.requests[0]!, expert.session.sessionId);
    const manager = SessionManager.inMemory(expert.manager.getCwd(), undefined, expert.manager.getEntries() as never);
    const consult = await createRealSession(stub, {
      manager,
      tools: ["read", "write", "bash", "nested_probe"],
      customTools: [nestedProbe],
    });
    const guard = createPermissiveGuard(consult.session);
    expect(guard.preflight(consult.session)).toEqual({ ok: true });
    guard.install(consult.session);
    await consult.session.prompt("run nested probe");
    expect(nestedOutcomes).toHaveLength(2);
    expect(nestedOutcomes.every((outcome: any) => outcome?.isError === true)).toBe(true);
    expect(existsSync(nestedWrites)).toBe(false);
    expect(existsSync(nestedBash)).toBe(false);
    expect(guard.counters().nested).toBe(2);

    const production = createConsultGuard(snapshot);
    expect(production.preflight(consult.session)).toEqual({ ok: true });
    production.install(consult.session);
    const nestedCallSpy = vi.spyOn(consult.session as never, "_executeNestedToolCall");
    await consult.session.prompt("run read-only tools");
    expect(nestedCallSpy).toHaveBeenCalledTimes(0);
    const originalReadDefinition = consult.session.getToolDefinition("read");
    consult.session.getToolDefinition = (name: string) =>
      name === "read" ? { ...originalReadDefinition } : originalReadDefinition;
    const identityBlocked = await consult.session.agent.beforeToolCall({
      toolCall: { name: "read", id: "identity-read" },
      assistantMessage: {},
      args: { path: "." },
      context: { tools: consult.session.agent.state.tools },
    });
    expect(identityBlocked).toMatchObject({ block: true, identity: true });
  });

  it("C5: fails closed before the provider request for missing hooks and changed definitions", async () => {
    const stub = await AnthropicStub.start();
    stubs.push(stub);
    const { consult } = await seedConsult(stub, ["read", "write"]);
    const dispose = vi.spyOn(consult.session, "dispose");
    delete (consult.session.agent as { beforeToolCall?: unknown }).beforeToolCall;
    const snapshot = snapshotFrom(stub.requests[0]!, consult.session.sessionId);
    expect(preflight(consult.session, snapshot)).toEqual({ ok: false, code: "guard_unavailable:agent-hooks" });
    expect(stub.requests).toHaveLength(1);
    let disposed = false;
    const disposeOnce = () => {
      if (disposed) return;
      disposed = true;
      consult.session.dispose();
    };
    disposeOnce();
    disposeOnce();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => preflight({}, snapshot)).not.toThrow();

    const nestedCase = await seedConsult(stub, ["read", "write"]);
    const nestedSnapshot = snapshotFrom(stub.requests[1]!, nestedCase.consult.session.sessionId);
    (nestedCase.consult.session as { _beforeToolCall?: unknown })._beforeToolCall = undefined;
    expect(preflight(nestedCase.consult.session, nestedSnapshot)).toEqual({
      ok: false,
      code: "guard_unavailable:nested-hook",
    });
    expect(stub.requests).toHaveLength(2);

    const prepareCase = await seedConsult(stub, ["read", "write"]);
    const prepareSnapshot = snapshotFrom(stub.requests[2]!, prepareCase.consult.session.sessionId);
    const originalDefinition = prepareCase.consult.session.getToolDefinition.bind(prepareCase.consult.session);
    prepareCase.consult.session.getToolDefinition = (name: string) =>
      name === "write"
        ? { ...originalDefinition(name), prepareArguments: (args: unknown) => args }
        : originalDefinition(name);
    expect(preflight(prepareCase.consult.session, prepareSnapshot)).toEqual({
      ok: false,
      code: "identity_mismatch:unaudited-prepare-arguments:write",
    });
    expect(stub.requests).toHaveLength(3);
  });

  it("C6: records system drift without weakening the tool/message prefix check", async () => {
    const stub = await AnthropicStub.start();
    stubs.push(stub);
    const { expert } = await seedConsult(stub, ["read", "write"]);
    writeFileSync(join(expert.manager.getCwd(), "AGENTS.md"), "changed project instructions");
    const manager = SessionManager.inMemory(expert.manager.getCwd(), undefined, expert.manager.getEntries() as never);
    const consult = await createRealSession(stub, { manager, tools: ["read", "write"] });
    const snapshot = snapshotFrom(stub.requests[0]!, expert.session.sessionId);
    const guard = createConsultGuard(snapshot);
    expect(preflight(consult.session, snapshot)).toEqual({ ok: true });
    guard.install(consult.session);
    await consult.session.prompt("system drift question");
    const comparison = comparePayloadPrefix(stub.requests[0]!.json, stub.requests[1]!.json);
    expect(comparison.messages).toBe(true);
    expect(comparison.tools).toBe(true);
    expect(comparison.system).toBe(false);
  });

  it.skip("C8: reuses agent.sessionId for provider affinity while keeping the fork header id new (Q5 pending)", () => {
    // Q5 is explicitly unresolved in expert-keepalive-plan.md §10. The
    // current implementation intentionally does not set agent.sessionId, so
    // this remains a visible release gate rather than a false green claim.
  });

  it("C7: keeps the consult prompt in the appended user message, never in system", () => {
    const prompt = buildConsultPrompt({
      question: "why does this fail?",
      allowed: ["read"],
      disabled: ["write"],
      isMain: false,
      maxAnswerChars: 500,
      budgetNote: true,
    });
    expect(prompt).toContain("READ-ONLY CONSULT MODE");
    expect(prompt).toContain("why does this fail?");
    expect(prompt).not.toContain("system");
  });
});

function sha(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

function assertProbeMatchesBody(
  record: NonNullable<ReturnType<ReturnType<typeof getPrefixProbeRegistry>["get"]>>["first"],
  body: Record<string, unknown>,
) {
  expect(record).toBeDefined();
  expect(Object.keys(record!.fieldHashes).sort()).toEqual(Object.keys(body).sort());
  for (const [key, hash] of Object.entries(record!.fieldHashes)) {
    if (key === "messages") {
      expect(hash).toBe(sha(stripMessageMarkers(body.messages)));
      continue;
    }
    expect(hash, `raw ${key} hash`).toBe(sha(body[key]));
  }
  expect(record!.messageHashes).toEqual(wireMessages(body).map((message) => sha(stripMessageMarkers(message))));
}

async function productionHost(stub: AnthropicStub, options: { oauth?: boolean; inject?: boolean } = {}) {
  const host = await productionConsultHost(stub, activate, () => production.stacks.at(-1)!, options);
  scratchDirs.push(host.cwd);
  productionCleanups.push(host.shutdown);
  return host;
}

describe("E1 production install chain — activate / stack / SpawnService / consult / real session-driver", () => {
  for (const oauth of [false, true]) {
    it(
      oauth
        ? "C11: OAuth relocated first, limit follow-up and honest degraded projection"
        : "C1 + C12: anchored C2-preserved threads retain full A1, replay the anchor, warm-hit #2, fresh #1 and close",
      async () => {
        const fullAnswer = `E1 full answer beginning\n${"complete answer detail ".repeat(50)} E1 mid retained sentinel ${"complete answer detail ".repeat(50)}\nE1 full answer END`;
        const consultBodies: StubRequest[] = [];
        const askerBodies: StubRequest[] = [];
        let askerTurn = 0;
        let onAskerRequest: ((turn: number) => void) | undefined;
        let release!: () => void;
        const endGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        productionCleanups.push(async () => {
          release();
        });
        const stub = await AnthropicStub.start({
          promptCache: true,
          reply: async (request): Promise<StubReply> => {
            const text = lastUserText(request.json);

            if (text.includes("\nQuestion:\nE1-Q")) {
              consultBodies.push(request);
              return {
                kind: "text",
                text: consultBodies.length === 1 ? fullAnswer : `E1 answer ${consultBodies.length}`,
              };
            }
            if (text.includes("E1-H")) return { kind: "text", text: "E1 expert completed its investigation" };
            if (!JSON.stringify(request.json.messages).includes("E1-ASK"))
              return { kind: "text", text: "host notice acknowledged" };
            askerBodies.push(request);
            const n = ++askerTurn;
            onAskerRequest?.(n);
            if (n <= (oauth ? 2 : 3))
              return {
                kind: "tool",
                calls: [
                  {
                    name: "consult",
                    input: { expert: "e1-expert", question: `E1-Q${n}`, ...(n === 3 ? { fresh: true } : {}) },
                  },
                ],
              };
            await endGate; // keep the REAL asker alive so terminal cleanup cannot hide close() leaks
            return { kind: "text", text: "E1 asker done" };
          },
        });
        stubs.push(stub);
        const host = await productionHost(stub, { oauth });
        const expertId = await host.dispatch("expert", `E1-H ${"stable expert history ".repeat(2_000)}`);
        const expertOutcome = await host.outcome(expertId);
        expect(expertOutcome.status).toBe("completed");
        expect(expertOutcome.diag.childExtensionMissing).toBeUndefined();
        const expertBody = stub.requests.at(-1)!.json;
        const expertRecord = getPrefixProbeRegistry().get(expertId)!;
        const expertFile = expertOutcome.diag.sessionFile!;
        const expertBytes = readFileSync(expertFile, "utf8");
        const sourceSnapshot = scanExpertSnapshot(expertFile);
        expect(sourceSnapshot.ok).toBe(true);

        // Observe physical disposal without replacing it. The registry must not
        // expose this fork as a head either before or immediately after dispose;
        // only the later onReaped(disposed:true) + eligible join can promote it.
        const disposal: Array<{ file: string; before: boolean; after: boolean; returned: boolean }> = [];
        const originalResume = PiSessionDriver.prototype.resume;
        const sessions: Array<{ file: string; shadowNames: string[]; guardInstalled: boolean }> = [];
        vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async function (file, spec) {
          const handle = await originalResume.call(this, file, spec);
          if (spec.consultGuard) {
            const session = (
              handle as unknown as { session: Awaited<ReturnType<typeof createAgentSession>>["session"] }
            ).session;
            sessions.push({
              file,
              shadowNames: ["set_model", "Agent"].filter((name) => Object.isFrozen(session.getToolDefinition(name))),
              guardInstalled: typeof session.agent.beforeToolCall === "function",
            });
            const dispose = handle.dispose.bind(handle);
            handle.dispose = () => {
              const before = host.stack.consult!.threads.isHead(file);
              const report = dispose();
              disposal.push({
                file,
                before,
                after: host.stack.consult!.threads.isHead(file),
                returned: report.returned,
              });
              return report;
            };
          }
          return handle;
        });
        const reaps: Array<{ file: string; disposed: boolean | undefined }> = [];
        const onReaped = host.stack.consult!.onReaped;
        vi.spyOn(host.stack.consult!, "onReaped").mockImplementation((id, file, info) => {
          if (file) reaps.push({ file, disposed: info?.disposed });
          return onReaped(id, file, info);
        });
        const checkpoints: Array<{ turn: number; files: boolean[]; head?: string; entries?: unknown[] }> = [];
        onAskerRequest = (turn) => {
          if (turn < 2) return;
          const head = host.stack.consult!.threads.views()[0]?.headFile;
          checkpoints.push({
            turn,
            files: sessions.map(({ file }) => existsSync(file)),
            ...(head === undefined ? {} : { head, entries: SessionManager.open(head).getEntries() }),
          });
        };
        const askerId = await host.dispatch("asker", "E1-ASK consult the expert in order", [expertId]);
        await expect
          .poll(() => host.stack.query.get(askerId)?.diag.consults?.calls, { timeout: 30_000 })
          .toBe(oauth ? 2 : 3);
        await expect.poll(() => askerBodies.length, { timeout: 10_000 }).toBe(oauth ? 3 : 4);
        const asker = host.stack.query.get(askerId)!;
        const probes = asker.diag.consults!.cacheProbes!;
        expect(probes).toHaveLength(oauth ? 2 : 3);
        const runs = host.stack.query
          .list()
          .filter((run) => run.diag.consultOf !== undefined)
          .sort((a, b) => a.diag.consultThread!.seq - b.diag.consultThread!.seq);
        const byId = new Map(runs.map((run) => [run.runId, run]));
        const records = consultBodies.map((request) => {
          const found = runs.find(
            (run) =>
              getPrefixProbeRegistry().get(run.runId)?.first?.fieldHashes.messages ===
              sha(stripMessageMarkers(request.json.messages)),
          );
          if (!found) throw new Error("no production run probe for raw body");
          return { run: found, record: getPrefixProbeRegistry().get(found.runId)! };
        });
        expect(records).toHaveLength(oauth ? 2 : 3);
        expect(byId.size).toBe(records.length);
        const consultCost = records.reduce((sum, { run }) => sum + (run.diag.usage?.costUsd ?? 0), 0);
        expect(consultCost).toBeGreaterThan(0);
        expect(asker.diag.consults!.costUsd).toBeCloseTo(consultCost, 8);
        expect(asker.diag.usage!.costUsd).toBeGreaterThanOrEqual(consultCost);
        for (const [index, { run, record }] of records.entries()) {
          const body = consultBodies[index]!.json;
          assertDocumentedFields(body);
          // Anthropic SDK moves params.betas into the HTTP header (not JSON).
          const beta = consultBodies[index]!.headers["anthropic-beta"];
          assertProbeMatchesBody(record.first, {
            ...body,
            ...(typeof beta === "string" ? { betas: beta.split(",") } : {}),
          });
          expect(record.firstSuccessful).toBe(record.first);
          expect(record.first?.responseOk).toBe(true);
          const usage = consultBodies[index]!.responseUsage!;
          expect(record.first?.usage).toMatchObject({
            input: usage.input_tokens,
            output: usage.output_tokens,
            cacheRead: usage.cache_read_input_tokens,
            cacheWrite: usage.cache_creation_input_tokens,
          });
          expect(record.probeErrors ?? 0).toBe(0);
          const raw = comparePayloadPrefix(expertBody, body, record.first?.anchor);
          expect(compareRecordedPrefix(expertRecord.latest!, record.first!)).toEqual(raw);
          expect(raw).toMatchObject({ model: true, tools: true, system: true, thinking: true, messages: true });
          expect(run.status).toBe("completed");
          expect(run.diag.consultCache?.first?.anchor).toBe(record.first?.anchor?.state);
          expect(run.diag.consultCache?.first?.label).toBe("hit");
          expect(run.diag.consultCache?.first?.readShare).toBeCloseTo(
            record.first!.usage!.cacheRead /
              (record.first!.usage!.input + record.first!.usage!.cacheRead + record.first!.usage!.cacheWrite),
          );
          expect(run.diag.consultThread).toEqual({
            threadId: probes[index]!.thread!.id,
            seq: probes[index]!.thread!.seq,
          });
          expect(run.diag.consultCache?.predicted).toEqual(probes[index]!.warm);
          expect(run.diag.consultCache?.first).toMatchObject(probes[index]!.cacheResult!);
        }
        const first = records[0]!;
        const second = records[1]!;
        const anchor = first.record.first!.anchor!;
        expect(anchor.state).toBe(oauth ? "relocated" : "added");
        const identity = anchor.identity!;
        const control = { type: "ephemeral" };
        const firstLast = wireMessages(consultBodies[0]!.json).length - 1;
        expect(messageMarkers(consultBodies[0]!.json)).toEqual([
          { m: identity.k - 1, b: identity.block, control },
          ...(oauth
            ? []
            : [{ m: firstLast, b: wireMessages(consultBodies[0]!.json)[firstLast]!.content.length - 1, control }]),
        ]);
        expect(allMarkerCount(consultBodies[0]!.json)).toBe(4);
        expect(second.record.first?.anchor?.state).toBe(oauth ? "skipped:limit" : "added");
        const secondMessages = wireMessages(consultBodies[1]!.json);
        expect(stripMessageMarkers(secondMessages.slice(0, -2))).toEqual(
          stripMessageMarkers(wireMessages(consultBodies[0]!.json)),
        );
        expect(secondMessages.at(-2)).toEqual({ role: "assistant", content: [{ type: "text", text: fullAnswer }] });
        expect(lastUserText(consultBodies[1]!.json)).toContain("This is follow-up #2");
        expect(lastUserText(consultBodies[1]!.json)).toContain("\nQuestion:\nE1-Q2");
        expect(second.run.diag.consultThread).toEqual({ threadId: first.run.diag.consultThread!.threadId, seq: 2 });
        const secondLast = secondMessages.length - 1;
        expect(messageMarkers(consultBodies[1]!.json)).toEqual([
          ...(oauth ? [] : [{ m: identity.k - 1, b: identity.block, control }]),
          { m: secondLast, b: secondMessages[secondLast]!.content.length - 1, control },
        ]);
        // The caller saw a truncated answer, but the next fork saw every byte.
        const firstResult = JSON.stringify(askerBodies[1]!.json.messages);
        expect(firstResult).toContain("answer truncated at 500 chars");
        expect(firstResult).not.toContain("E1 mid retained sentinel");
        expect(firstResult).toContain("new consult thread");
        expect(JSON.stringify(askerBodies[2]!.json.messages)).toContain("previous 1 question(s)");
        expect(sessions).toHaveLength(records.length);
        expect(sessions.every((item) => item.guardInstalled)).toBe(true);
        expect(sessions.map((item) => item.shadowNames)).toEqual(records.map(() => ["set_model", "Agent"]));
        expect(disposal).toHaveLength(records.length);
        expect(disposal.every((item) => !item.before && !item.after && item.returned)).toBe(true);
        expect(reaps.map((item) => item.disposed)).toEqual(records.map(() => true));
        expect(host.stack.consult!.threads.stats().promotions).toBe(records.length);
        expect(checkpoints[0]).toMatchObject({ turn: 2, files: [true], head: first.run.diag.sessionFile });
        expect(checkpoints[1]).toMatchObject({ turn: 3, files: [false, true], head: second.run.diag.sessionFile });
        const originalEntries = SessionManager.open(expertFile).getEntries();
        const appended = checkpoints[0]!.entries!.slice(originalEntries.length) as Array<{
          type: string;
          customType?: string;
          message: { role: string; content: unknown };
        }>;
        expect(appended.map((entry) => [entry.type, entry.customType, entry.message?.role])).toEqual([
          ["custom", "subagent:prompt-sections", undefined],
          ["message", undefined, "user"],
          ["message", undefined, "assistant"],
        ]);
        expect(appended[2]!.message.content).toEqual([{ type: "text", text: fullAnswer }]);
        expect(existsSync(first.run.diag.sessionFile!)).toBe(false);
        const headFile = host.stack.consult!.threads.views()[0]!.headFile!;
        expect(existsSync(headFile)).toBe(true);
        const headSnapshot = scanExpertSnapshot(headFile);
        expect(headSnapshot.ok).toBe(true);
        if (!sourceSnapshot.ok || !headSnapshot.ok) throw new Error("production loadout snapshot missing");
        expect(headSnapshot.snapshot.tools).toEqual(sourceSnapshot.snapshot.tools);
        expect(headSnapshot.snapshot.systemSections).toEqual(sourceSnapshot.snapshot.systemSections);
        expect(readFileSync(expertFile, "utf8")).toBe(expertBytes);
        if (oauth) {
          expect(second.run.diag.consultCache?.predicted.state).toBe("unknown");
          expect(consultCacheMarkerOfDiag(first.run.diag)).toContain("degraded");
          expect(consultCacheMarkerOfDiag(second.run.diag)).toContain("degraded");
          expect(allMarkerCount(consultBodies[1]!.json)).toBe(4);
          expect(second.run.diag.consultCache?.predicted.reason).toBe("degraded-anchor");
        } else {
          expect(second.record.first?.anchor?.identity).toEqual(identity);
          expect(second.run.diag.consultCache?.predicted).toMatchObject({
            state: "warm",
            evidence: { source: "anchor-ledger", ttlMs: 300_000, lastProvenTouchAt: first.record.first!.startedAt },
          });
          expect(consultCacheMarkerOfDiag(second.run.diag)).toMatch(/^t#2 warm·hit \d+%$/);
          expect(host.stack.consult!.anchorLedger.size()).toBe(1);
          const fresh = records[2]!;
          expect(fresh.run.diag.consultThread?.seq).toBe(1);
          expect(fresh.run.diag.consultThread?.threadId).not.toBe(first.run.diag.consultThread!.threadId);
          expect(probes[2]!.thread?.mode).toBe("fresh");
          expect(lastUserText(consultBodies[2]!.json)).not.toContain("follow-up");
          expect(JSON.stringify(consultBodies[2]!.json)).not.toContain(fullAnswer);
          expect(stripMessageMarkers(wireMessages(consultBodies[2]!.json).slice(0, -1))).toEqual(
            stripMessageMarkers(wireMessages(consultBodies[0]!.json).slice(0, -1)),
          );
          expect(JSON.stringify(askerBodies[3]!.json.messages)).toContain("fresh consult (fresh:true)");
          expect(existsSync(second.run.diag.sessionFile!)).toBe(false);
        }
        // Production shutdown invokes close before abort/drain. Captured HTTP
        // replies remain pending, proving cleanup is not an asker-terminal side effect.
        await host.shutdown();
        release();
        expect(host.stack.consult!.threads.stats()).toMatchObject({ closed: true, heads: 0, forks: 0, usedBytes: 0 });
        expect(host.stack.consult!.threads.views()).toEqual([]);
        expect(host.stack.consult!.anchorLedger.size()).toBe(0);
        for (const { run } of records) expect(getConsultGuard(run.runId)).toBeUndefined();
        expect(readdirSync(join(host.agentDir, "cache", "consult-sessions"))).toEqual([]);
        expect(host.errors).toEqual([]);
      },
      60_000,
    );
  }

  it("C1 shape fallback: a real before_agent_start message makes the anchor skipped:shape, never an error", async () => {
    let consultBody: StubRequest | undefined;
    let askerTurn = 0;
    const stub = await AnthropicStub.start({
      promptCache: true,
      reply(request) {
        const text = lastUserText(request.json);
        const messages = JSON.stringify(request.json.messages);
        if (messages.includes("READ-ONLY CONSULT MODE") && messages.includes("E1-Q-shape")) {
          consultBody = request;
          return { kind: "text", text: "E1 shape consult answered normally" };
        }
        if (text.includes("E1-H")) return { kind: "text", text: "E1 expert history ready" };
        if (messages.includes("E1-ASK") && ++askerTurn === 1)
          return { kind: "tool", calls: [{ name: "consult", input: { expert: "e1-expert", question: "E1-Q-shape" } }] };
        return { kind: "text", text: "E1 finished" };
      },
    });
    stubs.push(stub);
    const host = await productionHost(stub, { inject: true });
    const expertId = await host.dispatch("expert", `E1-H ${"shape stable history ".repeat(1_000)}`);
    expect((await host.outcome(expertId)).status).toBe("completed");
    const expertBody = stub.requests.find((request) => lastUserText(request.json).includes("E1-H"))!.json;
    const askerId = await host.dispatch("asker", "E1-ASK one shape consult", [expertId]);
    const asker = await host.outcome(askerId);
    expect(asker.status).toBe("completed");
    expect(asker.diag.consults).toMatchObject({ calls: 1, byResult: { completed: 1 } });
    const consult = host.stack.query.list().find((run) => run.diag.consultOf !== undefined)!;
    expect(consult.status).toBe("completed");
    const record = getPrefixProbeRegistry().get(consult.runId)!;
    expect(record.first?.anchor).toEqual({ state: "skipped:shape" });
    expect(record.first?.responseOk).toBe(true);
    expect(record.probeErrors ?? 0).toBe(0);
    expect(consult.diag.consultCache?.first).toMatchObject({ anchor: "skipped:shape", label: "hit" });
    const body = consultBody!.json;
    expect(JSON.stringify(body.messages)).toContain("E1 injected before_agent_start message");
    const messages = wireMessages(body);
    expect(messageMarkers(body)).toEqual([
      { m: messages.length - 1, b: messages.at(-1)!.content.length - 1, control: { type: "ephemeral" } },
    ]);
    expect(allMarkerCount(body)).toBe(3);
    const comparison = comparePayloadPrefix(expertBody, body, record.first?.anchor);
    expect(comparison).toMatchObject({ model: true, tools: true, system: true, thinking: true, messages: true });
    expect(compareRecordedPrefix(getPrefixProbeRegistry().get(expertId)!.latest!, record.first!)).toEqual(comparison);
    assertProbeMatchesBody(record.first, body);
    expect(host.stack.consult!.anchorLedger.size()).toBe(0);
    await host.shutdown();
    expect(host.errors).toEqual([]);
  }, 45_000);

  it("C2 production supplement: the installed guard blocks builtin writes and adapter shadows without spawning", async () => {
    let marker = "";
    let askerTurn = 0;
    let consultTurn = 0;
    const stub = await AnthropicStub.start({
      promptCache: true,
      reply(request) {
        const text = lastUserText(request.json);
        const messages = JSON.stringify(request.json.messages);
        if (messages.includes("READ-ONLY CONSULT MODE") && messages.includes("E1-Q-guard")) {
          if (++consultTurn === 1)
            return {
              kind: "tool",
              calls: [
                { name: "write", input: { path: marker, content: "must not be written" } },
                {
                  name: "Agent",
                  input: {
                    subagent_type: "e1-expert",
                    description: "forbidden spawn",
                    prompt: "forbidden nested spawn",
                  },
                },
                { name: "set_model", input: { model: "anthropic-stub/claude-conformance" } },
              ],
            };
          return { kind: "text", text: "E1 answered after one refused batch" };
        }
        if (text.includes("E1-H")) return { kind: "text", text: "E1 expert ready" };
        if (messages.includes("E1-ASK") && ++askerTurn === 1)
          return { kind: "tool", calls: [{ name: "consult", input: { expert: "e1-expert", question: "E1-Q-guard" } }] };
        return { kind: "text", text: "E1 done" };
      },
    });
    stubs.push(stub);
    const host = await productionHost(stub);
    marker = join(host.cwd, "forbidden-write.txt");
    const expertId = await host.dispatch("expert", "E1-H guard expert");
    expect((await host.outcome(expertId)).status).toBe("completed");
    const askerId = await host.dispatch("asker", "E1-ASK guard consult", [expertId]);
    const asker = await host.outcome(askerId);
    expect(asker.status).toBe("completed");
    expect(consultTurn).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(host.stack.query.list()).toHaveLength(3); // expert + asker + consult, never a nested Agent run
    const probe = asker.diag.consults!.cacheProbes![0]!;
    expect(probe.outcome).toBe("completed");
    expect(probe.blocked).toMatchObject({ calls: 3, batches: 1, terminated: false });
    const consult = host.stack.query.list().find((run) => run.diag.consultOf !== undefined)!;
    const record = getPrefixProbeRegistry().get(consult.runId)!;
    expect(record.requests?.map((request) => request.anchor?.state)).toEqual(["added", "added"]);
    const requests = stub.requests.filter((request) =>
      JSON.stringify(request.json.messages).includes("READ-ONLY CONSULT MODE"),
    );
    const results = wireMessages(requests[1]!.json).at(-1)!.content;
    expect(results).toHaveLength(3);
    expect(
      results.every(
        (block) =>
          block.type === "tool_result" &&
          block.is_error === true &&
          String(block.content).includes("disabled in this read-only consult"),
      ),
    ).toBe(true);
    expect(consult.diag.consultCache?.first?.at).toBeDefined();
    await host.shutdown();
    expect(host.errors).toEqual([]);
  }, 45_000);

  for (const oauth of [false, true])
    it(`C14: ordinary create and resume preserve native payload references/bytes and last-only breakpoints (OAuth=${oauth})`, async () => {
      const stub = await AnthropicStub.start({ reply: () => ({ kind: "text", text: "E1 ordinary response" }) });
      stubs.push(stub);
      const host = await productionHost(stub, { oauth });
      const observed: Array<{ kind: string; same: boolean; before: string; after: string }> = [];
      const observe = (handle: SessionHandle, kind: string) => {
        const session = (handle as unknown as { session: Awaited<ReturnType<typeof createAgentSession>>["session"] })
          .session;
        const original = session.agent.onPayload!;
        session.agent.onPayload = async (payload, selectedModel) => {
          const before = JSON.stringify(payload);
          const returned = await original(payload, selectedModel);
          const effective = returned ?? payload;
          observed.push({ kind, same: payload === effective, before, after: JSON.stringify(effective) });
          return returned;
        };
        return handle;
      };
      const create = PiSessionDriver.prototype.create;
      const resume = PiSessionDriver.prototype.resume;
      vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation(async function (spec) {
        return observe(await create.call(this, spec), "create");
      });
      vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async function (file, spec) {
        return observe(await resume.call(this, file, spec), "resume");
      });
      const firstId = await host.dispatch("expert", "E1 ordinary first");
      const first = await host.outcome(firstId);
      expect(first.status).toBe("completed");
      await expect.poll(() => isLiveSessionFile(first.diag.sessionFile!), { timeout: 10_000 }).toBe(false);
      const secondId = await host.dispatch("expert", "E1 ordinary resumed", undefined, firstId);
      const second = await host.outcome(secondId);
      expect(second.status).toBe("completed");
      expect(observed.map((value) => value.kind)).toEqual(["create", "resume"]);
      for (const [index, value] of observed.entries()) {
        expect(value.same).toBe(true);
        expect(value.after).toBe(value.before);
        const native = JSON.parse(value.before) as Record<string, unknown>;
        // SDK projects betas into a header after onPayload. Every other byte
        // reaches the local HTTP boundary untouched by toolkit instrumentation.
        const { betas, ...httpBody } = native;
        const wire = stub.requests.find((request) => JSON.stringify(request.json) === JSON.stringify(httpBody));
        expect(wire).toBeDefined();
        expect(wire!.body).toBe(JSON.stringify(httpBody));
        if (betas !== undefined) expect(wire!.headers["anthropic-beta"]).toBe((betas as string[]).join(","));
        const messages = wireMessages(native);
        expect(messageMarkers(native)).toEqual([
          { m: messages.length - 1, b: messages.at(-1)!.content.length - 1, control: { type: "ephemeral" } },
        ]);
        expect(allMarkerCount(native)).toBe(oauth ? 4 : 3);
        const run = index === 0 ? first : second;
        expect(run.diag).not.toHaveProperty("consultCache");
        expect(run.diag).not.toHaveProperty("consultThread");
        expect(getPrefixProbeRegistry().get(run.runId)?.anchor).toBeUndefined();
      }
      await host.shutdown();
      expect(host.errors).toEqual([]);
    }, 45_000);
});
