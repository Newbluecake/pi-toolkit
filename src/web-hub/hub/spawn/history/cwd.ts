/**
 * web-hub session-history plan §4.5.4 (`cwd.ts`): the per-cwd status cache the list and the
 * POST resolve path both consult. `realpath` ENOENT/ENOTDIR ⇒ `gone`, anything else ⇒
 * `no-access`; not a directory ⇒ `not-dir`; `access(R_OK|X_OK)` failure ⇒ `no-access`;
 * `realpath !== cwd` ⇒ `moved`; otherwise `ok`. A budget/zombie timeout degrades to `unknown`
 * WITHOUT caching (so the next request gets a fresh chance once the storm clears).
 */
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import type { HistoryCwdState } from "../../../protocol/session-history.js";
import type { ReqDeadline } from "../../req-deadline.js";
import { isPreviewIoError } from "../../preview/fs.js";
import {
  HISTORY_CWD_BUDGET_MS,
  HISTORY_CWD_CACHE_MS,
  HISTORY_CWD_STEP_MS,
  historyStep,
  isHistoryBusyError,
  type HistoryIoGate,
} from "./budget.js";
import { errCodeOf } from "./fs.js";

export interface CwdFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{ isDirectory(): boolean }>;
  access(p: string, mode: number): Promise<void>;
}

export function defaultCwdFs(): CwdFs {
  return { realpath: (p) => realpath(p), stat: (p) => stat(p), access: (p, mode) => access(p, mode) };
}

export interface CwdCheckDeps {
  fs: CwdFs;
  gate: HistoryIoGate;
  now(): number;
}

export interface CwdCache {
  check(cwd: string, deadline: ReqDeadline, deps: CwdCheckDeps): Promise<HistoryCwdState>;
  size(): number;
}

function isUnresolvable(err: unknown): boolean {
  return isHistoryBusyError(err) || isPreviewIoError(err);
}

export function createCwdCache(cacheMs: number = HISTORY_CWD_CACHE_MS): CwdCache {
  const cache = new Map<string, { state: HistoryCwdState; at: number }>();

  return {
    size: () => cache.size,
    async check(cwd, deadline, deps): Promise<HistoryCwdState> {
      const cached = cache.get(cwd);
      if (cached !== undefined && deps.now() - cached.at < cacheMs) return cached.state;

      const overallBudget = Math.min(HISTORY_CWD_BUDGET_MS, deadline.remaining());
      if (overallBudget <= 0) return "unknown";
      const overallAt = deps.now() + overallBudget;
      const step = <T>(lazy: () => Promise<T>): Promise<T> =>
        historyStep(deps.gate, lazy, Math.min(overallAt, deps.now() + HISTORY_CWD_STEP_MS), deps.now);

      const remember = (state: HistoryCwdState): HistoryCwdState => {
        cache.set(cwd, { state, at: deps.now() });
        return state;
      };

      let rp: string;
      try {
        rp = await step(() => deps.fs.realpath(cwd));
      } catch (err) {
        if (isUnresolvable(err)) return "unknown";
        const code = errCodeOf(err);
        if (code === "ENOENT" || code === "ENOTDIR") return remember("gone");
        return remember("no-access");
      }

      let isDir: boolean;
      try {
        isDir = (await step(() => deps.fs.stat(rp))).isDirectory();
      } catch (err) {
        if (isUnresolvable(err)) return "unknown";
        return remember("no-access");
      }
      if (!isDir) return remember("not-dir");

      try {
        await step(() => deps.fs.access(rp, constants.R_OK | constants.X_OK));
      } catch (err) {
        if (isUnresolvable(err)) return "unknown";
        return remember("no-access");
      }

      return remember(rp !== cwd ? "moved" : "ok");
    },
  };
}
