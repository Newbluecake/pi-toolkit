import { describe, expect, it } from "vitest";
import { ClassifiedError, classifiedInfo } from "../../src/core/errors.js";
import type { ErrorInfo } from "../../src/core/types.js";

describe("ClassifiedError (external-agent plan §2.3)", () => {
  it("carries the ErrorInfo; name === ClassifiedError; message comes from info", () => {
    const info: ErrorInfo = { kind: "config", message: "boom", retryable: false };
    const e = new ClassifiedError(info);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ClassifiedError");
    expect(e.message).toBe("boom");
    expect(e.info).toBe(info);
  });

  it("classifiedInfo unwraps via instanceof", () => {
    const info: ErrorInfo = { kind: "auth", message: "402", retryable: false };
    expect(classifiedInfo(new ClassifiedError(info))).toEqual(info);
    const withStack: ErrorInfo = { kind: "startup_transient", message: "EAGAIN", stack: "s", retryable: true };
    expect(classifiedInfo(new ClassifiedError(withStack))).toEqual(withStack);
  });

  it("classifiedInfo accepts a structurally identical object from another realm", () => {
    const foreign = {
      name: "ClassifiedError",
      info: { kind: "model", message: "x", retryable: false },
    };
    expect(classifiedInfo(foreign)).toEqual({ kind: "model", message: "x", retryable: false });
  });

  it("classifiedInfo rejects non-ClassifiedError and malformed shapes", () => {
    expect(classifiedInfo(undefined)).toBeUndefined();
    expect(classifiedInfo(null)).toBeUndefined();
    expect(classifiedInfo("nope")).toBeUndefined();
    expect(classifiedInfo(new Error("plain"))).toBeUndefined();
    expect(classifiedInfo({ name: "Other", info: { kind: "model", message: "x", retryable: false } })).toBeUndefined();
    // right name, wrong info shapes
    expect(classifiedInfo({ name: "ClassifiedError" })).toBeUndefined();
    expect(classifiedInfo({ name: "ClassifiedError", info: null })).toBeUndefined();
    expect(classifiedInfo({ name: "ClassifiedError", info: "x" })).toBeUndefined();
    expect(classifiedInfo({ name: "ClassifiedError", info: { message: "x", retryable: false } })).toBeUndefined();
    expect(classifiedInfo({ name: "ClassifiedError", info: { kind: "model", retryable: false } })).toBeUndefined();
    expect(
      classifiedInfo({ name: "ClassifiedError", info: { kind: "model", message: "x", retryable: "yes" } }),
    ).toBeUndefined();
    // unknown ErrorKind string is rejected (kind must be a real union member)
    expect(
      classifiedInfo({ name: "ClassifiedError", info: { kind: "nonsense", message: "x", retryable: false } }),
    ).toBeUndefined();
    // non-string stack is rejected
    expect(
      classifiedInfo({ name: "ClassifiedError", info: { kind: "model", message: "x", stack: 5, retryable: false } }),
    ).toBeUndefined();
  });
});
