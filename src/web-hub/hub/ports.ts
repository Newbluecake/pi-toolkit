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
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentCard, HistoryPayload } from "../protocol/http-contract.js";
import type { AvatarInfo, AvatarPath } from "../protocol/avatar.js";
import type {
  ProxyCapReason,
  ProxyDenyReason,
  ProxyLimitReason,
  ProxyListResponse,
  ProxyOpenResult,
  ProxyUnavailableExtraReason,
} from "../protocol/proxy.js";
import type { ClientAllowSnapshot, HostTokenRejectReason, LanOffReason, LanStatus } from "../protocol/lan.js";
import type {
  AgentId,
  CmdArgs,
  CmdData,
  CmdErrorCode,
  CmdFrame,
  CmdOp,
  CmdOrigin,
  CmdResultFrame,
  CommandInfoWire,
  DialogClosedWire,
  DialogWire,
  CtlItemWire,
  FleetRowWire,
  FleetOmitted,
  SessionInfo,
  StatusInfo,
  WireEntry,
  WireEvent,
  LoadWire,
} from "../protocol/messages.js";
import type { FeishuBotHubConfig } from "../protocol/feishu.js";
import type { HubCrossSessionConfig } from "./xs/limits.js";
import type { HubScheduleConfig } from "../protocol/schedule.js";
import type { CommandCompleteRoutes } from "./command-complete.js";
import type { CmdLimit } from "./cmd-limit.js";
import type { HubPaths } from "../protocol/paths.js";
import type { AgentRemoveFrontendPort } from "./agent-remove.js";
import type { AuthIdentity, IdentityResult } from "./auth-identity.js";
import type { AuthRevokeBus, AuthRevokeEvent } from "./auth-revoke.js";
import type {
  RunEndFrame,
  RunEvFrame,
  RunGapFrame,
  RunEndPayload,
  RunEvPayload,
  RunHistoryError,
  RunHistoryPayload,
} from "../protocol/run-transcript.js";
import type { HubSpawnConfig, SpawnsPayload } from "../protocol/spawn.js";
import type { CommitRef, HubUiBuildWire, VersionInfoWire } from "../protocol/version-info.js";
import type { PROTO } from "../protocol/version.js";
import type { Scope } from "./lifecycle.js";
import type { ReqDeadline } from "./req-deadline.js";
import type { SpawnFrontendPort } from "./spawn/ports.js";
import type { UiServer } from "./static.js";
import type { UiStatus } from "./ui-root.js";
import type { UploadStore } from "./uploads.js";
import type { UploadHttpMetrics } from "./audit.js";

import type { LanFactorBody, LanLoginResponse } from "../protocol/lan-2fa.js";
import type { SecurityEventBus } from "./security-events.js";

export type { LanOffReason, LanStatus } from "../protocol/lan.js";

// ---------------------------------------------------------------------------
// §1.4.1 双 listener 组合契约
// ---------------------------------------------------------------------------

export type ListenerKind = "loopback" | "lan";

export interface HubLanConfig {
  /** Absent = unrestricted; present [] = explicit deny-all. Canonical CIDRs only, ≤64. */
  allowClients?: string[];
  /** Absent = 720 min. 5–10080 min, integral milliseconds. */
  sessionIdleMs?: number;
  port: number; // ≠ config.port
  extraHosts: string[]; // 已通过 classifyHostToken（env 解析再校验一次）
  trustProxyFrom: string[]; // IPv4 字面量；空 ⇒ 不解析任何转发头
  externalOrigins: string[]; // 只允许 https（§2.4）；与 trustProxyFrom 同时非空或同时为空
}

export interface RequestContext {
  readonly kind: ListenerKind;
  readonly peerIp: string; // socket 对端（去 ::ffff:）
  readonly viaTrustedProxy: boolean; // peerIp ∈ trustProxyFrom
  /** P0 additive compatibility: absent means UNUSABLE, never trusted XFF. I sets on wiring. */
  readonly xffUsable?: boolean;
  /** I supplies the request UA for cancel's binding check (no LoginIo on that entry). */
  readonly ua?: string;
  readonly clientIp: string; // 直连 = peerIp；经代理 = XFF 链上第一个不受信任的地址（解析失败 ⇒ peerIp）
  readonly scheme: "http" | "https"; // 直连恒 http；经代理恒 https（XFP 非 https ⇒ 400，不会构造出 ctx）
  readonly hostKey: string; // canonicalHostKey（小写、显式端口）
  readonly externalOrigin: string; // canonicalOrigin（浏览器形式）
  readonly snapshot?: HostSnapshot; // kind === "lan" 时那一次读取的快照
}

export interface LanFrontendDeps {
  /** Optional body-free observation AFTER LAN cookie/session authentication succeeds. */
  onAuthenticated?(ctx: RequestContext): void;
  /** Shared hub-owned allowlist, injected by startHub after assembly; required by the HTTP frontend. */
  clientAllow?: ClientAllowGuard;
  /** Open-time history repair notice; never inferred from a missing account. */
  loginIpsRebuiltAt?: number;
  security?: SecurityEventBus;
  /** Internal rollout gate, NOT a setting. Production enables it together with LAN capabilities. */
  secondFactorEnabled?: boolean;
  approval?: LoginApprovalPort;
  /** Core registration for the late-bound Feishu decision sink. Cleared on dispose. */
  onLoginCore?(core: LanLoginCore | undefined): void;
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
    /** Optional until I wires E's transition-only limiter events. */
    security?: SecurityEventBus;
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
// §6.3 ConnGuard（审查修复 #9、1轮：冻结接口、以 lease 替代 peerIp 键释放；审查修复 #4、2轮：
// admit() 新增 onEvict 回调，使“淡汰旧连接并 destroy”（§6.3）可表达
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
 *
 * `leaveLoginPending()` (LC review fix, lan-plan.md §15.8 实施偏差记录) is the
 * missing inverse: §6.3's class table has every *login-pending* request end
 * (success, failure, 429, or an exception/timeout from the store or KDF)
 * either promote to `authed` (`enterAuthed()`) or fall back to the
 * evictable `unauth` category — there was previously no way to express the
 * latter, so a socket that took a KDF admission slot and then failed to log
 * in stayed `login-pending` (never evictable) for the rest of its
 * connection lifetime. A no-op when the lease is already `authed`,
 * `released`, or already `unauth` (idempotent, like the other two).
 */
export interface ConnLease {
  readonly peerIp: string;
  readonly viaTrustedProxy: boolean;
  enterLoginPending(): void;
  enterAuthed(): void;
  leaveLoginPending(): void;
  release(): void;
}

export interface ConnGuard {
  /**
   * Admit a new connection into the direct or proxy pool (by
   * `viaTrustedProxy`). Returns `undefined` when §6.3's eviction rules found
   * nothing evictable and the pool is at capacity — the caller must
   * `socket.destroy()` the *new* connection without a response.
   *
   * `args.onEvict` is registered against the returned lease and is invoked
   * *at most once* if §6.3's eviction rules pick *this* connection to make
   * room for a *later* admission. The caller must `socket.destroy()` its
   * *own* connection when `onEvict` fires; this is how eviction is
   * expressed without `ConnGuard` needing to hold a `net.Socket` reference
   * itself (§6.3: "淡汰 = socket.destroy()（无 HTTP 响应。。。选择、计数、
   * destroy、接纳都在同一个同步的 connection 处理块中完成"). `onEvict` firing
   * does *not* itself call `release()` — the evicted connection's own
   * `socket.destroy()`/`'close'` handling is still responsible for that,
   * same as any other connection closing.
   *
   * Frozen `onEvict` semantics (review fix round 3 #3 — pin these so LC, W2,
   * doesn't have to guess, and so the fake below and any real implementation
   * agree):
   *
   *   1. **Synchronous, in-turn**: `onEvict` is called synchronously from
   *      *inside* the *evicting* `admit()` call (never deferred to a later
   *      turn, never called from the call that originally registered it) —
   *      matching §6.3's "选择、计数、destroy、接纳都在同一个同步的
   *      connection 处理块中完成". The caller can `socket.destroy()`
   *      unconditionally inside it without worrying about ordering.
   *   2. **Non-reentrant**: `onEvict` must never call `admit()` itself
   *      (directly or indirectly, while still inside the evicting `admit()`
   *      call). An implementation must reject such a reentrant call —
   *      either by throwing a descriptive `Error` or by treating it as a
   *      capacity rejection (`undefined`) — *without* changing any pool's
   *      state (no lease is allocated, no other entry is evicted, the
   *      original eviction+admission that triggered it still completes
   *      normally once `onEvict` returns/throws).
   *   3. **Exception-safe**: if `onEvict` throws, the guard must catch and
   *      swallow that exception (a real implementation logs it) — it must
   *      never propagate out of `admit()`, never leave the pool in an
   *      inconsistent state (the evicted lease is still removed either
   *      way), and never prevent the *new* connection that triggered the
   *      eviction from getting its own lease-or-rejection per §6.3's normal
   *      rules.
   *
   * LC (W2) wires this to `net.Server`'s `connection`/`close` events; W1's
   * port stays decoupled from `net.Socket` on purpose (easier to fake in
   * tests).
   */
  admit(args: { peerIp: string; viaTrustedProxy: boolean; onEvict: () => void }): ConnLease | undefined;
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

/**
 * §7 / §5.2: what `GET /api/session` needs, keyed by `userId` (which
 * `touchSession`'s `LanSessionRecord` already carries) — kept as its own
 * narrow lookup rather than widening `LanSessionRecord` itself, since
 * `initialPasswordInUse` has nothing to do with session validity and every
 * *other* `touchSession` call site (SSE open/subscribe/unsubscribe/history,
 * §4.2) has no use for it. `initialPasswordInUse` is `users.initial_password
 * IS NOT NULL` (§5.2: "只要初始密码还在使用").
 */
export interface LanUserSummary {
  username: string;
  initialPasswordInUse: boolean;
}

export type DeleteLanUserResult =
  { ok: true; userId: number } | { ok: false; reason: "not-found" | "primary" | "last-user" };

export interface LanStorePort extends LanSecurityStorePort {
  /** Local admin only. Bounded projection (at most 256 accounts; overflow refuses). */
  listUsers(now: number, opts?: PortOptions): Promise<import("../protocol/messages.js").LanAccountSummary[]>;
  /** Refusal checks and CASCADE deletion share one transaction. */
  deleteUser(username: string, opts?: PortOptions): Promise<DeleteLanUserResult>;
  getUser(username: string, opts?: PortOptions): Promise<LanUserRecord | undefined>;
  /**
   * 审查修复 #5（v2）: backs `GET /api/session` (§7) — the endpoint only has a
   * `userId` (from `touchSession`'s `LanSessionRecord`), never a username.
   */
  getUserSummary(userId: number, opts?: PortOptions): Promise<LanUserSummary | undefined>;
  initialInfo(
    opts?: PortOptions,
  ): Promise<{ username: string; initialPassword?: string; initialLogin?: { ip: string; at: number } } | undefined>;
  /**
   * 审查修复 #5（v2）: raw vs. hash semantics (§6.4 "库中只存 sha256(sid)"). The
   * store generates a random raw session id internally, persists only its
   * `sha256`, and returns the **raw** id — the caller sets it directly as
   * the `pwh_lan` cookie value and never sees/handles the hash. This is the
   * only place a raw sid ever exists outside a request's own `Cookie`
   * header; every other method below (`touchSession`/`deleteSession`) takes
   * `sidHash` because by the time a *later* request needs to look a session
   * up, the caller only has the cookie's raw value on hand and is the one
   * hashing it (matching §4.2's own prose, which names the parameter
   * `sidHash`, not `sid`).
   */
  createSession(
    input: { userId: number; epoch: number; boundOrigin: string; createdIp: string; now: number },
    opts?: PortOptions,
  ): Promise<{ sid: string }>;
  touchSession(
    sidHash: string,
    now: number,
    opts?: PortOptions & { ip?: string },
  ): Promise<LanSessionRecord | undefined>;
  deleteSession(sidHash: string, opts?: PortOptions): Promise<void>;
  /** Explicit kick, unlike logout: atomically untrust the target's created/last IP except keepIp. */
  revokeSession(
    userId: number,
    sidHash: string,
    keepIp: string,
    opts?: PortOptions,
  ): Promise<{ sharedIpKept: boolean }>;
  /** Bounded best-effort fallback for a dispatched revoke with uncertain effect. */
  untrustLoginIps(userId: number, ips: string[], keepIp: string, opts?: PortOptions): Promise<void>;
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
  /** web-hub-spawn plan §SP1 (arch §6.2): the managed-spawn policy, present ONLY when
   * `webHub.spawn.enabled === true` (SP2's `buildHubConfig` omits the key otherwise — the key's
   * absence IS the wire-level "feature off" that keeps the §8.2 response matrix byte-identical). */
  spawn?: HubSpawnConfig;
  /** web-hub-preview plan v3 §4.1 (PV1): preview availability — `"on"`/`"loopback"` only.
   * `"off"` is the key's ABSENCE (same wire-level off pattern as `spawn`); `hub/main.ts`
   * re-validates via `normalizeHubPreviewMode` and drops the whole key on anything else. */
  preview?: "on" | "loopback";
  /** web-hub-avatar plan v2.1 §2.6: presence of the literal key is the feature gate. */
  avatar?: true;
  /** Slash-argument completion; absent = off (no cap or routes). */
  cmdArgs?: "all" | "toolkit";
  /** web-hub-privacy plan v2.1 (P1, 「设置」节): presence of the literal key is the feature
   * gate (same wire-level pattern as `avatar`): `webHub.privacy` default true — `false` leaves
   * the key ABSENT, so an off hub mounts no routes, sends no `privacy` frame, declares no
   * `privacy.v1` cap, and never touches the on-disk `privacy.json` (marks survive a disable
   * round-trip). Non-live: change needs `/reload` + `/webhub restart`. */
  privacy?: true;
  /** sysload plan (docs/dev/sysload/plan.md) §7.2/§11: the hub's OWN sampler policy, written by
   * the pi process that launched it, ONLY when `load.enabled ∧ webHub.load` are both true
   * (`buildHubConfig`, P2a) — same wire-level "feature off IS key absence" pattern as `spawn`/
   * `preview` above. A singleton: kept as-is for the hub's whole lifetime even if the launching
   * pi's settings change later (§3/§7.2 — "singleton 保留到 restart"); `hub/main.ts`'s
   * `normalizeHubLoadConfig` (P3) re-validates and drops the whole key on anything malformed. */
  load?: HubLoadConfig;
  /** web-hub-proxy plan v2 §5 (X0 frozen face): the port-proxy policy, present ONLY when
   * `webHub.proxy.enabled ∧ control !== false` (X1c's `buildHubConfig` omits the key otherwise —
   * the key's absence IS the wire-level off: no service, routes, caps, `/api` cross-site gate or
   * disk, byte-identical hub). LAN reach is NOT a field here: it is derived from `config.lan`
   * (Q2 — the proxy has no LAN switch of its own). `hub/main.ts`'s `normalizeHubProxyConfig`
   * drops the whole key when malformed. */
  proxy?: HubProxyConfig;
  /** Feishu bot: absence is off; credentials never cross this config boundary. */
  feishuBot?: FeishuBotHubConfig;
  /** fabric phase-2 §4.6 (X1): the cross-session relay's hub-global limits, present ONLY when
   * `xsOn` on the launching pi (X2's `buildHubConfig` omits the key otherwise — key absence IS off:
   * no relay, no frame handling, no `xs.v1` cap, byte-identical hub). Frozen at hub start;
   * `hub/main.ts` re-validates via `normalizeHubCrossSessionConfig` and drops the whole key on a
   * malformed value. */
  crossSession?: HubCrossSessionConfig;
  /** scheduled-reports plan r3 §10.3 (S0 frozen face): the hub's read-only schedule coordinator
   * policy, present ONLY when `schedule.enabled ∧ webHub.enabled ∧ control !== false` on the
   * launching pi (A0's `buildHubConfig` omits the key otherwise — key absence IS off: no reader,
   * no `sched.v1` cap, no `/api/schedules`, no `schedules` SSE, no `sched_*` frame handling,
   * byte-identical hub). Frozen at hub start; `hub/main.ts` re-validates via
   * `normalizeHubScheduleConfig` (protocol/schedule.ts) and drops the whole key when malformed.
   * Residual: the pi that launched the hub decides (alias R11 class). */
  schedule?: HubScheduleConfig;
}

/**
 * web-hub-proxy plan v2 §5: `HubConfig.proxy`. `portRange` is the inclusive `[lo, hi]` tuple
 * (`parseProxyPortRange`'s output; ≤ `PROXY_PORT_RANGE_MAX_SPAN` ports, never overlapping the hub
 * or LAN port), `maxProxies` is 1..16.
 */
export interface HubProxyConfig {
  portRange: [number, number];
  maxProxies: number;
}

/**
 * sysload plan §6.1/§7.2: the hub-side mirror of `LoadSettings`'s non-gating fields — the hub has
 * no `gate`/`gateLevel`/`hint` concept at all (§3/§7.2: "hub 不承载 gate 概念，Pill/Card 只显示
 * 等级"), so only the sampling cadence and the threshold numbers used to CLASSIFY a reading
 * into a level cross this boundary.
 */
export interface HubLoadConfig {
  sampleIntervalMs: number;
  sustainMs: number;
  recoverMs: number;
  thresholds: {
    cpu: { warnPercent: number; critPercent: number; psiWarnPercent: number; psiCritPercent: number };
    mem: { warnAvailPercent: number; critAvailPercent: number };
    disk: { warnFreePercent: number; critFreePercent: number; critFreeGiB: number };
  };
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
  /** fleet-drawer plan §5.3 (F3b, v2 review fix #4): the raw hello caps `requireCap` gates run
   * subscriptions against (§7.1 — never the UX-only `AgentCard.runTranscript*`). Delegates to
   * `registry.ts`'s own `getCaps`. Optional only so narrow out-of-package test fakes that never
   * touch the run channel keep compiling; the real `Registry` (the sole production
   * `RegistryView`) always provides it — a missing method reads as "caps unknown" and run
   * admission fails closed (E_NOT_FOUND). */
  getCaps?(agentKey: string): readonly string[] | undefined;
}

export type HubEvent =
  | { type: "agent_up"; agent: AgentCard }
  | { type: "agent_down"; agentKey: string; reason: string }
  | { type: "agent_stale"; agentKey: string }
  /** web-hub-delete-session plan v2 §2.3: a card was deleted (hub-broadcast, `registry.remove`)
   * — the browser drops `agentKey` from `agents`/`order`, remembers it in the reducer's
   * `removed` set, and clears any scoped subscription for it (§2.3/§4.3's `AgentRemovedPayload`
   * is the wire shape; this is the internal bus event `http.ts`'s `onHubEvent` forwards from). */
  | { type: "agent_removed"; agentKey: string }
  | { type: "session"; agentKey: string; session: SessionInfo }
  | { type: "ev"; agentKey: string; seq: number; e: WireEvent }
  | { type: "status"; agentKey: string; status: StatusInfo }
  | { type: "fleet"; agentKey: string; runs: FleetRowWire[]; omitted?: FleetOmitted }
  | { type: "prompt"; agentKey: string; prompts: AgentCard["prompts"] }
  | { type: "gap"; agentKey: string; fromSeq: number }
  | { type: "append"; agentKey: string; entries: WireEntry[] }
  // §3.2/§6.6 (C0 P0 fix): the four control-plane bus events every future package (C1/C3) needs
  // to publish from `registry.onFrame`'s `dialogs`/`ctl`/`commands`/`cmd_result`(late) cases and
  // `http.ts`'s `onHubEvent` needs to forward as SSE — shapes pinned to §6.6's documented SSE
  // payloads (`dialogs{agentKey,epoch,open,closed}`, `ctl{agentKey,epoch,sessionId,items}`,
  // `commands{agentKey,epoch,items}`, `cmd_late{agentKey,id,op,ok,code?,data?}`); never carries
  // `CommandOutputWire`'s `output` (§4.9/§6.6: never broadcast over SSE).
  | { type: "dialogs"; agentKey: string; epoch: string; open: DialogWire[]; closed: DialogClosedWire[] }
  | { type: "ctl"; agentKey: string; epoch: string; sessionId: string; items: CtlItemWire[] }
  | { type: "commands"; agentKey: string; epoch: string; items: CommandInfoWire[] }
  | { type: "cmd_late"; agentKey: string; id: string; op: CmdOp; ok: boolean; code?: CmdErrorCode; data?: CmdData }
  /** acc32-B6: a live push of the hub-level info snapshot (state/caps/supersede*) to every
   * already-connected browser — without this, `info.state` mutations (e.g. "stopping") are only
   * ever seen by a client that connects/reconnects AFTER the change; a live client's SSE
   * connection just drops when the hub actually exits, showing the generic "reconnecting" copy
   * instead of `HubStateBanner`'s dedicated stopped/restarting text. `http.ts`'s `onHubEvent`
   * forwards this as the SAME "hub" SSE event name `openEvents`' connect-time send already uses
   * (`logic/state.js`'s `case "hub"` already merges repeated frames of that name). */
  | { type: "hub" }
  /** sysload plan §7.1/§7.2: the hub's own direct-send `load` SSE event (no `agentKey`, never
   * `id:`, never replayed from the ring — §7.2's "直发"). `http.ts`'s `onHubEvent` forwards this
   * as the `load` SSE event and (like `spawns`) snapshots the latest wire on connect, sent right
   * AFTER `spawns` (§7.2). */
  | { type: "load"; wire: LoadWire }
  /** web-hub-privacy plan v2.1 (P1): the hub-global locked-sessionId set changed — broadcast as
   * the direct-send `privacy` SSE event (no `agentKey`, no `id:`, never the replay ring — same
   * 直发 posture as `load`). `http.ts`'s `openEvents` ALSO sends the snapshot on every connect
   * burst, BEFORE `agents` (with spawns/load as the同构 precedent). Published by hub.ts from the
   * privacy store's `onChange`. */
  | { type: "privacy"; locked: readonly string[] }
  /** web-hub-spawn plan §SP1 (arch §6.4): the `spawns` SSE broadcast — carries the Public
   * projection ONLY (`SpawnsPayload`); owner detail never rides the bus. `http.ts` (SP9)
   * forwards it as the `spawns` SSE event and snapshots it on connect. */
  | { type: "spawns"; payload: SpawnsPayload }
  // fleet-drawer plan §5.3 (F3b): the run-transcript channel's agent→hub frames, republished
  // from `registry.onFrame`'s new cases. These are DIRECT-fanout events, never SSE-broadcast:
  // `http.ts`'s `onHubEvent` deliberately has no case for them — `hub/run-transcript.ts`'s
  // service is the sole consumer (it applies §3.3's state table, then fans out per-subscriber
  // through its `RunSink`; a broadcast would push every subagent's stream to every browser).
  | { type: "run_ev"; agentKey: string; runId: string; tapId: string; seq: number; e: WireEvent }
  | { type: "run_gap"; agentKey: string; runId: string; tapId: string; fromSeq: number }
  | { type: "run_end"; agentKey: string; runId: string; tapId: string; lastSeq: number; status: string }
  /** fleet-drawer plan §5.3 (F3b): an agent re-hello'd and its caps set changed — run
   * subscriptions must be re-validated against the new caps (§5.2 "caps 变化 ⇒ 回收不再合格的
   * 订阅"). Published by `registry.register()`'s reclaim branch after the record is updated, so
   * subscribers reading `getCaps()` inside the handler already see the new set. */
  | { type: "caps"; agentKey: string };

export interface HubBus {
  subscribe(fn: (e: HubEvent) => void): () => void;
}

export interface HistoryService {
  snapshot(agentKey: string): Promise<HistoryPayload>; // §7 步骤 1-4；deadline TIMING.snapshotMs → reject E_DEADLINE
  page(agentKey: string, beforeEntryId: string, limit: number): Promise<HistoryPayload>;
  onLeafChanged(agentKey: string, leafId: string | null): void; // status.leafId 变化时调用；有订阅者才工作，500ms 去抖；结果经 bus `append` 事件发出
}

// ---------------------------------------------------------------------------
// fleet-drawer plan §5.2/§5.3 (F3b): the run-transcript service surface. Implemented by
// `hub/run-transcript.ts` (`createRunTranscriptService`), wired into `FrontendDeps.runTx` by
// `hub.ts`, consumed by F4's `hub/run-routes.ts`. Frozen here so both sides compile against
// one shape.
// ---------------------------------------------------------------------------

/**
 * The http layer's fan-out callbacks (§5.2 `setSink` — loopback and LAN each hand in ONE
 * sink; subscriptions carry `${listener}:${clientId}` refs so the service knows which
 * listener a cap re-validation targets). Every method is exception-guarded by the service —
 * a throwing sink never breaks the state machine.
 */
export interface RunSink {
  /** A `run_ev` that passed §3.3's checks: deliver to the run's live subscribers now, buffer
   * for pending ones. */
  ev(agentKey: string, runId: string, payload: RunEvPayload): void;
  /** A seq-aligned `run_end` (already ledger-deduped): deliver once, terminal. */
  end(agentKey: string, runId: string, payload: RunEndPayload): void;
  /** §3.3 resync step 1: a resync round STARTED — swap the run's live subs to fresh pending
   * objects (old identities void) and buffer; the settled snapshot follows as `history`. */
  resyncStart(agentKey: string, runId: string): void;
  /** A resync round settled: success payloads carry `resync:true` and replace the whole runTx
   * state; an error payload means the round failed — deliver `run_history{error}` and drop the
   * subs the round was covering. */
  history(agentKey: string, runId: string, payload: RunHistoryPayload | RunHistoryError): void;
  /** The service dropped subscriptions server-side: agent gone (all refs), resync storm (all
   * refs), or a caps change invalidating `refs` (subset — deliver the error to exactly those
   * and delete their subs; `refs === undefined` means every ref). */
  dropped(agentKey: string, runId: string, err: RunHistoryError, refs?: string[]): void;
}

/** fleet-drawer plan §5.2: the hub-side run-transcript service (capability gate, watch
 * refcounting, snapshot/page via `run_tx_req` + F3a's file reader, §3.3 state table,
 * RunEndLedger, bus reactions). */
export interface RunTranscriptService {
  snapshot(agentKey: string, runId: string, listener: ListenerKind): Promise<RunHistoryPayload>;
  page(
    agentKey: string,
    runId: string,
    before: string,
    limit: number,
    listener: ListenerKind,
  ): Promise<RunHistoryPayload>;
  watch(agentKey: string, runId: string, ref: string): void; // ref = `${listener}:${clientId}`
  unwatch(agentKey: string, runId: string, ref: string): void;
  /** Direct §3.3 input (the service also receives the same frames via the bus; this is the
   * explicit seam F4/tests can drive). */
  onFrame(agentKey: string, f: RunEvFrame | RunGapFrame | RunEndFrame): void;
  setSink(s: RunSink): void;
  dispose(): void;
}

export interface HubInfo {
  version: string;
  buildId: string;
  pid: number;
  startedAt: number;
  proto: typeof PROTO;
  caps: readonly string[];
  state?: "running" | "stopping" | "restarting";
  nextVersion?: string;
  supersedePending?: boolean;
  supersedeDeadlineAt?: number;
  forced?: boolean;
  draining?: boolean;
  /** §6.7.3 ① (main-session frozen amendment): stop marker holding the replacement back —
   * drives HubStateBanner's "升级已暂停" state. */
  supersedeBlocked?: "stopped" | "unknown";
  /** web-hub-avatar plan v2.1 §4.1: per-hub avatar generation and digest. */
  avatar?: AvatarInfo;
  /** web-hub-version plan §2 (V0 frozen face): identity of the UI root the hub is CURRENTLY
   *  serving (`HubUiBuildWire` — assets are the verified index.html's `/assets/*` references,
   * a content-hash bundle fingerprint). Present only while the UI root state is `ok`; set by
   * V1's `hub.ts` through `FrontendDeps.onUiServed` (undefined when no root is servable) and
   * re-broadcast via a `hub` frame. Optional so every pre-V1 assembly keeps compiling and the
   * wire stays byte-identical until then. */
  ui?: HubUiBuildWire;
  /** web-hub-version plan §2 (V0 frozen face): the disk HEAD first observed after hub start
   * (`captureBootHead`, §3.5 — one shot, silent on failure). NOT a guarantee about the loaded
   * code (§10 residual: a `git pull` racing hub start can go unnoticed); V2's
   * `hub-disk-changed` finding compares it against a live `/api/version` snapshot. */
  bootHead?: CommitRef;
}

export interface CommandRouter {
  request(frame: CmdFrame, agentKey: string): Promise<CmdResultFrame>;
  drain(): Promise<{ inflight: number; timedOut: boolean }>;
  inflight(): number;
  /** C3 P1 fix (plan §6.5 "幂等命中（dup）不扣令牌"): best-effort, side-effect-free peek of the hub-side
   * idempotency LRU for `principal|agentKey|id` (the exact key `request()` itself would use) —
   * `http.ts`'s per-category/per-IP/per-agent rate limiters call this *before* spending a token so
   * a retried/still-running duplicate of the same user action is never charged twice. Optional so
   * a test double that only cares about `request()`/`drain()`/`inflight()` can omit it — `http.ts`
   * degrades to always charging the token (old behavior) when it is absent.
   *
   * C3 re-review fix (Blocker #2, plan §3.4/§6.3): `cmd` is required and MUST be compared against
   * the cached entry's own payload digest (the same `sha256(canonicalJSON(cmd))` `request()` uses
   * for its own "id reused with a different payload" check) — a same-`id`-different-payload replay
   * is never a real dup, so it must fall through to the caller's normal rate limiting exactly like
   * a brand-new `id` would, even though an LRU entry for that key exists. Never a source of truth
   * on its own: `request()` re-derives the same digest/state independently and is the only actual
   * decision-maker (§3.4 D7) — this is purely an admission-time hint to skip token spend. */
  peekIdempotent?(
    origin: CmdOrigin,
    agentKey: string,
    id: string,
    cmd: CmdArgs,
  ): "inflight" | "unknown" | "done" | undefined;
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
  /** §6.1 (C0 P0 fix): hub's command router (`hub/commands.ts`'s `createCommandRouter()` at C0 —
   * a fast-path stub that always answers `E_UNSUPPORTED`, never broadcasts new caps; C3 replaces
   * it with the real §6.3 gated implementation). Optional so a `FrontendFactory` that ignores it
   * (or a test double) keeps `createHttpFrontend`'s existing behavior (no `/api/cmd` wiring,
   * 501/404 unchanged) byte-identical — `hub.ts`'s `startHub` constructs the C0 stub and passes
   * it through unconditionally (zero visible change: reading this key is opt-in for the factory). */
  commands?: CommandRouter;
  /** The composition root owns ONE limiter, shared with the Feishu admission path. */
  cmdLimit?: CmdLimit;
  /** web-hub-upload plan §2/§6 (U3): the hub's upload store (`hub/uploads.ts`, U2), constructed
   * and closed by `hub.ts`. Optional so test doubles and pre-U3 assemblies keep compiling — when
   * absent (or store construction failed in `hub.ts`), `/api/upload/*` answers 501
   * `E_NOT_IMPLEMENTED` and everything else is byte-identical. */
  uploads?: UploadStore;
  /** web-hub-upload plan §5.4 (U3 P2-2): shared HTTP-layer upload reject counters — pre-store
   * rejects (CSRF/auth/429/501/caps) are invisible to the store, so they are counted here and
   * merged into the periodic `upload stats` row by `uploadStatsFields`. hub.ts owns the one
   * instance; both listeners' `/api/upload/*` branches count into it. */
  uploadMetrics?: UploadHttpMetrics;
  /** vue-plan.md v2.1 §2.1/§5.2（P5b）：Vue UI 服务；省略时 `createHttpFrontend` 自建
   * （`config.home`/`config.pluginVersion` 构造 `buildUiCandidates` + `createUiServer`），可注入
   * 以便测试 helper 与 `hub.ts` 共享同一实例、把其 `status()` 灌进 `hub.json` 的 `ui` 字段。 */
  ui?: UiServer;
  /** vue-plan.md v2.1 §2.1（P5b）：仅在 `deps.ui` 省略时生效——`createHttpFrontend` 自建默认 UI
   * 服务时把这个回调接到 `createUiServer({ onStatus })`，让 `hub.ts` 在每次实际状态变化（含首次
   * resolve）时收到通知去 `hubJson.patchUi(status)`，与 `LanFrontendDeps.onStatus` 对 `LanStatus`
   * 的做法完全对称。 */
  onUiStatus?: (status: UiStatus) => void;
  /** web-hub-spawn plan §SP1 (arch §4.1): the managed-spawn route frontend (SP9's
   * `createSpawnRoutes`). Optional so test doubles and pre-SP9 assemblies keep compiling —
   * when absent, `/api/headless*` answers exactly as it does today (404/501 per the §8.2
   * not-enabled matrix) and no `spawns` SSE frame is ever sent. */
  spawn?: SpawnFrontendPort;
  /** web-hub-preview plan v3 §4.5 (PV1): the preview route frontend (PV3's
   * `createPreviewRoutes`). Optional so test doubles and pre-PV3 assemblies keep compiling —
   * when absent, `GET /api/preview` answers exactly as today (§4.7 matrix: loopback 401/404,
   * LAN 404) and no `X-PWH-Preview-*` header is ever sent. */
  preview?: PreviewRoutes;
  /** @文件补全 (file-mention): the `GET /api/files/search` route frontend
   * (`hub/file-search.ts`'s `createFileSearchRoutes`). Optional so test doubles keep
   * compiling; `createHttpFrontend` default-constructs it from `deps.preview`'s presence
   * and mode (the search endpoint is the preview line's completion sibling — same cwd-root
   * security surface, same §4.7 listener matrix: LAN answers 404 unless `mode === "on"`),
   * so an assembly that injects neither gets the exact pre-feature behavior back. */
  fileSearch?: FileSearchRoutes;
  /** Same ephemeral route instance on both listeners; absent keeps the original 404. */
  commandComplete?: CommandCompleteRoutes;
  /** worktree-diff plan §1.6 (D3): the worktree-diff route frontend
   * (`hub/worktree-diff/routes.ts`'s `createWorktreeDiffRoutes`), constructed by hub.ts only
   * when `config.preview` exists AND `/proc/self/fd` is usable (D21). Optional so test doubles
   * and pre-D3 assemblies keep compiling — when absent, `/api/worktree-diff/*` answers exactly
   * as today (loopback 401/404, LAN 404) and `wtdiff.v1` is never declared. */
  worktreeDiff?: WorktreeDiffRoutes;
  /** worktree-graph plan v2 §2.6 (P2): the worktree-graph route frontend
   * (`hub/worktree-graph/routes.ts`'s `createWorktreeGraphRoutes`), constructed by hub.ts under
   * the SAME gate as `worktreeDiff` (`config.preview` exists AND `/proc/self/fd` is usable).
   * Optional so test doubles keep compiling — when absent, `GET /api/worktree-graph` answers
   * exactly as today (loopback 401/404, LAN 404) and `wtgraph.v1` is never declared. */
  worktreeGraph?: WorktreeGraphRoutes;
  /** fleet-drawer plan §5.2/§5.3 (F3b): the run-transcript service. Optional so test doubles
   * and pre-F4 assemblies keep compiling — when absent there is no `/api/run/*` wiring (F4
   * builds `createRunRoutes` off this) and everything else is byte-identical. */
  runTx?: RunTranscriptService;
  /** web-hub-delete-session plan v2 §2.9: the agent/managed-session removal route frontend
   * (`hub/agent-remove.ts`'s `createAgentRemoveService`). Optional so test doubles and
   * pre-feature assemblies keep compiling — when absent, `POST /api/agents/remove` answers 404
   * on both listeners, byte-identical to not-enabled. */
  agentRemove?: AgentRemoveFrontendPort;
  /** web-hub-avatar plan v2.1 §2.1: optional route frontend; absent keeps the hub inert. */
  avatar?: AvatarRoutes;
  /** web-hub-privacy plan v2.1 (P1): the privacy-lock route frontend
   * (`hub/privacy/routes.ts`'s `createPrivacyRoutes`), constructed by hub.ts only when
   * `config.privacy === true`. Optional so test doubles and pre-feature assemblies keep
   * compiling — when absent, `/api/privacy/lock` answers 404 on both listeners and
   * `/api/privacy/verify` 404s (LAN included), byte-identical to not-enabled, and no `privacy`
   * SSE frame is ever sent. */
  privacy?: PrivacyRoutes;
  /** web-hub-version plan §2 (V0 frozen face): the version-info service
   * (`hub/version-info.ts`'s `createVersionInfoService`, V1 §3.5 — constructed and disposed by
   * `hub.ts`, never holds the UiServer). Optional so test doubles and pre-V1 assemblies keep
   * compiling — when absent, `GET /api/version` answers exactly as today (loopback 401/404,
   * LAN 404, §3.9's fallback matrix) and `VERSION_HUB_CAP` is never consumed. */
  version?: VersionInfoPort;
  /** web-hub-version plan §2 (V0 frozen face): V1's `hub.ts` hands this to the UI-server layer
   * so `refreshFor()`'s independent `rootGeneration + assets` dedup (§3.6, R2 #2/#5 — NOT the
   * `statusSignature` dedup behind `onStatus`) can update `HubInfo.ui` + re-broadcast a `hub`
   * frame whenever the SERVED bundle identity actually changes; `undefined` means no servable
   * root (delete `info.ui`). Mirrors `onUiStatus`'s role for `hubJson.patchUi`. */
  onUiServed?: (ui: HubUiBuildWire | undefined) => void;
  /** web-hub-proxy plan v2 §3.8/§12 (X0 frozen face): the proxy route frontend (X1c's
   * `createProxyRoutes`), constructed by `hub.ts` only when `config.proxy` exists. Optional so
   * test doubles and pre-X1c assemblies keep compiling — when absent, `/api/proxy*` answers
   * exactly as today (404 on both listeners) and no `/api` cross-site gate or multi-candidate
   * cookie mode is ever armed. */
  proxy?: ProxyRoutes;
}

export interface HttpFrontend {
  listen(opts?: { signal?: AbortSignal }): Promise<{ port: number }>; // loopback；新增可选 opts：已 aborted ⇒ 立即 reject；listen 进行中 abort ⇒ reject 且迟到的 listening 回调自己 server.close()
  close(): Promise<void>; // 变更语义：同时关闭 lan（如有），先 lan 再 loopback
  clientCount(): number; // 变更语义：两个 listener 的 SSE 之和（idle 判定不变）
  lan?: LanFacade; // 仅当 deps.lan !== undefined
  /** vue-plan.md v2.1 §2.1（P5b）：最终生效的 Vue UI 服务（`deps.ui` 或本工厂自建的默认值）——
   * `hub.ts` 读它的 `status()` 灌进 `hub.json` 的 `ui` 字段，并在首次写 hub.json 前调一次
   * `refresh()`。 */
  ui: UiServer;
}

export type FrontendFactory = (deps: FrontendDeps) => HttpFrontend;

// ---------------------------------------------------------------------------
// web-hub-preview plan v3 §4.5 (PV1): the preview route frontend's frozen surface.
// Hoisted HERE (not `hub/preview/routes.ts`, which is PV3's file) because PV1 only adds the
// `FrontendDeps.preview` field — the type must exist for ports.ts to compile. PV3 implements
// `createPreviewRoutes` against this shape; if it needs to refine a member signature, the
// change comes back through ports.ts review (same rule as the W1 port freeze above).
// ---------------------------------------------------------------------------

/** Successful `authorize()`: the authenticated principal preview audits/limits charge to. */
export interface PreviewAuthResult {
  ip: string;
  user?: string;
  /** web-hub-html-preview plan v2 §2.1-② (P0 frozen face): the session tag a minted HTML
   * capability binds to for revocation — loopback `hashSid(pwh_sid)`, LAN `session.sidHash`
   * (both opaque strings; the §2.4 logout hooks select on it). Optional: pre-feature
   * authorize closures and test doubles never set it, and only the future `handleHtmlCap`
   * ever reads it. */
  sidTag?: string;
  /** web-hub-html-preview plan v2 §2.1-②/§R1-1 (P0 frozen face): LAN only — the authenticated
   * session's numeric user id (same field and meaning as `PrivacyAuthResult.userId` below),
   * the selector the real passwd commit path (`admin.ts handlePasswd` →
   * `lanFacade.revoke({userId})`) revokes HTML caps on. Optional for the same reason as
   * `sidTag`. */
  userId?: number;
}

/** `authorize()` already sent its own error response (401/etc.); `code` is mirror-back only. */
export interface PreviewAuthHandled {
  handled: true;
  code: string;
}

/** What `hub/http.ts` injects into every preview dispatch, one instance per request per listener
 * (§4.5; mirrors `SpawnRouteIo`): `listener`/`ip`/`expectedOrigin` feed the CSRF + audit layers,
 * `authorize` is the listener's own auth gate (loopback `auth.check`, LAN `requireLanSession`),
 * `sendJson` is the shared response helper — routes answer via their own `PREVIEW_STATUS` table
 * and never throw. */
export interface PreviewRouteIo {
  listener: "loopback" | "lan";
  ip: string;
  expectedOrigin: string;
  authorize(deadline: ReqDeadline): Promise<PreviewAuthResult | PreviewAuthHandled>;
  sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
}

// ---------------------------------------------------------------------------
// web-hub-html-preview plan v2 §2.3/§2.4 (P0 frozen face): the auth-free `/pv*` request io
// and the revocation selector/reason `PreviewRoutes.revokeHtmlCaps` (below) is frozen
// against. Declared here for the same reason as `PreviewRoutes` itself — `hub/http.ts`'s
// (P1b's) dispatch points and `hub/preview/pv-routes.ts` compile against this shape in a
// later package; a member-signature refinement must come back through ports.ts review.
// ---------------------------------------------------------------------------

/**
 * What `hub/http.ts` injects into every `/pv/*` / `/pvw/*` dispatch, one instance per request
 * per listener. Deliberately NOT `PreviewRouteIo`: I1 (§1) forbids `/pv*` from ever touching
 * `authorize`/`sendJson` — the capability is the only credential — so the serve paths get only
 * what they need: the listener + peer ip (audit / per-request limits) and `origin`, the
 * expected origin the cap was minted under (`lookup` binds listener+origin, §2.2 — a cap
 * minted through origin A never serves a request arriving via origin B).
 */
export interface PvIo {
  listener: "loopback" | "lan";
  ip: string;
  origin: string;
}

/**
 * §2.2/§2.4: what a revocation selects — exactly one of a session tag (either logout path), a
 * LAN user id (the passwd commit path), a whole listener (LAN rotate / loopback
 * `revokeAllSse`), or every cap (hub dispose).
 */
export type PvRevokeSelector =
  { readonly sidTag: string } | { readonly userId: number } | { readonly listener: "loopback" | "lan" } | "all";

/** §2.4's four hook sites, folded into the cap-end audit line (`end:"revoked"`). */
export type PvRevokeReason = "logout" | "passwd" | "rotate" | "close";

/** The frontend surface for the avatar endpoints (A0 frozen face; H implements it). */
export interface AvatarRoutes {
  /** Dispatch one of `/api/avatar` or `/api/avatar/delete`; the route owns auth, limits and audit. */
  handle(req: IncomingMessage, res: ServerResponse, path: AvatarPath, io: PreviewRouteIo): Promise<void>;
  /** Idempotent bounded teardown used by hub close/startup-failure paths. */
  dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void>;
}

/** The frontend surface `createHttpFrontend` optionally carries (PV3 wires `FrontendDeps.preview`):
 * `handle` dispatches `GET /api/preview` for ONE listener (LAN only when `mode === "on"`, §4.7;
 * dir-plan §1.1: the response `X-PWH-Preview-Kind` values are the protocol's
 * `PreviewResponseKind` — `text`/`image`, and `dir` for the P1b `dir=1` opt-in whose body is a
 * `PreviewDirListing`); `handleProbe` (2026-10-07 修订 + dir-plan §1.3) dispatches
 * `POST /api/preview/probe` under the same listener matrix — body `PreviewProbeRequestBody`
 * (`{paths:[…], dirs?}`), answer `PreviewProbeResponseBody` (`{results:[{kind}]}`, kinds from
 * the protocol's `PREVIEW_PROBE_KINDS` tuple) in request order; `dispose` is the bounded (≤1s),
 * idempotent teardown `hub.close()` awaits between `spawnSup.shutdown` and `fe.close()`, and the
 * startup-failure cleanup runs before `fe.close()` (§4.5.1's three exit paths). */
export interface PreviewRoutes {
  readonly mode: "on" | "loopback";
  handle(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  /** `POST /api/preview/probe?agentKey=&sessionId=` — body `{paths:[…], dirs?}` (≤100 entries,
   * ≤8 KiB; `dirs:true` makes directories answer `"dir"`), answer `{results:[{kind}]}`
   * (`PreviewProbeKind` per entry) in request order. */
  handleProbe(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  /** web-hub-html-preview plan v2 §2.1 (P0 frozen face, P1b implements):
   * `POST /api/preview/html-cap?agentKey=&sessionId=` — mint ONE path-shaped capability for an
   * admitted HTML entry (body `PreviewHtmlCapRequestBody`, answer `PreviewHtmlCapResponseBody`,
   * both from `protocol/preview-html.ts`). Same CSRF gate + listener matrix as `handleProbe`
   * (LAN only `mode === "on"`). Optional per the frozen-surface convention — absent (html
   * disabled / pre-P1b hub) ⇒ the dispatch sites never route it, everything else stays
   * byte-identical. */
  handleHtmlCap?(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  /** plan v2 §2.3: `GET /pv/<cap>/<rel>` — `rest` is the RAW (percent-encoded) remainder after
   * `PV_PREFIX` (`"<cap>/<rel>"`); the route itself runs the cap grammar, the rel parser and
   * the fd-anchored admission — io is the auth-free `PvIo` (I1: never calls `authorize`).
   * Non-GET ⇒ 404; the query string is already dropped by the dispatch. */
  servePv?(req: IncomingMessage, res: ServerResponse, rest: string, io: PvIo): Promise<void>;
  /** plan v2 §2.3/§3.2: `GET /pvw/<cap>` — the fixed script-free new-tab wrapper page holding
   * the same sandboxed iframe; `rest` is the raw remainder after `PVW_PREFIX`. */
  serveWrapper?(req: IncomingMessage, res: ServerResponse, rest: string, io: PvIo): Promise<void>;
  /** plan v2 §2.4: the revocation hooks (both logout paths, the LAN facade `revoke`/`revokeAll`
   * — the real passwd commit path —, loopback `revokeAllSse`, and `dispose` ⇒ `"all"`).
   * Synchronous by design: the P1a store aborts in-flight requests + queued waiters
   * immediately and closes the held dir fd once in-flight use drains (refcount), so no caller
   * ever awaits it. Optional ⇒ the hooks are simply not wired. */
  revokeHtmlCaps?(sel: PvRevokeSelector, reason: PvRevokeReason): void;
  /** Idempotent; aborts every active request ("hub-close") and single-flight verify task. */
  dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void>;
}

// ---------------------------------------------------------------------------
// @文件补全 (file-mention): the file-search route frontend's surface, declared here for the
// same reason as `PreviewRoutes` above — `FrontendDeps.fileSearch` needs the type to compile
// before `hub/file-search.ts` exists from ports.ts's perspective. The io shape is REUSED from
// preview (`PreviewRouteIo`: listener/ip/expectedOrigin/authorize/sendJson) — the dispatch
// sites inject exactly the same objects; file-search never throws and owns its own status
// table. No `dispose`: a search holds no fds (only in-flight readdir promises), bounded by
// its per-request deadline + the res-close abort.
// ---------------------------------------------------------------------------
export interface FileSearchRoutes {
  readonly mode: "on" | "loopback";
  handle(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
}

// ---------------------------------------------------------------------------
// web-hub-privacy plan v2.1 (P1): the privacy-lock route frontend's frozen surface — same
// declaration rationale as `PreviewRoutes`/`WorktreeDiffRoutes` above (`FrontendDeps.privacy`
// needs the type before `hub/privacy/routes.ts` exists from ports.ts's perspective). The io
// shape mirrors `AgentRemoveIo` (`SpawnRouteIo` minus the LAN-admission-scope fields) plus one
// addition: `PrivacyAuthResult.userId`, the LAN session's numeric user id, which only the
// listener's `authorize` closure can know (`http.ts`'s `requireLanSession`) and which the
// `verify`/LAN-unlock password pipeline needs (`lan-auth.ts`'s extracted `verifyPassword`).
// ---------------------------------------------------------------------------

/** Successful privacy-route `authorize()`: `SpawnAuthResult` plus the LAN session's userId
 * (present exactly on the LAN listener; loopback authorizes by cookie only). */
export interface PrivacyAuthResult {
  ip: string;
  user?: string;
  /** LAN only — the authenticated session's `users.id`, the input `verifyPassword` starts from
   * (会话取 userId → getUserSummary → getUser → 共用 KDF admission, plan「校验管线」). */
  userId?: number;
}

/** `authorize()` already sent its own error response (401/429/503); `code` is mirror-back only. */
export interface PrivacyAuthHandled {
  handled: true;
  code: string;
}

/** Per-request io injected by `http.ts`'s dispatch points (one per listener), mirroring
 * `AgentRemoveIo` = `SpawnRouteIo` minus `scheme`/`viaTrustedProxy`, with the widened auth
 * result above. */
export interface PrivacyRouteIo {
  listener: "loopback" | "lan";
  /** Known before `authorize()` ever runs (LAN: `ctx.clientIp`; loopback: peer IP). */
  ip: string;
  strictCsrfOk(): boolean;
  authorize(deadline: ReqDeadline): Promise<PrivacyAuthResult | PrivacyAuthHandled>;
  readJson(req: IncomingMessage, maxBytes?: number, maxMs?: number): Promise<unknown>;
  sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
  sendError(res: ServerResponse, status: number, code: string, message?: string): void;
  HttpError: new (status: number, code: string, message?: string) => Error & { status: number; code: string };
}

/** The frontend surface `createHttpFrontend` optionally carries (P1 wires
 * `FrontendDeps.privacy`): `handleVerify` dispatches `POST /api/privacy/verify` (LAN ONLY —
 * the loopback dispatch point never routes it, and the route itself 404s a non-LAN call as a
 * defensive second gate, v2.1 N1); `handleLock` dispatches `POST /api/privacy/lock` for ONE
 * listener (both listeners mount it). No `dispose`: the routes hold no fds/timers of their
 * own — the store's write chain is drained by `PrivacyStore.close()` (hub.ts-owned). */
export interface PrivacyRoutes {
  handleVerify(req: IncomingMessage, res: ServerResponse, io: PrivacyRouteIo): Promise<void>;
  handleLock(req: IncomingMessage, res: ServerResponse, io: PrivacyRouteIo): Promise<void>;
  /** The current locked-sessionId set (sorted) — `http.ts`'s `openEvents` connect burst and
   * (via the bus `privacy` event gate) the listener-level presence check read it. */
  locked(): readonly string[];
}

// ---------------------------------------------------------------------------
// worktree-diff plan §1.6 (D3): the worktree-diff route frontend's frozen surface — same
// declaration rationale as `PreviewRoutes`/`FileSearchRoutes` above (`FrontendDeps.worktreeDiff`
// needs the type before hub/worktree-diff/routes.ts exists from ports.ts's perspective). The
// io shape is REUSED from preview (`PreviewRouteIo`); `dispose` is the bounded (≤1 s),
// idempotent teardown hub.close() awaits right after preview's, and the startup-failure
// cleanup runs before `fe.close()` — the same three-exit-path contract as preview's.
// ---------------------------------------------------------------------------
export interface WorktreeDiffRoutes {
  readonly mode: "on" | "loopback";
  /** `GET /api/worktree-diff/files` — the file list (§1.2; `X-PWH: 1` required). */
  handleFiles(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  /** `GET /api/worktree-diff/file` — the single-file patch envelope (§1.2). */
  handleFile(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  /** Idempotent; aborts every active request and single-flight execution ("hub-close"), ≤1 s. */
  dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void>;
}

// ---------------------------------------------------------------------------
// worktree-graph plan v2 §2.6 (P2): the worktree commit-graph route frontend's frozen surface —
// same declaration rationale as `WorktreeDiffRoutes` above (`FrontendDeps.worktreeGraph` needs
// the type before `hub/worktree-graph/routes.ts` exists from ports.ts's perspective). The io
// shape is REUSED from preview/wtdiff (`PreviewRouteIo`); `dispose` is the bounded (≤1 s),
// idempotent teardown `hub.close()` awaits right after wtdiff's, and the startup-failure
// cleanup runs before `fe.close()` — the same three-exit-path contract.
// ---------------------------------------------------------------------------
export interface WorktreeGraphRoutes {
  readonly mode: "on" | "loopback";
  /** `GET /api/worktree-graph` — the one endpoint (§3; `X-PWH: 1` required). */
  handle(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  /** Idempotent; aborts every active request and single-flight Gl execution ("hub-close"), ≤1 s. */
  dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void>;
}

// ---------------------------------------------------------------------------
// web-hub-proxy plan v2 §3.4/§3.8/§4.1/§4.2 (X0 frozen surface): the proxy service + route
// frontend. Declared here for the same reason as `PreviewRoutes` — `FrontendDeps.proxy` needs
// the types before `hub/proxy/{service,routes}.ts` exist from ports.ts's perspective. The
// identity / revocation types live in `auth-identity.ts` / `auth-revoke.ts` (package XA) and are
// re-exported from here; a member-signature refinement must come back through ports.ts review.
// ---------------------------------------------------------------------------

export type { AuthIdentity, IdentityResult } from "./auth-identity.js";
export type { AuthRevokeEvent } from "./auth-revoke.js";

/** A refused `ProxyService.open`: the wire status + error code + reason (`protocol/proxy.ts`'s
 * `PROXY_REASON_RESPONSE` fixes the pairing for `ProxyDenyReason`s; the other branches are the
 * `proxies` limit, the §3.2 code/session caps and the closing/gap/listen-timeout availability
 * reasons). `retryable` mirrors §3.2's "503 retryable" (tombstone gap). */
export type ProxyOpenFailure =
  | { ok: false; status: 400 | 403; error: "E_PROXY_DENIED"; reason: ProxyDenyReason }
  | {
      ok: false;
      status: 409 | 503;
      error: "E_PROXY_UNAVAILABLE";
      reason: ProxyDenyReason | ProxyUnavailableExtraReason;
      retryable?: boolean;
    }
  | { ok: false; status: 409; error: "E_LIMIT"; reason: ProxyLimitReason }
  | { ok: false; status: 429; error: "E_RATE"; reason: ProxyCapReason };

export type ProxyOpenOutcome = { ok: true; result: ProxyOpenResult } | ProxyOpenFailure;

/** `ProxyService.stop` outcome (404 ⇔ unknown instance, or not stoppable by this identity). */
export type ProxyStopOutcome = { ok: true } | { ok: false; code: "E_NOT_FOUND" };

/** `ProxyService.status()` — read-only, for `/webhub status` (`agent/proxy-status.ts`). */
export interface ProxyServiceStatus {
  instances: number;
  reserved: number;
  /** `broken` ⇒ every `open` answers 503 `E_PROXY_UNAVAILABLE{ports-store}` (plan §3.3). */
  portsStore: "ok" | "broken";
}

/**
 * The hub-side proxy service (`hub/proxy/service.ts`, X1b). One instance per hub, constructed
 * after `frontend.listen()` (it needs the real bound ports) with `lanHostSnapshot:
 * () => HostSnapshot | undefined` as a construction dependency (live LAN host allow-list).
 */
export interface ProxyService {
  /** The current revocation sequence — `http.ts` captures `seq0` from here BEFORE it calls
   * `resolveIdentity` (plan §3.2 / seq0-before-authorize). */
  currentSeq(): number;
  /** `true` ⇔ a revocation matching `identity` happened after `seq0`; `"gap"` ⇔ `seq0` is older
   * than the oldest retained tombstone (fail closed ⇒ 503 retryable `revocation-gap`). */
  revokedSince(seq0: number, identity: AuthIdentity): boolean | "gap";
  /** §3.4 `open`: closing fence → reservation → parse+fence/DNS → single-flight → port bind +
   * listen → code. `browserHost` is the host part the browser used (loopback: request Host;
   * LAN direct: `ctx.hostKey`). The routes refuse a trusted-reverse-proxy mint (409
   * `reverse-proxy`) BEFORE calling this. */
  open(identity: AuthIdentity, target: string, browserHost: string, seq0: number): Promise<ProxyOpenOutcome>;
  /** §3.8 `GET /api/proxy`: every live instance + the policy block (`mine` is per `identity`). */
  list(identity: AuthIdentity): ProxyListResponse;
  /** §3.4 `stop`: allowed for the owner principal or any loopback principal. */
  stop(instanceId: string, identity: AuthIdentity): Promise<ProxyStopOutcome>;
  /** §4.2: the auth-revocation bus subscriber (wired by `hub.ts` via the frontend's duck-typed
   * `subscribeAuthRevoke` extra, only when `config.proxy`). */
  revoke(ev: AuthRevokeEvent): void;
  /** §3.4: open proxied connections — added to the idle monitor's `sse` count. */
  activeConnections(): number;
  /** Optional, `/webhub status` only. */
  status?(): ProxyServiceStatus;
  /** §3.4 closing fence — irreversible, idempotent, bounded by the hub's 2 s close deadline;
   * also called on every `startHub` failure path after construction. */
  dispose(): Promise<void>;
}

/** What `hub/http.ts` injects into every proxy-route dispatch (one per request per listener;
 * mirrors `PreviewRouteIo`/`SpawnRouteIo`). `resolveIdentity` is the listener's single
 * identity-resolution API (§4.1) — the route never touches `Cookie`. */
export interface ProxyRouteIo {
  /** LAN security P0: I supplies ctx.clientIp when wiring E; absent on legacy callers. */
  ip?: string;
  listener: "loopback" | "lan";
  expectedOrigin: string;
  /** Host part the browser addressed this request with (loopback: request Host's host part;
   * LAN direct: `ctx.hostKey`'s host part). */
  browserHost: string;
  /** LAN only: the request arrived through the trusted reverse proxy ⇒ open/stop answer 409
   * `reverse-proxy` (plan §3.4/§6). Always `false` on loopback. */
  viaTrustedProxy: boolean;
  /** Per-listener CSRF gates: `strictCsrfOk` (POST routes; Origin mandatory) / `X-PWH: 1`
   * present (`GET /api/proxy`). */
  strictCsrfOk(): boolean;
  xPwhOk(): boolean;
  resolveIdentity(deadline: ReqDeadline): Promise<IdentityResult>;
  readJson(req: IncomingMessage, maxBytes?: number, maxMs?: number): Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
  sendError(res: ServerResponse, status: number, code: string, message?: string): void;
}

/**
 * The proxy route frontend (`hub/proxy/routes.ts`, X1c) — one `handle`, like the headless/avatar
 * routes. Returns `false` when `method`+`path` is not one of the three proxy routes
 * (`protocol/proxy.ts`'s `PROXY_OPEN_PATH` / `PROXY_LIST_PATH` / `PROXY_STOP_PATH`), so the
 * original 404 still applies; `true` once it has answered. The route owns CSRF, auth, the
 * per-principal bucket and audit; it never throws.
 */
export interface ProxyRoutes {
  handle(req: IncomingMessage, res: ServerResponse, method: string, path: string, io: ProxyRouteIo): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// web-hub-version plan §2 (V0 frozen surface): the version-info port + outcome. Declared here
// for the same reason as `PreviewRoutes` above — `FrontendDeps.version` needs the type before
// `hub/version-info.ts` exists from ports.ts's perspective. V1 implements
// `createVersionInfoService` against this shape; a member-signature refinement must come back
// through ports.ts review (same rule as the W1 port freeze at the top of this file).
// ---------------------------------------------------------------------------

/** `VersionInfoPort.snapshot()` outcome: `data` is a fully validated `VersionInfoWire` (the
 *  service builds it server-side from `parseVersionInfoWire`-compatible shapes — the HTTP
 *  layer serializes it verbatim). Failures are transport-level only: `E_BUSY` ⇒ the 8-waiter
 *  single-flight cap is exhausted (V1's http.ts maps it to 503), `E_DEADLINE` ⇒ the request's
 *  own budget expired before the round settled (504). Section-level failures ride INSIDE a
 *  `data` response as `repo.error`/`changelog.error` and the 10s fail cache — they never fail
 *  the call. */
export type VersionInfoOutcome = { ok: true; data: VersionInfoWire } | { ok: false; code: "E_BUSY" | "E_DEADLINE" };

/** web-hub-version plan §3.5: the single-flight version-info service. `signal` is the
 *  REQUESTER's disconnect signal — aborting it only detaches that waiter from the shared
 *  round (never cancels the computation; the slot stays held until uncancellable IO really
 *  settles, §3.5 lifecycle). One round at a time, ≤8 waiters, success cached 30s / failed
 *  sections 10s (`VERSION_LIMITS`). */
export interface VersionInfoPort {
  snapshot(signal: AbortSignal): Promise<VersionInfoOutcome>;
}

// LAN security r2 P0. Required ops: B replaces the explicit throwing production stubs.
export interface LanSessionListRecord extends LanSessionRecord {
  /** Internal only; D derives the public id with publicSessionId(). */
  sidHash: string;
  createdAt: number;
  lastSeenAt: number;
  createdIp: string;
  lastIp?: string;
  ua?: string;
  method?: "password" | "totp" | "feishu" | "recovery";
}
export interface Lan2faState {
  state: "none" | "enrolled" | "inconsistent";
  totp: boolean;
  feishu: boolean;
  recoveryLeft: number;
  factorGen: number;
  repairNeeded?: string;
}
export type LanFactorVerdict =
  { ok: true; recoveryLeft?: number } | { ok: false; reason: "bad" | "replay" | "stale" | "none" };
export interface CreateSessionCheckedInput {
  userId: number;
  expectedEpoch: number;
  expectedFactorGen: number;
  method?: "password" | "totp" | "feishu" | "recovery";
  boundOrigin: string;
  createdIp: string;
  ua?: string;
  now: number;
}
export type CreateSessionCheckedResult = { ok: true; sid: string; evicted: string[] } | { ok: false; reason: "stale" };
/** All security ops are required and accept per-request cancellation. Never return an enrolled secret. */
export interface LanSecurityStorePort {
  createSessionChecked(input: CreateSessionCheckedInput, opts?: PortOptions): Promise<CreateSessionCheckedResult>;
  listSessions(userId: number, now: number, opts?: PortOptions): Promise<LanSessionListRecord[]>;
  deleteSessionsExcept(
    userId: number,
    keepSidHash: string,
    opts?: PortOptions & { keepIp?: string },
  ): Promise<{ deleted: string[]; more: boolean; sharedIpKept?: boolean }>;
  /** Login completion pins this write to its session so a delayed hook cannot restore kicked trust. */
  noteLoginIp(
    userId: number,
    ip: string,
    now: number,
    opts?: PortOptions & { sidHash?: string },
  ): Promise<{ wasKnown: boolean }>;
  isKnownIp(userId: number, ip: string, now: number, windowMs: number, opts?: PortOptions): Promise<boolean>;
  knownIpCount(userId: number, now: number, windowMs: number, opts?: PortOptions): Promise<number>;
  get2faState(userId: number, opts?: PortOptions): Promise<Lan2faState>;
  verifyTotp(
    input: { userId: number; code: string; expectedGen: number; now: number },
    opts?: PortOptions,
  ): Promise<LanFactorVerdict>;
  consumeRecovery(
    input: { userId: number; code: string; expectedGen: number; now: number },
    opts?: PortOptions,
  ): Promise<LanFactorVerdict>;
  /** Pending secret stays in the child; replace must be explicit. Five-minute pending TTL. */
  beginTotp(
    input: { userId: number; replace?: boolean; now: number },
    opts?: PortOptions,
  ): Promise<{ otpauthUri: string; secretB32: string }>;
  commitTotp(
    input: { userId: number; code: string; expectedGen: number; now: number },
    opts?: PortOptions,
  ): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; reason: "bad" | "stale" | "none" }>;
  /** First Feishu-only enrollment returns recoveryCodes; later toggles don't regenerate. */
  setFeishu2fa(
    input: { userId: number; on: boolean; now: number },
    opts?: PortOptions,
  ): Promise<{ recoveryCodes?: string[] }>;
  regenRecovery(userId: number, now: number, opts?: PortOptions): Promise<{ recoveryCodes: string[] }>;
  reset2fa(userId: number, now: number, opts?: PortOptions): Promise<void>;
  forgetLoginIps(opts?: PortOptions): Promise<void>;
}

export interface ClientAllowBurst {
  count: number;
  ips: readonly string[];
  lastIp: string;
}
export interface ClientAllowGuard {
  readonly active: boolean;
  admitPeer(peerIp: string, trustedProxyPeer: boolean): boolean;
  admitForwarded(input: { clientIp: string; xffUsable: boolean }): boolean;
  snapshot(): ClientAllowSnapshot;
  onBurst(fn: (burst: ClientAllowBurst) => void): () => void;
}
export type LoginApprovalCloseReason =
  "success" | "cancel" | "deny" | "expire" | "evict" | "revoked" | "attempts" | "deadline" | "client-gone" | "dispose";
export interface LoginApprovalPort {
  request(c: {
    challengeId: string;
    gen: number;
    ip: string;
    device: string;
    user: string;
    expiresAt: number;
  }): Promise<"sent" | "unavailable">;
  close(challengeId: string, why: LoginApprovalCloseReason): void;
}
/** One per request. Aborted/client gone before INSERT must prevent a session; after it must revoke. */
export interface LoginIo {
  ua: string;
  signal: AbortSignal;
  responseOpen(): boolean;
  onAdmitted?(): void;
}
/** Register after ONCE on finish BEFORE sending headers/body; never run it on close. */
export interface LoginReply {
  status: number;
  body: LanLoginResponse;
  headers?: Record<string, string | string[]>;
  after?: () => Promise<void>;
}
export interface LanLoginCore {
  passwordLogin(ctx: RequestContext, body: unknown, ua: string, io: LoginIo): Promise<LoginReply>;
  submitFactor(token: string, body: LanFactorBody, ctx: RequestContext, io: LoginIo): Promise<LoginReply>;
  waitApproval(token: string, ctx: RequestContext, io: LoginIo): Promise<LoginReply>;
  cancel(token: string, ctx: RequestContext): void;
  onApprovalDecision(challengeId: string, allowed: boolean, gen: number): void;
  onRevoke(ev: AuthRevokeEvent): void;
  dispose(): void;
}
export interface LanLoginCoreDeps {
  /** false keeps password completion usable until the second-factor UI is integrated. */
  secondFactorEnabled?: boolean;
  onCorruptKdfParams?: (username: string, reason: string) => void;
  store: LanStorePort;
  kdf: KdfPort;
  limiter: LoginLimiterPort & { isFresh?(ip: string): boolean };
  admission: KdfAdmissionPort;
  approval: LoginApprovalPort;
  security: SecurityEventBus;
  authRevoke: AuthRevokeBus;
  revokeSse(sidHash: string): void;
  now(): number;
  log: HubLog;
}
export interface LanSessionsAuth {
  userId: number;
  sidHash: string;
  user: string;
}
export interface LanSessionsIo {
  listener: ListenerKind;
  ip: string;
  xPwhOk(): boolean;
  csrfOkLan(): boolean;
  requireLanSession(deadline: ReqDeadline): Promise<LanSessionsAuth | { handled: true }>;
  readJson(req: IncomingMessage, maxBytes?: number, maxMs?: number): Promise<unknown>;
  sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
  clearCookie(res: ServerResponse): void;
}
export interface LanSessionsRoutes {
  handle(req: IncomingMessage, res: ServerResponse, method: string, path: string, io: LanSessionsIo): Promise<boolean>;
  dispose(): void;
}
export interface LanSessionsDeps {
  store: LanStorePort;
  idleMs: number;
  now(): number;
  log: HubLog;
  authRevoke: AuthRevokeBus;
  revokeSse(sidHash: string): void;
}
