import { describe, expect, it, vi } from "vitest";
import {
  createBashJobTool,
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  finalStatusLine,
  formatJobSummary,
  STATUS_TAIL_BYTES,
  STATUS_TAIL_LINES,
  BashJobToolParams,
  type BashJobToolParams as BashJobToolParamsType,
} from "../../src/tools/bash-job-tool.js";
import type { BashJobManager, JobOutputRead, KillJobResult, ReadOutputOptions } from "../../src/bash/manager.js";
import { isTerminalJobStatus, type JobId, type JobRecord, type JobStatus } from "../../src/bash/types.js";

/**
 * T10-T16 (docs/dev/bash-auto-background/plan-fable.md section 9): the
 * `bash_job` tool's four actions against a fake BashJobManager — status
 * wording per state, the log tail `status` carries, bounded wait, idempotent
 * kill, list, and prefix resolution. There is no `output` action: the log is a
 * plain file the model reads directly (change C).
 */

const theme = { fg: (_tone: string, value: string) => value, bold: (value: string) => value } as never;
const renderContext = { lastComponent: undefined } as never;
const NOW = 1_000_000;

function makeRecord(over: Partial<JobRecord> & { jobId: JobId }): JobRecord {
  return {
    v: 1,
    command: "npm test",
    cwd: "/repo",
    sessionId: "s1",
    hostPid: 4242,
    status: "running",
    createdAt: NOW - 60_000,
    spawnedAt: NOW - 60_000,
    exitCode: null,
    logPath: `/tmp/${over.jobId}.log`,
    logBytes: 0,
    outputTruncated: false,
    readCursor: 0,
    ...over,
  };
}

interface FakeManager extends BashJobManager {
  readonly calls: string[];
  failReads?: boolean;
  put(record: JobRecord, log?: string): void;
  setLog(jobId: JobId, log: string): void;
  settleWait(jobId: JobId, record?: JobRecord): void;
}

/** Minimal in-memory stand-in for the real manager (S4). */
function fakeManager(options: { waitResolvesImmediately?: boolean } = {}): FakeManager {
  const records = new Map<JobId, JobRecord>();
  const logs = new Map<JobId, string>();
  const waiters = new Map<JobId, (record: JobRecord | undefined) => void>();
  const calls: string[] = [];

  const manager: FakeManager = {
    calls,
    dir: "/tmp/bash-jobs",
    maxBackgroundJobs: 8,
    put(record, log = "") {
      records.set(record.jobId, record);
      logs.set(record.jobId, log);
    },
    setLog(jobId, log) {
      logs.set(jobId, log);
    },
    settleWait(jobId, record) {
      const resolve = waiters.get(jobId);
      if (record) records.set(jobId, record);
      waiters.delete(jobId);
      resolve?.(record ?? records.get(jobId));
    },
    async recover() {
      throw new Error("unused");
    },
    async create() {
      throw new Error("unused");
    },
    reserve() {
      throw new Error("unused in bash_job tests");
    },
    cancelReserve() {},
    markBackgroundedSync() {},
    async extend(): Promise<never> {
      throw new Error("unused in bash_job tests");
    },
    async waitAllExit() {},
    get(jobId) {
      return records.get(jobId);
    },
    async load(jobId) {
      calls.push(`load:${jobId}`);
      return records.get(jobId);
    },
    list() {
      return [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    resolve(handle) {
      const trimmed = handle.trim();
      if (records.has(trimmed)) return trimmed;
      const matches = trimmed.length > 0 ? [...records.keys()].filter((id) => id.startsWith(trimmed)) : [];
      if (matches.length === 1) return matches[0]!;
      const candidates = [...records.keys()].join(", ") || "none";
      throw new Error(
        matches.length > 1
          ? `ambiguous bash job target: ${trimmed}. Candidates: [${candidates}]`
          : `bash job not found: ${trimmed}. Candidates: [${candidates}]`,
      );
    },
    async markBackgrounded(jobId) {
      return records.get(jobId);
    },
    async setFinalText(jobId) {
      return records.get(jobId);
    },
    noteTermination() {},
    async readOutput(jobId: JobId, readOptions: ReadOutputOptions = {}): Promise<JobOutputRead> {
      const record = records.get(jobId);
      if (!record) throw new Error(`bash job not found: ${jobId}`);
      if (manager.failReads) throw new Error("log unreadable");
      const log = Buffer.from(logs.get(jobId) ?? "", "utf8");
      const startOffset = Math.min(Math.max(0, readOptions.offset ?? record.readCursor), log.length);
      const end = Math.min(log.length, startOffset + (readOptions.maxBytes ?? log.length));
      const content = log.subarray(startOffset, end).toString("utf8");
      const nextOffset = end;
      calls.push(`readOutput:${jobId}:${startOffset}`);
      if (readOptions.advanceCursor !== false && nextOffset > record.readCursor) {
        records.set(jobId, { ...record, readCursor: nextOffset, logBytes: log.length });
      }
      const current = records.get(jobId)!;
      const read: JobOutputRead = {
        jobId,
        content,
        startOffset,
        nextOffset,
        logBytes: log.length,
        state: current.status,
        exitCode: current.exitCode,
        logTruncated: current.outputTruncated,
        ...(current.finalText !== undefined ? { finalText: current.finalText } : {}),
        record: current,
      };
      return read;
    },
    async kill(jobId): Promise<KillJobResult> {
      const record = records.get(jobId);
      if (!record) throw new Error(`bash job not found: ${jobId}`);
      calls.push(`kill:${jobId}`);
      if (isTerminalJobStatus(record.status)) {
        return { jobId, outcome: "already-terminal", alreadyTerminal: true, record };
      }
      if (record.pid === -1) {
        const orphan = { ...record, status: "orphaned" as JobStatus };
        records.set(jobId, orphan);
        return {
          jobId,
          outcome: "refused",
          alreadyTerminal: false,
          reason: `job ${jobId} cannot be safely killed: its pid ownership could not be verified`,
          record: orphan,
        };
      }
      const killed = { ...record, status: "killed" as JobStatus, endedAt: NOW };
      records.set(jobId, killed);
      return { jobId, outcome: "signalled", alreadyTerminal: false, record: killed };
    },
    waitExit(jobId, timeoutMs, opts) {
      calls.push(`waitExit:${jobId}:${timeoutMs}`);
      const record = records.get(jobId);
      if (!record) return Promise.resolve(undefined);
      if (isTerminalJobStatus(record.status) || options.waitResolvesImmediately) return Promise.resolve(record);
      if (opts?.signal?.aborted) return Promise.resolve(record);
      return new Promise((resolve) => {
        waiters.set(jobId, resolve);
        opts?.signal?.addEventListener(
          "abort",
          () => {
            waiters.delete(jobId);
            resolve(records.get(jobId));
          },
          { once: true },
        );
      });
    },
    backgroundJobCount() {
      return 0;
    },
    hasBackgroundCapacity() {
      return true;
    },
    dispose() {},
  };
  return manager;
}

/** Yield until the tool has reached the fake manager's `waitExit`. */
async function waitForCall(manager: FakeManager, call: string): Promise<void> {
  for (let i = 0; i < 100 && !manager.calls.includes(call); i++) await Promise.resolve();
  if (!manager.calls.includes(call)) throw new Error(`never observed ${call} (saw ${manager.calls.join(", ")})`);
}

function run(manager: BashJobManager | undefined, params: BashJobToolParamsType) {
  const tool = createBashJobTool({ manager: () => manager, now: () => NOW });
  return tool.execute("tc", params, undefined, undefined, {} as never);
}

describe("bash_job — T10 status wording per state", () => {
  it.each([
    [{ status: "running" as JobStatus, pid: 23456, logBytes: 2048 }, /running for 1m00s \(pid 23456, log 2\.0KB\)/],
    [{ status: "completed" as JobStatus, exitCode: 0, endedAt: NOW - 10_000 }, /completed \(exit 0\) after 50s/],
    [{ status: "failed" as JobStatus, exitCode: 1, endedAt: NOW }, /failed \(exit 1\) after 1m00s/],
    [{ status: "timed_out" as JobStatus, endedAt: NOW }, /timed out after/],
    [{ status: "killed" as JobStatus, endedAt: NOW }, /killed after/],
    [{ status: "exited_unknown" as JobStatus, endedAt: NOW }, /exit code lost/],
    [{ status: "orphaned" as JobStatus, endedAt: NOW }, /orphaned \(left behind by an earlier pi process\)/],
    [{ status: "staged" as JobStatus, spawnedAt: undefined }, /not started yet/],
  ])("summarizes %j", async (over, expected) => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_AAAA1111", ...over }));
    const response = await run(manager, { action: "status", job_id: "b_AAAA1111" });
    expect(response.content[0]!.text).toMatch(expected);
    expect(response.content[0]!.text).toContain("$ npm test");
  });

  it("carries a structured details payload and points at the log file", async () => {
    const manager = fakeManager();
    manager.put(
      makeRecord({ jobId: "b_AAAA1111", status: "failed", exitCode: 2, endedAt: NOW, pid: 77, logBytes: 12 }),
      "boom\n",
    );
    const response = await run(manager, { action: "status", job_id: "b_AAAA1111" });
    const out = response.content[0]!.text;
    expect(out).toContain("Full log: /tmp/b_AAAA1111.log");
    expect(out).toMatch(/read tool.*tail\/grep\/awk/);
    expect(out).not.toContain('action: "output"');
    expect(response.details).toMatchObject({
      jobId: "b_AAAA1111",
      status: "failed",
      exitCode: 2,
      terminal: true,
      pid: 77,
      logPath: "/tmp/b_AAAA1111.log",
    });
  });
});

/**
 * T11/T12 (reshaped by change C): `output` is gone; `status` carries a bounded
 * log tail and always names the log file. The tail read must never advance the
 * persisted cursor, so status stays a free, repeatable poll.
 */
describe("bash_job — T11/T12 status log tail", () => {
  it("shows the tail of a running job's log without consuming it", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_BBBB2222", logBytes: 6 }), "hello\n");
    const first = await run(manager, { action: "status", job_id: "b_BBBB2222" });
    const out = first.content[0]!.text;
    expect(out).toContain("running for 1m00s");
    expect(out).toContain("--- log tail (last 20 lines");
    expect(out).toContain("hello");
    expect(first.details).toMatchObject({ tailBytes: 6, tailFromOffset: 0 });

    // No cursor was advanced, so the same content is still there next time,
    // and the whole log remains readable from byte 0.
    manager.setLog("b_BBBB2222", "hello\nworld\n");
    const second = await run(manager, { action: "status", job_id: "b_BBBB2222" });
    expect(second.content[0]!.text).toContain("hello");
    expect(second.content[0]!.text).toContain("world");
    expect(manager.get("b_BBBB2222")!.readCursor).toBe(0);
  });

  it("keeps only the last STATUS_TAIL_LINES lines", async () => {
    const manager = fakeManager();
    const log = `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")}\n`;
    manager.put(makeRecord({ jobId: "b_BBBB2222", logBytes: log.length }), log);
    const out = (await run(manager, { action: "status", job_id: "b_BBBB2222" })).content[0]!.text;
    expect(out).toContain("line 59");
    expect(out).not.toContain("line 39");
    expect(out.split("\n").filter((line) => line.startsWith("line ")).length).toBe(STATUS_TAIL_LINES);
  });

  it("says so when the log is still empty", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_BBBB2222" }), "");
    const out = (await run(manager, { action: "status", job_id: "b_BBBB2222" })).content[0]!.text;
    expect(out).toContain("(the log is empty so far)");
    expect(out).toContain("Full log: /tmp/b_BBBB2222.log");
  });

  it("surfaces the terminal footer the manager wrote into the log", async () => {
    const manager = fakeManager();
    const log = "boom\n[pi-subagent] job b_CCCC3333 failed (exit 1) after 2m30s\n";
    manager.put(
      makeRecord({ jobId: "b_CCCC3333", status: "failed", exitCode: 1, endedAt: NOW, logBytes: log.length }),
      log,
    );
    const out = (await run(manager, { action: "status", job_id: "b_CCCC3333" })).content[0]!.text;
    expect(out).toContain("failed (exit 1) after 1m00s");
    expect(out).toContain("[pi-subagent] job b_CCCC3333 failed (exit 1) after 2m30s");
  });

  it("flags a capped log", async () => {
    const manager = fakeManager();
    manager.put(
      makeRecord({ jobId: "b_CCCC3333", status: "killed", endedAt: NOW, outputTruncated: true, logBytes: 8 }),
      "partial\n",
    );
    const out = (await run(manager, { action: "status", job_id: "b_CCCC3333" })).content[0]!.text;
    expect(out).toContain("(the job's log hit its size cap; some output was dropped)");
  });

  it("reads at most STATUS_TAIL_BYTES from the end and clips with truncateTail", async () => {
    const manager = fakeManager();
    const huge = `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")}\n`;
    manager.put(makeRecord({ jobId: "b_DDDD4444", logBytes: huge.length }), huge);
    const response = await run(manager, { action: "status", job_id: "b_DDDD4444" });
    const out = response.content[0]!.text;
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("line 4999");
    expect(out).not.toContain("line 0\n");
    expect(response.details).toMatchObject({ tailBytes: STATUS_TAIL_BYTES });
    // Two passes: the record's byte counter can lag behind the real file.
    expect(manager.calls.filter((call) => call.startsWith("readOutput:b_DDDD4444")).length).toBeGreaterThanOrEqual(1);
  });

  it("degrades to a plain summary when the log cannot be read", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_DDDD4444", status: "completed", exitCode: 0, endedAt: NOW }));
    manager.failReads = true;
    const out = (await run(manager, { action: "status", job_id: "b_DDDD4444" })).content[0]!.text;
    expect(out).toContain("completed (exit 0)");
    expect(out).toContain("Full log: /tmp/b_DDDD4444.log");
  });

  it("no longer accepts an offset parameter", () => {
    const properties = (BashJobToolParams as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["action", "job_id", "wait_ms"]);
    expect(properties.offset).toBeUndefined();
    const actions = (
      BashJobToolParams as { properties: { action: { anyOf: { const: string }[] } } }
    ).properties.action.anyOf.map((entry) => entry.const);
    expect(actions).toEqual(["status", "wait", "kill", "list"]);
  });
});

describe("bash_job — T13 bounded wait", () => {
  it("returns the current status on timeout instead of throwing", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_EEEE5555", pid: 31337 }));
    const pending = run(manager, { action: "wait", job_id: "b_EEEE5555", wait_ms: 5 });
    // The manager's waitExit owns the deadline; simulate it firing with the
    // still-running record (the real one does exactly this — Z1).
    await waitForCall(manager, "waitExit:b_EEEE5555:5");
    manager.settleWait("b_EEEE5555");
    const response = await pending;
    expect(response.content[0]!.text).toMatch(/running for/);
    expect(response.content[0]!.text).toContain("the job was not stopped");
    expect(response.details).toMatchObject({ finished: false, waitedMs: 5 });
  });

  it("defaults to 30s and caps the wait at 120s", async () => {
    const manager = fakeManager({ waitResolvesImmediately: true });
    manager.put(makeRecord({ jobId: "b_EEEE5555" }));
    await run(manager, { action: "wait", job_id: "b_EEEE5555" });
    await run(manager, { action: "wait", job_id: "b_EEEE5555", wait_ms: 999_999 });
    await run(manager, { action: "wait", job_id: "b_EEEE5555", wait_ms: -5 });
    expect(manager.calls).toContain(`waitExit:b_EEEE5555:${DEFAULT_WAIT_MS}`);
    expect(manager.calls).toContain(`waitExit:b_EEEE5555:${MAX_WAIT_MS}`);
    expect(manager.calls).toContain("waitExit:b_EEEE5555:0");
  });

  it("returns immediately for an already terminal job, without waiting", async () => {
    const manager = fakeManager();
    manager.put(
      makeRecord({
        jobId: "b_FFFF6666",
        status: "completed",
        exitCode: 0,
        endedAt: NOW,
        finalText: "ok\n\nCommand exited with code 0",
      }),
    );
    const response = await run(manager, { action: "wait", job_id: "b_FFFF6666" });
    expect(manager.calls.some((call) => call.startsWith("waitExit:"))).toBe(false);
    expect(response.content[0]!.text).toContain("completed (exit 0)");
    expect(response.content[0]!.text).toContain("Command exited with code 0");
    expect(response.details).toMatchObject({ finished: true });
  });

  it("interrupts the wait promptly when the tool-call signal aborts (Esc / teardown)", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_EEEE5555", pid: 31337 }));
    const tool = createBashJobTool({ manager: () => manager, now: () => NOW });
    const controller = new AbortController();
    const pending = tool.execute(
      "tc",
      { action: "wait", job_id: "b_EEEE5555", wait_ms: 60_000 },
      controller.signal,
      undefined,
      {} as never,
    );
    await waitForCall(manager, "waitExit:b_EEEE5555:60000");
    controller.abort();
    // pi's Esc / /exit path aborts in-flight tool calls and then waits for
    // them to settle — the wait must not outlive the abort all the way to
    // its wait_ms deadline, or the turn (and exit) stays wedged.
    await expect(pending).rejects.toThrow("wait was aborted");
  });
});

describe("bash_job — T14 kill", () => {
  it("kills a running job and keeps the log readable", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_GGGG7777", pid: 999 }));
    const response = await run(manager, { action: "kill", job_id: "b_GGGG7777" });
    expect(response.content[0]!.text).toContain("signalled");
    expect(response.details).toMatchObject({ killed: true, status: "killed", outcome: "signalled" });
  });

  it("is idempotent: a finished job reports already-finished instead of failing", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_GGGG7777", status: "completed", exitCode: 0, endedAt: NOW }));
    const response = await run(manager, { action: "kill", job_id: "b_GGGG7777" });
    expect(response.content[0]!.text).toContain("has already finished (completed (exit 0)); nothing to kill");
    expect(response.details).toMatchObject({ alreadyTerminal: true, killed: false });
  });

  it("refuses an orphaned job with a reason, both when refused and when already marked", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_HHHH8888", pid: -1 }));
    await expect(run(manager, { action: "kill", job_id: "b_HHHH8888" })).rejects.toThrow(
      /cannot be safely killed.*pid ownership/,
    );
    // Second call: the record is now orphaned — still refused, with the same intent.
    await expect(run(manager, { action: "kill", job_id: "b_HHHH8888" })).rejects.toThrow(
      /left behind by an earlier pi process and cannot be safely killed/,
    );
  });
});

describe("bash_job — T15 list", () => {
  it("reports an empty table", async () => {
    const response = await run(fakeManager(), { action: "list" });
    expect(response.content[0]!.text).toBe("no bash jobs");
    expect(response.details).toMatchObject({ count: 0, jobs: [] });
  });

  it("lists one line per job with state, command preview and age", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_AAAA1111", createdAt: NOW - 720_000, command: "npm run build:all" }));
    manager.put(
      makeRecord({
        jobId: "b_BBBB2222",
        createdAt: NOW - 120_000,
        command: "pytest -x",
        status: "completed",
        exitCode: 0,
        endedAt: NOW,
      }),
    );
    const response = await run(manager, { action: "list" });
    const lines = response.content[0]!.text.split("\n");
    expect(lines[0]).toBe("2 bash jobs:");
    expect(lines[1]).toBe("b_AAAA1111 · running · $ npm run build:all · 12m00s ago");
    expect(lines[2]).toBe("b_BBBB2222 · completed (exit 0) · $ pytest -x · 2m00s ago");
    expect(response.details).toMatchObject({ count: 2 });
  });
});

describe("bash_job — T16 job_id resolution and guards", () => {
  it("accepts an exact id and a unique prefix", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_AAAA1111" }));
    manager.put(makeRecord({ jobId: "b_ZZZZ9999" }));
    await expect(run(manager, { action: "status", job_id: "b_AAAA1111" })).resolves.toBeDefined();
    const byPrefix = await run(manager, { action: "status", job_id: "b_Z" });
    expect(byPrefix.details).toMatchObject({ jobId: "b_ZZZZ9999" });
  });

  it("throws a candidate-listing error for an ambiguous or unknown handle", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_AAAA1111" }));
    manager.put(makeRecord({ jobId: "b_AAAA2222" }));
    await expect(run(manager, { action: "status", job_id: "b_AAAA" })).rejects.toThrow(
      /ambiguous bash job target.*Candidates: \[b_AAAA1111, b_AAAA2222\]/,
    );
    await expect(run(manager, { action: "kill", job_id: "b_NOPE" })).rejects.toThrow(/bash job not found/);
  });

  it("requires job_id for every action except list", async () => {
    const manager = fakeManager();
    for (const action of ["status", "wait", "kill"] as const) {
      await expect(run(manager, { action })).rejects.toThrow(`bash_job(action: "${action}") requires job_id`);
      await expect(run(manager, { action, job_id: "   " })).rejects.toThrow("requires job_id");
    }
    await expect(run(manager, { action: "list" })).resolves.toBeDefined();
  });

  it("fails clearly when no session stack is active", async () => {
    await expect(run(undefined, { action: "list" })).rejects.toThrow("no active session yet");
  });

  it("renders a single-line call", () => {
    const tool = createBashJobTool({ manager: () => undefined });
    const rendered = tool.renderCall!({ action: "status", job_id: "b_AAAA1111" }, theme, renderContext) as {
      text: string;
    };
    expect(rendered.text).toBe("bash_job status b_AAAA1111");
    const list = tool.renderCall!({ action: "list" }, theme, renderContext) as { text: string };
    expect(list.text).toBe("bash_job list");
  });

  it("keeps model-facing strings free of internal jargon", () => {
    const tool = createBashJobTool({ manager: () => undefined });
    const strings = [tool.description, tool.promptSnippet ?? "", JSON.stringify(tool.parameters)];
    for (const value of strings) expect(value).not.toMatch(/[§]|architecture/);
    expect(tool.description).toContain("job_id");
    expect(tool.promptSnippet).toContain("unique prefix");
    // Change A: the model must be told the log is an ordinary file.
    expect(tool.description).toMatch(/plain file/);
    expect(tool.description).toMatch(/read tool|tail\/grep\/awk/);
  });
});

describe("bash_job — exported formatters", () => {
  it("prefers the inner tool's closing line over a synthesized one", () => {
    const record = makeRecord({
      jobId: "b_AAAA1111",
      status: "timed_out",
      endedAt: NOW,
      finalText: "output\n\nCommand timed out after 5 seconds",
    });
    expect(finalStatusLine(record)).toBe("Command timed out after 5 seconds");
    expect(finalStatusLine({ ...record, finalText: "just output" })).toBe(
      "Command timed out and its process tree was killed",
    );
  });

  it("clamps a negative elapsed time instead of rendering nonsense", () => {
    const record = makeRecord({ jobId: "b_AAAA1111", spawnedAt: NOW + 5_000 });
    expect(formatJobSummary(record, NOW)).toContain("running for 0ms");
  });
});

describe("bash_job — status poll guard (anti-loop frequency warning)", () => {
  const setup = () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_AAAA1111", status: "running", pid: 23456 }), "line\n");
    return manager;
  };
  const status = (tool: ReturnType<typeof createBashJobTool>, jobId = "b_AAAA1111") =>
    tool.execute("tc", { action: "status", job_id: jobId }, undefined, undefined, {} as never);

  it("does not warn at or below the default threshold (3 status calls per job within 120s)", async () => {
    const tool = createBashJobTool({ manager: setup, now: () => NOW });
    for (let i = 0; i < 3; i++) {
      const r = await status(tool);
      expect(r.content[0]!.text).not.toContain("Polling too frequently");
    }
  });

  it("warns on the 4th status poll of the same job within the window, keeping the status payload", async () => {
    const tool = createBashJobTool({ manager: setup, now: () => NOW });
    for (let i = 0; i < 3; i++) await status(tool);
    const r = await status(tool);
    expect(r.content[0]!.text).toContain("Polling too frequently");
    expect(r.content[0]!.text).toContain('"b_AAAA1111"');
    expect(r.content[0]!.text).toContain('action: "wait"');
    expect(r.content[0]!.text).toMatch(/running for 1m00s/); // status payload survives the warning
  });

  it("tracks frequency per job_id — listing/checking many different jobs does not warn", async () => {
    const manager = setup();
    for (const id of ["b_BBBB2222", "b_CCCC3333", "b_DDDD4444", "b_EEEE5555"]) {
      manager.put(makeRecord({ jobId: id, status: "running" }));
    }
    const tool = createBashJobTool({ manager: () => manager, now: () => NOW });
    for (const id of ["b_AAAA1111", "b_BBBB2222", "b_CCCC3333", "b_DDDD4444", "b_EEEE5555"]) {
      const r = await status(tool, id);
      expect(r.content[0]!.text).not.toContain("Polling too frequently");
    }
  });

  it("does not count wait/kill/list actions toward the status poll budget", async () => {
    const manager = setup();
    manager.put(makeRecord({ jobId: "b_DONE0000", status: "completed", exitCode: 0, endedAt: NOW }));
    const tool = createBashJobTool({ manager: () => manager, now: () => NOW });
    await tool.execute("tc", { action: "list" }, undefined, undefined, {} as never);
    // wait on an already-terminal job returns immediately without blocking.
    await tool.execute("tc", { action: "wait", job_id: "b_DONE0000" }, undefined, undefined, {} as never);
    for (let i = 0; i < 3; i++) {
      const r = await status(tool);
      expect(r.content[0]!.text).not.toContain("Polling too frequently");
    }
  });

  it("stops warning after the window slides past the burst", async () => {
    let now = NOW;
    const tool = createBashJobTool({ manager: setup, now: () => now });
    for (let i = 0; i < 3; i++) await status(tool);
    expect((await status(tool)).content[0]!.text).toContain("Polling too frequently");
    now += 121_000;
    expect((await status(tool)).content[0]!.text).not.toContain("Polling too frequently");
  });
});

describe("bash_job — wait timeout streak (repeated timing-out waits escalate guidance)", () => {
  // waitResolvesImmediately makes waitExit return the still-running record at
  // once — exactly what a wait that hit its budget looks like to the tool.
  const setup = () => {
    const manager = fakeManager({ waitResolvesImmediately: true });
    manager.put(makeRecord({ jobId: "b_AAAA1111", status: "running", pid: 23456 }), "line\n");
    return manager;
  };
  const wait = (tool: ReturnType<typeof createBashJobTool>) =>
    tool.execute("tc", { action: "wait", job_id: "b_AAAA1111", wait_ms: 5_000 }, undefined, undefined, {} as never);

  it("first timing-out wait suggests a larger wait_ms or awaiting the notification, without escalation", async () => {
    const tool = createBashJobTool({ manager: setup, now: () => NOW });
    const text = (await wait(tool)).content[0]!.text;
    expect(text).toContain("Still running after waiting 5s");
    expect(text).toContain("wait_ms");
    expect(text).toContain("completion notification");
    expect(text).not.toContain("consecutive wait timeouts");
  });

  it("escalates on the 2nd consecutive timing-out wait with streak and blocked total", async () => {
    const tool = createBashJobTool({ manager: setup, now: () => NOW });
    await wait(tool);
    const text = (await wait(tool)).content[0]!.text;
    expect(text).toContain("2 consecutive wait timeouts");
    expect(text).toContain("10s spent blocked");
  });

  it("a finished job resets the streak", async () => {
    const manager = setup();
    const tool = createBashJobTool({ manager: () => manager, now: () => NOW });
    await wait(tool); // streak 1
    await wait(tool); // streak 2 (escalated)
    manager.put(makeRecord({ jobId: "b_AAAA1111", status: "completed", exitCode: 0, endedAt: NOW }), "line\n");
    const finished = await wait(tool); // terminal -> reset
    expect(finished.content[0]!.text).toContain("Command exited with code 0");
    manager.put(makeRecord({ jobId: "b_AAAA1111", status: "running", pid: 23456 }), "line\n");
    const text = (await wait(tool)).content[0]!.text;
    expect(text).toContain("Still running after waiting 5s");
    expect(text).not.toContain("consecutive wait timeouts"); // back to first-timeout wording
  });
});

// ── T16 (bash-timeout-grace §2.6/§3.6): extend, schema trimming, D budgets ─

import type { ExtendJobOutcome } from "../../src/bash/manager.js";
import type { JobDeadline, JobDeadlinePolicy } from "../../src/bash/types.js";
import type { HostRunView } from "../../src/bash/child-registry.js";
import { BashJobToolExtendParams } from "../../src/tools/bash-job-tool.js";

const POLICY: JobDeadlinePolicy = { graceMs: 60_000, maxExtensions: 3, maxTimeoutFactor: 3 };

function makeDeadline(over: Partial<JobDeadline> = {}): JobDeadline {
  return {
    timeoutMs: 600_000,
    policy: POLICY,
    dueAt: NOW + 60_000,
    hardAt: NOW + 1_800_000,
    graces: 0,
    graceNotified: 0,
    extensions: 0,
    grantedMs: 0,
    seq: 0,
    ...over,
  };
}

/** Deadline fake: the base fake plus a scriptable `extend` (§2.6). */
function fakeDeadlineManager(): FakeManager & {
  extendCalls: { jobId: string; extendMs: number; reason?: string }[];
  extendOutcome: ExtendJobOutcome | undefined;
  setExtendOutcome(outcome: ExtendJobOutcome): void;
} {
  const base = fakeManager();
  const extendCalls: { jobId: string; extendMs: number; reason?: string }[] = [];
  const holder: {
    extendOutcome: ExtendJobOutcome | undefined;
  } = { extendOutcome: undefined };
  return Object.assign(base, {
    extendCalls,
    ...holder,
    setExtendOutcome(outcome: ExtendJobOutcome) {
      holder.extendOutcome = outcome;
    },
    async extend(jobId: string, extendMs: number, reason?: string): Promise<ExtendJobOutcome> {
      extendCalls.push({ jobId, extendMs, ...(reason !== undefined ? { reason } : {}) });
      if (holder.extendOutcome !== undefined) return holder.extendOutcome;
      throw new Error("test must setExtendOutcome first");
    },
  });
}

describe("bash_job — T16 extend (§2.6)", () => {
  it("extends a graced job and reports the new deadline and budget", async () => {
    const manager = fakeDeadlineManager();
    const before = makeRecord({
      jobId: "b_EXTE0001",
      backgroundedAt: NOW - 30_000,
      deadline: makeDeadline({ graceUntil: NOW + 58_000 }),
    });
    manager.put(before);
    const extended: JobRecord = {
      ...before,
      deadline: makeDeadline({
        graceUntil: undefined,
        dueAt: NOW + 660_000,
        extensions: 1,
        grantedMs: 600_000,
        seq: 1,
        ...({ lastReason: "test needs more time" } as Partial<JobDeadline>),
      }),
    };
    manager.setExtendOutcome({ ok: true, record: extended, persistPending: false });
    const tool = createBashJobTool({ manager: () => manager, now: () => NOW, deadline: () => POLICY });
    const response = await tool.execute(
      "tc",
      { action: "extend", job_id: "b_EXTE0001", extend_s: 600, reason: "test needs more time" },
      undefined,
      undefined,
      {} as never,
    );
    expect(manager.extendCalls).toEqual([{ jobId: "b_EXTE0001", extendMs: 600_000, reason: "test needs more time" }]);
    const out = response.content[0]!.text;
    expect(out).toContain("extended by 10m00s");
    expect(out).toContain("2 of 3 extensions left");
    expect(out).not.toContain("persist pending");
    expect(response.details).toMatchObject({
      extended: true,
      extendMs: 600_000,
      grantedMs: 600_000,
      extensionsLeft: 2,
    });
    expect((response.details as Record<string, unknown>).persistPending).toBeUndefined();
  });

  it("notes persist pending when the manager reports the write-behind record unconfirmed (R7)", async () => {
    // The 2s bound itself is the manager's (P3: tests/bash/manager.test.ts
    // "extend() waits at most 2s for the disk write and reports persistPending
    // on timeout"); at this layer the contract is simply that a persistPending
    // outcome is surfaced, never silently dropped and never blocking further.
    const manager = fakeDeadlineManager();
    const before = makeRecord({ jobId: "b_EXTE0002", backgroundedAt: NOW - 30_000, deadline: makeDeadline() });
    manager.put(before);
    manager.setExtendOutcome({
      ok: true,
      record: {
        ...before,
        deadline: makeDeadline({ dueAt: NOW + 660_000, extensions: 1, grantedMs: 600_000, seq: 1 }),
      },
      persistPending: true, // the store write is still queued past its 2s budget
    });
    const tool = createBashJobTool({ manager: () => manager, now: () => NOW, deadline: () => POLICY });
    const response = await tool.execute(
      "tc",
      { action: "extend", job_id: "b_EXTE0002", extend_s: 600 },
      undefined,
      undefined,
      {} as never,
    );
    expect(response.content[0]!.text).toContain("persist pending");
    expect(response.details).toMatchObject({ persistPending: true });
  });

  it.each([
    ["already_terminal", /has already finished — there is no timeout left to extend/],
    ["no_timeout", /started without an explicit timeout, so it has no deadline to extend/],
    ["foreground", /still in the foreground — its timeout cannot be extended/],
    ["limit_reached", /already used its full extension budget \(3 of 3 extensions\)/],
    ["no_headroom", /has reached its hard lifetime ceiling \(3x its original timeout\)/],
    ["zero_gain", /would add no time/],
  ])("rejects with a self-correctable message for %s", async (reason, expected) => {
    const manager = fakeDeadlineManager();
    const before = makeRecord({
      jobId: "b_EXTE0003",
      backgroundedAt: NOW - 30_000,
      deadline: makeDeadline({
        extensions: reason === "limit_reached" ? 3 : 0,
        dueAt: reason === "no_headroom" ? NOW : NOW + 60_000,
      }),
    });
    if (reason === "already_terminal") before.status = "completed";
    manager.put(before);
    manager.setExtendOutcome({
      ok: false,
      reason: reason as ExtendJobOutcome extends { ok: false; reason: infer R } ? R : never,
    });
    const tool = createBashJobTool({ manager: () => manager, now: () => NOW, deadline: () => POLICY });
    await expect(
      tool.execute("tc", { action: "extend", job_id: "b_EXTE0003", extend_s: 60 }, undefined, undefined, {} as never),
    ).rejects.toThrow(expected);
  });

  it("validates extend_s and reason before touching the manager", async () => {
    const manager = fakeDeadlineManager();
    manager.put(makeRecord({ jobId: "b_EXTE0004", backgroundedAt: NOW, deadline: makeDeadline() }));
    const tool = createBashJobTool({ manager: () => manager, now: () => NOW, deadline: () => POLICY });
    await expect(
      tool.execute("tc", { action: "extend", job_id: "b_EXTE0004" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/requires extend_s: a positive number of seconds/);
    for (const bad of [0, -5, Number.NaN, Infinity]) {
      await expect(
        tool.execute(
          "tc",
          { action: "extend", job_id: "b_EXTE0004", extend_s: bad },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/requires extend_s: a positive number of seconds/);
    }
    await expect(
      tool.execute(
        "tc",
        { action: "extend", job_id: "b_EXTE0004", extend_s: 10, reason: "r".repeat(201) },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/reason is too long \(201 chars; max 200\)/);
    expect(manager.extendCalls).toEqual([]);
  });
});

describe("bash_job — T16 schema trimming per switch (§5.2)", () => {
  const actionsOf = (schema: unknown): string[] =>
    (schema as { properties: { action: { anyOf: Array<{ const: string }> } } }).properties.action.anyOf
      .map((entry) => entry.const)
      .sort();
  const keysOf = (schema: unknown): string[] => Object.keys((schema as { properties: object }).properties).sort();

  it("feature off (no deadline dep): exactly the golden surface", () => {
    const tool = createBashJobTool({ manager: () => undefined });
    expect(actionsOf(tool.parameters)).toEqual(["kill", "list", "status", "wait"]);
    expect(keysOf(tool.parameters)).toEqual(["action", "job_id", "wait_ms"]);
  });

  it("maxExtensions=0 or factor=1 (D-6): still exactly the golden surface", () => {
    for (const surface of [
      { graceMs: 60_000, maxExtensions: 0, maxTimeoutFactor: 3 },
      { graceMs: 60_000, maxExtensions: 3, maxTimeoutFactor: 1 },
    ]) {
      const tool = createBashJobTool({ manager: () => undefined, deadline: () => surface });
      expect(actionsOf(tool.parameters)).toEqual(["kill", "list", "status", "wait"]);
      expect(keysOf(tool.parameters)).toEqual(["action", "job_id", "wait_ms"]);
    }
  });

  it("feature on: adds exactly extend / extend_s / reason (T18's default-config claim)", () => {
    const off = createBashJobTool({ manager: () => undefined });
    const on = createBashJobTool({ manager: () => undefined, deadline: () => POLICY });
    expect(actionsOf(on.parameters)).toEqual(["extend", "kill", "list", "status", "wait"]);
    expect(keysOf(on.parameters)).toEqual(["action", "extend_s", "job_id", "reason", "wait_ms"]);
    // Everything the two surfaces share is byte-identical (same description
    // strings), so the only additions are the extend bits themselves.
    const onProps = (on.parameters as typeof BashJobToolExtendParams).properties;
    const offProps = (off.parameters as unknown as typeof BashJobToolExtendParams).properties;
    expect(onProps.job_id).toEqual(offProps.job_id);
    expect(onProps.wait_ms).toEqual(offProps.wait_ms);
    expect(onProps.action.description).toBe(offProps.action.description);
  });

  it("default-config surface differs from the golden fixture only by extend/extend_s/reason", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const fixturePath = resolveRepoPath("tests/fixtures/bash-tools-golden.json");
    expect(existsSync(fixturePath)).toBe(true);
    const golden = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, { parameters: unknown }>;
    // Rebuild the default-config surface the same canonical way the golden
    // test does (deep key sort), then prove the diff is confined.
    const sortKeysDeep = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeysDeep);
      if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) sorted[key] = sortKeysDeep(source[key]);
        return sorted;
      }
      return value;
    };
    const extract = (schema: unknown): unknown =>
      sortKeysDeep(JSON.parse(JSON.stringify(schema, (_, v) => (typeof v === "symbol" ? undefined : v))));
    const onTool = createBashJobTool({ manager: () => undefined, deadline: () => POLICY });
    const goldenParams = extract(golden.bash_job!.parameters);
    const onParams = extract(onTool.parameters);
    // Strip the three additions from the ON side and byte-compare the rest.
    const stripped = JSON.parse(JSON.stringify(onParams)) as {
      properties: Record<string, unknown> & { action: { anyOf: unknown[]; description: string } };
    };
    delete stripped.properties.extend_s;
    delete stripped.properties.reason;
    const extendLiteral = JSON.stringify(sortKeysDeep({ const: "extend", type: "string" }));
    stripped.properties.action.anyOf = stripped.properties.action.anyOf.filter(
      (entry) => JSON.stringify(sortKeysDeep(entry)) !== extendLiteral,
    );
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(goldenParams));
    // The non-parameter surface fields are untouched too.
    const offTool = createBashJobTool({ manager: () => undefined });
    expect(onTool.description).toBe(offTool.description);
    expect(onTool.promptSnippet).toBe(offTool.promptSnippet);
    expect(onTool.label).toBe(offTool.label);
  });
});

function resolveRepoPath(relative: string): string {
  // tests run with cwd = package root.
  return `${process.cwd()}/${relative}`;
}

describe("bash_job — T16 grace line in status/wait (§2.6)", () => {
  const graced = makeRecord({
    jobId: "b_GRAC0001",
    backgroundedAt: NOW - 30_000,
    deadline: makeDeadline({ graceUntil: NOW + 58_000 }),
  });

  it("status shows the extend-or-expire line while in grace", async () => {
    const manager = fakeManager();
    manager.put(graced, "working\n");
    const out = (await run(manager, { action: "status", job_id: "b_GRAC0001" })).content[0]!.text;
    expect(out).toContain("⏳ timeout reached — killed in 58s unless extended:");
    expect(out).toContain('bash_job(action: "extend", job_id: "b_GRAC0001", extend_s: 600)');
  });

  it("wait leads with the grace line instead of the generic timeout guidance", async () => {
    const manager = fakeManager({ waitResolvesImmediately: true });
    manager.put(graced);
    const out = (await run(manager, { action: "wait", job_id: "b_GRAC0001", wait_ms: 1_000 })).content[0]!.text;
    expect(out).toContain("⏳ timeout reached — killed in 58s unless extended:");
    expect(out).toContain("Doing nothing lets the job be killed as timed_out");
    expect(out).not.toContain("Still running after waiting");
  });

  it("no grace line without a deadline, outside grace, or once terminal", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_GRAC0002", backgroundedAt: NOW }));
    manager.put(
      makeRecord({ jobId: "b_GRAC0003", backgroundedAt: NOW, deadline: makeDeadline({ dueAt: NOW + 60_000 }) }),
    );
    manager.put(
      makeRecord({
        jobId: "b_GRAC0004",
        status: "completed",
        exitCode: 0,
        endedAt: NOW,
        deadline: makeDeadline({ graceUntil: NOW + 58_000 }),
      }),
    );
    for (const jobId of ["b_GRAC0002", "b_GRAC0003", "b_GRAC0004"]) {
      const out = (await run(manager, { action: "status", job_id: jobId })).content[0]!.text;
      expect(out).not.toContain("timeout reached");
    }
  });
});

describe("bash_job — T16 child-session D budgets (§3.6)", () => {
  function childView(dueAt: number | undefined): () => HostRunView {
    return () => ({
      runId: "run-1",
      watchdogDueAt: () => dueAt,
      hardDeadlineAt: () => undefined,
      maxExtensions: () => 3,
      stopping: () => false,
      noteToolReturn: () => {},
    });
  }

  it("a single wait is truncated to D − now − MARGIN_RETURN", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const manager = fakeManager();
      manager.put(makeRecord({ jobId: "b_WAIT0001", pid: 5 }));
      let at = NOW; // call start
      const due = at + 43_000; // D − 3s leaves 40s
      const tool = createBashJobTool({
        manager: () => manager,
        host: childView(due),
        now: () => at,
      });
      const pending = tool.execute(
        "tc",
        { action: "wait", job_id: "b_WAIT0001", wait_ms: 60_000 },
        undefined,
        undefined,
        {} as never,
      );
      await waitForCall(manager, "waitExit:b_WAIT0001:40000");
      manager.settleWait("b_WAIT0001");
      const response = await pending;
      expect(manager.calls).toContain("waitExit:b_WAIT0001:40000");
      expect(response.content[0]!.text).toContain("Still running after waiting 40s");
      expect(response.details).toMatchObject({ waitedMs: 40_000, finished: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("consecutive waits: the second call's budget is what remains until D − 3s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const manager = fakeManager({ waitResolvesImmediately: true });
      manager.put(makeRecord({ jobId: "b_WAIT0002", pid: 5 }));
      const tool = createBashJobTool({
        manager: () => manager,
        host: childView(NOW + 23_000), // 20s of budget left at NOW
        now: () => NOW,
      });
      await tool.execute(
        "tc",
        { action: "wait", job_id: "b_WAIT0002", wait_ms: 120_000 },
        undefined,
        undefined,
        {} as never,
      );
      expect(manager.calls).toContain("waitExit:b_WAIT0002:20000");
      // Time has passed: only 5s remain until D − 3s.
      const later = createBashJobTool({
        manager: () => manager,
        host: childView(NOW + 8_000),
        now: () => NOW,
      });
      await later.execute(
        "tc",
        { action: "wait", job_id: "b_WAIT0002", wait_ms: 30_000 },
        undefined,
        undefined,
        {} as never,
      );
      expect(manager.calls).toContain("waitExit:b_WAIT0002:5000");
    } finally {
      vi.useRealTimers();
    }
  });

  it("parallel waits all return by D − 3s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const manager = fakeManager();
      manager.put(makeRecord({ jobId: "b_WAIT0003", pid: 5 }));
      manager.put(makeRecord({ jobId: "b_WAIT0004", pid: 6 }));
      const tool = createBashJobTool({
        manager: () => manager,
        host: childView(NOW + 43_000),
        now: () => NOW,
      });
      const first = tool.execute(
        "tc",
        { action: "wait", job_id: "b_WAIT0003", wait_ms: 60_000 },
        undefined,
        undefined,
        {} as never,
      );
      const second = tool.execute(
        "tc2",
        { action: "wait", job_id: "b_WAIT0004", wait_ms: 60_000 },
        undefined,
        undefined,
        {} as never,
      );
      await waitForCall(manager, "waitExit:b_WAIT0003:40000");
      manager.settleWait("b_WAIT0003");
      manager.settleWait("b_WAIT0004");
      const [a, b] = await Promise.all([first, second]);
      expect(a.details).toMatchObject({ waitedMs: 40_000 });
      expect(b.details).toMatchObject({ waitedMs: 40_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hanging disk read still returns on time, with memory state and a budget note", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const manager = fakeManager();
      const hanging: JobRecord = makeRecord({ jobId: "b_HANG0001", pid: 9, logBytes: 4 });
      manager.put(hanging, "data\n");
      manager.load = async () => new Promise(() => {}); // store hang
      manager.readOutput = async () => new Promise(() => {}); // log read hang
      let at = NOW;
      const tool = createBashJobTool({
        manager: () => manager,
        host: childView(NOW + 13_000), // 10s budget
        now: () => at,
      });
      const pending = tool.execute("tc", { action: "status", job_id: "b_HANG0001" }, undefined, undefined, {} as never);
      // Load race (10s) then tail race (whatever remains) both time out.
      await vi.advanceTimersByTimeAsync(10_000);
      at += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
      at += 10_000;
      const response = await pending;
      const out = response.content[0]!.text;
      expect(out).toContain("running"); // the memory record answered
      expect(out).toContain("log tail unavailable (time budget)");
      expect(response.details).toMatchObject({ degraded: true, tailBudgetExhausted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("wait with a hanging trailing read falls back to memory and still finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const manager = fakeManager();
      manager.put(makeRecord({ jobId: "b_HANG0002", pid: 10 }));
      // waitExit resolves `undefined` (memory entry unknown to it) so the
      // trailing load runs — and hangs, like a wedged store chain.
      manager.waitExit = (jobId: JobId, timeoutMs: number) => {
        manager.calls.push(`waitExit:${jobId}:${timeoutMs}`);
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
          (timer as unknown as { unref?: () => void }).unref?.();
        });
      };
      const originalLoad = manager.load.bind(manager);
      let loads = 0;
      manager.load = async (jobId: JobId) => {
        loads += 1;
        if (loads >= 2) await new Promise(() => {}); // only the trailing load hangs
        return originalLoad(jobId);
      };
      const tool = createBashJobTool({
        manager: () => manager,
        host: childView(NOW + 43_000), // 40s budget
        now: () => NOW,
      });
      const pending = tool.execute(
        "tc",
        { action: "wait", job_id: "b_HANG0002", wait_ms: 5_000 },
        undefined,
        undefined,
        {} as never,
      );
      await waitForCall(manager, "waitExit:b_HANG0002:5000");
      await vi.advanceTimersByTimeAsync(5_000); // the wait itself elapses
      await vi.advanceTimersByTimeAsync(40_000); // the trailing load's budget runs out
      const response = await pending;
      expect(response.content[0]!.text).toContain("running"); // memory fallback
      expect(response.details).toMatchObject({ finished: false, waitedMs: 5_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("D undefined (no truncation): today's wait semantics", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_WAIT0005", pid: 5 }));
    const tool = createBashJobTool({
      manager: () => manager,
      host: childView(undefined),
      now: () => NOW,
    });
    const pending = tool.execute(
      "tc",
      { action: "wait", job_id: "b_WAIT0005", wait_ms: 60_000 },
      undefined,
      undefined,
      {} as never,
    );
    await waitForCall(manager, "waitExit:b_WAIT0005:60000");
    manager.settleWait("b_WAIT0005");
    expect((await pending).details).toMatchObject({ waitedMs: 60_000 });
  });
});
