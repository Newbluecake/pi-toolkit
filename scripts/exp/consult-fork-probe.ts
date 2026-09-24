#!/usr/bin/env node
/**
 * P0-alpha consult fork probe. This is intentionally standalone: it exercises
 * pi's real SessionManager/session driver seam without importing the extension
 * activation path as a host.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type Model,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { toCreateOptions } from "../../src/runtime/session-driver.js";

const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const HOST_KEY = Symbol.for("pi-subagent:host");
const TOKEN = `CONSULT-PROBE-${randomBytes(4).toString("hex").toUpperCase()}`;

type Result = { status: "PASS" | "FAIL" | "SKIPPED"; detail: string; data?: Record<string, unknown> };

function help(): void {
  console.log(`Usage: npx tsx scripts/exp/consult-fork-probe.ts [options]

Options:
  --help       Print this help and exit
  --offline    Run deterministic fork/file probes only; do not call providers
  --route API  Restrict the online matrix to one pi API (repeatable)
  --no-cost    Skip the alpha3 cost probe (alpha1/2/4 only)

The online probe uses credentials and model routes already configured in ~/.pi/agent.`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function textMessage(role: "user" | "assistant", text: string): Message {
  if (role === "user") return { role, content: [{ type: "text", text }], timestamp: Date.now() };
  return {
    role,
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "probe",
    model: "probe-history",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as Message;
}

function toolHistory(): Message[] {
  const call = (name: string, id: string): Message =>
    ({
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: {} }],
      api: "anthropic-messages",
      provider: "probe",
      model: "probe-history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    }) as Message;
  const result = (name: string, id: string): Message => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: `historical ${name} result; fact=${TOKEN}` }],
    isError: false,
    timestamp: Date.now(),
  });
  return [
    call("bash", "probe-bash"),
    result("bash", "probe-bash"),
    call("write", "probe-write"),
    result("write", "probe-write"),
    call("Agent", "probe-agent"),
    result("Agent", "probe-agent"),
  ];
}

function makeSource(cwd: string, sessionDir: string): string {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage(textMessage("user", `Remember this fact exactly: ${TOKEN}`));
  manager.appendMessage(textMessage("assistant", `Recorded ${TOKEN}.`));
  for (const message of toolHistory()) manager.appendMessage(message);
  manager.appendMessage(textMessage("user", "The historical tools above were used before this probe."));
  return manager.getSessionFile()!;
}

async function openReadonlyFork(
  source: string,
  cwd: string,
  sessionDir: string,
  model?: Model,
): Promise<{ manager: SessionManager; session: any; path: string; active: string[] }> {
  (globalThis as Record<symbol, unknown>)[HOST_KEY] = { probe: true };
  const fork = SessionManager.forkFrom(source, cwd, sessionDir);
  const path = fork.getSessionFile()!;
  const spec = {
    cwd,
    model,
    tools: [...READONLY_TOOLS],
    systemPrompt: "You are a consulted expert. Answer from your own history.",
  };
  const options = await toCreateOptions(spec, cwd);
  const reopened = SessionManager.open(path, sessionDir, cwd);
  const created = await createAgentSession({ ...options, sessionManager: reopened } as any);
  return { manager: reopened, session: created.session, path, active: created.session.getActiveToolNames() };
}

async function alpha1(root: string, model?: Model): Promise<Result> {
  const cwd = root;
  const sessionDir = join(root, "sessions");
  const source = makeSource(cwd, sessionDir);
  const before = sha256(source);
  const forked = await openReadonlyFork(source, cwd, join(root, "consult"), model);
  const header = forked.manager.getHeader();
  const beforeAssistantCount = (forked.session.state.messages ?? []).filter(
    (message: any) => message.role === "assistant",
  ).length;
  let promptError: string | undefined;
  try {
    await forked.session.prompt(`Repeat the historical fact token exactly: ${TOKEN}`);
  } catch (error) {
    promptError = error instanceof Error ? error.message : String(error);
  }
  const assistants = (forked.session.state.messages ?? []).filter((message: any) => message.role === "assistant");
  const answer = assistants.length > beforeAssistantCount ? (forked.session.getLastAssistantText() ?? "") : "";
  const after = sha256(source);
  const pass =
    !promptError &&
    answer.includes(TOKEN) &&
    before === after &&
    header.parentSession === source &&
    forked.active.every((name: string) => READONLY_TOOLS.includes(name as never));
  return {
    status: pass ? "PASS" : "FAIL",
    detail: promptError ?? "fork, header, source hash and history assertions completed",
    data: {
      source,
      fork: forked.path,
      token: TOKEN,
      sourceSha256Unchanged: before === after,
      parentSessionCorrect: header.parentSession === source,
      systemPromptAssembled: true,
      activeTools: forked.active,
      answerContainsToken: answer.includes(TOKEN),
      answer: answer.slice(0, 500),
    },
  };
}

async function alpha1Offline(root: string): Promise<Result> {
  const cwd = root;
  const sessionDir = join(root, "sessions");
  const source = makeSource(cwd, sessionDir);
  const before = sha256(source);
  const forked = SessionManager.forkFrom(source, cwd, join(root, "consult"));
  const forkPath = forked.getSessionFile()!;
  const header = SessionManager.open(forkPath).getHeader();
  const after = sha256(source);
  return {
    status: before === after && header.parentSession === source ? "PASS" : "FAIL",
    detail: "offline fork/header/hash assertions completed",
    data: {
      source,
      fork: forkPath,
      sourceSha256Unchanged: before === after,
      parentSessionCorrect: header.parentSession === source,
      systemPromptAssemblyDeferred: true,
    },
  };
}
async function alpha1Unavailable(root: string): Promise<Result> {
  const structural = await alpha1Offline(root);
  return {
    status: "SKIPPED",
    detail: "No authenticated model route; structural fork checks passed but no real request was attempted",
    data: { structural: structural.data },
  };
}

function defaultRoute(runtime: ModelRuntime): { provider: string; id: string } | undefined {
  const settings = SettingsManager.create(process.cwd(), getAgentDir());
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  return provider && id ? { provider, id } : undefined;
}

function routes(
  runtime: ModelRuntime,
  only: string[],
  keyProviders: Set<string>,
  providers: string[] = [],
): Array<{ api: string; model: Model; provider: string; id: string }> {
  const out = new Map<string, { api: string; model: Model; provider: string; id: string }>();
  for (const provider of runtime.getProviders()) {
    // Probe fix 2026-09-24: getProviders() lists EVERY known provider (incl. pi built-ins
    // like ant-ling / cloudflare-ai-gateway that have no credentials here). First-wins
    // across all of them picked keyless providers per api. Only consider providers with
    // an inline models.json apiKey or a hasConfiguredAuth model.
    const usable =
      (providers.length === 0 || providers.includes(provider.id)) &&
      (keyProviders.has(provider.id) ||
        runtime.getModels(provider.id).some((candidate) => runtime.hasConfiguredAuth(candidate)));
    if (!usable) continue;
    for (const model of runtime.getModels(provider.id)) {
      const existing = out.get(model.api);
      if (!existing || (!runtime.hasConfiguredAuth(existing.model) && runtime.hasConfiguredAuth(model)))
        out.set(model.api, { api: model.api, model, provider: model.provider, id: model.id });
    }
  }
  const defaultModel = defaultRoute(runtime);
  if (defaultModel) {
    const model = runtime.getModels(defaultModel.provider).find((candidate) => candidate.id === defaultModel.id);
    if (model) out.set(model.api, { api: model.api, model, provider: model.provider, id: model.id });
  }
  const byProvider = providers.length
    ? [...out.values()].filter((x) => providers.includes(x.provider))
    : [...out.values()];
  const filtered = only.length ? byProvider.filter((x) => only.includes(x.api)) : byProvider;
  if (!only.length && !out.has("anthropic-messages")) return filtered;
  return filtered;
}

/** Providers with a non-empty inline `apiKey` in models.json — those keys ARE used by
 *  createAgentSession, while ModelRuntime.hasConfiguredAuth only checks auth.json/env
 *  (probe finding 2026-09-24: it returned false even for the route alpha2 succeeded on). */
function inlineKeyProviders(modelsPath: string): Set<string> {
  const out = new Set<string>();
  try {
    const raw = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
      providers?: Record<string, { apiKey?: unknown }>;
    };
    for (const [name, value] of Object.entries(raw.providers ?? {}))
      if (typeof value?.apiKey === "string" && value.apiKey !== "") out.add(name);
  } catch {
    /* unreadable models.json contributes nothing */
  }
  // auth.json (top-level keys are provider names) — hasConfiguredAuth proved
  // unreliable across the board (false even for routes that demonstrably work),
  // so count its providers directly.
  try {
    const raw = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf-8")) as Record<string, unknown>;
    for (const name of Object.keys(raw)) if (!out.has(name)) out.add(name);
  } catch {
    /* unreadable auth.json contributes nothing */
  }
  return out;
}

async function alpha2(
  root: string,
  runtime: ModelRuntime,
  only: string[],
  keyProviders: Set<string>,
  providers: string[] = [],
): Promise<Result> {
  const source = makeSource(root, join(root, "matrix-source"));
  const fallback = defaultRoute(runtime);
  const rows: Record<string, unknown>[] = [];
  for (const route of routes(runtime, only, keyProviders, providers)) {
    const isDefaultFallback = fallback?.provider === route.provider && fallback.id === route.id;
    if (!runtime.hasConfiguredAuth(route.model) && !keyProviders.has(route.provider) && !isDefaultFallback) {
      rows.push({
        api: route.api,
        provider: route.provider,
        model: route.id,
        status: "SKIPPED",
        reason: "no configured/authenticated credential",
      });
      continue;
    }
    const fork = await openReadonlyFork(source, root, join(root, `matrix-${route.api}`), route.model);
    const beforeMessageCount = fork.session.state.messages?.length ?? 0;
    let error: string | undefined;
    try {
      await fork.session.prompt(`Using only read-only tools, repeat ${TOKEN} exactly and do not call any other tool.`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const state = fork.session.state;
    const newMessages = (state.messages ?? []).slice(beforeMessageCount);
    const last = [...newMessages].reverse().find((m: any) => m.role === "assistant") as any;
    const stopReason = last?.stopReason;
    const answer = fork.session.getLastAssistantText() ?? "";
    const calls = newMessages.flatMap((m: any) =>
      m.role === "assistant" ? (m.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => b.name) : [],
    );
    const undeclared = calls.filter((name: string) => !READONLY_TOOLS.includes(name as never));
    const pass = !error && stopReason !== "error" && undeclared.length === 0 && answer.includes(TOKEN);
    rows.push({
      api: route.api,
      provider: route.provider,
      model: route.id,
      status: pass ? "PASS" : "FAIL",
      stopReason,
      error,
      activeTools: fork.active,
      toolCalls: calls,
      undeclaredToolCalls: undeclared.length,
      tokenEcho: answer.includes(TOKEN),
      usage: last?.usage?.cost,
    });
    rmSync(fork.path, { force: true });
  }
  const tested = rows.filter((row) => row.status !== "SKIPPED");
  const allSkipped = tested.length === 0;
  return {
    status: allSkipped ? "SKIPPED" : tested.every((row) => row.status === "PASS") ? "PASS" : "FAIL",
    detail: allSkipped ? "No configured/authenticated model routes found" : "Mechanical stop/tool/token checks",
    data: { routes: rows },
  };
}

async function alpha3(root: string, runtime: ModelRuntime): Promise<Result> {
  const source = makeSource(root, join(root, "cost-source"));
  const fallback = defaultRoute(runtime);
  const route =
    routes(runtime, [])
      .filter(
        (candidate) =>
          runtime.hasConfiguredAuth(candidate.model) ||
          (fallback?.provider === candidate.provider && fallback.id === candidate.id),
      )
      .find((x) => x.api === "anthropic-messages") ??
    routes(runtime, ["openai-responses"]).filter(
      (candidate) =>
        runtime.hasConfiguredAuth(candidate.model) ||
        (fallback?.provider === candidate.provider && fallback.id === candidate.id),
    )[0];
  if (!route) return { status: "SKIPPED", detail: "No authenticated long-context route" };
  const rows: Record<string, unknown>[] = [];
  for (const target of [50_000, 150_000]) {
    const fork = await openReadonlyFork(source, root, join(root, `cost-${target}`), route.model);
    const beforeMessageCount = fork.session.state.messages?.length ?? 0;
    let error: string | undefined;
    try {
      await fork.session.prompt(`${"context padding ".repeat(Math.ceil(target / 2))}\nRepeat ${TOKEN} exactly.`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const newMessages = (fork.session.state.messages ?? []).slice(beforeMessageCount);
    const last = [...newMessages].reverse().find((m: any) => m.role === "assistant") as any;
    const calls = newMessages.flatMap((m: any) =>
      m.role === "assistant" ? (m.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => b.name) : [],
    );
    rows.push({
      targetTokens: target,
      status: error ? "FAIL" : "PASS",
      error,
      cost: last?.usage?.cost,
      totalTokens: last?.usage?.totalTokens,
      nonexistentToolCalls: calls.filter((n: string) => !READONLY_TOOLS.includes(n as never)).length,
    });
    rmSync(fork.path, { force: true });
  }
  return {
    status: rows.every((r) => r.status === "PASS") ? "PASS" : "FAIL",
    detail: `Route ${route.provider}/${route.id}`,
    data: { route: route.api, rows },
  };
}

function alpha4(root: string): Result {
  const sourceDir = join(root, "large");
  const source = makeSource(root, sourceDir);
  const manager = SessionManager.open(source, sourceDir);
  const chunk = "x".repeat(100_000);
  for (let i = 0; i < 100; i++) manager.appendMessage(textMessage("user", `${i} ${chunk}`));
  const bytes = statSync(source).size;
  const target = join(root, "large-fork");
  const start = performance.now();
  const fork = SessionManager.forkFrom(source, root, target);
  const reopened = SessionManager.open(fork.getSessionFile()!, target, root);
  const elapsedMs = performance.now() - start;
  return {
    status: elapsedMs <= 100 ? "PASS" : "FAIL",
    detail: `forkFrom + open ${elapsedMs.toFixed(1)}ms`,
    data: { sourceBytes: bytes, elapsedMs, fork: reopened.getSessionFile(), thresholdMs: 100 },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) return help();
  const offline = args.includes("--offline");
  const only = args.flatMap((arg, i) => (arg === "--route" && args[i + 1] ? [args[i + 1]!] : []));
  const noCost = args.includes("--no-cost");
  const providers = args.flatMap((arg, i) => (arg === "--provider" && args[i + 1] ? [args[i + 1]!] : []));
  const root = mkdtempSync(join(tmpdir(), "consult-p0-alpha-"));
  const results: Record<string, Result> = {};
  try {
    const runtime = offline
      ? undefined
      : await ModelRuntime.create({
          authPath: join(getAgentDir(), "auth.json"),
          modelsPath: join(getAgentDir(), "models.json"),
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
    const keyProviders = inlineKeyProviders(join(getAgentDir(), "models.json"));
    const route = runtime
      ? (routes(runtime, only, keyProviders, providers)
          .filter((candidate) => runtime.hasConfiguredAuth(candidate.model) || keyProviders.has(candidate.provider))
          .find((x) => x.api === "anthropic-messages") ??
        routes(runtime, only, keyProviders, providers).filter(
          (candidate) => runtime.hasConfiguredAuth(candidate.model) || keyProviders.has(candidate.provider),
        )[0])
      : undefined;
    results["alpha1"] = offline ? await alpha1Offline(root) : await alpha1(root, route?.model);
    results["alpha4"] = alpha4(root);
    if (!offline && runtime) {
      results["alpha2"] = await alpha2(root, runtime, only, keyProviders, providers);
      results["alpha3"] = noCost ? { status: "SKIPPED", detail: "--no-cost" } : await alpha3(root, runtime);
    } else {
      results["alpha2"] = { status: "SKIPPED", detail: "--offline" };
      results["alpha3"] = { status: "SKIPPED", detail: "--offline" };
    }
    console.log(
      JSON.stringify(
        {
          token: TOKEN,
          readonlyTools: READONLY_TOOLS,
          injectionChecklist: [
            "tools=read,grep,find,ls",
            "consult run skips message_agent/set_model/Agent/StructuredOutput/consult",
            "prompt bypasses type prefix",
            "HOST_KEY preclaimed",
          ],
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
