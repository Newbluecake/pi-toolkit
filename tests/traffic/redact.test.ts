import { describe, expect, it } from "vitest";
import { collectSecrets, redactHeaderMap, redactText } from "../../src/traffic/redact.js";

describe("redactText", () => {
  it("按敏感键名整体替换值", () => {
    expect(redactText('authorization: "sk-secret"')).toContain("«REDACTED»");
    expect(redactText("x-api-key: ordinary-secret")).not.toContain("ordinary-secret");
  });

  it("已知密钥回显按精确子串脱敏", () => {
    const text = "jq: error (at <stdin>:1): sk-secret";
    const result = redactText(text, { secrets: ["sk-secret"] });
    expect(result).toContain("«REDACTED»");
    expect(result).not.toContain("sk-secret");
  });

  it("无 secrets 提示时模式层也遮盖短 sk 密钥", () => {
    expect(redactText("jq: error (at <stdin>:1): sk-secret")).not.toContain("sk-secret");
  });

  it("识别常见密钥值模式", () => {
    const text = [
      "sk-secret",
      "Bearer abcdefgh",
      "eyJabcdefghijklmnopqrstuv",
      "ghp_1234567890123456",
      "xoxb-1234567890",
      "AKIA1234567890ABCDEF",
      "AIza12345678901234567890",
      "a".repeat(40),
    ].join(" ");
    const redacted = redactText(text);
    expect(redacted).not.toContain("sk-secret");
    expect(redacted).not.toContain("Bearer abcdefgh");
    expect(redacted).not.toContain("ghp_");
    expect(redacted).toContain("«REDACTED»");
  });

  it("从 headers 和递归 JSON body 收集真实密钥", () => {
    const secrets = collectSecrets(
      { Authorization: "Bearer bearer-token-value", "x-api-key": "header-secret" },
      JSON.stringify({ nested: { config: { api_key: "p@ss w0rd" } } }),
    );
    expect(secrets).toEqual(
      expect.arrayContaining(["Bearer bearer-token-value", "bearer-token-value", "header-secret", "p@ss w0rd"]),
    );
    expect(redactText("jq: error: p@ss w0rd", { secrets })).not.toContain("p@ss w0rd");
  });

  it("按 UTF-8 字节数截断到 2KB", () => {
    const result = redactText("中文".repeat(2000));
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(2048);
  });
});

describe("redactHeaderMap", () => {
  it("不修改输入，并遮盖黑名单 header 与模式密钥", () => {
    const headers = { Authorization: "sk-secret", "x-safe": "Bearer abcdefgh" };
    const result = redactHeaderMap(headers);
    expect(result).toEqual({ Authorization: "«REDACTED»", "x-safe": "«REDACTED»" });
    expect(headers.Authorization).toBe("sk-secret");
  });
});
