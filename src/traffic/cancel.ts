/**
 * engine 级可取消域（traffic-merge plan §4.1 / §5.2）。
 *
 * 重放、读流、后台流捕获在开始时登记一个中止函数；`engine.close()` 同步调用 `abortAll()`，
 * 每个中止函数只「触发」不等待（例如 `reader.cancel()` 不 await）。另提供截止定时器（unref）作二级上界。
 * 无模块级状态：每个 engine 一个实例。
 */
export interface CancelDomain {
  /** 已经 abortAll 过：之后登记的条目立即被中止。 */
  readonly aborted: boolean;
  /** 登记一个中止函数；返回注销函数（幂等）。 */
  register(abort: (reason: string) => void): () => void;
  /** 中止全部在册条目（同步、只触发不等待；单个中止函数抛错被吞掉）。 */
  abortAll(reason: string): void;
  size(): number;
}

export function createCancelDomain(): CancelDomain {
  const entries = new Set<(reason: string) => void>();
  let aborted = false;
  let abortReason = "closed";
  const fire = (fn: (reason: string) => void, reason: string): void => {
    try {
      fn(reason);
    } catch {
      // 中止失败不得影响关闭流程。
    }
  };
  return {
    get aborted() {
      return aborted;
    },
    register(abort) {
      if (aborted) {
        fire(abort, abortReason);
        return () => {};
      }
      entries.add(abort);
      return () => {
        entries.delete(abort);
      };
    },
    abortAll(reason) {
      aborted = true;
      abortReason = reason;
      const all = [...entries];
      entries.clear();
      for (const fn of all) fire(fn, reason);
    },
    size() {
      return entries.size;
    },
  };
}

/** 重放截止（§4.1 二级上界）：响应头 60s、读流空闲 120s、总长 30 min。 */
export interface ReplayDeadlines {
  headMs: number;
  idleMs: number;
  totalMs: number;
}

export const REPLAY_DEADLINES: ReplayDeadlines = { headMs: 60_000, idleMs: 120_000, totalMs: 30 * 60_000 };

/** unref 的一次性定时器；返回清除函数。 */
export function armTimer(ms: number, fn: () => void): () => void {
  const timer = setTimeout(fn, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

/**
 * 可重置的空闲定时器：`touch()` 重新计时，`clear()` 停止。用于读流空闲上界。
 */
export function idleTimer(ms: number, fn: () => void): { touch(): void; clear(): void } {
  let clear: (() => void) | null = armTimer(ms, fn);
  return {
    touch() {
      if (clear === null) return;
      clear();
      clear = armTimer(ms, fn);
    },
    clear() {
      clear?.();
      clear = null;
    },
  };
}
