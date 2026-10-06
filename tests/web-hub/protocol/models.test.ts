import { describe, expect, it } from "vitest";
import {
  isValidModelId,
  isValidProvider,
  modelCommandArg,
  sanitizeModelName,
  truncateUtf8,
  utf8Bytes,
} from "../../../src/web-hub/protocol/models.js";

describe("web model protocol validators", () => {
  it("validates provider and model id boundaries", () => {
    expect(isValidProvider("openai")).toBe(true);
    expect(isValidProvider("open/ai")).toBe(false);
    expect(isValidProvider("bad name")).toBe(false);
    expect(isValidProvider("é".repeat(64))).toBe(true);
    expect(isValidProvider("é".repeat(65))).toBe(false);
    expect(isValidModelId("gpt-5/pro")).toBe(true);
    expect(isValidModelId("gpt 5")).toBe(false);
    expect(isValidModelId("\u0000model")).toBe(false);
  });

  it("truncates at UTF-8 boundaries and sanitizes display names", () => {
    const value = "模型🚀".repeat(20);
    const clipped = truncateUtf8(value, 17);
    expect(utf8Bytes(clipped)).toBeLessThanOrEqual(17);
    expect(() => new TextEncoder().encode(clipped)).not.toThrow();
    expect(sanitizeModelName("  模型\n\t名称  ", "id")).toBe("模型 名称");
    expect(sanitizeModelName("id", "id")).toBeUndefined();
    expect(sanitizeModelName("\u0000\u0001", "id")).toBeUndefined();
  });

  it("only builds command arguments from validated refs", () => {
    expect(modelCommandArg("openai", "gpt-5/pro")).toBe("openai/gpt-5/pro");
    expect(modelCommandArg("bad/provider", "gpt-5")).toBeUndefined();
    expect(modelCommandArg("openai", "bad model")).toBeUndefined();
  });
});
