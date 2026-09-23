import { describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { createCredentialResolver, ENV_FALLBACK } from "../../src/quota/credentials.js";

// 安全红线回归护栏：整个测试文件模块图里的 node:child_process 都被换成
// spy —— credentials.ts 若（现在或将来）真去 exec 命令型 key，这里立刻爆红。
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

function makeResolver(credential: unknown, env: Record<string, string | undefined> = {}, warn?: (m: string) => void) {
  return createCredentialResolver({
    readCredential: () => credential,
    env,
    ...(warn === undefined ? {} : { warn }),
  });
}

describe("ENV_FALLBACK", () => {
  it("maps every provider id to its fallback variable (zai shares one)", () => {
    expect(ENV_FALLBACK).toEqual({
      "zai-coding-cn": "ZAI_API_KEY",
      zai: "ZAI_API_KEY",
      "kimi-coding": "KIMI_CODING_API_KEY",
    });
  });
});

describe("createCredentialResolver", () => {
  it("resolves a plain api_key credential", () => {
    expect(makeResolver({ type: "api_key", key: "sk-x" })("zai-coding-cn")).toBe("sk-x");
  });

  it("returns undefined for oauth credentials (not supported this phase)", () => {
    const warnings: string[] = [];
    const resolve = makeResolver({ type: "oauth", refresh: "r", access: "a", expires: 1 }, {}, (m) => warnings.push(m));
    expect(resolve("kimi-coding")).toBeUndefined();
    expect(warnings).toHaveLength(1); // miss → 一次 WARN
  });

  it("falls back to process.env[ENV_FALLBACK[id]] when the key is missing", () => {
    expect(makeResolver({ type: "api_key" }, { ZAI_API_KEY: "env-key" })("zai-coding-cn")).toBe("env-key");
    expect(makeResolver(undefined, { KIMI_CODING_API_KEY: "kimi-env" })("kimi-coding")).toBe("kimi-env");
  });

  it("resolves a $VAR template via a single-layer env lookup", () => {
    expect(makeResolver({ type: "api_key", key: "$MY_KEY" }, { MY_KEY: "resolved" })("zai")).toBe("resolved");
    expect(makeResolver({ type: "api_key", key: "${MY_KEY}" }, { MY_KEY: "resolved2" })("zai")).toBe("resolved2");
    // 查不到模板变量 → 视为 key 不可用 → 走 ENV_FALLBACK 回退
    expect(makeResolver({ type: "api_key", key: "$MISSING" }, { ZAI_API_KEY: "fallback" })("zai")).toBe("fallback");
  });

  it("gives up on command-shaped keys without ever executing anything (security red line)", () => {
    expect(
      makeResolver({ type: "api_key", key: "!op read api.key" }, { ZAI_API_KEY: "fallback" })("zai-coding-cn"),
    ).toBe("fallback");
    // 纯命令型（无 env 回退可用）→ undefined
    expect(makeResolver({ type: "api_key", key: "!cat ~/.secret" })("zai-coding-cn")).toBeUndefined();
    // 含空格的 shell 形态同样放弃
    expect(makeResolver({ type: "api_key", key: "echo sk-123" })("zai")).toBeUndefined();
    // 绝不 exec：四个入口零调用
    expect(childProcess.execSync).not.toHaveBeenCalled();
    expect(childProcess.exec).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("returns undefined without throwing when readCredential throws", () => {
    const resolve = createCredentialResolver({
      readCredential: () => {
        throw new Error("auth.json unreadable");
      },
      env: {},
    });
    expect(() => resolve("zai")).not.toThrow();
    expect(resolve("zai")).toBeUndefined();
  });

  it("warns exactly once per provider on repeated misses", () => {
    const warnings: string[] = [];
    const resolve = makeResolver(undefined, {}, (m) => warnings.push(m));
    expect(resolve("kimi-coding")).toBeUndefined();
    expect(resolve("kimi-coding")).toBeUndefined();
    expect(resolve("kimi-coding")).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("kimi-coding");
    // 不同 provider 各自一次
    expect(resolve("zai")).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });
});
