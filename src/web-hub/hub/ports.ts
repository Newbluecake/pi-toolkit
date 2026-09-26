/**
 * hub internal ports (plan §1.4.1 / §2.3 / §4 / §5.1 / §6.2 / §9.2 — frozen
 * interface, S1-W1 接口包). Types only, no runtime code: package B implements
 * these (hub core + history), package C consumes them (HTTP/SSE frontend),
 * LD/LS/LC (W2/W3) implement the LAN ports — this file is what lets every
 * package compile in parallel against a frozen surface.
 *
 * `LanStorePort` / `KdfPort` / `LoginLimiterPort` / `KdfAdmissionPort`: the
 * plan's §4 / §5.1 / §6.2 prose names these ports and their call sites
 * (`store.createSession`, `store.touchSession`, `kdf.run`, `limiter.admit` /
 * `.fail`, …) but does not spell out full method signatures anywhere. W1
 * freezes a conservative shape assembled from every call site mentioned in
 * the plan, flagged for the record: LS/LC (W2) may refine field types
 * (nothing about them is exercised by W1's own runtime code — `lan-
 * assembly.ts`'s stub throws before ever constructing one) but a signature
 * change that breaks an existing caller must come back through W1's review
 * per §11's "改签名 ⇒ 回到 W1 文件重新过 typecheck + 契约测试".
 */
import type { AgentCard, HistoryPayload } from "../protocol/http-contract.js";
import type { HostTokenRejectReason, LanOffReason, LanStatus } from "../protocol/lan.js";
import type { AgentId, FleetRowWire, SessionInfo, StatusInfo, WireEntry, WireEvent } from "../protocol/messages.js";
import type { HubPaths } from "../protocol/paths.js";
import type { PROTO } from "../protocol/version.js";
import type { Scope } from "./lifecycle.js";

export type { LanOffReason, LanStatus } from "../protocol/lan.js";

// ---------------------------------------------------------------------------
// §1.4.1 双 listener 组合契约
// ---------------------------------------------------------------------------

export type ListenerKind = "loopback" | "lan";

export interface HubLanConfig {
  port: number; // ≠ config.port
  extraHosts: string[]; // 已通过 classifyHostToken（env 解析再校验一次）
  trustProxyFrom: string[]; // IPv4 字面量；空 ⇒ 不解析任何转发头
  externalOrigins: string[]; // 只允许 https（§2.4）；与 trustProxyFrom 同时非空或同时为空
}

export interface RequestContext {
  readonly kind: ListenerKind;
  readonly peerIp: string; // socket 对端（去 ::ffff:）
  readonly viaTrustedProxy: boolean; // peerIp ∈ trustProxyFrom
  readonly clientIp: string; // 直连 = peerIp；经代理 = XFF 链上第一个不受信任的地址（解析失败 ⇒ peerIp）
  readonly scheme: "http" | "https"; // 直连恒 http；经代理恒 https（XFP 非 https ⇒ 400，不会构造出 ctx）
  readonly hostKey: string; // canonicalHostKey（小写、显式端口）
  readonly externalOrigin: string; // canonicalOrigin（浏览器形式）
  readonly snapshot?: HostSnapshot; // kind === "lan" 时那一次读取的快照
}

export interface LanFrontendDeps {
  cfg: HubLanConfig;
  store: LanStorePort; // §4
  kdf: KdfPort; // §5.1
  limiter: LoginLimiterPort; // §6.2
  admission: KdfAdmissionPort; // §6.2
  hosts: HostsPort; // §2.3
  scope: Scope; // §3
  onStatus(s: LanStatus): void; // hub.ts 收到后重写 hub.json.lan
}

export interface LanFacade {
  start(): Promise<LanStatus>; // §3 controller.start()；受 LAN_START_DEADLINE_MS 约束
  status(): LanStatus;
  close(): Promise<void>; // 关闭 LAN listener 与其 SSE（≤2s）；loopback 不受影响
  revoke(target: { sidHash: string } | { userId: number }): number; // 同步关闭匹配的 LAN SSE，返回条数
}

/** hub.ts 用来装配 LanFrontendDeps 的接缝（LD 提供默认实现 hub/lan-assembly.ts；测试注入假件） */
export interface LanAssembly {
  build(args: {
    cfg: HubLanConfig;
    paths: HubPaths;
    log: HubLog;
    now: () => number;
    scope: Scope;
    onStatus(s: LanStatus): void;
  }): Promise<LanFrontendDeps>;
}

// ---------------------------------------------------------------------------
// §2.3 快照、重算与传输插槽
// ---------------------------------------------------------------------------

export interface HostSnapshot {
  readonly gen: number;
  readonly hostKeys: ReadonlySet<string>; // 直连白名单：canonicalHostKey 集合
  readonly externalOrigins: ReadonlySet<string>; // 经受信任代理的白名单：canonicalOrigin 集合（来自配置，不随接口变化）
  readonly trustProxyFrom: ReadonlySet<string>; // IPv4 字面量
  readonly omitted: readonly { host: string; reason: HostTokenRejectReason }[];
  readonly computedAt: number;
}

export interface LanListenerHandle {
  readonly port: number;
  current(): HostSnapshot;
  swap(next: HostSnapshot): void; // 同步替换引用
  close(): Promise<void>; // 上限 2s
}

export interface LanTransport {
  bind(port: number, first: HostSnapshot, signal: AbortSignal): Promise<LanListenerHandle>;
}

export interface HostsPort {
  compute(cfg: HubLanConfig): HostSnapshot; // 纯计算 + os.networkInterfaces()/os.hostname()，同步、无 I/O
}

// ---------------------------------------------------------------------------
// §6.3 ConnGuard（审查修复 #9：冻结接口、以 lease 替代 peerIp 键释放）
// ---------------------------------------------------------------------------

/**
 * A connection's admission lease (§6.3). `admit()` allocates a monotonic
 * `seq` internally and tracks this lease's *own* category so that `release()`
 * always decrements the right pool/IP counter even when the same `peerIp`
 * holds several concurrent connections — releasing by `peerIp` alone (as an
 * earlier draft of this port did) would double-release or mis-attribute
 * category transitions across those connections. `release()` is idempotent;
 * `enterLoginPending()`/`enterAuthed()` move this lease out of the
 * eligible-for-eviction `unauth` category (§6.3's class table) and are also
 * idempotent (a repeated call is a no-op).
 */
export interface ConnLease {
  readonly peerIp: string;
  readonly viaTrustedProxy: boolean;
  enterLoginPending(): void;
  enterAuthed(): void;
  release(): void;
}

export interface ConnGuard {
  /**
   * Admit a new connection into the direct or proxy pool (by
   * `viaTrustedProxy`). Returns `undefined` when §6.3's eviction rules found
   * nothing evictable and the pool is at capacity — the caller must
   * `socket.destroy()` the new connection without a response. LC (W2) wires
   * this to `net.Server`'s `connection`/`close` events; W1's port stays
   * decoupled from `net.Socket` on purpose (easier to fake in tests).
   */
  admit(args: { peerIp: string; viaTrustedProxy: boolean }): ConnLease | undefined;
}

// ---------------------------------------------------------------------------
// port-level cancellation (审查修复 #9): every port operation that may queue or
// run long enough to matter accepts an optional AbortSignal so a disconnected
// caller's waiter can be removed instead of leaking until its own deadline.
// Concrete deadline *values* stay each port's own implementation detail (not
// frozen here) — only the cancellation shape is part of the frozen surface.
// ---------------------------------------------------------------------------

export interface PortOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// §4 LanStorePort（W1 保守占位 — 见文件头说明）
// ---------------------------------------------------------------------------

export interface LanUserRecord {
  id: number;
  username: string;
  kdf: "scrypt";
  n: number;
  r: number;
  p: number;
  salt: Uint8Array;
  hash: Uint8Array;
  epoch: number;
  initialPassword?: string;
  initialCreatedAt?: number;
  initialLoginAt?: number;
  initialLoginIp?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LanSessionRecord {
  userId: number;
  epoch: number;
  boundOrigin: string;
  expiresAt: number;
  absoluteExpiresAt: number;
}

export interface LanStorePort {
  getUser(username: string, opts?: PortOptions): Promise<LanUserRecord | undefined>;
  initialInfo(
    opts?: PortOptions,
  ): Promise<{ username: string; initialPassword?: string; initialLogin?: { ip: string; at: number } } | undefined>;
  createSession(
    input: { userId: number; epoch: number; boundOrigin: string; createdIp: string; now: number },
    opts?: PortOptions,
  ): Promise<{ sidHash: string }>;
  touchSession(sidHash: string, now: number, opts?: PortOptions): Promise<LanSessionRecord | undefined>;
  deleteSession(sidHash: string, opts?: PortOptions): Promise<void>;
  deleteAllSessions(userId: number, opts?: PortOptions): Promise<void>;
  setPassword(
    input: { username: string; kdf: "scrypt"; n: number; r: number; p: number; salt: Uint8Array; hash: Uint8Array },
    opts?: PortOptions,
  ): Promise<void>;
  markInitialLogin(username: string, ip: string, at: number, opts?: PortOptions): Promise<void>;
  purgeExpired(now: number, opts?: PortOptions): Promise<number>;
}

// ---------------------------------------------------------------------------
// §5.1 KdfPort（W1 保守占位）
// ---------------------------------------------------------------------------

export interface KdfParams {
  n: number;
  r: number;
  p: number;
  keyLen: number;
  salt: Uint8Array;
}

export interface KdfPort {
  run(password: string, params: KdfParams, opts?: PortOptions): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// §6.2 LoginLimiterPort / KdfAdmissionPort（W1 保守占位）
// ---------------------------------------------------------------------------

export interface LoginLimiterPort {
  admit(clientIp: string): { ok: true } | { ok: false; retryAfterMs: number; saturated?: boolean };
  fail(clientIp: string): void;
  succeed(clientIp: string): void;
  unlock(): void;
}

export interface KdfAdmissionPort {
  /**
   * Queues for a KDF run slot (§6.2's fair-scheduling waiter). Must honor
   * `opts.signal`: an aborted/disconnected caller's waiter is removed from
   * the queue instead of leaking until it would have otherwise timed out.
   */
  acquire(
    clientIp: string,
    fresh: boolean,
    opts?: PortOptions,
  ): Promise<{ ok: true; release(): void } | { ok: false; retryAfterMs: number }>;
}

// ---------------------------------------------------------------------------
// existing (P1) ports
// ---------------------------------------------------------------------------

export interface HubConfig {
  v: 1;
  home: string;
  port: number;
  idleExitMinutes: number;
  pluginVersion: string;
  buildId: string;
  launcher?: [string, string];
  lan?: HubLanConfig;
}

export interface HubLog {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

export interface AgentView extends AgentCard {
  agentId: AgentId;
  connectedAt: number;
  lastFrameAt: number;
  seq: number;
}

export interface RegistryView {
  list(): readonly AgentView[];
  get(agentKey: string): AgentView | undefined;
}

export type HubEvent =
  | { type: "agent_up"; agent: AgentCard }
  | { type: "agent_down"; agentKey: string; reason: string }
  | { type: "agent_stale"; agentKey: string }
  | { type: "session"; agentKey: string; session: SessionInfo }
  | { type: "ev"; agentKey: string; seq: number; e: WireEvent }
  | { type: "status"; agentKey: string; status: StatusInfo }
  | { type: "fleet"; agentKey: string; runs: FleetRowWire[] }
  | { type: "prompt"; agentKey: string; prompts: AgentCard["prompts"] }
  | { type: "gap"; agentKey: string; fromSeq: number }
  | { type: "append"; agentKey: string; entries: WireEntry[] };

export interface HubBus {
  subscribe(fn: (e: HubEvent) => void): () => void;
}

export interface HistoryService {
  snapshot(agentKey: string): Promise<HistoryPayload>; // §7 步骤 1-4；deadline TIMING.snapshotMs → reject E_DEADLINE
  page(agentKey: string, beforeEntryId: string, limit: number): Promise<HistoryPayload>;
  onLeafChanged(agentKey: string, leafId: string | null): void; // status.leafId 变化时调用；有订阅者才工作，500ms 去抖；结果经 bus `append` 事件发出
}

export interface HubInfo {
  version: string;
  buildId: string;
  pid: number;
  startedAt: number;
  proto: typeof PROTO;
}

export interface FrontendDeps {
  config: HubConfig;
  paths: HubPaths;
  registry: RegistryView;
  bus: HubBus;
  history: HistoryService;
  log: HubLog;
  info: () => HubInfo;
  now: () => number;
  lan?: LanFrontendDeps;
}

export interface HttpFrontend {
  listen(opts?: { signal?: AbortSignal }): Promise<{ port: number }>; // loopback；新增可选 opts：已 aborted ⇒ 立即 reject；listen 进行中 abort ⇒ reject 且迟到的 listening 回调自己 server.close()
  close(): Promise<void>; // 变更语义：同时关闭 lan（如有），先 lan 再 loopback
  clientCount(): number; // 变更语义：两个 listener 的 SSE 之和（idle 判定不变）
  lan?: LanFacade; // 仅当 deps.lan !== undefined
}

export type FrontendFactory = (deps: FrontendDeps) => HttpFrontend;
