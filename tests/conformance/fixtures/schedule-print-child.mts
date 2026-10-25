/**
 * C-S6 child (scheduled-reports I1): the REAL extension (`src/index.ts`, schedule enabled) bound to a real pi
 * AgentSession in `print` mode against the local Anthropic stub. It must finish by ITSELF — no `process.exit`,
 * no ref'd timer left behind by the schedule feature (plan r3 §3.3: print/json never arm and must be able to exit).
 */
import { mkdirSync } from "node:fs";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import activate from "../../../src/index.ts";

const dir = process.env.CHILD_DIR!;
const agentDir = `${dir}/agent`;
mkdirSync(agentDir, { recursive: true });
const model: any = {
  id: "m",
  name: "m",
  provider: "p",
  api: "anthropic-messages",
  baseUrl: `${process.env.STUB_URL}/v1`,
  reasoning: false,
  input: ["text"],
  contextWindow: 100000,
  maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const settings = SettingsManager.create(dir, agentDir);
const loader = new DefaultResourceLoader({
  cwd: dir,
  agentDir,
  settingsManager: settings,
  noExtensions: true,
  extensionFactories: [activate as never],
});
await loader.reload();
const manager = SessionManager.create(dir, `${dir}/sessions`);
const { session } = await createAgentSession({
  cwd: dir,
  sessionManager: manager,
  model,
  modelRuntime: {
    streamSimple: (m: any, c: any, o: any) => streamSimple(m, c, { ...o, apiKey: "x" }),
    getModel: () => model,
    checkAuth: async () => ({ ok: true }),
    hasConfiguredAuth: () => true,
    getAuth: async () => ({ apiKey: "x" }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
  } as never,
  settingsManager: settings,
  resourceLoader: loader,
});
await session.bindExtensions({ mode: "print", onError: (e: unknown) => console.error("EXT_ERR", e) } as never);
await session.prompt("hello");
await session.abort();
session.dispose();
console.log("DONE");
// the event loop must drain on its own
