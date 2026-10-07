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
import type { HostTokenRejectReason, LanOffReason, LanStatus } from "../protocol/lan.js";
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
  SessionInfo,
  StatusInfo,
  WireEntry,
  WireEvent,
} from "../protocol/messages.js";
import type { HubPaths } from "../protocol/paths.js";
import type { AgentRemoveFrontendPort } from "./agent-remove.js";
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
import type { PROTO } from "../protocol/version.js";
import type { Scope } from "./lifecycle.js";
import type { ReqDeadline } from "./req-deadline.js";
import type { SpawnFrontendPort } from "./spawn/ports.js";
import type { UiServer } from "./static.js";
import type { UiStatus } from "./ui-root.js";
import type { UploadStore } from "./uploads.js";
import type { UploadHttpMetrics } from "./audit.js";

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

export interface LanStorePort {
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
  /** web-hub-spawn plan §SP1 (arch §6.2): the managed-spawn policy, present ONLY when
   * `webHub.spawn.enabled === true` (SP2's `buildHubConfig` omits the key otherwise — the key's
   * absence IS the wire-level "feature off" that keeps the §8.2 response matrix byte-identical). */
  spawn?: HubSpawnConfig;
  /** web-hub-preview plan v3 §4.1 (PV1): preview availability — `"on"`/`"loopback"` only.
   * `"off"` is the key's ABSENCE (same wire-level off pattern as `spawn`); `hub/main.ts`
   * re-validates via `normalizeHubPreviewMode` and drops the whole key on anything else. */
  preview?: "on" | "loopback";
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
  | { type: "fleet"; agentKey: string; runs: FleetRowWire[] }
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
  /** fleet-drawer plan §5.2/§5.3 (F3b): the run-transcript service. Optional so test doubles
   * and pre-F4 assemblies keep compiling — when absent there is no `/api/run/*` wiring (F4
   * builds `createRunRoutes` off this) and everything else is byte-identical. */
  runTx?: RunTranscriptService;
  /** web-hub-delete-session plan v2 §2.9: the agent/managed-session removal route frontend
   * (`hub/agent-remove.ts`'s `createAgentRemoveService`). Optional so test doubles and
   * pre-feature assemblies keep compiling — when absent, `POST /api/agents/remove` answers 404
   * on both listeners, byte-identical to not-enabled. */
  agentRemove?: AgentRemoveFrontendPort;
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

/** The frontend surface `createHttpFrontend` optionally carries (PV3 wires `FrontendDeps.preview`):
 * `handle` dispatches `GET /api/preview` for ONE listener (LAN only when `mode === "on"`, §4.7);
 * `handleProbe` (2026-10-07 修订) dispatches `POST /api/preview/probe` under the same listener
 * matrix — the batch existence probe that lets the UI mark a path clickable only after the
 * backend confirms it; `dispose` is the bounded (≤1s), idempotent teardown `hub.close()` awaits
 * between `spawnSup.shutdown` and `fe.close()`, and the startup-failure cleanup runs before
 * `fe.close()` (§4.5.1's three exit paths). */
export interface PreviewRoutes {
  readonly mode: "on" | "loopback";
  handle(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  /** `POST /api/preview/probe?agentKey=&sessionId=` — body `{paths:[…]}` (≤100 entries,
   * ≤8 KiB), answer `{results:[{kind:"text"|"image"|"missing"}…]}` in request order. */
  handleProbe(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
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
