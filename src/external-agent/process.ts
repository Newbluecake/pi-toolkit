/**
 * ManagedChild（external-agent plan §4.1 / arch §4.4）：零挂死的外部 CLI 进程管理。pi-free，provider 无关。
 * - detached 进程组：kill 一律 `process.kill(-pid, sig)`，ESRCH 视为已死；进程退出时顺手组杀残留成员。
 * - terminate("graceful")：stdin.end + SIGTERM 组 + killGraceMs 后 SIGKILL 组；("now")：立即 SIGKILL 组。幂等。
 * - 进程级登记 `Symbol.for("pi-subagent:external-agent-procs")` + 一次性 `process.on("exit")` 同步组杀（首次 spawn 才安装）。
 * - ownerWatchdog：`/bin/sh` 哨兵作组长，pi 死（pid 消失或 starttime 变化）⇒ `kill -KILL -$$`。
 * - 所有计时器走注入的 clock（生产为 unref 的 systemClock）；子进程与 stdio socket 均 unref。
 * - spawn 错误归类：ENOENT ⇒ ClassifiedError{config}；其余（EAGAIN/EMFILE/…）一律 internal。
 *   注意：**不得**抛 kind:"startup_transient" —— runner 目前没有 create() 重试循环（reducer 的 startup_retry
 *   分支不产生 effect，runner 会拿到 undefined outcome），抛它只会把可诊断的失败变成悬空状态。
 */
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { ClassifiedError } from "../core/errors.js";
import type { TimerHandle } from "../core/clock.js";
import { msgBinaryNotFound } from "./messages.js";
import { createRedactor } from "./redact.js";
import type { ChildExit, ManagedChild, ManagedChildOptions, SpawnChild } from "./types.js";

const REGISTRY_KEY = Symbol.for("pi-subagent:external-agent-procs");
const STDERR_RING_BYTES = 64 * 1024;
const CLOSE_WAIT_MS = 250;

interface Registry {
  procs: Map<number, { pid: number }>;
  hookInstalled: boolean;
}

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  let r = g[REGISTRY_KEY];
  if (r === undefined) {
    r = { procs: new Map(), hookInstalled: false };
    g[REGISTRY_KEY] = r;
  }
  return r;
}

function installExitHook(r: Registry): void {
  if (r.hookInstalled) return;
  r.hookInstalled = true;
  process.on("exit", () => {
    for (const pid of r.procs.keys()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
}

/** 哨兵脚本：$0=binary，$@=args；owner 信息经临时 env 传入并立即 unset（不泄漏给子进程）。 */
const WATCHDOG_SCRIPT = [
  'op="$__PTK_OWNER_PID"; os="$__PTK_OWNER_START"; unset __PTK_OWNER_PID __PTK_OWNER_START',
  'start_of() { sed "s/.*) //" "/proc/$1/stat" 2>/dev/null | cut -d" " -f20; }',
  "trap : TERM INT HUP",
  // 异步命令默认 stdin=/dev/null（dash 下裸 `0<&0` 不够）：先把真 stdin 存到 fd 3，再显式 0<&3 接回。
  "exec 3<&0",
  '"$0" "$@" 0<&3 3<&- &',
  "child=$!",
  "(",
  "  while :; do",
  "    sleep 1",
  '    if ! kill -0 "$op" 2>/dev/null; then kill -s KILL -- "-$$"; exit 0; fi',
  '    if [ -n "$os" ] && [ "$(start_of "$op")" != "$os" ]; then kill -s KILL -- "-$$"; exit 0; fi',
  "  done",
  ") </dev/null >/dev/null 2>&1 3<&- &",
  "watcher=$!",
  "while :; do",
  '  wait "$child"; rc=$?',
  '  kill -0 "$child" 2>/dev/null || break',
  "done",
  'kill "$watcher" 2>/dev/null',
  'exit "$rc"',
].join("\n");

function ownerStartTime(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  } catch {
    return "";
  }
}

function config(message: string): ClassifiedError {
  return new ClassifiedError({ kind: "config", message, retryable: false });
}
function internal(message: string): ClassifiedError {
  return new ClassifiedError({ kind: "internal", message, retryable: false });
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryResolvable(binary: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (binary.includes("/")) return isExecutable(resolve(cwd, binary));
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir !== "" && isExecutable(join(dir, binary))) return true;
  }
  return false;
}

export function createSpawnChild(redact: (text: string) => string): SpawnChild {
  return (o: ManagedChildOptions): ManagedChild => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...o.extraEnv };
    try {
      if (!statSync(o.cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw config(`working directory does not exist or is not a directory: ${o.cwd}`);
    }
    if (!binaryResolvable(o.binary, o.cwd, env)) throw config(msgBinaryNotFound(o.binary));

    let file = o.binary;
    let args: string[] = [...o.args];
    if (o.ownerWatchdog) {
      env.__PTK_OWNER_PID = String(process.pid);
      env.__PTK_OWNER_START = ownerStartTime(process.pid);
      file = "/bin/sh";
      args = ["-c", WATCHDOG_SCRIPT, o.binary, ...o.args];
    }

    let cp: ChildProcess;
    try {
      cp = spawn(file, args, { cwd: o.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw config(msgBinaryNotFound(o.binary));
      throw internal(`failed to spawn ${o.binary}: ${code ?? (e instanceof Error ? e.message : String(e))}`);
    }
    // 异步 'error'（spawn 失败时 pid 为 undefined）必须有监听器，否则 uncaught。
    let spawnErr: Error | undefined;
    cp.on("error", (e) => {
      spawnErr = e;
    });
    const pid = cp.pid;
    if (pid === undefined) {
      throw internal(`failed to spawn ${o.binary}: process could not be created (EAGAIN/EMFILE or similar)`);
    }
    cp.unref();
    for (const s of [cp.stdin, cp.stdout, cp.stderr]) {
      (s as unknown as { unref?: () => void } | null)?.unref?.();
    }

    const reg = registry();
    installExitHook(reg);
    reg.procs.set(pid, { pid });

    const stdin = cp.stdin;
    let stdinBroken = false;
    stdin?.on("error", () => {
      stdinBroken = true;
    });

    // stderr 环形缓冲
    let errChunks: Buffer[] = [];
    let errBytes = 0;
    cp.stderr?.on("data", (c: Buffer) => {
      errChunks.push(c);
      errBytes += c.length;
      while (errBytes > STDERR_RING_BYTES && errChunks.length > 1) errBytes -= (errChunks.shift() as Buffer).length;
      if (errBytes > STDERR_RING_BYTES) {
        const joined = Buffer.concat(errChunks).subarray(-STDERR_RING_BYTES);
        errChunks = [joined];
        errBytes = joined.length;
      }
    });

    let exit: ChildExit | undefined;
    let terminating = false;
    let killedNow = false;
    let graceExpired = false;
    let graceTimer: TimerHandle | undefined;
    let closeTimer: TimerHandle | undefined;
    let resolveExited!: (e: ChildExit) => void;
    const exited = new Promise<ChildExit>((res) => {
      resolveExited = res;
    });

    const killGroup = (sig: NodeJS.Signals): { ok: boolean; error?: string } => {
      try {
        process.kill(-pid, sig);
        return { ok: true };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return { ok: false };
        return { ok: false, error: `${code ?? "kill failed"}: ${e instanceof Error ? e.message : String(e)}` };
      }
    };
    const clearGrace = (): void => {
      if (graceTimer !== undefined) {
        o.clock.clearTimer(graceTimer);
        graceTimer = undefined;
      }
    };
    const settle = (): void => {
      if (closeTimer !== undefined) {
        o.clock.clearTimer(closeTimer);
        closeTimer = undefined;
      }
      resolveExited(exit ?? { code: null, signal: null });
    };

    cp.on("exit", (code, signal) => {
      exit = { code, signal };
      reg.procs.delete(pid);
      clearGrace();
      // 组长已退出：清理组内残留成员（如 MCP server）；ESRCH 无害。
      killGroup("SIGKILL");
      // 给 stdout 一个短窗口 drain（close），但绝不无限等待（孙进程可能持有管道）。
      closeTimer = o.clock.setTimer(CLOSE_WAIT_MS, settle);
    });
    cp.on("close", () => {
      if (exit !== undefined) settle();
    });
    // spawn 后异步失败（极少）：当作立即退出，不挂死。
    cp.on("error", () => {
      if (exit === undefined) {
        exit = { code: null, signal: null };
        reg.procs.delete(pid);
        settle();
      }
    });

    const child: ManagedChild = {
      pid,
      onStdout(cb) {
        cp.stdout?.on("data", cb);
      },
      write(line) {
        if (stdin === null || stdinBroken || stdin.destroyed || !stdin.writable || exit !== undefined) {
          throw internal("child stdin is closed (process exited or pipe broken)");
        }
        try {
          return stdin.write(line);
        } catch (e) {
          stdinBroken = true;
          throw internal(`failed to write to child stdin: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      onDrain(cb) {
        stdin?.on("drain", cb);
      },
      exited,
      exitInfo: () => exit,
      terminate(mode) {
        if (exit !== undefined) return { signalled: false };
        if (mode === "now") {
          if (killedNow) return { signalled: false };
          killedNow = true;
          terminating = true;
          clearGrace();
          const r = killGroup("SIGKILL");
          return r.error === undefined ? { signalled: r.ok } : { signalled: false, error: r.error };
        }
        if (terminating) return { signalled: false };
        terminating = true;
        try {
          stdin?.end();
        } catch {
          /* ignore */
        }
        const r = killGroup("SIGTERM");
        graceTimer = o.clock.setTimer(o.killGraceMs, () => {
          graceTimer = undefined;
          if (exit !== undefined || killedNow) return;
          graceExpired = true;
          killGroup("SIGKILL");
        });
        return r.error === undefined ? { signalled: r.ok } : { signalled: false, error: r.error };
      },
      terminating: () => terminating,
      graceExpired: () => graceExpired,
      stderrTail(maxBytes = 2048) {
        const all = Buffer.concat(errChunks);
        let s = all.subarray(Math.max(0, all.length - maxBytes)).toString("utf8");
        if (spawnErr !== undefined) s += `\n${spawnErr.message}`;
        return redact(s);
      },
    };
    return child;
  };
}

/** 默认实例：脱敏器用 `createRedactor(process.env)`（默认键）；其它 provider 用 createSpawnChild 注入自己的脱敏器。 */
export const spawnManagedChild: SpawnChild = (o) => createSpawnChild(createRedactor(process.env))(o);
