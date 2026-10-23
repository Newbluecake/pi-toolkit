import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupJqTempDir,
  getActiveChildCount,
  getSpawnCount,
  probeJq,
  resetJqEngine,
  resetJqForTest,
  runJq,
  shutdownJq,
  JqError,
} from "../../src/traffic/jq.js";

const jqAvailable = existsSync("/usr/bin/jq");
const jqDescribe = jqAvailable ? describe : describe.skip;

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
    await expect(runJq(".", "not json")).rejects.toMatchObject({ kind: "input_parse", exitCode: 4 });
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

  it("probeJq 解析 1.6 并缓存同一路径结果", async () => {
    const before = getSpawnCount();
    await expect(probeJq("/usr/bin/jq")).resolves.toMatchObject({ ok: true, version: "1.6" });
    const afterFirst = getSpawnCount();
    await expect(probeJq("/usr/bin/jq")).resolves.toMatchObject({ ok: true, version: "1.6" });
    expect(afterFirst).toBeGreaterThan(before);
    expect(getSpawnCount()).toBe(afterFirst);
  });
});

describe("runJq（stub jq）", () => {
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
