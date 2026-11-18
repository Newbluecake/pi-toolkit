import type { Clock } from "../core/clock.js";
import { createSegmentedClock } from "../core/clock.js";
import type { LoadSettings } from "../config/settings.js";
import { IoLedger } from "./io-ledger.js";
import { sampleOnce, type SamplerHost, type SamplerIo } from "./sampler.js";
import { createHostTopScanner, scanTop, type TopPrevious } from "./top.js";
import type { TopScanOptions } from "./top.js";
import { resolveSysloadHost } from "../web-hub/protocol/sysload-darwin.js";
import { createLoadTracker, type LoadTracker } from "./tracker.js";
import type { LoadLevel, LoadPort, TopSnapshot } from "./types.js";

const severity = (level: LoadLevel): number => (level === "crit" ? 2 : level === "warn" ? 1 : 0);
/** True when the level rose INTO warn/crit — ok→warn, ok→crit and warn→crit all count. */
export const escalated = (before: LoadLevel, after: LoadLevel): boolean => severity(after) > severity(before);

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
  /** darwin-plan §2.1/§3.1-S2: the platform-resolved host (test seam; production leaves this
   *  undefined and `resolveSysloadHost()` decides — `undefined` on every non-darwin platform, so
   *  the Linux path stays byte-identical). An injected `io` is AUTHORITATIVE for its own `host`
   *  field: no platform resolution ever happens behind a test's injected io (the Linux fixture
   *  suites must keep taking the Linux path on a mac dev machine). */
  readonly host?: SamplerHost;
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
  // darwin-plan §3.0: the FIRST compile-time compatibility checkpoint between S0's protocol
  // host and S1's C0 seam — this assignment typechecks only while DarwinHost still satisfies
  // SamplerHost structurally (protocol must never import sysload, not even type-only).
  const host: SamplerHost | undefined = deps.host ?? (deps.io !== undefined ? deps.io.host : resolveSysloadHost());
  const io: SamplerIo | undefined = host === undefined ? deps.io : { ...(deps.io ?? {}), host };
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
    void sampleOnce(io, plan, ledger, mine, deps.settings)
      .then((result) => {
        if (!started || disposed || mine !== generation) return;
        previousCpu = result.nextCpu;
        previousMono = result.sample.mono;
        if (result.mountinfoText !== undefined) {
          mountinfoText = result.mountinfoText;
          mountinfoAt = result.sample.mono;
        }
        const before = tracker.verdict(result.sample.mono, result.sample.at);
        tracker.observe(result.sample);
        const after = tracker.verdict(result.sample.mono, result.sample.at);
        // Scan top processes whenever the level rises into warn/crit (incl. warn→crit), not only when gating flips, so
        // the turn_end hint — which also fires with `load.gate=false` — has a snapshot to show.
        if ((!before.gating && after.gating) || escalated(before.level, after.level)) port.refreshTop();
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
      void (deps.scanTop ?? (host === undefined ? scanTop : createHostTopScanner(host)))(ledger, {
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
