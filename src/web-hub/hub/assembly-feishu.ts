import type { HubAssembly } from "./assembly.js";
import type { FeishuIdleEvidence } from "./feishu/notify.js";
import { createFeishuBotService, type FeishuBotServiceDeps } from "./feishu/service.js";
import { createFsAdmitter } from "./preview/admit.js";
import { createPreviewIoTracker, resolvePreviewDenyContext } from "./preview/fs.js";
/** Pure extraction of the assembleFeishu phase; invoked only at the original feature gate. */
export async function assembleFeishu(ctx: HubAssembly): Promise<void> {
  const { config, deps, paths, log, now, startup, startupStep } = ctx;
  const registry = ctx.registry!;
  const botDialogSlots = ctx.botDialogSlots;
  const security = ctx.security;
  const commandRouter = ctx.commandRouter!;
  const cmdLimit = ctx.cmdLimit!;
  const feishuLinks = ctx.feishuLinks;
  const scheduleHub = ctx.scheduleHub;
  const hubAgentDir = ctx.hubAgentDir;
  if (config.feishuBot !== undefined) {
    // Outbound file admission always uses the preview safety chain, even with the browser
    // preview UI disabled. No raw-fs fallback and no bot-local upload store.
    ctx.previewDenyCtx ??= await startupStep(
      resolvePreviewDenyContext(
        { home: config.home, agentDir: hubAgentDir },
        { tracker: createPreviewIoTracker(), now, log, signal: startup.signal },
      ),
    );
    startup.signal.throwIfAborted();
    const evidence = new Map<string, { statusAt?: number; fleetAt?: number; fleet?: FeishuIdleEvidence["fleet"] }>();
    const { wrapService: _wrapService, ...platformSeams } = deps.feishuSeams ?? {};
    const botDeps: FeishuBotServiceDeps = {
      ...(security === undefined ? {} : { security }),
      onApprovalDecision: (id, allowed, gen) => ctx.lanLoginCore?.onApprovalDecision(id, allowed, gen),
      stateDir: paths.stateDir,
      config: config.feishuBot,
      limit: cmdLimit,
      commands: commandRouter,
      sessions: {
        // xs alias off ⇒ key absent (byte-identical); read lazily from the loaded store.
        ...(ctx.xsAlias === undefined ? {} : { alias: (sid: string) => ctx.xsAlias?.store.heldBy(sid) }),
        views: () =>
          registry.list().flatMap((a) =>
            a.session === undefined
              ? []
              : [
                  {
                    sessionId: a.session.sessionId,
                    agentKey: a.agentKey,
                    cwd: a.cwd,
                    ...(a.session.name === undefined ? {} : { name: a.session.name }),
                    live: registry.isConnected(a.agentKey),
                    mode: a.kind,
                    state: !a.control
                      ? ("read-only" as const)
                      : a.prompts.length > 0
                        ? ("waiting" as const)
                        : a.status?.busy
                          ? ("busy" as const)
                          : ("idle" as const),
                  },
                ],
          ),
        managed: () =>
          (ctx.spawnSup?.records() ?? []).flatMap((r) =>
            r.sessionId === undefined ? [] : [{ sessionId: r.sessionId, cwd: r.cwd }],
          ),
      },
      // scheduled-reports H1 → F1 (verify r1 major): the port rides FeishuBotServiceDeps at
      // CONSTRUCTION time (F1 builds its whole schedule surface iff it is present; the
      // coordinator implements list/run/receiptsChanged). Key absence (schedule off / no
      // coordinator) keeps the bot byte-identical.
      ...(scheduleHub === undefined ? {} : { schedule: scheduleHub.port() }),
      events: {
        subscribe: (listener) => {
          ctx.botSchedEventListener = listener;
          ctx.botOnHello = (key) => {
            evidence.delete(key);
            listener({ type: "agent_up", agentKey: key });
          };
          const unsubscribe = registry.bus.subscribe((e) => {
            if (e.type === "agent_up" || e.type === "agent_down" || e.type === "agent_stale" || e.type === "gap") {
              evidence.delete(e.type === "agent_up" ? e.agent.agentKey : e.agentKey);
            }
            if (e.type === "status" || e.type === "fleet") {
              const sample = evidence.get(e.agentKey) ?? {};
              if (e.type === "status") sample.statusAt = now();
              else {
                sample.fleetAt = now();
                sample.fleet = {
                  complete: e.omitted === undefined || (e.omitted.active === 0 && e.omitted.terminal === 0),
                  terminal: e.runs.map((r) => r.terminal === true),
                };
              }
              evidence.set(e.agentKey, sample);
            }
            switch (e.type) {
              case "agent_up":
                listener({ type: "agent_up", agentKey: e.agent.agentKey });
                break;
              case "ev":
              case "ctl":
              case "session":
              case "dialogs":
              case "gap":
              case "agent_down":
              case "agent_stale":
              case "spawns":
              case "status":
              case "fleet":
                listener(e);
                break;
            }
          });
          return () => {
            ctx.botOnHello = undefined;
            unsubscribe();
          };
        },
        dialogs: () =>
          [...(botDialogSlots?.values() ?? [])]
            .filter((slot) => registry.isConnected(slot.agentKey))
            .map(({ type: _type, ...slot }) => slot),
      },
      ...(ctx.uploads === undefined ? {} : { uploads: ctx.uploads }),
      preview:
        ctx.botPreview ??
        createFsAdmitter({ denyCtx: ctx.previewDenyCtx, tracker: createPreviewIoTracker(), now, log }),
      ...(ctx.botSpawn === undefined ? {} : { spawn: ctx.botSpawn }),
      idleEvidence: (key) => {
        const sample = evidence.get(key),
          bash = registry.get(key)?.status?.bashJobs;
        if (sample?.statusAt === undefined || sample.fleetAt === undefined || bash === undefined) return undefined;
        return {
          at: Math.min(sample.statusAt, sample.fleetAt, bash.sampledAt),
          fleet: sample.fleet,
          bash: { complete: (bash.omitted ?? 0) === 0 && bash.total === bash.rows.length, running: bash.running },
        };
      },
      // Every Feishu surface shares phone-facing origin selection. Before listen(), absent
      // external/LAN evidence returns empty for F8's honest "web 会话页面" fallback.
      link: (key) => feishuLinks!.link(key),
      log: (event) => log.info("web-hub feishu:", event),
      ...platformSeams,
    };
    const created = createFeishuBotService(botDeps);
    ctx.bot = deps.feishuSeams?.wrapService?.(created, botDeps) ?? created;
    if (ctx.lanDeps !== undefined) ctx.lanDeps!.approval = ctx.bot.approval;
    await startupStep(ctx.bot.start());
    startup.signal.throwIfAborted();
    // scheduled-reports H1 → F1 (§7.1–§7.5): hand over F1's own delivery half
    // (`service.schedule`: pushReport/pushNotice/receiptsFor/hasReceipt) — discovery, notices
    // and the receipt view flow through it from now on — and tap `sched_bound` into the bot's
    // event stream (those frames are routed to the coordinator BEFORE the registry, so the
    // bot's registry-bus subscription can never see them by itself).
    if (scheduleHub !== undefined) {
      scheduleHub.setBoundTap((agentKey, runKey) => {
        try {
          ctx.botSchedEventListener?.({ type: "sched_bound", agentKey, runKey } as never);
        } catch {
          /* the bot's listener must never break the coordinator */
        }
      });
      if (ctx.bot.schedule !== undefined) scheduleHub.bindDelivery(ctx.bot.schedule);
    }
  }
}
