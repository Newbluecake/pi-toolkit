/**
 * 外部 agent 框架接口（external-agent plan §2.9，P1 冻结面）。
 *
 * 纯类型：只 `import type`，零运行时依赖。P2（框架实现）与 P3（droid 适配器）都只
 * 消费本文件与 `src/core/**` 的类型/纯函数，互不 import 对方实现——装配（P5 port.ts）
 * 经 `ExternalFrameworkDeps` 注入工厂。后续包不得改本文件签名（plan §2 冻结规则）。
 */
import type { Clock } from "../core/clock.js";
import type { ClassifiedError } from "../core/errors.js";
import type {
  DriverEvent,
  ExternalPriceTable,
  ExternalPricing,
  ExternalPricingDiag,
  ExternalRunSpec,
  JsonSchema,
  SessionSpec,
  UsageDelta,
} from "../core/types.js";
import type { DroidPricingOverride } from "../config/settings.js";
import type { SessionHandle } from "../runtime/session-driver.js";

export type ExternalSessionSpec = SessionSpec & { external: ExternalRunSpec };

// ── provider 与句柄 ──
export interface ExternalSessionHandle extends SessionHandle {
  readonly provider: string;
  /** RoutingSessionDriver.bind 委托；同步注册，只可调用一次（第二次 throw）。 */
  attach(onEvent: (e: DriverEvent) => void): void;
}
export interface ExternalAgentProvider {
  readonly id: string; // "droid"
  ownsSessionFile(path: string): boolean; // 路径前缀 + 头行 provider（有界同步读 ≤64KiB）
  create(spec: ExternalSessionSpec): Promise<ExternalSessionHandle>;
  /** 进程 cwd 与 initialize_session.cwd 一律取 transcript 头行 cwd（忽略 spec.cwd）；头行 cwd 不存在/非目录 ⇒
   *  reject ClassifiedError{config, msgResumeCwdGone(cwd)}，不起进程（§4.4）。 */
  resume(sessionFile: string, spec: ExternalSessionSpec): Promise<ExternalSessionHandle>;
  readonly catalog: ExternalCatalogPort;
  /** stack 重建时调用：停目录探测；不杀运行中的 run。幂等。 */
  dispose(): void;
}

// ── 模型目录 ──
export interface ExternalModelInfo {
  id: string;
  displayName?: string;
  upstreamProvider?: string; // availableModels[].modelProvider：anthropic|openai|google|xai|factory
  kind?: string; // "router" 等
  tokenMultiplier?: number;
  reasoningEfforts: readonly string[];
  defaultEffort?: string;
  deprecated: boolean;
}
export interface ExternalCatalog {
  provider: string;
  fetchedAt: number;
  agentVersion?: string;
  protocolVersion?: string;
  binaryFingerprint?: string; // realpath|size|mtimeMs|ino
  models: readonly ExternalModelInfo[];
  drift?: { expected: string; actual: string };
}
export interface ExternalCatalogPort {
  snapshot(): ExternalCatalog | undefined; // 同步：内存→磁盘缓存；绝不 spawn
  refreshInBackground(reason: "stack_build" | "binary_changed" | "stale"): void; // single-flight、有界、unref、失败静默
  observeInit(models: unknown, protocolVersion: string | undefined): void;
}
export interface CatalogStore {
  read(provider: string): ExternalCatalog | undefined; // 损坏/超限 ⇒ undefined
  write(catalog: ExternalCatalog): void; // 原子写 0600、≤256KiB；失败静默（warn 一次）
}

// ── service/stack 门面 ──
export interface ExternalAdvertisedModel {
  provider: string;
  id: string;
  name?: string;
  note?: string;
}
export interface PlanRunInput {
  runId: string;
  model: { provider: string; id: string };
  thinkingLevel?: string;
  typeName: string;
  rolePrompt?: string;
  canSpawn: boolean;
  canMessage: boolean;
  declaresTools: boolean;
  schema?: JsonSchema;
  resume: boolean;
  cwd: string; // H2 之后的 cwd（resume 时仅用于诊断，provider 以头行为准）
  persist: boolean;
}
export interface ExternalAgentsPort {
  owns(provider: string): boolean;
  /** true 已知 / false 确定未知 / undefined 目录不可用（fail-open，交给 init+update 校验）。 */
  exists(ref: { provider: string; id: string }): boolean | undefined;
  /** 漂移（strict）/ 二进制缺失 / provider 名冲突 等整体不可用原因；有值即准入拒绝。 */
  unavailableReason(provider: string): string | undefined;
  unknownModelMessage(ref: { provider: string; id: string }): string;
  advertised(): readonly ExternalAdvertisedModel[];
  ownerOfSessionFile(path: string): string | undefined;
  /** 纯同步：定价（60s memo）+ 记忆块渲染（有界同步读）+ 能力块；不起进程。 */
  planRun(input: PlanRunInput): ExternalRunSpec;
  pricingFor(ref: { provider: string; id: string }): ExternalPricing;
  dispose(): void;
}

// ── 进程 ──
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
export interface ManagedChildOptions {
  binary: string;
  args: readonly string[];
  cwd: string;
  /** 子进程 env = { ...process.env, ...extraEnv }（凭据随 process.env 继承，不读取、不打印、不持久化）。 */
  extraEnv: Readonly<Record<string, string>>;
  killGraceMs: number;
  ownerWatchdog: boolean; // DROID_EXITS_ON_STDIN_EOF=false 时为 true：sh 哨兵包裹（§4.1）
  clock: Clock;
}
export interface ManagedChild {
  readonly pid: number;
  onStdout(cb: (chunk: Buffer) => void): void;
  /** false ⇒ 背压（行仍在 Node 缓冲）；stdin 已销毁/EPIPE ⇒ throw ClassifiedError{internal}。 */
  write(line: string): boolean;
  onDrain(cb: () => void): void;
  readonly exited: Promise<ChildExit>; // 永不 reject
  exitInfo(): ChildExit | undefined;
  /** "graceful"：stdin.end + SIGTERM 组 + killGraceMs 后 SIGKILL 组；"now"：立即 SIGKILL 组。幂等。 */
  terminate(mode: "graceful" | "now"): { signalled: boolean; error?: string };
  terminating(): boolean;
  graceExpired(): boolean;
  stderrTail(maxBytes?: number): string; // 已脱敏，默认 2KiB
}
/** 同步 spawn；ENOENT ⇒ throw ClassifiedError{config}；EAGAIN/EMFILE ⇒ ClassifiedError{startup_transient, retryable:true}。 */
export type SpawnChild = (o: ManagedChildOptions) => ManagedChild;

// ── JSON-RPC ──
export type EnvelopeVerdict = { ok: true } | { ok: false; drift: { expected: string; actual: string } };
export interface Envelope {
  decorate(msg: Record<string, unknown>): Record<string, unknown>;
  /** 入站消息 factoryProtocolVersion/factoryApiVersion 比对（S6：droid 每条入站消息都带自身版本）。 */
  check(msg: Record<string, unknown>): EnvelopeVerdict;
}
export type RequestReply = { result: unknown } | { error: { code: number; message: string } };
export interface JsonRpcClientOptions {
  envelope: Envelope;
  /** 抛错 = 写不出去（进程死/EPIPE）。 */
  write(line: string): boolean;
  onNotification(method: string, params: unknown): void;
  /** 同步应答，绝不悬挂。抛错 ⇒ 客户端回 -32603 并 onProtocolError；应答 write 抛错 ⇒ onProtocolError。 */
  onRequest(method: string, id: string, params: unknown): RequestReply;
  onDrift(d: { expected: string; actual: string }): void;
  onProtocolError(e: ClassifiedError): void; // 致命
  clock: Clock;
  maxLineBytes?: number; // 默认 8 MiB
}
export interface JsonRpcClient {
  feed(chunk: Buffer | string): void;
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T>; // 超时 ⇒ ClassifiedError{internal}
  failAll(e: ClassifiedError): void;
  stats(): { lateResponses: number; nonJsonLines: number };
}
export type CreateJsonRpcClient = (o: JsonRpcClientOptions) => JsonRpcClient;

// ── transcript（格式冻结见 §4.6） ──
export interface TranscriptHeader {
  type: "external_session";
  version: 1;
  provider: string;
  sessionId: string;
  cwd: string; // create 时进程实际 cwd 的绝对 realpath；resume 的唯一 cwd 来源
  modelId: string;
  createdAt: string;
  roleName: string;
  runId: string;
}
export interface TranscriptEntry {
  type: "message" | "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: unknown;
  customType?: string;
  data?: unknown;
}
export interface TranscriptWriter {
  readonly path: string;
  append(
    entry: { type: "message"; message: unknown } | { type: "custom"; customType: string; data: unknown },
  ): string | undefined;
  leafId(): string | undefined;
  branch(): readonly TranscriptEntry[];
  failed(): boolean;
  close(): void; // 同步、幂等
}
export type OpenTranscript = (o: {
  path: string;
  header?: TranscriptHeader;
  resume: boolean;
  maxFileBytes?: number;
}) => TranscriptWriter;
export type ReadTranscriptHeader = (path: string) => TranscriptHeader | undefined;

// ── 用量账本（§3.3） ──
export interface ExternalTokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  credits: number;
}
export interface UsageLedgerTotals {
  usage: UsageDelta;
  credits: number;
  thinking: number;
  childTokens: number;
  overcount: boolean;
  pricing: ExternalPricingDiag;
}
export interface UsageLedger {
  beginTurn(baseline: ExternalTokenCounts | undefined): void;
  /** lastCall：droid lastCallTokenUsage（有则用于 tier 选择，S10）。 */
  observeCumulative(cum: ExternalTokenCounts, lastCall?: ExternalTokenCounts): UsageDelta | undefined;
  completeTurn(turnTotal: ExternalTokenCounts, child?: ExternalTokenCounts): UsageDelta | undefined;
  lastCumulative(): ExternalTokenCounts | undefined;
  totals(): UsageLedgerTotals;
}
export type CreateUsageLedger = (
  pricing: ExternalPricing,
  opts: { thinkingInOutput: boolean; cumulativeIncludesChild: boolean },
) => UsageLedger;

// ── 定价（§3.1） ──
export interface PriceCandidate {
  provider: string;
  id: string;
  cost?: ExternalPriceTable;
}
export type ResolveExternalPricing = (input: {
  modelId: string;
  info?: ExternalModelInfo;
  registry: readonly PriceCandidate[] | undefined;
  override?: DroidPricingOverride;
}) => ExternalPricing;
export type PriceUsage = (
  tokens: Pick<UsageDelta, "input" | "output" | "cacheRead" | "cacheWrite">,
  table: ExternalPriceTable,
  requestInputTokens?: number, // tier 选择依据；缺省 = input+cacheRead+cacheWrite
) => number;

// ── 框架依赖注入（P5 port.ts 组装；P3 只消费） ──
export interface ExternalFrameworkDeps {
  spawnChild: SpawnChild;
  createRpc: CreateJsonRpcClient;
  openTranscript: OpenTranscript;
  readTranscriptHeader: ReadTranscriptHeader;
  createLedger: CreateUsageLedger;
  catalogStore: CatalogStore;
  clock: Clock;
  agentDir: string;
  redact(text: string): string;
  warnOnce(key: string, message: string): void;
}
