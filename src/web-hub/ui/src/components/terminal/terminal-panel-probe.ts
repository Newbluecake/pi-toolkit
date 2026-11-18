/** Unlinked offline browser harness. Real v2 SFC/renderer, explicit contract fake;
 * zero real backend/auth claims. The SPA never imports this probe. */
import { createApp, h, nextTick } from "vue";
import IconSprite from "../../icons/IconSprite.vue";
import TerminalPanelV2 from "./v2/TerminalPanelV2.vue";
import { TERMINAL_RENDERER_FACTORY } from "./renderer-port.js";
import type { mountTerminal } from "./renderer.js";
import type { TerminalTransportV2 } from "../../transport/terminal-v2.js";
import type { TerminalViewFrameV2, TerminalTabRowV2 } from "./protocol-v2.js";
export async function mountTerminalPanelProbe(
  container: HTMLElement,
  options: Parameters<typeof mountTerminal>[1] = {},
) {
  const waits = new Set<() => void>();
  const waitWritable = () =>
    new Promise<void>((resolve, reject) => {
      if (container.querySelector('[data-writable="true"]')) {
        resolve();
        return;
      }
      const finish = (error?: Error) => {
        clearTimeout(timer);
        observer.disconnect();
        waits.delete(cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(new Error("probe disposed"));
      const observer = new MutationObserver(() => {
        if (container.querySelector('[data-writable="true"]')) finish();
      });
      const timer = setTimeout(() => finish(new Error("契约重放未就绪。")), 3000);
      observer.observe(container, { subtree: true, attributes: true });
      waits.add(cancel);
    });
  const hubInstance = "h".repeat(24),
    termId = "t".repeat(24);
  const row: TerminalTabRowV2 = { termId, name: "probe shell", state: "live", createdAt: Date.now(), ordinal: 1 };
  let rows: TerminalTabRowV2[] = [],
    serial = 0;
  let sink: ((frame: TerminalViewFrameV2) => void) | undefined;
  const ops: string[] = [],
    input: number[] = [];
  const quota = {
    session: { used: 1, unknown: 0, limit: 2 },
    principal: { used: 1, unknown: 0, limit: 2 },
    total: { used: 1, unknown: 0, limit: 8 },
  };
  const transport: TerminalTransportV2 = {
    async request(op, body) {
      ops.push(op);
      container.dataset["probeOps"] = JSON.stringify(ops.slice(-128));
      // Correlated generic response discriminants are fixed by each branch; this
      // contract fake never manufactures a real service/resource observation.
      let result: unknown;
      if (op === "list")
        result = { ok: true, hubInstance, revision: 1, rows: rows.map((r) => ({ ...r })), unknownResources: [], quota };
      else if (op === "create" && "requestId" in body) {
        rows = [row];
        result = { ok: true, requestId: body.requestId, termId, state: "live" };
      } else if (op === "creation")
        result = { ok: true, outcome: rows.length ? "created" : "unknown", ...(rows.length ? { termId } : {}) };
      else if (op === "input" && "bytesB64" in body) {
        input.push(...Uint8Array.from(atob(body.bytesB64), (c) => c.charCodeAt(0)));
        container.dataset["probeInput"] = JSON.stringify(input.slice(-128));
        result = { ok: true, acceptedThrough: body.seq };
      } else if (op === "resize" && "seq" in body) result = { ok: true, acceptedThrough: body.seq };
      else if (op === "ack" && "offset" in body) {
        if (body.replayComplete) queueMicrotask(() => sink?.({ t: "ready", offset: body.offset }));
        result = { ok: true, offset: body.offset };
      } else if (op === "close") {
        rows = [];
        result = { ok: true, state: "closed", revision: 2 };
      } else result = { ok: false, code: "E_BAD_REQUEST", effect: "none" };
      return result as Awaited<ReturnType<TerminalTransportV2["request"]>> as never;
    },
    view(body, onFrame, signal) {
      ops.push("view");
      container.dataset["probeOps"] = JSON.stringify(ops.slice(-128));
      sink = onFrame;
      serial++;
      queueMicrotask(() => {
        if (signal?.aborted) return;
        onFrame({
          t: "attached",
          hubInstance,
          termId: body.termId,
          viewId: `v${String(serial).padStart(23, "0")}`,
          start: 0,
          end: 0,
          metadata: {
            cwd: "/probe-fixture",
            shellName: "bash",
            userLabel: "Probe user (fake)",
            hostLabel: "probe.invalid",
          },
        });
        onFrame({ t: "replay-end", offset: 0 });
      });
      return new Promise<void>((_resolve, reject) => {
        const abort = () => {
          if (sink === onFrame) sink = undefined;
          reject(new Error("probe view detached"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  let captured: Awaited<ReturnType<typeof mountTerminal>> | undefined, failure: unknown;
  let panel: { open(): Promise<boolean> } | undefined;
  let stop: ReturnType<typeof setTimeout>;
  let ready: () => void = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    ready = resolve;
    stop = setTimeout(() => reject(new Error("正式面板加载超时。")), 8000);
  });
  const app = createApp({
    render: () => [
      h(IconSprite, { terminalEnabled: true }),
      h(TerminalPanelV2, {
        transport,
        scope: { agentKey: "probe-agent", sessionId: "probe-session", epoch: "probe-epoch" },
        ref: (value: unknown) => {
          panel = value as typeof panel;
        },
      }),
    ],
  });
  app.provide(
    TERMINAL_RENDERER_FACTORY,
    async (surface: HTMLElement, panelOptions: Parameters<typeof mountTerminal>[1]) => {
      try {
        const { mountTerminal } = await import("./v2/terminal-v2-impl.js");
        captured = await mountTerminal(surface, {
          ...panelOptions,
          onStateChange(state) {
            panelOptions?.onStateChange?.(state);
            if (state.phase === "ready")
              void waitWritable()
                .then(() => options.onStateChange?.(state))
                .catch(() => {});
            else options.onStateChange?.(state);
          },
        });
      } catch (error) {
        failure = error;
      }
      ready();
      if (failure) throw failure;
      return captured!;
    },
  );
  container.classList.add("terminal-probe");
  app.mount(container);
  await nextTick();
  const open = panel?.open();
  try {
    await settled;
    if (failure) throw failure;
    await open;
    await waitWritable();
  } catch (error) {
    for (const cancel of [...waits]) cancel();
    app.unmount();
    throw error;
  } finally {
    clearTimeout(stop!);
  }
  return {
    get terminal() {
      return captured?.terminal;
    },
    get state() {
      return captured?.state;
    },
    fit() {
      captured?.fit();
    },
    write(bytes: string | Uint8Array) {
      return captured!.write(bytes);
    },
    theme() {
      captured?.theme();
    },
    font() {
      captured?.font();
    },
    focus() {
      captured?.focus();
    },
    dispose() {
      for (const cancel of [...waits]) cancel();
      app.unmount();
    },
  };
}
