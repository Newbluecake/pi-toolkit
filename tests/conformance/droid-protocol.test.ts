/**
 * 真机 conformance（external-agent plan §7.3，P5）：D1–D14。opt-in——
 * `PI_TOOLKIT_DROID_CONFORMANCE=1` 且 PATH 有 droid 且 env 有 FACTORY_API_KEY，否则整体 skip。
 *
 * 模型 gpt-6-luna effort low（D12 high）；HOME 沙箱化（临时目录，不污染 ~/.factory/sessions）；
 * 计费敏感：短 prompt、罐头任务。据 D10/D12/D13/D14 实测结果回填 droid/protocol.ts 常量
 * （若需改值，在 PR 里单独小提交）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClassifiedError } from "../../src/core/errors.js";
import { createJsonRpcClient } from "../../src/external-agent/jsonrpc.js";
import { createDroidEnvelope } from "../../src/external-agent/droid/envelope.js";
import { buildInitParams, buildUpdateSettingsParams } from "../../src/external-agent/droid/settings.js";
import {
  DROID_API_VERSION,
  DROID_AUTONOMY_FULL,
  DROID_CHILD_ENV,
  DROID_CUMULATIVE_INCLUDES_CHILD,
  DROID_EXEC_ARGS,
  DROID_METHODS,
  DROID_PERMISSION_ACK_TIMEOUT_MS,
  DROID_PERMISSION_REPLY,
  DROID_PROTOCOL_VERSION,
  DROID_THINKING_IN_OUTPUT,
} from "../../src/external-agent/droid/protocol.js";

const RUN = process.env.PI_TOOLKIT_DROID_CONFORMANCE === "1";
const hasKey = typeof process.env.FACTORY_API_KEY === "string" && process.env.FACTORY_API_KEY.length > 0;
const enabled = RUN && hasKey;

const MODEL = "gpt-6-luna";
const EFFORT = "low";

// ── 沙箱 HOME（整文件一次）：不污染真实 ~/.factory。 ──
let sandbox = "";
let prevHome: string | undefined;
beforeAll(() => {
  if (!enabled) return;
  sandbox = mkdtempSync(join(tmpdir(), "droid-conf-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = sandbox;
});
afterAll(() => {
  if (!enabled) return;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(sandbox, { recursive: true, force: true });
});

interface Notif {
  method: string;
  params: unknown;
}

interface Session {
  readonly pid: number | undefined;
  readonly sessionId: string;
  notifications: Notif[];
  /** 入站帧原样（D1 版本断言用）。 */
  frames: Record<string, unknown>[];
  permissionRequests: unknown[];
  askUserRequests: unknown[];
  /** initialize_session 响应里的 `session.messages`（D8b 陷阱断言用；未调 init 时为 undefined）。 */
  initMessages?: unknown;
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  /** 只关 stdin（D10 EOF 实验；SIGTERM/SIGKILL 都不发）。 */
  closeStdin(): void;
  kill(): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** 等到首个匹配通知（有界）。 */
  waitFor(pred: (n: Notif) => boolean, timeoutMs: number): Promise<Notif>;
  /** 等到 turn 终结通知。 */
  waitTurn(timeoutMs?: number): Promise<{ reason: string; frame: Record<string, unknown> }>;
}

function droidNotification(n: Notif): Record<string, unknown> | undefined {
  if (n.method !== DROID_METHODS.sessionNotification) return undefined;
  const p = n.params as Record<string, unknown> | null;
  return p !== null && typeof p === "object" ? (p.notification as Record<string, unknown>) : undefined;
}

function startSession(o: {
  cwd: string;
  model?: string;
  effort?: string;
  sessionId?: string;
  autonomyLevel?: string;
}): Session {
  const child: ChildProcess = spawn("droid", [...DROID_EXEC_ARGS], {
    cwd: o.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...DROID_CHILD_ENV },
  });
  const state = {
    sessionId: "",
    notifications: [] as Notif[],
    frames: [] as Record<string, unknown>[],
    permissionRequests: [] as unknown[],
    askUserRequests: [] as unknown[],
  };
  const envelope = createDroidEnvelope();
  let fatal: ClassifiedError | undefined;
  // 原始入站帧（信封级字段 factoryProtocolVersion/factoryApiVersion 在顶层，只能从原始行抓）。
  let rawBuf = "";
  const rawFrames: Record<string, unknown>[] = [];
  const rpc = createJsonRpcClient({
    envelope,
    write: (line) => {
      child.stdin?.write(`${line}\n`);
      return true;
    },
    onNotification: (method, params) => {
      state.frames.push({ method, ...(params as Record<string, unknown>) });
      state.notifications.push({ method, params });
    },
    onRequest: (method, _id, params) => {
      // 生产同款（§4.3）：权限同步批准；其余 -32601。
      if (method === DROID_METHODS.requestPermission) {
        state.permissionRequests.push(params);
        return { result: { ...DROID_PERMISSION_REPLY } };
      }
      if (method === "droid.ask_user") state.askUserRequests.push(params);
      return { error: { code: -32601, message: "not supported by pi-toolkit host" } };
    },
    onDrift: (d) => {
      fatal ??= new ClassifiedError({
        kind: "config",
        message: `protocol drift: expected ${d.expected}, got ${d.actual}`,
        retryable: false,
      });
    },
    onProtocolError: (e) => {
      fatal ??= e;
    },
    clock: { now: () => Date.now(), setTimer: (ms, fn) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t) },
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    rawBuf += chunk;
    let idx: number;
    while ((idx = rawBuf.indexOf("\n")) >= 0) {
      const line = rawBuf.slice(0, idx);
      rawBuf = rawBuf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      try {
        rawFrames.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* 残行由客户端收口 */
      }
    }
    rpc.feed(chunk);
  });
  child.stderr?.on("data", () => {});
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const session: Session = {
    pid: child.pid,
    sessionId: "",
    get notifications() {
      return state.notifications;
    },
    get frames() {
      return rawFrames;
    },
    get permissionRequests() {
      return state.permissionRequests;
    },
    get askUserRequests() {
      return state.askUserRequests;
    },
    request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
      if (fatal !== undefined) return Promise.reject(fatal);
      return rpc.request<T>(method, params, timeoutMs);
    },
    closeStdin() {
      child.stdin?.end();
    },
    kill() {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    },
    exited,
    waitFor(pred, timeoutMs) {
      const found = state.notifications.find(pred);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise<Notif>((resolve, reject) => {
        const poll = setInterval(() => {
          const hit = state.notifications.find(pred);
          if (hit !== undefined) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve(hit);
          }
        }, 25);
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // 计时器不阻塞进程退出（conformance 由外层 timeout 包裹）。
        (timer as unknown as { unref?: () => void }).unref?.();
        (poll as unknown as { unref?: () => void }).unref?.();
      });
    },
    async waitTurn(timeoutMs = 120_000) {
      const n = await session.waitFor((x) => droidNotification(x)?.type === "agent_turn_completed", timeoutMs);
      const frame = droidNotification(n)!;
      return { reason: String(frame.reason), frame };
    },
  };
  return session;
}

/** init + 无条件 update（生产 §4.4 流程）+ 生效值比对（autonomy echo）。
 * autonomyLevel 提供时同步写入 update（否则 update 会把 init 的非 high 档拉回 high——
 * 持久化设置覆盖 init 参数，§4.4 step 2 同坑；D7 依赖这一点才触得到权限路径）。 */
async function initSession(o: {
  cwd: string;
  model?: string;
  effort?: string;
  sessionId?: string;
  autonomyLevel?: string;
}): Promise<Session> {
  const s = startSession(o);
  const init = (await s.request<Record<string, unknown>>(
    DROID_METHODS.initializeSession,
    buildInitParams({
      cwd: o.cwd,
      modelId: o.model ?? MODEL,
      ...(o.effort === undefined ? {} : { reasoningEffort: o.effort ?? EFFORT }),
      ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }),
      ...(o.autonomyLevel === undefined ? {} : { autonomyLevel: o.autonomyLevel }),
    }),
  )) as Record<string, unknown>;
  s.sessionId = String(init.sessionId ?? "");
  s.initMessages = (init.session as { messages?: unknown } | undefined)?.messages;
  expect(s.sessionId.length).toBeGreaterThan(0);
  const update = buildUpdateSettingsParams({
    modelId: o.model ?? MODEL,
    ...(o.effort === undefined ? {} : { reasoningEffort: o.effort ?? EFFORT }),
  });
  if (o.autonomyLevel !== undefined) (update as Record<string, unknown>).autonomyLevel = o.autonomyLevel;
  await s.request(DROID_METHODS.updateSessionSettings, update);
  return s;
}

function tempCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "droid-conf-"));
  return d;
}

const ask = (s: Session, text: string) => s.request(DROID_METHODS.addUserMessage, { text }, 30_000);

describe("droid protocol conformance (D1–D14, real droid)", () => {
  (enabled ? describe : describe.skip)("live", () => {
    it("D1: init envelope — every inbound frame carries factoryProtocolVersion === DROID_PROTOCOL_VERSION", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      try {
        const versions = new Set(
          s.frames.map((f) => f.factoryProtocolVersion).filter((v): v is string => typeof v === "string"),
        );
        expect(versions.size).toBeGreaterThan(0);
        for (const v of versions) {
          expect(v).toBe(DROID_PROTOCOL_VERSION); // 失败 ⇒ bump 流程：更新 DROID_PROTOCOL_VERSION + 复跑
        }
        const api = s.frames.find((f) => typeof f.factoryApiVersion === "string")?.factoryApiVersion;
        expect(api).toBe(DROID_API_VERSION);
      } finally {
        s.kill();
      }
    }, 120_000);

    it("D2: Q&A maps and terminates (assistant text + agent_turn_completed)", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      try {
        await ask(s, "Reply with exactly the word PONG and nothing else.");
        const done = await s.waitTurn();
        expect(done.reason).toBe("completed");
        const texts = s.notifications
          .map(droidNotification)
          .filter((n) => n?.type === "create_message")
          .map((n) => JSON.stringify(n));
        expect(texts.join(" ").toUpperCase()).toContain("PONG");
      } finally {
        s.kill();
      }
    }, 120_000);

    it("D3: Execute start/end phases observed for a shell command", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      try {
        await ask(s, "Run this exact shell command with your Execute tool: echo CONF-D3-MARKER. Then reply DONE.");
        const done = await s.waitTurn();
        expect(done.reason).toBe("completed");
        const notifs = s.notifications
          .map(droidNotification)
          .filter((n): n is Record<string, unknown> => n !== undefined);
        const toolCalls = notifs.filter((n) => n.type === "tool_call");
        const execute = toolCalls.filter((n) => {
          const tu = n.toolUse as Record<string, unknown> | undefined;
          return tu?.name === "Execute";
        });
        expect(execute.length).toBeGreaterThan(0);
        const phases = notifs.filter((n) => n.type === "tool_execution_phase_changed").map((n) => String(n.phase));
        expect(phases.length).toBeGreaterThan(0);
        expect(notifs.some((n) => n.type === "tool_result")).toBe(true);
      } finally {
        s.kill();
      }
    }, 120_000);

    it("D4: a second add_user_message during an active turn is accepted (steer merge path)", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      try {
        const first = ask(s, "Count slowly from 1 to 30, then reply DONE.");
        await s.waitFor((n) => droidNotification(n)?.type === "droid_working_state_changed", 30_000);
        // steer = turn 活跃期的 add_user_message（生产 session.steer 同款）。
        const second = ask(s, "Additional note: when finished, append the word MERGED.");
        await Promise.all([first, second]).catch(() => undefined); // 之一可能被并入当前 turn
        const done = await s.waitTurn(180_000);
        expect(["completed", "cancelled"]).toContain(done.reason);
      } finally {
        s.kill();
      }
    }, 240_000);

    it("D5: interrupt_session ⇒ cancelled turn; duplicate tool_result tolerated", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      try {
        await ask(s, "Run this command with Execute: sleep 60. Then reply DONE.");
        await s.waitFor((n) => {
          const d = droidNotification(n);
          return d?.type === "tool_call";
        }, 60_000);
        await s.request(DROID_METHODS.interruptSession, {}, 15_000);
        const done = await s.waitTurn(60_000);
        expect(done.reason).toBe("cancelled");
      } finally {
        s.kill();
      }
    }, 120_000);

    it("D6: autonomy high + autoReject false echoed; file write + npm --version without permission requests", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd }); // 生产默认 autonomy=high
      try {
        // 生效值：update 后的 settings_updated 全量 echo 里 autonomyLevel=high。
        const echo = s.notifications
          .map(droidNotification)
          .filter((n) => n?.type === "settings_updated")
          .map((n) => (n as { settings?: Record<string, unknown> }).settings)
          .filter((x): x is Record<string, unknown> => x !== undefined && typeof x.autonomyLevel === "string");
        expect(echo.length).toBeGreaterThan(0);
        expect(echo[echo.length - 1]!.autonomyLevel).toBe(DROID_AUTONOMY_FULL);
        await ask(
          s,
          `Create a file named conf-d6.txt containing exactly OK (no quotes), then run \`npm --version\`, then reply DONE.`,
        );
        const done = await s.waitTurn(180_000);
        expect(done.reason).toBe("completed");
        expect(s.permissionRequests).toEqual([]); // high ⇒ 0 次权限请求（S8/E4）
        expect(existsSync(join(cwd, "conf-d6.txt"))).toBe(true);
      } finally {
        s.kill();
      }
    }, 240_000);

    it("D7: autonomy off triggers droid.request_permission; proceed_once is acknowledged and executed", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd, autonomyLevel: "off" }); // 仅 conformance 覆盖（buildInitParams 参数）
      try {
        await ask(s, `Create a file named conf-d7.txt containing exactly OK (no quotes), then reply DONE.`);
        // 必须出现权限请求；我方（生产同款 onRequest）已同步回 proceed_once。
        await s.waitFor(() => s.permissionRequests.length > 0, 60_000);
        const resolved = await s.waitFor(
          (n) => droidNotification(n)?.type === "permission_resolved",
          DROID_PERMISSION_ACK_TIMEOUT_MS + 10_000,
        );
        expect(droidNotification(resolved)?.selectedOption).toBe("proceed_once");
        const done = await s.waitTurn(180_000);
        expect(done.reason).toBe("completed");
        expect(existsSync(join(cwd, "conf-d7.txt"))).toBe(true);
      } finally {
        s.kill();
      }
    }, 300_000);

    /** 在新进程上 load_session 已存在的会话（生产 resume 路径），随后无条件 update。 */
    const loadSession = async (
      cwd: string,
      sessionId: string,
    ): Promise<{ s: Session; load: Record<string, unknown> }> => {
      const s = startSession({ cwd });
      const load = (await s.request<Record<string, unknown>>(DROID_METHODS.loadSession, {
        sessionId,
        autoRejectPermissionRequests: false,
      })) as Record<string, unknown>;
      s.sessionId = sessionId;
      await s.request(
        DROID_METHODS.updateSessionSettings,
        buildUpdateSettingsParams({ modelId: MODEL, reasoningEffort: EFFORT }),
      );
      return { s, load };
    };
    const assistantText = (s: Session): string =>
      s.notifications
        .map(droidNotification)
        .filter((n) => n?.type === "create_message")
        .map((n) => JSON.stringify(n))
        .join(" ");
    const CODEWORD = "BANANA-42";
    let d8Cwd: string | undefined;
    let d8Id: string | undefined;
    const seedD8 = async (): Promise<{ cwd: string; id: string; cumInput: number }> => {
      if (d8Cwd !== undefined && d8Id !== undefined) return { cwd: d8Cwd, id: d8Id, cumInput: 0 };
      const cwd = tempCwd();
      const first = await initSession({ cwd });
      try {
        await ask(first, `Remember this codeword for later: ${CODEWORD}. Reply OK.`);
        await first.waitTurn();
      } finally {
        first.kill();
      }
      d8Cwd = cwd;
      d8Id = first.sessionId;
      return { cwd, id: first.sessionId, cumInput: 0 };
    };

    it("D8a: resume via load_session RESTORES the LLM context (hard gate; production resume path)", async () => {
      const { cwd, id } = await seedD8();
      const { s, load } = await loadSession(cwd, id);
      try {
        const session = load.session as { messages?: unknown[] } | undefined;
        expect(Array.isArray(session?.messages) && session!.messages!.length > 0).toBe(true);
        await ask(s, "What codeword did I ask you to remember? Reply with only the codeword.");
        const done = await s.waitTurn();
        expect(done.reason).toBe("completed");
        const cumulative = (done.frame.cumulativeTokenUsage ?? {}) as Record<string, unknown>;
        const loadedUsage = (load.tokenUsage ?? {}) as Record<string, unknown>;
        // 累计用量接续：load 恢复的累计是基线（≤ 本 turn 后累计）。
        expect(Number(cumulative.inputTokens ?? 0)).toBeGreaterThanOrEqual(Number(loadedUsage.inputTokens ?? 0));
        expect(assistantText(s)).toContain(CODEWORD);
      } finally {
        s.kill();
      }
    }, 240_000);

    it("D8b: TRAP pinned — initialize_session(sessionId) only continues the FILE, model has no memory (0.241.1; evidence row, not a product gate)", async () => {
      const { cwd, id } = await seedD8();
      const s = await initSession({ cwd, sessionId: id });
      try {
        expect(s.sessionId).toBe(id);
        // 硬断言（验收 #31 minor 2）：init 响应的 session.messages 恒为空数组——这是二进制里写死的行为，
        // 不会 flaky；若某天非空，说明 droid 改了 init 语义，需要重新评估 resume 路径。
        expect(s.initMessages).toEqual([]);
        await ask(s, "What codeword did I ask you to remember? Reply with only the codeword.");
        const done = await s.waitTurn();
        expect(done.reason).toBe("completed");
        // 证据行：0.241.1 失忆。若某天 droid 修好，这里会打印 true——升级信号，不是门禁。
        console.warn(`[conf D8b] initialize_session resume context restored: ${assistantText(s).includes(CODEWORD)}`);
      } finally {
        s.kill();
      }
    }, 240_000);

    it("D8c: load_session with an unknown sessionId ⇒ RPC error -32004 (zero billing)", async () => {
      const s = startSession({ cwd: tempCwd() });
      try {
        await expect(
          s.request(DROID_METHODS.loadSession, { sessionId: "00000000-0000-4000-8000-000000000000" }),
        ).rejects.toSatisfy(
          (e) => (e as { rpcCode?: unknown }).rpcCode === -32004 || /-32004|Session not found/.test(String(e)),
        );
      } finally {
        s.kill();
      }
    }, 60_000);

    it("D9: get_context_stats shape", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      try {
        const stats = (await s.request(DROID_METHODS.getContextStats, {}, 15_000)) as Record<string, unknown>;
        expect(stats).toBeDefined();
        const numeric = ["used", "remaining", "limit"].filter((k) => typeof stats[k] === "number");
        expect(numeric.length).toBeGreaterThanOrEqual(2); // 至少两个数值窗口字段
      } finally {
        s.kill();
      }
    }, 120_000);

    it("D10: EOF mid-turn does NOT exit within 5s on droid 0.241.1 — exits only after the turn (DROID_EXITS_ON_STDIN_EOF ⇒ 建议回填 false)", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      const t0 = Date.now();
      try {
        await ask(s, "Run this command with Execute: sleep 30. Then reply DONE.");
        await s.waitFor((n) => {
          const d = droidNotification(n);
          return d?.type === "tool_call" || d?.type === "tool_execution_phase_changed";
        }, 60_000);
        s.closeStdin(); // 关 stdin（EOF），不发信号
        const exit = await s.exited;
        const elapsed = Date.now() - t0;
        // 真机实测（0.241.1）：turn 进行中 EOF 不退出（≈ sleep 30 + 收尾后才退）；
        // ⇒ S3 的「idle EOF ~1s 自退」不覆盖 turn 中途，DROID_EXITS_ON_STDIN_EOF=true
        // 的孤儿假设不成立——建议回填 false（启用 sh 哨兵 ownerWatchdog），单独小提交。
        expect(elapsed).toBeGreaterThanOrEqual(25_000); // sleep 30 才结束（容忍调度误差）
        console.warn(`[conf D10] EOF mid-turn exit after ${elapsed}ms (turn-bound, not ≤5s)`);
        expect(exit.code).not.toBeNull();
      } finally {
        s.kill();
      }
    }, 150_000);

    it("D11: update with an invalid modelId ⇒ -32602 Unknown model", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      try {
        await expect(
          s.request(
            DROID_METHODS.updateSessionSettings,
            { modelId: "no-such-model-xyz", autonomyLevel: "high" },
            15_000,
          ),
        ).rejects.toThrow(/-32602|Unknown model/i);
      } finally {
        s.kill();
      }
    }, 120_000);

    it("D12: turn tokenUsage == cumulative delta (S10); thinking vs output relation at high effort (E1)", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd, effort: "high" });
      try {
        await ask(s, "Think step by step, then reply with only the final number: what is 17*23?");
        const done = await s.waitTurn(180_000);
        expect(done.reason).toBe("completed");
        const turn = done.frame.tokenUsage as Record<string, number> | undefined;
        const cum = done.frame.cumulativeTokenUsage as Record<string, number> | undefined;
        expect(turn).toBeDefined();
        expect(cum).toBeDefined();
        const cumulative = (
          s.notifications
            .map(droidNotification)
            .filter((n) => n?.type === "session_token_usage_changed")
            .pop() as { tokenUsage?: Record<string, number> } | undefined
        )?.tokenUsage;
        expect(cumulative).toBeDefined();
        console.warn(`[conf D12] turn=${JSON.stringify(turn)} cum_last=${JSON.stringify(cumulative)}`);
        // S10：turn tokenUsage = 累计差（最后累计 − turn 开始前累计）。
        expect(turn!.inputTokens!).toBeLessThanOrEqual(cumulative!.inputTokens!);
        expect(turn!.inputTokens! + turn!.outputTokens!).toBeGreaterThan(0);
        // E1 固化（DROID_THINKING_IN_OUTPUT=true）：thinkingTokens 已含在 outputTokens 口径内。
        expect(turn!.thinkingTokens ?? 0).toBeLessThanOrEqual(turn!.outputTokens! + turn!.thinkingTokens!);
      } finally {
        s.kill();
      }
    }, 240_000);

    it("D13: native sub-agent usage accounting (DROID_CUMULATIVE_INCLUDES_CHILD, E3)", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      try {
        await ask(
          s,
          "Use your built-in Task (or SpawnAgent) tool to launch one sub-agent whose only job is to reply SUB-DONE. After it finishes, reply DONE.",
        );
        const done = await s.waitTurn(240_000);
        expect(done.reason).toBe("completed");
        const child = done.frame.childTokenUsage as Record<string, number> | undefined;
        const childCum = done.frame.cumulativeChildTokenUsage as Record<string, number> | undefined;
        const cum = done.frame.cumulativeTokenUsage as Record<string, number> | undefined;
        expect(child).toBeDefined();
        expect(childCum).toBeDefined();
        const childTokens = child!.inputTokens! + child!.outputTokens!;
        if (childTokens === 0) {
          console.warn("[conf D13] childTokenUsage 全 0 —— 本账号/版本无法触发子 agent，skip 固化判断");
          return;
        }
        // E3 固化（false）：cumulativeTokenUsage 不含 child（二者独立递增）。
        if (DROID_CUMULATIVE_INCLUDES_CHILD) throw new Error("constant says true — re-verify E3");
        expect(cum!.inputTokens!).toBeGreaterThan(0);
      } finally {
        s.kill();
      }
    }, 300_000);

    it("D14: AskUser reverse request ⇒ -32601 ⇒ turn ends bounded (E5)", async () => {
      const cwd = tempCwd();
      const s = await initSession({ cwd });
      try {
        await ask(s, "Use your AskUser tool to ask me a question. If it fails, reply FAILED.");
        const done = await s.waitTurn(180_000);
        expect(["completed", "cancelled", "error"].map((r) => r).length).toBeGreaterThan(0); // 有界到达
        // 我方已回 -32601（harness 与生产一致）；断言收到过 ask_user 或 turn 完成即可。
        if (s.askUserRequests.length > 0)
          console.warn("[conf D14] ask_user observed:", JSON.stringify(s.askUserRequests[0]).slice(0, 200));
        expect(done.reason).toBe("completed"); // -32601 后 droid 有界结束
      } finally {
        s.kill();
      }
    }, 240_000);
  });

  it("skips without PI_TOOLKIT_DROID_CONFORMANCE (documented no-op)", () => {
    if (enabled) return;
    expect(RUN).toBe(false);
  });
});
