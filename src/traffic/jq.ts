import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type JqErrorKind =
  | "not_found"
  | "version_too_low"
  | "compile_error"
  | "input_parse"
  | "runtime_error"
  | "timeout"
  | "output_empty"
  | "output_multi"
  | "output_invalid"
  | "output_too_large"
  | "spawn_error";

export class JqError extends Error {
  constructor(
    readonly kind: JqErrorKind,
    message: string,
    readonly rawStderr?: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "JqError";
  }
}

export interface JqRunOptions {
  /** T1 严格化：显式 undefined 可赋（exactOptionalPropertyTypes）。 */
  jqPath?: string | undefined;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const MAX_STDERR_BYTES = 2048;
let jqTempDir: string | null = null;
const filterFiles = new Map<string, string>();
const probeCache = new Map<string, Promise<{ ok: boolean; version: string | null; error?: JqErrorKind }>>();
const activeChildren = new Set<ChildProcess>();
let spawnCount = 0;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

function truncateBytes(value: Buffer): string {
  return value.subarray(0, MAX_STDERR_BYTES).toString("utf8");
}

function ensureTempDir(): string {
  if (jqTempDir === null) jqTempDir = mkdtempSync(join(tmpdir(), "pi-record-jq-"));
  return jqTempDir;
}

function filterFile(filter: string): string {
  const hash = createHash("sha1").update(filter).digest("hex").slice(0, 16);
  const existing = filterFiles.get(hash);
  if (existing) return existing;
  const file = join(ensureTempDir(), `${hash}.jq`);
  writeFileSync(file, filter, { mode: 0o600 });
  filterFiles.set(hash, file);
  return file;
}

function removeTempDir(): void {
  filterFiles.clear();
  if (jqTempDir === null) return;
  try {
    rmSync(jqTempDir, { recursive: true, force: true });
  } catch {}
  jqTempDir = null;
}

function cleanupOnExit(): void {
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  removeTempDir();
}

process.once("exit", cleanupOnExit);

function makeError(kind: JqErrorKind, stderr: string, code: number | null): JqError {
  const suffix = code === null ? "" : ` (exit ${code})`;
  return new JqError(kind, `jq ${kind}${suffix}`, stderr || undefined, code ?? undefined);
}

function runProcess(
  jqPath: string,
  args: string[],
  input: string | null,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ stdout: string; stderr: string; code: number | null; error: JqError | null }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      spawnCount++;
      child = spawn(jqPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { PATH: process.env.PATH ?? "", LANG: "C" },
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: "",
        code: null,
        error: new JqError("spawn_error", `jq spawn_error: ${String(err)}`),
      });
      return;
    }
    activeChildren.add(child);

    let stdoutBytes = 0;
    let stdout = "";
    let stderr = "";
    // 流式 chunk 的边界会切断多字节 UTF-8 序列（管道按 ~4KB/64KB 切片），
    // 逐 chunk toString() 会把被切断的字符解成 U+FFFD，改写后的 body 随之损坏。
    // StringDecoder 跨 chunk 保留残字节，保证只在真正非法的字节上产生替换字符。
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let forced: JqErrorKind | null = null;
    let spawnError: JqError | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      forced = "timeout";
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!forced) stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (stderr) stderr = truncateBytes(Buffer.from(stderr));
      if (spawnError) {
        resolve({ stdout, stderr, code, error: spawnError });
        return;
      }
      if (forced) {
        resolve({ stdout, stderr, code, error: makeError(forced, stderr, code) });
        return;
      }
      resolve({ stdout, stderr, code, error: null });
    };

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (!stdoutStream || !stderrStream || !stdinStream) {
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({
        stdout: "",
        stderr: "",
        code: null,
        error: new JqError("spawn_error", "jq spawn_error: missing stdio"),
      });
      return;
    }

    stdoutStream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.byteLength(chunk);
      stdoutBytes += bytes;
      if (stdoutBytes > maxOutputBytes && !forced) {
        forced = "output_too_large";
        try {
          child.kill("SIGKILL");
        } catch {}
        return;
      }
      if (!forced) stdout += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
    });
    stderrStream.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) {
        stderr += typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
        stderr = truncateBytes(Buffer.from(stderr));
      }
    });
    stdinStream.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        spawnError = makeError("not_found", "", null);
      } else {
        spawnError = new JqError("spawn_error", `jq spawn_error: ${err.message}`);
      }
    });
    child.on("close", (code) => {
      activeChildren.delete(child);
      finish(code);
    });

    if (input === null) {
      stdinStream.end();
    } else {
      try {
        stdinStream.write(input);
        stdinStream.end();
      } catch {}
    }
  });
}

export async function runJq(filter: string, input: string, opts: JqRunOptions = {}): Promise<string> {
  if (shuttingDown) throw new JqError("spawn_error", "jq spawn_error: engine shutting down");
  const jqPath = opts.jqPath || "jq";
  const timeoutMs = opts.timeoutMs ?? 2000;
  const maxOutputBytes = opts.maxOutputBytes ?? 16 * 1024 * 1024;
  const result = await runProcess(jqPath, ["-c", "-M", "-f", filterFile(filter)], input, timeoutMs, maxOutputBytes);
  if (result.error) throw result.error;
  if (result.code !== 0) {
    const kind: JqErrorKind =
      result.code === 2
        ? "not_found"
        : result.code === 3
          ? "compile_error"
          : result.code === 4
            ? "input_parse"
            : result.code === 5
              ? "runtime_error"
              : "runtime_error";
    throw makeError(kind, result.stderr, result.code);
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw makeError("output_empty", result.stderr, result.code);
  if (lines.length > 1) throw makeError("output_multi", result.stderr, result.code);
  const line = lines[0];
  if (line === undefined) throw makeError("output_empty", result.stderr, result.code);
  try {
    JSON.parse(line);
  } catch {
    throw makeError("output_invalid", result.stderr, result.code);
  }
  return line;
}

async function probe(jqPath: string): Promise<{ ok: boolean; version: string | null; error?: JqErrorKind }> {
  const result = await runProcess(jqPath, ["--version"], null, 2000, 64 * 1024);
  if (result.error) return { ok: false, version: null, error: result.error.kind };
  if (result.code !== 0) return { ok: false, version: null, error: result.code === 2 ? "not_found" : "runtime_error" };
  const match = result.stdout.trim().match(/jq-(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return { ok: false, version: null, error: "spawn_error" };
  const majorText = match[1];
  const minorText = match[2];
  if (majorText === undefined || minorText === undefined) return { ok: false, version: null, error: "spawn_error" };
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = match[3];
  const version = patch === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
  if (major < 1 || (major === 1 && minor < 6)) return { ok: false, version, error: "version_too_low" };
  return { ok: true, version };
}

export function probeJq(jqPath?: string): Promise<{ ok: boolean; version: string | null; error?: JqErrorKind }> {
  const key = jqPath || "jq";
  const cached = probeCache.get(key);
  if (cached) return cached;
  const promise = probe(key);
  probeCache.set(key, promise);
  return promise;
}

export function getSpawnCount(): number {
  return spawnCount;
}

export function getActiveChildCount(): number {
  return activeChildren.size;
}

function waitForChildren(children: ChildProcess[]): Promise<void> {
  return Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (!activeChildren.has(child)) {
            resolve();
            return;
          }
          child.once("close", () => resolve());
        }),
    ),
  ).then(() => undefined);
}

function resetJqState(): void {
  shuttingDown = false;
}

// 进程退出外的恢复由 session_start 调 resetJqEngine。
export async function shutdownJq(graceMs = 1000): Promise<void> {
  shuttingDown = true;
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const children = [...activeChildren];
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    });
    try {
      await Promise.race([waitForChildren(children), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    removeTempDir();
  })();
  try {
    await shutdownPromise;
  } finally {
    shutdownPromise = null;
  }
}

export function cleanupJqTempDir(): void {
  removeTempDir();
}

export function resetJqEngine(): void {
  resetJqState();
}

export function resetJqForTest(): void {
  resetJqState();
  shutdownPromise = null;
  filterFiles.clear();
  probeCache.clear();
  spawnCount = 0;
  removeTempDir();
}
