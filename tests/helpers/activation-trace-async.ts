/**
 * Awaitable activation recorder — startup-bundle plan r3 §7.1 seam A.
 *
 * `traceActivation` (activation-trace.ts) calls `activate(pi)` synchronously and without awaiting,
 * which was fine while every entry was a sync function. The root `index.ts` dispatcher is `async`,
 * so the sync recorder stops before the dispatcher's first `await` and records nothing from it.
 * This helper awaits the activate promise; the recording semantics (describe / Proxy / SAFE_RETURN /
 * env delta) are copied verbatim from `activation-trace.ts` so fingerprints stay comparable with the
 * ones the sync recorder produced — the existing file is intentionally NOT modified (it is fixed in
 * place by the secure-off golden and the activation-trace golden).
 *
 * Additive extras (they never touch `calls`): `onRegisterTool` exposes the full tool object so the
 * parity suite can check the bundle's typebox schemas, and `onRegisterCommand` exposes command
 * registrations (name → command object) for the §7.3 smoke probes that drive `/webhub` and
 * `/record` against the loaded entry's own copies.
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

export interface TraceOptions {
  /** Properties read as `undefined` on the traced pi (builds a compat failure, e.g. `["appendEntry"]`). */
  omit?: readonly string[];
  /** Receives every handler registered through `pi.on` (for phase-2 event replay). */
  onHandler?: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
  /** Receives every tool object passed to `pi.registerTool` (parameters schema checks; parity suite only). */
  onRegisterTool?: (tool: unknown) => void;
  /** Receives every (name, command) passed to `pi.registerCommand` (§7.3 smoke probes only). */
  onRegisterCommand?: (name: string, command: unknown) => void;
}

export async function traceActivationAsync(
  activate: (pi: ExtensionAPI) => void | Promise<void>,
  options: TraceOptions = {},
): Promise<ActivationTrace> {
  const calls: string[] = [];
  const envBefore = { ...process.env };
  const describe = (name: string, args: unknown[]): string => {
    const first = args[0];
    if (typeof first === "string") return `${name}(${first})`;
    if (first !== null && typeof first === "object" && typeof (first as { name?: unknown }).name === "string")
      return `${name}(${(first as { name: string }).name})`;
    if (
      first !== null &&
      typeof first === "object" &&
      typeof (first as { customType?: unknown }).customType === "string"
    )
      return `${name}(${(first as { customType: string }).customType})`;
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
        if (options.omit?.includes(prop)) return undefined;
        return (...args: unknown[]) => {
          calls.push(describe(prop, args));
          if (prop === "on" && typeof args[0] === "string" && typeof args[1] === "function")
            options.onHandler?.(args[0], args[1] as (event: unknown, ctx: unknown) => unknown);
          if (prop === "registerTool" && args[0] !== null && typeof args[0] === "object")
            options.onRegisterTool?.(args[0]);
          if (prop === "registerCommand" && typeof args[0] === "string") options.onRegisterCommand?.(args[0], args[1]);
          if (prop in SAFE_RETURN) return SAFE_RETURN[prop];
          if (prop === "exec") return Promise.resolve({ code: 1, stdout: "", stderr: "", killed: false });
          return () => undefined;
        };
      },
    },
  ) as unknown as ExtensionAPI;
  await activate(pi);
  const envDelta: Record<string, string | null> = {};
  for (const k of new Set([...Object.keys(envBefore), ...Object.keys(process.env)])) {
    if (envBefore[k] !== process.env[k]) envDelta[k] = process.env[k] ?? null;
  }
  return { calls, envDelta };
}
