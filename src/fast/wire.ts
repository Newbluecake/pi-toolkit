/** Session-local Fast controller and fixed provider wiring. No globals, timers or alternate storage. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FastMode, FastSeed } from "../core/types.js";
import type {
  FastBindReply,
  FastBindRequest,
  FastChildStatePort,
  FastParentPort,
  FastSnapshot,
  FastWorkflowPort,
} from "./ports.js";
import { FAST_BIND_EVENT } from "./ports.js";
import {
  FAST_CUSTOM_TYPE,
  foldFastBranch,
  parseFastCommand,
  readFastMode,
  resolveFastCommandMode,
  snapshotToFastSeed,
} from "./state.js";
import { rewriteFastPayload } from "./payload.js";

const COST_NOTICE =
  "原生预热也跟随本会话 Fast；代理可能改写，落实及费用/额度 premium 未核实。default 不代表未加速，priority 不作账单确认。已交付请求不受切档影响。";
interface FastControllerDeps {
  getBranch(): readonly unknown[];
  appendEntry(type: string, data: unknown): void;
  isCurrent(): boolean;
  notify?(text: string, level: "info" | "warning" | "error"): void;
  setStatus?(text: string | undefined): void;
  selection?(): string;
}
export interface FastController {
  snapshot(): FastSnapshot | undefined;
  command(args: string): void;
  rewrite(payload: unknown): unknown;
  observe(data: unknown, api: string): void;
  describe(): string;
  dispose(): void;
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && "value" in d ? d.value : undefined;
}
function hint(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,96}$/.test(value) ? value : "unknown";
}
/** append's normal SDK1.5 return is success, NOT fsync. Never use branch readback as IO proof. */
export function createFastController(deps: FastControllerDeps): FastController {
  const incarnation = {};
  let live = true;
  let state = foldFastBranch(deps.getBranch());
  let revision = 0;
  let storageFault = false;
  let atHook = "unknown";
  let payloadModel = "unknown";
  let observed: { tier: string; api: string; at: number } | undefined;
  let lastStatus: string | undefined;
  const warned = new Set<string>(); // Only static outcome enums, bounded by the P1 reason enum.
  const current = () => {
    try {
      return live && deps.isCurrent();
    } catch {
      return false;
    }
  };
  const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
    try {
      deps.notify?.(text, level);
    } catch {
      /* UI failure is not a storage failure. */
    }
  };
  const render = () => {
    const text = storageFault
      ? "Fast storage-fault"
      : state.invalidRecord
        ? "Fast invalid-record"
        : state.mode === "inherit"
          ? undefined
          : atHook === "other"
            ? "Fast suspended"
            : atHook.startsWith("unsupported")
              ? "Fast unsupported-payload"
              : state.mode === "on"
                ? "Fast requested"
                : "Tier default requested";
    if (text === lastStatus) return;
    lastStatus = text;
    try {
      deps.setStatus?.(text);
    } catch {
      /* closed UI */
    }
  };
  const refresh = () => {
    if (!current()) return false;
    const next = foldFastBranch(deps.getBranch());
    if (next.mode !== state.mode || next.invalidRecord !== state.invalidRecord) {
      state = next;
      revision++;
      atHook = "unknown";
      render();
    }
    return true;
  };
  const snapshot = (): FastSnapshot | undefined =>
    refresh() ? { mode: state.mode, revision, incarnation } : undefined;
  const selection = () => {
    try {
      return hint(deps.selection?.());
    } catch {
      return "unknown";
    }
  };
  const describe = () =>
    `Fast requested=${state.mode}; selection=${selection()} (display only); at-hook=${atHook}; payloadModel=${payloadModel}; ` +
    `latest observed=${observed?.tier ?? "unknown"} (origin unknown); observed API=${observed?.api ?? "unknown"}; observed at=${observed?.at ?? "unknown"}` +
    `${state.invalidRecord ? "; invalid-record" : ""}${storageFault ? "; storage-fault" : ""}。${COST_NOTICE}`;
  render(); // Initial inherit never occupies the footer.
  return {
    snapshot,
    describe,
    command(args) {
      const parsed = parseFastCommand(args);
      if (!current()) return;
      if (parsed.kind === "usage") {
        notify("用法：/fast [toggle|on|off|inherit|reset|status]", "warning");
        return;
      }
      if (!refresh()) return;
      if (parsed.command === "status") {
        notify(describe());
        return;
      }
      // Explicit inherit/reset repairs a latest invalid/future record with one valid tombstone.
      const next =
        resolveFastCommandMode(state.mode, parsed) ??
        (state.invalidRecord && parsed.command === "inherit" ? "inherit" : undefined);
      if (next === undefined) {
        notify(describe());
        return;
      }
      try {
        deps.appendEntry(FAST_CUSTOM_TYPE, { v: 1, mode: next });
      } catch {
        if (!current()) return;
        storageFault = true;
        render();
        notify("Fast storage-fault：未切档，保留最后成功模式。", "error");
        return;
      }
      if (!current()) return;
      state = { mode: next, invalidRecord: false };
      revision++;
      storageFault = false;
      atHook = "unknown";
      render();
      notify(describe());
    },
    rewrite(payload) {
      const captured = snapshot(); // Capture once, synchronously at callback entry.
      if (!captured) return undefined;
      const result = rewriteFastPayload(payload, captured);
      if (!current()) return undefined;
      if (result === undefined) return undefined;
      if (result.kind === "applied") {
        atHook = result.requestedTier;
        payloadModel = hint(result.shape.payloadModel);
        render();
        return result.replacement;
      }
      atHook = result.kind === "other" ? "other" : `unsupported-payload:${result.reason}`;
      render();
      if (!warned.has(atHook)) {
        warned.add(atHook);
        notify(
          result.kind === "other"
            ? "Fast suspended：当前请求不是 Responses，保留原请求。"
            : `Fast unsupported-payload (${result.reason})：未覆写，原请求继续；不增加重试。`,
          "warning",
        );
      }
      return undefined;
    },
    observe(data, api) {
      // Raw parsed Responses frames only. No headers/body retention, no request/origin correlation.
      const type = own(data, "type");
      if (type !== "response.created" && type !== "response.completed") return;
      if (!current()) return;
      const tier = own(own(data, "response"), "service_tier");
      const safeTier =
        tier === "default" || tier === "priority" || tier === "flex" || tier === "auto" || tier === "scale"
          ? tier
          : "unknown";
      observed = { tier: safeTier, api: hint(api), at: Date.now() };
    },
    dispose() {
      if (!live) return;
      if (current() && lastStatus !== undefined) {
        try {
          deps.setStatus?.(undefined);
        } catch {
          /* closed UI */
        }
      }
      live = false;
      warned.clear();
      observed = undefined;
    },
  };
}
export interface FastSessionPorts {
  readonly parent: FastParentPort;
  readonly workflow: FastWorkflowPort;
  readonly childState: FastChildStatePort;
  dispose(): void;
}
/** All closures bind this exact owner, never a holder/global-active-stack lookup. Closed capture returns undefined. */
export function createFastSessionPorts(controller: FastController): FastSessionPorts {
  let live = true;
  const children = new Map<string, { owner: object; readMode: () => FastMode }>();
  const rootSeed = (): FastSeed | undefined => {
    if (!live) return undefined;
    const snapshot = controller.snapshot();
    return snapshot ? snapshotToFastSeed(snapshot) : undefined;
  };
  return {
    parent: {
      snapshot(parentRunId) {
        if (!live || !controller.snapshot()) return undefined;
        if (parentRunId === undefined) return rootSeed();
        const child = children.get(parentRunId);
        return child ? { v: 1, mode: child.readMode() } : undefined;
      },
    },
    workflow: { capture: rootSeed },
    childState: {
      bind(owner, readMode) {
        if (!live) return () => {};
        const entry = { owner: owner.incarnation, readMode };
        children.set(owner.parentRunId, entry);
        return () => {
          if (children.get(owner.parentRunId) === entry) children.delete(owner.parentRunId);
        };
      },
    },
    dispose() {
      if (!live) return;
      live = false;
      children.clear();
      controller.dispose();
    },
  };
}

// Public ID/file identify the selected history. SDK1.5 stale context getters throw after replacement;
// each open still creates a fresh incarnation, even when ID/file are reused. No facade identity assumptions.
function identity(ctx: ExtensionContext): string {
  return JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile() ?? null]);
}
export interface FastWireOptions {
  /** Existing secure pre-write recheck: slash commands bypass input guards. No new domain policy. */
  canUse?(ctx: ExtensionContext): boolean;
}
export interface FastMainWiring {
  open(ctx: ExtensionContext): FastSessionPorts;
}
/** Registration only once per activation. Stack.open owns each session incarnation and its teardown. */
export function wireFastMain(
  pi: ExtensionAPI,
  enabled: boolean,
  options: FastWireOptions = {},
): FastMainWiring | undefined {
  if (!enabled) return undefined;
  let active: { key: string; controller: FastController; ports: FastSessionPorts } | undefined;
  const get = (ctx: ExtensionContext) => {
    try {
      return active && active.key === identity(ctx) && options.canUse?.(ctx) !== false ? active.controller : undefined;
    } catch {
      return undefined;
    }
  };
  pi.registerCommand("fast", {
    description: "会话服务档位：/fast [toggle|on|off|inherit|reset|status]；原生预热跟随，费用未核实",
    handler: async (args, ctx) => {
      get(ctx)?.command(args);
    },
  });
  pi.on("before_provider_request", (event, ctx) => get(ctx)?.rewrite(event.payload));
  pi.on("provider_stream_event", (event, ctx) => {
    get(ctx)?.observe(event.data, event.api);
  });
  return {
    open(ctx) {
      active?.ports.dispose();
      const key = identity(ctx);
      let controller: FastController;
      controller = createFastController({
        getBranch: () => ctx.sessionManager.getBranch(),
        appendEntry: (type, data) => pi.appendEntry(type, data),
        isCurrent: () =>
          active?.controller === controller &&
          active.key === key &&
          identity(ctx) === key &&
          options.canUse?.(ctx) !== false,
        notify: (text, level) => ctx.ui.notify(text, level),
        setStatus: (text) => ctx.ui.setStatus(FAST_CUSTOM_TYPE, text),
        selection: () => ctx.model?.id ?? "unknown",
      });
      const ports = createFastSessionPorts(controller);
      active = { key, controller, ports };
      return ports;
    },
  };
}

/** Minimal pre-guard receiver: no command, UI, tool or host. Reply's synchronous prefix is the ready barrier. */
export function wireFastChild(pi: ExtensionAPI, enabled: boolean, options: FastWireOptions = {}): void {
  if (!enabled) return;
  let closed = false;
  let binding: { request: FastBindRequest; reply: FastBindReply } | undefined;
  let legacy: { key: string; controller: FastController } | undefined;
  const disposers: Array<() => void> = [];
  const dispose = () => {
    if (closed) return;
    closed = true;
    legacy?.controller.dispose();
    legacy = undefined;
    binding = undefined;
    for (const off of disposers.splice(0)) off();
  };
  disposers.push(
    pi.events.on(FAST_BIND_EVENT, (raw) => {
      if (closed) return;
      const request = raw as FastBindRequest;
      if (request?.v !== 1 || typeof request.reply !== "function" || typeof request.manager?.getBranch !== "function")
        return;
      if (binding) {
        if (
          binding.request.manager === request.manager &&
          binding.request.owner.incarnation === request.owner.incarnation
        )
          request.reply(binding.reply);
        return;
      }
      const reply: FastBindReply = {
        v: 1,
        wired: true,
        readMode: () => (closed ? "inherit" : readFastMode(request.manager.getBranch())),
        dispose,
      };
      binding = { request, reply };
      request.reply(reply);
    }),
  );
  const get = (ctx: ExtensionContext) => {
    if (closed || options.canUse?.(ctx) === false) return undefined;
    const key = identity(ctx);
    if (legacy && legacy.key !== key) {
      legacy.controller.dispose();
      legacy = undefined;
    }
    if (!legacy) {
      const controller = createFastController({
        getBranch: () => (binding ? binding.request.manager.getBranch() : ctx.sessionManager.getBranch()),
        appendEntry: () => {
          throw new Error("Child Fast has no command writer");
        },
        isCurrent: () => !closed && key === identity(ctx) && options.canUse?.(ctx) !== false,
      });
      legacy = { key, controller };
    }
    return legacy?.controller;
  };
  disposers.push(pi.on("before_provider_request", (event, ctx) => get(ctx)?.rewrite(event.payload)));
  disposers.push(
    pi.on("provider_stream_event", (event, ctx) => {
      get(ctx)?.observe(event.data, event.api);
    }),
  );
}
