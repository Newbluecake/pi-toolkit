/**
 * fetch trampoline（traffic-merge plan §5.2，r3 裁定 R1-3）。
 *
 * - **每次安装新建 wrapper 闭包**：`install()` 捕获 `next = globalThis.fetch`（不可变），新建 wrapper 设为
 *   全局；不存在共享的可变 `orig`。
 * - **活动性只看身份**：`record.activeId !== myId || retired` ⇒ 只剥票据头后透传给自己的固定下游（不录、不改写）。
 *   旧模块实例留下的 wrapper 同理。
 * - **退役**：engine 关闭时若 `globalThis.fetch === wrapper` ⇒ 还原为 `next`；否则（被第三方包住）全局不动，
 *   wrapper 退役为纯透传。不存在「retained 后复用」——下次 `/record on` 一律新建。
 * - **同一时刻最多一个活动 wrapper**：安装新 wrapper 前退役旧的。
 * - **重入守卫（每条路径，先于任何 return）**：wrapper 以进程级 `AsyncLocalStorage` 携带「本异步调用链上
 *   已经过的 wrapper id 集合 + 是否处于回退中」调下游——录制 / 停录透传 / 加密会话透传 / 退役透传**全部**
 *   如此（安全评审 #1：停录或退役绝不等于可以取消环路保护）。入口发现自己的 id 已在集合中（被自己的下游
 *   同步/异步再次调用，例如延迟绑定 `globalThis.fetch` 的第三方层）⇒ 不再调用 next，计数 `tapReentry`
 *   （日志只记一次）并改走 `nativeFetch`，同时把上下文标记为「回退中」。
 * - **回退出口不可信（安全评审 #2）**：`nativeFetch` 只是进程内首次安装时看到的全局函数，可能本身就是延迟绑定的
 *   第三方 wrapper（它先于 traffic 加载）。若回退途中再次重入 ⇒ 证明没有安全出口：按 §5.2 tap lost 规则可见
 *   停用（停录、退役、notify 一次）并以 `TrafficFetchLoopError` 有界失败本次请求，绝不继续递归。
 * - **tap lost**：`after_provider_response` 已到而活动 wrapper 从未见到该请求的票据 ⇒ 活动 wrapper 已被第三方
 *   丢出链：停止录制（engine.recording=false）、退役、notify 一次、status 显示 `tap lost`；需用户 `/record on`
 *   重新安装。票据铸造归 T2b；本包提供 `noteTicketSeen` / `checkTapAfterResponse` 判定接口。
 *
 * 票据头 `x-pi-traffic-ticket` 在任何路径上都**恒剥离**（活动 / 退役 / 重入 / engine 非 open）。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ensureTrafficGlobal, peekTrafficGlobal } from "./container.js";
import type { TrafficEngine } from "./engine.js";
import { isSecure } from "./secure.js";

export const TICKET_HEADER = "x-pi-traffic-ticket";

export type FetchFn = typeof globalThis.fetch;

/** 活动 wrapper 交给 engine 的请求处理器：`next` 为安装时捕获的固定下游，入参已剥离票据头。 */
export type TapHandler = (next: FetchFn, input: any, init: any, ticket: string | null) => Promise<Response>;

export interface TapWrapper {
  readonly id: number;
  readonly next: FetchFn;
  readonly wrapper: FetchFn;
  readonly engine: TrafficEngine;
  retired: boolean;
}

export interface TapInstallRecord {
  id: number;
  at: number;
  epoch: number;
  /** 安装时 next 是否就是 nativeFetch（诊断用）。 */
  nextIsNative: boolean;
}

/** ALS 携带的调用链上下文（不可变；每层 wrapper 派生新对象）。 */
export interface TapCallContext {
  /** 本异步调用链上已经过的 wrapper id。 */
  readonly ids: ReadonlySet<number>;
  /** 已因重入改走 nativeFetch：再次重入 ⇒ 没有安全出口。 */
  readonly fallback: boolean;
}

/** 回退出口也成环时的有界失败（plan §5.2：无法安全路由 ⇒ 可见停用，不递归）。 */
export class TrafficFetchLoopError extends TypeError {
  readonly code = "E_TRAFFIC_FETCH_LOOP" as const;
  constructor() {
    super("traffic: fetch 拦截层与其它扩展的 fetch 包装形成环路且没有安全出口，已停用拦截层（tap lost）");
    this.name = "TrafficFetchLoopError";
  }
}

export interface TapRecord {
  activeId: number | null;
  active?: TapWrapper;
  /** 进程内**第一次**安装时看到的 `globalThis.fetch`（重入守卫的出口）。 */
  readonly nativeFetch: FetchFn;
  seq: number;
  /** 最近 ≤8 次安装（环形）。 */
  installs: TapInstallRecord[];
  readonly als: AsyncLocalStorage<TapCallContext>;
  reentry: number;
  reentryLogged: boolean;
  /** 回退出口自身也成环、被有界失败的次数。 */
  loopFailures: number;
}

const MAX_INSTALL_LOG = 8;
const MAX_SEEN_TICKETS = 1024;

function tapRecord(): TapRecord {
  const g = ensureTrafficGlobal();
  if (!g.tap) {
    g.tap = {
      activeId: null,
      nativeFetch: globalThis.fetch,
      seq: 0,
      installs: [],
      als: new AsyncLocalStorage<TapCallContext>(),
      reentry: 0,
      reentryLogged: false,
      loopFailures: 0,
    };
  }
  return g.tap;
}

export function peekTapRecord(): TapRecord | undefined {
  return peekTrafficGlobal()?.tap;
}

function headerValue(headers: unknown): { has: boolean; value: string | null } {
  if (!headers) return { has: false, value: null };
  if (headers instanceof Headers) {
    const value = headers.get(TICKET_HEADER);
    return { has: value !== null, value };
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && String(entry[0]).toLowerCase() === TICKET_HEADER) {
        return { has: true, value: String(entry[1]) };
      }
    }
    return { has: false, value: null };
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === TICKET_HEADER) return { has: true, value: value === undefined ? null : String(value) };
    }
  }
  return { has: false, value: null };
}

function withoutTicket(headers: unknown): unknown {
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.delete(TICKET_HEADER);
    return copy;
  }
  if (Array.isArray(headers)) {
    return headers.filter((entry) => !(Array.isArray(entry) && String(entry[0]).toLowerCase() === TICKET_HEADER));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== TICKET_HEADER) out[key] = value;
  }
  return out;
}

/**
 * 剥离票据头（只在确实携带时复制；不携带时原样返回同一对象）。返回剥离后的入参与票据值。
 * `init.headers` 优先于 `Request` 自带头（与 fetch 语义一致：init.headers 整体覆盖 Request 的头）。
 */
export function stripTicket(input: any, init: any): { input: any; init: any; ticket: string | null } {
  let ticket: string | null = null;
  let outInit = init;
  let outInput = input;
  const initHeaders = typeof init === "object" && init !== null ? (init as { headers?: unknown }).headers : undefined;
  const fromInit = headerValue(initHeaders);
  if (fromInit.has) {
    ticket = fromInit.value;
    outInit = { ...init, headers: withoutTicket(initHeaders) };
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    const fromReq = headerValue(input.headers);
    if (fromReq.has) {
      ticket = ticket ?? fromReq.value;
      const headers = new Headers(input.headers);
      headers.delete(TICKET_HEADER);
      outInput = new Request(input, { headers });
    }
  }
  return { input: outInput, init: outInit, ticket };
}

function callStripped(fn: FetchFn, input: any, init: any): Promise<Response> {
  const stripped = stripTicket(input, init);
  return stripped.init === undefined ? fn(stripped.input) : fn(stripped.input, stripped.init);
}

/**
 * 为 engine 安装一个新 wrapper（同一 engine 已有未退役的活动 wrapper ⇒ 幂等返回它）。
 * 已有属于别的 engine 的活动 wrapper ⇒ 先退役（陈旧）。
 */
export function installTap(engine: TrafficEngine, handler: TapHandler): TapWrapper {
  const record = tapRecord();
  const current = record.active;
  if (current && !current.retired && current.engine === engine && record.activeId === current.id) return current;
  if (current) retireWrapper(record, current);
  const next = globalThis.fetch;
  const id = ++record.seq;
  const state: { retired: boolean } = { retired: false };
  const wrapper = async function trafficTap(input: any, init?: any): Promise<Response> {
    const ctx = record.als.getStore();
    // ---- 重入守卫：先于任何 return（录制 / 停录 / secure / 退役 路径一视同仁）----
    if (ctx?.ids.has(id)) {
      record.reentry++;
      engine.counters.tapReentry++;
      if (!record.reentryLogged) {
        record.reentryLogged = true;
        console.warn(
          "[pi-subagent] traffic: fetch trampoline re-entered by its own downstream; routed to native fetch",
        );
      }
      if (ctx.fallback) {
        // 回退出口本身又回到了这里：没有可证明安全的出口 ⇒ 可见停用 + 有界失败。
        record.loopFailures++;
        markTapLost(engine, "fetch-loop");
        throw new TrafficFetchLoopError();
      }
      const fallbackCtx: TapCallContext = { ids: ctx.ids, fallback: true };
      return record.als.run(fallbackCtx, () => callStripped(record.nativeFetch, input, init));
    }
    const nextIds = new Set(ctx?.ids ?? []);
    nextIds.add(id);
    const callCtx: TapCallContext = { ids: nextIds, fallback: ctx?.fallback ?? false };
    if (record.activeId !== id || state.retired) {
      return record.als.run(callCtx, () => callStripped(next, input, init));
    }
    const stripped = stripTicket(input, init);
    if (stripped.ticket !== null) noteTicketSeen(engine, stripped.ticket);
    // engine 入口固定（安装时捕获）：关闭 / 停录 / 加密会话 ⇒ 纯透传（仍在 ALS 保护下）。
    if (engine.state !== "open" || !engine.recording || isSecure()) {
      return record.als.run(callCtx, () =>
        stripped.init === undefined ? next(stripped.input) : next(stripped.input, stripped.init),
      );
    }
    return record.als.run(callCtx, () => handler(next, stripped.input, stripped.init, stripped.ticket));
  } as FetchFn;
  const tap: TapWrapper = {
    id,
    next,
    wrapper,
    engine,
    get retired() {
      return state.retired;
    },
    set retired(value: boolean) {
      state.retired = value;
    },
  };
  record.active = tap;
  record.activeId = id;
  record.installs.push({ id, at: Date.now(), epoch: engine.epoch, nextIsNative: next === record.nativeFetch });
  while (record.installs.length > MAX_INSTALL_LOG) record.installs.shift();
  globalThis.fetch = wrapper;
  engine.tapId = id;
  engine.tapLost = false;
  return tap;
}

function retireWrapper(record: TapRecord, tap: TapWrapper): "restored" | "retained" {
  tap.retired = true;
  if (record.activeId === tap.id) record.activeId = null;
  if (record.active === tap) delete record.active;
  if (tap.engine.tapId === tap.id) tap.engine.tapId = null;
  if (globalThis.fetch === tap.wrapper) {
    globalThis.fetch = tap.next;
    return "restored";
  }
  return "retained";
}

/** 退役该 engine 的活动 wrapper。返回 `none`（无属于它的活动 wrapper）/ `restored` / `retained`。 */
export function retireTap(engine: TrafficEngine): "none" | "restored" | "retained" {
  const record = peekTapRecord();
  const active = record?.active;
  if (!record || !active || active.engine !== engine) return "none";
  return retireWrapper(record, active);
}

/** 该 engine 是否持有活动 wrapper。 */
export function tapActiveFor(engine: TrafficEngine): TapWrapper | undefined {
  const record = peekTapRecord();
  const active = record?.active;
  return active && !active.retired && active.engine === engine && record.activeId === active.id ? active : undefined;
}

/** wrapper 见到票据（活动路径）。有界 FIFO。 */
export function noteTicketSeen(engine: TrafficEngine, ticket: string): void {
  engine.tapSeen.add(ticket);
  if (engine.tapSeen.size > MAX_SEEN_TICKETS) {
    const oldest = engine.tapSeen.values().next();
    if (!oldest.done) engine.tapSeen.delete(oldest.value);
  }
}

/**
 * T2b 在 `after_provider_response` 对其铸造的票据调用：活动 wrapper 从未见到该票据 ⇒ tap lost。
 * 返回是否判定为 lost。
 */
export function checkTapAfterResponse(engine: TrafficEngine, ticket: string): boolean {
  if (engine.state !== "open" || !engine.recording) return false;
  if (!tapActiveFor(engine)) return false;
  if (engine.tapSeen.has(ticket)) return false;
  markTapLost(engine, "ticket-unseen");
  return true;
}

/** tap lost 停用：停录、退役、notify 一次。之后需用户 `/record on` 重新安装。 */
export function markTapLost(engine: TrafficEngine, reason: string): void {
  // 停录与退役每次都执行（幂等）；只有通知去重。
  engine.recording = false;
  retireTap(engine);
  if (engine.tapLost) return;
  engine.tapLost = true;
  engine.tapLostReason = reason;
  const message =
    reason === "fetch-loop"
      ? "traffic：fetch 拦截层与其它扩展的 fetch 包装形成环路且没有安全出口（tap lost），录制已停止；请检查扩展加载顺序后执行 /record on"
      : "traffic：fetch 拦截层已被其它扩展移出调用链（tap lost），录制已停止；请执行 /record on 重新安装";
  try {
    engine.notify?.(message, "warning");
  } catch {
    // notify 失败不影响停用。
  }
}

/** status 用快照。 */
export function tapSnapshot(): {
  activeId: number | null;
  installs: number;
  reentry: number;
  loopFailures: number;
  globalIsActive: boolean;
} {
  const record = peekTapRecord();
  if (!record) return { activeId: null, installs: 0, reentry: 0, loopFailures: 0, globalIsActive: false };
  return {
    activeId: record.activeId,
    installs: record.seq,
    reentry: record.reentry,
    loopFailures: record.loopFailures,
    globalIsActive: record.active !== undefined && globalThis.fetch === record.active.wrapper,
  };
}
