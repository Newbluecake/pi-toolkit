/** Offline browser harness. Mounts the real SFC; fake HTTP cannot create a backend. */
import { createApp, h, nextTick, ref } from "vue";
import IconSprite from "../../icons/IconSprite.vue";
import TerminalPanel from "./TerminalPanel.vue";
import { TERMINAL_RENDERER_FACTORY, type TerminalRendererFactory } from "./renderer-port.js";
import type { mountTerminal } from "./renderer.js";
import type { HubHandle } from "../../types.js";
export async function mountTerminalPanelProbe(
  container: HTMLElement,
  options: Parameters<typeof mountTerminal>[1] = {},
) {
  let sink: (event: string, data: unknown) => void = () => {};
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
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(new Error("probe disposed"));
      const observer = new MutationObserver(() => {
        if (container.querySelector('[data-writable="true"]')) finish();
      });
      const timer = setTimeout(() => finish(new Error("契约重放未就绪。")), 3000);
      observer.observe(container, { subtree: true, attributes: true });
      waits.add(cancel);
    });
  let serial = 0;
  const now = Date.now();
  const fact = {
    termId: "probe-term",
    reservationId: "probe-reservation",
    revision: 1,
    state: "live",
    nextInputSeq: 0,
    baseOffset: 0,
    nextOffset: 0,
    deadlines: { inputIdleAt: now + 3600000, lifetimeAt: now + 28800000, parentExpiresAt: now + 60000 },
    sessionOrdinal: 1,
    createdAt: now,
    writerPresent: true,
    ownerLabel: "Probe login (fake)",
  };
  let attachment = {
    ok: true,
    ...fact,
    attachmentId: "probe-attachment-0",
    writerLease: "probe-lease-0",
    replayMode: "cold",
    shellName: "bash",
    userLabel: "Probe user (fake)",
    hostLabel: "probe.invalid",
    cwd: "/probe-fixture",
  };
  const ops: string[] = [];
  const input: number[] = [];
  const send = (event: Record<string, unknown>) =>
    sink("terminal", {
      agentKey: "probe-agent",
      attachmentId: attachment.attachmentId,
      connectionInstance: "probe-instance",
      event: {
        v: 1,
        sessionId: "probe-session",
        epoch: "probe-epoch",
        ownerInstance: "probe-owner",
        termId: fact.termId,
        revision: 1,
        ...event,
      },
    });
  let captured: Awaited<ReturnType<typeof mountTerminal>> | undefined;
  let failure: unknown;
  let stop: ReturnType<typeof setTimeout>;
  let ready: () => void = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    ready = resolve;
    stop = setTimeout(() => reject(new Error("正式面板加载超时。")), 8000);
  });
  const app = createApp({
    render: () => [
      h(IconSprite, { terminalEnabled: true }),
      h(TerminalPanel, {
        hub: {
          state: ref({ clientId: "probe-client" }),
          terminal: {
            async request(op: string, body: any) {
              ops.push(op);
              container.dataset["probeOps"] = JSON.stringify(ops.slice(-128));
              if (op === "list") return { ok: true, revision: 1, rows: serial ? [fact] : [] };
              if (op === "prepare")
                return {
                  ok: true,
                  openId: "probe-ticket",
                  createTicket: {
                    v: 1,
                    bootId: "probe-boot",
                    ticketId: "probe-ticket",
                    issuedAt: now,
                    expiresAt: now + 60000,
                    ownerBinding: {
                      listener: "loopback",
                      principal: "probe-principal",
                      sidTag: "probe-sid",
                      agentKey: "probe-agent",
                      sessionId: "probe-session",
                      epoch: "probe-epoch",
                      ownerInstance: "probe-owner",
                    },
                    payloadDigest: "a".repeat(64),
                    mac: "b".repeat(64),
                  },
                };
              if (op === "open" || op === "attach") {
                serial++;
                attachment = {
                  ...attachment,
                  attachmentId: `probe-attachment-${serial}`,
                  writerLease: `probe-lease-${serial}`,
                  nextInputSeq: fact.nextInputSeq,
                };
                queueMicrotask(() =>
                  send({
                    kind: "replay_begin",
                    attemptId: `probe-attempt-${serial}`,
                    replayEpoch: `probe-replay-${serial}`,
                    S: 0,
                    N0: 0,
                    deadlineAt: Date.now() + 3000,
                  }),
                );
                return { ...attachment };
              }
              if (op === "ack" && body.ack.phase === "replay_ready")
                queueMicrotask(() =>
                  send({
                    kind: "cutover",
                    attemptId: `probe-attempt-${serial}`,
                    newLiveEpoch: `probe-live-${serial}`,
                    replayEnd: 0,
                    liveFrom: 0,
                    gap: { from: 0, to: 0 },
                    resetParser: true,
                  }),
                );
              if (op === "input") {
                const bytes = Array.from(atob(body.bytesB64), (c) => c.charCodeAt(0));
                input.push(...bytes);
                container.dataset["probeInput"] = JSON.stringify(input.slice(-128));
                fact.nextInputSeq = body.inputSeq + 1;
                return { ok: true, acceptedThrough: body.inputSeq };
              }
              return { ok: true, revision: 1 };
            },
          },
          terminalEvents(subscriber: (event: string, data: unknown) => void) {
            sink = subscriber;
            sink("terminal_connection", {
              connectionInstance: "probe-instance",
              connectionToken: "probe-token",
              expiresAt: Date.now() + 60000,
            });
            return () => {};
          },
        } as unknown as HubHandle,
        scope: { agentKey: "probe-agent", expect: { sessionId: "probe-session", epoch: "probe-epoch" } },
      }),
    ],
  });
  app.provide(
    TERMINAL_RENDERER_FACTORY,
    async (surface: HTMLElement, panelOptions: Parameters<typeof mountTerminal>[1]) => {
      try {
        const { mountTerminal } = await import("./terminal-impl.js");
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
  const clickCreate = () => {
    const button = container.querySelector<HTMLButtonElement>("[data-terminal-create]");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  };
  if (!clickCreate()) {
    const observer = new MutationObserver(() => {
      if (clickCreate()) observer.disconnect();
    });
    observer.observe(container, { subtree: true, attributes: true, childList: true });
    void settled.finally(() => observer.disconnect()).catch(() => {});
  }
  try {
    await settled;
    if (failure) throw failure;
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
