import { describe, expect, it, vi } from "vitest";
import { createFeishuDiagnostics, feishuPatchMessage } from "../../../../src/web-hub/hub/feishu/diagnostics.js";

describe("body-free Feishu diagnostics", () => {
  it("logs a given event/reason once per minute and globally at most 20/min, with a bounded key cache", () => {
    let now = 100;
    const log = vi.fn();
    const emit = createFeishuDiagnostics(log, () => now);
    for (let i = 0; i < 100; i++) emit({ event: "refresh", reason: "operator-missing" });
    expect(log).toHaveBeenCalledTimes(1);
    now += 60_000;
    emit({ event: "refresh", reason: "operator-missing" });
    expect(log).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 100; i++) emit({ event: "patch", reason: `code-${i}` });
    expect(log).toHaveBeenCalledTimes(21);
    // Exercise more than 64 distinct keys across windows; no unbounded per-card/id keys are used.
    for (let i = 0; i < 100; i++) {
      now += 60_000;
      emit({ event: "patch", reason: `new-${i}` });
    }
    expect(log).toHaveBeenCalledTimes(121);
  });
  it("preserves platform validation codes/static messages, but never ErrorValue or reflected card content", () => {
    expect(
      feishuPatchMessage(
        "ErrCode: 11310; ErrPath: ROOT; ErrMsg: max_length exceed the default maximum 1000; ErrorValue: private question secret",
      ),
    ).toBe("ErrCode: 11310; max_length exceed the default maximum 1000");
    expect(
      feishuPatchMessage(
        "ErrCode: 300123; ErrMsg: there is no submit button in the form container, at least one; ErrorValue: secret",
      ),
    ).toBe("ErrCode: 300123; there is no submit button in the form container, at least one");
    expect(feishuPatchMessage("unknown: private label, token, URL, JSON")).toBe(
      "platform message omitted (may contain card content)",
    );
  });
});
