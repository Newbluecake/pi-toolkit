/**
 * result-tool rename (get_subagent_result → get_run_result) — conformance R1–R8
 * (docs/dev/result-tool-rename/plan.md §7.3 + r3).
 *
 * REAL pi `createAgentSession` + the REAL toolkit `activate()` (extensionFactories) + a scripted fake
 * model. Nothing here is a stub of pi's tool-restore behaviour: the premise tests (R1) pin what pi
 * actually does so a pi change surfaces here first.
 *
 *  R1  premise: pi 1.3 resume restored the transcript's tool declarations ⇒ the new tool was registered
 *      but NOT active without the toolkit migration. pi 1.4 (#11062/#11075) activates extension tools the
 *      branch never added/removed, so on 1.4 the new tool is active natively; the migration is then a no-op
 *      and stays only as the fallback for pi 1.0–1.3 (the peer range still allows them). R1 pins the 1.4 fact.
 *  R2  resume with the toolkit ⇒ new name active, request declares it (not the legacy one), history intact.
 *  R3  fork ⇒ same.
 *  R4  `/tree` back to the pre-rename node ⇒ session_tree re-activates it.
 *  R5  user choices survive: transcript without the legacy name stays disabled; `--tools -get_run_result`
 *      (modifier argv) and `--exclude-tools` never re-enable it; no modifier ⇒ activates (R2).
 *  R6  `/reload` keeps it active (pi's own behaviour; migration is a no-op).
 *  R7  a model calling the legacy name gets pi's immediate `not found`, and NO tool_call / tool_result
 *      hook sees it (pins the hook boundary: if pi starts firing hooks, a redirect becomes possible).
 *  R8  history renderer wiring: the legacy name resolves to the current tool's cards; every other name
 *      falls through to `next()`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import activate from "../../src/index.js";
import { LEGACY_RESULT_TOOL_NAME, RESULT_TOOL_NAME } from "../../src/core/tool-names.js";
import {
  assistantTextMsg,
  assistantToolCallMsg,
  fakeModel,
  fakeModelRuntime,
  type ScriptedTurn,
} from "./agent-session-harness.js";

const HOST_KEYS = [
  Symbol.for("pi-subagent:host"),
  Symbol.for("pi-subagent:feishu-notify:host"),
  Symbol.for("pi-subagent:background-status"),
];
const releaseHost = () => {
  for (const key of HOST_KEYS) delete (globalThis as Record<symbol, unknown>)[key];
};

const LEGACY = LEGACY_RESULT_TOOL_NAME;
const NEW = RESULT_TOOL_NAME;

let home = "";
let realHome: string | undefined;
let realArgv: string[] = [];
let root = "";
const opened: AgentSession[] = [];

beforeEach(() => {
  releaseHost();
  root = mkdtempSync(join(tmpdir(), "pi-result-rename-"));
  home = join(root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  // The toolkit must stay quiet and offline: no widget, no quota probing, no web hub.
  writeFileSync(
    join(home, ".pi", "agent", "pi-subagent.json"),
    JSON.stringify({ fleetWidget: false, quota: { enabled: false } }),
  );
  realHome = process.env.HOME;
  process.env.HOME = home;
  // The migration reads process.argv (any --tools/-t would disable it); vitest's own `-t` must not leak in.
  realArgv = process.argv;
  process.argv = ["node", "pi"];
});
afterEach(() => {
  for (const session of opened.splice(0)) session.dispose();
  releaseHost();
  process.argv = realArgv;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(root, { recursive: true, force: true });
});

const textTool = (name: string) => (pi: ExtensionAPI) => {
  pi.registerTool({
    name,
    label: name,
    description: `stub ${name}`,
    parameters: Type.Object({ run_id: Type.String() }),
    execute: async () => ({ content: [{ type: "text" as const, text: "stub result" }], details: {} }),
  } as never);
};

const sessionsDir = () => join(root, "sessions");
const agentDir = () => join(root, "agent");
const cwd = () => join(root, "work");

async function openSession(o: {
  factories: unknown[];
  manager: SessionManager;
  scripted?: ScriptedTurn[];
  tools?: string[];
  excludeTools?: string[];
}) {
  mkdirSync(cwd(), { recursive: true });
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(
    model,
    o.scripted ?? [{ toolCall: false, build: (m) => assistantTextMsg(m, "ok") }],
  );
  const settingsManager = SettingsManager.create(cwd(), agentDir());
  const loader = new DefaultResourceLoader({
    cwd: cwd(),
    agentDir: agentDir(),
    settingsManager,
    extensionFactories: o.factories as never,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: cwd(),
    model: model as never,
    modelRuntime: modelRuntime as never,
    sessionManager: o.manager,
    settingsManager,
    resourceLoader: loader,
    ...(o.tools !== undefined ? { tools: o.tools } : {}),
    ...(o.excludeTools !== undefined ? { excludeTools: o.excludeTools } : {}),
  } as never);
  opened.push(session);
  await session.bindExtensions({});
  return { session, modelRuntime };
}

/** Seed: a session recorded under the OLD name — the model calls get_subagent_result once. Returns the file + final leaf. */
async function seedLegacySession() {
  const { session } = await openSession({
    factories: [textTool(LEGACY)],
    manager: SessionManager.create(cwd(), sessionsDir()),
    tools: ["bash", LEGACY],
    scripted: [
      { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc_seed", LEGACY, { run_id: "r_seed" }) },
      { toolCall: false, build: (m) => assistantTextMsg(m, "seed done") },
    ],
  });
  await session.prompt("seed");
  await session.agent.waitForIdle?.();
  const file = session.sessionFile as string;
  const leaf = session.sessionManager.getLeafId() as string;
  const declared = getCurrentTools(session.sessionManager.buildSessionProjection().messages).map((t) => t.name);
  expect(declared, "seed transcript must declare the legacy tool").toContain(LEGACY);
  session.dispose();
  opened.splice(opened.indexOf(session), 1);
  return { file, leaf };
}

const declaredNames = (session: AgentSession) =>
  getCurrentTools(session.sessionManager.buildSessionProjection().messages).map((t) => t.name);

/** Tool names declared on the FIRST model request after `prompt()` + the historic toolCall names in it. */
async function firstRequest(session: AgentSession, modelRuntime: ReturnType<typeof fakeModelRuntime>) {
  await session.prompt("next");
  await session.agent.waitForIdle?.();
  const messages = modelRuntime.requestMessages[0] as Array<{ role: string; content?: unknown }>;
  const declared = getCurrentTools(messages as never).map((t) => t.name);
  const historicCalls = messages
    .filter((m) => m.role === "assistant" && Array.isArray(m.content))
    .flatMap((m) => (m.content as Array<{ type: string; name?: string }>).filter((c) => c.type === "toolCall"))
    .map((c) => c.name);
  return { declared, historicCalls };
}

describe("result-tool rename conformance (real createAgentSession × real activate)", () => {
  it("R1 premise (pi ≥1.4): resume activates extension tools the branch never mentioned — the new tool is active even without the migration", async () => {
    const { file } = await seedLegacySession();
    const { session } = await openSession({
      factories: [textTool(NEW)],
      manager: SessionManager.open(file, sessionsDir()),
    });
    expect(session.getAllTools().map((t) => t.name)).toContain(NEW);
    // pi 1.3 asserted `.not.toContain(NEW)` here (the reason the migration exists).
    expect(session.getActiveToolNames()).toContain(NEW);
  });

  it("R2 resume with the toolkit: new name active, request declares it (not the legacy one), history keeps the old call", async () => {
    const { file } = await seedLegacySession();
    const { session, modelRuntime } = await openSession({
      factories: [activate],
      manager: SessionManager.open(file, sessionsDir()),
    });
    expect(session.getActiveToolNames()).toContain(NEW);
    expect(session.getActiveToolNames()).not.toContain(LEGACY);
    const { declared, historicCalls } = await firstRequest(session, modelRuntime);
    expect(declared).toContain(NEW);
    expect(declared).not.toContain(LEGACY);
    expect(historicCalls).toContain(LEGACY);
  });

  it("R3 fork of the seed session: same activation", async () => {
    const { file } = await seedLegacySession();
    const forked = SessionManager.forkFrom(file, cwd(), sessionsDir());
    const { session, modelRuntime } = await openSession({ factories: [activate], manager: forked });
    expect(session.getActiveToolNames()).toContain(NEW);
    const { declared, historicCalls } = await firstRequest(session, modelRuntime);
    expect(declared).toContain(NEW);
    expect(declared).not.toContain(LEGACY);
    expect(historicCalls).toContain(LEGACY);
  });

  it("R4 /tree back to the pre-rename node re-activates the new name via session_tree", async () => {
    const { file, leaf } = await seedLegacySession();
    const { session, modelRuntime } = await openSession({
      factories: [activate],
      manager: SessionManager.open(file, sessionsDir()),
    });
    await firstRequest(session, modelRuntime); // a turn under the new name lands in the transcript
    expect(session.getActiveToolNames()).toContain(NEW);
    // Park on the new-name branch first so the navigation really restores from the OLD node.
    const result = await session.navigateTree(leaf, {});
    expect(result.cancelled).toBe(false);
    expect(declaredNames(session)).toContain(LEGACY);
    expect(declaredNames(session)).not.toContain(NEW);
    expect(session.getActiveToolNames()).toContain(NEW);
  });

  it("R5a a user who disabled the new tool (transcript never declared the legacy name) keeps it disabled across resume", async () => {
    // Fresh session under the toolkit. One turn with the tool active records it in the transcript; then
    // the user disables it and a second turn records the removal. (pi ≥1.4 re-activates a tool the branch
    // never mentioned at all, so "disabled before the first turn" no longer survives a resume — that is
    // pi's behaviour, not the migration's; see docs/dev/toolchain/pi-1.4-report.md.)
    const first = await openSession({
      factories: [activate],
      manager: SessionManager.create(cwd(), sessionsDir()),
      scripted: [
        { toolCall: false, build: (m) => assistantTextMsg(m, "ok") },
        { toolCall: false, build: (m) => assistantTextMsg(m, "ok2") },
      ],
    });
    expect(first.session.getActiveToolNames()).toContain(NEW);
    await first.session.prompt("hello");
    await first.session.agent.waitForIdle?.();
    first.session.setActiveToolsByName(first.session.getActiveToolNames().filter((n) => n !== NEW));
    await first.session.prompt("hi");
    await first.session.agent.waitForIdle?.();
    const file = first.session.sessionFile as string;
    expect(declaredNames(first.session)).not.toContain(LEGACY);
    first.session.dispose();
    opened.splice(opened.indexOf(first.session), 1);
    releaseHost();
    const { session } = await openSession({
      factories: [activate],
      manager: SessionManager.open(file, sessionsDir()),
    });
    expect(session.getAllTools().map((t) => t.name)).toContain(NEW);
    expect(session.getActiveToolNames()).not.toContain(NEW);
  });

  it("R5b `--tools -get_run_result` (modifier argv) is never overridden; without modifiers the same resume activates", async () => {
    const { file } = await seedLegacySession();
    process.argv = ["node", "pi", "--tools", `-${NEW}`];
    const blocked = await openSession({
      factories: [activate],
      manager: SessionManager.open(file, sessionsDir()),
      tools: [`-${NEW}`],
    });
    expect(blocked.session.getActiveToolNames()).not.toContain(NEW);
    blocked.session.dispose();
    opened.splice(opened.indexOf(blocked.session), 1);
    releaseHost();
    // Control: identical resume, no modifier argv ⇒ activated.
    process.argv = ["node", "pi"];
    const free = await openSession({
      factories: [activate],
      manager: SessionManager.open(file, sessionsDir()),
    });
    expect(free.session.getActiveToolNames()).toContain(NEW);
  });

  it("R5c `--exclude-tools get_run_result` ⇒ not registered, never activated (even if argv were unreadable)", async () => {
    const { file } = await seedLegacySession();
    const { session } = await openSession({
      factories: [activate],
      manager: SessionManager.open(file, sessionsDir()),
      excludeTools: [NEW],
    });
    expect(session.getAllTools().map((t) => t.name)).not.toContain(NEW);
    expect(session.getActiveToolNames()).not.toContain(NEW);
  });

  it("R6 /reload keeps the new name active (pi's own behaviour; the migration has nothing to do)", async () => {
    const { file } = await seedLegacySession();
    const { session } = await openSession({
      factories: [activate],
      manager: SessionManager.open(file, sessionsDir()),
    });
    expect(session.getActiveToolNames()).toContain(NEW);
    releaseHost(); // the reload re-activates in the same process (I4)
    await session.reload();
    expect(session.getActiveToolNames()).toContain(NEW);
  });

  it("R7 a call to the legacy name is pi's immediate `not found`; no tool_call/tool_result hook sees it", async () => {
    const seen: string[] = [];
    const probe = (pi: ExtensionAPI) => {
      pi.on("tool_call", (e) => {
        seen.push(`call:${(e as { toolName: string }).toolName}`);
      });
      pi.on("tool_result", (e) => {
        seen.push(`result:${(e as { toolName: string }).toolName}`);
      });
    };
    const { session } = await openSession({
      factories: [activate, probe],
      manager: SessionManager.create(cwd(), sessionsDir()),
      scripted: [
        { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc_legacy", LEGACY, { run_id: "r_x" }) },
        { toolCall: false, build: (m) => assistantTextMsg(m, "after") },
      ],
    });
    await session.prompt("go");
    await session.agent.waitForIdle?.();
    const result = session.messages.find(
      (m) =>
        (m as { role: string; toolName?: string }).role === "toolResult" &&
        (m as { toolName?: string }).toolName === LEGACY,
    ) as { isError?: boolean; content: Array<{ type: string; text?: string }> } | undefined;
    expect(result, "a toolResult for the legacy call").toBeDefined();
    expect(result!.isError).toBe(true);
    expect(result!.content.map((c) => c.text ?? "").join("")).toBe(`Tool ${LEGACY} not found`);
    expect(seen.filter((s) => s.endsWith(`:${LEGACY}`))).toEqual([]);
  });

  it("R8 history renderer: the legacy name draws the current tool's cards; other names fall through to next()", async () => {
    const { session } = await openSession({
      factories: [activate],
      manager: SessionManager.create(cwd(), sessionsDir()),
    });
    const runner = session.extensionRunner;
    const current = session.getToolDefinition(NEW);
    expect(current?.renderCall).toBeTypeOf("function");
    const sentinel = { renderCall: () => undefined } as never;
    const legacy = runner.resolveToolRenderers(LEGACY, () => undefined);
    expect(legacy?.renderCall).toBe(current?.renderCall);
    expect(legacy?.renderResult).toBe(current?.renderResult);
    expect(runner.resolveToolRenderers(NEW, () => sentinel)).toBe(sentinel);
    expect(runner.resolveToolRenderers("bash", () => sentinel)).toBe(sentinel);
  });
});
