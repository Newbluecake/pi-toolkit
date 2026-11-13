/** UI renderer only: never closes/restarts a transport or a future background shell. */
export const WEBGL_READY_TIMEOUT_MS = 3_000;
export const MAX_WEBGL_REBUILDS = 1;
export type WebglUiPhase = "starting" | "ready" | "recovering" | "unavailable" | "reopen-required" | "disposed";
export interface WebglUiState {
  phase: WebglUiPhase;
  rebuilds: number;
  reason: string;
}
export interface WebglSession {
  dispose(): void;
}

export function createWebglLifecycle<T extends WebglSession>(ports: {
  create(signal: AbortSignal, onLoss: () => void): Promise<T>;
  onStateChange?(state: WebglUiState): void;
}) {
  let state: WebglUiState = { phase: "starting", rebuilds: 0, reason: "正在启动 WebGL 终端…" };
  let current: T | undefined;
  let epoch = 0;
  let pending: AbortController | undefined;
  let disposed = false;
  let started = false;
  const publish = (phase: WebglUiPhase, reason: string) => {
    state = { phase, reason, rebuilds: state.rebuilds };
    // A consumer callback cannot interfere with renderer cleanup or create a retry loop.
    try {
      ports.onStateChange?.({ ...state });
    } catch {
      /* UI port only */
    }
  };
  const release = (value: T | undefined) => {
    try {
      value?.dispose();
      return true;
    } catch {
      return false;
    }
  };
  const acquire = () => {
    const mine = ++epoch;
    const abort = new AbortController();
    pending = abort;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, value?: T) => {
        if (settled) {
          release(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", cancelled);
        if (pending === abort) pending = undefined;
        if (error) reject(error);
        else resolve(value!);
      };
      const cancelled = () => finish(new Error("WebGL 初始化已取消，终端未启动。"));
      const timer = setTimeout(() => {
        finish(new Error("WebGL 初始化超时，终端未启动。"));
        abort.abort();
      }, WEBGL_READY_TIMEOUT_MS);
      abort.signal.addEventListener("abort", cancelled, { once: true });
      void Promise.resolve()
        .then(() => {
          if (abort.signal.aborted) throw new Error("WebGL 初始化已取消。");
          return ports.create(abort.signal, () => loss(mine));
        })
        .then(
          (value) => finish(undefined, value),
          (error: unknown) => finish(error instanceof Error ? error : new Error("WebGL 初始化失败，终端未启动。")),
        );
    });
  };
  const loss = (mine: number) => {
    if (disposed || mine !== epoch) return;
    if (state.phase !== "ready") {
      pending?.abort();
      return;
    }
    ++epoch;
    const old = current;
    current = undefined;
    const exhausted = state.rebuilds >= MAX_WEBGL_REBUILDS;
    if (!exhausted) state.rebuilds++;
    publish(
      exhausted ? "reopen-required" : "recovering",
      exhausted ? "WebGL 再次丢失，请重开终端。" : "WebGL 已丢失，正在自动重建（1/1）…",
    );
    if (!release(old)) {
      publish("reopen-required", "WebGL 界面清理失败，请重开终端。");
      return;
    }
    if (exhausted) return;
    void acquire().then(
      (value) => {
        if (disposed) {
          release(value);
          return;
        }
        current = value;
        publish("ready", "WebGL 已恢复，终端界面已重建。");
      },
      () => {
        if (!disposed) publish("reopen-required", "WebGL 自动重建失败，请重开终端。");
      },
    );
  };
  return {
    get current() {
      return current;
    },
    get state(): WebglUiState {
      return { ...state };
    },
    async start() {
      if (started || disposed) throw new Error("终端界面已启动或关闭，请重开终端。");
      started = true;
      publish("starting", state.reason);
      try {
        const value = await acquire();
        if (disposed) {
          release(value);
          throw new Error("终端界面已关闭。");
        }
        current = value;
        publish("ready", "WebGL 终端已就绪。");
      } catch (error) {
        if (!disposed) publish("unavailable", error instanceof Error ? error.message : "WebGL 不可用，终端未启动。");
        throw error;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ++epoch;
      pending?.abort();
      release(current);
      current = undefined;
      publish("disposed", "终端界面已关闭。");
    },
  };
}
