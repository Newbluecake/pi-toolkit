import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { CmdOrigin } from "../protocol/messages.js";

export interface CaptureInvocation {
  cmdId: string;
  reqId: string;
  origin: CmdOrigin;
  name: string;
  args: string;
  deadlineAt: number;
}
export interface CommandCapturePort {
  arm(invocation: CaptureInvocation): void;
  take(name: string, args: string): CaptureInvocation | undefined;
  settleArm?(): void;
  finish?(cmdId: string): void;
  owns?(name: string): boolean;
  collect?(entry: {
    kind: "notify" | "widget" | "status" | "text" | "error" | "interactive";
    text: string;
    level?: "info" | "warning" | "error";
    key?: string;
    title?: string;
    clipped?: true;
  }): void;
  output?(): unknown;
}

/**
 * C0 fast path: `registerCommand` is the only property ever intercepted (K25
 * primary path "tool / \u4e8b\u4ef6 / appendEntry / \u5d4c\u5957\u547d\u4ee4\u5747\u900f\u4f20"). The
 * capture lookup is dynamic (`getCapture()` is called again on every
 * `registerCommand` call and again on every actual command invocation), never
 * cached at wrap time \u2014 caching it here would freeze the pre-wiring "no
 * capture yet" snapshot for the whole process lifetime, since `wrapCommandApi`
 * runs once at the very top of `activate()`, before `commandCaptureRef` is
 * ever assigned. With no capture wired (the whole of C0), every branch below
 * degrades to a plain `Reflect.apply`/`Reflect.get` passthrough with `this`
 * bound to `target` \u2014 byte-identical behavior to the unwrapped `pi`.
 */
export function wrapCommandApi<T extends ExtensionAPI>(pi: T, getCapture: () => CommandCapturePort | undefined): T {
  return new Proxy(pi, {
    get(target, property) {
      if (property !== "registerCommand") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      const register = Reflect.get(target, property, target) as (
        name: string,
        command: Omit<RegisteredCommand, "name" | "sourceInfo">,
      ) => unknown;
      return function registerCapturedCommand(
        this: unknown,
        name: string,
        command: Omit<RegisteredCommand, "name" | "sourceInfo">,
      ): unknown {
        const handler = command.handler;
        if (typeof handler !== "function") return Reflect.apply(register, target, [name, command]);
        const wrapped = {
          ...command,
          handler: function (this: unknown, args: string, ctx: ExtensionCommandContext) {
            const capture = getCapture();
            if (capture === undefined) return Reflect.apply(handler, this, [args, ctx]);
            const invocation = capture.take(name, args);
            if (invocation === undefined) return Reflect.apply(handler, this, [args, ctx]);
            try {
              return Reflect.apply(handler, this, [args, ctx]);
            } finally {
              capture.finish?.(invocation.cmdId);
            }
          },
        } as Omit<RegisteredCommand, "name" | "sourceInfo">;
        return Reflect.apply(register, target, [name, wrapped]);
      };
    },
  }) as T;
}

export function createCommandCapture(): CommandCapturePort {
  return {
    arm() {
      /* C12 fills capture */
    },
    take() {
      return undefined;
    },
    settleArm() {},
    finish() {},
    owns() {
      return false;
    },
  };
}

export function isWebInvocation(ctx: ExtensionCommandContext): boolean {
  return Boolean((ctx as unknown as { webInvocation?: unknown }).webInvocation);
}
