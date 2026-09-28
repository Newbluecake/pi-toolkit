import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { CmdOrigin, CommandOutputEntry, CommandOutputWire } from "../protocol/messages.js";

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

// ---------------------------------------------------------------------------
// §4.9 point 8: size & truncation budgets (agent side, before a frame is ever
// built). Single entry text ≤ 8 KiB (UTF-8 byte boundary, `clipped:true`,
// trailing "…"); window total ≤ 32 KiB text / ≤ 64 entries (keep the front,
// silently drop the rest, tally `truncated{droppedEntries,droppedBytes}`);
// `title` ≤ 200 chars, `key` ≤ 64 chars.
// ---------------------------------------------------------------------------
const MAX_ENTRY_BYTES = 8 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;
const MAX_ENTRIES = 64;
const MAX_TITLE_CHARS = 200;
const MAX_KEY_CHARS = 64;
const ELLIPSIS = "\u2026";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

/** §4.9 point 7: hard per-invocation cap from claim to handler settle. */
const CAPTURE_MAX_MS = 30_000;
/** §4.9 point 3: fallback-queue TTL, capped by the frame's own remaining budget. */
const FALLBACK_TTL_MS = 5_000;
/** Not part of the plan's numeric budgets — a defensive bound so a long session's finished
 * windows never grow unbounded; FIFO-evicted, oldest first. */
const MAX_RETAINED_WINDOWS = 64;

/** Strip ANSI CSI/OSC sequences, then any other C0 control byte except `\n`/`\t` (§4.9 point 8). */
function sanitizeText(raw: string): string {
  const noOsc = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const noCsi = noOsc.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const noOtherEsc = noCsi.replace(/\x1b[@-Z\\-_]/g, "");
  return noOtherEsc.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

/** Truncate `s` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte code point. */
function utf8SafeTruncate(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  for (let end = maxBytes; end >= 0 && end > maxBytes - 4; end--) {
    const candidate = buf.toString("utf8", 0, end);
    if (Buffer.byteLength(candidate, "utf8") === end) return candidate;
  }
  return buf.toString("utf8", 0, Math.max(0, maxBytes - 4));
}

function clampText(text: string, maxBytes: number): { text: string; clipped?: true } {
  const sanitized = sanitizeText(text);
  if (Buffer.byteLength(sanitized, "utf8") <= maxBytes) return { text: sanitized };
  const truncated = utf8SafeTruncate(sanitized, Math.max(0, maxBytes - ELLIPSIS_BYTES));
  return { text: truncated + ELLIPSIS, clipped: true };
}

interface Window {
  entries: CommandOutputEntry[];
  totalBytes: number;
  needsTerminal: boolean;
  droppedEntries: number;
  droppedBytes: number;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface QueuedInvocation {
  invocation: CaptureInvocation;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The full runtime surface `wrapCommandApi` uses internally, structurally wider than the frozen
 * {@link CommandCapturePort} (whose `collect`/`output` are deliberately zero-cmdId "current
 * invocation" convenience methods — fine for a caller with no better context, but wrong under two
 * genuinely concurrent claimed invocations). `collectFor`/`outputFor` are the precise, cmdId-keyed
 * primitives `wrapCommandApi`'s per-invocation ctx/ui proxy actually calls; nothing outside this
 * module needs them, so they are not part of the exported `CommandCapturePort` type — only of this
 * additionally-exported, richer type used by this file's own tests and by `wrapCommandApi` itself
 * (via a same-module cast, sound because every real capture reaching `getCapture()` was created by
 * {@link createCommandCapture} in this same file).
 */
export interface CommandCaptureEngine extends CommandCapturePort {
  arm(invocation: CaptureInvocation): void;
  take(name: string, args: string): CaptureInvocation | undefined;
  settleArm(): void;
  finish(cmdId: string): void;
  owns(name: string): boolean;
  /** Records a name as pi-toolkit-owned (real `registerCommand` time — see the doc comment above
   * {@link createCommandCaptureEngine} for why this is separate from `arm()`). */
  registerOwned(name: string): void;
  collect(entry: CommandOutputEntry): void;
  output(): CommandOutputWire | undefined;
  /** cmdId-scoped variants used internally by {@link wrapCommandApi}. */
  collectFor(cmdId: string, entry: CommandOutputEntry): void;
  outputFor(cmdId: string): CommandOutputWire | undefined;
}

/**
 * Ownership (`owns`) is derived from a name set that is populated exactly once, at real
 * `registerCommand` time — never from `arm()`. `wrapCommandApi`'s `registerCommand` proxy is the
 * only thing that ever sees a pi-toolkit `registerCommand(name, …)` call (third-party extensions
 * get their own, unwrapped `pi` from their own `activate()` — this proxy is never handed to them),
 * so it is also the only correct place to decide "this name belongs to pi-toolkit". That proxy runs
 * long before any capture object exists (`wrapCommandApi(rawPi, () => commandCaptureRef.current)` is
 * the very first line of `activate()`; the capture itself is only built once web-hub wires up, near
 * the end) — so ownership can't be pushed into a not-yet-existing capture at registration time.
 * Instead, `wrapCommandApi` and `createCommandCaptureEngine` are handed the *same* `Set<string>`
 * object by reference (`deps.ownedNames` here, the `ownedNames` parameter there): whichever side
 * writes to it first, the other side always reads the up-to-date membership, because it's the same
 * object — no backfill/replay step needed. `arm()` intentionally does **not** touch this set: arming
 * merely reflects what the (future) web dispatcher *believes* is a pi-toolkit command by name, which
 * is exactly the belief a same-named third-party command would let it hold mistakenly; only real
 * registration state can arbitrate that. `settleArm()` now gates fallback-queue admission on
 * `ownedNames.has(invocation.name)`, and `owns(name)` answers the same set directly.
 */
export function createCommandCaptureEngine(
  deps: { now?: () => number; ownedNames?: Set<string> } = {},
): CommandCaptureEngine {
  const now = deps.now ?? Date.now;
  const ownedNames = deps.ownedNames ?? new Set<string>();
  let syncSlot: CaptureInvocation | undefined;
  const queue: QueuedInvocation[] = [];
  const windows = new Map<string, Window>();
  const retainedOrder: string[] = [];
  const activeStack: string[] = [];

  function openWindow(cmdId: string): void {
    const timer = setTimeout(() => {
      const win = windows.get(cmdId);
      if (win !== undefined) win.closed = true;
    }, CAPTURE_MAX_MS);
    timer.unref?.();
    windows.set(cmdId, {
      entries: [],
      totalBytes: 0,
      needsTerminal: false,
      droppedEntries: 0,
      droppedBytes: 0,
      closed: false,
      timer,
    });
    retainedOrder.push(cmdId);
    if (retainedOrder.length > MAX_RETAINED_WINDOWS) {
      const evict = retainedOrder.shift();
      if (evict !== undefined) windows.delete(evict);
    }
  }

  function arm(invocation: CaptureInvocation): void {
    syncSlot = invocation;
  }

  function take(name: string, args: string): CaptureInvocation | undefined {
    if (syncSlot !== undefined && syncSlot.name === name && syncSlot.args === args) {
      const invocation = syncSlot;
      syncSlot = undefined;
      openWindow(invocation.cmdId);
      activeStack.push(invocation.cmdId);
      return invocation;
    }
    const idx = queue.findIndex((q) => q.invocation.name === name && q.invocation.args === args);
    if (idx === -1) return undefined;
    const [queued] = queue.splice(idx, 1);
    if (queued === undefined) return undefined;
    clearTimeout(queued.timer);
    openWindow(queued.invocation.cmdId);
    activeStack.push(queued.invocation.cmdId);
    return queued.invocation;
  }

  function settleArm(): void {
    if (syncSlot === undefined) return;
    const invocation = syncSlot;
    syncSlot = undefined;
    if (!ownedNames.has(invocation.name)) return;
    const ttl = Math.min(FALLBACK_TTL_MS, Math.max(0, invocation.deadlineAt - now()));
    if (ttl <= 0) return;
    const timer = setTimeout(() => {
      const idx = queue.findIndex((q) => q.invocation.cmdId === invocation.cmdId);
      if (idx !== -1) queue.splice(idx, 1);
    }, ttl);
    timer.unref?.();
    queue.push({ invocation, timer });
  }

  function finish(cmdId: string): void {
    const win = windows.get(cmdId);
    if (win !== undefined) {
      win.closed = true;
      if (win.timer !== undefined) clearTimeout(win.timer);
    }
    const idx = activeStack.lastIndexOf(cmdId);
    if (idx !== -1) activeStack.splice(idx, 1);
  }

  function owns(name: string): boolean {
    return ownedNames.has(name);
  }

  /** Called by `wrapCommandApi`'s `registerCommand` proxy at real registration time (and directly
   * by tests that want to simulate a genuine toolkit registration without going through the proxy). */
  function registerOwned(name: string): void {
    ownedNames.add(name);
  }

  function collectFor(cmdId: string, rawEntry: CommandOutputEntry): void {
    const win = windows.get(cmdId);
    if (win === undefined || win.closed) return;
    if (rawEntry.kind === "interactive") win.needsTerminal = true;
    const clamped = clampText(rawEntry.text, MAX_ENTRY_BYTES);
    const key = rawEntry.key !== undefined ? rawEntry.key.slice(0, MAX_KEY_CHARS) : undefined;
    const title = rawEntry.title !== undefined ? rawEntry.title.slice(0, MAX_TITLE_CHARS) : undefined;
    const entry: CommandOutputEntry = {
      kind: rawEntry.kind,
      text: clamped.text,
      ...(rawEntry.level !== undefined ? { level: rawEntry.level } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(clamped.clipped === true ? { clipped: true as const } : {}),
    };
    const entryBytes = Buffer.byteLength(entry.text, "utf8");
    if (win.entries.length >= MAX_ENTRIES || win.totalBytes + entryBytes > MAX_TOTAL_BYTES) {
      win.droppedEntries += 1;
      win.droppedBytes += entryBytes;
      return;
    }
    win.entries.push(entry);
    win.totalBytes += entryBytes;
  }

  function outputFor(cmdId: string): CommandOutputWire | undefined {
    const win = windows.get(cmdId);
    if (win === undefined) return undefined;
    const out: CommandOutputWire = { entries: win.entries };
    if (win.droppedEntries > 0 || win.droppedBytes > 0) {
      out.truncated = { droppedEntries: win.droppedEntries, droppedBytes: win.droppedBytes };
    }
    if (win.needsTerminal) out.needsTerminal = true;
    return out;
  }

  return {
    arm,
    take,
    settleArm,
    finish,
    owns,
    registerOwned,
    collectFor,
    outputFor,
    collect(entry) {
      const cmdId = activeStack[activeStack.length - 1];
      if (cmdId === undefined) return;
      collectFor(cmdId, entry);
    },
    output() {
      const cmdId = activeStack[activeStack.length - 1];
      return cmdId === undefined ? undefined : outputFor(cmdId);
    },
  };
}

/** Production factory (`src/web-hub/agent/index.ts`'s call site). `ownedNames` is the same
 * `Set<string>` object `wrapCommandApi` writes into at real `registerCommand` time — `src/index.ts`
 * creates it once and passes it to both sides (see the doc comment above
 * {@link createCommandCaptureEngine}). */
export function createCommandCapture(ownedNames?: Set<string>): CommandCapturePort {
  return createCommandCaptureEngine(ownedNames !== undefined ? { ownedNames } : {});
}

/** Structural view `wrapCommandApi` casts a `CommandCapturePort` to — sound because any capture it
 * ever sees through `getCapture()` was built by {@link createCommandCapture} in this same module. */
type InternalCapture = CommandCapturePort & Partial<Pick<CommandCaptureEngine, "collectFor" | "outputFor">>;

function collectEntry(capture: InternalCapture, cmdId: string, entry: CommandOutputEntry): void {
  capture.collectFor?.(cmdId, entry);
}

/**
 * §4.9 point 4/5: the per-invocation `ctx.ui` proxy. Re-derives the wrapped `ui` object on every
 * `ctx.ui` access (never cached) per the plan's "每次访问现取 ctx.ui". `notify`/`setWidget`/
 * `setStatus` still forward to the real terminal UI (so a human watching the same session sees
 * them too) in addition to being collected; `editor`/`select`/`input`/`confirm`/`custom` never
 * open a real terminal dialog for a web-claimed invocation — they return the same synthetic
 * "cancelled" values a human declining the dialog would produce, and record an `interactive` entry
 * so the web UI can say "this command's interactive step needs the terminal"; `setEditorText`/
 * `pasteToEditor` are dropped entirely (never forwarded, never overwrite a real terminal draft).
 * Everything else (`theme`, `setTitle`, `setWorkingMessage`, `setFooter`, …) delegates untouched.
 */
function createCapturedUi(ui: ExtensionUIContext, capture: InternalCapture, cmdId: string): ExtensionUIContext {
  const collect = (entry: CommandOutputEntry): void => collectEntry(capture, cmdId, entry);
  return new Proxy(ui, {
    get(target, property) {
      switch (property) {
        case "notify":
          return (message: string, type?: "info" | "warning" | "error") => {
            collect({ kind: "notify", level: type ?? "info", text: message });
            return Reflect.apply(target.notify, target, [message, type]);
          };
        case "setWidget":
          return (key: string, content: unknown, options?: unknown) => {
            if (content !== undefined) {
              if (Array.isArray(content)) collect({ kind: "widget", key, text: content.join("\n") });
              else collect({ kind: "widget", key, text: "(rendered in terminal)" });
            }
            return Reflect.apply(target.setWidget, target, [key, content, options]);
          };
        case "setStatus":
          return (key: string, text: string | undefined) => {
            if (text !== undefined) collect({ kind: "status", key, text });
            return Reflect.apply(target.setStatus, target, [key, text]);
          };
        case "editor":
          return async (title: string, prefill?: string) => {
            collect({ kind: "text", title, text: prefill ?? "" });
            collect({ kind: "interactive", text: "editor" });
            return undefined;
          };
        case "select":
          return async (title: string) => {
            collect({ kind: "interactive", title, text: "select" });
            return undefined;
          };
        case "input":
          return async (title: string) => {
            collect({ kind: "interactive", title, text: "input" });
            return undefined;
          };
        case "confirm":
          return async (title: string) => {
            collect({ kind: "interactive", title, text: "confirm" });
            return false;
          };
        case "custom":
          return async () => {
            collect({ kind: "interactive", text: "custom" });
            return undefined;
          };
        case "setEditorText":
          return (_text: string) => {
            collect({ kind: "interactive", text: "editor-text" });
          };
        case "pasteToEditor":
          return (_text: string) => {
            collect({ kind: "interactive", text: "editor-text" });
          };
        default: {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  }) as ExtensionUIContext;
}

/** §4.9 point 4: `ctxProxy` — same delegate-everything-except-`ui` shape as `wrapCommandApi`'s own
 * outer proxy, plus a synthetic `webInvocation: true` (what `isWebInvocation` reads) so command
 * code (`canOpenSettingsEditor`, `/tasklist`, …) can special-case a web-claimed invocation. */
function createCapturedCtx(
  ctx: ExtensionCommandContext,
  capture: InternalCapture,
  cmdId: string,
): ExtensionCommandContext {
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "webInvocation") return true;
      if (property === "ui")
        return createCapturedUi(Reflect.get(target, "ui", target) as ExtensionUIContext, capture, cmdId);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionCommandContext;
}

/** §4.9 point 4: run the real handler with the captured ctx, only calling `finish` once its
 * Promise actually settles (resolved or rejected) — not merely once it has been obtained — so the
 * collection window stays open for the handler's whole lifetime, matching "认领 → handler Promise
 * settle". Catches and records a thrown/rejected error as an `error` entry, then rethrows
 * unchanged (pi's own `emitError` path is untouched). */
async function runCaptured(
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  thisArg: unknown,
  args: string,
  ctxProxy: ExtensionCommandContext,
  capture: InternalCapture,
  cmdId: string,
): Promise<void> {
  try {
    return await Reflect.apply(handler, thisArg, [args, ctxProxy]);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    collectEntry(capture, cmdId, { kind: "error", text });
    throw error;
  } finally {
    capture.finish?.(cmdId);
  }
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
 *
 * C12: when a capture *is* wired and `take(name, args)` actually claims this invocation (§4.9
 * point 3 — the web dispatcher armed it first), the real handler runs with a captured `ctx` (§4.9
 * point 4/5) instead of the original one, and `finish` is called once its Promise settles. Every
 * other case (`getCapture()` undefined, or `take()` returns undefined because this specific
 * invocation was never claimed — e.g. a human typing the same command on the terminal) is the
 * exact original passthrough, unchanged.
 */
export function wrapCommandApi<T extends ExtensionAPI>(
  pi: T,
  getCapture: () => CommandCapturePort | undefined,
  ownedNames?: Set<string>,
): T {
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
        ownedNames?.add(name);
        const handler = command.handler;
        if (typeof handler !== "function") return Reflect.apply(register, target, [name, command]);
        const wrapped = {
          ...command,
          handler: function (this: unknown, args: string, ctx: ExtensionCommandContext) {
            const capture = getCapture() as InternalCapture | undefined;
            if (capture === undefined) return Reflect.apply(handler, this, [args, ctx]);
            const invocation = capture.take(name, args);
            if (invocation === undefined) return Reflect.apply(handler, this, [args, ctx]);
            const ctxProxy = createCapturedCtx(ctx, capture, invocation.cmdId);
            return runCaptured(handler, this, args, ctxProxy, capture, invocation.cmdId);
          },
        } as Omit<RegisteredCommand, "name" | "sourceInfo">;
        return Reflect.apply(register, target, [name, wrapped]);
      };
    },
  }) as T;
}

export function isWebInvocation(ctx: ExtensionCommandContext): boolean {
  return Boolean((ctx as unknown as { webInvocation?: unknown }).webInvocation);
}
