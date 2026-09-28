/**
 * `wrapCommandApi` transparency tests (plan §4.9/§12.1 C0, `command-capture.ts`).
 *
 * C0's hard constraint: with no capture wired (the whole of C0 — `getCapture()`
 * always returns `undefined`), every ExtensionAPI method other than
 * `registerCommand` must forward byte-identically (same args, same `this`,
 * same return value), and `registerCommand` itself must produce a handler
 * that behaves exactly like the original one — this is what lets every
 * existing command test in the repo pass unmodified once `wrapCommandApi` is
 * spliced into `activate()`'s very first line (K25① primary path).
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { wrapCommandApi, type CommandCapturePort } from "../../../src/web-hub/agent/command-capture.js";

/** A minimal fake ExtensionAPI that records every call and its `this` receiver. */
function fakeApi(): ExtensionAPI & { calls: Array<{ prop: string; args: unknown[]; self: unknown }> } {
  const calls: Array<{ prop: string; args: unknown[]; self: unknown }> = [];
  const api = {
    calls,
    registerTool(this: unknown, ...args: unknown[]) {
      calls.push({ prop: "registerTool", args, self: this });
      return "registerTool-result";
    },
    on(this: unknown, ...args: unknown[]) {
      calls.push({ prop: "on", args, self: this });
      return () => undefined;
    },
    appendEntry(this: unknown, ...args: unknown[]) {
      calls.push({ prop: "appendEntry", args, self: this });
      return "appendEntry-result";
    },
    registerCommand(this: unknown, name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      calls.push({ prop: "registerCommand", args: [name, command], self: this });
      return `registered:${name}`;
    },
    events: { on: () => () => undefined, emit: () => undefined },
  };
  return api as unknown as ExtensionAPI & typeof api;
}

const ctx = { webInvocation: undefined } as unknown as ExtensionCommandContext;

describe("wrapCommandApi — no capture (C0 fast path)", () => {
  it("registerTool forwards args and `this` unchanged and returns the original value", () => {
    const raw = fakeApi();
    const pi = wrapCommandApi(raw, () => undefined);
    const result = (pi.registerTool as (...a: unknown[]) => unknown)("a", "b");
    expect(result).toBe("registerTool-result");
    expect(raw.calls).toEqual([{ prop: "registerTool", args: ["a", "b"], self: raw }]);
  });

  it("pi.on forwards args and `this` unchanged", () => {
    const raw = fakeApi();
    const pi = wrapCommandApi(raw, () => undefined);
    (pi.on as (...a: unknown[]) => unknown)("turn_end", "handler-ref");
    expect(raw.calls).toEqual([{ prop: "on", args: ["turn_end", "handler-ref"], self: raw }]);
  });

  it("appendEntry forwards args and `this` unchanged", () => {
    const raw = fakeApi();
    const pi = wrapCommandApi(raw, () => undefined);
    (pi.appendEntry as (...a: unknown[]) => unknown)({ type: "x" });
    expect(raw.calls).toEqual([{ prop: "appendEntry", args: [{ type: "x" }], self: raw }]);
  });

  it("non-function properties (events) pass through unwrapped", () => {
    const raw = fakeApi();
    const pi = wrapCommandApi(raw, () => undefined);
    expect(pi.events).toBe(raw.events);
  });

  it("registerCommand still registers the command (return value forwarded)", () => {
    const raw = fakeApi();
    const pi = wrapCommandApi(raw, () => undefined);
    const handler = vi.fn(() => "handler-result");
    const result = pi.registerCommand("mycmd", { handler } as unknown as Omit<
      RegisteredCommand,
      "name" | "sourceInfo"
    >);
    expect(result).toBe("registered:mycmd");
    expect(raw.calls).toHaveLength(1);
    expect(raw.calls[0]!.prop).toBe("registerCommand");
  });

  it("a registered command's handler still runs and returns the original value with no capture", async () => {
    const raw = fakeApi();
    const pi = wrapCommandApi(raw, () => undefined);
    const handler = vi.fn(async (args: string, c: ExtensionCommandContext) => `ran:${args}:${c === ctx}`);
    pi.registerCommand("mycmd", { handler } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const registeredCommand = raw.calls[0]!.args[1] as { handler: (a: string, c: ExtensionCommandContext) => unknown };
    const out = await registeredCommand.handler("hello", ctx);
    expect(out).toBe("ran:hello:true");
    expect(handler).toHaveBeenCalledWith("hello", ctx);
  });

  it("a non-function `handler` (or missing) command is passed through unwrapped", () => {
    const raw = fakeApi();
    const pi = wrapCommandApi(raw, () => undefined);
    const command = {} as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">;
    pi.registerCommand("nohandler", command);
    expect(raw.calls[0]!.args[1]).toBe(command); // identical object, not re-wrapped
  });

  it("nested/dynamic registerCommand calls (called from inside another callback) still forward `this`", () => {
    const raw = fakeApi();
    const pi = wrapCommandApi(raw, () => undefined);
    function registerLater(this: unknown): unknown {
      return pi.registerCommand("late", { handler: () => "late-result" } as unknown as Omit<
        RegisteredCommand,
        "name" | "sourceInfo"
      >);
    }
    const result = registerLater.call({ some: "receiver" });
    expect(result).toBe("registered:late");
    expect(raw.calls[0]!.self).toBe(raw); // registerCommand itself is always called bound to `target`
  });
});

describe("wrapCommandApi — capture wired later (dynamic lookup, not frozen at wrap time)", () => {
  it("getCapture() is re-evaluated on every command invocation, not cached when wrapCommandApi was called", async () => {
    let capture: CommandCapturePort | undefined;
    const raw = fakeApi();
    // Constructed while capture is still undefined (mirrors src/index.ts calling wrapCommandApi
    // at the very top of activate(), before webHubRef.current.capture is ever assigned).
    const pi = wrapCommandApi(raw, () => capture);
    const handler = vi.fn(async () => "normal-result");
    pi.registerCommand("mycmd", { handler } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const registeredCommand = raw.calls[0]!.args[1] as { handler: (a: string, c: ExtensionCommandContext) => unknown };

    // Still no capture: plain passthrough.
    await registeredCommand.handler("a1", ctx);
    expect(handler).toHaveBeenCalledTimes(1);

    // Capture becomes available later (as it would once C12 wires the real port in) — the SAME
    // already-registered handler must now consult it, proving the lookup isn't frozen.
    const finish = vi.fn();
    capture = {
      arm: () => undefined,
      take: (name) =>
        name === "mycmd"
          ? { cmdId: "c1", reqId: "r1", origin: {} as never, name, args: "a2", deadlineAt: 0 }
          : undefined,
      finish,
    };
    await registeredCommand.handler("a2", ctx);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledWith("c1");
  });

  it("capture.take() returning undefined (this invocation was not web-claimed) still runs the handler plainly", async () => {
    const capture: CommandCapturePort = { arm: () => undefined, take: () => undefined, finish: vi.fn() };
    const raw = fakeApi();
    const pi = wrapCommandApi(raw, () => capture);
    const handler = vi.fn(async () => "plain");
    pi.registerCommand("mycmd", { handler } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const registeredCommand = raw.calls[0]!.args[1] as { handler: (a: string, c: ExtensionCommandContext) => unknown };
    const out = await registeredCommand.handler("x", ctx);
    expect(out).toBe("plain");
    expect(capture.finish).not.toHaveBeenCalled();
  });
});
