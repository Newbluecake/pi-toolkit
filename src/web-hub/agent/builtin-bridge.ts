/**
 * §4.6 web slash-command execution pipeline (plan control-plan.md §4.6/§4.9, package C11).
 *
 * `commands.ts`'s `handleCommand()` (package C1, frozen) delegates the ENTIRE `command` op to
 * `BuiltinBridge.execute(frame)` — a single synchronous call, no other hook. So despite the file
 * name (matching §4.1's module list), `execute()` is the whole §4.6 pipeline: validate → classify
 * (`slash.ts`) → policy (`command-policy.ts`) → dispatch by kind (template/skill → plain prompt
 * dispatch; extension → capture-wrapped dispatch, §4.9; builtin → direct `pi`/`ExtensionContext`
 * calls, §4.6's "内置桥" column).
 *
 * Every field of `BuiltinBridgeDeps` is optional so `createBuiltinBridge()` keeps working at the
 * current call site (`src/web-hub/agent/index.ts`'s `const builtinBridge = createBuiltinBridge();`
 * — zero args, outside this package's exclusive file list, so this file only ALIGNS with that
 * call convention rather than requiring it to change immediately, per the task's own framing).
 * With no deps at all `execute()` degrades to the same `E_UNSUPPORTED` the C0 stub always
 * returned — a real command bridge additionally needs `pi`/`getCtx` (and, for capturing
 * pi-toolkit output and for the compact/model "async" completion, `capture`/`sendLate`) wired
 * from `index.ts`; see this package's final report for the exact one-line proposal, since
 * `index.ts` is not in this package's exclusive file list.
 */
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CmdArgs,
  CmdData,
  CmdErrorCode,
  CmdFrame,
  CmdResultBody,
  CommandOutputWire,
} from "../protocol/messages.js";
import { buildSlashText, classifyCommand, type CommandsPort } from "./slash.js";
import { effectivePolicy, resolveCommandPolicy, type CommandPolicy } from "./command-policy.js";
import type { CommandCapturePort } from "./command-capture.js";

export interface BuiltinBridge {
  execute(frame: CmdFrame): CmdResultBody;
}

export interface BuiltinBridgeDeps {
  pi?: ExtensionAPI & CommandsPort;
  getCtx?(): ExtensionContext | undefined;
  getSessionId?(): string;
  now?(): number;
  /** §4.9: the shared `CommandCapturePort` (`index.ts`'s `WebHubControl.capture`). Without it,
   *  extension-kind dispatch always reports `captured:false`. */
  capture?(): CommandCapturePort | undefined;
  /** `webHub.webCommandPolicy` (§4.6 U8). */
  overrides?(): Record<string, CommandPolicy> | undefined;
  /**
   * Best-effort async-completion channel for the two builtins pi itself makes asynchronous
   * (`/compact`, `/model`). Without it, both still fire — they just report `completion:"unknown"`
   * instead of `"async"` (no later `cmd_late` will ever follow, matching the plan's "effect
   * unknown" semantics rather than fabricating a promise this file cannot keep — `commands.ts`'s
   * `command` op has no late channel of its own to piggyback on, see the module doc comment).
   */
  sendLate?(frame: CmdFrame, result: CmdResultBody): void;
}

const ARGS_MAX_BYTES = 16 * 1024;
const OUTPUT_TEXT_MAX_BYTES = 8 * 1024;
const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function clipBytes(s: string, maxBytes: number): { text: string; clipped: boolean } {
  if (byteLen(s) <= maxBytes) return { text: s, clipped: false };
  const buf = Buffer.from(s, "utf8").subarray(0, Math.max(0, maxBytes - 1));
  // Trim any partial trailing UTF-8 sequence so the cut never splits a multi-byte codepoint.
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end -= 1;
  return { text: `${buf.subarray(0, end).toString("utf8")}…`, clipped: true };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function errResult(
  code: CmdErrorCode,
  retryable: boolean,
  effect: "none" | "unknown",
  message?: string,
): CmdResultBody {
  return message !== undefined
    ? { ok: false, code, retryable, effect, message }
    : { ok: false, code, retryable, effect };
}
function okResult(data: CmdData): CmdResultBody {
  return { ok: true, data };
}

function commandArgs(frame: CmdFrame): (CmdArgs & { op: "command" }) | undefined {
  return frame.cmd.op === "command" ? frame.cmd : undefined;
}

function confirmMessage(name: string, args: string, kind: "extension" | "template" | "builtin"): string {
  const text = buildSlashText(name, args);
  const what = kind === "builtin" ? "this changes the session" : "the effect is not previewed here";
  return `${text} requires confirmation — ${what}. Resend with confirm:true to proceed.`;
}

function textOutput(text: string): CommandOutputWire {
  const { text: clipped, clipped: wasClipped } = clipBytes(text, OUTPUT_TEXT_MAX_BYTES);
  return wasClipped
    ? { entries: [{ kind: "text", text: clipped, clipped: true }] }
    : { entries: [{ kind: "text", text: clipped }] };
}

function buildSessionText(ctx: ExtensionContext): string {
  const lines: string[] = [];
  const id = safe(() => ctx.sessionManager.getSessionId(), "");
  if (id !== "") lines.push(`session: ${id}`);
  const file = safe(() => ctx.sessionManager.getSessionFile(), undefined);
  if (file !== undefined) lines.push(`file: ${file}`);
  const name = safe(() => ctx.sessionManager.getSessionName(), undefined);
  if (name !== undefined) lines.push(`name: ${name}`);
  const model = safe(() => ctx.model, undefined);
  if (model !== undefined) lines.push(`model: ${String(model.provider)}/${model.id}`);
  const level = safe(() => ctx.thinkingLevel, undefined);
  if (level !== undefined) lines.push(`thinking: ${String(level)}`);
  const usage = safe(() => ctx.getContextUsage(), undefined);
  if (usage !== undefined && usage.tokens !== null)
    lines.push(`context: ${usage.tokens}/${usage.contextWindow} tokens`);
  return lines.length > 0 ? lines.join("\n") : "(no session info)";
}

/** §4.6 template/skill row: dispatched exactly like a `/skill:x`-shaped prompt (`deliverAs`
 *  defaults to `steer`, matching §4.3's prompt semantics — not `followUp` like the extension
 *  row, since template/skill expansion turns into ordinary conversational text). No capture: the
 *  `command` op reports only `completion`, never the full observed/started/queued/consumed
 *  lifecycle (that machinery is `commands.ts`'s `prompt` op, out of `BuiltinBridge`'s reach). */
function dispatchTemplate(deps: BuiltinBridgeDeps, cmd: CmdArgs & { op: "command" }): CmdResultBody {
  if (deps.pi === undefined) return errResult("E_UNSUPPORTED", false, "none");
  try {
    deps.pi.sendUserMessage(buildSlashText(cmd.name, cmd.args), {
      expandPromptTemplates: true,
      deliverAs: cmd.deliver ?? "steer",
    });
  } catch {
    return errResult("E_STALE_CTX", true, "none");
  }
  return okResult({ op: "command", kind: "template", completion: "unknown" });
}

/** §4.6 extension row + §4.9's `capture.arm`/`settleArm` call site. */
function dispatchExtension(deps: BuiltinBridgeDeps, frame: CmdFrame, cmd: CmdArgs & { op: "command" }): CmdResultBody {
  if (deps.pi === undefined) return errResult("E_UNSUPPORTED", false, "none");
  const capture = deps.capture?.();
  if (capture !== undefined) {
    capture.arm({
      cmdId: frame.id,
      reqId: frame.origin.reqId,
      origin: frame.origin,
      name: cmd.name,
      args: cmd.args,
      deadlineAt: (deps.now?.() ?? Date.now()) + Math.max(0, frame.deadlineMs),
    });
  }
  try {
    deps.pi.sendUserMessage(buildSlashText(cmd.name, cmd.args), {
      expandPromptTemplates: true,
      deliverAs: cmd.deliver ?? "followUp",
    });
  } catch {
    capture?.settleArm?.();
    return errResult("E_STALE_CTX", true, "none");
  }
  // §2.1 K20: the handler's synchronous prefix runs inside this very call stack on the idle /
  // streaming paths, so a simple pi-toolkit handler (no `await` before its last `ctx.ui.*` call)
  // has already been captured by the time `sendUserMessage` returns; a settle-deferred handler
  // (`_isEmittingAgentSettled`) has not — `capture.owns()` still reports `true` for it (it is a
  // pi-toolkit command either way), but `output()` will be empty until the deferred handler runs
  // — hence `completion` stays `"unknown"` rather than a fabricated `"sync"`.
  capture?.settleArm?.();
  const owns = capture?.owns?.(cmd.name) === true;
  const output = owns ? (capture?.output?.() as CommandOutputWire | undefined) : undefined;
  const hasOutput = output !== undefined && output.entries.length > 0;
  const data: CmdData = {
    op: "command",
    kind: "extension",
    completion: hasOutput ? "sync" : "unknown",
    captured: owns,
  };
  if (hasOutput) (data as { output?: CommandOutputWire }).output = output;
  return okResult(data);
}

function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

/** §4.6 builtin row: direct `pi`/`ExtensionContext` calls for the 7 builtins in
 *  `BUILTIN_BRIDGE_NAMES`. `/new` and `/reload` re-enter the extension-command surface
 *  (`/webhub __exec new <nonce>` and `/agent reload` respectively) because `ctx.newSession()` /
 *  `ctx.reload()` only exist on `ExtensionCommandContext`, which this bridge — running from an
 *  event-context call, not a registered command handler — never has (§4.6 K22). */
function dispatchBuiltin(
  deps: BuiltinBridgeDeps,
  ctx: ExtensionContext,
  frame: CmdFrame,
  cmd: CmdArgs & { op: "command" },
): CmdResultBody {
  switch (cmd.name) {
    case "session":
      return okResult({
        op: "command",
        kind: "builtin",
        completion: "sync",
        output: textOutput(buildSessionText(ctx)),
      });
    case "name": {
      const value = cmd.args.trim();
      if (value === "") return errResult("E_BAD_REQUEST", true, "none", "missing name");
      if (deps.pi === undefined) return errResult("E_UNSUPPORTED", false, "none");
      try {
        deps.pi.setSessionName(value);
      } catch {
        return errResult("E_STALE_CTX", true, "none");
      }
      return okResult({ op: "command", kind: "builtin", completion: "sync" });
    }
    case "thinking": {
      const value = cmd.args.trim().toLowerCase();
      if (!THINKING_LEVELS.has(value)) return errResult("E_BAD_REQUEST", true, "none", "unknown thinking level");
      if (deps.pi === undefined) return errResult("E_UNSUPPORTED", false, "none");
      try {
        deps.pi.setThinkingLevel(value as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
      } catch {
        return errResult("E_STALE_CTX", true, "none");
      }
      return okResult({ op: "command", kind: "builtin", completion: "sync" });
    }
    case "model": {
      const value = cmd.args.trim();
      const slash = value.indexOf("/");
      if (slash <= 0 || slash === value.length - 1)
        return errResult("E_BAD_REQUEST", true, "none", "expected provider/model");
      const provider = value.slice(0, slash);
      const modelId = value.slice(slash + 1);
      if (deps.pi === undefined) return errResult("E_UNSUPPORTED", false, "none");
      const model = safe(() => ctx.modelRegistry.find(provider, modelId), undefined);
      if (model === undefined) return errResult("E_BAD_REQUEST", false, "none", "unknown model");
      let pending: Promise<boolean>;
      try {
        pending = deps.pi.setModel(model);
      } catch {
        return errResult("E_STALE_CTX", true, "none");
      }
      if (deps.sendLate !== undefined) {
        pending.then(
          (accepted) =>
            deps.sendLate?.(
              frame,
              accepted
                ? okResult({ op: "command", kind: "builtin", completion: "sync" })
                : errResult("E_SUBAGENT_REJECTED", false, "none", "authentication not configured for that model"),
            ),
          () => deps.sendLate?.(frame, errResult("E_SUBAGENT_REJECTED", false, "none")),
        );
        return okResult({ op: "command", kind: "builtin", completion: "async" });
      }
      pending.catch(() => undefined);
      return okResult({ op: "command", kind: "builtin", completion: "unknown" });
    }
    case "compact": {
      const instructions = cmd.args.trim();
      try {
        ctx.compact({
          ...(instructions !== "" ? { customInstructions: instructions } : {}),
          ...(deps.sendLate !== undefined
            ? {
                onComplete: () =>
                  deps.sendLate?.(frame, okResult({ op: "command", kind: "builtin", completion: "sync" })),
                onError: (e: Error) =>
                  deps.sendLate?.(frame, errResult("E_SUBAGENT_REJECTED", false, "none", e.message)),
              }
            : {}),
        });
      } catch {
        return errResult("E_STALE_CTX", true, "none");
      }
      return okResult({
        op: "command",
        kind: "builtin",
        completion: deps.sendLate !== undefined ? "async" : "unknown",
      });
    }
    case "new": {
      if (deps.pi === undefined) return errResult("E_UNSUPPORTED", false, "none");
      try {
        deps.pi.sendUserMessage(`/webhub __exec new ${randomNonce()}`, {
          expandPromptTemplates: true,
          deliverAs: "followUp",
        });
      } catch {
        return errResult("E_STALE_CTX", true, "none");
      }
      return okResult({ op: "command", kind: "builtin", completion: "unknown" });
    }
    case "reload": {
      if (deps.pi === undefined) return errResult("E_UNSUPPORTED", false, "none");
      try {
        deps.pi.sendUserMessage("/agent reload", { expandPromptTemplates: true, deliverAs: "followUp" });
      } catch {
        return errResult("E_STALE_CTX", true, "none");
      }
      return okResult({ op: "command", kind: "builtin", completion: "unknown" });
    }
    default:
      return errResult("E_COMMAND_DENIED", false, "none");
  }
}

export function createBuiltinBridge(deps: BuiltinBridgeDeps = {}): BuiltinBridge {
  return {
    execute(frame: CmdFrame): CmdResultBody {
      const cmd = commandArgs(frame);
      if (cmd === undefined) return errResult("E_UNSUPPORTED", false, "none");
      if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(cmd.name))
        return errResult("E_BAD_REQUEST", false, "none", "bad command name");
      if (byteLen(cmd.args) > ARGS_MAX_BYTES) return errResult("E_BAD_REQUEST", true, "none", "args too long");
      const ctx = deps.getCtx?.();
      if (ctx === undefined) return errResult("E_STALE_CTX", true, "none");
      if (cmd.expect?.sessionId !== undefined) {
        const sessionId = deps.getSessionId?.();
        if (sessionId !== undefined && sessionId !== cmd.expect.sessionId) {
          return errResult("E_SESSION_CHANGED", false, "none");
        }
      }
      const classified = classifyCommand(deps.pi, cmd.name);
      if (classified === undefined) return errResult("E_UNKNOWN_COMMAND", false, "none");
      const busy = !safe(() => ctx.isIdle(), true);
      const overrides = deps.overrides?.();
      const decision = resolveCommandPolicy({
        name: cmd.name,
        args: cmd.args,
        kind: classified.kind,
        ...(overrides !== undefined ? { overrides } : {}),
      });
      const policy = effectivePolicy(decision, busy);
      if (policy === "deny") return errResult("E_COMMAND_DENIED", false, "none");
      if (policy === "confirm" && cmd.confirm !== true) {
        const kind = classified.kind === "skill" ? "template" : classified.kind;
        return errResult("E_CONFIRM_REQUIRED", false, "none", confirmMessage(cmd.name, cmd.args, kind));
      }
      switch (classified.kind) {
        case "template":
        case "skill":
          return dispatchTemplate(deps, cmd);
        case "extension":
          return dispatchExtension(deps, frame, cmd);
        case "builtin":
          return dispatchBuiltin(deps, ctx, frame, cmd);
      }
    },
  };
}
