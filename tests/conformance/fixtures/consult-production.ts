import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vi, expect } from "vitest";
import {
  createAgentSession,
  initTheme,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Stack } from "../../../src/stack.js";
import type { RunOutcome } from "../../../src/core/types.js";
import type { AgentToolDetails } from "../../../src/tools/agent-tool.js";
import type { AnthropicStub } from "./anthropic-stub.js";

/** Real activate -> session_start -> buildSessionStack. The caller's stack
 * observer is call-through only: no service, hook, tool or driver is replaced.
 * Children discover the package from settings.json, not inherited factories.
 */
export async function productionConsultHost(
  stub: AnthropicStub,
  activate: (pi: ExtensionAPI) => void,
  stackOf: () => Stack,
  options: { oauth?: boolean; inject?: boolean } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "consult-production-"));
  const home = join(cwd, "home");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  // All traffic goes to the local stub. Disable background/model-using modules.
  writeFileSync(
    join(agentDir, "pi-subagent.json"),
    JSON.stringify({
      rememberAgents: true,
      fleetWidget: false,
      webSearch: { enabled: false },
      todo: { enabled: false },
      memory: { enabled: false },
      date: { enabled: false },
      hud: { enabled: false },
      feishuNotify: { enabled: false },
      askUser: { enabled: false },
      sessionNav: { enabled: false },
      title: { enabled: false },
      topicSwitch: { enabled: false },
      quota: { enabled: false },
      load: { enabled: false },
      workflow: { enabled: false },
      fabric: { enabled: false },
      bashJobs: { autoBackgroundS: 0 },
      compact: { childSessions: false, hintPercent: 0, dynamicThreshold: { mode: "off" } },
      cacheTtl: { mode: "off", keepalive: false, childKeepalive: false },
      consult: { enabled: true, timeoutS: 30, maxAnswerChars: 500, maxTurns: 8, maxFirstRequestUsd: 0, maxCostUsd: 0 },
    }),
  );
  const injection = join(cwd, "injection.ts");
  if (options.inject)
    writeFileSync(
      injection,
      `export default function(pi) { pi.on("before_agent_start", (event) => event.prompt.startsWith("READ-ONLY CONSULT MODE\\n") ? { message: { customType: "e1-shape", content: "E1 injected before_agent_start message", display: false } } : undefined); }`,
    );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [resolve("index.ts"), ...(options.inject ? [injection] : [])],
      packages: [],
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarmer: { enabled: false },
    }),
  );
  const selected = {
    id: "claude-conformance",
    name: "Claude conformance",
    api: "anthropic-messages" as const,
    provider: "anthropic-stub",
    baseUrl: `${stub.baseUrl}/v1`,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [selected.provider]: {
          baseUrl: selected.baseUrl,
          api: selected.api,
          apiKey: options.oauth ? "sk-ant-oat-e1-local-stub" : "e1-local-stub-key",
          models: [selected],
        },
      },
    }),
  );
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  for (const name of ["expert", "asker"])
    writeFileSync(
      join(agentDir, "agents", `e1-${name}.md`),
      `---\nname: e1-${name}\ndescription: E1 ${name}\ntools: read, write, bash, set_model, Agent, consult\ncan_spawn: e1-expert\n---\nE1 production conformance ${name}.\n`,
    );
  initTheme("dark", false);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  // Main uses the actual exported activate factory so the call-through observer
  // can read its stack. Children use the settings-discovered jiti entry above.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [activate],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const manager = SessionManager.create(cwd, join(cwd, "host-sessions"));
  const { session } = await createAgentSession({
    cwd,
    model: selected,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
  const stack = stackOf();
  expect(stack.consult).toBeDefined();
  const dispatch = async (type: "expert" | "asker", prompt: string, experts?: string[], resume?: string) => {
    const tool = session.getToolDefinition("Agent");
    if (!tool) throw new Error("production activate did not register Agent");
    const result = await tool.execute(
      "e1-dispatch",
      {
        subagent_type: `e1-${type}`,
        description: `e1-${type}`,
        prompt,
        model: `${selected.provider}/${selected.id}`,
        ...(experts ? { experts } : {}),
        ...(resume ? { resume } : {}),
      },
      undefined,
      undefined,
      {} as never,
    );
    const details = result.details as AgentToolDetails;
    if (!details.runId) throw new Error(`Agent dispatch refused: ${JSON.stringify(result)}`);
    return details.runId;
  };
  const outcome = async (runId: string): Promise<RunOutcome> => {
    const result = await stack.spawn.waitOutcome(runId, 30_000);
    if (result.kind !== "settled")
      throw new Error(`run did not settle in 30s: ${JSON.stringify(stack.query.get(runId))}`);
    return result.outcome;
  };
  let shut = false;
  const shutdown = async () => {
    if (shut) return;
    shut = true;
    // pi's runtime emits this before dispose. Use the actual bound runner,
    // never a hand-built handler list, then dispose the actual session.
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  };
  return { cwd, agentDir, session, manager, stack, dispatch, outcome, shutdown, errors };
}

export function wireMessages(body: Record<string, unknown>) {
  return body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
}

export function lastUserText(body: Record<string, unknown>): string {
  const message = wireMessages(body).findLast((message) => message.role === "user");
  return (message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function messageMarkers(body: Record<string, unknown>) {
  return wireMessages(body).flatMap((message, m) =>
    message.content.flatMap((block, b) =>
      block.cache_control === undefined ? [] : [{ m, b, control: block.cache_control }],
    ),
  );
}

export function allMarkerCount(body: Record<string, unknown>) {
  return (
    messageMarkers(body).length +
    [
      ...((body.tools as Array<Record<string, unknown>>) ?? []),
      ...((body.system as Array<Record<string, unknown>>) ?? []),
    ].filter((block) => block.cache_control !== undefined).length
  );
}

export function stripMessageMarkers<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === "cache_control" ? undefined : v))) as T;
}
