/**
 * 票据身份（traffic-merge plan §5.3，r3 裁定 R1-1）。
 *
 * - **铸造**（`before_provider_headers`）：入口 engine open ∧ recording ∧ 认领有效 ∧ 非 secure ∧ 活动 wrapper
 *   属于该 engine ∧ `ctx.model.api` ∈ 票据白名单 ⇒ 铸 128-bit 随机票据 T，写入 `x-pi-traffic-ticket`，台账登记，
 *   T 加入本 runner 的存活集合 L。
 * - **配对**（`before_provider_request`）：只在**可证明**时绑定——payload 到达时 L 恰为 {T}。否则（|L| = 0 或 ≥2）
 *   不绑定任何票据、不改写、记 `unattributed`。绝不按「唯一未配对票据」认领。
 * - **payload generation**：T 首次绑定 ⇒ generation 1；之后 L={T} 且 T 最近一次 fetch 非成功（strict-tools 回退
 *   的 400 等）时又来一个 payload ⇒ generation+1，旧 generation 的改写缓存与正文摘要绑定作废。其它情况（T 已绑定
 *   但尚无失败 fetch）无法证明 ⇒ unattributed。
 * - **退役**（只表示不再参与 L 的判据）：① fetch 收到 2xx/3xx；② 本 runner 收到 assistant `message_end` 且最近 60s
 *   未放行 cache warming ⇒ L 内全部存活票据；③ 未绑定票据铸造后 30s、非成功票据最后一次 fetch 结束后 30s（惰性 TTL）；
 *   ④ engine 关闭（台账随 engine 一起作废）。
 * - **台账回收**（fetch 层不再识别该票据头）：未绑定 30s、已绑定未 fetch 120s、已 fetch 的保留至「最后响应 + 60s」，
 *   硬上限 10 min；总量 ≤1024 条 FIFO。惰性扫描，无定时器。
 * - **墓碑**（安全评审 #1）：TTL 退役 / 回收 / FIFO 淘汰都只是**存储**决定，不证明该调用不会再产生 payload
 *   （SDK 读 400 错误体、pi-ai 判定 strict 回退再 onPayload 之间没有时间上界）。凡是**未经证明**就离开 L 的票据，
 *   都给其 runner 立墓碑：墓碑存在期间本 runner 的一切 payload 判 unattributed（不绑定、不升代、不改写），
 *   直到可验证的完成边界——规则 ② 的 assistant `message_end`（agent loop 逐次串行调用 provider，message_end
 *   表示当前调用已结束；60s 内放行过 warming 时规则 ② 本身不成立，墓碑也不清）或子会话 `agent_settled`。
 *   规则 ①（fetch 2xx）只证明「该票据」完成，不清除其它票据留下的墓碑。墓碑不随时间自动解除。
 * - **改写暂停**（第三轮裁定 A）：warming 没有可验证的完成边界（60s 窗口只是时间，不是证据）。危害在于「改写」作用到
 *   错误请求，故改写路径 fail closed：runner 一旦观测到任何 `cache_warming_decision`，进入 rewrite-suspended——不对任何
 *   请求应用改写规则（照常录制、计数），**不按时间解除**；只在可验证边界解除：`/record off→on`（`resumeSeq` 前进）、
 *   暂停之后观测到「启用规则为零」再启用（`zeroSeq` 前进且当前有启用规则）、或新 engine（新台账 / 新 runner）。
 *   仅录制路径的归属仍沿用墓碑 + 60s 时间窗；迟到 warming payload 错配到别的票据**录制行**是已接受残留（数据质量，不改写）。
 *
 * 本模块纯逻辑（无 pi / DB 依赖）；时钟可注入。
 */
import { randomBytes } from "node:crypto";
import type { ApplyResult, EngineSettings, RewriteRule } from "./rewrite.js";
import type { RowRef } from "./db-port.js";

/** 票据白名单：conformance 证明 SDK 把 options.headers 带到 globalThis.fetch 且剥离后 provider 收不到（§5.3、R-b）。 */
export const TICKET_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
]);

export const TICKET_TTL = {
  /** 未绑定票据：铸造后退役 + 台账回收。 */
  unboundMs: 30_000,
  /** 非成功票据：最后一次 fetch 结束后退役。 */
  failedRetireMs: 30_000,
  /** 已绑定未 fetch：台账回收。 */
  boundUnfetchedMs: 120_000,
  /** 已 fetch：最后响应 + 60s 回收（容纳 SDK 重试）。 */
  fetchedKeepMs: 60_000,
  /** 硬上限。 */
  hardMs: 10 * 60_000,
  /** 规则 2 的 warming 前提窗口。 */
  warmingWindowMs: 60_000,
  /** 「fetch 已收到 2xx、等 after_provider_response」的标记有效期。 */
  awaitingHookMs: 60_000,
} as const;

export const MAX_TICKETS = 1024;

/** 一次 generation 的改写结果（按 (T, generation, 正文摘要) 缓存）。 */
export type RewriteOutcome = { kind: "ok"; result: ApplyResult | null } | { kind: "blocked"; error: Error };

export interface TicketGeneration {
  readonly gen: number;
  /** 本 generation 的 hook 级行（childPersist=false ⇒ null）。 */
  readonly row: RowRef | null;
  readonly sessionId: string;
  readonly model: string | null;
  readonly baseUrl: string | null;
  /** 绑定时的规则快照（录制关闭 / 无规则 ⇒ 空）。 */
  readonly rules: RewriteRule[];
  readonly settings: EngineSettings;
  /** 本 generation 首次 fetch 的原始正文摘要（sha256，解压后）。 */
  digest: string | null;
  /** 本 generation 的改写（首次 fetch 时创建；同摘要重试复用同一 promise）。 */
  rewrite: Promise<RewriteOutcome> | null;
  /** 线级字段是否已写（首次 fetch）。 */
  wireRecorded: boolean;
  streamCaptured: boolean;
}

export interface Ticket {
  readonly id: string;
  readonly runner: TicketRunner;
  readonly epoch: number;
  readonly sessionId: string;
  readonly api: string;
  readonly mintedAt: number;
  /** 铸造时的请求头快照（不含票据），JSON 文本。 */
  readonly headersSnapshot: string | null;
  retired: boolean;
  retiredReason: string | null;
  generation: TicketGeneration | null;
  generations: number;
  fetches: number;
  inFlight: number;
  /** 最近一次 fetch 的结局：null = 从未 fetch。 */
  lastFetchOk: boolean | null;
  lastFetchEndAt: number | null;
  /** fetch 收到 2xx 且尚未被 after_provider_response 消费的时刻。 */
  awaitingHookSince: number | null;
}

/** 等待 after_provider_response 的 hook 级行（白名单外 API / unattributed）。 */
export interface HookRow {
  readonly row: RowRef | null;
  readonly sessionId: string;
  readonly createdAt: number;
}

/** 每次激活（runner 闭包）一个。 */
export interface TicketRunner {
  readonly id: number;
  readonly role: "host" | "child";
  /** 本 runner 铸造、未退役的票据（惰性 TTL 退役后才移除）。 */
  readonly live: Set<Ticket>;
  /** 最近一次放行（未 stop）的 cache warming 时刻。 */
  warmingAllowedAt: number | null;
  /** 等待响应回填的 hook 级行（有界 32，TTL 120s）。 */
  readonly hookRows: HookRow[];
  /** 未铸票据（白名单外）请求头快照，供 hook 级行的 request_headers（仅恰一条时使用）。 */
  readonly untrackedHeaders: Array<{ json: string; at: number }>;
  /**
   * 墓碑：本 runner 有票据未经证明就离开了 L（TTL / 回收 / FIFO）。为真期间本 runner 的 payload 一律 unattributed，
   * 只由完成边界（规则 ② / agent_settled）清除。
   */
  tombstoned: boolean;
  /** 改写暂停（观测到 warming decision）。只由 `rewriteSuspended()` 在可验证边界解除。 */
  rewriteSuspended: boolean;
  /** 暂停时（最近一次 decision）的边界序号快照。 */
  suspendedAt: { resumeSeq: number; zeroSeq: number } | null;
}

/**
 * 改写暂停的解除边界（engine 持有，单调递增）：
 * - `resumeSeq`：`/record off→on`（录制关闭后重新开启）时 +1；
 * - `zeroSeq`：规则快照刷新观测到「启用规则为零」时 +1。
 */
export interface RewriteBoundaryMarks {
  resumeSeq: number;
  zeroSeq: number;
}

export interface TicketLedgerCounters {
  ticketsMinted: number;
  ticketsBound: number;
  generationBumps: number;
  unattributedPayloads: number;
  unattributedFetches: number;
  unattributedResponses: number;
  staleTickets: number;
  retiredBySuccess: number;
  retiredByMessageEnd: number;
  retiredByTtl: number;
  reclaimed: number;
  unsupportedApiPayloads: number;
  hookBackfills: number;
  /** 立墓碑次数（未经证明离开 L 的票据数）。 */
  tombstones: number;
  /** 因墓碑判 unattributed 的 payload 数（含于 unattributedPayloads）。 */
  tombstonedPayloads: number;
  /** 完成边界清除墓碑的次数。 */
  tombstonesCleared: number;
  /** 进入（或在暂停中再次观测到 warming 而刷新）改写暂停的次数。 */
  rewriteSuspensions: number;
  /** 可验证边界解除改写暂停的次数。 */
  rewriteResumes: number;
  /** 因改写暂停而未应用启用规则的请求数（绑定时 + fetch 层创建改写时）。 */
  rewriteSuspendedRequests: number;
}

export interface TicketLedger {
  readonly tickets: Map<string, Ticket>;
  readonly counters: TicketLedgerCounters;
  newRunner(role: "host" | "child"): TicketRunner;
  mint(
    runner: TicketRunner,
    init: { epoch: number; sessionId: string; api: string; headersSnapshot: string | null },
  ): Ticket;
  /** 惰性 TTL 退役后的存活集合 L。 */
  liveOf(runner: TicketRunner): Ticket[];
  /** fetch 层查找（回收后 / 未知 ⇒ undefined）。 */
  lookup(id: string): Ticket | undefined;
  retire(ticket: Ticket, reason: "success" | "message_end" | "ttl" | "settled" | "closed"): void;
  /** 规则 2：assistant message_end。返回退役数量；前提不成立返回 -1。前提成立时同时清除本 runner 的墓碑。 */
  retireOnMessageEnd(runner: TicketRunner): number;
  /**
   * 子会话 agent_settled：丢弃该 runner 未配对 / 未 fetch 票据；run 已结束 ⇒ 清除墓碑（60s 内观测到 warming 时不清）。
   * **绝不**清除 warming 状态（`warmingAllowedAt`）与改写暂停。
   */
  discardUnfetched(runner: TicketRunner): void;
  /** engine 关闭：全部退役。 */
  retireAll(): void;
  sweep(): void;
  now(): number;
}

export function newTicketId(): string {
  return randomBytes(16).toString("hex");
}

export function createTicketLedger(opts: { now?: () => number; newId?: () => string } = {}): TicketLedger {
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? newTicketId;
  const tickets = new Map<string, Ticket>();
  let runnerSeq = 0;
  const counters: TicketLedgerCounters = {
    ticketsMinted: 0,
    ticketsBound: 0,
    generationBumps: 0,
    unattributedPayloads: 0,
    unattributedFetches: 0,
    unattributedResponses: 0,
    staleTickets: 0,
    retiredBySuccess: 0,
    retiredByMessageEnd: 0,
    retiredByTtl: 0,
    reclaimed: 0,
    unsupportedApiPayloads: 0,
    hookBackfills: 0,
    tombstones: 0,
    tombstonedPayloads: 0,
    tombstonesCleared: 0,
    rewriteSuspensions: 0,
    rewriteResumes: 0,
    rewriteSuspendedRequests: 0,
  };

  function retire(ticket: Ticket, reason: "success" | "message_end" | "ttl" | "settled" | "closed"): void {
    if (ticket.retired) return;
    ticket.retired = true;
    ticket.retiredReason = reason;
    ticket.runner.live.delete(ticket);
    if (reason === "success") counters.retiredBySuccess++;
    else if (reason === "message_end") counters.retiredByMessageEnd++;
    else if (reason === "ttl") {
      counters.retiredByTtl++;
      // 未经证明离开 L：该调用仍可能迟到一个 payload（strict 回退）⇒ 墓碑，直到完成边界。
      ticket.runner.tombstoned = true;
      counters.tombstones++;
    }
  }

  function clearTombstone(runner: TicketRunner): void {
    if (!runner.tombstoned) return;
    runner.tombstoned = false;
    counters.tombstonesCleared++;
  }

  function ttlRetire(ticket: Ticket, t: number): void {
    if (ticket.retired) return;
    if (ticket.generation === null && t - ticket.mintedAt >= TICKET_TTL.unboundMs) retire(ticket, "ttl");
    else if (
      ticket.lastFetchOk === false &&
      ticket.inFlight === 0 &&
      ticket.lastFetchEndAt !== null &&
      t - ticket.lastFetchEndAt >= TICKET_TTL.failedRetireMs
    )
      retire(ticket, "ttl");
    else if (t - ticket.mintedAt >= TICKET_TTL.hardMs) retire(ticket, "ttl");
  }

  function reclaimable(ticket: Ticket, t: number): boolean {
    if (t - ticket.mintedAt >= TICKET_TTL.hardMs) return true;
    if (ticket.inFlight > 0) return false;
    if (ticket.generation === null && ticket.fetches === 0) return t - ticket.mintedAt >= TICKET_TTL.unboundMs;
    if (ticket.fetches === 0) return t - ticket.mintedAt >= TICKET_TTL.boundUnfetchedMs;
    return ticket.lastFetchEndAt !== null && t - ticket.lastFetchEndAt >= TICKET_TTL.fetchedKeepMs;
  }

  function sweep(): void {
    const t = now();
    for (const [id, ticket] of tickets) {
      ttlRetire(ticket, t);
      if (reclaimable(ticket, t)) {
        retire(ticket, "ttl");
        tickets.delete(id);
        counters.reclaimed++;
      }
    }
    while (tickets.size > MAX_TICKETS) {
      const oldest = tickets.entries().next();
      if (oldest.done) break;
      retire(oldest.value[1], "ttl");
      tickets.delete(oldest.value[0]);
      counters.reclaimed++;
    }
  }

  return {
    tickets,
    counters,
    now,
    newRunner(role) {
      return {
        id: ++runnerSeq,
        role,
        live: new Set(),
        warmingAllowedAt: null,
        hookRows: [],
        untrackedHeaders: [],
        tombstoned: false,
        rewriteSuspended: false,
        suspendedAt: null,
      };
    },
    mint(runner, init) {
      sweep();
      const ticket: Ticket = {
        id: newId(),
        runner,
        epoch: init.epoch,
        sessionId: init.sessionId,
        api: init.api,
        mintedAt: now(),
        headersSnapshot: init.headersSnapshot,
        retired: false,
        retiredReason: null,
        generation: null,
        generations: 0,
        fetches: 0,
        inFlight: 0,
        lastFetchOk: null,
        lastFetchEndAt: null,
        awaitingHookSince: null,
      };
      tickets.set(ticket.id, ticket);
      runner.live.add(ticket);
      counters.ticketsMinted++;
      sweep();
      return ticket;
    },
    liveOf(runner) {
      const t = now();
      for (const ticket of [...runner.live]) ttlRetire(ticket, t);
      return [...runner.live];
    },
    lookup(id) {
      sweep();
      return tickets.get(id);
    },
    retire,
    retireOnMessageEnd(runner) {
      const t = now();
      if (runner.warmingAllowedAt !== null && t - runner.warmingAllowedAt < TICKET_TTL.warmingWindowMs) return -1;
      let n = 0;
      for (const ticket of [...runner.live]) {
        retire(ticket, "message_end");
        n++;
      }
      // 完成边界：本 runner 当前（串行的）调用已结束，此前未经证明退役的票据不会再有 payload 被误认。
      clearTombstone(runner);
      return n;
    },
    discardUnfetched(runner) {
      for (const ticket of [...runner.live]) {
        if (ticket.fetches === 0 && ticket.inFlight === 0) {
          retire(ticket, "settled");
          tickets.delete(ticket.id);
        }
      }
      runner.hookRows.length = 0;
      runner.untrackedHeaders.length = 0;
      // warming 可能仍在途（无完成证据）：与规则 ② 同一前提，窗口内不清墓碑。warming 状态与改写暂停一律不动。
      const t = now();
      if (runner.warmingAllowedAt === null || t - runner.warmingAllowedAt >= TICKET_TTL.warmingWindowMs)
        clearTombstone(runner);
    },
    retireAll() {
      for (const ticket of tickets.values()) retire(ticket, "closed");
      tickets.clear();
    },
    sweep,
  };
}

export type PairResult =
  | { kind: "bound"; ticket: Ticket; gen: 1 }
  | { kind: "bumped"; ticket: Ticket; gen: number }
  | { kind: "unattributed"; live: number; tombstoned?: true };

/**
 * 配对判据（纯函数，不修改 ticket）：L 恰为 {T} 且 runner 无墓碑才能证明。
 * - runner 有墓碑 ⇒ unattributed（迟到 payload 可能属于已离开 L 的票据）
 * - T 未绑定 ⇒ bound(gen 1)
 * - T 已绑定 ∧ 最近一次 fetch 非成功 ∧ 无在途 fetch ⇒ bumped(gen+1)
 * - 其它 ⇒ unattributed
 */
export function decidePairing(live: readonly Ticket[], tombstoned = false): PairResult {
  if (tombstoned) return { kind: "unattributed", live: live.length, tombstoned: true };
  if (live.length !== 1) return { kind: "unattributed", live: live.length };
  const ticket = live[0]!;
  if (ticket.generation === null) return { kind: "bound", ticket, gen: 1 };
  if (ticket.lastFetchOk === false && ticket.inFlight === 0) {
    return { kind: "bumped", ticket, gen: ticket.generations + 1 };
  }
  return { kind: "unattributed", live: 1 };
}

/** 观测到 warming decision：进入（或刷新）改写暂停，记录当前边界序号。 */
export function suspendRewrite(
  runner: TicketRunner,
  marks: RewriteBoundaryMarks,
  counters: TicketLedgerCounters,
): void {
  runner.rewriteSuspended = true;
  runner.suspendedAt = { resumeSeq: marks.resumeSeq, zeroSeq: marks.zeroSeq };
  counters.rewriteSuspensions++;
}

/**
 * 改写是否暂停（顺带在可验证边界解除）：`/record off→on` 之后，或暂停之后观测到启用规则为零且当前 `enabledRules > 0`。
 * 不看时间。
 */
export function rewriteSuspended(
  runner: TicketRunner,
  marks: RewriteBoundaryMarks,
  enabledRules: number,
  counters: TicketLedgerCounters,
): boolean {
  if (!runner.rewriteSuspended) return false;
  const at = runner.suspendedAt;
  if (at && (marks.resumeSeq > at.resumeSeq || (marks.zeroSeq > at.zeroSeq && enabledRules > 0))) {
    runner.rewriteSuspended = false;
    runner.suspendedAt = null;
    counters.rewriteResumes++;
    return false;
  }
  return true;
}
