import { describe, expect, it } from "vitest";
import { classifyTurnEnd } from "../../../src/external-agent/droid/terminal.js";
import { MSG_USAGE_EXHAUSTED } from "../../../src/external-agent/messages.js";

describe("droid/terminal（plan §4.5 终态表逐行）", () => {
  it("completed 无 error ⇒ undefined（正常完成）", () => {
    expect(
      classifyTurnEnd({ reason: "completed", abortRequested: false, errors: [], permissionApprovals: 0 }),
    ).toBeUndefined();
  });

  it("cancelled 且我方发起过 interrupt/abort ⇒ undefined（runner 按 stopCause 结算）", () => {
    expect(
      classifyTurnEnd({ reason: "cancelled", abortRequested: true, errors: [], permissionApprovals: 0 }),
    ).toBeUndefined();
  });

  it("cancelled 非我方发起 ⇒ model 不可重试 + msgUnexpectedCancel；approvals>0 附提示", () => {
    const info = classifyTurnEnd({ reason: "cancelled", abortRequested: false, errors: [], permissionApprovals: 0 });
    expect(info).toMatchObject({ kind: "model", retryable: false });
    expect(info!.message).toBe("droid cancelled the turn unexpectedly");
    const withApprovals = classifyTurnEnd({
      reason: "cancelled",
      abortRequested: false,
      errors: [],
      permissionApprovals: 2,
    });
    expect(withApprovals!.message).toMatch(/permission approval may not have been understood/);
  });

  it("401/402/403 错误通知 + 任意完成 ⇒ auth 不可重试（含 status:402 形态）；文案含 FACTORY_API_KEY 与重启提示", () => {
    for (const msg of [
      '402 {"detail":"Organization does not have an active paid subscription","status":402}',
      "Error: 401 unauthorized",
      'HTTP 403 forbidden {"status":403}',
    ]) {
      const info = classifyTurnEnd({
        reason: "model_usage_exhausted",
        abortRequested: false,
        errors: [msg],
        permissionApprovals: 0,
      });
      expect(info).toMatchObject({ kind: "auth", retryable: false });
      expect(info!.message).toContain("FACTORY_API_KEY");
      expect(info!.message).toContain("restart pi");
    }
  });

  it("model_usage_exhausted（无可分类 error）⇒ auth 不可重试 MSG_USAGE_EXHAUSTED", () => {
    const info = classifyTurnEnd({
      reason: "model_usage_exhausted",
      abortRequested: false,
      errors: [],
      permissionApprovals: 0,
    });
    expect(info).toEqual({ kind: "auth", retryable: false, message: MSG_USAGE_EXHAUSTED });
  });

  it("其它 error + 完成 ⇒ model；429 ⇒ retryable，其余不可重试", () => {
    const e429 = classifyTurnEnd({
      reason: "completed",
      abortRequested: false,
      errors: ["429 too many requests"],
      permissionApprovals: 0,
    });
    expect(e429).toMatchObject({ kind: "model", retryable: true });
    const e500 = classifyTurnEnd({
      reason: "completed",
      abortRequested: false,
      errors: ["500 internal"],
      permissionApprovals: 0,
    });
    expect(e500).toMatchObject({ kind: "model", retryable: false, message: "500 internal" });
  });

  it("auth 优先于 model_usage_exhausted（S/10 同时命中两行）", () => {
    const info = classifyTurnEnd({
      reason: "model_usage_exhausted",
      abortRequested: false,
      errors: ['402 {"status":402}'],
      permissionApprovals: 0,
    });
    expect(info!.message).not.toBe(MSG_USAGE_EXHAUSTED);
    expect(info!.kind).toBe("auth");
  });

  it("我方 abort 优先于一切（含挂着的 error）", () => {
    expect(
      classifyTurnEnd({ reason: "cancelled", abortRequested: true, errors: ["500 boom"], permissionApprovals: 0 }),
    ).toBeUndefined();
  });
});
