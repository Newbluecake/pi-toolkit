import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  installNestedCallBlock,
  NESTED_TOOL_CALL_REASON,
} from "../../src/consult/preserve-guard.js";
import { buildConsultPrompt } from "../../src/consult/prompt.js";
import { compareRecordedPrefix, getPrefixProbeRegistry, installPrefixProbe } from "../../src/consult/prefix-probe.js";
import { createPermissiveGuard } from "./fixtures/permissive-guard.js";
import { AnthropicStub, type StubReply, type StubRequest } from "./fixtures/anthropic-stub.js";

const scratchDirs: string[] = [];
const stubs: AnthropicStub[] = [];

afterEach(async () => {
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

describe("consult preserve conformance — real pi 1.0.2 + Anthropic Messages boundary", () => {
  it("C1: compares the raw expert-last and consult-first provider prefixes", async () => {
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
