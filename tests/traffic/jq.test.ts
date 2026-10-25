import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJqRunner, JqError } from "../../src/traffic/jq.js";

// T2a：jq 执行器归 engine（无模块级状态）；本文件共享一个执行器，等价于源实现的模块单例。
const jq = createJqRunner();
const runJq = jq.run;
const probeJq = jq.probe;
const shutdownJq = jq.shutdown;
const resetJqEngine = jq.reset;
const resetJqForTest = jq.resetForTest;
const getSpawnCount = jq.spawnCount;
const getActiveChildCount = jq.activeChildCount;
const cleanupJqTempDir = jq.cleanupTempDir;

const jqAvailable = existsSync("/usr/bin/jq");
const jqDescribe = jqAvailable ? describe : describe.skip;

/**
 * Installed jq version, probed once. The test expectations that depend on it:
 *  - exit code of unparsable INPUT: 4 up to jq 1.6, 5 from jq 1.7 ("jq: parse error: …" on stderr);
 *  - `--version` prints "jq-1.6" / "jq-1.7" / "jq-1.7.1" — probeJq must report exactly that.
 */
const jqVersionText = jqAvailable
  ? (spawnSync("/usr/bin/jq", ["--version"], { encoding: "utf8" }).stdout ?? "").trim()
  : "";
const jqVersionMatch = jqVersionText.match(/jq-(\d+)\.(\d+)(?:\.(\d+))?/i);
const jqMajor = Number(jqVersionMatch?.[1] ?? 0);
const jqMinor = Number(jqVersionMatch?.[2] ?? 0);
const jqExpectedVersion = jqVersionMatch
  ? `${jqMajor}.${jqMinor}${jqVersionMatch[3] === undefined ? "" : `.${jqVersionMatch[3]}`}`
  : "";
const jqInputParseExit = jqMajor > 1 || (jqMajor === 1 && jqMinor >= 7) ? 5 : 4;

if (!jqAvailable) console.warn("跳过 jq 测试：/usr/bin/jq 不存在");

function makeStubJq(script: string): { jqPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-record-jq-stub-"));
  const jqPath = join(dir, "jq");
  writeFileSync(jqPath, `#!/bin/sh\n${script}\n`);
  chmodSync(jqPath, 0o755);
  return { jqPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function waitForActiveChild(): Promise<void> {
  for (let i = 0; i < 100 && getActiveChildCount() === 0; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function jqTempDirs(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-record-jq-"))
    .map((entry) => join(tmpdir(), entry.name));
}

jqDescribe("runJq（真 jq）", () => {
  it("使用 -f 执行恒等和字段改写", async () => {
    expect(await runJq(".", '{"a":1}')).toBe('{"a":1}');
    expect(await runJq(".a = 2", '{"a":1}')).toBe('{"a":2}');
  });

  it("支持以 - 开头的 filter 和 Unicode", async () => {
    expect(await runJq("-1", "null")).toBe("-1");
    expect(await runJq(".", JSON.stringify({ text: "中文 😀" }))).toBe(JSON.stringify({ text: "中文 😀" }));
  });

  it("跨 chunk 边界不破坏多字节字符（大体积中文 payload）", async () => {
    // 管道按 ~4KB/64KB 切片；逐 chunk toString() 会把被切断的 UTF-8 序列解成 U+FFFD，
    // 改写后的 body 随之逐请求随机变化（真实事故：Anthropic prompt cache 每轮全量重建）。
    const unit = "中文内容测试 😀 mixed ascii 汉字边界";
    const text = unit.repeat(Math.ceil((512 * 1024) / unit.length));
    const input = JSON.stringify({ text, thinking: { type: "enabled", budget_tokens: 8192 } });
    expect(Buffer.byteLength(input)).toBeGreaterThan(512 * 1024);
    const out = await runJq(".", input);
    expect(out).not.toMatch(/\uFFFD/);
    expect(JSON.parse(out).text).toBe(text);
  });

  it.each([
    [".a |", "compile_error", 3],
    ['error("x")', "runtime_error", 5],
    ["empty", "output_empty", 0],
    [".,.", "output_multi", 0],
  ] as const)("错误分类 %s", async (filter, kind, code) => {
    try {
      await runJq(filter, "{}");
      throw new Error("expected runJq to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(JqError);
      expect((err as JqError).kind).toBe(kind);
      expect((err as JqError).exitCode).toBe(code);
    }
  });

  it("把非 JSON 输入归类为 input_parse", async () => {
    await expect(runJq(".", "not json")).rejects.toMatchObject({
      kind: "input_parse",
      exitCode: jqInputParseExit,
    });
  });

  it("把不存在的 jq 路径归类为 not_found", async () => {
    await expect(runJq(".", "{}", { jqPath: "/nonexistent/jq" })).rejects.toMatchObject({ kind: "not_found" });
  });

  it("超时后 SIGKILL 子进程", async () => {
    await expect(runJq("[range(1e8)] | length", "null", { timeoutMs: 100 })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("限制 stdout 总大小", async () => {
    await expect(runJq("range(10000)", "null", { maxOutputBytes: 100 })).rejects.toMatchObject({
      kind: "output_too_large",
    });
  });

  it("只向 jq 暴露 PATH 和 LANG", async () => {
    const key = "PI_RECORD_JQ_TEST_SECRET";
    const previous = process.env[key];
    process.env[key] = "secret-from-parent";
    try {
      expect(await runJq("env.PI_RECORD_JQ_TEST_SECRET", "null")).toBe("null");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("probeJq 解析已安装 jq 的版本并缓存同一路径结果", async () => {
    expect(jqExpectedVersion).not.toBe(""); // `jq --version` must be parsable at all
    const before = getSpawnCount();
    await expect(probeJq("/usr/bin/jq")).resolves.toMatchObject({ ok: true, version: jqExpectedVersion });
    const afterFirst = getSpawnCount();
    await expect(probeJq("/usr/bin/jq")).resolves.toMatchObject({ ok: true, version: jqExpectedVersion });
    expect(afterFirst).toBeGreaterThan(before);
    expect(getSpawnCount()).toBe(afterFirst);
  });
});

describe("runJq（stub jq）", () => {
  // jq ≥ 1.7 reports unparsable input as exit 5 + "jq: parse error: …" (1.6: exit 4). Pinned
  // against stubs so the classification is verified whatever jq the host has installed.
  it.each([
    ["exit 4（jq ≤ 1.6）", "echo 'parse error: Invalid literal at line 1, column 4' >&2; exit 4", "input_parse", 4],
    [
      "exit 5 + parse error（jq ≥ 1.7）",
      "echo 'jq: parse error: Invalid numeric literal at line 1, column 4' >&2; exit 5",
      "input_parse",
      5,
    ],
    ["exit 5 + 过滤器运行期错误", "echo 'jq: error (at <stdin>:0): x (while parsing)' >&2; exit 5", "runtime_error", 5],
  ] as const)("输入解析错误分类：%s", async (_name, script, kind, code) => {
    const stub = makeStubJq(script);
    try {
      await expect(runJq(".", "not json", { jqPath: stub.jqPath })).rejects.toMatchObject({ kind, exitCode: code });
    } finally {
      stub.cleanup();
    }
  });

  it("把成功但非 JSON 的 stub 输出归类为 output_invalid", async () => {
    const stub = makeStubJq("echo 'not json'");
    try {
      await expect(runJq(".", "{}", { jqPath: stub.jqPath })).rejects.toMatchObject({ kind: "output_invalid" });
    } finally {
      stub.cleanup();
    }
  });

  it("把 stub jq-1.5 归类为 version_too_low", async () => {
    const stub = makeStubJq("echo 'jq-1.5'");
    try {
      await expect(probeJq(stub.jqPath)).resolves.toMatchObject({
        ok: false,
        version: "1.5",
        error: "version_too_low",
      });
    } finally {
      stub.cleanup();
    }
  });

  it("把 stub exit 3 归类为 compile_error", async () => {
    const stub = makeStubJq("exit 3");
    try {
      await expect(runJq(".", "{}", { jqPath: stub.jqPath })).rejects.toMatchObject({
        kind: "compile_error",
        exitCode: 3,
      });
    } finally {
      stub.cleanup();
    }
  });
});

jqDescribe("runJq（子进程生命周期）", () => {
  it("shutdown 后由 resetJqEngine 恢复同一 filter", async () => {
    resetJqForTest();
    const filter = ".value = 2";
    await expect(runJq(filter, '{"value":1}')).resolves.toBe('{"value":2}');
    await shutdownJq();
    await expect(runJq(filter, '{"value":1}')).rejects.toMatchObject({
      kind: "spawn_error",
      message: "jq spawn_error: engine shutting down",
    });
    resetJqEngine();
    await expect(runJq(filter, '{"value":1}')).resolves.toBe('{"value":2}');
    resetJqForTest();
  });

  it("shutdownJq 回收在途子进程并在其关闭后删除目录，reset 后可重建缓存", async () => {
    resetJqForTest();
    const beforeDirs = new Set(jqTempDirs());
    const slowFilter = "if . == null then ([range(1e8)] | length) else 1 end";
    const running = runJq(slowFilter, "null", { timeoutMs: 60_000 });
    await waitForActiveChild();
    expect(getActiveChildCount()).toBe(1);
    const createdDirs = jqTempDirs().filter((dir) => !beforeDirs.has(dir));
    expect(createdDirs).toHaveLength(1);
    const tempDir = createdDirs[0];
    if (tempDir === undefined) throw new Error("jq temp directory was not created");

    const shutdown = shutdownJq();
    expect(existsSync(tempDir)).toBe(true);
    await expect(running).rejects.toBeInstanceOf(JqError);
    await shutdown;
    expect(existsSync(tempDir)).toBe(false);
    expect(getActiveChildCount()).toBe(0);
    await expect(runJq(".", "{}", { timeoutMs: 100 })).rejects.toMatchObject({
      kind: "spawn_error",
      message: "jq spawn_error: engine shutting down",
    });

    resetJqForTest();
    expect(await runJq(slowFilter, "{}", { timeoutMs: 60_000 })).toBe("1");
    expect(getActiveChildCount()).toBe(0);
    cleanupJqTempDir();
    expect(await runJq(slowFilter, "{}", { timeoutMs: 60_000 })).toBe("1");
    expect(getActiveChildCount()).toBe(0);
    resetJqForTest();
  });
});

describe("T2a：exit 监听惰性登记（plan §3.1 / §7.1）", () => {
  it("创建执行器不登记 exit 监听；首次 spawn 才登记一次；dispose 移除且之后拒绝执行", async () => {
    const before = process.listenerCount("exit");
    const runner = createJqRunner();
    expect(runner.exitHookInstalled()).toBe(false);
    expect(process.listenerCount("exit")).toBe(before);
    await runner.probe("/nonexistent/jq-for-lazy-test");
    await runner.probe("/nonexistent/jq-for-lazy-test-2");
    expect(runner.exitHookInstalled()).toBe(true);
    expect(process.listenerCount("exit")).toBe(before + 1);
    runner.dispose();
    expect(runner.exitHookInstalled()).toBe(false);
    expect(process.listenerCount("exit")).toBe(before);
    runner.reset();
    await expect(runner.run(".", "{}")).rejects.toMatchObject({ kind: "spawn_error" });
    expect(process.listenerCount("exit")).toBe(before);
  });
});
