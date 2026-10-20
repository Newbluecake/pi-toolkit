import { describe, expect, it, vi } from "vitest";
import { droidAuthFailureDetail, observeDroidAuthFailure } from "../../../src/external-agent/droid/auth.js";
import { makeFakeDeps } from "./fakes.js";
import { msgAuthFailure, msgDroidAuthUnavailable } from "../../../src/external-agent/messages.js";

describe("droid authentication evidence", () => {
  it("402 points to payment/plan repair; 403 points to permissions, not merely logging in", () => {
    const payment = msgDroidAuthUnavailable("Factory HTTP 402");
    expect(payment).toContain("账单");
    expect(payment).toContain("订阅计划");
    expect(payment).not.toContain("登录后");
    const forbidden = msgDroidAuthUnavailable("Factory HTTP 403");
    expect(forbidden).toContain("访问权限");
    expect(forbidden).toContain("凭据");
    expect(forbidden).not.toContain("登录后");
    expect(msgAuthFailure("HTTP 402")).toContain("payment/subscription plan (HTTP 402)");
    expect(msgAuthFailure("HTTP 403")).toContain("access permissions (HTTP 403)");
  });
  it.each([
    ["No access token SECRET", "No access token"],
    ["JSON-RPC error -32603: No access token ***", "No access token"],
    ['Factory response {"status":401,"token":"SECRET"}', "Factory HTTP 401"],
    ["HTTP 402 Payment Required", "Factory HTTP 402"],
    ["status 401", "Factory HTTP 401"],
    ["401 Unauthorized", "Factory HTTP 401"],
    ["code: 403", "Factory HTTP 403"],
    ["error 402", "Factory HTTP 402"],
    ["HTTP/1.1 401", "Factory HTTP 401"],
    ["Factory HTTP 403 Forbidden", "Factory HTTP 403"],
    ["Invalid API key SECRET", "authentication failed"],
    ["Access token expired", "authentication failed"],
    ["Not authenticated", "authentication failed"],
  ])("classifies %s without retaining raw output", (text, detail) => {
    expect(droidAuthFailureDetail(text)).toContain(detail);
    expect(droidAuthFailureDetail(text)).not.toContain("SECRET");
    const f = makeFakeDeps();
    const observed = vi.fn();
    f.deps.observeAvailability = observed;
    expect(observeDroidAuthFailure(f.deps, text)).toMatchObject({ kind: "auth", retryable: false });
    expect(observed).toHaveBeenCalledWith({ source: "run", authError: droidAuthFailureDetail(text) });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("SECRET");
    expect(observeDroidAuthFailure(f.deps, text)?.message).not.toContain("SECRET");
  });

  it("catalog failures retain their own evidence source", () => {
    const f = makeFakeDeps();
    const observed = vi.fn();
    f.deps.observeAvailability = observed;
    observeDroidAuthFailure(f.deps, "No access token", "catalog");
    expect(observed.mock.calls).toEqual([[{ source: "catalog", authError: "No access token" }]]);
  });

  it.each([
    "port 401 busy",
    "17.401",
    "connect to localhost:403 failed",
    "2026-10-20T17:06:17.401Z socket reset",
    "HTTP 401.123",
    "status 4030",
    "model_usage_exhausted",
    "quota exhausted",
    "HTTP 429",
    "HTTP 500",
    "socket reset",
    "tool permission denied",
  ])("%s is not provider-wide authentication unavailability", (text) => {
    const f = makeFakeDeps();
    const observed = vi.fn();
    f.deps.observeAvailability = observed;
    expect(observeDroidAuthFailure(f.deps, text)).toBeUndefined();
    expect(observed).not.toHaveBeenCalled();
  });
});
