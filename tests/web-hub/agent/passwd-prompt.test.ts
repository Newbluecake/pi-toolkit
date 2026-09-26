import { describe, expect, it, vi } from "vitest";
import {
  formatPasswdOutcomeMessage,
  MaskedInputComponent,
  runPasswdPrompt,
  type PasswdPromptDeps,
} from "../../../src/web-hub/agent/passwd-prompt.js";
import type { LanResFrame } from "../../../src/web-hub/protocol/messages.js";

// ---------------------------------------------------------------- MaskedInputComponent

function tui(): { requestRender: () => void; calls: number } {
  const state = { calls: 0 };
  return {
    requestRender: () => (state.calls += 1),
    get calls() {
      return state.calls;
    },
  };
}

describe("MaskedInputComponent (plan §11 LE row: 掩码组件从不渲染明文)", () => {
  it("render() never contains the typed characters, only bullets — for any input", () => {
    const t = tui();
    let result: string | undefined | "unset" = "unset";
    const c = new MaskedInputComponent("新密码", t, (v) => (result = v));
    for (const ch of "s3cr3t-Pässw0rd!") c.handleInput(ch);
    const lines = c.render(80);
    expect(lines.join("\n")).not.toContain("s3cr3t");
    expect(lines.join("\n")).not.toContain("Pässw0rd");
    expect(lines[0]).toContain("•".repeat(16));
    expect(result).toBe("unset");
  });

  it("enter submits the accumulated (unmasked, in-memory only) value", () => {
    const t = tui();
    let result: string | undefined = undefined;
    const c = new MaskedInputComponent("t", t, (v) => (result = v));
    for (const ch of "hunter2") c.handleInput(ch);
    c.handleInput("\r");
    expect(result).toBe("hunter2");
  });

  it("escape cancels with undefined", () => {
    const t = tui();
    let result: string | undefined | "unset" = "unset";
    const c = new MaskedInputComponent("t", t, (v) => (result = v));
    c.handleInput("a");
    c.handleInput("\x1b");
    expect(result).toBeUndefined();
  });

  it("ctrl+c cancels with undefined", () => {
    const t = tui();
    let result: string | undefined | "unset" = "unset";
    const c = new MaskedInputComponent("t", t, (v) => (result = v));
    c.handleInput("a");
    c.handleInput("\x03");
    expect(result).toBeUndefined();
  });

  it("backspace removes the last character (never exposed, but reflected in mask length)", () => {
    const t = tui();
    const c = new MaskedInputComponent("t", t, () => undefined);
    c.handleInput("a");
    c.handleInput("b");
    c.handleInput("\x7f");
    expect(c.render(80)[0]).toContain("•".repeat(1));
    expect(c.render(80)[0]).not.toContain("••");
  });

  it("backspace on empty value is a no-op (doesn't call requestRender or throw)", () => {
    const t = tui();
    const c = new MaskedInputComponent("t", t, () => undefined);
    expect(() => c.handleInput("\x7f")).not.toThrow();
    expect(t.calls).toBe(0);
  });

  it("control/escape sequences (e.g. arrow keys) are swallowed, never inserted as text", () => {
    const t = tui();
    const c = new MaskedInputComponent("t", t, () => undefined);
    c.handleInput("a");
    c.handleInput("\x1b[C"); // right-arrow CSI sequence, not a recognized special key handled here
    expect(c.render(80)[0]).toContain("•".repeat(1));
  });

  it("done is called at most once even if handleInput fires again after finishing", () => {
    const t = tui();
    const calls: (string | undefined)[] = [];
    const c = new MaskedInputComponent("t", t, (v) => calls.push(v));
    c.handleInput("a");
    c.handleInput("\r");
    c.handleInput("\r");
    expect(calls).toEqual(["a"]);
  });

  it("invalidate() never throws (no cached render state to drop)", () => {
    const c = new MaskedInputComponent("t", tui(), () => undefined);
    expect(() => c.invalidate()).not.toThrow();
  });
});

// ---------------------------------------------------------------- runPasswdPrompt

function deps(over: Partial<PasswdPromptDeps> = {}): PasswdPromptDeps {
  return {
    hasCap: () => true,
    promptUsername: async () => "alice",
    promptPassword: async () => "hunter2-hunter2",
    request: async (): Promise<LanResFrame> => ({ t: "lan_res", rid: "x", ok: true }),
    ...over,
  };
}

describe("runPasswdPrompt (plan §9.3 passwd flow)", () => {
  it("no lan.v1 cap ⇒ rejects before prompting anything", async () => {
    const promptUsername = vi.fn(async () => "alice");
    const outcome = await runPasswdPrompt(deps({ hasCap: () => false, promptUsername }));
    expect(outcome).toEqual({ ok: false, reason: "no-cap" });
    expect(promptUsername).not.toHaveBeenCalled();
  });

  it("username cancelled (undefined) ⇒ cancelled, never prompts password", async () => {
    const promptPassword = vi.fn(async () => "x");
    const outcome = await runPasswdPrompt(deps({ promptUsername: async () => undefined, promptPassword }));
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(promptPassword).not.toHaveBeenCalled();
  });

  it("empty/whitespace username ⇒ cancelled", async () => {
    const outcome = await runPasswdPrompt(deps({ promptUsername: async () => "   " }));
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
  });

  it("first password cancelled ⇒ cancelled, second prompt never shown", async () => {
    let calls = 0;
    const promptPassword = async (): Promise<string | undefined> => {
      calls += 1;
      return undefined;
    };
    const outcome = await runPasswdPrompt(deps({ promptPassword }));
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(calls).toBe(1);
  });

  it("second password cancelled ⇒ cancelled", async () => {
    let calls = 0;
    const promptPassword = async (): Promise<string | undefined> => {
      calls += 1;
      return calls === 1 ? "hunter2-hunter2" : undefined;
    };
    const outcome = await runPasswdPrompt(deps({ promptPassword }));
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(calls).toBe(2);
  });

  it("passwords don't match ⇒ mismatch, request() never called", async () => {
    let calls = 0;
    const request = vi.fn();
    const promptPassword = async (): Promise<string | undefined> => {
      calls += 1;
      return calls === 1 ? "hunter2-hunter2" : "different-pass";
    };
    const outcome = await runPasswdPrompt(deps({ promptPassword, request }));
    expect(outcome).toEqual({ ok: false, reason: "mismatch" });
    expect(request).not.toHaveBeenCalled();
  });

  it("too short (< 10) ⇒ invalid-length, request() never called", async () => {
    const request = vi.fn();
    const outcome = await runPasswdPrompt(deps({ promptPassword: async () => "short", request }));
    expect(outcome).toEqual({ ok: false, reason: "invalid-length" });
    expect(request).not.toHaveBeenCalled();
  });

  it("too long (> 256) ⇒ invalid-length", async () => {
    const outcome = await runPasswdPrompt(deps({ promptPassword: async () => "a".repeat(300) }));
    expect(outcome).toEqual({ ok: false, reason: "invalid-length" });
  });

  it("hub rejects (ok:false) ⇒ rejected with code/message surfaced", async () => {
    const request = async (): Promise<LanResFrame> => ({
      t: "lan_res",
      rid: "x",
      ok: false,
      code: "E_AUTH",
      message: "nope",
    });
    const outcome = await runPasswdPrompt(deps({ request }));
    expect(outcome).toEqual({ ok: false, reason: "rejected", code: "E_AUTH", message: "nope" });
  });

  it("success path: sends passwd with trimmed username and the entered password, no cap check bypass", async () => {
    const request = vi.fn(async (frame: { op: string; username: string; password: string }): Promise<LanResFrame> => {
      expect(frame.op).toBe("passwd");
      expect(frame.username).toBe("alice");
      expect(frame.password).toBe("hunter2-hunter2");
      return { t: "lan_res", rid: "x", ok: true };
    });
    const outcome = await runPasswdPrompt(deps({ promptUsername: async () => "  alice  ", request }));
    expect(outcome).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("formatPasswdOutcomeMessage", () => {
  it("success message per plan §9.3", () => {
    expect(formatPasswdOutcomeMessage({ ok: true })).toMatch(/已更新/);
  });
  it.each([
    ["no-cap", /lan\.v1/],
    ["cancelled", /取消/],
    ["mismatch", /不一致/],
    ["invalid-length", /10\.\.256/],
  ] as const)("%s reason message", (reason, re) => {
    expect(formatPasswdOutcomeMessage({ ok: false, reason })).toMatch(re);
  });
  it("rejected reason includes the hub's message", () => {
    expect(formatPasswdOutcomeMessage({ ok: false, reason: "rejected", code: "E_AUTH", message: "boom" })).toContain(
      "boom",
    );
  });
});
