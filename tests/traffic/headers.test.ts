import { describe, expect, it } from "vitest";
import { normalizeHeaders } from "../../src/traffic/capture.js";
import { filterReplayHeaders } from "../../src/traffic/server.js";

describe("normalizeHeaders（fetch 入参 → 普通对象）", () => {
  it("归一化 Headers 实例", () => {
    const h = new Headers({ "content-type": "application/json", "x-api-key": "sk-test" });
    expect(normalizeHeaders(h)).toEqual({ "content-type": "application/json", "x-api-key": "sk-test" });
  });

  it("归一化普通对象", () => {
    expect(normalizeHeaders({ authorization: "Bearer t", "anthropic-version": "2023-06-01" })).toEqual({
      authorization: "Bearer t",
      "anthropic-version": "2023-06-01",
    });
  });

  it("归一化二元组数组", () => {
    expect(
      normalizeHeaders([
        ["x-api-key", "k1"],
        ["accept", "application/json"],
      ]),
    ).toEqual({ "x-api-key": "k1", accept: "application/json" });
  });

  it("空值 / 非字符串值安全处理", () => {
    expect(normalizeHeaders(undefined)).toEqual({});
    expect(normalizeHeaders(null)).toEqual({});
    expect(normalizeHeaders({ "x-null": null, "x-num": 42, "x-ok": "v" } as unknown as Record<string, string>)).toEqual(
      {
        "x-ok": "v",
      },
    );
  });
});

describe("filterReplayHeaders（重放前剔除 hop-by-hop 头）", () => {
  it("剔除 content-length / host / connection / transfer-encoding（大小写不敏感）", () => {
    const out = filterReplayHeaders({
      "Content-Length": "123",
      HOST: "api.anthropic.com",
      Connection: "keep-alive",
      "transfer-encoding": "chunked",
      "x-api-key": "sk-live",
      "content-type": "application/json",
    });
    expect(out).toEqual({ "x-api-key": "sk-live", "content-type": "application/json" });
  });

  it("保留鉴权头（重放需要凭证）", () => {
    const out = filterReplayHeaders({ authorization: "Bearer abc", "x-api-key": "k" });
    expect(out).toEqual({ authorization: "Bearer abc", "x-api-key": "k" });
  });

  it("丢弃非字符串值", () => {
    expect(filterReplayHeaders({ "x-a": "1", "x-b": null, "x-c": 3 })).toEqual({ "x-a": "1" });
  });
});
