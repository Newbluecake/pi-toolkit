/**
 * P3 单测共享假实现：注入 ExternalFrameworkDeps 的 SpawnChild/JsonRpcClient/OpenTranscript/
 * UsageLedger/CatalogStore（不 import P2 实现——并行纪律）。
 */
import { FakeClock } from "../../../src/core/clock.js";
import type { UsageDelta } from "../../../src/core/types.js";
import type {
  ExternalTokenCounts,
  UsageLedger,
  UsageLedgerTotals,
  ChildExit,
  JsonRpcClient,
  JsonRpcClientOptions,
  ManagedChild,
  ManagedChildOptions,
  TranscriptWriter,
  CatalogStore,
  ExternalCatalog,
  ExternalFrameworkDeps,
} from "../../../src/external-agent/types.js";
import type { ExternalPricing } from "../../../src/core/types.js";
import type { ExternalSessionSpec, TranscriptHeader } from "../../../src/external-agent/types.js";

export { FakeClock };

// ── ManagedChild ──
export class FakeChild implements ManagedChild {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly terminated: ("graceful" | "now")[] = [];
  stderr = "";
  private exitValue: ChildExit | undefined;
  private resolveExited!: (e: ChildExit) => void;
  readonly exited: Promise<ChildExit> = new Promise((r) => {
    this.resolveExited = r;
  });
  private stdoutCbs: ((chunk: Buffer) => void)[] = [];
  private graceExpiredFlag = false;
  writeThrows: Error | undefined;

  onStdout(cb: (chunk: Buffer) => void): void {
    this.stdoutCbs.push(cb);
  }
  feedStdout(text: string): void {
    for (const cb of this.stdoutCbs) cb(Buffer.from(text));
  }
  write(line: string): boolean {
    if (this.writeThrows) throw this.writeThrows;
    this.writes.push(line);
    return true;
  }
  onDrain(): void {}
  exitInfo(): ChildExit | undefined {
    return this.exitValue;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitValue !== undefined) return;
    this.exitValue = { code, signal };
    this.resolveExited(this.exitValue);
  }
  terminate(mode: "graceful" | "now"): { signalled: boolean; error?: string } {
    this.terminated.push(mode);
    return { signalled: true };
  }
  terminating(): boolean {
    return this.terminated.length > 0 && this.exitValue === undefined;
  }
  graceExpired(): boolean {
    return this.graceExpiredFlag;
  }
  expireGrace(): void {
    this.graceExpiredFlag = true;
  }
  stderrTail(): string {
    return this.stderr;
  }
}

// ── JsonRpcClient ──
export type FakeRpcHandler = (method: string, params: unknown) => unknown;

export class FakeRpc implements JsonRpcClient {
  readonly requests: { method: string; params: unknown; timeoutMs: number }[] = [];
  handler: FakeRpcHandler | undefined;
  /** createRpc 之后、request 之前才可能被赋值（provider 流程）：请求时动态取。 */
  dynamicHandler: (() => FakeRpcHandler | undefined) | undefined;
  failAllCalls: ClassifiedLike[] = [];
  fed: (Buffer | string)[] = [];
  /** §15（P3 验收遗留）：failAll 同真客户端语义拒绝挂起请求（无 handler 的永悬 promise 也一样）。 */
  private pendingRejects = new Set<(e: ClassifiedLike) => void>();
  constructor(public opts: JsonRpcClientOptions) {}
  feed(chunk: Buffer | string): void {
    this.fed.push(chunk);
  }
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    this.requests.push({ method, params, timeoutMs });
    const handler = this.handler ?? this.dynamicHandler?.();
    if (handler === undefined)
      return new Promise<T>((_resolve, reject) => {
        this.pendingRejects.add(reject);
      });
    try {
      const result = handler(method, params);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result as T);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  failAll(e: ClassifiedLike): void {
    this.failAllCalls.push(e);
    const rejects = [...this.pendingRejects];
    this.pendingRejects.clear();
    for (const reject of rejects) {
      try {
        reject(e);
      } catch {
        /* 防御 */
      }
    }
  }
  stats(): { lateResponses: number; nonJsonLines: number } {
    return { lateResponses: 0, nonJsonLines: 0 };
  }
  // 测试驱动入口：
  notify(method: string, params: unknown): void {
    this.opts.onNotification(method, params);
  }
  notifyDroid(notification: unknown): void {
    this.opts.onNotification("droid.session_notification", { sessionId: "s", notification });
  }
  reverseRequest(method: string, id: string, params: unknown): ReturnType<JsonRpcClientOptions["onRequest"]> {
    return this.opts.onRequest(method, id, params);
  }
  drift(actual: string): void {
    this.opts.onDrift({ expected: "1.264.0", actual });
  }
  protocolError(e: ClassifiedLike): void {
    this.opts.onProtocolError(e);
  }
}
type ClassifiedLike = import("../../../src/core/errors.js").ClassifiedError;

// ── UsageLedger（L1–L3 的最小诚实语义；定价按 input 记 costUsd 便于断言） ──
const zeroCounts = (): ExternalTokenCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
  credits: 0,
});
const subClamp = (a: ExternalTokenCounts, b: ExternalTokenCounts): ExternalTokenCounts => ({
  input: Math.max(0, a.input - b.input),
  output: Math.max(0, a.output - b.output),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  thinking: Math.max(0, a.thinking - b.thinking),
  credits: Math.max(0, a.credits - b.credits),
});
const add = (a: ExternalTokenCounts, b: ExternalTokenCounts): ExternalTokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  thinking: a.thinking + b.thinking,
  credits: a.credits + b.credits,
});

export class FakeLedger implements UsageLedger {
  beginTurns: (ExternalTokenCounts | undefined)[] = [];
  observed: ExternalTokenCounts[] = [];
  completed: { turn: ExternalTokenCounts; child?: ExternalTokenCounts }[] = [];
  private baseline: ExternalTokenCounts | undefined;
  private prev: ExternalTokenCounts | undefined;
  private turnOpenFlag = false;
  private emitted = zeroCounts();
  private total = zeroCounts();
  constructor(
    private pricing: ExternalPricing,
    private opts: { thinkingInOutput: boolean; cumulativeIncludesChild: boolean },
  ) {}
  private toDelta(c: ExternalTokenCounts): UsageDelta {
    const zero = c.input + c.output + c.cacheRead + c.cacheWrite === 0;
    const base: UsageDelta = {
      input: c.input,
      output: c.output,
      cacheRead: c.cacheRead,
      cacheWrite: c.cacheWrite,
      costUsd: this.pricing.status === "priced" ? c.input : 0,
    };
    if (this.pricing.status === "unpriced") base.unpriced = "all";
    return zero ? { ...base } : base;
  }
  beginTurn(baseline: ExternalTokenCounts | undefined): void {
    this.beginTurns.push(baseline);
    this.baseline = baseline;
    this.prev = baseline;
    this.emitted = zeroCounts();
    this.turnOpenFlag = true;
  }
  observeCumulative(cum: ExternalTokenCounts): UsageDelta | undefined {
    this.observed.push(cum);
    if (!this.turnOpenFlag || this.prev === undefined) {
      this.prev = cum;
      return undefined;
    }
    const delta = subClamp(cum, this.prev);
    this.prev = cum;
    this.emitted = add(this.emitted, delta);
    this.total = add(this.total, delta);
    return this.toDelta(delta);
  }
  completeTurn(turnTotal: ExternalTokenCounts, child?: ExternalTokenCounts): UsageDelta | undefined {
    this.completed.push(child === undefined ? { turn: turnTotal } : { turn: turnTotal, child });
    if (!this.turnOpenFlag) return undefined;
    this.turnOpenFlag = false;
    const target = this.opts.cumulativeIncludesChild && child !== undefined ? add(turnTotal, child) : turnTotal;
    const remainder = subClamp(target, this.emitted);
    this.total = add(this.total, remainder);
    return this.toDelta(remainder);
  }
  lastCumulative(): ExternalTokenCounts | undefined {
    return this.prev;
  }
  totals(): UsageLedgerTotals {
    return {
      usage: this.toDelta(this.total),
      credits: this.total.credits,
      thinking: this.total.thinking,
      childTokens: 0,
      overcount: false,
      pricing:
        this.pricing.status === "priced"
          ? { status: "priced", source: this.pricing.source, basis: this.pricing.basis }
          : { status: "unpriced", reason: this.pricing.reason },
    };
  }
}

// ── TranscriptWriter ──
export class FakeTranscript implements TranscriptWriter {
  readonly appended: { type: string; message?: unknown; customType?: string; data?: unknown }[] = [];
  private closed = false;
  constructor(
    readonly path: string,
    public header: TranscriptHeader | undefined,
    public resume: boolean,
  ) {}
  append(entry: { type: "message"; message: unknown } | { type: "custom"; customType: string; data: unknown }): string {
    this.appended.push(entry);
    return `t${this.appended.length}`;
  }
  leafId(): string | undefined {
    return this.appended.length > 0 ? `t${this.appended.length}` : undefined;
  }
  branch(): [] {
    return [];
  }
  failed(): boolean {
    return false;
  }
  close(): void {
    this.closed = true;
  }
  get isClosed(): boolean {
    return this.closed;
  }
}

// ── CatalogStore ──
export class FakeCatalogStore implements CatalogStore {
  readonly written: ExternalCatalog[] = [];
  onDisk: ExternalCatalog | undefined;
  read(): ExternalCatalog | undefined {
    return this.onDisk;
  }
  write(catalog: ExternalCatalog): void {
    this.written.push(catalog);
    this.onDisk = catalog;
  }
}

// ── ExternalFrameworkDeps ──
export interface FakeDeps {
  deps: ExternalFrameworkDeps;
  clock: FakeClock;
  children: FakeChild[];
  rpcs: FakeRpc[];
  transcripts: FakeTranscript[];
  ledgers: FakeLedger[];
  spawnOpts: ManagedChildOptions[];
  warnings: string[];
  spawnError?: Error;
  rpcHandler?: FakeRpcHandler | undefined;
  readHeader?: (path: string) => TranscriptHeader | undefined;
}

export function makeFakeDeps(agentDir = "/tmp/fake-agent"): FakeDeps {
  const clock = new FakeClock(1_000_000);
  const out: FakeDeps = {
    clock,
    children: [],
    rpcs: [],
    transcripts: [],
    ledgers: [],
    spawnOpts: [],
    warnings: [],
    deps: undefined as unknown as ExternalFrameworkDeps,
  };
  out.deps = {
    spawnChild: (o) => {
      if (out.spawnError) throw out.spawnError;
      out.spawnOpts.push(o);
      const child = new FakeChild();
      out.children.push(child);
      return child;
    },
    createRpc: (opts) => {
      const rpc = new FakeRpc(opts);
      rpc.dynamicHandler = () => out.rpcHandler;
      out.rpcs.push(rpc);
      return rpc;
    },
    openTranscript: (o) => {
      const t = new FakeTranscript(o.path, o.header, o.resume);
      out.transcripts.push(t);
      return t;
    },
    readTranscriptHeader: (path) => out.readHeader?.(path),
    createLedger: (pricing, opts) => {
      const l = new FakeLedger(pricing, opts);
      out.ledgers.push(l);
      return l;
    },
    catalogStore: new FakeCatalogStore(),
    clock,
    agentDir,
    redact: (t) => t.replaceAll("SECRET", "***"),
    warnOnce: (_key, message) => {
      out.warnings.push(message);
    },
  };
  return out;
}

// ── 规格构造 ──
export function makeSpec(over: {
  cwd?: string;
  modelId?: string;
  resume?: boolean;
  persist?: boolean;
  pricing?: ExternalPricing;
  thinkingLevel?: string;
  contextBlocks?: ExternalSessionSpec["external"]["contextBlocks"];
  rolePrompt?: string;
  schema?: ExternalSessionSpec["external"]["schema"];
}): ExternalSessionSpec {
  const pricing: ExternalPricing = over.pricing ?? {
    status: "priced",
    source: "openai/gpt-6-luna",
    basis: "upstream",
    approx: false,
    table: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
  };
  return {
    cwd: over.cwd ?? "/tmp/fake-cwd",
    external: {
      provider: "droid",
      modelId: over.modelId ?? "gpt-6-luna",
      ...(over.thinkingLevel === undefined ? {} : { thinkingLevel: over.thinkingLevel }),
      roleName: "tester",
      ...(over.rolePrompt === undefined ? {} : { rolePrompt: over.rolePrompt }),
      contextBlocks: over.contextBlocks ?? [],
      ...(over.schema === undefined ? {} : { schema: over.schema }),
      persistTranscript: over.persist ?? true,
      runId: "run-1",
      pricing,
      degraded: [],
    },
  };
}

/** droid settings_updated 全量 echo 通知载荷。 */
export function settingsEcho(modelId = "gpt-6-luna", autonomyLevel = "high", reasoningEffort = "low"): unknown {
  return {
    type: "settings_updated",
    settings: { modelId, reasoningEffort, autonomyMode: `auto-${autonomyLevel}`, autonomyLevel },
  };
}

/** 驱动 provider 流程的假 RPC handler：init/update/close 正常应答，update 前发全量 echo。 */
export function standardRpcHandler(
  rpc: FakeRpc,
  over: { modelId?: string; sessionId?: string; autonomy?: string; loadMissing?: boolean } = {},
): FakeRpcHandler {
  const modelId = over.modelId ?? "gpt-6-luna";
  const sessionId = over.sessionId ?? "12345678-abcd-4321-9876-abcdef012345";
  return (method, params) => {
    if (method === "droid.initialize_session") {
      return {
        sessionId,
        hostId: "h",
        session: { messages: [] },
        settings: { modelId, reasoningEffort: "low", autonomyLevel: over.autonomy ?? "high" },
        availableModels: [
          {
            id: modelId,
            modelProvider: "openai",
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "low",
            deprecated: false,
          },
        ],
      };
    }
    if (method === "droid.load_session") {
      if (over.loadMissing === true)
        return Object.assign(new Error("JSON-RPC error -32004 on droid.load_session: Session not found"), {
          rpcCode: -32004,
        });
      // 形状对齐 resume-memory.md E5：无顶层 sessionId，带 session.messages / settings / tokenUsage。
      return {
        hostId: "h",
        session: { messages: [{ id: "m1", role: "user", content: [] }] },
        settings: { modelId, reasoningEffort: "low", autonomyLevel: over.autonomy ?? "high" },
        tokenUsage: { inputTokens: 5000, outputTokens: 900 },
        workingState: "idle",
        hasOlderMessages: false,
        availableModels: [
          {
            id: modelId,
            modelProvider: "openai",
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "low",
            deprecated: false,
          },
        ],
      };
    }
    if (method === "droid.update_session_settings") {
      rpc.notifyDroid(settingsEcho((params as { modelId?: string }).modelId ?? modelId, over.autonomy ?? "high"));
      return {};
    }
    if (method === "droid.add_user_message") return {};
    if (method === "droid.interrupt_session") return {};
    if (method === "droid.close_session") return {};
    if (method === "droid.get_context_stats") return { used: 100, remaining: 900, limit: 1000, accuracy: "estimated" };
    return new Error(`unexpected method ${method}`);
  };
}
