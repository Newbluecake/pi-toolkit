import type { Clock } from "../core/clock.js";
import { createSegmentedClock } from "../core/clock.js";
import type { LoadSettings } from "../config/settings.js";
import { IoLedger } from "./io-ledger.js";
import { sampleOnce, type SamplerIo } from "./sampler.js";
import { scanTop, type TopPrevious } from "./top.js";
import type { TopScanOptions } from "./top.js";
import { createLoadTracker, type LoadTracker } from "./tracker.js";
import type { LoadPort, TopSnapshot } from "./types.js";

export interface LoadActivationContext {
  readonly mode?: string;
  readonly home?: string;
  readonly cwd?: string;
}

export interface LoadActivationDeps {
  readonly settings: LoadSettings;
  readonly mono?: () => number;
  readonly wall?: () => number;
  readonly clock?: Clock;
  readonly io?: SamplerIo;
  /** Test seam for the bounded top scanner; production uses scanTop. */
  readonly scanTop?: (ledger: IoLedger, options: TopScanOptions) => Promise<TopSnapshot>;
}

export interface LoadActivation {
  start(ctx?: LoadActivationContext): void;
  stop(): void;
  port(): LoadPort;
  dispose(): void;
}

export function createLoadActivation(deps: LoadActivationDeps): LoadActivation {
  const mono = deps.mono ?? (() => performance.now());
  const wall = deps.wall ?? (() => Date.now());
  const clock = deps.clock ?? createLoadClock(mono);
  const ledger = new IoLedger();
  const tracker: LoadTracker = createLoadTracker(deps.settings, mono, wall);
  let generation = 0;
  let timer: ReturnType<Clock["setTimer"]> | undefined;
  let started = false;
  let disposed = false;
  let home: string | undefined;
  let cwd: string | undefined;
  let previousCpu: Awaited<ReturnType<typeof sampleOnce>>["nextCpu"];
  let previousMono: number | undefined;
  let mountinfoText: string | undefined;
  let mountinfoAt = -Infinity;
  const realpathCache = new Map<string, { path: string; at: number }>();
  let topSnapshot: TopSnapshot | undefined;
  let topPrevious: TopPrevious | undefined;
  let topInFlight = false;
  let topLastAt = -Infinity;

  const tick = (): void => {
    if (!started || disposed) return;
    const mine = generation;
    const plan = {
      ...(home === undefined ? {} : { home }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(previousCpu === undefined ? {} : { previousCpu }),
      ...(previousMono === undefined ? {} : { previousMono }),
      ...(mountinfoText !== undefined && mono() - mountinfoAt <= 60_000 ? { mountinfoText } : {}),
      realpathCache,
      expectedGeneration: () => generation,
      mono,
      at: wall,
    };
    void sampleOnce(deps.io, plan, ledger, mine, deps.settings)
      .then((result) => {
        if (!started || disposed || mine !== generation) return;
        previousCpu = result.nextCpu;
        previousMono = result.sample.mono;
        if (result.mountinfoText !== undefined) {
          mountinfoText = result.mountinfoText;
          mountinfoAt = result.sample.mono;
        }
        tracker.observe(result.sample);
      })
      .catch(() => undefined)
      .finally(() => {
        if (started && !disposed && mine === generation) timer = clock.setTimer(deps.settings.sampleIntervalMs, tick);
      });
  };

  const port: LoadPort = {
    verdict: () => tracker.verdict(mono(), wall()),
    top: () => topSnapshot,
    refreshTop: () => {
      if (disposed || topInFlight || mono() - topLastAt < 30_000) return;
      topInFlight = true;
      const mine = generation;
      void (deps.scanTop ?? scanTop)(ledger, {
        now: mono,
        isCurrent: () => !disposed && mine === generation,
        ...(topPrevious === undefined ? {} : { previous: topPrevious }),
        onPrevious: (next) => {
          if (!disposed && mine === generation) topPrevious = next;
        },
      })
        .then((snapshot) => {
          if (!disposed && mine === generation) topSnapshot = snapshot;
        })
        .catch(() => undefined)
        .finally(() => {
          topInFlight = false;
          topLastAt = mono();
        });
    },
  };

  return {
    start(ctx = {}): void {
      if (disposed || started || !deps.settings.enabled || ctx.mode === "print" || ctx.mode === "json") return;
      started = true;
      home = ctx.home;
      cwd = ctx.cwd;
      generation += 1;
      tick();
    },
    stop(): void {
      if (!started) return;
      started = false;
      generation += 1;
      previousCpu = undefined;
      previousMono = undefined;
      mountinfoText = undefined;
      mountinfoAt = -Infinity;
      realpathCache.clear();
      topPrevious = undefined;
      if (timer !== undefined) {
        clock.clearTimer(timer);
        timer = undefined;
      }
    },
    port: () => port,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      started = false;
      if (timer !== undefined) clock.clearTimer(timer);
      timer = undefined;
      topSnapshot = undefined;
      topPrevious = undefined;
    },
  };
}

export function createLoadClock(mono: () => number): Clock {
  return createSegmentedClock({
    now: mono,
    set: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      (timer as { unref?: () => void }).unref?.();
      return timer;
    },
    clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
}
