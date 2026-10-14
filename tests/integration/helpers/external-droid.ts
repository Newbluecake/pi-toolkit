/**
 * external-droid 集成测试共享 harness（plan §7.2，P5）：真 buildSessionStack + 真
 * fake-droid 进程（wrapper shell 脚本当 `externalAgents.droid.binary`）+ 真时钟小预算。
 *
 * 观测接缝（fake-droid 侧，生产路径恒空）：
 * - `DROID_TRACE_FILE`：fake 收到的每个 JSON-RPC 方法名一行（断言「add_user_message 从未发出」等）。
 * - `DROID_ECHO_FILE`（echo-cwd 模式）：init 时把进程 cwd 与 init 参数 cwd 各记一行。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionStack, type Stack } from "../../../src/stack.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../../src/config/settings.js";
import { DEFAULT_BUDGET } from "../../../src/core/deadline.js";
import type { DeadlineBudget } from "../../../src/core/types.js";

const FAKE_DROID = join(process.cwd(), "tests", "external-agent", "fixtures", "fake-droid.mjs");

export interface DroidStack {
  readonly stack: Stack;
  readonly root: string;
  readonly agentDir: string;
  readonly traceFile: string;
  readonly echoFile: string;
  dispose(): void;
}

/** 生成一个可执行 wrapper 脚本当 droid binary（模式/参数烤进脚本；观测文件经 env 注入）。 */
export function makeBinary(root: string, args: readonly string[]): string {
  const dir = join(root, "bin");
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `droid-${args.join("_").replaceAll(/[^A-Za-z0-9._-]/g, "") || "default"}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const script = [
    "#!/bin/sh",
    `exec "${process.execPath}" "${FAKE_DROID}" ${args.map((a) => `"${a}"`).join(" ")} "$@"`,
    "",
  ].join("\n");
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

export function buildDroidStack(o: {
  binary: string;
  /** 每个 stack 独立 tmp 根目录（agentDir 隔离 + 二进制 wrapper）。 */
  settings?: Partial<AgentSettings["externalAgents"]["droid"]>;
  quota?: Partial<AgentSettings["quota"]>;
  budget?: Partial<DeadlineBudget>;
}): DroidStack {
  const root = mkdtempSync(join(tmpdir(), "ext-droid-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const traceFile = join(root, "trace.log");
  const echoFile = join(root, "echo.log");
  writeFileSync(traceFile, "");
  writeFileSync(echoFile, "");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.DROID_TRACE_FILE = traceFile;
  process.env.DROID_ECHO_FILE = echoFile;

  const pi = {
    sendMessage: vi.fn(),
    appendEntry: () => undefined,
    events: { emit: () => undefined, on: () => () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  } as unknown as ExtensionAPI;
  const ctx: ExtensionContext = {
    cwd: root,
    sessionManager: { getEntries: () => [], getSessionId: () => "ext-droid-test", getBranch: () => [] },
    modelRegistry: {
      getAvailable: () => [{ provider: "openai", id: "gpt-6-luna", name: "GPT-6 Luna" }],
      getAll: () => [
        {
          provider: "openai",
          id: "gpt-6-luna",
          name: "GPT-6 Luna",
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
        },
      ],
      find: (p: string, id: string) =>
        p === "openai" && id === "gpt-6-luna"
          ? {
              provider: "openai",
              id: "gpt-6-luna",
              name: "GPT-6 Luna",
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
            }
          : undefined,
    },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    hasUI: false,
    mode: "interactive",
  } as unknown as ExtensionContext;
  const type = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" } as never;
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  } as never;

  const stack = buildSessionStack(
    pi,
    ctx,
    {
      ...DEFAULT_SETTINGS,
      fleetWidget: false,
      bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
      cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: false },
      quota: { ...DEFAULT_SETTINGS.quota, providers: "", ...(o.quota ?? {}) },
      externalAgents: {
        droid: {
          ...DEFAULT_SETTINGS.externalAgents.droid,
          enabled: true,
          binary: o.binary,
          ...(o.settings ?? {}),
        },
      },
    },
    types,
    [],
  );
  return {
    stack,
    root,
    agentDir,
    traceFile,
    echoFile,
    dispose() {
      stack.external?.dispose();
      stack.quota?.dispose();
      stack.scheduler.stop();
      stack.rpc.close();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      delete process.env.DROID_TRACE_FILE;
      delete process.env.DROID_ECHO_FILE;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 小预算（hang 类用例）：显式 totalMs ⇒ fixed deadline（无宽限无延长）。 */
export function smallBudget(over: Partial<DeadlineBudget> = {}): Partial<DeadlineBudget> {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 5_000,
    startupMs: 5_000,
    bindMs: 5_000,
    firstEventMs: 3_000,
    idleMs: 3_000,
    modelTurnMs: 6_000,
    toolMs: 4_000,
    totalMs: 8_000,
    abortGraceMs: 1_500,
    reapMs: 1_500,
    totalGraceMs: 0,
    maxExtensions: 0,
    maxTotalFactor: 1,
    ...over,
  };
}

export function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/** 轮询到 run 终态（真时钟）。 */
export async function waitFor(
  stack: Stack,
  runId: string,
  timeoutMs: number,
): Promise<{
  status: string;
  outcome?: {
    status: string;
    error?: { message: string; kind: string; retryable: boolean };
    timeoutReason?: string;
    text?: string;
    usage?: { input?: number; output?: number; costUsd?: number; unpriced?: string };
  };
}> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = stack.query.get(runId as never);
    if (snap !== undefined && ["completed", "failed", "timed_out", "aborted"].includes(snap.status)) {
      const outcome = await stack.query.wait(runId as never, { waitMs: 1 }).catch(() => undefined);
      return {
        status: snap.status,
        outcome: outcome !== undefined && "outcome" in outcome ? outcome.outcome : undefined,
      };
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} did not settle within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
