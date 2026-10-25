/**
 * Records EVERYTHING a real `activate()` does to the ExtensionAPI (method name + string args, in
 * order) plus the process.env delta — used by the secure-off golden. Test-only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ActivationTrace {
  calls: string[];
  envDelta: Record<string, string | null>;
}

const SAFE_RETURN: Record<string, unknown> = {
  getCommands: [],
  getAllTools: [],
  getActiveTools: [],
  getThinkingLevel: "off",
};

export function traceActivation(activate: (pi: ExtensionAPI) => void): ActivationTrace {
  const calls: string[] = [];
  const envBefore = { ...process.env };
  const describe = (name: string, args: unknown[]): string => {
    const first = args[0];
    if (typeof first === "string") return `${name}(${first})`;
    if (first !== null && typeof first === "object" && typeof (first as { name?: unknown }).name === "string")
      return `${name}(${(first as { name: string }).name})`;
    return `${name}()`;
  };
  const events = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => {
          calls.push(describe(`events.${prop}`, args));
          return () => undefined;
        };
      },
    },
  );
  const pi = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== "string") return undefined;
        if (prop === "events") return events;
        if (prop === "then") return undefined;
        return (...args: unknown[]) => {
          calls.push(describe(prop, args));
          if (prop in SAFE_RETURN) return SAFE_RETURN[prop];
          if (prop === "exec") return Promise.resolve({ code: 1, stdout: "", stderr: "", killed: false });
          return () => undefined;
        };
      },
    },
  ) as unknown as ExtensionAPI;
  activate(pi);
  const envDelta: Record<string, string | null> = {};
  for (const k of new Set([...Object.keys(envBefore), ...Object.keys(process.env)])) {
    if (envBefore[k] !== process.env[k]) envDelta[k] = process.env[k] ?? null;
  }
  return { calls, envDelta };
}
